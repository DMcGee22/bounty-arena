'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const config = require('./config');
const { db } = require('./db');
const auth = require('./auth');
const wallet = require('./wallet');
const payments = require('./payments');
const game = require('./matchmaker');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw new Error('invalid JSON'); }
}

function currentUser(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  return auth.userByToken(cookies.session);
}

// Prefer X-Forwarded-Proto so HTTPS tunnels (ngrok) set Secure cookies —
// without Secure, browsers often drop the session cookie on https:// URLs
// and friends get stuck reconnecting / "not signed in".
function requestIsHttps(req) {
  const xf = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (xf === 'https') return true;
  if (xf === 'http') return false;
  return !!(req.socket && req.socket.encrypted);
}

function setSessionCookie(res, token, req) {
  const maxAge = Math.floor(config.SESSION_TTL_MS / 1000);
  let cookie = `session=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  if (req && requestIsHttps(req)) cookie += '; Secure';
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res, req) {
  let cookie = 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax';
  if (req && requestIsHttps(req)) cookie += '; Secure';
  res.setHeader('Set-Cookie', cookie);
}

function publicUser(u) {
  const row = db.prepare('SELECT kills, deaths, elo FROM users WHERE id = ?').get(u.id);
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    balance: wallet.getBalance(u.id),
    kills: row.kills,
    deaths: row.deaths,
    elo: row.elo,
    stakeCents: config.STAKE_CENTS,
    paymentsMode: payments.mode(),
    inArena: game.isActive(u.id),
  };
}

const routes = {
  'POST /api/register': async (req, res) => {
    const { email, username, password } = await readJson(req);
    const id = auth.register(email, username, password);
    setSessionCookie(res, auth.createSession(id), req);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    json(res, 200, { user: publicUser(u) });
  },

  'POST /api/login': async (req, res) => {
    const { email, password } = await readJson(req);
    const u = auth.login(email, password);
    setSessionCookie(res, auth.createSession(u.id), req);
    json(res, 200, { user: publicUser(u) });
  },

  'POST /api/guest': async (req, res) => {
    let body = {};
    try { body = await readJson(req); } catch { body = {}; }
    const id = auth.guest(body.username);
    setSessionCookie(res, auth.createSession(id), req);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    json(res, 200, { user: publicUser(u) });
  },

  'POST /api/logout': async (req, res) => {
    const cookies = auth.parseCookies(req.headers.cookie);
    auth.destroySession(cookies.session);
    clearSessionCookie(res, req);
    json(res, 200, { ok: true });
  },

  'GET /api/me': async (req, res, user) => {
    json(res, 200, { user: publicUser(user) });
  },

  'POST /api/deposit': async (req, res, user) => {
    const { amountCents } = await readJson(req);
    const origin = `http://${req.headers.host}`;
    const result = await payments.startDeposit(user, amountCents, origin);
    if (result.balance !== undefined) game.onBalanceChange(user.id);
    json(res, 200, result);
  },

  'POST /api/withdraw': async (req, res, user) => {
    if (game.isActive(user.id)) {
      // Withdrawing mid-match could leave a live player unable to cover a
      // death; the arena invariant is "alive implies balance >= stake".
      return json(res, 409, { error: 'Leave the arena before withdrawing.' });
    }
    const { amountCents } = await readJson(req);
    const result = payments.withdraw(user, amountCents);
    // Record where this payout would go: linked crypto wallet if present,
    // otherwise a generic simulated bank payout. Always 'simulated' in sandbox.
    const cw = db.prepare('SELECT address FROM crypto_wallets WHERE user_id = ?').get(user.id);
    db.prepare(`INSERT INTO payouts (user_id, amount_cents, dest, status) VALUES (?, ?, ?, 'simulated')`)
      .run(user.id, amountCents, cw ? `eth:${cw.address}` : 'bank:simulated');
    json(res, 200, { ...result, dest: cw ? cw.address : null });
  },

  'GET /api/transactions': async (req, res, user) => {
    json(res, 200, { transactions: wallet.history(user.id, 25) });
  },

  'GET /api/leaderboard': async (req, res) => {
    const rows = db.prepare(
      `SELECT username, elo, kills, deaths, (kills - deaths) * ? AS net_cents
       FROM users WHERE kills > 0 OR deaths > 0
       ORDER BY elo DESC, net_cents DESC LIMIT 10`
    ).all(config.STAKE_CENTS);
    json(res, 200, { leaderboard: rows });
  },

  'GET /api/arena': async (req, res) => {
    json(res, 200, { ...game.stats(), stakeCents: config.STAKE_CENTS });
  },

  // Player profile + game tracking: career stats and recent fight history.
  'GET /api/profile': async (req, res, user) => {
    const u = db.prepare('SELECT username, elo, kills, deaths, pronouns, created_at FROM users WHERE id = ?').get(user.id);
    const net = db.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS net FROM transactions
       WHERE user_id = ? AND type IN ('kill','death')`
    ).get(user.id);
    const recent = db.prepare(
      `SELECT k.match_id, k.amount_cents, k.created_at,
              ku.username AS killer, vu.username AS victim,
              CASE WHEN k.killer_id = ? THEN k.killer_elo_after ELSE k.victim_elo_after END AS elo_after
       FROM kills k
       JOIN users ku ON ku.id = k.killer_id
       JOIN users vu ON vu.id = k.victim_id
       WHERE k.killer_id = ? OR k.victim_id = ?
       ORDER BY k.id DESC LIMIT 20`
    ).all(user.id, user.id, user.id);
    const wallet_ = db.prepare('SELECT chain, address FROM crypto_wallets WHERE user_id = ?').get(user.id);
    json(res, 200, {
      profile: {
        ...u,
        netCents: Number(net.net),
        recent,
        cryptoWallet: wallet_ || null,
      },
    });
  },

  // Player-chosen pronouns, shown on their in-game nameplate. Free text rather
  // than a fixed list, because no fixed list covers everyone; kept short and
  // stripped of control characters, and escaped wherever it is rendered.
  'POST /api/pronouns': async (req, res, user) => {
    const { pronouns } = await readJson(req);
    const value = String(pronouns ?? '')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .trim()
      .slice(0, 24);
    db.prepare('UPDATE users SET pronouns = ? WHERE id = ?').run(value, user.id);
    game.onProfileChange(user.id);
    json(res, 200, { pronouns: value });
  },

  // Link a crypto wallet address for payouts. Address format is validated;
  // production must verify ownership with a signed nonce (SIWE) — see README.
  'POST /api/wallet/link': async (req, res, user) => {
    const { address } = await readJson(req);
    const addr = String(address || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      return json(res, 400, { error: 'invalid EVM address (expected 0x + 40 hex chars)' });
    }
    db.prepare(
      `INSERT INTO crypto_wallets (user_id, chain, address) VALUES (?, 'ethereum', ?)
       ON CONFLICT(user_id) DO UPDATE SET address = excluded.address, created_at = datetime('now')`
    ).run(user.id, addr);
    json(res, 200, { linked: { chain: 'ethereum', address: addr } });
  },

  'POST /api/stripe/webhook': async (req, res) => {
    const raw = await readBody(req, 64 * 1024);
    try {
      const out = payments.handleWebhook(raw, req.headers['stripe-signature']);
      if (out.credited) game.onBalanceChange(out.credited);
      json(res, 200, { received: true });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  },
};

// Guest create must stay open — no login wall; this is how operators enter.
const OPEN_ROUTES = new Set([
  'POST /api/register',
  'POST /api/login',
  'POST /api/guest',
  'POST /api/logout',
  'GET /api/leaderboard',
  'GET /api/arena',
  'POST /api/stripe/webhook',
]);

// three.js is vendored from node_modules rather than a CDN so the game keeps
// working offline and on a LAN with no internet. The whole build directory is
// exposed because three.module.js imports three.core.js as a sibling.
const THREE_DIR = path.join(__dirname, '..', 'node_modules', 'three', 'build');

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';

  if (urlPath.startsWith('/vendor/')) {
    const vendorPath = path.join(THREE_DIR, urlPath.slice('/vendor/'.length));
    if (!vendorPath.startsWith(THREE_DIR)) { res.writeHead(403); return res.end(); }
    return fs.readFile(vendorPath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('three.js not installed — run npm install'); }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      res.end(data);
    });
  }
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  const ext = path.extname(filePath).toLowerCase();
  // Stream large media; full buffer-read of multi‑MB music tanks first paint
  // for friends on slow links.
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    const type = MIME[ext] || 'application/octet-stream';
    // Game JS/CSS: no long cache (stale clients look like "broken features").
    // Audio / images: cache hard so friends don't re-download 30MB every join.
    const isMedia = /\.(ogg|mp3|wav|webm|png|jpg|jpeg|webp|woff2)$/i.test(ext);
    const cache = isMedia
      ? 'public, max-age=604800, immutable'
      : 'no-store, must-revalidate';
    const headers = {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': cache,
      'Accept-Ranges': 'bytes',
    };
    // Range support for audio seeking / resume
    const range = req.headers.range;
    if (range && isMedia) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : (st.size - 1);
        if (start <= end && end < st.size) {
          headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
          headers['Content-Length'] = end - start + 1;
          res.writeHead(206, headers);
          fs.createReadStream(filePath, { start, end }).pipe(res);
          return;
        }
      }
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const key = `${req.method} ${new URL(req.url, 'http://x').pathname}`;
  const handler = routes[key];
  if (!handler) return serveStatic(req, res);
  try {
    let user = null;
    if (!OPEN_ROUTES.has(key)) {
      user = currentUser(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
    }
    await handler(req, res, user);
  } catch (err) {
    const status = err.code === 'INSUFFICIENT' ? 402
      : err.code === 'BAD_AMOUNT' ? 400
      : err instanceof auth.AuthError ? 400
      : err instanceof wallet.WalletError ? 400
      : 500;
    if (status === 500) console.error('[http]', key, err);
    json(res, status, { error: err.message });
  }
});

// ---- WebSocket: the arena ---------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const { pathname } = url;
  if (pathname !== '/ws') { socket.destroy(); return; }
  const user = currentUser(req);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const botArena = url.searchParams.get('mode') === 'bots';
  wss.handleUpgrade(req, socket, head, (ws) => {
    const player = game.join(user, ws, { botArena });
    if (!player) return;
    ws.isAlivePing = true;
    ws.on('pong', () => { ws.isAlivePing = true; });
    ws.on('message', (data, isBinary) => {
      // Binary frames are voice audio; text frames are the JSON game protocol.
      if (isBinary) {
        player.match.handleVoice(player, data);
        return;
      }
      // Generous enough that a full-length chat line always arrives and gets
      // truncated by the chat handler. A tighter cap silently swallowed long
      // messages at the socket layer, which looked like chat being broken.
      if (data.length > 2048) return;
      player.match.handleMessage(player, data.toString());
    });
    ws.on('close', () => {
      if (player.socket === ws) player.match.handleDisconnect(player);
    });
    ws.on('error', () => {});
  });
});

// Heartbeat: detect half-dead sockets (client vanished without TCP FIN) and
// terminate them so the combat-log grace timer starts promptly.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlivePing) { ws.terminate(); continue; }
    ws.isAlivePing = false;
    ws.ping();
  }
}, 10_000);

server.listen(config.PORT, () => {
  console.log(`[bounty-arena] listening on http://localhost:${config.PORT}`);
  console.log(`[bounty-arena] payments mode: ${payments.mode()}`);
  if (payments.mode() === 'sandbox') {
    console.log('[bounty-arena] SANDBOX: no real money moves. See README.md before even thinking about going live.');
  }
});
