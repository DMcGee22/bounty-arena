'use strict';

// Skill-based matchmaking + dynamic match scaling + isolated bot arena.
//
// Bot arena (`?mode=bots`) is a SEPARATE match with 30 server AIs.
// It never receives normal JOIN MATCH traffic and is excluded from PvP stats.

const config = require('./config');
const elo = require('./elo');
const { Match } = require('./match');

const EMPTY_MATCH_TTL_MS = 30 * 1000;
const BOT_ARENA_IDLE_MS = 45 * 1000; // tear down bots when no humans for a bit

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
        // Only keep bot arena while a human is in it (or briefly after leave)
        if (m.humanCount() > 0) {
          m.emptySince = 0;
          return true;
        }
        if (!m.emptySince) m.emptySince = now;
        if (now - m.emptySince > BOT_ARENA_IDLE_MS) {
          m.close();
          if (this.botMatch === m) this.botMatch = null;
          console.log(`[matchmaker] bot arena #${m.dbId} recycled (no humans)`);
          return false;
        }
        return true;
      }
      // Normal PvP: destroy when no humans left
      if (m.humanCount() === 0) {
        if (!m.emptySince) m.emptySince = now;
        if (now - m.emptySince > EMPTY_MATCH_TTL_MS) {
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

  /** Drop a user out of whatever match they're in (mode switch / leave). */
  eject(userId, reason = 'left') {
    const m = this.findMatchOf(userId);
    if (!m) return;
    const p = m.players.get(userId);
    if (p && !p.isBot) m.removePlayer(p, reason);
  }

  // opts.botArena → join / create the 30-bot test match only.
  join(user, socket, opts = {}) {
    const wantBots = !!opts.botArena;
    const current = this.findMatchOf(user.id);

    // Already in a match: rebind only if mode matches; otherwise leave first
    if (current) {
      const curBots = !!current.botArena;
      if (curBots === wantBots) {
        return current.addPlayer(user, socket, elo.get(user.id));
      }
      // Switching PvP ↔ bot arena
      const p = current.players.get(user.id);
      if (p) current.removePlayer(p, wantBots ? 'entered bot arena' : 'entered PvP');
    }

    if (wantBots) {
      const arena = this.ensureBotArena();
      return arena.addPlayer(user, socket, elo.get(user.id));
    }

    // ---- Normal PvP only (never bot arena) ----
    const rating = elo.get(user.id);
    let best = null;
    let bestDiff = Infinity;
    for (const m of this.matches) {
      if (m.botArena) continue;
      const humans = m.humanCount();
      if (humans >= config.MAX_MATCH_PLAYERS) continue;
      const avg = m.avgElo();
      const diff = avg === null ? config.ELO_BAND - 1 : Math.abs(avg - rating);
      const score = diff - (humans > 0 ? 100 : 0);
      if (diff <= config.ELO_BAND && score < bestDiff) {
        best = m;
        bestDiff = score;
      }
    }
    if (!best) {
      best = new Match({ botArena: false });
      this.matches.push(best);
      console.log(`[matchmaker] spun up PvP match #${best.dbId} (now ${this.matches.length} live)`);
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
    let pvpPlayers = 0;
    let pvpMatches = 0;
    let botHumans = 0;
    let bots = 0;
    for (const m of this.matches) {
      if (m.botArena) {
        botHumans += m.humanCount();
        bots += m.botAIs ? m.botAIs.size : 0;
        continue;
      }
      const h = m.humanCount();
      if (h > 0) {
        pvpMatches++;
        pvpPlayers += h;
      }
    }
    return {
      // PvP-only for the normal lobby readout
      matches: pvpMatches,
      players: pvpPlayers,
      // Bot test is separate
      bots,
      botArena: !!(this.botMatch && !this.botMatch.closed && this.matches.includes(this.botMatch)),
      botArenaHumans: botHumans,
    };
  }
}

module.exports = new Matchmaker();
