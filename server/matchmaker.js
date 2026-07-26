'use strict';

// Skill-based matchmaking + dynamic match scaling.
//
// Matches are lightweight instances (see match.js), all ticked by one 30Hz
// loop. A joining player is placed into the open match whose average Elo is
// closest to theirs (within ELO_BAND); if none fits — or everything is full —
// a fresh match is spun up. Empty matches are destroyed after a short idle,
// so the number of concurrent matches breathes with demand.
//
// Scaling beyond one process: matches share nothing but the SQLite ledger, so
// the manager can be sharded across processes/hosts with a routing layer in
// front (see README.md).

const config = require('./config');
const elo = require('./elo');
const { Match } = require('./match');

const EMPTY_MATCH_TTL_MS = 30 * 1000;

class Matchmaker {
  constructor() {
    this.matches = [];
    setInterval(() => this.tick(), 1000 / config.TICK_HZ);
  }

  tick() {
    for (const m of this.matches) m.tick();
    // GC empty matches
    const now = Date.now();
    this.matches = this.matches.filter((m) => {
      if (m.players.size === 0 && now - m.emptySince > EMPTY_MATCH_TTL_MS) {
        m.close();
        return false;
      }
      return true;
    });
  }

  findMatchOf(userId) {
    return this.matches.find(m => m.players.has(userId)) || null;
  }

  // SBMM placement. Returns the Player or null (couldn't afford stake).
  join(user, socket) {
    // Reconnect path: if this user already has a live avatar anywhere, rebind.
    const current = this.findMatchOf(user.id);
    if (current) return current.addPlayer(user, socket, elo.get(user.id));

    const rating = elo.get(user.id);
    let best = null;
    let bestDiff = Infinity;
    for (const m of this.matches) {
      if (m.playerCount() >= config.MAX_MATCH_PLAYERS) continue;
      const avg = m.avgElo();
      const diff = avg === null ? config.ELO_BAND - 1 : Math.abs(avg - rating);
      // prefer populated matches so games actually happen
      const score = diff - (m.playerCount() > 0 ? 100 : 0);
      if (diff <= config.ELO_BAND && score < bestDiff) { best = m; bestDiff = score; }
    }
    if (!best) {
      best = new Match();
      this.matches.push(best);
      console.log(`[matchmaker] spun up match #${best.dbId} (now ${this.matches.length} live)`);
    }
    return best.addPlayer(user, socket, rating);
  }

  isActive(userId) {
    return this.findMatchOf(userId) !== null;
  }

  onBalanceChange(userId) {
    const m = this.findMatchOf(userId);
    if (m) m.onBalanceChange(userId);
  }

  onProfileChange(userId) {
    const m = this.findMatchOf(userId);
    if (m) m.onProfileChange(userId);
  }

  stats() {
    let players = 0;
    for (const m of this.matches) players += m.playerCount();
    return {
      matches: this.matches.filter(m => m.players.size > 0).length,
      players,
    };
  }
}

module.exports = new Matchmaker();
