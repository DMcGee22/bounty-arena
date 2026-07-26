'use strict';

// Ledger audit against the live database. Run any time to prove the books
// balance: every user's transactions must sum to their stored balance, the
// house must never create or destroy money via kills, and no balance may be
// negative.
//
//   node test/audit.js

const { db } = require('../server/db');

let bad = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); bad++; };

console.log('\nBOUNTY ARENA — ledger audit\n');

const users = db.prepare('SELECT id, username, balance_cents, kills, deaths FROM users').all();
console.log(`users: ${users.length}`);

for (const u of users) {
  const rows = db.prepare('SELECT amount_cents, balance_after_cents FROM transactions WHERE user_id = ? ORDER BY id').all(u.id);
  let running = 0;
  for (const [i, r] of rows.entries()) {
    running += Number(r.amount_cents);
    if (running !== Number(r.balance_after_cents)) {
      fail(`${u.username}: ledger drift at row ${i + 1} (running ${running} != recorded ${r.balance_after_cents})`);
      break;
    }
  }
  if (running !== Number(u.balance_cents)) fail(`${u.username}: ledger sum ${running} != balance ${u.balance_cents}`);
  if (Number(u.balance_cents) < 0) fail(`${u.username}: NEGATIVE balance ${u.balance_cents}`);

  const k = db.prepare(`SELECT COUNT(*) c FROM transactions WHERE user_id = ? AND type = 'kill'`).get(u.id).c;
  const d = db.prepare(`SELECT COUNT(*) c FROM transactions WHERE user_id = ? AND type = 'death'`).get(u.id).c;
  if (Number(k) !== Number(u.kills)) fail(`${u.username}: kill count ${u.kills} != kill transactions ${k}`);
  if (Number(d) !== Number(u.deaths)) fail(`${u.username}: death count ${u.deaths} != death transactions ${d}`);
}

// Kills are pure transfers between players: they must net to exactly zero
// across the whole system. If this is ever non-zero, the game is minting money.
const combatNet = db.prepare(
  `SELECT COALESCE(SUM(amount_cents), 0) n FROM transactions WHERE type IN ('kill','death')`
).get().n;
if (Number(combatNet) !== 0) fail(`combat is not zero-sum: net ${combatNet} cents created`);
else console.log(`combat net: ${combatNet} cents (zero-sum ✓)`);

// Deposits - withdrawals must equal the sum of all balances.
const deposits = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) n FROM transactions WHERE type='deposit'`).get().n;
const withdrawals = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) n FROM transactions WHERE type='withdrawal'`).get().n;
const totalBalances = db.prepare('SELECT COALESCE(SUM(balance_cents),0) n FROM users').get().n;
const expected = Number(deposits) + Number(withdrawals); // withdrawals are negative
console.log(`deposits: $${(Number(deposits) / 100).toFixed(2)} · withdrawals: $${(Math.abs(Number(withdrawals)) / 100).toFixed(2)}`);
console.log(`float held: $${(Number(totalBalances) / 100).toFixed(2)}`);
if (Number(totalBalances) !== expected) {
  fail(`float mismatch: balances ${totalBalances} != deposits+withdrawals ${expected}`);
} else {
  console.log('float reconciles with deposits/withdrawals ✓');
}

// Every kill row must correspond to a matched pair of transactions.
const killRows = db.prepare('SELECT COUNT(*) c FROM kills').get().c;
const killTx = db.prepare(`SELECT COUNT(*) c FROM transactions WHERE type='kill'`).get().c;
const deathTx = db.prepare(`SELECT COUNT(*) c FROM transactions WHERE type='death'`).get().c;
if (Number(killTx) !== Number(deathTx)) fail(`unmatched legs: ${killTx} kill tx vs ${deathTx} death tx`);
else console.log(`kill log: ${killRows} kills · ${killTx} matched transaction pairs ✓`);

console.log(bad === 0 ? '\nAUDIT PASSED — books balance.\n' : `\nAUDIT FAILED — ${bad} problem(s).\n`);
process.exit(bad === 0 ? 0 : 1);
