'use strict';

const { db, tx } = require('./db');

class WalletError extends Error {
  constructor(msg, code = 'WALLET') { super(msg); this.code = code; }
}

const qBalance = db.prepare('SELECT balance_cents FROM users WHERE id = ?');
const qSetBalance = db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?');
const qInsertTx = db.prepare(
  `INSERT INTO transactions (user_id, amount_cents, balance_after_cents, type, ref)
   VALUES (?, ?, ?, ?, ?)`
);
const qBumpKills = db.prepare('UPDATE users SET kills = kills + 1 WHERE id = ?');
const qBumpDeaths = db.prepare('UPDATE users SET deaths = deaths + 1 WHERE id = ?');

function getBalance(userId) {
  const row = qBalance.get(userId);
  if (!row) throw new WalletError('no such user', 'NO_USER');
  return Number(row.balance_cents);
}

// Applies a signed amount inside an open transaction. Internal.
function apply(userId, amountCents, type, ref) {
  if (!Number.isInteger(amountCents)) throw new WalletError('amount must be integer cents', 'BAD_AMOUNT');
  const bal = getBalance(userId);
  const after = bal + amountCents;
  if (after < 0) throw new WalletError('insufficient funds', 'INSUFFICIENT');
  qSetBalance.run(after, userId);
  qInsertTx.run(userId, amountCents, after, type, ref ?? null);
  return after;
}

function deposit(userId, cents, ref) {
  if (!Number.isInteger(cents) || cents <= 0) throw new WalletError('bad amount', 'BAD_AMOUNT');
  return tx(() => apply(userId, cents, 'deposit', ref));
}

function withdraw(userId, cents, ref) {
  if (!Number.isInteger(cents) || cents <= 0) throw new WalletError('bad amount', 'BAD_AMOUNT');
  return tx(() => apply(userId, -cents, 'withdrawal', ref));
}

const elo = require('./elo');
const qLogKill = db.prepare(
  `INSERT INTO kills (match_id, killer_id, victim_id, amount_cents, killer_elo_after, victim_elo_after)
   VALUES (?, ?, ?, ?, ?, ?)`
);

// The core of the game economy: atomically move `cents` from victim to killer,
// update both Elo ratings and append to the kill log — one transaction, so
// money, ratings and history can never disagree.
function killTransfer(matchId, killerId, killerName, victimId, victimName, cents) {
  return tx(() => {
    const victimAfter = apply(victimId, -cents, 'death', `killed by ${killerName}`);
    const killerAfter = apply(killerId, cents, 'kill', `eliminated ${victimName}`);
    qBumpKills.run(killerId);
    qBumpDeaths.run(victimId);
    const ratings = elo.applyKill(killerId, victimId);
    qLogKill.run(matchId, killerId, victimId, cents, ratings.killerElo, ratings.victimElo);
    return { killerAfter, victimAfter, ...ratings };
  });
}

function history(userId, limit = 25) {
  return db.prepare(
    `SELECT amount_cents, balance_after_cents, type, ref, created_at
     FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?`
  ).all(userId, limit);
}

module.exports = { getBalance, deposit, withdraw, killTransfer, history, WalletError };
