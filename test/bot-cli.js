'use strict';

// Headless 3D bot: registers (or logs in), joins a match and fights. It runs
// the same shared physics the real client does, so it walks, falls, jumps and
// gets blocked by terrain exactly like a human player would. Used to verify
// multiplayer traffic, hitscan and money transfers without needing two humans.
//
//   node test/bot-cli.js <name> [serverUrl]

const path = require('node:path');
const V = require(path.join(__dirname, '..', 'public', 'js', 'shared', 'voxel.js'));

const NAME = process.argv[2] || `bot${Math.floor(Math.random() * 1000)}`;
const BASE = process.argv[3] || 'http://localhost:3000';
const EMAIL = `${NAME}@bots.local`;
const PASSWORD = 'botpassword123';

async function jsonFetch(path_, body, cookie) {
  const res = await fetch(BASE + path_, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { res, data: await res.json().catch(() => ({})) };
}

(async () => {
  let out = await jsonFetch('/api/register', { email: EMAIL, username: NAME, password: PASSWORD });
  if (!out.res.ok) out = await jsonFetch('/api/login', { email: EMAIL, password: PASSWORD });
  if (!out.res.ok) { console.error('auth failed:', out.data); process.exit(1); }
  const cookie = out.res.headers.get('set-cookie').split(';')[0];

  if (out.data.user.balance < 1000) {
    await jsonFetch('/api/deposit', { amountCents: 2000 }, cookie);
    console.log(`[${NAME}] deposited $20 (sandbox)`);
  }

  const { WebSocket } = require('ws');
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie } });

  let selfId = null;
  let world = null;
  let me = null;              // latest server-reported self state
  let others = [];
  let seq = 0;
  let yaw = Math.random() * Math.PI * 2, pitch = 0;
  let wanderUntil = 0, wanderYaw = yaw;
  let jumpUntil = 0;

  ws.on('open', () => console.log(`[${NAME}] connected`));

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'welcome') {
      selfId = msg.id;
      world = new V.World(msg.world.w, msg.world.h, msg.world.d, msg.seed);
      console.log(`[${NAME}] joined match #${msg.matchId} · $${(msg.balance / 100).toFixed(2)} · ${msg.elo} Elo · world seed ${msg.seed}`);
    } else if (msg.type === 'state') {
      if (msg.self) me = msg.self;
      others = msg.players.filter((p) => p.id !== selfId && p.alive);
    } else if (msg.type === 'kill') {
      console.log(`[${NAME}] KILLFEED ${msg.killer} ${msg.headshot ? '☠' : '→'} ${msg.victim} ($${(msg.amount / 100).toFixed(2)})`);
    } else if (msg.type === 'balance') {
      console.log(`[${NAME}] balance $${(msg.balance / 100).toFixed(2)}${msg.delta ? ` (${msg.delta > 0 ? '+' : ''}${(msg.delta / 100).toFixed(2)})` : ''}`);
    } else if (msg.type === 'died') {
      console.log(`[${NAME}] died to ${msg.by} · balance $${(msg.balance / 100).toFixed(2)}`);
    } else if (msg.type === 'broke') {
      console.log(`[${NAME}] BUSTED at $${(msg.balance / 100).toFixed(2)}`);
    } else if (msg.type === 'hitmarker') {
      console.log(`[${NAME}] hit${msg.headshot ? ' (HEADSHOT)' : ''}${msg.lethal ? ' — LETHAL' : ''}`);
    }
  });

  ws.on('close', (c) => { console.log(`[${NAME}] closed (${c})`); process.exit(0); });
  ws.on('error', (e) => { console.error(`[${NAME}] error`, e.message); process.exit(1); });

  // 60Hz input, matching the real client's fixed timestep
  setInterval(() => {
    if (ws.readyState !== 1 || !me || !world) return;
    const now = Date.now();

    let target = null, bestD = Infinity;
    for (const o of others) {
      const d = Math.hypot(o.x - me.x, o.y - me.y, o.z - me.z);
      if (d < bestD) { bestD = d; target = o; }
    }

    let f = false, b = false, l = false, r = false, fire = false;

    if (target) {
      // aim at the target's chest
      const dx = target.x - me.x;
      const dy = (target.y + 1.1) - (me.y + V.PHYS.EYE);
      const dz = target.z - me.z;
      const horiz = Math.hypot(dx, dz);
      yaw = Math.atan2(-dx, -dz);
      pitch = Math.atan2(dy, horiz);

      // only shoot with line of sight, so bots don't just spray into terrain
      const dir = V.lookDir(yaw, pitch);
      const wall = V.raycastVoxels(world, me.x, me.y + V.PHYS.EYE, me.z, dir.x, dir.y, dir.z, 120);
      const clear = !wall.hit || wall.dist > bestD - 0.6;
      fire = clear && bestD < 60;
      if (bestD > 6) f = true;
      if (bestD < 3) b = true;
      if (!clear) { l = Math.random() < 0.5; r = !l; f = true; }
    } else {
      if (now > wanderUntil) {
        wanderUntil = now + 1200 + Math.random() * 2200;
        wanderYaw = Math.random() * Math.PI * 2;
      }
      yaw = wanderYaw;
      pitch = 0;
      f = true;
    }

    // hop over things it gets stuck on
    if (now > jumpUntil && Math.random() < 0.02) jumpUntil = now + 220;
    const jump = now < jumpUntil;

    ws.send(JSON.stringify({
      type: 'input', seq: ++seq, f, b, l, r, jump, fire, reload: false, yaw, pitch,
    }));
  }, 1000 / 60);
})();
