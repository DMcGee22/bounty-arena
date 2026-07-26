'use strict';

// Skill-based matchmaking + dynamic match scaling + persistent bot arena.
//
// Matches are lightweight instances (see match.js), all ticked by one 30Hz
// loop. A joining player is placed into the open match whose average Elo is
// closest to theirs (within ELO_BAND); if none fits — or everything is full —
// a fresh match is spun up. Empty matches are destroyed after a short idle,
// so the number of concurrent matches breathes with demand.
//
// Bot arena (`?mode=bots`) is a separate always-on match with 30 server AIs.

const config = require('./config');
const elo = require('./elo');
const { Match } = require('./match');

const EMPTY_MATCH_TTL_MS = 30 * 1000;

class Matchmaker {
  constructor() {
    this.matches = [];
    this.botMatch = null;
    setInterval(() => this.tick(), 1000 / config.TICK_HZ);
  }

  tick() {
    for (const m of this.matches) m.tick();
    const now = Date.now();
    this.matches = this.matches.filter((m) => {
      if (m.botArena) {
        // Keep bot arena while any human is connected; recycle after idle
        if (m.humanCount() > 0) return true;
        if (now - (m.emptySince || now) > EMPTY_MATCH_TTL_MS * 4) {
          m.close();
          if (this.botMatch === m) this.botMatch = null;
          return false;
        }
        return true;
      }
      if (m.players.size === 0 && now - m.emptySince > EMPTY_MATCH_TTL_MS) {
        m.close();
        return false;
      }
      // Also GC normal matches with no humans (shouldn't happen without bots)
      if (m.humanCount() === 0 && m.players.size > 0 && now - m.emptySince > EMPTY_MATCH_TTL_MS) {
        // only bots left in a non-bot match — close
        if (![...m.players.values()].some((p) => !p.isBot)) {
          m.close();
          return false;
        }
      }
      return true;
    });
  }

  findMatchOf(userId) {
    return this.matches.find((m) => m.players.has(userId)) || null;
  }

  ensureBotArena() {
    if (this.botMatch && !this.botMatch.closed && this.matches.includes(this.botMatch)) {
      return this.botMatch;
    }
    const m = new Match({ botArena: true });
    this.botMatch = m;
    this.matches.push(m);
    console.log(`[matchmaker] bot arena #${m.dbId} with ${m.botAIs.size} AIs`);
    return m;
  }

  // SBMM placement. Returns the Player or null (couldn't afford stake).
  // opts.botArena → join / create the 30-bot test match.
  join(user, socket, opts = {}) {
    // Reconnect path: if this user already has a live avatar anywhere, rebind.
    const current = this.findMatchOf(user.id);
    if (current) return current.addPlayer(user, socket, elo.get(user.id));

    if (opts.botArena) {
      const arena = this.ensureBotArena();
      return arena.addPlayer(user, socket, elo.get(user.id));
    }

    const rating = elo.get(user.id);
    let best = null;
    let bestDiff = Infinity;
    for (const m of this.matches) {
      if (m.botArena) continue; // never dump ranked players into bot meat grinder
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
    let bots = 0;
    for (const m of this.matches) {
      for (const p of m.players.values()) {
        if (p.isBot) bots++;
        else if (!p.disconnectedAt) players++;
      }
    }
    return {
      matches: this.matches.filter((m) => m.humanCount() > 0 || m.botArena).length,
      players,
      bots,
      botArena: !!(this.botMatch && !this.botMatch.closed),
    };
  }
}

module.exports = new Matchmaker();
