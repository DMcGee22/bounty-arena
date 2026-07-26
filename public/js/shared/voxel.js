// Shared voxel world, physics and raycasting. Loaded by BOTH the server
// (require) and the browser (script tag -> window.BountyVoxel).
//
// This file is shared on purpose. The client predicts its own movement so the
// game feels responsive, and the server re-simulates the same inputs to decide
// what actually happened. If the two used different movement code the client
// would constantly snap and rubber-band, so there is exactly one implementation
// and both sides run it.
//
// It uses only integer hashing and basic float arithmetic — no Math.sin/random
// in world generation — so a given seed produces a byte-identical world in Node
// and in every browser. The world is never transmitted; only the seed is.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BountyVoxel = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- block types ---------------------------------------------------------

  const AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, COBBLE = 4,
        PLANKS = 5, LOG = 6, LEAVES = 7, SAND = 8, BRICK = 9, IRON = 10,
        LADDER = 11;

  // tile indices into the 4x4 texture atlas built by the client
  const BLOCKS = {
    [GRASS]:  { top: 0,  side: 1,  bottom: 2 },
    [DIRT]:   { top: 2,  side: 2,  bottom: 2 },
    [STONE]:  { top: 3,  side: 3,  bottom: 3 },
    [COBBLE]: { top: 4,  side: 4,  bottom: 4 },
    [PLANKS]: { top: 5,  side: 5,  bottom: 5 },
    [LOG]:    { top: 7,  side: 6,  bottom: 7 },
    [LEAVES]: { top: 8,  side: 8,  bottom: 8 },
    [SAND]:   { top: 9,  side: 9,  bottom: 9 },
    [BRICK]:  { top: 10, side: 10, bottom: 10 },
    [IRON]:   { top: 11, side: 11, bottom: 11 },
    [LADDER]: { top: 12, side: 12, bottom: 12 },
  };

  // ---- deterministic noise -------------------------------------------------

  function hash2(x, y, seed) {
    let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1442695040;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  const smooth = (t) => t * t * (3 - 2 * t);

  function valueNoise(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
    const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  function fbm(x, y, seed, octaves) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += valueNoise(x * freq, y * freq, seed + i * 7919) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  // ---- world (chunked, infinite XZ, multi-theme) -----------------------------

  const CHUNK = 16;
  // Extreme biome set — huge amp / personality so sector morphs feel like a new game.
  // `smooth: true` → client renders continuous heightfield terrain (experimental).
  const THEMES = [
    { id: 'neon',     name: 'NEON SPIRE MEGA',   base: 12, amp: 9.5,  wet: 0, cold: 0, harsh: 1 },
    { id: 'forest',   name: 'TITAN CANOPY',      base: 14, amp: 12.0, wet: 1, cold: 0, harsh: 0 },
    { id: 'desert',   name: 'DUNE CATASTROPHE',  base: 10, amp: 14.0, wet: 0, cold: 0, harsh: 1 },
    { id: 'snow',     name: 'GLACIER FANG',      base: 16, amp: 16.0, wet: 0, cold: 1, harsh: 1 },
    { id: 'volcanic', name: 'MAGMA CALDERA',     base: 11, amp: 15.0, wet: 0, cold: 0, harsh: 1 },
    { id: 'coast',    name: 'CLIFF HELL',        base: 8,  amp: 13.0, wet: 1, cold: 0, harsh: 1 },
    { id: 'farm',     name: 'SCRAPYARD ABYSS',   base: 11, amp: 8.0,  wet: 0, cold: 0, harsh: 0 },
    { id: 'canyon',   name: 'GOD CANYON',        base: 18, amp: 18.0, wet: 0, cold: 0, harsh: 1 },
    { id: 'storm',    name: 'STORM CROWN',       base: 13, amp: 11.0, wet: 1, cold: 0, harsh: 1 },
    { id: 'void',     name: 'VOID SHELF',        base: 9,  amp: 10.0, wet: 0, cold: 1, harsh: 1 },
    // Experimental: rolling natural hills — not a mega-city block world
    { id: 'wilds',    name: 'OPEN WILDS',        base: 12, amp: 5.5,  wet: 1, cold: 0, harsh: 0, smooth: true },
  ];

  // Pick a theme from seed/epoch. Optionally skip a previous id so morphs never
  // repeat the same biome back-to-back.
  function themeFor(seed, epoch, avoidId) {
    const pool = avoidId
      ? THEMES.filter((t) => t.id !== avoidId)
      : THEMES;
    const list = pool.length ? pool : THEMES;
    const i = Math.floor(hash2(epoch * 31 + 7, 113, seed) * list.length) % list.length;
    return list[i];
  }

  class World {
    // Compat: new World(w, h, d, seed) OR new World(seed, h) — XZ is infinite.
    constructor(wOrSeed, h, d, seed) {
      if (typeof d === 'number' && seed != null) {
        this.seed = seed | 0;
        this.h = h | 0;
        // keep legacy fields for HUD/fog estimates
        this.w = wOrSeed | 0;
        this.d = d | 0;
      } else {
        this.seed = (wOrSeed | 0);
        this.h = (h | 0) || 48;
        this.w = 256;
        this.d = 256;
      }
      if (this.h < 32) this.h = 48;
      this.chunkSize = CHUNK;
      this.chunks = new Map();
      this.epoch = 0;
      this.theme = themeFor(this.seed, this.epoch);
      this._landmarks = null; // computed once per epoch
    }

    chunkKey(cx, cz) { return cx + ':' + cz; }

    worldToChunk(x, z) {
      const cs = this.chunkSize;
      const cx = Math.floor(x / cs);
      const cz = Math.floor(z / cs);
      const lx = x - cx * cs;
      const lz = z - cz * cs;
      return { cx, cz, lx, lz };
    }

    ensureChunk(cx, cz) {
      const k = this.chunkKey(cx, cz);
      if (this.chunks.has(k)) return this.chunks.get(k);
      const data = this.generateChunk(cx, cz);
      this.chunks.set(k, data);
      return data;
    }

    // Force-load a radius of chunks around a world position
    ensureAround(wx, wz, radiusChunks = 4) {
      const cs = this.chunkSize;
      const ccx = Math.floor(wx / cs);
      const ccz = Math.floor(wz / cs);
      for (let dz = -radiusChunks; dz <= radiusChunks; dz++)
        for (let dx = -radiusChunks; dx <= radiusChunks; dx++)
          this.ensureChunk(ccx + dx, ccz + dz);
    }

    get(x, y, z) {
      x = x | 0; y = y | 0; z = z | 0;
      if (y < 0) return STONE;
      if (y >= this.h) return AIR;
      const { cx, cz, lx, lz } = this.worldToChunk(x, z);
      const data = this.ensureChunk(cx, cz);
      return data[(y * CHUNK + lz) * CHUNK + lx];
    }

    set(x, y, z, v) {
      x = x | 0; y = y | 0; z = z | 0;
      if (y < 0 || y >= this.h) return;
      const { cx, cz, lx, lz } = this.worldToChunk(x, z);
      const data = this.ensureChunk(cx, cz);
      data[(y * CHUNK + lz) * CHUNK + lx] = v;
    }

    isSolid(x, y, z) {
      if (y < 0) return true;
      if (y >= this.h) return false;
      const b = this.get(x, y, z);
      return b !== AIR && b !== LADDER;
    }

    isLadder(x, y, z) { return this.get(x, y, z) === LADDER; }

    surfaceY(x, z) {
      for (let y = this.h - 1; y >= 0; y--) if (this.get(x, y, z) !== AIR) return y + 1;
      return 1;
    }

    solidSurfaceY(x, z) {
      for (let y = this.h - 1; y >= 0; y--) if (this.isSolid(x, y, z)) return y + 1;
      return 1;
    }

    // Wipe all chunks and advance theme (map morph).
    // newSeed (optional): full reseed so terrain is not a mild remix of the old map.
    morph(epoch, newSeed) {
      const prevId = this.theme?.id;
      this.epoch = epoch | 0;
      if (newSeed != null && Number.isFinite(+newSeed)) this.seed = (+newSeed) | 0;
      this.theme = themeFor(this.seed, this.epoch, prevId);
      this.chunks.clear();
      this._landmarks = null;
    }

    // Per-epoch salt used to warp noise / layout so morphs feel unrelated
    layoutSalt() {
      return (this.seed + this.epoch * 104729) | 0;
    }

    landmarks() {
      if (this._landmarks) return this._landmarks;
      const seed = this.layoutSalt();
      const tid = this.theme.id;
      const list = [];
      // Origin hub plaza always exists (layout inside hub is seed-driven)
      list.push({ type: 'hub', x: 0, z: 0 });

      // Theme-specific POI kits — denser, taller, more aggressive silhouettes
      const kits = {
        neon:     ['building', 'building', 'walkway', 'tower', 'plaza_deck', 'spire', 'tower'],
        forest:   ['ruin_keep', 'tree_platform', 'ruins', 'deck', 'spire', 'tree_platform'],
        desert:   ['mesa', 'temple', 'bunker', 'ruins', 'tower', 'mesa'],
        snow:     ['fort', 'tower', 'deck', 'ruin_keep', 'spire', 'fort'],
        volcanic: ['basalt', 'tower', 'bunker', 'mesa', 'spire', 'basalt'],
        coast:    ['pier', 'warehouse', 'deck', 'tower', 'walkway', 'cliff_pad'],
        farm:     ['barn', 'silo', 'deck', 'warehouse', 'ruins', 'silo'],
        canyon:   ['bridge', 'cliff_pad', 'mesa', 'ruin_keep', 'tower', 'bridge'],
        storm:    ['tower', 'spire', 'plaza_deck', 'walkway', 'fort', 'tower'],
        void:     ['spire', 'mesa', 'deck', 'tower', 'bridge', 'spire'],
        wilds:    ['ruins', 'ruin_keep', 'deck', 'cliff_pad', 'bridge', 'ruins'],
      };
      const kinds = kits[tid] || kits.neon;

      // More POIs, further out, much taller
      const innerN = 8 + Math.floor(hash2(1, 9, seed) * 6);   // 8–13
      const outerN = 12 + Math.floor(hash2(2, 9, seed) * 10); // 12–21
      const total = innerN + outerN;
      const rot = hash2(3, 9, seed) * Math.PI * 2;
      const innerMin = 20 + hash2(4, 9, seed) * 16;
      const innerSpan = 32 + hash2(5, 9, seed) * 45;
      const outerMin = 50 + hash2(6, 9, seed) * 35;
      const outerSpan = 80 + hash2(7, 9, seed) * 140;

      for (let i = 0; i < total; i++) {
        const inner = i < innerN;
        const ang = rot + hash2(i, 1, seed) * Math.PI * 2;
        const dist = inner
          ? innerMin + hash2(i, 2, seed) * innerSpan
          : outerMin + hash2(i, 2, seed) * outerSpan;
        const x = Math.floor(Math.cos(ang) * dist);
        const z = Math.floor(Math.sin(ang) * dist);
        const kind = kinds[Math.floor(hash2(i, 3, seed) * kinds.length) % kinds.length];
        list.push({
          type: kind, x, z,
          h: 8 + Math.floor(hash2(i, 4, seed) * 16), // was 4–13, now 8–23
          w: 3 + Math.floor(hash2(i, 5, seed) * 6),
        });
      }
      this._landmarks = list;
      return list;
    }

    // Continuous height field (float). Integer collision uses floor().
    heightField(x, z) {
      const th = this.theme;
      const salt = this.layoutSalt();
      const ox = (hash2(11, 1, salt) - 0.5) * 800;
      const oz = (hash2(11, 2, salt) - 0.5) * 800;
      const sc = th.smooth
        ? 0.55 + hash2(11, 3, salt) * 0.55   // calmer frequencies for natural hills
        : 0.35 + hash2(11, 3, salt) * 1.4;
      const rot = hash2(11, 4, salt) * Math.PI * 2;
      const cosR = Math.cos(rot), sinR = Math.sin(rot);
      const rx = (x + ox) * cosR - (z + oz) * sinR;
      const rz = (x + ox) * sinR + (z + oz) * cosR;
      const seed = salt;
      const scaleA = 22 / sc;
      const scaleB = 9 / sc;
      const n = fbm(rx / scaleA, rz / scaleA, seed, th.smooth ? 6 : 5);
      const ridge = fbm(rx / scaleB + 40, rz / scaleB + 40, seed + 19, th.smooth ? 5 : 4);
      const warp = fbm(rx / 55, rz / 55, seed + 101, 3);
      const baseShift = th.smooth
        ? (hash2(11, 5, salt) - 0.5) * 6
        : Math.floor((hash2(11, 5, salt) - 0.5) * 20);
      let height =
        (th.base + baseShift)
        + n * th.amp * (1.1 + hash2(11, 6, salt) * 0.7)
        + ridge * (th.harsh ? 5.5 : (th.smooth ? 1.4 : 2.8))
        + (warp - 0.5) * th.amp * (th.smooth ? 0.28 : 0.55);

      // —— Extreme theme personalities ——
      if (th.id === 'canyon') {
        // Deep gashes + towering mesas
        const cut = fbm(rx / 14, rz / 14, seed + 77, 4);
        if (cut < 0.42) height = Math.max(3, height - 14 - Math.floor(cut * 18));
        else if (cut > 0.78) height = Math.min(this.h - 10, height + 8 + Math.floor(ridge * 10));
      } else if (th.id === 'coast') {
        // Sheer cliff walls out of the waterline
        const shore = fbm(rx / 28, rz / 28, seed + 33, 3);
        if (shore < 0.36) height = Math.max(3, th.base + baseShift - 4 - Math.floor((0.36 - shore) * 20));
        else if (shore > 0.7) height = Math.min(this.h - 10, height + 10 + Math.floor(ridge * 8));
      } else if (th.id === 'volcanic') {
        // Calderas, cones, lava trenches
        const vent = fbm(rx / 12, rz / 12, seed + 55, 4);
        if (vent > 0.68) height = Math.min(this.h - 8, height + 10 + Math.floor((vent - 0.68) * 40));
        if (vent < 0.22) height = Math.max(3, height - 8 - Math.floor((0.22 - vent) * 30));
        // Ring caldera around landmark-ish noise peaks
        const ring = Math.abs(vent - 0.55);
        if (ring < 0.06) height = Math.max(4, height - 12);
      } else if (th.id === 'snow') {
        // Alpine knife ridges
        height = Math.floor(height + ridge * 6 + Math.abs(n - 0.5) * 8);
        const pass = fbm(rx / 20, rz / 20, seed + 88, 2);
        if (pass < 0.3) height = Math.max(5, height - 7);
      } else if (th.id === 'desert') {
        // Mega dunes + flat salt pans
        const dune = Math.sin(rx * 0.09 + salt * 0.01) * Math.cos(rz * 0.07);
        height = Math.floor(height + dune * 10 + ridge * 4);
        const pan = fbm(rx / 35, rz / 35, seed + 44, 2);
        if (pan < 0.28) height = Math.max(4, th.base + baseShift - 2);
      } else if (th.id === 'farm') {
        // Brutal terraces + deep trenches
        height = Math.floor(height / 3) * 3;
        const trench = fbm(rx / 16, rz / 16, seed + 12, 3);
        if (trench < 0.3) height = Math.max(4, height - 9);
        if (trench > 0.75) height += 5;
      } else if (th.id === 'forest') {
        // Rolling basalt + giant knolls for tree platforms
        const knoll = fbm(rx / 8, rz / 8, seed + 91, 3);
        if (knoll > 0.55) height += 3 + Math.floor((knoll - 0.55) * 20);
        const hollow = fbm(rx / 25, rz / 25, seed + 3, 2);
        if (hollow < 0.25) height = Math.max(5, height - 6);
      } else if (th.id === 'neon') {
        // Stepped megacity pads + sky-bridge elevation bands
        height = Math.floor(height / 3) * 3;
        const pad = fbm(rx / 18, rz / 18, seed + 66, 2);
        if (pad > 0.7) height += 6 + Math.floor(pad * 8);
        if (pad < 0.2) height = Math.max(5, height - 5);
      } else if (th.id === 'storm') {
        // Jagged thunder-mesa terrain
        height = Math.floor(height + Math.abs(ridge - 0.5) * 14);
        const bolt = fbm(rx / 10, rz / 10, seed + 201, 3);
        if (bolt > 0.8) height = Math.min(this.h - 8, height + 12);
        if (bolt < 0.2) height = Math.max(4, height - 8);
      } else if (th.id === 'void') {
        // Floating shelves: large pits of "void" (low ground) + raised islands
        const shelf = fbm(rx / 16, rz / 16, seed + 303, 4);
        if (shelf < 0.45) height = Math.max(3, 4 + Math.floor(shelf * 6));
        else height = Math.min(this.h - 10, height + 6 + Math.floor((shelf - 0.45) * 22));
      } else if (th.id === 'wilds') {
        // Broad rolling hills + gentle valleys (continuous, not terraced)
        const roll = fbm(rx / 38, rz / 38, seed + 501, 5);
        const detail = fbm(rx / 11, rz / 11, seed + 502, 3);
        height = th.base + baseShift + roll * th.amp * 1.6 + (detail - 0.5) * 2.2;
        const valley = fbm(rx / 48, rz / 48, seed + 503, 3);
        if (valley < 0.32) height -= (0.32 - valley) * 7;
      }

      // Hub plaza flatten — still fightable, not totally flat pancake
      const plazaR = 14 + Math.floor(hash2(12, 1, salt) * 8);
      const dist0 = Math.sqrt(x * x + z * z);
      if (dist0 < plazaR) {
        const t = dist0 / plazaR;
        const padH = Math.max(8, Math.min(this.h - 20, th.base + Math.floor(baseShift * 0.35)));
        height = height * smooth(t) * 0.55 + padH * (1 - smooth(t) * 0.55);
        if (!th.smooth) height = Math.round(height);
      }
      // Soft roads (skip heavy flattening on natural wilds)
      if (!th.smooth) {
        const roadMode = Math.floor(hash2(12, 2, salt) * 4);
        const roadLen = 50 + Math.floor(hash2(12, 3, salt) * 70);
        if (dist0 < roadLen) {
          let onRoad = false;
          if (roadMode === 0) onRoad = Math.abs(x) <= 2 || Math.abs(z) <= 2;
          else if (roadMode === 1) onRoad = Math.abs(x - z) <= 2 || Math.abs(x + z) <= 2;
          else if (roadMode === 2) onRoad = (hash2(12, 4, salt) < 0.5 ? Math.abs(x) <= 2 : Math.abs(z) <= 2);
          if (onRoad) {
            const padH = Math.max(6, th.base + Math.floor(baseShift * 0.3));
            height = Math.round(height * 0.35 + padH * 0.65);
          }
        }
      }
      if (height < 3) height = 3;
      if (height > this.h - 8) height = this.h - 8;
      return height;
    }

    // Integer height for voxel fill / collision
    columnHeight(x, z) {
      return Math.floor(this.heightField(x, z));
    }

    surfaceBlock(x, z, height) {
      const th = this.theme;
      const dist0 = Math.sqrt(x * x + z * z);
      if (dist0 < 17) return ((x % 4 === 0) || (z % 4 === 0)) ? COBBLE : STONE;
      if (Math.abs(x) <= 2 || Math.abs(z) <= 2) return COBBLE;
      if (th.id === 'desert' || th.id === 'canyon') return SAND;
      if (th.id === 'snow' || th.id === 'void') return STONE;
      if (th.id === 'volcanic') return height < th.base + 2 ? BRICK : STONE;
      if (th.id === 'coast' && height <= th.base + 1) return SAND;
      if (th.id === 'storm') return height > th.base + 8 ? IRON : STONE;
      if (th.id === 'forest') return GRASS;
      if (th.id === 'farm') return GRASS;
      if (th.id === 'wilds') return GRASS;
      if (th.id === 'neon') return ((x + z) & 1) ? IRON : STONE;
      return GRASS;
    }

    generateChunk(cx, cz) {
      const cs = CHUNK;
      const data = new Uint8Array(cs * this.h * cs);
      const setL = (lx, y, lz, v) => {
        if (y < 0 || y >= this.h || lx < 0 || lz < 0 || lx >= cs || lz >= cs) return;
        data[(y * cs + lz) * cs + lx] = v;
      };
      const getL = (lx, y, lz) => {
        if (y < 0 || y >= this.h || lx < 0 || lz < 0 || lx >= cs || lz >= cs) return AIR;
        return data[(y * cs + lz) * cs + lx];
      };

      // Terrain fill
      for (let lz = 0; lz < cs; lz++) {
        for (let lx = 0; lx < cs; lx++) {
          const x = cx * cs + lx;
          const z = cz * cs + lz;
          const height = this.columnHeight(x, z);
          const top = this.surfaceBlock(x, z, height);
          for (let y = 0; y <= height; y++) {
            let b;
            if (y === height) b = top;
            else if (y > height - 3) b = DIRT;
            else b = STONE;
            // volcanic deep = brick
            if (this.theme.id === 'volcanic' && y < height - 2 && y > height - 6) b = BRICK;
            setL(lx, y, lz, b);
          }
        }
      }

      // Landmarks intersecting this chunk
      for (const lm of this.landmarks()) {
        this.stampLandmark(data, cx, cz, lm, setL, getL);
      }

      // Light decoration (theme-specific), only if not hub core
      this.decorateChunk(data, cx, cz, setL, getL);

      // Integrity: support floating solids inside chunk (local + neighbor via get later repair on morph)
      for (let lz = 0; lz < cs; lz++) {
        for (let lx = 0; lx < cs; lx++) {
          for (let y = 1; y < this.h; y++) {
            const b = getL(lx, y, lz);
            if (b === AIR || b === LADDER || b === LEAVES) continue;
            const below = getL(lx, y - 1, lz);
            if (below === AIR || below === LADDER) {
              // fill support
              let yy = y - 1;
              while (yy >= 0 && (getL(lx, yy, lz) === AIR || getL(lx, yy, lz) === LADDER)) {
                setL(lx, yy, lz, BRICK);
                yy--;
              }
            }
          }
        }
      }

      return data;
    }

    stampLandmark(data, cx, cz, lm, setL, getL) {
      const cs = CHUNK;
      const x0 = cx * cs, z0 = cz * cs;
      const pad = 16;
      if (lm.x + pad < x0 || lm.x - pad >= x0 + cs || lm.z + pad < z0 || lm.z - pad >= z0 + cs) return;

      const inChunk = (x, z) => x >= x0 && x < x0 + cs && z >= z0 && z < z0 + cs;
      const setW = (x, y, z, v) => {
        if (!inChunk(x, z) || y < 0 || y >= this.h) return;
        setL(x - x0, y, z - z0, v);
      };
      const foundation = (x, z, upTo) => {
        for (let y = 0; y < upTo; y++) {
          if (!inChunk(x, z)) return;
          const cur = getL(x - x0, y, z - z0);
          if (cur === AIR || cur === LADDER) setW(x, y, z, STONE);
        }
      };
      // Hollow multi-story box with floors, windows, roof, ladder
      const multiBuilding = (ox, oz, sx, sz, floors, wallB, floorB, roofB) => {
        const floorH = 4;
        const totalH = floors * floorH + 1;
        const g = this.columnHeight(ox, oz) + 1;
        for (let dx = -sx; dx <= sx; dx++) {
          for (let dz = -sz; dz <= sz; dz++) {
            const edgeX = dx === -sx || dx === sx;
            const edgeZ = dz === -sz || dz === sz;
            const wall = edgeX || edgeZ;
            const corner = edgeX && edgeZ;
            foundation(ox + dx, oz + dz, g);
            for (let fy = 0; fy < floors; fy++) {
              const y0 = g + fy * floorH;
              // floor slab
              setW(ox + dx, y0, oz + dz, floorB);
              if (wall) {
                for (let y = y0 + 1; y < y0 + floorH; y++) {
                  // window band on mid height of non-corners
                  const mid = y === y0 + 2;
                  if (mid && !corner && ((edgeX && (dz & 1)) || (edgeZ && (dx & 1)))) {
                    setW(ox + dx, y, oz + dz, AIR);
                  } else {
                    setW(ox + dx, y, oz + dz, wallB);
                  }
                }
              } else {
                // clear interior
                for (let y = y0 + 1; y < y0 + floorH; y++) setW(ox + dx, y, oz + dz, AIR);
              }
            }
            // roof
            setW(ox + dx, g + totalH - 1, oz + dz, roofB);
          }
        }
        // doorways on ground
        setW(ox - sx, g + 1, oz, AIR);
        setW(ox - sx, g + 2, oz, AIR);
        setW(ox + sx, g + 1, oz, AIR);
        setW(ox + sx, g + 2, oz, AIR);
        // exterior ladder to roof
        for (let y = g; y <= g + totalH - 1; y++) setW(ox + sx + 1, y, oz, LADDER);
        setW(ox + sx + 1, g + totalH - 1, oz, roofB);
        // interior ladder shaft
        for (let y = g; y < g + totalH - 1; y++) setW(ox, y, oz, LADDER);
      };

      if (lm.type === 'hub') {
        const salt = this.layoutSalt();
        const baseShift = Math.floor((hash2(12, 5, salt) - 0.5) * 6);
        const target = Math.max(5, Math.min(this.h - 16, this.theme.base + baseShift));
        const tid = this.theme.id;
        const pad = 12 + Math.floor(hash2(20, 1, salt) * 8); // plaza half-size 12–19
        for (let dx = -pad; dx <= pad; dx++) {
          for (let dz = -pad; dz <= pad; dz++) {
            const x = lm.x + dx, z = lm.z + dz;
            if (!inChunk(x, z)) continue;
            for (let y = 0; y <= target; y++) {
              let b;
              if (y === target) {
                if (tid === 'neon') b = ((x % 4 === 0) || (z % 4 === 0)) ? IRON : STONE;
                else if (tid === 'desert' || tid === 'canyon') b = SAND;
                else if (tid === 'coast') b = ((Math.abs(x) + Math.abs(z)) % 3 === 0) ? PLANKS : COBBLE;
                else if (tid === 'snow') b = STONE;
                else if (tid === 'volcanic') b = BRICK;
                else b = ((x % 4 === 0) || (z % 4 === 0)) ? COBBLE : STONE;
              } else {
                b = y > target - 3 ? DIRT : STONE;
              }
              setW(x, y, z, b);
            }
            for (let y = target + 1; y < Math.min(this.h, target + 8); y++) {
              const b = getL(x - x0, y, z - z0);
              if (b !== AIR && b !== LADDER) setW(x, y, z, AIR);
            }
          }
        }
        // Cover posts — count, radius, rotation all reseed
        const coverN = 5 + Math.floor(hash2(20, 2, salt) * 6); // 5–10
        const coverR = 6 + hash2(20, 3, salt) * 7;
        const coverRot = hash2(20, 4, salt) * Math.PI * 2;
        for (let k = 0; k < coverN; k++) {
          const a = coverRot + (k / coverN) * Math.PI * 2 + (hash2(k, 21, salt) - 0.5) * 0.4;
          const rr = coverR + (hash2(k, 22, salt) - 0.5) * 3;
          const x = Math.floor(lm.x + Math.cos(a) * rr);
          const z = Math.floor(lm.z + Math.sin(a) * rr);
          const g = target + 1;
          const tall = 1 + Math.floor(hash2(k, 23, salt) * 3);
          if (inChunk(x, z)) {
            for (let yy = 0; yy < tall; yy++) setW(x, g + yy, z, yy === tall - 1 && (k & 1) ? IRON : PLANKS);
          }
        }
        // Elevated fight decks — random offsets per sector
        const deckCount = 2 + Math.floor(hash2(20, 5, salt) * 2); // 2–3
        for (let d = 0; d < deckCount; d++) {
          const ang = hash2(d, 30, salt) * Math.PI * 2;
          const dist = 9 + hash2(d, 31, salt) * 10;
          const ox = lm.x + Math.floor(Math.cos(ang) * dist);
          const oz = lm.z + Math.floor(Math.sin(ang) * dist);
          const g = target + 1;
          const half = 1 + Math.floor(hash2(d, 32, salt) * 2); // 1–2
          const rise = 2 + Math.floor(hash2(d, 33, salt) * 3); // 2–4
          for (let dx = -half; dx <= half; dx++) {
            for (let dz = -half; dz <= half; dz++) {
              foundation(ox + dx, oz + dz, g);
              for (let y = g; y < g + rise; y++) {
                if (Math.abs(dx) === half || Math.abs(dz) === half) setW(ox + dx, y, oz + dz, BRICK);
              }
              setW(ox + dx, g + rise, oz + dz, PLANKS);
            }
          }
          for (let y = g; y <= g + rise; y++) setW(ox + half + 1, y, oz, LADDER);
        }
        return;
      }

      const g = this.columnHeight(lm.x, lm.z) + 1;
      const hh = lm.h || 6;
      const ww = lm.w || 3;
      const t = lm.type;

      if (t === 'building' || t === 'warehouse' || t === 'barn' || t === 'fort' || t === 'temple' || t === 'ruin_keep') {
        const floors = t === 'building' ? 2 + (hh % 3) : t === 'warehouse' || t === 'barn' ? 2 : t === 'fort' ? 3 : 2;
        const sx = t === 'warehouse' || t === 'barn' ? ww + 1 : Math.min(4, ww);
        const sz = t === 'warehouse' || t === 'barn' ? ww : Math.min(3, Math.max(2, ww - 1));
        let wallB = BRICK, floorB = PLANKS, roofB = IRON;
        if (t === 'barn') { wallB = PLANKS; roofB = BRICK; }
        if (t === 'temple') { wallB = SAND; floorB = STONE; roofB = SAND; }
        if (t === 'fort') { wallB = STONE; floorB = COBBLE; roofB = IRON; }
        if (t === 'ruin_keep') { wallB = COBBLE; floorB = STONE; roofB = COBBLE; }
        if (t === 'building') { wallB = STONE; floorB = PLANKS; roofB = IRON; }
        multiBuilding(lm.x, lm.z, sx, sz, floors, wallB, floorB, roofB);
        // ruin keep: knock some walls out
        if (t === 'ruin_keep') {
          for (let k = 0; k < 6; k++) {
            const s = this.layoutSalt();
            const dx = Math.floor((hash2(lm.x + k, lm.z, s) - 0.5) * sx * 2);
            const dz = Math.floor((hash2(lm.z + k, lm.x, s) - 0.5) * sz * 2);
            const y = g + 2 + Math.floor(hash2(k, lm.x, s) * floors * 3);
            setW(lm.x + dx, y, lm.z + dz, AIR);
            setW(lm.x + dx, y + 1, lm.z + dz, AIR);
          }
        }
      } else if (t === 'tower') {
        const r = 2;
        const floors = Math.max(2, Math.floor(hh / 3));
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            foundation(lm.x + dx, lm.z + dz, g);
            for (let y = g; y < g + hh; y++) {
              const edge = Math.abs(dx) === r || Math.abs(dz) === r;
              const floor = ((y - g) % 4) === 0;
              if (edge) setW(lm.x + dx, y, lm.z + dz, IRON);
              else if (floor) setW(lm.x + dx, y, lm.z + dz, PLANKS);
              else setW(lm.x + dx, y, lm.z + dz, AIR);
            }
            setW(lm.x + dx, g + hh, lm.z + dz, PLANKS);
          }
        }
        for (let y = g; y <= g + hh; y++) setW(lm.x, y, lm.z + r + 1, LADDER);
        setW(lm.x, g + hh, lm.z + r + 1, PLANKS);
        // battlements
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if ((Math.abs(dx) === r || Math.abs(dz) === r) && ((dx + dz) & 1)) {
              setW(lm.x + dx, g + hh + 1, lm.z + dz, IRON);
            }
          }
        }
      } else if (t === 'bunker') {
        const sx = 3, sz = 2, hgt = 3;
        for (let dx = -sx; dx <= sx; dx++) {
          for (let dz = -sz; dz <= sz; dz++) {
            const wall = dx === -sx || dx === sx || dz === -sz || dz === sz;
            foundation(lm.x + dx, lm.z + dz, g);
            for (let y = g; y < g + hgt; y++) {
              if (wall) setW(lm.x + dx, y, lm.z + dz, BRICK);
              else setW(lm.x + dx, y, lm.z + dz, AIR);
            }
            setW(lm.x + dx, g - 1, lm.z + dz, STONE);
            setW(lm.x + dx, g + hgt, lm.z + dz, IRON);
          }
        }
        for (let y = g; y < g + 2; y++) {
          setW(lm.x - sx, y, lm.z, AIR);
          setW(lm.x + sx, y, lm.z, AIR);
        }
        // Roof access ladder
        for (let y = g; y <= g + hgt; y++) setW(lm.x + sx + 1, y, lm.z, LADDER);
      } else if (t === 'deck' || t === 'plaza_deck' || t === 'cliff_pad' || t === 'tree_platform') {
        const rx = t === 'plaza_deck' ? 5 : 4;
        const rz = t === 'plaza_deck' ? 4 : 3;
        const deck = g + (t === 'tree_platform' ? 5 : t === 'cliff_pad' ? 3 : 4);
        const pillarB = t === 'tree_platform' ? LOG : BRICK;
        const floorB = t === 'tree_platform' ? LEAVES : PLANKS;
        for (let dx = -rx; dx <= rx; dx++) {
          for (let dz = -rz; dz <= rz; dz++) {
            const pillar = (Math.abs(dx) === rx || Math.abs(dz) === rz) && ((dx + dz) % 2 === 0);
            if (pillar || (dx === 0 && dz === 0)) {
              for (let y = g; y < deck; y++) setW(lm.x + dx, y, lm.z + dz, pillarB);
              foundation(lm.x + dx, lm.z + dz, g);
            }
            setW(lm.x + dx, deck, lm.z + dz, floorB);
            // rail
            if (Math.abs(dx) === rx || Math.abs(dz) === rz) {
              setW(lm.x + dx, deck + 1, lm.z + dz, IRON);
            }
          }
        }
        // second tier on plaza
        if (t === 'plaza_deck') {
          for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
              setW(lm.x + dx, deck + 3, lm.z + dz, PLANKS);
              if (Math.abs(dx) === 2 || Math.abs(dz) === 2) setW(lm.x + dx, deck + 4, lm.z + dz, IRON);
            }
          }
          for (let y = deck; y <= deck + 3; y++) setW(lm.x + 3, y, lm.z, LADDER);
        }
        for (let y = g; y <= deck; y++) setW(lm.x + rx + 1, y, lm.z, LADDER);
        if (t === 'tree_platform') {
          // canopy above
          for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
              if (Math.abs(dx) + Math.abs(dz) < 5) setW(lm.x + dx, deck + 3, lm.z + dz, LEAVES);
            }
          }
        }
      } else if (t === 'walkway') {
        // Elevated corridor — great multi-level mid-range fight
        const len = 10, deck = g + 4;
        for (let i = -len; i <= len; i++) {
          for (let s = -1; s <= 1; s++) {
            foundation(lm.x + i, lm.z + s, g);
            for (let y = g; y < deck; y++) {
              if (s !== 0 && (i % 3 === 0)) setW(lm.x + i, y, lm.z + s, IRON);
            }
            setW(lm.x + i, deck, lm.z + s, PLANKS);
            if (s !== 0) setW(lm.x + i, deck + 1, lm.z + s, IRON);
          }
        }
        for (let y = g; y <= deck; y++) {
          setW(lm.x - len, y, lm.z + 2, LADDER);
          setW(lm.x + len, y, lm.z + 2, LADDER);
        }
      } else if (t === 'pier') {
        const len = 12, deck = Math.max(g, this.theme.base + 2);
        for (let i = 0; i < len; i++) {
          for (let s = -2; s <= 2; s++) {
            foundation(lm.x + i, lm.z + s, deck);
            if (s === -2 || s === 2 || i % 3 === 0) {
              for (let y = Math.max(1, deck - 4); y < deck; y++) setW(lm.x + i, y, lm.z + s, LOG);
            }
            setW(lm.x + i, deck, lm.z + s, PLANKS);
          }
        }
        // warehouse shack at end
        multiBuilding(lm.x + len - 2, lm.z, 2, 2, 1, PLANKS, PLANKS, IRON);
      } else if (t === 'mesa' || t === 'basalt') {
        const r = 4 + (ww % 3);
        const top = g + 3 + (hh % 5);
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (dx * dx + dz * dz > r * r + 1) continue;
            const colH = top - Math.floor((Math.abs(dx) + Math.abs(dz)) * 0.35);
            for (let y = 0; y <= colH; y++) {
              const b = t === 'basalt'
                ? (y > colH - 2 ? BRICK : STONE)
                : (y > colH - 2 ? SAND : STONE);
              setW(lm.x + dx, y, lm.z + dz, b);
            }
          }
        }
        // fight pad on top
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            setW(lm.x + dx, top + 1, lm.z + dz, t === 'basalt' ? IRON : COBBLE);
          }
        }
        // Two ladders + stepped ramp so the mesa is always reachable
        for (let y = g; y <= top + 1; y++) {
          setW(lm.x + r + 1, y, lm.z, LADDER);
          setW(lm.x - r - 1, y, lm.z, LADDER);
        }
        // Spiral-ish step blocks on the south face (climb without ladder)
        for (let s = 0; s <= r + 1; s++) {
          const y = g + Math.floor((s / (r + 1)) * (top - g));
          setW(lm.x + s - Math.floor(r / 2), y, lm.z - r - 1, t === 'basalt' ? BRICK : COBBLE);
          setW(lm.x + s - Math.floor(r / 2), y + 1, lm.z - r - 1, t === 'basalt' ? BRICK : COBBLE);
        }
      } else if (t === 'bridge') {
        const len = 14, deck = g + 5;
        for (let i = -len; i <= len; i++) {
          for (let s = -1; s <= 1; s++) {
            setW(lm.x + i, deck, lm.z + s, PLANKS);
            if (s !== 0) setW(lm.x + i, deck + 1, lm.z + s, IRON);
            if (i === -len || i === len || i === 0) {
              for (let y = Math.max(0, deck - 8); y < deck; y++) setW(lm.x + i, y, lm.z + s, STONE);
            }
          }
        }
        // canyon cut under bridge (air)
        for (let i = -len + 2; i <= len - 2; i++) {
          for (let s = -3; s <= 3; s++) {
            for (let y = g - 2; y < deck - 1; y++) {
              if (Math.abs(s) > 1) setW(lm.x + i, y, lm.z + s, AIR);
            }
          }
        }
        // Ladders at both ends so the deck is always reachable
        for (let y = Math.max(0, g - 1); y <= deck; y++) {
          setW(lm.x - len, y, lm.z + 2, LADDER);
          setW(lm.x + len, y, lm.z + 2, LADDER);
        }
      } else if (t === 'silo') {
        const r = 2, hgt = 8 + (hh % 4);
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.abs(dx) === r || Math.abs(dz) === r) {
              foundation(lm.x + dx, lm.z + dz, g);
              for (let y = g; y < g + hgt; y++) setW(lm.x + dx, y, lm.z + dz, IRON);
            }
            setW(lm.x + dx, g + hgt, lm.z + dz, IRON);
          }
        }
        for (let y = g; y <= g + hgt; y++) setW(lm.x + r + 1, y, lm.z, LADDER);
      } else if (t === 'ruins') {
        const s = this.layoutSalt();
        for (let k = 0; k < 10; k++) {
          const dx = Math.floor((hash2(lm.x + k, lm.z, s) - 0.5) * 10);
          const dz = Math.floor((hash2(lm.z + k, lm.x, s) - 0.5) * 10);
          const h2 = 2 + Math.floor(hash2(k, lm.x, s) * 5);
          foundation(lm.x + dx, lm.z + dz, g);
          for (let y = g; y < g + h2; y++) setW(lm.x + dx, y, lm.z + dz, BRICK);
          if (k % 3 === 0) {
            for (let y = g; y < g + h2; y++) setW(lm.x + dx + 1, y, lm.z + dz, BRICK);
            setW(lm.x + dx, g + h2, lm.z + dz, PLANKS);
            setW(lm.x + dx + 1, g + h2, lm.z + dz, PLANKS);
          }
        }
      } else if (t === 'spire') {
        const h2 = 8 + Math.floor(hash2(lm.x, lm.z, this.layoutSalt()) * 6);
        foundation(lm.x, lm.z, g);
        for (let y = g; y < g + h2; y++) setW(lm.x, y, lm.z, LOG);
        setW(lm.x, g + h2, lm.z, IRON);
        // small crow's nest
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            setW(lm.x + dx, g + h2 - 2, lm.z + dz, PLANKS);
          }
        }
        for (let y = g; y <= g + h2 - 2; y++) setW(lm.x + 1, y, lm.z + 1, LADDER);
      } else {
        // fallback solid platform
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            foundation(lm.x + dx, lm.z + dz, g);
            setW(lm.x + dx, g, lm.z + dz, PLANKS);
          }
        }
      }
    }

    decorateChunk(data, cx, cz, setL, getL) {
      const cs = CHUNK;
      const seed = this.seed + this.epoch * 44;
      const tid = this.theme.id;
      const wx = cx * cs + 8, wz = cz * cs + 8;
      if (Math.hypot(wx, wz) < 22) return;

      // Dense biome scatter — giants + cover
      // Wilds keeps voxel deco light (client adds soft grass/trees for the natural look)
      const count = tid === 'forest' ? 14
        : tid === 'wilds' ? 5
        : tid === 'neon' || tid === 'storm' ? 10
        : 8;
      for (let i = 0; i < count; i++) {
        const lx = Math.floor(hash2(cx * 13 + i, cz * 7, seed) * cs);
        const lz = Math.floor(hash2(cz * 9 + i, cx * 3, seed) * cs);
        const x = cx * cs + lx, z = cz * cs + lz;
        let g = 0;
        for (let y = this.h - 1; y >= 0; y--) {
          const b = getL(lx, y, lz);
          if (b !== AIR && b !== LADDER) { g = y + 1; break; }
        }
        if (g < 2 || g >= this.h - 14) continue;
        const roll = hash2(x, z, seed);

        if (tid === 'wilds' && roll < 0.55) {
          // Sparse rock spines / stump cover — rest is client soft props
          if (roll < 0.22) {
            const h = 1 + Math.floor(roll * 4);
            for (let y = g; y < g + h && y < this.h - 2; y++) setL(lx, y, lz, STONE);
          } else if (roll < 0.4) {
            setL(lx, g, lz, LOG);
            setL(lx, g + 1, lz, LOG);
          }
          continue;
        }

        if (tid === 'forest' && roll < 0.75) {
          // Titan trees
          const h = 8 + Math.floor(hash2(i, x, seed) * 12);
          for (let y = g; y < g + h && y < this.h - 2; y++) setL(lx, y, lz, LOG);
          const cap = g + h - 1;
          for (let dy = 0; dy < 4; dy++) {
            const r = 3 - Math.floor(dy / 2);
            for (let ddx = -r; ddx <= r; ddx++) {
              for (let ddz = -r; ddz <= r; ddz++) {
                if (Math.abs(ddx) + Math.abs(ddz) > r + 1) continue;
                const nx = lx + ddx, nz = lz + ddz;
                if (nx < 0 || nz < 0 || nx >= cs || nz >= cs) continue;
                setL(nx, cap + dy, nz, LEAVES);
              }
            }
          }
        } else if (tid === 'neon' && roll < 0.45) {
          const h = 3 + Math.floor(roll * 10);
          for (let y = g; y < g + h && y < this.h - 2; y++) setL(lx, y, lz, y === g + h - 1 ? IRON : STONE);
        } else if ((tid === 'desert' || tid === 'canyon') && roll < 0.4) {
          const h = 2 + Math.floor(roll * 8);
          for (let y = g; y < g + h && y < this.h - 2; y++) setL(lx, y, lz, SAND);
        } else if ((tid === 'snow' || tid === 'void') && roll < 0.4) {
          const h = 2 + Math.floor(roll * 9);
          for (let y = g; y < g + h && y < this.h - 2; y++) setL(lx, y, lz, STONE);
        } else if (tid === 'volcanic' && roll < 0.45) {
          const h = 2 + Math.floor(roll * 8);
          for (let y = g; y < g + h && y < this.h - 2; y++) setL(lx, y, lz, BRICK);
        } else if (tid === 'storm' && roll < 0.4) {
          const h = 4 + Math.floor(roll * 12);
          for (let y = g; y < g + h && y < this.h - 2; y++) setL(lx, y, lz, IRON);
        } else if (tid === 'coast' && roll < 0.35) {
          setL(lx, g, lz, PLANKS);
          setL(lx, g + 1, lz, PLANKS);
        } else if (tid === 'farm' && roll < 0.4) {
          const h = 2 + Math.floor(roll * 5);
          for (let y = g; y < g + h; y++) setL(lx, y, lz, PLANKS);
        } else if (roll < 0.18) {
          setL(lx, g, lz, PLANKS);
          setL(lx, g + 1, lz, COBBLE);
        }
      }
    }

    // Unstick a player if morph sealed them in solid
    findOpenSpawnNear(x, z, maxR = 24) {
      const cx = Math.floor(x), cz = Math.floor(z);
      for (let r = 0; r <= maxR; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r && r > 0) continue;
            const px = cx + dx, pz = cz + dz;
            this.ensureAround(px, pz, 1);
            const y = this.solidSurfaceY(px, pz);
            if (y >= this.h - 4) continue;
            if (!collidesAt(this, px + 0.5, y, pz + 0.5, PHYS.HEIGHT)) {
              return { x: px + 0.5, y, z: pz + 0.5 };
            }
          }
        }
      }
      return { x: 0.5, y: this.solidSurfaceY(0, 0), z: 0.5 };
    }
  }

  // ---- player physics ------------------------------------------------------

  const PHYS = {
    WIDTH: 0.6,           // AABB footprint
    HEIGHT: 1.8,
    EYE: 1.62,
    CROUCH_HEIGHT: 1.25,  // smaller target, and fits under one-block gaps
    CROUCH_EYE: 1.05,
    CROUCH_SPEED: 0.42,   // fraction of walk speed
    SPRINT_SPEED: 1.45,   // fraction of walk speed while sprinting
    ADS_SPEED: 0.52,      // fraction of walk speed while aiming down sights
    SPEED: 5.4,           // blocks/sec on ground (slightly human, not arcade-skid)
    // Horizontal accel/friction so starts/stops aren't instant teleports
    ACCEL: 24,            // blocks/s² toward desired velocity (ground)
    DECEL: 32,            // blocks/s² when releasing keys / opposing
    AIR_ACCEL: 9,         // weaker air steer
    AIR_FRICTION: 0.4,    // light air drag
    AIR_CONTROL: 0.72,    // max air speed as fraction of ground speed
    GRAVITY: 24,          // slightly floatier fall
    JUMP: 8.2,
    MAX_FALL: 52,
    STEP_UP: 1.02,        // auto-climb a single block without jumping
    CLIMB_SPEED: 4.2,     // blocks/sec while on a ladder
    // Hold jump against any solid face → slow climb (map accessibility)
    WALL_CLIMB: 4.6,          // blocks/sec up the face
    WALL_CLIMB_AIR_CTRL: 0.7,
    // Power-up / chaos buffs (seconds remaining on player fields)
    LOW_GRAV_MUL: 0.22,   // fraction of normal gravity
    LOW_GRAV_JUMP: 1.55,  // jump height multiplier
    LOW_GRAV_AIR: 0.95,   // near full air speed
    LOW_GRAV_MAX_FALL: 18,
    HASTE_SPEED: 1.55,    // ground/air speed while p.hasteT > 0
    SUPER_JUMP: 1.85,     // jump mult while p.superJumpT > 0
    STEP: 1 / 60,         // fixed physics timestep, shared by both sides
  };

  // True if the player AABB overlaps any ladder block.
  function touchesLadder(world, x, y, z, height = PHYS.HEIGHT) {
    const hw = PHYS.WIDTH / 2;
    const x0 = Math.floor(x - hw), x1 = Math.floor(x + hw);
    const y0 = Math.floor(y), y1 = Math.floor(y + height - 0.001);
    const z0 = Math.floor(z - hw), z1 = Math.floor(z + hw);
    for (let bx = x0; bx <= x1; bx++)
      for (let by = y0; by <= y1; by++)
        for (let bz = z0; bz <= z1; bz++)
          if (world.isLadder && world.isLadder(bx, by, bz)) return true;
    return false;
  }

  /**
   * Solid vertical face within grab range. Returns { nx, nz } unit normal
   * pointing INTO the wall (from player), or null.
   * Generous probes so climbing isn't lost to 1-pixel gaps / corners.
   */
  function wallGrab(world, x, y, z, height, wishX, wishZ) {
    const len = Math.hypot(wishX, wishZ);
    const dirs = [];
    if (len >= 1e-4) dirs.push([wishX / len, wishZ / len]);
    // Cardinals always — looking up/down or strafing still finds the face
    dirs.push([1, 0], [-1, 0], [0, 1], [0, -1]);
    const midYs = [
      y + 0.35,
      y + Math.min(1.0, height * 0.5),
      y + Math.min(1.45, height * 0.8),
    ];
    let best = null;
    let bestScore = -1;
    for (const [nx, nz] of dirs) {
      for (const dist of [0.28, 0.42, 0.58, 0.78, 0.95]) {
        // Full-body probe (catches thin pillars / window edges)
        if (collidesAt(world, x + nx * dist, y, z + nz * dist, height * 0.92)) {
          const score = 2 + (1 - dist); // prefer closer hits
          if (score > bestScore) { bestScore = score; best = { nx, nz }; }
          continue;
        }
        for (const my of midYs) {
          const bx = Math.floor(x + nx * dist);
          const by = Math.floor(my);
          const bz = Math.floor(z + nz * dist);
          if (world.isSolid(bx, by, bz)) {
            // Prefer solid that has open space above feet (true wall, not a floor lip)
            const score = 1 + (1 - dist) + (world.isSolid(bx, by + 1, bz) ? 0.5 : 0);
            if (score > bestScore) { bestScore = score; best = { nx, nz }; }
          }
        }
      }
    }
    return best;
  }

  function touchesWall(world, x, y, z, height, wishX, wishZ) {
    return !!wallGrab(world, x, y, z, height, wishX, wishZ);
  }

  const heightOf = (p) => (p && p.crouching ? PHYS.CROUCH_HEIGHT : PHYS.HEIGHT);
  const eyeOf = (p) => (p && p.crouching ? PHYS.CROUCH_EYE : PHYS.EYE);

  function collidesAt(world, x, y, z, height = PHYS.HEIGHT) {
    const hw = PHYS.WIDTH / 2;
    const x0 = Math.floor(x - hw), x1 = Math.floor(x + hw);
    const y0 = Math.floor(y), y1 = Math.floor(y + height - 0.001);
    const z0 = Math.floor(z - hw), z1 = Math.floor(z + hw);
    for (let bx = x0; bx <= x1; bx++)
      for (let by = y0; by <= y1; by++)
        for (let bz = z0; bz <= z1; bz++)
          if (world.isSolid(bx, by, bz)) return true;
    return false;
  }

  // Applies one fixed timestep. `p` is mutated:
  // {x,y,z,vx,vz,vy,onGround,crouching,lowGravT?}. Horizontal velocity is
  // accelerated toward a desired walk vector so motion eases in/out.
  // `input` is {f,b,l,r,jump,crouch,sprint,aim,yaw,pitch?}.
  function step(world, p, input) {
    const dt = PHYS.STEP;
    const hw = PHYS.WIDTH / 2;
    if (p.vx == null) p.vx = 0;
    if (p.vz == null) p.vz = 0;
    if (p.lowGravT == null) p.lowGravT = 0;
    if (p.hasteT == null) p.hasteT = 0;
    if (p.superJumpT == null) p.superJumpT = 0;
    // Tick buff timers in the shared sim so client prediction matches server
    if (p.lowGravT > 0) p.lowGravT = Math.max(0, p.lowGravT - dt);
    if (p.hasteT > 0) p.hasteT = Math.max(0, p.hasteT - dt);
    if (p.superJumpT > 0) p.superJumpT = Math.max(0, p.superJumpT - dt);
    const lowGrav = p.lowGravT > 0 || (p.eventGravMul != null && p.eventGravMul < 0.85);
    const haste = p.hasteT > 0 || (p.eventSpeedMul != null && p.eventSpeedMul > 1.05);
    const superJump = p.superJumpT > 0 || (p.eventJumpMul != null && p.eventJumpMul > 1.05);

    // Crouch state resolves before anything else, because it changes the
    // collision height everything below depends on. Standing back up is
    // refused when there is no headroom — otherwise you could crouch under a
    // one-block gap and then teleport your own hitbox into solid rock.
    if (input.crouch) {
      p.crouching = true;
    } else if (p.crouching && !collidesAt(world, p.x, p.y, p.z, PHYS.HEIGHT)) {
      p.crouching = false;
    }
    const height = heightOf(p);

    // Movement basis is derived from the same yaw convention as lookDir(), so
    // "forward" is always exactly where the camera points.
    //   forward = (-sin yaw, -cos yaw)   right = (cos yaw, -sin yaw)
    let fwd = 0, strafe = 0;
    if (input.f) fwd += 1;
    if (input.b) fwd -= 1;
    if (input.r) strafe += 1;
    if (input.l) strafe -= 1;

    let speedMult = 1;
    if (p.crouching) {
      speedMult *= PHYS.CROUCH_SPEED;
    } else if (input.sprint && input.f && !input.aim && p.onGround) {
      speedMult *= PHYS.SPRINT_SPEED;
    }
    if (input.aim) speedMult *= PHYS.ADS_SPEED;
    if (haste) speedMult *= (p.eventSpeedMul > 1 ? p.eventSpeedMul : PHYS.HASTE_SPEED);
    else if (p.eventSpeedMul != null && p.eventSpeedMul !== 1) speedMult *= p.eventSpeedMul;

    const airCtrl = lowGrav ? PHYS.LOW_GRAV_AIR : PHYS.AIR_CONTROL;
    const maxSpeed = PHYS.SPEED * speedMult * (p.onGround ? 1 : airCtrl);
    let wishX = 0, wishZ = 0;
    if (fwd !== 0 || strafe !== 0) {
      const len = Math.sqrt(fwd * fwd + strafe * strafe);
      fwd /= len; strafe /= len;
      const sin = Math.sin(input.yaw), cos = Math.cos(input.yaw);
      wishX = (strafe * cos - fwd * sin) * maxSpeed;
      wishZ = (-strafe * sin - fwd * cos) * maxSpeed;
    }

    // Accelerate toward wish velocity. Stronger when opposing current motion
    // (stopping/turning) so it still feels responsive without skating.
    const ax = wishX - p.vx;
    const az = wishZ - p.vz;
    const aLen = Math.hypot(ax, az);
    let maxA;
    if (!p.onGround) {
      // ZERO-G: stronger air steer so moon-jumps stay controllable
      const airA = lowGrav ? PHYS.AIR_ACCEL * 1.85 : PHYS.AIR_ACCEL;
      maxA = (wishX === 0 && wishZ === 0) ? PHYS.AIR_FRICTION : airA;
    } else if (wishX === 0 && wishZ === 0) {
      maxA = PHYS.DECEL;
    } else {
      // Blend accel/decel by how aligned the wish is with current velocity
      const cur = Math.hypot(p.vx, p.vz) || 1e-6;
      const align = (p.vx * wishX + p.vz * wishZ) / (cur * maxSpeed || 1e-6);
      maxA = align > 0.2 ? PHYS.ACCEL : PHYS.DECEL;
    }
    const maxDelta = maxA * dt;
    if (aLen > maxDelta && aLen > 1e-8) {
      p.vx += (ax / aLen) * maxDelta;
      p.vz += (az / aLen) * maxDelta;
    } else {
      p.vx = wishX;
      p.vz = wishZ;
    }

    // Hard cap so sprints don't overshoot from accel stack
    const sp = Math.hypot(p.vx, p.vz);
    const cap = maxSpeed * 1.05;
    if (sp > cap && sp > 1e-8) {
      p.vx = (p.vx / sp) * cap;
      p.vz = (p.vz / sp) * cap;
    }

    let dx = p.vx * dt;
    let dz = p.vz * dt;

    // Ladder climb: while overlapping a ladder, gravity is off and W/Space
    // climb up, S/Ctrl climb down. Looking up/down also steers climb.
    const onLadder = touchesLadder(world, p.x, p.y, p.z, height);
    p.onLadder = onLadder;

    // ---- Wall climb (stateless — same inputs ⇒ same result on both sides) ----
    // Hold JUMP while against a solid face. Probes are generous; if we slam into
    // a face this frame while Jump is held we also count that as a grab.
    const grabWishX = wishX !== 0 ? wishX : p.vx;
    const grabWishZ = wishZ !== 0 ? wishZ : p.vz;
    const wantClimb = !!input.jump && !onLadder && !p.crouching;
    let grab = wantClimb
      ? wallGrab(world, p.x, p.y, p.z, height, grabWishX, grabWishZ)
      : null;
    let onWall = !!(wantClimb && grab);
    p.onWall = onWall;

    // Ground jump ONLY when not wall-climbing — Space against a wall must
    // climb, not hop off the floor and break contact.
    if (input.jump && p.onGround && !onLadder && !onWall) {
      let jumpMul = 1;
      if (lowGrav) jumpMul *= PHYS.LOW_GRAV_JUMP;
      if (superJump) jumpMul *= (p.eventJumpMul > 1 ? p.eventJumpMul : PHYS.SUPER_JUMP);
      else if (p.eventJumpMul != null && p.eventJumpMul !== 1) jumpMul *= p.eventJumpMul;
      p.vy = PHYS.JUMP * jumpMul;
      p.onGround = false;
      p.vx *= 1.02;
      p.vz *= 1.02;
    }

    if (onLadder) {
      let climb = 0;
      if (input.jump || input.f) climb += 1;
      if (input.crouch || input.b) climb -= 1;
      if (climb === 0 && input.pitch != null) {
        if (input.pitch > 0.25) climb = 1;
        else if (input.pitch < -0.35) climb = -1;
      }
      p.vy = climb * PHYS.CLIMB_SPEED;
      if (climb === 0) p.vy = 0;
      p.vx *= 0.82;
      p.vz *= 0.82;
      dx = p.vx * dt;
      dz = p.vz * dt;
    } else if (onWall) {
      p.vy = PHYS.WALL_CLIMB * (lowGrav ? 1.2 : 1);
      // Pull into the wall + optional strafe along the face
      const pull = 2.2;
      p.vx = grab.nx * pull;
      p.vz = grab.nz * pull;
      if (wishX !== 0 || wishZ !== 0) {
        const dot = wishX * grab.nx + wishZ * grab.nz;
        let tx = wishX - grab.nx * dot;
        let tz = wishZ - grab.nz * dot;
        const tl = Math.hypot(tx, tz);
        if (tl > 1e-4) {
          const slide = PHYS.SPEED * PHYS.WALL_CLIMB_AIR_CTRL;
          p.vx += (tx / tl) * slide;
          p.vz += (tz / tl) * slide;
        }
      }
      dx = p.vx * dt;
      dz = p.vz * dt;
      p.onGround = false;
    } else {
      let gMul = lowGrav ? PHYS.LOW_GRAV_MUL : 1;
      if (p.eventGravMul != null && p.eventGravMul !== 1) {
        // Event can force heavy OR light gravity (overrides powerup when heavier)
        gMul = lowGrav ? Math.min(gMul, p.eventGravMul) : p.eventGravMul;
      }
      p.vy -= PHYS.GRAVITY * gMul * dt;
      const maxFall = gMul < 0.5 ? PHYS.LOW_GRAV_MAX_FALL : (gMul > 1.3 ? PHYS.MAX_FALL * 1.15 : PHYS.MAX_FALL);
      if (p.vy < -maxFall) p.vy = -maxFall;
    }
    let dy = p.vy * dt;

    // Horizontal movement, axis-separated so you slide along walls.
    const wasGrounded = p.onGround;
    // No mantle while climbing — step-up was turning climbs into ledge hops
    const canMantle = !onWall && (wasGrounded || (!!input.jump && p.vy > -2));
    p.steppedUp = 0;
    let blockedX = false;
    let blockedZ = false;

    if (dx !== 0) {
      const nx = p.x + dx;
      if (!collidesAt(world, nx, p.y, p.z, height)) {
        p.x = nx;
      } else if (canMantle && !collidesAt(world, nx, p.y + PHYS.STEP_UP, p.z, height)) {
        p.x = nx;
        p.y += PHYS.STEP_UP;
        p.steppedUp += PHYS.STEP_UP;
        if (p.vy < 0) p.vy = 0;
      } else {
        p.x = dx > 0 ? Math.floor(nx + hw) - hw - 1e-4 : Math.floor(nx - hw) + 1 + hw + 1e-4;
        p.vx = onWall ? grab.nx * 0.5 : 0;
        blockedX = true;
      }
    }

    if (dz !== 0) {
      const nz = p.z + dz;
      if (!collidesAt(world, p.x, p.y, nz, height)) {
        p.z = nz;
      } else if (canMantle && !collidesAt(world, p.x, p.y + PHYS.STEP_UP, nz, height)) {
        p.z = nz;
        p.y += PHYS.STEP_UP;
        p.steppedUp += PHYS.STEP_UP;
        if (p.vy < 0) p.vy = 0;
      } else {
        p.z = dz > 0 ? Math.floor(nz + hw) - hw - 1e-4 : Math.floor(nz - hw) + 1 + hw + 1e-4;
        p.vz = onWall ? grab.nz * 0.5 : 0;
        blockedZ = true;
      }
    }

    // Bonked a face this frame while holding Jump → start climb even if the
    // pre-move probe missed (common the first tick you walk into a wall).
    if (!onWall && wantClimb && (blockedX || blockedZ)) {
      grab = wallGrab(world, p.x, p.y, p.z, height, grabWishX, grabWishZ);
      if (!grab) {
        // Infer normal from which axis blocked
        if (blockedX && !blockedZ) grab = { nx: dx > 0 ? 1 : -1, nz: 0 };
        else if (blockedZ && !blockedX) grab = { nx: 0, nz: dz > 0 ? 1 : -1 };
        else if (blockedX && blockedZ) {
          grab = { nx: dx > 0 ? 1 : -1, nz: dz > 0 ? 1 : -1 };
          const gl = Math.hypot(grab.nx, grab.nz) || 1;
          grab.nx /= gl; grab.nz /= gl;
        }
      }
      if (grab) {
        onWall = true;
        p.onWall = true;
        p.vy = PHYS.WALL_CLIMB * (lowGrav ? 1.2 : 1);
        dy = p.vy * dt;
        p.onGround = false;
      }
    }

    // Y
    p.onGround = false;
    if (dy !== 0) {
      const ny = p.y + dy;
      if (!collidesAt(world, p.x, ny, p.z, height)) {
        p.y = ny;
      } else if (dy < 0) {
        p.y = Math.floor(ny) + 1;
        p.vy = 0;
        p.onGround = true;
      } else {
        p.y = Math.floor(ny + height) - height - 1e-4;
        p.vy = 0;
      }
    } else if (onLadder) {
      p.onGround = true;
    }

    return p;
  }

  // ---- raycasting ----------------------------------------------------------

  // Amanatides-Woo DDA voxel traversal. Returns distance to the first solid
  // block, or maxDist if the ray reaches that far unobstructed.
  function raycastVoxels(world, ox, oy, oz, dx, dy, dz, maxDist) {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
    const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
    const tDeltaZ = dz === 0 ? Infinity : Math.abs(1 / dz);
    let tMaxX = dx === 0 ? Infinity : ((dx > 0 ? x + 1 - ox : ox - x) * tDeltaX);
    let tMaxY = dy === 0 ? Infinity : ((dy > 0 ? y + 1 - oy : oy - y) * tDeltaY);
    let tMaxZ = dz === 0 ? Infinity : ((dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ);

    let t = 0;
    for (let guard = 0; guard < 2048; guard++) {
      if (world.isSolid(x, y, z)) return { hit: true, dist: t, bx: x, by: y, bz: z };
      if (tMaxX < tMaxY && tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += tDeltaX; }
      else if (tMaxY < tMaxZ) { y += stepY; t = tMaxY; tMaxY += tDeltaY; }
      else { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
      if (t > maxDist) break;
    }
    return { hit: false, dist: maxDist };
  }

  // Ray vs axis-aligned box (slab method). Returns entry distance or -1.
  function rayAABB(ox, oy, oz, dx, dy, dz, minx, miny, minz, maxx, maxy, maxz) {
    let tmin = -Infinity, tmax = Infinity;
    const o = [ox, oy, oz], dir = [dx, dy, dz];
    const lo = [minx, miny, minz], hi = [maxx, maxy, maxz];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(dir[i]) < 1e-9) {
        if (o[i] < lo[i] || o[i] > hi[i]) return -1;
      } else {
        let t1 = (lo[i] - o[i]) / dir[i];
        let t2 = (hi[i] - o[i]) / dir[i];
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return -1;
      }
    }
    return tmax < 0 ? -1 : (tmin < 0 ? 0 : tmin);
  }

  // Weapon spread must be identical on both sides or the client draws a tracer
  // going somewhere the server never shot. Deriving the deviation from the
  // shooter's id and input sequence makes it deterministic instead of random,
  // so both compute the same ray without transmitting anything extra.
  function applySpread(dir, amount, id, seq) {
    if (!amount) return dir;
    const a = hash2(seq, id, 0x5eed) * Math.PI * 2;
    const r = Math.sqrt(hash2(seq, id, 0x1337)) * amount;

    // build a basis perpendicular to dir
    const up = Math.abs(dir.y) > 0.95 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    let rx = up.y * dir.z - up.z * dir.y;
    let ry = up.z * dir.x - up.x * dir.z;
    let rz = up.x * dir.y - up.y * dir.x;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const ux = dir.y * rz - dir.z * ry;
    const uy = dir.z * rx - dir.x * rz;
    const uz = dir.x * ry - dir.y * rx;

    const ox = Math.cos(a) * r, oy = Math.sin(a) * r;
    const nx = dir.x + rx * ox + ux * oy;
    const ny = dir.y + ry * ox + uy * oy;
    const nz = dir.z + rz * ox + uz * oy;
    const nl = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / nl, y: ny / nl, z: nz / nl };
  }

  // Direction vector from yaw/pitch. yaw 0 looks down -Z, pitch up is positive.
  function lookDir(yaw, pitch) {
    const cp = Math.cos(pitch);
    return {
      x: -Math.sin(yaw) * cp,
      y: Math.sin(pitch),
      z: -Math.cos(yaw) * cp,
    };
  }

  /**
   * Shared lob/RPG launch pose — must match client aim line + server throw.
   * def: { speed, gravity?, bounce?, direct? }
   * player: { x, y, z, crouching? }
   */
  function throwLaunch(player, yaw, pitch, def) {
    const pit = Math.max(-1.4, Math.min(1.4, pitch));
    const dir = lookDir(yaw, pit);
    const speed = (def && def.speed) || 22;
    const eye = eyeOf(player);
    if (def && def.direct) {
      return {
        x: player.x + dir.x * 0.85,
        y: player.y + eye - 0.05 + dir.y * 0.85,
        z: player.z + dir.z * 0.85,
        vx: dir.x * speed,
        vy: dir.y * speed,
        vz: dir.z * speed,
      };
    }
    // Right-hand lob: slight lateral offset, velocity follows look closely so the
    // yellow marker matches where the nade actually flies (no huge extra loft).
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const lobBoost = Math.max(1.2, speed * 0.03);
    return {
      x: player.x + dir.x * 0.45 + rx * 0.18,
      y: player.y + eye - 0.12 + dir.y * 0.35,
      z: player.z + dir.z * 0.45 + rz * 0.18,
      vx: dir.x * speed,
      vy: dir.y * speed + lobBoost,
      vz: dir.z * speed,
    };
  }

  // Mild ballistic cast shared by client tracers and server hits.
  // gravity is blocks/s² downward; speed is muzzle velocity in blocks/s.
  // Drop is noticeable past ~40m but never cartoonish.
  //
  // Returns:
  //   hit, dist (path length), x/y/z impact, bx/by/bz if voxel,
  //   path: [[x,y,z], ...] samples for curved tracers,
  //   impactDir: velocity direction at impact (for sparks)
  function ballisticCast(world, ox, oy, oz, dir, maxDist, speed, gravity) {
    speed = speed || 320;
    gravity = gravity == null ? 5.5 : gravity;
    const dt = 0.012;
    let x = ox, y = oy, z = oz;
    let vx = dir.x * speed, vy = dir.y * speed, vz = dir.z * speed;
    let traveled = 0;
    let prevX = x, prevY = y, prevZ = z;
    const path = [[x, y, z]];
    let sampleAcc = 0;
    // Dense enough that client tracers show a smooth drop curve (was 2.2)
    const sampleEvery = 0.85;

    for (let guard = 0; guard < 900; guard++) {
      vy -= gravity * dt;
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;
      const seg = Math.hypot(x - prevX, y - prevY, z - prevZ);
      if (seg < 1e-8) break;
      traveled += seg;
      sampleAcc += seg;

      const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
      if (world && world.isSolid(bx, by, bz)) {
        // Binary search along last segment for a tighter impact
        let lo = 0, hi = 1, ix = x, iy = y, iz = z;
        for (let k = 0; k < 6; k++) {
          const m = (lo + hi) * 0.5;
          const mx = prevX + (x - prevX) * m;
          const my = prevY + (y - prevY) * m;
          const mz = prevZ + (z - prevZ) * m;
          if (world.isSolid(Math.floor(mx), Math.floor(my), Math.floor(mz))) {
            hi = m; ix = mx; iy = my; iz = mz;
          } else lo = m;
        }
        const vl = Math.hypot(vx, vy, vz) || 1;
        path.push([ix, iy, iz]);
        return {
          hit: true,
          dist: traveled - seg + seg * hi,
          x: ix, y: iy, z: iz,
          bx: Math.floor(ix), by: Math.floor(iy), bz: Math.floor(iz),
          path,
          impactDir: { x: vx / vl, y: vy / vl, z: vz / vl },
        };
      }

      if (sampleAcc >= sampleEvery) {
        path.push([x, y, z]);
        sampleAcc = 0;
      }
      prevX = x; prevY = y; prevZ = z;
      if (traveled >= maxDist || y < -20) break;
    }
    path.push([x, y, z]);
    const vl = Math.hypot(vx, vy, vz) || 1;
    return {
      hit: false,
      dist: Math.min(traveled, maxDist),
      x, y, z,
      path,
      impactDir: { x: vx / vl, y: vy / vl, z: vz / vl },
    };
  }

  // Segment-wise AABB test along a ballistic path. Returns path distance to
  // entry or -1. Also returns approximate hit position.
  function ballisticHitAABB(path, minx, miny, minz, maxx, maxy, maxz) {
    if (!path || path.length < 2) return { t: -1 };
    let acc = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const segLen = Math.hypot(dx, dy, dz) || 1e-9;
      const t = rayAABB(a[0], a[1], a[2], dx / segLen, dy / segLen, dz / segLen,
        minx, miny, minz, maxx, maxy, maxz);
      if (t >= 0 && t <= segLen) {
        return {
          t: acc + t,
          x: a[0] + (dx / segLen) * t,
          y: a[1] + (dy / segLen) * t,
          z: a[2] + (dz / segLen) * t,
        };
      }
      acc += segLen;
    }
    return { t: -1 };
  }

  // ---- hit zones + distance falloff ---------------------------------------
  // Zones use vertical + lateral position within the AABB, with per-shot
  // hash jitter so thresholds aren't perfectly readable.

  function resolveHitZone(victim, hitX, hitY, hitZ, shotId, seq) {
    const h = heightOf(victim);
    const relY = (hitY - victim.y) / (h || 1.8);
    const hw = PHYS.WIDTH / 2;
    const lx = Math.abs(hitX - victim.x) / (hw || 0.3);
    const lz = Math.abs(hitZ - victim.z) / (hw || 0.3);
    const lateral = Math.max(lx, lz); // 0 = center, 1 = edge

    // Per-shot threshold jitter so hitboxes aren't frame-perfect readable
    const j = (hash2(seq | 0, shotId | 0, 0xb0d1) - 0.5) * 0.08;
    const j2 = (hash2(seq | 0, shotId | 0, 0xb0d2) - 0.5) * 0.1;
    const jLat = (hash2(seq | 0, shotId | 0, 0xb0d3) - 0.5) * 0.12;
    const roll = (salt) => hash2(seq | 0, shotId | 0, salt);

    // Zones are rewards for aim — not free one-taps. Full HP = 100.
    // Brain is the best mult but still needs multiple mid-weapon hits.
    if (relY > 0.86 + j) return { zone: 'brain', mult: 2.35 + roll(0x11b1) * 0.25, label: 'BRAIN' };
    if (relY > 0.74 + j) {
      return { zone: 'head', mult: 1.75 + roll(0x11ea01) * 0.2, label: 'HEAD' };
    }
    if (relY > 0.52 + j && relY < 0.72 + j && lateral < 0.34 + jLat) {
      return { zone: 'heart', mult: 1.45 + roll(0x1ea170) * 0.2, label: 'HEART' };
    }
    if (relY > 0.48 + j && relY < 0.74 + j && lateral < 0.68 + jLat) {
      return { zone: 'chest', mult: 1.12 + roll(0xc1e570) * 0.12, label: 'CHEST' };
    }
    if (lateral > 0.52 + jLat && relY > 0.38 + j && relY < 0.78 + j) {
      return {
        zone: 'arm',
        mult: 0.42 + roll(0xa110) * 0.18,
        label: 'ARM',
      };
    }
    if (relY < 0.40 + j) {
      const foot = relY < 0.16 + j;
      return {
        zone: foot ? 'foot' : 'leg',
        mult: (foot ? 0.32 : 0.48) + roll(0x1e90) * 0.14,
        label: foot ? 'FOOT' : 'LEG',
      };
    }
    return { zone: 'body', mult: 0.92 + roll(0xb0d4) * 0.1, label: 'BODY' };
  }

  // Distance falloff: close = full; long range still meaningful (~50–65%)
  // Significant enough to reward mid-range fights without feeling useless at range.
  function distanceFalloff(dist, range) {
    const r = range || 100;
    const t = Math.max(0, Math.min(1, dist / r));
    // Gentle early, steeper past mid-range
    const f = 1 - t * t * 0.52;
    return Math.max(0.5, Math.min(1, f));
  }

  function computeDamage(baseDamage, victim, hitX, hitY, hitZ, dist, range, shotId, seq) {
    const zone = resolveHitZone(victim, hitX, hitY, hitZ, shotId, seq);
    const fall = distanceFalloff(dist, range);
    let dmg = baseDamage * zone.mult * fall;
    // Tiny per-shot noise so identical shots aren't pixel-identical numbers
    const noise = 0.96 + hash2(seq | 0, shotId | 0, 0xd06) * 0.08;
    dmg *= noise;
    // No instakill zones — TTK comes from base weapon damage + mults only
    return {
      damage: Math.max(1, Math.round(dmg)),
      zone: zone.zone,
      label: zone.label,
      mult: zone.mult,
      falloff: fall,
    };
  }

  // ---- throwable / projectile physics (shared client + server) ------------
  // Point mass with small radius. Axis-separated resolution so nades rest on
  // block tops and roll instead of tunneling through floors.

  const PROJ_RADIUS = 0.16;

  function projSolidAt(world, x, y, z, r = PROJ_RADIUS) {
    // Sample the projectile's AABB corners against the voxel grid
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r);
    const y0 = Math.floor(y - r), y1 = Math.floor(y + r);
    const z0 = Math.floor(z - r), z1 = Math.floor(z + r);
    for (let bx = x0; bx <= x1; bx++)
      for (let by = y0; by <= y1; by++)
        for (let bz = z0; bz <= z1; bz++)
          if (world.isSolid(bx, by, bz)) return true;
    return false;
  }

  /** Highest solid top surface under (x,z) near fromY (world Y of block top). */
  function surfaceSupportY(world, x, z, fromY) {
    const ix = Math.floor(x), iz = Math.floor(z);
    let start = Math.floor(fromY + 0.01);
    if (start >= world.h) start = world.h - 1;
    for (let y = start; y >= 0; y--) {
      if (world.isSolid(ix, y, iz)) return y + 1;
    }
    // also check neighbor columns if straddling an edge
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let y = start; y >= 0; y--) {
        if (world.isSolid(ix + dx, y, iz + dz)) return y + 1;
      }
    }
    return 0;
  }

  /**
   * Advance a projectile one frame.
   * mutates p: { x,y,z,vx,vy,vz, onGround?, bounces? }
   * returns { hit: bool, settled: bool }
   */
  function stepProjectile(world, p, dt, opts) {
    const r = opts.radius != null ? opts.radius : PROJ_RADIUS;
    const gravity = opts.gravity != null ? opts.gravity : 28;
    const bounce = opts.bounce != null ? opts.bounce : 0.35;
    const direct = !!opts.direct;
    const friction = opts.friction != null ? opts.friction : 0.82; // per ground contact
    const airDrag = opts.airDrag != null ? opts.airDrag : 0.995;

    if (!p.onGround) p.vy -= gravity * dt;
    p.vx *= airDrag;
    p.vz *= airDrag;

    // Substeps prevent tunneling on fast rockets / steep falls
    const speed = Math.hypot(p.vx, p.vy, p.vz);
    const steps = Math.max(1, Math.min(6, Math.ceil(speed * dt / 0.25)));
    const sdt = dt / steps;
    let hit = false;

    for (let s = 0; s < steps; s++) {
      // ---- X ----
      let nx = p.x + p.vx * sdt;
      if (projSolidAt(world, nx, p.y, p.z, r)) {
        if (direct) { hit = true; break; }
        p.vx *= -bounce;
        p.vz *= 0.92;
        nx = p.x;
        p.bounces = (p.bounces || 0) + 1;
      }
      p.x = nx;

      // ---- Z ----
      let nz = p.z + p.vz * sdt;
      if (projSolidAt(world, p.x, p.y, nz, r)) {
        if (direct) { hit = true; break; }
        p.vz *= -bounce;
        p.vx *= 0.92;
        nz = p.z;
        p.bounces = (p.bounces || 0) + 1;
      }
      p.z = nz;

      // ---- Y ----
      let ny = p.y + p.vy * sdt;
      if (projSolidAt(world, p.x, ny, p.z, r)) {
        if (direct) { hit = true; break; }
        if (p.vy <= 0) {
          // Land on top of the supporting block
          const top = surfaceSupportY(world, p.x, p.z, p.y);
          ny = top + r + 0.001;
          // Don't end up inside — if still solid, nudge up a bit more
          let guard = 0;
          while (projSolidAt(world, p.x, ny, p.z, r) && guard++ < 6) ny += 0.15;

          if (Math.abs(p.vy) > 4.5) {
            // Only hard impacts bounce; soft landings stick near the marker
            p.vy = -p.vy * bounce * 0.55;
            p.onGround = false;
            p.vx *= 0.72;
            p.vz *= 0.72;
          } else {
            // Soft settle → short roll then stop
            p.vy = 0;
            p.onGround = true;
            p.vx *= friction * 0.55;
            p.vz *= friction * 0.55;
          }
          p.bounces = (p.bounces || 0) + 1;
        } else {
          // Ceiling
          p.vy = -Math.abs(p.vy) * bounce * 0.4;
          ny = p.y;
          p.bounces = (p.bounces || 0) + 1;
        }
      } else {
        // In air — check if we walked off a ledge
        if (p.onGround) {
          const top = surfaceSupportY(world, p.x, p.z, p.y + 0.5);
          if (p.y - r > top + 0.08) p.onGround = false;
          else {
            // stick to surface while rolling
            ny = top + r + 0.001;
            p.vy = 0;
          }
        }
      }
      p.y = ny;
    }

    // Floor clamp
    if (p.y < r) {
      p.y = r;
      if (direct) hit = true;
      else {
        p.vy = 0;
        p.onGround = true;
        p.vx *= friction;
        p.vz *= friction;
      }
    }

    // Rolling friction while grounded — snappy settle so the detonation marker
    // stays near first contact instead of sliding half the map.
    if (p.onGround && !direct) {
      const damp = Math.pow(0.02, dt);
      p.vx *= damp;
      p.vz *= damp;
      p.vy = 0;
      const top = surfaceSupportY(world, p.x, p.z, p.y + 0.5);
      p.y = top + r + 0.001;
      if (Math.hypot(p.vx, p.vz) < 0.35) {
        p.vx = 0;
        p.vz = 0;
      }
    }

    // Unstick if somehow embedded
    if (projSolidAt(world, p.x, p.y, p.z, r)) {
      const top = surfaceSupportY(world, p.x, p.z, p.y + 2);
      p.y = top + r + 0.05;
      p.vy = 0;
      if (!direct) p.onGround = true;
    }

    const settled = !direct && p.onGround && Math.hypot(p.vx, p.vy, p.vz) < 0.15;
    return { hit, settled };
  }

  // Blast damage vs player center (no hit zones) — full near epicenter, soft edge
  function explosionDamage(baseDamage, dist, radius) {
    if (radius <= 0 || dist > radius) return 0;
    const t = Math.max(0, Math.min(1, dist / radius));
    // Keep more damage out to mid-radius so nades/RPGs feel threatening
    const fall = (1 - t) * (1 - t * 0.45);
    return Math.max(8, Math.round(baseDamage * (0.45 + 0.55 * fall)));
  }

  // Carve a sphere of air. Dig only — never place blocks.
  // (An old "escape fill" compared neighbors and stacked dirt next to trees /
  // buildings, so explosions looked like they were building.)
  // Depth capped at 1 below original surface so holes stay step-out-able.
  // Returns list of [x,y,z, newBlock] for clients to remesh.
  function destroySphere(world, cx, cy, cz, radius) {
    const changes = [];
    if (!world || radius <= 0) return changes;
    const r = Math.ceil(radius);
    const r2 = radius * radius;
    world.ensureAround(cx, cz, Math.ceil(radius / 16) + 1);

    const preSurf = new Map();
    const colKey = (x, z) => x + ',' + z;
    for (let x = cx - r - 1; x <= cx + r + 1; x++) {
      for (let z = cz - r - 1; z <= cz + r + 1; z++) {
        preSurf.set(colKey(x, z), world.solidSurfaceY(x, z));
      }
    }

    // Only DESTROY (set air). Prefer upper structures; keep a floor.
    for (let x = cx - r; x <= cx + r; x++) {
      for (let z = cz - r; z <= cz + r; z++) {
        const origTop = preSurf.get(colKey(x, z)) || 1; // stand height before blast
        for (let y = Math.max(1, cy - r); y <= Math.min(world.h - 1, cy + r); y++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz;
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          const prev = world.get(x, y, z);
          if (prev === AIR) continue;
          // Never open the void
          if (y <= 1) continue;
          // At most 1 block below original surface (escapable with step-up)
          if (y < origTop - 1) continue;
          // Always allow destroying above original surface (walls, decks, roofs)
          world.set(x, y, z, AIR);
          changes.push([x, y, z, AIR]);
        }
      }
    }

    // Remove floating leaves / unsupported structure blocks (drop, don't restack)
    for (let x = cx - r; x <= cx + r; x++) {
      for (let z = cz - r; z <= cz + r; z++) {
        for (let y = Math.min(world.h - 2, cy + r + 2); y >= 2; y--) {
          const b = world.get(x, y, z);
          if (b === AIR || b === LADDER) continue;
          if (world.isSolid(x, y - 1, z)) continue;
          if (b === LEAVES || b === PLANKS || b === LOG || b === IRON || b === BRICK || b === COBBLE) {
            world.set(x, y, z, AIR);
            changes.push([x, y, z, AIR]);
          }
        }
      }
    }

    // No fill / rebuild. Dig is capped at 1 deep so players can always step out.
    return changes;
  }

  return {
    AIR, GRASS, DIRT, STONE, COBBLE, PLANKS, LOG, LEAVES, SAND, BRICK, IRON, LADDER,
    BLOCKS, THEMES, themeFor, World, PHYS, step, collidesAt, touchesLadder,
    raycastVoxels, rayAABB, lookDir, applySpread, ballisticCast, ballisticHitAABB,
    heightOf, eyeOf, hash2, resolveHitZone, distanceFalloff, computeDamage,
    explosionDamage, destroySphere,
    PROJ_RADIUS, projSolidAt, surfaceSupportY, stepProjectile, throwLaunch,
  };
}));
