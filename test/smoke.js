'use strict';

// Ledger + Elo correctness. The money math is the part that must be provably
// right, so this runs against a throwaway DB and asserts the invariants that
// matter: conservation, atomicity, no negative balances, Elo symmetry.

process.env.DATA_DIR = require('node:path').join(require('node:os').tmpdir(), `bounty-test-${Date.now()}`);

const assert = require('node:assert');
const { db } = require('../server/db');
const auth = require('../server/auth');
const wallet = require('../server/wallet');
const elo = require('../server/elo');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

console.log('\nledger');

const alice = auth.register('alice@test.com', 'alice', 'password123');
const bob = auth.register('bob@test.com', 'bob', 'password123');
const MATCH = Number(db.prepare('INSERT INTO matches DEFAULT VALUES').run().lastInsertRowid);

test('new accounts start at zero', () => {
  assert.strictEqual(wallet.getBalance(alice), 0);
});

test('deposit credits exact cents', () => {
  assert.strictEqual(wallet.deposit(alice, 1000, 'test'), 1000);
  assert.strictEqual(wallet.deposit(bob, 1000, 'test'), 1000);
});

test('deposit rejects non-integer and negative amounts', () => {
  assert.throws(() => wallet.deposit(alice, 10.5, 'x'), /bad amount/);
  assert.throws(() => wallet.deposit(alice, -500, 'x'), /bad amount/);
});

test('withdraw cannot overdraw', () => {
  assert.throws(() => wallet.withdraw(alice, 999999, 'x'), /insufficient/);
  assert.strictEqual(wallet.getBalance(alice), 1000, 'balance unchanged after failed withdraw');
});

test('kill transfers exactly $3 from victim to killer', () => {
  const r = wallet.killTransfer(MATCH, alice, 'alice', bob, 'bob', 300);
  assert.strictEqual(r.killerAfter, 1300);
  assert.strictEqual(r.victimAfter, 700);
});

test('kill transfer conserves total money', () => {
  const before = wallet.getBalance(alice) + wallet.getBalance(bob);
  wallet.killTransfer(MATCH, bob, 'bob', alice, 'alice', 300);
  const after = wallet.getBalance(alice) + wallet.getBalance(bob);
  assert.strictEqual(before, after, 'money created or destroyed');
});

test('kill transfer is atomic — a broke victim moves no money at all', () => {
  const poor = auth.register('poor@test.com', 'poor', 'password123');
  wallet.deposit(poor, 100, 'test'); // less than the 300 stake
  const aliceBefore = wallet.getBalance(alice);
  assert.throws(() => wallet.killTransfer(MATCH, alice, 'alice', poor, 'poor', 300), /insufficient/);
  assert.strictEqual(wallet.getBalance(poor), 100, 'victim charged despite rollback');
  assert.strictEqual(wallet.getBalance(alice), aliceBefore, 'killer paid despite rollback');
  // and no orphaned ledger rows
  const rows = db.prepare(`SELECT COUNT(*) c FROM transactions WHERE user_id = ?`).get(poor);
  assert.strictEqual(Number(rows.c), 1, 'rolled-back transaction leaked a ledger row');
});

test('balance never goes negative under a kill storm', () => {
  const victim = auth.register('victim@test.com', 'victim', 'password123');
  wallet.deposit(victim, 1000, 'test');
  let killed = 0;
  for (let i = 0; i < 20; i++) {
    try { wallet.killTransfer(MATCH, alice, 'alice', victim, 'victim', 300); killed++; } catch {}
  }
  assert.strictEqual(killed, 3, 'should afford exactly 3 deaths from $10');
  assert.strictEqual(wallet.getBalance(victim), 100);
  assert.ok(wallet.getBalance(victim) >= 0);
});

test('every ledger row matches its running balance', () => {
  for (const uid of [alice, bob]) {
    const rows = db.prepare('SELECT amount_cents, balance_after_cents FROM transactions WHERE user_id = ? ORDER BY id').all(uid);
    let running = 0;
    for (const r of rows) {
      running += Number(r.amount_cents);
      assert.strictEqual(running, Number(r.balance_after_cents), `ledger drift for user ${uid}`);
    }
    assert.strictEqual(running, wallet.getBalance(uid), `final ledger sum != balance for user ${uid}`);
  }
});

test('kill/death counters track transfers', () => {
  const a = db.prepare('SELECT kills, deaths FROM users WHERE id = ?').get(alice);
  assert.ok(a.kills > 0 && a.deaths > 0);
});

console.log('\nelo');

test('kills log post-kill ratings for both players', () => {
  const row = db.prepare('SELECT * FROM kills ORDER BY id DESC LIMIT 1').get();
  assert.ok(row.killer_elo_after > 0 && row.victim_elo_after > 0);
});

test('beating a higher-rated player gains more than beating a lower one', () => {
  const under = auth.register('under@test.com', 'under', 'password123');
  const over = auth.register('over@test.com', 'over', 'password123');
  db.prepare('UPDATE users SET elo = 800 WHERE id = ?').run(under);
  db.prepare('UPDATE users SET elo = 1600 WHERE id = ?').run(over);
  const before = elo.get(under);
  elo.applyKill(under, over);        // upset win
  const upsetGain = elo.get(under) - before;

  db.prepare('UPDATE users SET elo = 800 WHERE id = ?').run(under);
  db.prepare('UPDATE users SET elo = 400 WHERE id = ?').run(over);
  const before2 = elo.get(under);
  elo.applyKill(under, over);        // expected win
  const easyGain = elo.get(under) - before2;

  assert.ok(upsetGain > easyGain, `upset ${upsetGain} should beat easy ${easyGain}`);
});

test('elo is zero-sum per kill and floored at 100', () => {
  const a = auth.register('e1@test.com', 'elo1', 'password123');
  const b = auth.register('e2@test.com', 'elo2', 'password123');
  const beforeSum = elo.get(a) + elo.get(b);
  elo.applyKill(a, b);
  assert.strictEqual(elo.get(a) + elo.get(b), beforeSum, 'elo not zero-sum');

  db.prepare('UPDATE users SET elo = 100 WHERE id = ?').run(b);
  elo.applyKill(a, b);
  assert.ok(elo.get(b) >= 100, 'elo floor breached');
});

console.log('\nauth');

test('passwords are salted, hashed, never stored plain', () => {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(alice);
  assert.ok(!row.password_hash.includes('password123'));
  assert.match(row.password_hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
});

test('login accepts correct password, rejects wrong', () => {
  assert.ok(auth.login('alice@test.com', 'password123'));
  assert.throws(() => auth.login('alice@test.com', 'wrong'), /invalid email or password/);
});

test('duplicate email or username is rejected', () => {
  assert.throws(() => auth.register('alice@test.com', 'other', 'password123'), /taken/);
  assert.throws(() => auth.register('other@test.com', 'alice', 'password123'), /taken/);
});

test('weak input is rejected', () => {
  assert.throws(() => auth.register('bad', 'name', 'password123'), /invalid email/);
  assert.throws(() => auth.register('n@t.com', 'a b', 'password123'), /username must be/);
  assert.throws(() => auth.register('n@t.com', 'nnn', 'short'), /password must be/);
});

test('sessions expire and resolve to the right user', () => {
  const token = auth.createSession(alice);
  assert.strictEqual(auth.userByToken(token).id, alice);
  db.prepare('UPDATE sessions SET expires_at = 0 WHERE token = ?').run(token);
  assert.strictEqual(auth.userByToken(token), null);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
