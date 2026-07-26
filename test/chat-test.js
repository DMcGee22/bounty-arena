'use strict';

// Chat correctness against a running server. The interesting cases are the
// hostile ones: a client must not be able to speak as someone else, flood the
// channel, smuggle control characters, or send unbounded text.
//
//   npm start   (in another terminal)
//   node test/chat-test.js

const BASE = process.argv[2] || 'http://localhost:3000';
const { WebSocket } = require('ws');

let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function account(name) {
  const body = JSON.stringify({ email: `${name}@bots.local`, username: name, password: 'botpassword123' });
  let res = await fetch(`${BASE}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!res.ok) {
    res = await fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${name}@bots.local`, password: 'botpassword123' }),
    });
  }
  const cookie = res.headers.get('set-cookie').split(';')[0];
  await fetch(`${BASE}/api/deposit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ amountCents: 1000 }),
  });
  return cookie;
}

function connect(cookie, sink) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie } });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'chat') sink.push({ from: m.from, text: m.text });
  });
  return new Promise((res, rej) => { ws.once('open', () => res(ws)); ws.once('error', rej); });
}

(async () => {
  console.log('\nchat\n');
  const tag = Date.now() % 100000;
  const nameA = `chatA${tag}`, nameB = `chatB${tag}`;
  const [ca, cb] = await Promise.all([account(nameA), account(nameB)]);

  const heardByA = [], heardByB = [];
  const a = await connect(ca, heardByA);
  const b = await connect(cb, heardByB);
  await sleep(1000);

  a.send(JSON.stringify({ type: 'chat', text: 'hello from A' }));
  await sleep(250);
  b.send(JSON.stringify({ type: 'chat', text: 'hey A, B here' }));
  await sleep(250);

  check(heardByB.some((m) => m.text === 'hello from A' && m.from === nameA), 'B receives A’s message with A’s name');
  check(heardByA.some((m) => m.text === 'hey A, B here' && m.from === nameB), 'A receives B’s message with B’s name');
  check(heardByA.some((m) => m.text === 'hello from A'), 'sender also sees their own message');

  // impersonation: the payload claims a different identity.
  // Wait out the rate limit first, or this gets dropped for the wrong reason.
  await sleep(900);
  a.send(JSON.stringify({ type: 'chat', text: 'i am staff', from: 'ADMIN', username: 'ADMIN' }));
  await sleep(400);
  const spoof = heardByB.find((m) => m.text === 'i am staff');
  check(!!spoof && spoof.from === nameA, 'name comes from the session, not the payload (impersonation blocked)');

  // flood
  await sleep(900);
  a.send(JSON.stringify({ type: 'chat', text: 'burst-one' }));
  a.send(JSON.stringify({ type: 'chat', text: 'burst-two' }));
  a.send(JSON.stringify({ type: 'chat', text: 'burst-three' }));
  await sleep(400);
  const bursts = heardByB.filter((m) => m.text.startsWith('burst-')).length;
  check(bursts === 1, `rate limit allowed 1 of 3 rapid messages (got ${bursts})`);

  // control characters
  await sleep(900);
  a.send(JSON.stringify({ type: 'chat', text: 'clean\u0007\u0000ertext' }));
  await sleep(400);
  const ctrl = heardByB.find((m) => m.text === 'cleanertext');
  check(!!ctrl, 'control characters stripped');
  check(!!ctrl && !/[\u0000-\u001f\u007f-\u009f]/.test(ctrl.text), 'no control characters survive in the broadcast');

  // length cap
  await sleep(900);
  a.send(JSON.stringify({ type: 'chat', text: 'Z'.repeat(500) }));
  await sleep(400);
  const long = heardByB.find((m) => m.text.startsWith('ZZZ'));
  check(!!long && long.text.length === 120, `overlong message capped at 120 chars (got ${long ? long.text.length : 'none'})`);

  // empty / whitespace only
  await sleep(900);
  const beforeEmpty = heardByB.length;
  a.send(JSON.stringify({ type: 'chat', text: '   ' }));
  await sleep(400);
  check(heardByB.length === beforeEmpty, 'whitespace-only message is not broadcast');

  a.close(); b.close();
  console.log(failures === 0 ? '\nall passed\n' : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
