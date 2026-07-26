'use strict';

// Measures how far the client's predicted position drifts from the server's
// authoritative one. This is the health metric for the whole netcode: if
// prediction matches, corrections are ~0 and movement is smooth. If it doesn't,
// the player gets yanked on every state frame and no amount of visual smoothing
// will hide it — smoothing would just be papering over a desync.
//
//   npm start   (in another terminal)
//   node test/prediction-test.js

const path = require('node:path');
const V = require(path.join(__dirname, '..', 'public', 'js', 'shared', 'voxel.js'));
const { WebSocket } = require('ws');

const BASE = process.argv[2] || 'http://localhost:3000';
const STEP_MS = V.PHYS.STEP * 1000;

(async () => {
  const name = `pred${Date.now() % 100000}`;
  let res = await fetch(`${BASE}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${name}@bots.local`, username: name, password: 'botpassword123' }),
  });
  if (!res.ok) { console.error('register failed'); process.exit(1); }
  const cookie = res.headers.get('set-cookie').split(';')[0];
  await fetch(`${BASE}/api/deposit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ amountCents: 1000 }),
  });

  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie } });
  let world = null, ready = false;
  const me = { x: 0, y: 0, z: 0, vy: 0, onGround: false };
  const pending = [];
  let seq = 0, yaw = 0;
  const errors = [];
  let maxBacklog = 0, lastAck = 0;

  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'welcome') {
      world = new V.World(m.world.w, m.world.h, m.world.d, m.seed);
    } else if (m.type === 'state' && m.self) {
      if (!ready) {
        Object.assign(me, m.self);
        ready = true;
        lastAck = m.seq;
        return;
      }
      // exactly what the browser client does
      const bx = me.x, by = me.y, bz = me.z;
      Object.assign(me, m.self);
      while (pending.length && pending[0].seq <= m.seq) pending.shift();
      for (const p of pending) V.step(world, me, p);
      errors.push(Math.hypot(bx - me.x, by - me.y, bz - me.z));

      // Ack lag: how many inputs are still unacknowledged. A steadily growing
      // backlog means the server cannot keep up; a flat one means it can.
      // (Inputs the server silently dropped would surface as position error
      // above, which is the real ground truth.)
      if (pending.length > maxBacklog) maxBacklog = pending.length;
      lastAck = m.seq;
    }
  });

  ws.on('error', (e) => { console.error(e.message); process.exit(1); });
  await new Promise((r) => ws.once('open', r));

  // Run a realistic movement pattern: walk, turn, strafe, jump — the cases
  // most likely to diverge (collisions, step-ups, gravity).
  const phases = [
    { ms: 1600, k: { f: true }, turn: 0 },
    { ms: 1600, k: { f: true }, turn: 0.9 },
    { ms: 1200, k: { f: true, r: true }, turn: 0.4 },
    { ms: 1200, k: { f: true, jump: true }, turn: 0 },
    { ms: 1200, k: { b: true, l: true }, turn: -0.7 },
    { ms: 1600, k: { f: true }, turn: 1.8 },
  ];

  const t0 = Date.now();
  let acc = 0, last = Date.now(), phaseIdx = 0, phaseStart = Date.now();

  await new Promise((done) => {
    const timer = setInterval(() => {
      if (!ready || !world) { last = Date.now(); return; }
      const now = Date.now();
      acc += now - last;
      last = now;

      if (now - phaseStart > phases[phaseIdx].ms) {
        phaseIdx++;
        phaseStart = now;
        if (phaseIdx >= phases.length) { clearInterval(timer); done(); return; }
      }
      const ph = phases[phaseIdx];
      yaw += ph.turn * 0.016;

      let steps = 0;
      while (acc >= STEP_MS && steps < 8) {
        acc -= STEP_MS;
        steps++;
        const input = {
          seq: ++seq,
          f: !!ph.k.f, b: !!ph.k.b, l: !!ph.k.l, r: !!ph.k.r,
          jump: !!ph.k.jump, fire: false, reload: false,
          yaw, pitch: 0,
        };
        V.step(world, me, input);
        pending.push(input);
        ws.send(JSON.stringify({ type: 'input', ...input }));
      }
    }, 1000 / 60);
  });

  errors.sort((a, b) => a - b);
  const n = errors.length;
  const pct = (p) => errors[Math.min(n - 1, Math.floor(n * p))] ?? 0;
  const mean = errors.reduce((a, b) => a + b, 0) / (n || 1);

  console.log('\nprediction accuracy over', ((Date.now() - t0) / 1000).toFixed(1), 's of movement\n');
  console.log(`  corrections sampled : ${n}`);
  console.log(`  mean error          : ${(mean * 100).toFixed(2)} cm`);
  console.log(`  median              : ${(pct(0.5) * 100).toFixed(2)} cm`);
  console.log(`  p95                 : ${(pct(0.95) * 100).toFixed(2)} cm`);
  console.log(`  worst               : ${(errors[n - 1] * 100).toFixed(2)} cm`);
  console.log(`  inputs sent         : ${seq}`);
  console.log(`  max unacked backlog : ${maxBacklog} inputs`);

  const ok = mean < 0.02 && pct(0.95) < 0.10 && maxBacklog < 20;
  console.log(ok
    ? '\n  ✓ prediction tracks the server — corrections are sub-centimetre\n'
    : '\n  ✗ prediction diverges; smoothing would be masking a real desync\n');
  process.exit(ok ? 0 : 1);
})();
