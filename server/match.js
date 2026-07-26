'use strict';

// One authoritative first-person match instance.
//
// Clients predict their own movement locally so the game feels responsive, but
// this file decides what actually happened. Each input carries a sequence
// number; the server re-runs the exact same shared physics step, then reports
// back the authoritative position along with the last sequence it processed, so
// the client can reconcile. Shooting is hitscan and resolved here only — a
// client saying "I hit him" is ignored, because a hit is three dollars.

const config = require('./config');
const wallet = require('./wallet');
const { db } = require('./db');
const V = require('../public/js/shared/voxel.js');

class Player {
  constructor(user, socket, elo) {
    this.id = user.id;
    this.username = user.username;
    this.pronouns = user.pronouns || '';
    this.socket = socket;
    this.balance = wallet.getBalance(user.id);
    this.elo = elo;
    this.match = null;

    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vz = 0;
    this.vy = 0;
    this.onGround = false;
    this.crouching = false;
    this.yaw = 0; this.pitch = 0;

    this.hp = config.PLAYER_MAX_HP;
    this.alive = false;
    this.respawnAt = 0;
    this.protectedUntil = 0;
    this.broke = false;
    this.disconnectedAt = null;

    this.weapon = config.DEFAULT_WEAPON;
    this.weaponAmmo = {};
    for (const id of config.WEAPON_KEYS) {
      this.weaponAmmo[id] = config.WEAPONS[id].magSize;
    }
    this.aiming = false;
    this.reloadingUntil = 0;
    this.lastFireAt = 0;
    this.nextFireAt = 0; // fire-rate schedule (allows limited catch-up)
    // throwableId -> readyAt timestamp (ms)
    this.throwReadyAt = {};
    for (const id of (config.THROWABLE_KEYS || [])) this.throwReadyAt[id] = 0;

    this.inputQueue = [];
    this.lastSeq = 0;
    this.inputTokens = config.INPUT_BURST;
    this.lastTokenRefill = Date.now();
    this.lastChatAt = 0;
    this.voiceWindowStart = 0;
    this.voiceFrames = 0;
    this.sessionKills = 0;
    this.sessionDeaths = 0;
    this.msgWindowStart = 0;
    this.msgCount = 0;
    // Buff timers (seconds) — physics buffs predicted client-side
    this.lowGravT = 0;
    this.hasteT = 0;
    this.superJumpT = 0;
    this.overchargeT = 0;
    this.armorT = 0;
  }

  eyeY() { return this.y + V.eyeOf(this); }
  ammo() { return this.weaponAmmo[this.weapon] ?? 0; }
  setAmmo(n) { this.weaponAmmo[this.weapon] = n; }
  weaponDef() { return config.WEAPONS[this.weapon] || config.WEAPONS[config.DEFAULT_WEAPON]; }
}

const qCreateMatch = db.prepare('INSERT INTO matches DEFAULT VALUES');
const qCloseMatch = db.prepare(`UPDATE matches SET closed_at = datetime('now') WHERE id = ?`);

class Match {
  constructor() {
    this.dbId = Number(qCreateMatch.run().lastInsertRowid);
    this.seed = (Math.random() * 0x7fffffff) | 0;
    this.epoch = 0;
    this.world = new V.World(config.WORLD_W, config.WORLD_H, config.WORLD_D, this.seed);
    this.world.ensureAround(0, 0, 5);
    this.players = new Map();
    this.shots = [];         // tracer events, flushed each tick
    this.explosions = [];    // VFX events flushed each tick
    this.blockChanges = [];  // [[x,y,z,v], ...] flushed each tick
    this.projectiles = [];   // live throwables
    this.nextProjId = 1;
    this.dummies = [];       // practice targets (no money, infinite respawn)
    this.nextDummyId = 1;
    this.powerups = [];      // map pickups
    this.nextPowerupId = 1;
    this.chaos = null;       // { id, name, endsAt, ...mods }
    this.nextChaosAt = Date.now() + (config.CHAOS_INTERVAL_MS || 42000) * (0.55 + Math.random() * 0.5);
    this.emptySince = Date.now();
    this.closed = false;
    this.nextMorphAt = Date.now() + (config.MAP_MORPH_MS || 90000);
    this.spawnPracticeDummies();
    this.seedPowerups();
  }

  // Stationary training targets near origin plaza
  spawnPracticeDummies() {
    this.dummies = [];
    const W = this.world;
    W.ensureAround(0, 0, 3);
    const spots = [
      [14, 0], [-14, 4], [6, -16], [-8, 18],
    ];
    for (let i = 0; i < spots.length; i++) {
      const [sx, sz] = spots[i];
      const y = W.solidSurfaceY(Math.floor(sx), Math.floor(sz));
      this.dummies.push({
        id: this.nextDummyId++,
        name: `TARGET ${i + 1}`,
        x: sx + 0.5,
        y,
        z: sz + 0.5,
        yaw: Math.atan2(-(-sx), -(-sz)),
        hp: 100,
        maxHp: 100,
        alive: true,
        respawnAt: 0,
      });
    }
  }

  // Every 2 minutes: full sector rewrite — new seed + different theme.
  // Re-seat players out of solids.
  maybeMorph(now) {
    if (now < this.nextMorphAt) return;
    this.nextMorphAt = now + (config.MAP_MORPH_MS || 120000);
    this.epoch += 1;
    // Fresh seed every morph so hills / POIs / hub are not a mild remix
    this.seed = (Math.random() * 0x7fffffff) | 0;
    this.world.morph(this.epoch, this.seed);

    // Preload hub + player neighborhoods
    this.world.ensureAround(0, 0, 5);
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      this.world.ensureAround(p.x, p.z, 4);
      // If sealed inside geometry, eject to open air nearby
      if (V.collidesAt(this.world, p.x, p.y, p.z, V.heightOf(p))) {
        const open = this.world.findOpenSpawnNear(p.x, p.z, 32);
        p.x = open.x; p.y = open.y; p.z = open.z;
        p.vx = 0; p.vz = 0; p.vy = 0;
        p.onGround = true;
      } else {
        // Snap down onto surface if floating after morph
        const sy = this.world.solidSurfaceY(Math.floor(p.x), Math.floor(p.z));
        if (p.y > sy + 2.5) p.y = sy;
        if (p.y < sy - 0.05) p.y = sy;
      }
    }

    // Refresh dummies on new terrain
    this.spawnPracticeDummies();
    this.seedPowerups();

    const theme = this.world.theme;
    this.broadcast({
      type: 'morph',
      epoch: this.epoch,
      theme: { id: theme.id, name: theme.name },
      seed: this.seed,
      nextMorphAt: this.nextMorphAt,
    });
    this.broadcast({
      type: 'feed', kind: 'morph',
      text: `◈ SECTOR SHIFT — ${theme.name}`,
    });
  }

  seedPowerups() {
    this.powerups = [];
    const W = this.world;
    W.ensureAround(0, 0, 5);
    const count = config.POWERUP_COUNT || 7;
    const rMin = config.POWERUP_RING_MIN || 14;
    const rMax = config.POWERUP_RING_MAX || 72;
    const kinds = config.POWERUP_KEYS || ['lowGrav'];
    const rot = Math.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      // Shuffle kinds so the map isn't always the same ring order
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      const def = (config.POWERUPS && config.POWERUPS[kind]) || { id: kind, duration: 14, respawn: 28 };
      let x = 0, z = 0, y = 4;
      for (let attempt = 0; attempt < 24; attempt++) {
        const a = rot + (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
        const r = rMin + Math.random() * (rMax - rMin);
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
        W.ensureAround(x, z, 1);
        y = W.solidSurfaceY(Math.floor(x), Math.floor(z)) + 1.15;
        if (y < config.WORLD_H - 6 && !V.collidesAt(W, x, y - 0.5, z, 1.2)) break;
      }
      this.powerups.push({
        id: this.nextPowerupId++,
        kind: def.id || kind,
        x, y, z,
        active: true,
        readyAt: 0,
        duration: def.duration || 14,
        respawn: def.respawn || 28,
      });
    }
  }

  applyPowerup(p, kind, duration) {
    const def = (config.POWERUPS && config.POWERUPS[kind]) || {};
    const dur = duration != null ? duration : (def.duration || 12);
    if (kind === 'lowGrav') p.lowGravT = Math.max(p.lowGravT || 0, dur);
    else if (kind === 'haste') p.hasteT = Math.max(p.hasteT || 0, dur);
    else if (kind === 'superJump') p.superJumpT = Math.max(p.superJumpT || 0, dur);
    else if (kind === 'overcharge') p.overchargeT = Math.max(p.overchargeT || 0, dur);
    else if (kind === 'armor') p.armorT = Math.max(p.armorT || 0, dur);
  }

  tickPowerups(now) {
    for (const pu of this.powerups) {
      if (!pu.active && pu.readyAt && now >= pu.readyAt) {
        const rMin = config.POWERUP_RING_MIN || 14;
        const rMax = config.POWERUP_RING_MAX || 72;
        const a = Math.random() * Math.PI * 2;
        const r = rMin + Math.random() * (rMax - rMin);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        this.world.ensureAround(x, z, 1);
        // Respawn as a random kind so the board stays mixed
        const kinds = config.POWERUP_KEYS || ['lowGrav'];
        const kind = kinds[Math.floor(Math.random() * kinds.length)];
        const def = (config.POWERUPS && config.POWERUPS[kind]) || {};
        pu.kind = def.id || kind;
        pu.duration = def.duration || 14;
        pu.respawn = def.respawn || 28;
        pu.x = x;
        pu.z = z;
        pu.y = this.world.solidSurfaceY(Math.floor(x), Math.floor(z)) + 1.15;
        pu.active = true;
        pu.readyAt = 0;
      }
    }

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      // Combat buff timers (not in shared physics step)
      const dt = 1 / (config.TICK_HZ || 30);
      if (p.overchargeT > 0) p.overchargeT = Math.max(0, p.overchargeT - dt);
      if (p.armorT > 0) p.armorT = Math.max(0, p.armorT - dt);

      for (const pu of this.powerups) {
        if (!pu.active) continue;
        const dx = p.x - pu.x;
        const dy = (p.y + 0.9) - pu.y;
        const dz = p.z - pu.z;
        if (dx * dx + dy * dy + dz * dz > 1.55 * 1.55) continue;
        pu.active = false;
        pu.readyAt = now + (pu.respawn || 28) * 1000;
        this.applyPowerup(p, pu.kind, pu.duration);
        const def = (config.POWERUPS && config.POWERUPS[pu.kind]) || {};
        this.broadcast({
          type: 'powerup',
          kind: pu.kind,
          name: def.name || 'POWER',
          label: def.label || '',
          by: p.username,
          id: p.id,
          puId: pu.id,
          duration: pu.duration || 14,
        });
        this.broadcast({
          type: 'feed', kind: 'powerup',
          text: `${p.username} grabbed ${def.name || 'POWER'}`,
        });
        break;
      }
    }
  }

  // Match-wide chaos events — keep fights from feeling static
  tickChaos(now) {
    if (this.chaos && now >= this.chaos.endsAt) {
      this.broadcast({
        type: 'chaos',
        phase: 'end',
        id: this.chaos.id,
        name: this.chaos.name,
      });
      this.broadcast({
        type: 'feed', kind: 'chaos',
        text: `◈ ${this.chaos.name} faded`,
      });
      this.chaos = null;
      this.nextChaosAt = now + (config.CHAOS_INTERVAL_MS || 42000) * (0.7 + Math.random() * 0.7);
    }

    if (!this.chaos && now >= this.nextChaosAt && this.playerCount() > 0) {
      const table = config.CHAOS_EVENTS || {};
      const keys = Object.keys(table);
      if (!keys.length) return;
      const id = keys[Math.floor(Math.random() * keys.length)];
      const def = table[id];
      const dur = (def.duration || 15) * 1000;
      this.chaos = {
        id: def.id || id,
        name: def.name || id.toUpperCase(),
        blurb: def.blurb || '',
        color: def.color || '#00f0ff',
        endsAt: now + dur,
        gravMul: def.gravMul != null ? def.gravMul : 1,
        jumpMul: def.jumpMul != null ? def.jumpMul : 1,
        speedMul: def.speedMul != null ? def.speedMul : 1,
        dmgOut: def.dmgOut != null ? def.dmgOut : 1,
        dmgIn: def.dmgIn != null ? def.dmgIn : 1,
      };
      this.broadcast({
        type: 'chaos',
        phase: 'start',
        id: this.chaos.id,
        name: this.chaos.name,
        blurb: this.chaos.blurb,
        color: this.chaos.color,
        duration: def.duration || 15,
        endsAt: this.chaos.endsAt,
        mods: {
          gravMul: this.chaos.gravMul,
          jumpMul: this.chaos.jumpMul,
          speedMul: this.chaos.speedMul,
          dmgOut: this.chaos.dmgOut,
          dmgIn: this.chaos.dmgIn,
        },
      });
      this.broadcast({
        type: 'feed', kind: 'chaos',
        text: `⚡ ${this.chaos.name} — ${this.chaos.blurb}`,
      });
    }

    // Stamp event mods onto every living player so shared step() sees them
    for (const p of this.players.values()) {
      if (this.chaos) {
        p.eventGravMul = this.chaos.gravMul;
        p.eventJumpMul = this.chaos.jumpMul;
        p.eventSpeedMul = this.chaos.speedMul;
      } else {
        p.eventGravMul = 1;
        p.eventJumpMul = 1;
        p.eventSpeedMul = 1;
      }
    }
  }

  dmgMultiplier(attacker, victim) {
    let out = 1;
    let inn = 1;
    if (attacker) {
      if ((attacker.overchargeT || 0) > 0) out *= 1.5;
      if (this.chaos && this.chaos.dmgOut) out *= this.chaos.dmgOut;
    }
    if (victim) {
      if ((victim.armorT || 0) > 0) inn *= 0.5;
      if (this.chaos && this.chaos.dmgIn) inn *= this.chaos.dmgIn;
    }
    return out * inn;
  }

  tickDummies(now) {
    for (const d of this.dummies) {
      if (!d.alive && d.respawnAt && now >= d.respawnAt) {
        d.alive = true;
        d.hp = d.maxHp;
        d.respawnAt = 0;
      }
    }
  }

  playerCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.disconnectedAt) n++;
    return n;
  }

  avgElo() {
    if (this.players.size === 0) return null;
    let sum = 0;
    for (const p of this.players.values()) sum += p.elo;
    return sum / this.players.size;
  }

  close() {
    this.closed = true;
    qCloseMatch.run(this.dbId);
  }

  // ---- connection lifecycle -------------------------------------------------

  addPlayer(user, socket, elo) {
    const existing = this.players.get(user.id);
    if (existing) {
      // Reconnect (or second tab): rebind to the live avatar so a dropped
      // connection resumes instead of costing a death.
      try { existing.socket?.close(4000, 'replaced by new connection'); } catch {}
      existing.socket = socket;
      existing.disconnectedAt = null;

      // The reconnecting client starts its input sequence from zero again, so
      // the old high-water mark must be cleared with it. Leaving it in place
      // made every incoming input look stale: the player could still look
      // around and shoot, but could not move at all until the avatar expired.
      existing.lastSeq = 0;
      existing.inputQueue.length = 0;
      existing.inputTokens = config.INPUT_BURST;
      existing.lastTokenRefill = Date.now();

      this.sendWelcome(existing);
      return existing;
    }

    const p = new Player(user, socket, elo);
    if (p.balance < config.STAKE_CENTS) {
      this.send(socket, { type: 'error', code: 'INSUFFICIENT', message: `You need at least $${(config.STAKE_CENTS / 100).toFixed(2)} to enter the arena.` });
      socket.close(4001, 'insufficient funds');
      return null;
    }
    p.match = this;
    this.players.set(p.id, p);
    this.sendWelcome(p);
    this.spawn(p);
    this.broadcast({ type: 'feed', kind: 'join', text: `${p.username} entered the arena` });
    return p;
  }

  sendWelcome(p) {
    this.send(p.socket, {
      type: 'welcome',
      id: p.id,
      username: p.username,
      matchId: this.dbId,
      // Seed + epoch + theme; chunks stream from the same generator on both sides.
      seed: this.seed,
      epoch: this.epoch,
      theme: { id: this.world.theme.id, name: this.world.theme.name },
      nextMorphAt: this.nextMorphAt,
      world: { w: config.WORLD_W, h: config.WORLD_H, d: config.WORLD_D, infinite: true },
      stakeCents: config.STAKE_CENTS,
      constants: {
        maxHp: config.PLAYER_MAX_HP,
        defaultWeapon: config.DEFAULT_WEAPON,
        weapons: config.WEAPONS,
        weaponKeys: config.WEAPON_KEYS,
        throwables: config.THROWABLES || {},
        throwableKeys: config.THROWABLE_KEYS || [],
        powerups: config.POWERUPS || {},
        powerupKeys: config.POWERUP_KEYS || [],
        chaosEvents: config.CHAOS_EVENTS || {},
        morphMs: config.MAP_MORPH_MS || 90000,
        magSize: config.WEAPONS.rifle.magSize,
        fireCooldown: config.WEAPONS.rifle.fireCooldown,
        reload: config.WEAPONS.rifle.reload,
        range: config.WEAPONS.rifle.range,
      },
      balance: p.balance,
      elo: p.elo,
      // Snapshot of live pods so reconnects / late joins see them immediately
      powerups: this.powerups.map((pu) => ({
        id: pu.id, kind: pu.kind, x: pu.x, y: pu.y, z: pu.z, active: !!pu.active,
      })),
      chaos: this.chaos ? {
        id: this.chaos.id, name: this.chaos.name, blurb: this.chaos.blurb,
        color: this.chaos.color, endsAt: this.chaos.endsAt,
      } : null,
    });
  }

  handleDisconnect(player) {
    if (player.socket) player.socket = null;
    player.disconnectedAt = Date.now();
    player.inputQueue.length = 0;
  }

  handleMessage(player, raw) {
    const now = Date.now();
    if (now - player.msgWindowStart > 1000) { player.msgWindowStart = now; player.msgCount = 0; }
    if (++player.msgCount > 200) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'input') {
      const seq = msg.seq | 0;
      if (seq <= player.lastSeq) return;              // stale or replayed
      const yaw = Number(msg.yaw), pitch = Number(msg.pitch);
      // Weapon id must be one we know; anything else is ignored so a modified
      // client cannot invent a third gun with made-up stats.
      const weapon = config.WEAPONS[msg.weapon] ? msg.weapon : null;
      player.inputQueue.push({
        seq,
        f: !!msg.f, b: !!msg.b, l: !!msg.l, r: !!msg.r,
        jump: !!msg.jump,
        crouch: !!msg.crouch,
        sprint: !!msg.sprint,
        aim: !!msg.aim,
        fire: !!msg.fire,
        reload: !!msg.reload,
        weapon,
        yaw: Number.isFinite(yaw) ? yaw : player.yaw,
        pitch: Number.isFinite(pitch) ? Math.max(-1.55, Math.min(1.55, pitch)) : player.pitch,
      });
    } else if (msg.type === 'chat') {
      // The sender's name comes from the authenticated session, never from the
      // message — otherwise anyone could speak as anyone else. Control
      // characters are stripped here; HTML escaping happens at render time.
      if (now - player.lastChatAt < config.CHAT_MIN_INTERVAL_MS) return;
      const text = String(msg.text ?? '')
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
        .trim()
        .slice(0, config.CHAT_MAX_LEN);
      if (!text) return;
      player.lastChatAt = now;
      this.broadcast({ type: 'chat', from: player.username, pronouns: player.pronouns, text });
    } else if (msg.type === 'throw') {
      this.tryThrow(player, msg, now);
    } else if (msg.type === 'ping') {
      this.send(player.socket, { type: 'pong', t: msg.t });
    } else if (msg.type === 'leave') {
      this.removePlayer(player, 'left the arena');
      player.socket?.close(4002, 'left');
    }
  }

  // Relay one voice frame to everyone within earshot. The frame body is opaque
  // to the server — it is never decoded, only forwarded — but WHO receives it
  // is decided here, so a client cannot listen beyond its range.
  handleVoice(player, data) {
    const now = Date.now();
    if (data.length < 2 || data.length > config.VOICE_MAX_FRAME_BYTES) return;

    if (now - player.voiceWindowStart > 1000) { player.voiceWindowStart = now; player.voiceFrames = 0; }
    if (++player.voiceFrames > config.VOICE_MAX_FRAMES_PER_SEC) return;

    const payload = data.subarray(1);          // strip the client's type byte
    const out = Buffer.allocUnsafe(5 + payload.length);
    out[0] = 0x01;                             // voice frame
    out.writeUInt32LE(player.id, 1);
    payload.copy(out, 5);

    const range2 = config.VOICE_RANGE * config.VOICE_RANGE;
    for (const other of this.players.values()) {
      if (other.id === player.id) continue;
      if (!other.socket || other.socket.readyState !== 1) continue;
      const dx = other.x - player.x, dy = other.y - player.y, dz = other.z - player.z;
      if (dx * dx + dy * dy + dz * dz > range2) continue;
      other.socket.send(out);
    }
  }

  removePlayer(player, reason) {
    if (!this.players.has(player.id)) return;
    this.players.delete(player.id);
    if (this.players.size === 0) this.emptySince = Date.now();
    this.broadcast({ type: 'feed', kind: 'leave', text: `${player.username} ${reason}` });
  }

  onBalanceChange(userId) {
    const p = this.players.get(userId);
    if (!p) return;
    p.balance = wallet.getBalance(userId);
    this.send(p.socket, { type: 'balance', balance: p.balance });
  }

  // Pick up profile edits (pronouns) without needing to rejoin the match.
  onProfileChange(userId) {
    const p = this.players.get(userId);
    if (!p) return;
    const row = db.prepare('SELECT pronouns FROM users WHERE id = ?').get(userId);
    p.pronouns = row?.pronouns || '';
  }

  // ---- simulation -----------------------------------------------------------

  spawn(p) {
    const W = this.world;
    W.ensureAround(0, 0, 4);
    const minDist = config.SPAWN_MIN_ENEMY_DIST || 28;
    // Ring around origin hub plaza
    const ring = 22;
    let best = null;

    for (let attempt = 0; attempt < 80; attempt++) {
      let x, z;
      if (attempt < 48) {
        const a = Math.random() * Math.PI * 2;
        const r = ring * (0.7 + Math.random() * 0.55);
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
      } else {
        x = (Math.random() - 0.5) * 50;
        z = (Math.random() - 0.5) * 50;
      }
      W.ensureAround(x, z, 2);
      const y = W.solidSurfaceY(Math.floor(x), Math.floor(z));
      if (y >= config.WORLD_H - 8) continue;
      if (V.collidesAt(W, x, y, z)) continue;

      let nearest = Infinity;
      let losBad = false;
      for (const other of this.players.values()) {
        if (other.id === p.id || !other.alive) continue;
        const d = Math.hypot(other.x - x, other.z - z);
        if (d < nearest) nearest = d;
        if (config.SPAWN_LOS_CHECK && d < minDist * 1.35) {
          const dx = other.x - x, dy = (other.y + 1.2) - (y + V.PHYS.EYE), dz = other.z - z;
          const len = Math.hypot(dx, dy, dz) || 1;
          const wall = V.raycastVoxels(W, x, y + V.PHYS.EYE, z, dx / len, dy / len, dz / len, d);
          if (!wall.hit || wall.dist > d - 0.8) losBad = true;
        }
      }
      if (losBad && nearest < minDist) continue;

      const score = nearest + (losBad ? -8 : 0);
      if (!best || score > best.score) best = { x, y, z, nearest, score };
      if (nearest > minDist * 1.4 && !losBad) break;
    }
    const s = best || W.findOpenSpawnNear(0, 0, 20);
    p.x = s.x; p.y = s.y; p.z = s.z;
    p.vx = 0; p.vz = 0;
    p.vy = 0;
    p.onGround = false;
    p.crouching = false;
    p.aiming = false;
    p.hp = config.PLAYER_MAX_HP;
    p.alive = true;
    p.broke = false;
    p.weapon = config.DEFAULT_WEAPON;
    for (const id of config.WEAPON_KEYS) {
      p.weaponAmmo[id] = config.WEAPONS[id].magSize;
    }
    p.reloadingUntil = 0;
    p.lowGravT = 0;
    p.hasteT = 0;
    p.superJumpT = 0;
    p.overchargeT = 0;
    p.armorT = 0;
    p.protectedUntil = Date.now() + config.SPAWN_PROTECT_S * 1000;
  }

  tick() {
    const now = Date.now();

    for (const p of [...this.players.values()]) {
      if (p.disconnectedAt && now - p.disconnectedAt > config.DISCONNECT_GRACE_S * 1000) {
        this.removePlayer(p, 'disconnected');
      }
    }

    // Chaos mods must be stamped before physics steps this frame
    this.tickChaos(now);

    for (const p of this.players.values()) {
      if (!p.alive) {
        if (p.respawnAt !== 0 && now >= p.respawnAt) {
          if (p.balance >= config.STAKE_CENTS) this.spawn(p);
          else if (!p.broke) {
            p.broke = true;
            this.send(p.socket, { type: 'broke', balance: p.balance, stake: config.STAKE_CENTS });
          }
        }
        p.inputQueue.length = 0;
        continue;
      }

      // If the backlog is beyond what a legitimate client could produce, skip
      // the oldest inputs — but still advance lastSeq past them. Dropping
      // inputs without acknowledging them is what desyncs a predicting client:
      // it keeps replaying moves the server threw away, so it lurches forward
      // and gets snapped back every frame. Acknowledging a skip costs one
      // correction; staying silent costs permanent jitter.
      while (p.inputQueue.length > config.INPUT_QUEUE_MAX) {
        p.lastSeq = p.inputQueue.shift().seq;
      }

      // Token bucket: refill at the honest input rate, spend one per step.
      const elapsed = (now - p.lastTokenRefill) / 1000;
      p.lastTokenRefill = now;
      p.inputTokens = Math.min(config.INPUT_BURST, p.inputTokens + elapsed * config.INPUT_RATE_HZ);

      while (p.inputQueue.length > 0 && p.inputTokens >= 1) {
        const inp = p.inputQueue.shift();
        p.inputTokens -= 1;
        p.yaw = inp.yaw;
        p.pitch = inp.pitch;
        p.aiming = !!inp.aim;

        if (inp.weapon && inp.weapon !== p.weapon) {
          this.switchWeapon(p, inp.weapon);
        }

        V.step(this.world, p, inp);
        p.lastSeq = inp.seq;

        if (inp.reload) this.startReload(p, now);
        if (inp.fire) this.tryFire(p, now);
      }

      if (p.reloadingUntil && now >= p.reloadingUntil) {
        p.setAmmo(p.weaponDef().magSize);
        p.reloadingUntil = 0;
      }

      // fell off the world
      if (p.y < config.VOID_Y) this.killByVoid(p, now);
    }

    // Stream terrain under every living player
    for (const p of this.players.values()) {
      if (p.alive) this.world.ensureAround(p.x, p.z, 3);
    }

    this.tickDummies(now);
    this.tickProjectiles(now);
    this.tickPowerups(now);
    this.maybeMorph(now);
    this.broadcastState(now);
    this.shots.length = 0;
    this.explosions.length = 0;
    this.blockChanges.length = 0;
  }

  tryThrow(player, msg, now) {
    if (!player.alive) return;
    const id = String(msg.id || '');
    const def = config.THROWABLES && config.THROWABLES[id];
    if (!def) return;
    if ((player.throwReadyAt[id] || 0) > now) return;

    const yaw = Number(msg.yaw);
    const pitch = Number(msg.pitch);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;

    player.throwReadyAt[id] = now + def.cooldown * 1000;
    player.protectedUntil = 0;

    // Same launch pose the client aim-line uses (shared throwLaunch)
    const launch = V.throwLaunch(player, yaw, pitch, def);
    const ox = launch.x, oy = launch.y, oz = launch.z;

    const proj = {
      id: this.nextProjId++,
      ownerId: player.id,
      ownerName: player.username,
      kind: def.kind || id,
      throwableId: id,
      x: ox, y: oy, z: oz,
      vx: launch.vx,
      vy: launch.vy,
      vz: launch.vz,
      gravity: def.gravity == null ? 28 : def.gravity,
      bounce: def.bounce == null ? 0.35 : def.bounce,
      fuseLeft: def.fuse || 0,
      direct: !!def.direct,
      radius: def.radius || 0,
      damage: def.damage || 0,
      destroyRadius: def.destroyRadius || 0,
      smokeRadius: def.smokeRadius || 9.5,
      smokeDur: def.smokeDur || 16,
      flashDur: def.flashDur || 0,
      bounces: 0,
      onGround: false,
      flight: 0,
      alive: true,
    };
    this.projectiles.push(proj);

    // Cooldown ack + throw event for all clients (visual rocket/nade)
    this.send(player.socket, {
      type: 'throwCooldown',
      id,
      readyAt: player.throwReadyAt[id],
      cooldown: def.cooldown,
    });
    this.broadcast({
      type: 'throw',
      projId: proj.id,
      ownerId: player.id,
      id,
      kind: proj.kind,
      from: [round2(ox), round2(oy), round2(oz)],
      vel: [round2(proj.vx), round2(proj.vy), round2(proj.vz)],
      fuse: proj.fuseLeft,
      direct: proj.direct,
    });
  }

  tickProjectiles(now) {
    if (!this.projectiles.length) return;
    const dt = 1 / (config.TICK_HZ || 30);
    const still = [];
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      this.world.ensureAround(p.x, p.z, 2);

      const res = V.stepProjectile(this.world, p, dt, {
        gravity: p.gravity,
        bounce: p.bounce,
        direct: p.direct,
        radius: V.PROJ_RADIUS,
        friction: 0.84,
      });

      if (p.direct) {
        // RPG: explode on solid contact, or after long flight
        p.flight = (p.flight || 0) + dt;
        if (res.hit || p.flight > 4.5) {
          this.detonate(p, now);
          continue;
        }
      } else {
        // Lobbed: fuse keeps ticking while rolling on the ground
        p.fuseLeft -= dt;
        if (p.fuseLeft <= 0) {
          this.detonate(p, now);
          continue;
        }
      }
      still.push(p);
    }
    this.projectiles = still;
  }

  detonate(proj, now) {
    proj.alive = false;
    const x = proj.x, y = proj.y, z = proj.z;
    const kind = proj.kind;

    // Block destruction (HE / RPG)
    if (proj.destroyRadius > 0) {
      const blocks = V.destroySphere(
        this.world, Math.floor(x), Math.floor(y), Math.floor(z), proj.destroyRadius
      );
      for (const c of blocks) this.blockChanges.push([c[0], c[1], c[2], c[3]]);
    }

    // Player / dummy damage
    if (proj.damage > 0 && proj.radius > 0) {
      const owner = this.players.get(proj.ownerId);
      for (const vic of this.players.values()) {
        if (!vic.alive) continue;
        if (now < vic.protectedUntil && vic.id !== proj.ownerId) continue;
        const dx = vic.x - x, dy = (vic.y + V.heightOf(vic) * 0.5) - y, dz = vic.z - z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > proj.radius) continue;
        let dmg = V.explosionDamage(proj.damage, dist, proj.radius);
        dmg = Math.max(1, Math.round(dmg * this.dmgMultiplier(
          owner && owner.id !== vic.id ? owner : null,
          vic
        )));
        // Self-blast: damage only, no $ transfer (can't farm yourself)
        if (!owner || vic.id === owner.id) {
          vic.hp -= dmg;
          this.send(vic.socket, {
            type: 'hurt', hp: Math.max(0, vic.hp), by: proj.ownerName || 'blast',
            damage: dmg, headshot: false, zone: 'blast', label: 'BLAST',
            dir: Math.atan2(x - vic.x, -(z - vic.z)),
          });
          if (vic.hp <= 0) this.killByVoid(vic, now);
        } else {
          this.damage(vic, owner, dmg, now, false, 'blast', 'BLAST');
        }
      }
      for (const d of this.dummies) {
        if (!d.alive) continue;
        const dist = Math.hypot(d.x - x, d.y + 0.9 - y, d.z - z);
        if (dist > proj.radius) continue;
        d.hp -= V.explosionDamage(proj.damage, dist, proj.radius);
        if (d.hp <= 0) {
          d.alive = false;
          d.hp = 0;
          d.respawnAt = now + 2000;
        }
      }
    }

    // Flash: blind anyone in radius (LOS not required for punchy arcade feel)
    if (kind === 'flash' && proj.radius > 0) {
      for (const vic of this.players.values()) {
        if (!vic.alive || !vic.socket) continue;
        const dist = Math.hypot(vic.x - x, (vic.y + 1) - y, vic.z - z);
        if (dist > proj.radius) continue;
        const strength = Math.max(0.25, 1 - dist / proj.radius);
        this.send(vic.socket, {
          type: 'flashbang',
          strength,
          dur: (proj.flashDur || 2.5) * strength,
          at: [round2(x), round2(y), round2(z)],
        });
      }
    }

    this.explosions.push({
      id: proj.id,
      kind,
      throwableId: proj.throwableId,
      x: round2(x), y: round2(y), z: round2(z),
      radius: kind === 'smoke' ? (proj.smokeRadius || 9.5) : (proj.radius || 4),
      destroyRadius: proj.destroyRadius || 0,
      smokeDur: proj.smokeDur || 0,
      ownerId: proj.ownerId,
    });
  }

  switchWeapon(p, weaponId) {
    if (!config.WEAPONS[weaponId] || p.weapon === weaponId) return;
    p.weapon = weaponId;
    // Cancel an in-progress reload — magazines are per-weapon, so the timer
    // for the previous gun would fill the wrong one.
    p.reloadingUntil = 0;
  }

  startReload(p, now) {
    const def = p.weaponDef();
    if (p.reloadingUntil || p.ammo() >= def.magSize) return;
    p.reloadingUntil = now + def.reload * 1000;
  }

  tryFire(shooter, now) {
    // Finish reload if the timer already elapsed (don't wait for end-of-tick)
    if (shooter.reloadingUntil && now >= shooter.reloadingUntil) {
      shooter.setAmmo(shooter.weaponDef().magSize);
      shooter.reloadingUntil = 0;
    }
    if (shooter.reloadingUntil) return;
    const def = shooter.weaponDef();
    const cd = (def.fireCooldown || 0.1) * 1000;
    // Schedule-based fire rate so a backlog of inputs can catch up a few
    // shots after a hitch, instead of collapsing to "one shot then silence".
    if (!shooter.nextFireAt) shooter.nextFireAt = 0;
    if (now < shooter.nextFireAt) return;
    if (shooter.ammo() <= 0) { this.startReload(shooter, now); return; }

    // Advance schedule; cap catch-up so a 2s freeze doesn't dump a whole mag at once
    if (shooter.nextFireAt < now - cd * 4) shooter.nextFireAt = now - cd * 3;
    shooter.nextFireAt = Math.max(shooter.nextFireAt, now - cd * 3) + cd;
    shooter.lastFireAt = now;
    shooter.setAmmo(shooter.ammo() - 1);
    shooter.protectedUntil = 0; // firing drops spawn protection

    // Spread is deterministic from shooter id + input seq so the client can
    // draw the same tracer the server actually resolved.
    const rawDir = V.lookDir(shooter.yaw, shooter.pitch);
    const spread = shooter.aiming ? def.adsSpread : def.hipSpread;
    const dir = V.applySpread(rawDir, spread, shooter.id, shooter.lastSeq);
    const ox = shooter.x, oy = shooter.eyeY(), oz = shooter.z;

    // Curved ballistic path (mild drop). Same function the client uses.
    const cast = V.ballisticCast(
      this.world, ox, oy, oz, dir, def.range,
      def.bulletSpeed || 320, def.bulletDrop == null ? 5.5 : def.bulletDrop
    );
    let bestDist = cast.dist;
    let impactX = cast.x, impactY = cast.y, impactZ = cast.z;
    let victim = null;
    let dummyHit = null;
    let headshot = false;

    const hw = V.PHYS.WIDTH / 2;
    for (const p of this.players.values()) {
      if (p.id === shooter.id || !p.alive) continue;
      if (now < p.protectedUntil) continue;
      const ph = V.heightOf(p);
      const hit = V.ballisticHitAABB(
        cast.path,
        p.x - hw, p.y, p.z - hw,
        p.x + hw, p.y + ph, p.z + hw
      );
      if (hit.t >= 0 && hit.t < bestDist) {
        bestDist = hit.t;
        impactX = hit.x; impactY = hit.y; impactZ = hit.z;
        victim = p;
        dummyHit = null;
      }
    }

    // Practice dummies — no money, free aim training
    for (const d of this.dummies) {
      if (!d.alive) continue;
      const hit = V.ballisticHitAABB(
        cast.path,
        d.x - hw, d.y, d.z - hw,
        d.x + hw, d.y + V.PHYS.HEIGHT, d.z + hw
      );
      if (hit.t >= 0 && hit.t < bestDist) {
        bestDist = hit.t;
        impactX = hit.x; impactY = hit.y; impactZ = hit.z;
        victim = null;
        dummyHit = d;
      }
    }

    // Trim path to impact for the tracer
    const pathOut = [];
    let acc = 0;
    pathOut.push(cast.path[0]);
    for (let i = 1; i < cast.path.length; i++) {
      const a = cast.path[i - 1], b = cast.path[i];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (acc + seg >= bestDist) {
        const u = (bestDist - acc) / (seg || 1);
        pathOut.push([
          round2(a[0] + (b[0] - a[0]) * u),
          round2(a[1] + (b[1] - a[1]) * u),
          round2(a[2] + (b[2] - a[2]) * u),
        ]);
        break;
      }
      acc += seg;
      pathOut.push([round2(b[0]), round2(b[1]), round2(b[2])]);
    }

    const struckBlock = (!victim && !dummyHit && cast.hit)
      ? this.world.get(cast.bx, cast.by, cast.bz)
      : 0;
    this.shots.push({
      id: shooter.id,
      from: [round2(ox), round2(oy), round2(oz)],
      to: [round2(impactX), round2(impactY), round2(impactZ)],
      path: pathOut,
      hitPlayer: !!(victim || dummyHit),
      block: struckBlock,
      weapon: shooter.weapon,
    });

    if (shooter.ammo() === 0) this.startReload(shooter, now);

    if (dummyHit) {
      const prof = V.computeDamage(
        def.damage,
        { x: dummyHit.x, y: dummyHit.y, z: dummyHit.z, crouching: false },
        impactX, impactY, impactZ,
        bestDist, def.range,
        shooter.id, shooter.lastSeq
      );
      const dmg = Math.max(1, Math.round(prof.damage * this.dmgMultiplier(shooter, null)));
      dummyHit.hp -= dmg;
      const lethal = dummyHit.hp <= 0;
      if (lethal) dummyHit.hp = 0;
      const isHead = prof.zone === 'brain' || prof.zone === 'head';
      this.send(shooter.socket, {
        type: 'hitmarker',
        headshot: isHead,
        lethal,
        damage: dmg,
        zone: prof.zone,
        label: prof.label,
        weapon: shooter.weapon,
        dummy: true,
        at: [round2(impactX), round2(impactY), round2(impactZ)],
      });
      if (lethal) {
        dummyHit.alive = false;
        dummyHit.hp = 0;
        dummyHit.respawnAt = now + 2000;
        this.send(shooter.socket, {
          type: 'feed', kind: 'dummy',
          text: `${dummyHit.name} down — respawning`,
        });
      }
      return;
    }

    if (!victim) return;

    const prof = V.computeDamage(
      def.damage, victim,
      impactX, impactY, impactZ,
      bestDist, def.range,
      shooter.id, shooter.lastSeq
    );
    const dmg = Math.max(1, Math.round(prof.damage * this.dmgMultiplier(shooter, victim)));
    const isHead = prof.zone === 'brain' || prof.zone === 'head';
    const lethal = victim.hp - dmg <= 0;
    this.send(shooter.socket, {
      type: 'hitmarker',
      headshot: isHead,
      lethal,
      damage: dmg,
      zone: prof.zone,
      label: prof.label,
      weapon: shooter.weapon,
      at: [round2(impactX), round2(impactY), round2(impactZ)],
    });
    this.damage(victim, shooter, dmg, now, isHead, prof.zone, prof.label);
  }

  damage(victim, killer, dmg, now, headshot, zone, label) {
    victim.hp -= dmg;
    this.send(victim.socket, {
      type: 'hurt',
      hp: Math.max(0, victim.hp),
      by: killer.username,
      damage: Math.round(dmg),
      headshot: !!headshot,
      zone: zone || null,
      label: label || null,
      dir: Math.atan2(killer.x - victim.x, -(killer.z - victim.z)),
    });
    if (victim.hp > 0) return;
    this.registerKill(killer, victim, now, headshot, zone, label);
  }

  // Death with no killer: fell into the void. No money moves — you can't lose
  // $3 to nobody, and it stops players farming suicides to grief a match.
  deathTiming() {
    const fallS = config.DEATH_FALL_S ?? 1.5;
    const cardS = config.DEATH_CARD_S ?? 1.0;
    const specS = config.SPECTATE_S ?? 15;
    const totalS = config.RESPAWN_S ?? (fallS + cardS + specS);
    return { fallS, cardS, specS, totalS };
  }

  killByVoid(victim, now) {
    victim.alive = false;
    victim.hp = 0;
    victim.lowGravT = 0;
    victim.hasteT = 0;
    victim.superJumpT = 0;
    victim.overchargeT = 0;
    victim.armorT = 0;
    const t = this.deathTiming();
    victim.respawnAt = now + t.totalS * 1000;
    this.broadcast({ type: 'feed', kind: 'kill', text: `${victim.username} fell out of the world`, victimId: victim.id });
    this.send(victim.socket, {
      type: 'died',
      by: 'the void',
      killerId: null,
      balance: victim.balance,
      delta: 0,
      respawnAt: victim.respawnAt,
      canAfford: victim.balance >= config.STAKE_CENTS,
      elo: victim.elo,
      fallS: t.fallS,
      cardS: t.cardS,
      spectateS: 0, // no killer to watch
      x: victim.x, y: victim.y, z: victim.z,
      yaw: victim.yaw, pitch: victim.pitch,
    });
  }

  registerKill(killer, victim, now, headshot, zone, label) {
    victim.alive = false;
    victim.hp = 0;
    victim.lowGravT = 0;
    victim.hasteT = 0;
    victim.superJumpT = 0;
    victim.overchargeT = 0;
    victim.armorT = 0;
    const t = this.deathTiming();
    victim.respawnAt = now + t.totalS * 1000;
    victim.sessionDeaths++;
    victim.inputQueue.length = 0;

    killer.sessionKills++;
    killer.hp = Math.min(config.PLAYER_MAX_HP, killer.hp + config.KILL_HEAL);

    // THE money moment. Atomic: victim -$3, killer +$3, Elo updated, kill
    // logged — or none of it.
    let transfer = null;
    try {
      transfer = wallet.killTransfer(this.dbId, killer.id, killer.username, victim.id, victim.username, config.STAKE_CENTS);
    } catch (err) {
      console.error('[match] kill transfer FAILED', { match: this.dbId, killer: killer.id, victim: victim.id, err: err.message });
    }
    if (transfer) {
      killer.balance = transfer.killerAfter;
      victim.balance = transfer.victimAfter;
      killer.elo = transfer.killerElo;
      victim.elo = transfer.victimElo;
    }

    this.broadcast({
      type: 'kill',
      killer: killer.username,
      victim: victim.username,
      // ids let other clients place the victim's scream in the world
      victimId: victim.id,
      killerId: killer.id,
      headshot: !!headshot,
      zone: zone || null,
      label: label || null,
      weapon: killer.weapon,
      amount: transfer ? config.STAKE_CENTS : 0,
      // death pose so other clients can play a fall on the body
      x: victim.x, y: victim.y, z: victim.z,
      yaw: victim.yaw,
    });
    this.send(killer.socket, {
      type: 'balance', balance: killer.balance,
      delta: transfer ? config.STAKE_CENTS : 0, reason: 'kill', elo: killer.elo,
    });
    this.send(victim.socket, {
      type: 'died',
      by: killer.username,
      killerId: killer.id,
      balance: victim.balance,
      delta: transfer ? -config.STAKE_CENTS : 0,
      respawnAt: victim.respawnAt,
      canAfford: victim.balance >= config.STAKE_CENTS,
      elo: victim.elo,
      fallS: t.fallS,
      cardS: t.cardS,
      spectateS: t.specS,
      x: victim.x, y: victim.y, z: victim.z,
      yaw: victim.yaw, pitch: victim.pitch,
      headshot: !!headshot,
      zone: zone || null,
      label: label || null,
      weapon: killer.weapon,
    });
  }

  // ---- networking -----------------------------------------------------------

  send(socket, obj) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj));
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.socket && p.socket.readyState === 1) p.socket.send(s);
    }
  }

  broadcastState(now) {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        u: p.username,
        pr: p.pronouns,
        x: round2(p.x), y: round2(p.y), z: round2(p.z),
        yaw: round3(p.yaw), pitch: round3(p.pitch),
        crouch: !!p.crouching,
        aim: !!p.aiming,
        w: p.weapon,
        hp: p.hp,
        alive: p.alive,
        prot: now < p.protectedUntil,
        k: p.sessionKills,
        d: p.sessionDeaths,
        elo: p.elo,
        gone: !!p.disconnectedAt,
        rs: p.alive ? 0 : p.respawnAt,
        lg: (p.lowGravT || 0) > 0.05,
        hs: (p.hasteT || 0) > 0.05,
        oc: (p.overchargeT || 0) > 0.05,
        ar: (p.armorT || 0) > 0.05,
      });
    }
    const dummies = this.dummies.map((d) => ({
      id: d.id,
      u: d.name,
      x: round2(d.x), y: round2(d.y), z: round2(d.z),
      yaw: round3(d.yaw),
      hp: Math.max(0, Math.round(d.hp)),
      alive: d.alive,
    }));
    // Each client needs its own last-processed sequence for reconciliation, so
    // the state frame is personalised rather than a single broadcast blob.
    const throwCd = {};
    const base = {
      type: 'state', t: now, players, shots: this.shots, dummies,
      explosions: this.explosions,
      blocks: this.blockChanges.length ? this.blockChanges : undefined,
    };
    for (const p of this.players.values()) {
      if (!p.socket || p.socket.readyState !== 1) continue;
      // Per-player throwable cooldown snapshot
      const cds = {};
      for (const id of (config.THROWABLE_KEYS || [])) {
        cds[id] = Math.max(0, (p.throwReadyAt[id] || 0) - now);
      }
      p.socket.send(JSON.stringify({
        ...base,
        seq: p.lastSeq,
        ammo: p.ammo(),
        weapon: p.weapon,
        reloading: p.reloadingUntil ? Math.max(0, p.reloadingUntil - now) : 0,
        throwCd: cds,
        // Full physics state for this client only. Prediction replay needs
        // velocity and ground contact, not just position, or the client would
        // re-simulate falls and jumps from the wrong starting conditions.
        self: {
          x: p.x, y: p.y, z: p.z,
          vx: p.vx || 0, vz: p.vz || 0, vy: p.vy,
          onGround: p.onGround,
          crouching: !!p.crouching,
          lowGravT: Math.max(0, p.lowGravT || 0),
          hasteT: Math.max(0, p.hasteT || 0),
          superJumpT: Math.max(0, p.superJumpT || 0),
          overchargeT: Math.max(0, p.overchargeT || 0),
          armorT: Math.max(0, p.armorT || 0),
          eventGravMul: p.eventGravMul != null ? p.eventGravMul : 1,
          eventJumpMul: p.eventJumpMul != null ? p.eventJumpMul : 1,
          eventSpeedMul: p.eventSpeedMul != null ? p.eventSpeedMul : 1,
        },
        powerups: this.powerups.map((pu) => ({
          id: pu.id,
          kind: pu.kind,
          x: round2(pu.x), y: round2(pu.y), z: round2(pu.z),
          active: !!pu.active,
        })),
        chaos: this.chaos ? {
          id: this.chaos.id,
          name: this.chaos.name,
          blurb: this.chaos.blurb,
          color: this.chaos.color,
          endsAt: this.chaos.endsAt,
        } : null,
      }));
    }
  }
}

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

module.exports = { Match };
