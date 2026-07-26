'use strict';

// Server-side combat AI for bot-arena / test mode.
// Medium → very good, each bot rolls an archetype so lobbies feel mixed.

const V = require('../public/js/shared/voxel.js');
const config = require('./config');

const CALLSIGNS = [
  'RAZOR', 'VEX', 'NYX', 'GHOST', 'HEX', 'KITE', 'ORBIT', 'DRIFT',
  'PULSE', 'NOVA', 'ECHO', 'WRAITH', 'SABLE', 'ONYX', 'JINX', 'REAP',
  'VOLT', 'ASH', 'CIPHER', 'BLADE', 'FROST', 'IRIS', 'QUAKE', 'SPARK',
  'ZERO', 'HAVOC', 'MOTH', 'LARK', 'CROW', 'PIKE', 'DUSK', 'GLINT',
  'ROOK', 'KNIGHT', 'BISHOP', 'PAWN', 'FLARE', 'TORCH', 'SNAG', 'WIRE',
];

// Higher skill = tighter aim, faster reactions, smarter spacing
const ARCHETYPES = [
  {
    id: 'soldier', weight: 4,
    aimCone: 0.042, aimSmooth: 9.5, reactMs: 210,
    move: 1.0, fireRange: 58, holdDist: 10, weapon: 'rifle',
    adsDist: 32, strafe: 0.85, aggression: 0.55,
  },
  {
    id: 'rusher', weight: 3,
    aimCone: 0.055, aimSmooth: 12, reactMs: 160,
    move: 1.18, fireRange: 32, holdDist: 4, weapon: 'smg',
    adsDist: 999, strafe: 1.15, aggression: 0.85,
  },
  {
    id: 'rifleman', weight: 4,
    aimCone: 0.028, aimSmooth: 11, reactMs: 180,
    move: 1.02, fireRange: 72, holdDist: 14, weapon: 'rifle',
    adsDist: 38, strafe: 1.0, aggression: 0.6,
  },
  {
    id: 'marksman', weight: 2,
    aimCone: 0.014, aimSmooth: 7.5, reactMs: 260,
    move: 0.92, fireRange: 120, holdDist: 42, weapon: 'sniper',
    adsDist: 28, strafe: 0.55, aggression: 0.4,
  },
  {
    id: 'veteran', weight: 3,
    aimCone: 0.022, aimSmooth: 12, reactMs: 150,
    move: 1.08, fireRange: 80, holdDist: 12, weapon: 'rifle',
    adsDist: 34, strafe: 1.1, aggression: 0.7,
  },
  {
    id: 'ace', weight: 2,
    aimCone: 0.010, aimSmooth: 15, reactMs: 120,
    move: 1.12, fireRange: 90, holdDist: 11, weapon: 'rifle',
    adsDist: 30, strafe: 1.25, aggression: 0.75,
  },
  {
    id: 'hunter', weight: 2,
    aimCone: 0.018, aimSmooth: 10, reactMs: 170,
    move: 1.05, fireRange: 95, holdDist: 22, weapon: 'sniper',
    adsDist: 22, strafe: 0.8, aggression: 0.5,
  },
];

function pickArchetype() {
  let total = 0;
  for (const a of ARCHETYPES) total += a.weight;
  let r = Math.random() * total;
  for (const a of ARCHETYPES) {
    r -= a.weight;
    if (r <= 0) return { ...a };
  }
  return { ...ARCHETYPES[0] };
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

class BotAI {
  constructor(player, archetype, nameIdx) {
    this.p = player;
    this.arch = archetype || pickArchetype();
    this.nameIdx = nameIdx | 0;
    // Per-bot variance so two "soldiers" still feel different
    this.arch.aimCone *= 0.85 + Math.random() * 0.35;
    this.arch.reactMs *= 0.9 + Math.random() * 0.25;
    this.arch.move *= 0.95 + Math.random() * 0.12;

    this.targetId = null;
    this.acquireAt = 0;
    this.strafeSign = Math.random() < 0.5 ? 1 : -1;
    this.strafeSwapAt = 0;
    this.jumpUntil = 0;
    this.wanderYaw = Math.random() * Math.PI * 2;
    this.wanderUntil = 0;
    this.lostSightAt = 0;
    this.seq = 0;

    player.weapon = this.arch.weapon;
    player.weaponAmmo[player.weapon] = (config.WEAPONS[player.weapon] || {}).magSize || 24;
  }

  pickTarget(match, now) {
    const me = this.p;
    let best = null;
    let bestScore = Infinity;
    for (const o of match.players.values()) {
      if (o.id === me.id || !o.alive) continue;
      const d = Math.hypot(o.x - me.x, o.y - me.y, o.z - me.z);
      if (d > this.arch.fireRange * 1.35) continue;
      // Prefer closer, slight preference for humans (more fun for tester)
      const humanBias = o.isBot ? 0 : -8;
      const score = d + humanBias + Math.random() * 3;
      if (score < bestScore) { bestScore = score; best = o; }
    }
    if (best) {
      if (this.targetId !== best.id) this.acquireAt = now + this.arch.reactMs;
      this.targetId = best.id;
      this.lostSightAt = 0;
    } else if (this.targetId && !this.lostSightAt) {
      this.lostSightAt = now;
    }
    if (this.lostSightAt && now - this.lostSightAt > 900) this.targetId = null;
    return this.targetId ? match.players.get(this.targetId) : null;
  }

  hasLos(match, target) {
    const me = this.p;
    const eye = me.y + V.PHYS.EYE;
    const tx = target.x, ty = target.y + 1.15, tz = target.z;
    const dx = tx - me.x, dy = ty - eye, dz = tz - me.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const wall = V.raycastVoxels(
      match.world, me.x, eye, me.z,
      dx / dist, dy / dist, dz / dist, dist
    );
    return !wall.hit || wall.dist > dist - 0.7;
  }

  /** Build one 60Hz input frame for shared physics. */
  buildInput(match, now) {
    const me = this.p;
    const arch = this.arch;
    let f = false, b = false, l = false, r = false;
    let jump = false, fire = false, aim = false, reload = false;
    let yaw = me.yaw;
    let pitch = me.pitch;

    const target = this.pickTarget(match, now);
    const dist = target
      ? Math.hypot(target.x - me.x, target.y - me.y, target.z - me.z)
      : Infinity;

    if (target && now >= this.acquireAt) {
      const eye = me.y + V.PHYS.EYE;
      // Lead slightly for movers
      const lead = arch.id === 'ace' || arch.id === 'veteran' ? 0.12 : 0.05;
      const tvx = (target.vx || 0) * lead;
      const tvz = (target.vz || 0) * lead;
      const dx = (target.x + tvx) - me.x;
      const dy = (target.y + 1.12) - eye;
      const dz = (target.z + tvz) - me.z;
      const horiz = Math.hypot(dx, dz) || 1e-6;
      const wantYaw = Math.atan2(-dx, -dz);
      const wantPitch = Math.atan2(dy, horiz);

      // Smooth aim (higher aimSmooth = snappier)
      const dt = V.PHYS.STEP;
      const k = 1 - Math.exp(-arch.aimSmooth * dt);
      yaw = me.yaw + angleDiff(me.yaw, wantYaw) * k;
      pitch = me.pitch + (wantPitch - me.pitch) * k;
      // Cone noise — better bots stay tighter
      const cone = arch.aimCone * (0.7 + Math.random() * 0.6);
      yaw += (Math.random() - 0.5) * cone * 2;
      pitch += (Math.random() - 0.5) * cone * 1.2;
      pitch = clamp(pitch, -1.4, 1.4);

      const los = this.hasLos(match, target);
      aim = dist > 8 && dist < arch.adsDist + 25;

      // Spacing
      if (dist > arch.holdDist + 4) f = true;
      else if (dist < Math.max(3, arch.holdDist - 6)) b = true;

      // Strafe while engaging
      if (now > this.strafeSwapAt) {
        this.strafeSwapAt = now + 400 + Math.random() * 900;
        if (Math.random() < 0.7) this.strafeSign *= -1;
      }
      if (los && dist < arch.fireRange) {
        if (this.strafeSign > 0) r = true;
        else l = true;
        // Occasionally break left/right only (peek rhythm)
        if (Math.random() < 0.08 * arch.strafe) { f = false; b = false; }
      }

      // Shoot when on target-ish + LOS
      const yawErr = Math.abs(angleDiff(yaw, wantYaw));
      const pitchErr = Math.abs(pitch - wantPitch);
      const onTarget = yawErr < arch.aimCone * 2.8 + 0.02 && pitchErr < arch.aimCone * 2.2 + 0.02;
      fire = los && onTarget && dist < arch.fireRange && Math.random() < (0.55 + arch.aggression * 0.4);

      if (!los) {
        // Reposition
        f = true;
        if (Math.random() < 0.5) l = true;
        else r = true;
        fire = false;
      }
    } else {
      // Patrol
      if (now > this.wanderUntil) {
        this.wanderUntil = now + 900 + Math.random() * 1800;
        this.wanderYaw += (Math.random() - 0.5) * 1.8;
      }
      const dt = V.PHYS.STEP;
      const k = 1 - Math.exp(-6 * dt);
      yaw = me.yaw + angleDiff(me.yaw, this.wanderYaw) * k;
      pitch *= 0.9;
      f = true;
      if (Math.random() < 0.04) l = true;
      if (Math.random() < 0.04) r = true;
    }

    // Jump to clear ledges / juke
    if (now > this.jumpUntil && Math.random() < 0.025 * arch.move) {
      this.jumpUntil = now + 280;
    }
    jump = now < this.jumpUntil;

    // Reload when empty or mid-fight low
    if (me.ammo() <= 0) reload = true;
    else if (me.ammo() < 4 && !target && Math.random() < 0.02) reload = true;

    // Sprint-ish: don't ADS while pushing hard
    if (f && dist > arch.holdDist + 10) aim = false;

    return {
      seq: ++this.seq,
      f, b, l, r, jump, crouch: false,
      sprint: f && !aim && dist > 12,
      aim, fire, reload,
      weapon: me.weapon,
      yaw, pitch,
    };
  }
}

function makeBotRoster(count) {
  const used = new Set();
  const list = [];
  for (let i = 0; i < count; i++) {
    let name;
    let guard = 0;
    do {
      const base = CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)];
      name = `AI-${base}`;
      if (used.has(name)) name = `AI-${base}-${i + 1}`;
      guard++;
    } while (used.has(name) && guard < 40);
    used.add(name);
    list.push({ name, arch: pickArchetype() });
  }
  return list;
}

module.exports = { BotAI, makeBotRoster, pickArchetype, ARCHETYPES };
