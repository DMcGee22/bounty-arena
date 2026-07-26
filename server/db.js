'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(config.DATA_DIR, 'bounty.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
    kills         INTEGER NOT NULL DEFAULT 0,
    deaths        INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL
  );

  -- Append-only ledger. amount_cents is signed; balance_after_cents is the
  -- user's balance immediately after this row was applied.
  CREATE TABLE IF NOT EXISTS transactions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id),
    amount_cents        INTEGER NOT NULL,
    balance_after_cents INTEGER NOT NULL,
    type                TEXT NOT NULL CHECK (type IN ('deposit','withdrawal','kill','death')),
    ref                 TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS matches (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at  TEXT
  );

  -- Every kill ever, with post-kill Elo for both parties: the game-tracking log.
  CREATE TABLE IF NOT EXISTS kills (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id         INTEGER NOT NULL REFERENCES matches(id),
    killer_id        INTEGER NOT NULL REFERENCES users(id),
    victim_id        INTEGER NOT NULL REFERENCES users(id),
    amount_cents     INTEGER NOT NULL,
    killer_elo_after INTEGER NOT NULL,
    victim_elo_after INTEGER NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_kills_killer ON kills(killer_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_kills_victim ON kills(victim_id, id DESC);

  -- Linked crypto wallet per user (address only; payouts are sandbox-queued).
  CREATE TABLE IF NOT EXISTS crypto_wallets (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id),
    chain      TEXT NOT NULL DEFAULT 'ethereum',
    address    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payouts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    amount_cents INTEGER NOT NULL,
    dest         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','simulated','paid','failed')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration for databases created before the elo column existed.
const userCols = db.prepare(`SELECT name FROM pragma_table_info('users')`).all().map(r => r.name);
if (!userCols.includes('elo')) {
  db.exec('ALTER TABLE users ADD COLUMN elo INTEGER NOT NULL DEFAULT 1000');
}
// Optional, player-chosen, shown on their nameplate. Empty means not stated.
if (!userCols.includes('pronouns')) {
  db.exec(`ALTER TABLE users ADD COLUMN pronouns TEXT NOT NULL DEFAULT ''`);
}

// node:sqlite has no transaction helper; the process is single-threaded so a
// simple BEGIN IMMEDIATE wrapper is safe.
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, tx };
