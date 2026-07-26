'use strict';

// Verifies the combat-log defence end-to-end against a running server:
// a player who drops mid-match stays in the arena (killable, still worth the
// stake) for DISCONNECT_GRACE_S, then is reaped. Also verifies that
// reconnecting inside the grace window resumes the SAME avatar rather than
// costing a life.
//
//   npm start   (in another terminal)
//   node test/disconnect-test.js

const BASE = process.argv[2] || 'http://localhost:3000';
const { WebSocket } = require('ws');

const stamp = Date.now();
const OBS = `obs${stamp}`.slice(0, 16);
const SUB = `sub${stamp}`.slice(0, 16);

async function signup(name) {
  const res = await fetch(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${name}@bots.local`, username: name, password: 'botpassword123' }),
  });
  if (!res.ok) throw new Error(`register ${name} failed: ${JSON.stringify(await res.json())}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  await fetch(`${BASE}/api/deposit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ amountCents: 2000 }),
  });
  return cookie;
}

function connect(cookie) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie } });
  ws.state = { self: null, players: [], welcomes: 0 };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'welcome') { ws.state.self = m.id; ws.state.welcomes++; }
    if (m.type === 'state') ws.state.players = m.players;
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};

(async () => {
  console.log('\ncombat-log / reconnect\n');

  const obsCookie = await signup(OBS);
  const subCookie = await signup(SUB);

  const obs = await connect(obsCookie);      // observer: stays connected
  const sub = await connect(subCookie);      // subject: will be dropped
  await sleep(600);

  const seenAlive = obs.state.players.find((p) => p.u === SUB);
  check(!!seenAlive, 'subject is visible in the arena');
  check(obs.state.players.length >= 2, 'both players share one match (SBMM placed them together)');

  // hard-drop the subject's socket
  sub.terminate();
  await sleep(1500);

  const duringGrace = obs.state.players.find((p) => p.u === SUB);
  check(!!duringGrace, 'subject STILL in arena 1.5s after dropping (cannot combat-log out)');
  check(duringGrace?.alive === true, 'subject is still alive and killable');
  check(duringGrace?.gone === true, 'subject is flagged as disconnected to other players');

  // reconnect inside the grace window resumes the same avatar
  const back = await connect(subCookie);
  await sleep(600);
  const resumed = obs.state.players.filter((p) => p.u === SUB);
  check(resumed.length === 1, 'reconnect resumed one avatar (no duplicate spawned)');
  check(resumed[0]?.gone === false, 'reconnected player no longer flagged disconnected');
  check(resumed[0]?.d === duringGrace?.d, 'reconnect cost the player no deaths');

  // now drop for good and let the grace expire
  back.terminate();
  await sleep(6500);
  const reaped = obs.state.players.find((p) => p.u === SUB);
  check(!reaped, 'subject reaped from the arena after the grace window expired');

  obs.close();
  console.log(failures === 0 ? '\nall passed\n' : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
