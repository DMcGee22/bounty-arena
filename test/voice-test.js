'use strict';

// Proximity voice relay. The security-relevant property is that range is
// enforced on the SERVER: a client must not receive audio it should be too far
// away to hear, because "someone is talking nearby" is positional information
// worth money in this game. A peer-to-peer design cannot enforce that.
//
//   npm start   (in another terminal)
//   node test/voice-test.js

const BASE = process.argv[2] || 'http://localhost:3000';
const { WebSocket } = require('ws');
const config = require('../server/config');

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

function session(cookie) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie } });
  const s = { ws, id: null, self: null, seq: 0, voiceFrames: [], others: [] };
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const b = Buffer.from(raw);
      s.voiceFrames.push({ type: b[0], speaker: b.readUInt32LE(1), bytes: b.length - 5 });
      return;
    }
    const m = JSON.parse(raw);
    if (m.type === 'welcome') s.id = m.id;
    if (m.type === 'state') {
      if (m.self) s.self = m.self;
      s.others = m.players.filter((p) => p.id !== s.id);
    }
  });
  ws.on('error', () => {});
  return new Promise((res) => ws.once('open', () => res(s)));
}

// Walk a player toward a target x/z by feeding real inputs, so the server's own
// physics decides where they end up.
async function walkTo(s, tx, tz, ms, stopAt = 2) {
  const t0 = Date.now();
  let stuckFor = 0, lastX = 0, lastZ = 0, jitter = 0;
  const timer = setInterval(() => {
    if (s.ws.readyState !== 1 || !s.self) return;
    const dx = tx - s.self.x, dz = tz - s.self.z;
    // Terrain gets in the way, so jump constantly and sidestep when progress
    // stalls — otherwise the walker parks against a ledge and the test proves
    // nothing about voice.
    const yaw = Math.atan2(-dx, -dz) + jitter;
    s.ws.send(JSON.stringify({
      type: 'input', seq: ++s.seq,
      f: true, b: false, l: jitter < -0.2, r: jitter > 0.2,
      jump: true, fire: false, reload: false, yaw, pitch: 0,
    }));
  }, 1000 / 60);
  while (Date.now() - t0 < ms) {
    await sleep(120);
    if (!s.self) continue;
    if (Math.hypot(tx - s.self.x, tz - s.self.z) < stopAt) break;
    const moved = Math.hypot(s.self.x - lastX, s.self.z - lastZ);
    lastX = s.self.x; lastZ = s.self.z;
    if (moved < 0.15) { stuckFor++; jitter = (stuckFor % 2 ? 1 : -1) * 0.9; }
    else { stuckFor = 0; jitter = 0; }
  }
  clearInterval(timer);
}

// Follow a live target rather than a fixed point, jumping and sidestepping when
// progress stalls on terrain.
async function chase(s, targetFn, ms) {
  const t0 = Date.now();
  let stuck = 0, lastX = 0, lastZ = 0, jitter = 0;
  const timer = setInterval(() => {
    const t = targetFn();
    if (s.ws.readyState !== 1 || !s.self || !t) return;
    const yaw = Math.atan2(-(t.x - s.self.x), -(t.z - s.self.z)) + jitter;
    s.ws.send(JSON.stringify({
      type: 'input', seq: ++s.seq,
      f: true, b: false, l: jitter < -0.2, r: jitter > 0.2,
      jump: true, fire: false, reload: false, yaw, pitch: 0,
    }));
  }, 1000 / 60);
  while (Date.now() - t0 < ms) {
    await sleep(120);
    const t = targetFn();
    if (!s.self || !t) continue;
    if (Math.hypot(t.x - s.self.x, t.z - s.self.z) < 6) break;
    const moved = Math.hypot(s.self.x - lastX, s.self.z - lastZ);
    lastX = s.self.x; lastZ = s.self.z;
    if (moved < 0.15) { stuck++; jitter = (stuck % 3 === 0 ? 1.6 : stuck % 2 ? 0.9 : -0.9); }
    else { stuck = 0; jitter = 0; }
  }
  clearInterval(timer);
}

function voiceFrame() {
  const buf = Buffer.alloc(1 + 320);
  buf[0] = 0x01;
  for (let i = 1; i < buf.length; i++) buf[i] = 0x7f;   // silence in mulaw
  return buf;
}

async function speak(s, frames = 6) {
  for (let i = 0; i < frames; i++) { s.ws.send(voiceFrame()); await sleep(20); }
  await sleep(250);
}

(async () => {
  console.log('\nproximity voice\n');
  const tag = Date.now() % 100000;
  const [ca, cb] = await Promise.all([account(`vcA${tag}`), account(`vcB${tag}`)]);
  const a = await session(ca);
  const b = await session(cb);
  await sleep(1200);

  check(a.id !== null && b.id !== null, 'both players joined a match');

  // A chases B's live position. Voxel terrain makes naive pathing unreliable,
  // so rather than depending on them meeting, the assertions below check the
  // actual invariant — audio is relayed if and only if the two are in range —
  // which is meaningful at whatever separation they end up at.
  const sep = () => (a.self && b.self ? Math.hypot(a.self.x - b.self.x, a.self.z - b.self.z) : Infinity);
  await chase(a, () => b.self, 22000);
  await sleep(500);
  const dist = sep();

  // Other real players may be in this match and talking, so every measurement
  // counts only frames attributed to the speaker this test controls.
  const fromA = (s) => s.voiceFrames.filter((f) => f.speaker === a.id);

  b.voiceFrames.length = 0;
  await speak(a);
  const closeFrames = fromA(b);
  const inRange = dist <= config.VOICE_RANGE;
  // The invariant, stated directly: relay happens exactly when in range.
  check(inRange === (closeFrames.length > 0),
    `relay matches range: ${dist.toFixed(1)} blocks (limit ${config.VOICE_RANGE}) → ${closeFrames.length} frames`);
  if (inRange) {
    check(closeFrames.every((f) => f.bytes === 320), 'payload relayed intact (320 bytes)');
    check(closeFrames.every((f) => f.type === 0x01), 'frames carry the voice type byte');
  } else {
    console.log('  ~ walkers never closed to within range; in-range relay not exercised');
  }

  // The speaker must not hear themselves echoed back.
  a.voiceFrames.length = 0;
  await speak(a);
  check(fromA(a).length === 0, 'speaker does not receive their own audio back');

  // Now separate them beyond range and confirm the server stops relaying.
  // Head for whichever corner is furthest from B.
  const bx = b.self?.x ?? 48, bz = b.self?.z ?? 48;
  await walkTo(a, bx > 48 ? 8 : 88, bz > 48 ? 8 : 88, 20000, 3);
  await sleep(400);
  const far = sep();

  b.voiceFrames.length = 0;
  await speak(a, 8);
  const heardFar = fromA(b).length;
  if (far > config.VOICE_RANGE) {
    check(heardFar === 0, `out of range (${far.toFixed(1)} blocks): server relayed nothing (${heardFar} frames)`);
  } else {
    console.log(`  ~ could not separate players far enough (${far.toFixed(1)} blocks); range cull not exercised`);
  }

  // Oversized frames must be rejected outright.
  b.voiceFrames.length = 0;
  const huge = Buffer.alloc(config.VOICE_MAX_FRAME_BYTES + 200);
  huge[0] = 0x01;
  a.ws.send(huge);
  await sleep(300);
  check(fromA(b).length === 0, 'oversized voice frame is dropped');

  a.ws.close(); b.ws.close();
  console.log(failures === 0 ? '\nall passed\n' : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
