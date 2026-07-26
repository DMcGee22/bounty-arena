'use strict';

// All money values are integer cents. Never floats.
module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  DATA_DIR: process.env.DATA_DIR || require('node:path').join(__dirname, '..', 'data'),

  // Money rules
  STAKE_CENTS: 300,            // $3.00 per kill / death
  MIN_DEPOSIT_CENTS: 100,      // $1.00
  MAX_DEPOSIT_CENTS: 50000,    // $500.00 per deposit
  MIN_WITHDRAW_CENTS: 100,

  // Payments: 'sandbox' unless a Stripe key is configured.
  // NOTE: going live with real money requires gaming counsel, licensing,
  // KYC/AML, geo-fencing and processor approval. See README.md.
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || null,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || null,
  PUBLIC_URL: process.env.PUBLIC_URL || null, // needed for Stripe redirect URLs

  // Matchmaking
  MAX_MATCH_PLAYERS: 8,        // matches scale out, not up
  ELO_BAND: 300,               // max avg-Elo distance for SBMM placement

  // Voxel world (blocks). Generated from a seed on both sides — never sent.
  // Larger footprint than the original 96² so fights have room to breathe
  // without turning into a marathon between spawns.
  // Legacy size hints (spawn ring / fog). World XZ is infinite via chunks.
  WORLD_W: 256,
  WORLD_H: 64,             // room for extreme biome peaks / canyons
  WORLD_D: 256,
  MAP_MORPH_MS: 90000,     // sector morph every 90s — keep the map wild

  TICK_HZ: 30,                 // server broadcast rate

  // Speedhack clamp as a token bucket rather than a per-tick cap. Tokens refill
  // at the legitimate input rate, so a cheater flooding inputs cannot outrun
  // anyone, while an honest client that hitched (GC pause, backgrounded tab)
  // can still burn a short burst to catch up instead of being throttled.
  INPUT_RATE_HZ: 60,
  INPUT_BURST: 18,
  INPUT_QUEUE_MAX: 24,         // beyond this, oldest inputs are skipped (not dropped silently)

  CHAT_MIN_INTERVAL_MS: 700,
  CHAT_MAX_LEN: 120,

  // Proximity voice. Range is enforced here rather than in the client: if
  // out-of-earshot audio were still delivered, a modified client could just
  // raise the gain and listen across the map.
  VOICE_RANGE: 34,             // blocks you can be heard from
  VOICE_MAX_FRAME_BYTES: 400,  // 20ms of 16kHz mulaw is 321 bytes
  VOICE_MAX_FRAMES_PER_SEC: 60,

  PLAYER_MAX_HP: 100,
  KILL_HEAL: 40,               // hp restored to the killer on a kill

  // Weapon definitions. Shared with the client via the welcome constants
  // payload so fire rate / mag size / spread match server-side resolution.
  // `hipSpread` / `adsSpread` are cone half-angles (radians-ish units fed to
  // applySpread). Sniper is devastating aimed, nearly useless from the hip.
  WEAPONS: {
    rifle: {
      id: 'rifle',
      name: 'RIFLE',
      damage: 20,              // ~5 body / ~3 head to kill (100 HP)
      headshotMult: 1.75,
      range: 140,
      fireCooldown: 0.14,
      reload: 1.6,
      magSize: 24,
      hipSpread: 0.028,
      adsSpread: 0.004,
      adsFov: 52,
      adsSens: 0.62,
      recoilPitch: 0.010,
      scope: false,
      bulletSpeed: 300,
      bulletDrop: 14,
    },
    smg: {
      id: 'smg',
      name: 'SMG',
      damage: 11,              // shreds close but many shots to drop
      headshotMult: 1.5,
      range: 70,
      fireCooldown: 0.068,
      reload: 1.35,
      magSize: 32,
      hipSpread: 0.042,
      adsSpread: 0.014,
      adsFov: 64,
      adsSens: 0.78,
      recoilPitch: 0.006,
      scope: false,
      bulletSpeed: 230,
      bulletDrop: 18,
    },
    sniper: {
      id: 'sniper',
      name: 'SNIPER',
      damage: 42,              // 3 body / 2 head typical — still punchy, not free
      headshotMult: 1.9,
      range: 220,
      fireCooldown: 1.15,
      reload: 2.5,
      magSize: 5,
      hipSpread: 0.095,
      adsSpread: 0.0004,      // near-true when scoped
      adsFov: 32,             // less extreme zoom = reticle matches aim better
      adsSens: 0.42,
      recoilPitch: 0.022,
      scope: true,
      bulletSpeed: 520,       // flatter trajectory under reticle
      bulletDrop: 3.5,        // holdover only at extreme range
    },
  },
  DEFAULT_WEAPON: 'rifle',
  WEAPON_KEYS: ['rifle', 'smg', 'sniper'],

  // Throwables — long recharge, long range. Shared via welcome.
  THROWABLE_KEYS: ['grenade', 'smoke', 'flash', 'rpg'],
  THROWABLES: {
    grenade: {
      id: 'grenade',
      name: 'GRENADE',
      kind: 'he',
      cooldown: 18,          // seconds between uses
      fuse: 2.4,             // slightly longer fuse so long lobs can land
      speed: 52,             // blocks/s — long arc throws
      gravity: 16,
      bounce: 0.38,
      radius: 6.0,           // damage radius
      damage: 72,            // dangerous near center, not auto-delete
      destroyRadius: 3.8,    // block destruction
      key: '4',
    },
    smoke: {
      id: 'smoke',
      name: 'SMOKE',
      kind: 'smoke',
      cooldown: 24,
      fuse: 1.6,
      speed: 48,
      gravity: 15,
      bounce: 0.25,
      radius: 0,
      damage: 0,
      destroyRadius: 0,
      smokeRadius: 9.5,
      smokeDur: 16,
      key: '5',
    },
    flash: {
      id: 'flash',
      name: 'FLASH',
      kind: 'flash',
      cooldown: 20,
      fuse: 1.7,
      speed: 50,
      gravity: 15,
      bounce: 0.3,
      radius: 10,
      damage: 2,
      destroyRadius: 0,
      flashDur: 2.8,
      key: '6',
    },
    rpg: {
      id: 'rpg',
      name: 'RPG',
      kind: 'rpg',
      cooldown: 36,
      fuse: 0,               // detonates on impact
      speed: 110,            // flat-ish long-range rocket
      gravity: 2.5,
      bounce: 0,
      radius: 7.0,
      damage: 95,            // hard hit / often lethal close, survivable at edge
      destroyRadius: 5.2,
      key: '7',
      direct: true,          // rocket-style, no long fuse bounce
    },
  },

  // Death sequence: short fall + card + killer POV, then back in (~6s total)
  DEATH_FALL_S: 1.2,
  DEATH_CARD_S: 0.8,
  SPECTATE_S: 4.0,
  RESPAWN_S: 6,              // fall + card + spectate before respawn
  SPAWN_PROTECT_S: 2.5,
  SPAWN_MIN_ENEMY_DIST: 28,    // prefer spawns this far from live enemies
  SPAWN_LOS_CHECK: true,       // reject spawns with clear LOS to an enemy
  DISCONNECT_GRACE_S: 5,       // combat-logging: your body stays killable
  VOID_Y: -6,                  // fall below this and you die (suicide, no payout)

  // Map power-ups — walk into a pod to activate (server-authoritative).
  POWERUP_KEYS: ['lowGrav', 'haste', 'superJump', 'overcharge', 'armor'],
  POWERUPS: {
    lowGrav: {
      id: 'lowGrav',
      name: 'ZERO-G',
      label: 'LOW GRAVITY',
      duration: 14,
      color: 0x66ffcc,
      respawn: 26,
    },
    haste: {
      id: 'haste',
      name: 'HASTE',
      label: 'SPEED BOOST',
      duration: 12,
      color: 0xffe14a,
      respawn: 24,
    },
    superJump: {
      id: 'superJump',
      name: 'LAUNCH',
      label: 'SUPER JUMP',
      duration: 14,
      color: 0x9b7bff,
      respawn: 26,
    },
    overcharge: {
      id: 'overcharge',
      name: 'OVERCHARGE',
      label: '+50% DAMAGE',
      duration: 10,
      color: 0xff2d6a,
      respawn: 30,
      dmgOut: 1.5,
    },
    armor: {
      id: 'armor',
      name: 'PLATE',
      label: '50% DAMAGE TAKEN',
      duration: 12,
      color: 0x4d9dff,
      respawn: 28,
      dmgIn: 0.5,
    },
  },
  POWERUP_COUNT: 7,
  POWERUP_RING_MIN: 14,
  POWERUP_RING_MAX: 72,

  // Match-wide chaos events — everyone gets the modifier for a short window.
  CHAOS_INTERVAL_MS: 42000,    // average gap between events
  CHAOS_EVENTS: {
    zeroG: {
      id: 'zeroG', name: 'SECTOR ZERO-G', blurb: 'Everyone floats',
      duration: 16, gravMul: 0.2, jumpMul: 1.4, speedMul: 1.05,
      color: '#66ffcc',
    },
    heavyG: {
      id: 'heavyG', name: 'GRAVITY CRUSH', blurb: 'Heavy legs, hard falls',
      duration: 14, gravMul: 1.85, jumpMul: 0.75, speedMul: 0.9,
      color: '#ff9f1c',
    },
    bloodlust: {
      id: 'bloodlust', name: 'BLOOD HOUR', blurb: '+40% damage dealt',
      duration: 18, dmgOut: 1.4, color: '#ff2d6a',
    },
    speedDemon: {
      id: 'speedDemon', name: 'SPEED DEMON', blurb: 'Everyone sprints hot',
      duration: 16, speedMul: 1.55, jumpMul: 1.15, color: '#ffe14a',
    },
    fortify: {
      id: 'fortify', name: 'FORTIFY', blurb: 'Everyone tanks shots',
      duration: 16, dmgIn: 0.55, color: '#4d9dff',
    },
    skyborn: {
      id: 'skyborn', name: 'SKYBORN', blurb: 'Moon jumps for all',
      duration: 15, gravMul: 0.45, jumpMul: 2.0, speedMul: 1.1,
      color: '#c8a0ff',
    },
    doubleTime: {
      id: 'doubleTime', name: 'DOUBLE TIME', blurb: 'Move + jump chaos',
      duration: 14, speedMul: 1.35, jumpMul: 1.45, gravMul: 0.7,
      color: '#00f0ff',
    },
  },

  SESSION_TTL_MS: 30 * 24 * 3600 * 1000,
};
