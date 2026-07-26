'use strict';

const crypto = require('node:crypto');
const { db } = require('./db');
const config = require('./config');

class AuthError extends Error {
  constructor(msg, code = 'AUTH') { super(msg); this.code = code; }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function register(email, username, password) {
  email = String(email || '').trim().toLowerCase();
  username = String(username || '').trim();
  password = String(password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('invalid email', 'BAD_EMAIL');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new AuthError('username must be 3-16 chars (letters, digits, _)', 'BAD_USERNAME');
  if (password.length < 8) throw new AuthError('password must be at least 8 characters', 'BAD_PASSWORD');

  try {
    const info = db.prepare(
      'INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?)'
    ).run(email, username, hashPassword(password));
    return Number(info.lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new AuthError('email or username already taken', 'TAKEN');
    }
    throw err;
  }
}

function login(email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new AuthError('invalid email or password', 'BAD_CREDS');
  }
  return user;
}

/** Instant play: create a sandbox operator with enough balance to enter. */
function guest(preferredName) {
  const tag = crypto.randomBytes(2).toString('hex');
  let base = String(preferredName || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 10);
  if (base.length < 3) base = 'Op';
  let username = `${base}${tag}`;
  if (username.length > 16) username = username.slice(0, 16);
  const email = `guest_${tag}_${Date.now()}@local.poc`;
  const password = crypto.randomBytes(18).toString('hex') + 'Aa1!';
  try {
    const info = db.prepare(
      'INSERT INTO users (email, username, password_hash, balance_cents) VALUES (?, ?, ?, ?)'
    ).run(email, username, hashPassword(password), 10000); // $100 sandbox
    return Number(info.lastInsertRowid);
  } catch (err) {
    // Collision on username — retry once with pure random
    const u2 = `Op${crypto.randomBytes(3).toString('hex')}`;
    const e2 = `guest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@local.poc`;
    const info = db.prepare(
      'INSERT INTO users (email, username, password_hash, balance_cents) VALUES (?, ?, ?, ?)'
    ).run(e2, u2, hashPassword(password), 10000);
    return Number(info.lastInsertRowid);
  }
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + config.SESSION_TTL_MS);
  return token;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function userByToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.email, u.username, u.balance_cents, u.kills, u.deaths, u.pronouns, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    destroySession(token);
    return null;
  }
  return row;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

module.exports = { register, login, guest, createSession, destroySession, userByToken, parseCookies, AuthError };
