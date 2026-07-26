'use strict';

// Regression test for the "can't move after reconnecting" bug.
//
// The server drops inputs whose sequence number it has already seen. A
// reconnecting client restarts its sequence at zero, so if the server keeps the
// previous high-water mark every input looks stale and is silently discarded:
// the player can still look around, but is frozen in place until their avatar
// expires. Leaving and rejoining "fixed" it only because that destroys the
// avatar and allocates a fresh one.
//
//   npm start   (in another terminal)
//   node test/reconnect-move-test.js

const path = require('node:path');
const V = require(path.join(__dirname, '..', 'public', 'js', 'shared', 'voxel.js'));
const { WebSocket } = require('ws');

const BASE = process.argv[2] || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};

async function account(name) {
  const body = JSON.stringify({ email: `${name}@bots.local`, username: name, password: 'botpassword123' });
  const res = await fetch(`${BASE}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  await fetch(`${BASE}/api/deposit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ amountCents: 2000 }),
  });
  return cookie;
}

// A minimal client that walks forward and reports how far the SERVER moved it.
function session(cookie) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie } });
  const s = { ws, self: null, seq: 0, ready: false };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'welcome') s.ready = true;
    if (m.type === 'state' && m.self) s.self = m.self;
  });
  ws.on('error', () => {});
  return new Promise((res) => { ws.once('open', () => res(s)); });
}

// `back` retraces ground already walked, which is known to be clear — walking
// further forward can simply run into terrain and understate the result.
async function walk(s, ms, back = false) {
  const start = s.self ? { ...s.self } : null;
  const timer = setInterval(() => {
    if (s.ws.readyState !== 1) return;
    s.ws.send(JSON.stringify({
      type: 'input', seq: ++s.seq,
      f: !back, b: back, l: false, r: false,
      jump: false, fire: false, reload: false, yaw: 0, pitch: 0,
    }));
  }, 1000 / 60);
  await sleep(ms);
  clearInterval(timer);
  const end = s.self;
  if (!start || !end) return 0;
  return Math.hypot(end.x - start.x, end.z - start.z);
}

(async () => {
  console.log('\nreconnect then move\n');
  const name = `rc${Date.now() % 100000}`;
  const cookie = await account(name);

  // first connection
  const a = await session(cookie);
  await sleep(900);
  const movedFirst = await walk(a, 1500);
  check(movedFirst > 1, `moves on first connection (${movedFirst.toFixed(2)} blocks)`);

  // Simulate a long session: after several minutes of play the sequence counter
  // is in the thousands. This is what makes the bug bite — a reconnecting
  // client has to climb all the way back past this before anything is accepted.
  a.seq = 6000;
  for (let i = 0; i < 5; i++) {
    a.ws.send(JSON.stringify({
      type: 'input', seq: ++a.seq,
      f: false, b: false, l: false, r: false,
      jump: false, fire: false, reload: false, yaw: 0, pitch: 0,
    }));
    await sleep(40);
  }
  const seqReached = a.seq;
  check(seqReached > 5000, `long session pushed the sequence to ${seqReached}`);

  // drop the socket WITHOUT leaving, so the avatar survives the grace window
  a.ws.terminate();
  await sleep(700);

  // reconnect: a fresh client restarts its sequence at 1, exactly like a reload
  const b = await session(cookie);
  await sleep(900);
  check(b.ready, 'reconnect rebinds to the surviving avatar');

  const movedAfter = await walk(b, 1500, true);
  check(b.seq < seqReached,
    `reconnected client restarted low (sent seq 1..${b.seq}, previous peak ${seqReached})`);
  check(movedAfter > movedFirst * 0.6,
    `moves normally after reconnect (${movedAfter.toFixed(2)} blocks vs ${movedFirst.toFixed(2)} before)`);

  b.ws.close();
  console.log(failures === 0 ? '\nall passed\n' : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
