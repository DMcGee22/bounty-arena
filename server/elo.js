'use strict';

// Elo rating. A kill is treated as a decisive game between killer and victim.
// K=24 keeps ratings responsive without wild swings; a kill against a much
// stronger player moves both ratings more than farming weaker ones.

const { db } = require('./db');

const K = 24;
const qGet = db.prepare('SELECT elo FROM users WHERE id = ?');
const qSet = db.prepare('UPDATE users SET elo = ? WHERE id = ?');

function get(userId) {
  const row = qGet.get(userId);
  return row ? Number(row.elo) : 1000;
}

// Returns { killerElo, victimElo } after the kill. Call inside the kill's
// DB transaction so ratings and money commit together.
function applyKill(killerId, victimId) {
  const rk = get(killerId);
  const rv = get(victimId);
  const expectedKiller = 1 / (1 + Math.pow(10, (rv - rk) / 400));
  const delta = Math.max(1, Math.round(K * (1 - expectedKiller)));
  const killerElo = rk + delta;
  const victimElo = Math.max(100, rv - delta);
  qSet.run(killerElo, killerId);
  qSet.run(victimElo, victimId);
  return { killerElo, victimElo };
}

module.exports = { get, applyKill, K };
