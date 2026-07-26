// First-person voxel client.
//
// Renders the world three.js-side and predicts local movement so the game feels
// immediate, but the server is still the only authority on where anyone is and
// who got shot. Prediction works by running the SAME shared physics module the
// server runs (js/shared/voxel.js), keeping a buffer of unacknowledged inputs,
// and replaying them on top of each authoritative snapshot.

import * as THREE from '/vendor/three.module.js';
import Audio from '/js/audio.js';
import Voice from '/js/voice.js';
import { BiomeLife } from '/js/biome-life.js';

const V = window.BountyVoxel;
let biomeLife = null;

// ---------------------------------------------------------------- atlas ----

// Procedural atlas — higher-res PBR-ish tiles (grass, rock, metal, neon).
// Linear filtering + mipmaps so surfaces read modern, not Minecraft-pixel.
function buildAtlas() {
  const TILE = 64, COLS = 4, SIZE = TILE * COLS;
  const cv = document.createElement('canvas');
  cv.width = cv.height = SIZE;
  const g = cv.getContext('2d');

  const rnd = (x, y, s) => {
    let h = x * 374761393 + y * 668265263 + s * 1442695040;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const fbm = (x, y, s) => {
    let v = 0, a = 0.5, f = 1, n = 0;
    for (let i = 0; i < 4; i++) {
      v += rnd(Math.floor(x * f), Math.floor(y * f), s + i * 17) * a;
      n += a; a *= 0.5; f *= 2;
    }
    return v / n;
  };

  const rgb = (r, gg, b, a = 1) => {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return a < 1 ? `rgba(${c(r)},${c(gg)},${c(b)},${a})` : `rgb(${c(r)},${c(gg)},${c(b)})`;
  };

  const tile = (idx, fn) => {
    const tx = (idx % COLS) * TILE, ty = Math.floor(idx / COLS) * TILE;
    const img = g.createImageData(TILE, TILE);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const c = fn(x, y);
        // c is [r,g,b] or css — support both
        let r, gg, b;
        if (Array.isArray(c)) { r = c[0]; gg = c[1]; b = c[2]; }
        else {
          // fallback parse not needed; always arrays below
          r = gg = b = 0;
        }
        const i = (y * TILE + x) * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, tx, ty);
  };

  const soft = (base, x, y, s, amt = 0.08) => {
    const n = (fbm(x * 0.35, y * 0.35, s) - 0.5) * amt * 2;
    const m = (rnd(x, y, s + 3) - 0.5) * amt * 0.5;
    return [
      Math.max(0, Math.min(255, base[0] * (1 + n + m))),
      Math.max(0, Math.min(255, base[1] * (1 + n + m))),
      Math.max(0, Math.min(255, base[2] * (1 + n + m))),
    ];
  };

  // 0 grass top — organic green with mottling
  tile(0, (x, y) => {
    const n = fbm(x * 0.4, y * 0.4, 1);
    const blade = rnd(x, y, 2) > 0.82;
    if (blade) return soft([40, 110, 48], x, y, 3, 0.15);
    return soft([34 + n * 40, 90 + n * 50, 36 + n * 20], x, y, 1, 0.12);
  });
  // 1 grass side (dirt under green lip)
  tile(1, (x, y) => {
    if (y < 10) return soft([48, 120, 52], x, y, 4, 0.1);
    if (y < 14) return soft([90, 70, 42], x, y, 5, 0.08);
    return soft([72, 52, 32], x, y, 6, 0.1);
  });
  // 2 dirt / soil
  tile(2, (x, y) => {
    const n = fbm(x * 0.5, y * 0.5, 7);
    const pebble = rnd(x, y, 8) > 0.93;
    if (pebble) return soft([110, 95, 70], x, y, 9, 0.1);
    return soft([78 + n * 25, 56 + n * 18, 36 + n * 12], x, y, 7, 0.1);
  });
  // 3 stone / rock
  tile(3, (x, y) => {
    const n = fbm(x * 0.3, y * 0.3, 10);
    const crack = Math.abs(Math.sin(x * 0.4 + n * 4) * Math.cos(y * 0.35)) > 0.92;
    if (crack) return soft([45, 48, 55], x, y, 11, 0.05);
    return soft([95 + n * 35, 100 + n * 32, 110 + n * 30], x, y, 10, 0.08);
  });
  // 4 cobble / pavement
  tile(4, (x, y) => {
    const cellX = Math.floor(x / 16), cellY = Math.floor(y / 16);
    const mortar = (x % 16 < 1) || (y % 16 < 1);
    if (mortar) return soft([50, 52, 58], x, y, 12, 0.04);
    const n = fbm(x * 0.4 + cellX * 3, y * 0.4 + cellY * 3, 13);
    return soft([110 + n * 30, 112 + n * 28, 120 + n * 25], x, y, 13, 0.06);
  });
  // 5 planks / wood deck
  tile(5, (x, y) => {
    const board = Math.floor(y / 11);
    const seam = y % 11 === 0;
    const grain = Math.sin(x * 0.7 + board) * 8 + fbm(x * 0.2, y * 0.5, 14) * 20;
    if (seam) return soft([40, 28, 16], x, y, 15, 0.05);
    return soft([120 + grain, 82 + grain * 0.6, 42 + grain * 0.3], x, y, 16, 0.07);
  });
  // 6 log side (bark rings)
  tile(6, (x, y) => {
    const ring = Math.sin(x * 0.35) * 10 + fbm(x * 0.2, y * 0.15, 17) * 25;
    const vertical = rnd(Math.floor(x / 3), y, 18) > 0.88;
    if (vertical) return soft([40, 28, 18], x, y, 19, 0.08);
    return soft([90 + ring, 62 + ring * 0.5, 36], x, y, 17, 0.1);
  });
  // 7 log top (rings)
  tile(7, (x, y) => {
    const cx = x - 31.5, cy = y - 31.5;
    const d = Math.sqrt(cx * cx + cy * cy);
    const ring = Math.sin(d * 0.9) * 0.5 + 0.5;
    return soft([140 - ring * 40, 100 - ring * 30, 60 - ring * 20], x, y, 20, 0.08);
  });
  // 8 leaves
  tile(8, (x, y) => {
    const n = fbm(x * 0.45, y * 0.45, 21);
    const hole = rnd(x, y, 22) > 0.9;
    if (hole) return soft([18, 40, 20], x, y, 23, 0.1);
    return soft([30 + n * 50, 90 + n * 70, 32 + n * 30], x, y, 21, 0.14);
  });
  // 9 sand
  tile(9, (x, y) => {
    const n = fbm(x * 0.25, y * 0.25, 24);
    const spark = rnd(x, y, 25) > 0.96;
    if (spark) return [230, 210, 160];
    return soft([194 + n * 30, 170 + n * 25, 110 + n * 20], x, y, 24, 0.08);
  });
  // 10 brick
  tile(10, (x, y) => {
    const row = Math.floor(y / 10);
    const off = (row % 2) * 16;
    const mortar = (y % 10 < 1) || ((x + off) % 32 < 1);
    if (mortar) return soft([55, 50, 48], x, y, 26, 0.04);
    const n = fbm(x * 0.3, y * 0.3, 27 + row);
    return soft([150 + n * 40, 70 + n * 20, 55 + n * 15], x, y, 28, 0.08);
  });
  // 11 iron / metal plate
  tile(11, (x, y) => {
    const rivet = ((x % 16 === 4) || (x % 16 === 12)) && ((y % 16 === 4) || (y % 16 === 12));
    const panel = (x % 32 < 1) || (y % 32 < 1);
    const sheen = 120 + Math.sin(x * 0.2 + y * 0.15) * 25 + fbm(x * 0.2, y * 0.2, 29) * 30;
    if (rivet) return [220, 230, 240];
    if (panel) return soft([40, 48, 58], x, y, 30, 0.05);
    return soft([sheen, sheen + 4, sheen + 12], x, y, 31, 0.05);
  });
  // 12 ladder
  tile(12, (x, y) => {
    const rail = x <= 8 || x >= 55;
    const rung = y % 10 <= 2;
    if (rail) return soft([20, 180, 210], x, y, 32, 0.08);
    if (rung) return soft([100, 110, 125], x, y, 33, 0.06);
    return soft([14, 18, 26], x, y, 34, 0.04);
  });
  // 13 hazard
  tile(13, (x, y) => {
    const stripe = ((x + y) % 18) < 9;
    return stripe ? soft([255, 190, 40], x, y, 35, 0.06) : soft([28, 30, 36], x, y, 36, 0.05);
  });
  // 14 deep panel
  tile(14, (x, y) => soft([18, 20, 28], x, y, 37, 0.06));
  // 15 emissive pad / neon
  tile(15, (x, y) => {
    const cx = x - 31.5, cy = y - 31.5;
    const d = Math.sqrt(cx * cx + cy * cy);
    if (d < 12) return [0, 255, 210];
    if (d < 22) return soft([0, 140, 160], x, y, 38, 0.1);
    return soft([24, 32, 44], x, y, 39, 0.06);
  });

  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// --------------------------------------------------------------- meshing ---

// Per-face: outward normal, the two in-plane axes, and the 4 corners as
// (u,v) signs. Ambient occlusion samples the three blocks around each corner.
// Each face: outward normal n, in-plane axes u/v, and base corner.
// Vertex order is base → +u → +u+v → +v. Triangle winding is chosen so
// (u × v) is flipped when it disagrees with n — required for FrontSide.
// Soft directional light — lower contrast than Minecraft face shading
const FACES = [
  { n: [1, 0, 0],  u: [0, 1, 0], v: [0, 0, 1], base: [1, 0, 0], light: 0.88, tint: [0.92, 0.95, 1.04], kind: 'side' },
  { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], base: [0, 0, 0], light: 0.74, tint: [0.86, 0.90, 1.00], kind: 'side' },
  { n: [0, 1, 0],  u: [1, 0, 0], v: [0, 0, 1], base: [0, 1, 0], light: 1.02, tint: [1.00, 1.00, 1.05], kind: 'top' },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], base: [0, 0, 0], light: 0.48, tint: [0.65, 0.70, 0.85], kind: 'bottom' },
  { n: [0, 0, 1],  u: [1, 0, 0], v: [0, 1, 0], base: [0, 0, 1], light: 0.94, tint: [0.98, 0.96, 1.02], kind: 'side' },
  { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], base: [0, 0, 0], light: 0.70, tint: [0.84, 0.90, 1.00], kind: 'side' },
];
for (const f of FACES) {
  // u × v
  const cx = f.u[1] * f.v[2] - f.u[2] * f.v[1];
  const cy = f.u[2] * f.v[0] - f.u[0] * f.v[2];
  const cz = f.u[0] * f.v[1] - f.u[1] * f.v[0];
  // true when natural corner order already points outward
  f.outward = cx * f.n[0] + cy * f.n[1] + cz * f.n[2] > 0;
}

const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
// Soft contact AO — solid faces (no bevel gaps / see-through edges)
const AO_LEVELS = [0.62, 0.78, 0.90, 1.0];

function vertexAO(s1, s2, c) {
  if (s1 && s2) return 0;
  return 3 - (s1 + s2 + c);
}

/** Solid chunk mesh — face normals for real sun/moon shading + soft AO colors. */
function meshChunkGeometry(world, cx, cz, chunkSize, atlasCols) {
  const pos = [], uv = [], col = [], nrm = [], idx = [];
  const inset = 0.5 / (atlasCols * 64);
  const tileSpan = 1 / atlasCols;
  let vcount = 0;
  const x0 = cx * chunkSize, z0 = cz * chunkSize;
  const x1 = x0 + chunkSize, z1 = z0 + chunkSize;
  const h = world.h;
  const tt = themeTint();
  const smoothTerrain = !!(world.theme && world.theme.smooth);

  for (let x = x0; x < x1; x++) {
    for (let z = z0; z < z1; z++) {
      // Generated ground height — terrain body is drawn as heightfield when smooth
      const genH = smoothTerrain ? world.columnHeight(x, z) : -1;
      for (let y = 0; y < h; y++) {
        const block = world.get(x, y, z);
        if (block === V.AIR) continue;
        // Skip pure terrain column fill in smooth biomes (heightfield covers it)
        if (smoothTerrain && y <= genH) continue;
        const def = V.BLOCKS[block];
        if (!def) continue;
        for (const f of FACES) {
          const nx = x + f.n[0], ny = y + f.n[1], nz = z + f.n[2];
          if (ny >= 0 && ny < h && world.isSolid(nx, ny, nz)) continue;
          const tileIdx = f.kind === 'top' ? def.top : f.kind === 'bottom' ? def.bottom : def.side;
          const tu = (tileIdx % atlasCols) * tileSpan;
          const tv = 1 - (Math.floor(tileIdx / atlasCols) + 1) * tileSpan;
          const aos = [];
          for (const [su, sv] of CORNERS) {
            const sgnU = su * 2 - 1, sgnV = sv * 2 - 1;
            const s1 = world.isSolid(nx + f.u[0] * sgnU, ny + f.u[1] * sgnU, nz + f.u[2] * sgnU) ? 1 : 0;
            const s2 = world.isSolid(nx + f.v[0] * sgnV, ny + f.v[1] * sgnV, nz + f.v[2] * sgnV) ? 1 : 0;
            const cc = world.isSolid(
              nx + f.u[0] * sgnU + f.v[0] * sgnV,
              ny + f.u[1] * sgnU + f.v[1] * sgnV,
              nz + f.u[2] * sgnU + f.v[2] * sgnV
            ) ? 1 : 0;
            aos.push(vertexAO(s1, s2, cc));
          }
          for (let i = 0; i < 4; i++) {
            const [su, sv] = CORNERS[i];
            pos.push(
              x + f.base[0] + f.u[0] * su + f.v[0] * sv,
              y + f.base[1] + f.u[1] * su + f.v[1] * sv,
              z + f.base[2] + f.u[2] * su + f.v[2] * sv
            );
            // True face normal — sun/moon directional shading
            nrm.push(f.n[0], f.n[1], f.n[2]);
            uv.push(
              tu + (su ? tileSpan - inset : inset),
              tv + (sv ? tileSpan - inset : inset)
            );
            // Keep baked light mild so dynamic lights can sculpt surfaces
            const ao = AO_LEVELS[aos[i]];
            const face = 0.72 + f.light * 0.22; // was full face darken — flattened lighting
            const b = face * ao;
            const t = f.tint || [1, 1, 1];
            col.push(b * t[0] * tt[0], b * t[1] * tt[1], b * t[2] * tt[2]);
          }
          const flipDiag = aos[0] + aos[2] > aos[1] + aos[3];
          if (f.outward) {
            if (flipDiag) idx.push(vcount, vcount + 1, vcount + 2, vcount, vcount + 2, vcount + 3);
            else idx.push(vcount + 1, vcount + 2, vcount + 3, vcount + 1, vcount + 3, vcount);
          } else {
            if (flipDiag) idx.push(vcount, vcount + 2, vcount + 1, vcount, vcount + 3, vcount + 2);
            else idx.push(vcount + 1, vcount + 3, vcount + 2, vcount + 1, vcount, vcount + 3);
          }
          vcount += 4;
        }
      }
    }
  }
  // Smooth heightfield terrain for experimental wilds (and any theme.smooth)
  if (smoothTerrain) {
    meshSmoothHeightfield(world, cx, cz, chunkSize, atlasCols, pos, uv, col, nrm, idx, () => vcount, (n) => { vcount = n; }, tt);
  }

  if (vcount === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/** Continuous ground mesh — corners sample live solid tops so digs become craters. */
function meshSmoothHeightfield(world, cx, cz, chunkSize, atlasCols, pos, uv, col, nrm, idx, getV, setV, tt) {
  const tileSpan = 1 / atlasCols;
  const inset = 0.5 / (atlasCols * 64);
  // Grass top tile
  const tileIdx = 0;
  const tu = (tileIdx % atlasCols) * tileSpan;
  const tv = 1 - (Math.floor(tileIdx / atlasCols) + 1) * tileSpan;
  const x0 = cx * chunkSize, z0 = cz * chunkSize;

  // Walk height: top of solid collision column (matches feet).
  // Prefer continuous heightField for roll; fall back to solids if dug out.
  const cornerH = (x, z) => {
    let hf = null;
    if (typeof world.heightField === 'function') {
      try { hf = world.heightField(x, z); } catch { hf = null; }
    }
    // solidSurfaceY = top solid + 1 (standing height)
    const solidTop = world.solidSurfaceY(x, z);
    if (hf == null || !Number.isFinite(hf)) return solidTop;
    // heightField is top-block Y-ish continuous; +1 matches solidSurfaceY convention
    const visual = hf + 1;
    // If digs removed terrain, stick to actual solids
    if (solidTop + 0.01 < visual - 0.9) return solidTop;
    return visual;
  };

  let vcount = getV();
  for (let lz = 0; lz < chunkSize; lz++) {
    for (let lx = 0; lx < chunkSize; lx++) {
      const x = x0 + lx, z = z0 + lz;
      // Sample at cell corners (integer grid) for continuous slopes
      const h00 = cornerH(x, z);
      const h10 = cornerH(x + 1, z);
      const h01 = cornerH(x, z + 1);
      const h11 = cornerH(x + 1, z + 1);
      // Quad corners in XZ
      const verts = [
        [x, h00, z],
        [x + 1, h10, z],
        [x + 1, h11, z + 1],
        [x, h01, z + 1],
      ];
      const pushTri = (a, b, c) => {
        const ax = verts[a][0], ay = verts[a][1], az = verts[a][2];
        const bx = verts[b][0], by = verts[b][1], bz = verts[b][2];
        const cx_ = verts[c][0], cy = verts[c][1], cz_ = verts[c][2];
        let nx = (by - ay) * (cz_ - az) - (bz - az) * (cy - ay);
        let ny = (bz - az) * (cx_ - ax) - (bx - ax) * (cz_ - az);
        let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx_ - ax);
        // CRITICAL: FrontSide materials cull back faces. Winding must face UP
        // (previous order produced ny≈-1 on flat ground → invisible terrain).
        if (ny < 0) {
          nx = -nx; ny = -ny; nz = -nz;
          // swap b/c by emitting c,b instead
          const tmp = b; b = c; c = tmp;
        }
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const light = 0.62 + 0.45 * Math.max(0.15, ny);
        const base = vcount;
        // Re-read verts after possible b/c swap for correct order
        const order = [a, b, c];
        for (let oi = 0; oi < 3; oi++) {
          const vi = order[oi];
          const [px, py, pz] = verts[vi];
          pos.push(px, py, pz);
          nrm.push(nx, ny, nz);
          const u = (vi === 1 || vi === 2) ? 1 : 0;
          const v = (vi === 2 || vi === 3) ? 1 : 0;
          uv.push(tu + (u ? tileSpan - inset : inset), tv + (v ? tileSpan - inset : inset));
          const slope = 1 - Math.min(0.3, Math.abs(1 - ny) * 0.45);
          col.push(
            light * 0.78 * tt[0] * slope,
            light * 1.05 * tt[1] * slope,
            light * 0.58 * tt[2] * slope
          );
        }
        idx.push(base, base + 1, base + 2);
        vcount += 3;
      };
      // CCW when viewed from above for flat ground: (0,2,1) and (0,3,2)
      // (0,1,2) was CW from above → normals pointed into the earth)
      if (Math.abs(h00 - h11) < Math.abs(h10 - h01)) {
        pushTri(0, 2, 1); pushTri(0, 3, 2);
      } else {
        pushTri(0, 3, 1); pushTri(1, 3, 2);
      }
    }
  }
  setV(vcount);
}

function buildChunk(world, cx, cz, chunkSize, atlasCols) {
  const pos = [], uv = [], col = [], idx = [];
  // inset matches atlas tile size used in buildAtlas
  const inset = 0.5 / (atlasCols * 64);
  const tileSpan = 1 / atlasCols;
  let vcount = 0;

  const x0 = cx * chunkSize, z0 = cz * chunkSize;
  const x1 = Math.min(x0 + chunkSize, world.w), z1 = Math.min(z0 + chunkSize, world.d);

  for (let x = x0; x < x1; x++) {
    for (let z = z0; z < z1; z++) {
      for (let y = 0; y < world.h; y++) {
        const block = world.get(x, y, z);
        if (block === V.AIR) continue;
        const def = V.BLOCKS[block];
        if (!def) continue;

        for (const f of FACES) {
          const nx = x + f.n[0], ny = y + f.n[1], nz = z + f.n[2];
          // skip faces buried against another solid block (ladders are non-solid)
          if (ny >= 0 && ny < world.h && world.isSolid(nx, ny, nz)) continue;

          const tileIdx = f.kind === 'top' ? def.top : f.kind === 'bottom' ? def.bottom : def.side;
          const tu = (tileIdx % atlasCols) * tileSpan;
          const tv = 1 - (Math.floor(tileIdx / atlasCols) + 1) * tileSpan;

          const aos = [];
          for (const [su, sv] of CORNERS) {
            const sgnU = su * 2 - 1, sgnV = sv * 2 - 1;
            const s1 = world.isSolid(nx + f.u[0] * sgnU, ny + f.u[1] * sgnU, nz + f.u[2] * sgnU) ? 1 : 0;
            const s2 = world.isSolid(nx + f.v[0] * sgnV, ny + f.v[1] * sgnV, nz + f.v[2] * sgnV) ? 1 : 0;
            const cc = world.isSolid(
              nx + f.u[0] * sgnU + f.v[0] * sgnV,
              ny + f.u[1] * sgnU + f.v[1] * sgnV,
              nz + f.u[2] * sgnU + f.v[2] * sgnV
            ) ? 1 : 0;
            aos.push(vertexAO(s1, s2, cc));
          }

          for (let i = 0; i < 4; i++) {
            const [su, sv] = CORNERS[i];
            pos.push(
              x + f.base[0] + f.u[0] * su + f.v[0] * sv,
              y + f.base[1] + f.u[1] * su + f.v[1] * sv,
              z + f.base[2] + f.u[2] * su + f.v[2] * sv
            );
            uv.push(
              tu + (su ? tileSpan - inset : inset),
              tv + (sv ? tileSpan - inset : inset)
            );
            const b = f.light * AO_LEVELS[aos[i]];
            const t = f.tint || [1, 1, 1];
            col.push(b * t[0], b * t[1], b * t[2]);
          }

          // Per-face outward winding. A blanket reverse fixed tops but inverted
          // +X/+Z sides (see-through walls). Flip only when u×v disagrees with n.
          // AO diagonal split stays orientation-preserving.
          const flipDiag = aos[0] + aos[2] > aos[1] + aos[3];
          if (f.outward) {
            if (flipDiag) idx.push(vcount, vcount + 1, vcount + 2, vcount, vcount + 2, vcount + 3);
            else idx.push(vcount + 1, vcount + 2, vcount + 3, vcount + 1, vcount + 3, vcount);
          } else {
            if (flipDiag) idx.push(vcount, vcount + 2, vcount + 1, vcount, vcount + 3, vcount + 2);
            else idx.push(vcount + 1, vcount + 3, vcount + 2, vcount + 1, vcount, vcount + 3);
          }
          vcount += 4;
        }
      }
    }
  }

  if (vcount === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// ------------------------------------------------------------- the client ---

const canvas = document.getElementById('game-canvas');

let renderer, scene, camera, worldGroup, atlas, worldMat;
let world = null;
let ws = null;
let hooks = {};
let selfId = null;
let myName = '';
let running = false;
let rafId = null;

// Defaults match server config so the game is playable before welcome arrives.
const DEFAULT_WEAPONS = {
  rifle: {
    id: 'rifle', name: 'RIFLE', damage: 20, headshotMult: 1.75, range: 140,
    fireCooldown: 0.14, reload: 1.6, magSize: 24,
    hipSpread: 0.028, adsSpread: 0.004, adsFov: 52, adsSens: 0.62,
    recoilPitch: 0.010, scope: false, bulletSpeed: 300, bulletDrop: 14,
  },
  smg: {
    id: 'smg', name: 'SMG', damage: 11, headshotMult: 1.5, range: 70,
    fireCooldown: 0.068, reload: 1.35, magSize: 32,
    hipSpread: 0.042, adsSpread: 0.014, adsFov: 64, adsSens: 0.78,
    recoilPitch: 0.006, scope: false, bulletSpeed: 230, bulletDrop: 18,
  },
  sniper: {
    id: 'sniper', name: 'SNIPER', damage: 42, headshotMult: 1.9, range: 220,
    fireCooldown: 1.15, reload: 2.5, magSize: 5,
    hipSpread: 0.095, adsSpread: 0.0004, adsFov: 32, adsSens: 0.42,
    recoilPitch: 0.022, scope: true, bulletSpeed: 520, bulletDrop: 3.5,
  },
};
const DEFAULT_THROWABLES = {
  grenade: { id: 'grenade', name: 'GRENADE', kind: 'he', cooldown: 18, fuse: 2.4, speed: 52, gravity: 16, bounce: 0.38, key: '4' },
  smoke: { id: 'smoke', name: 'SMOKE', kind: 'smoke', cooldown: 24, fuse: 1.6, speed: 48, gravity: 15, bounce: 0.25, key: '5', smokeDur: 16 },
  flash: { id: 'flash', name: 'FLASH', kind: 'flash', cooldown: 20, fuse: 1.7, speed: 50, gravity: 15, bounce: 0.3, key: '6', flashDur: 2.8 },
  rpg: { id: 'rpg', name: 'RPG', kind: 'rpg', cooldown: 36, fuse: 0, speed: 110, gravity: 2.5, bounce: 0, key: '7', direct: true },
};
const C = {
  maxHp: 100,
  magSize: 24,
  range: 140,
  fireCooldown: 0.14,
  weapons: DEFAULT_WEAPONS,
  weaponKeys: ['rifle', 'smg', 'sniper'],
  defaultWeapon: 'rifle',
  throwables: DEFAULT_THROWABLES,
  throwableKeys: ['grenade', 'smoke', 'flash', 'rpg'],
};
let throwCdMs = { grenade: 0, smoke: 0, flash: 0, rpg: 0 };
/** Currently armed equipment: null = guns, else throwable id */
let armedEquip = null;
const localProjectiles = []; // visual only
const smokeClouds = [];
let flashFx = null;
let trajLine = null; // THREE.Line for throw preview
let trajMarker = null;
let balance = 0, elo = 1000;
let ammo = 24, reloadingMs = 0, reloadingWas = 0;
let latency = 0;
let currentWeapon = 'rifle';
let aiming = false;
let adsBlend = 0;           // 0..1 smoothed ADS for FOV / viewmodel
let eyeSmooth = V?.PHYS?.EYE || 1.62;
let shakePhase = 0;
let renderFov = 78;

// ---- graphics / input settings (localStorage) ------------------------------
const SETTINGS_KEY = 'bounty.settings';
const settings = loadSettings();
function loadSettings() {
  const d = {
    quality: 'high',       // low | medium | high
    sens: 1.0,             // multiplier on base mouse sens
    fov: 78,
    particles: true,
    showFps: false,
    music: true,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(d, JSON.parse(raw));
  } catch {}
  return d;
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  applyGraphicsSettings();
}
function qualityPixelRatio() {
  const dpr = window.devicePixelRatio || 1;
  if (settings.quality === 'low') return 1;
  if (settings.quality === 'medium') return Math.min(dpr, 1.25);
  return Math.min(dpr, 1.75); // high: cap below 2 — full 2x retina is pure fill-rate tax
}
function qualityViewFar(_mapSize) {
  // Camera far must cover the streamed mesh radius so the world edge
  // (and sky dome) never clip into a full-screen ring.
  const stream = (typeof MESH_RADIUS === 'number' ? MESH_RADIUS : 10) * 16;
  const base = Math.max(280, stream * 1.85);
  if (settings.quality === 'low') return base * 0.9;
  if (settings.quality === 'medium') return base * 1.0;
  return base * 1.15;
}
/** @deprecated name kept for any external refs */
function qualityFogFar(m) { return qualityViewFar(m); }

function baseFov() { return settings.fov || 78; }

function weaponDef(id = currentWeapon) {
  return C.weapons[id] || DEFAULT_WEAPONS[id] || C.weapons.rifle || DEFAULT_WEAPONS.rifle;
}

// local predicted state
const me = {
  x: 0, y: 20, z: 0, vx: 0, vz: 0, vy: 0, onGround: false, crouching: false,
  lowGravT: 0, hasteT: 0, superJumpT: 0, overchargeT: 0, armorT: 0,
  eventGravMul: 1, eventJumpMul: 1, eventSpeedMul: 1,
};
// State at the start of the most recent physics step, so rendering can
// interpolate between steps instead of showing a stair-stepped position.
const mePrev = { x: 0, y: 20, z: 0 };
let lastStepAt = performance.now();
// Visual-only offset that absorbs server corrections, then decays to zero.
// The simulation stays exactly authoritative; only the camera eases.
const smoothErr = { x: 0, y: 0, z: 0 };
let lastMispredict = 0;
// Separate from smoothErr so step-up climb can ease slower than netcode
// corrections without fighting physics interpolation.
let stepLift = 0;

// footstep cadence
const STRIDE = 2.05;         // blocks between steps
let strideDist = 0;
function blockUnder(x, y, z) {
  if (!world) return 0;
  return world.get(Math.floor(x), Math.floor(y - 0.2), Math.floor(z));
}
let yaw = 0, pitch = 0;
let havePosition = false;

const pending = [];       // unacknowledged inputs for replay
let inputSeq = 0;
let accumulator = 0;
let lastTime = performance.now();
let lastStepTime = performance.now();
let physTimer = null;

const keys = {
  f: false, b: false, l: false, r: false,
  jump: false, reload: false, crouch: false, sprint: false,
};
let firing = false;

// remote players
const remote = new Map();   // id -> { group, parts, nameplate, target, prev, lerpT }
const dummies = new Map();  // practice targets from server
const snapshots = [];
const tracers = [];

let intentionalExit = false;
let reconnectAttempt = 0;
let reconnectTimer = null;

// --------------------------------------------------------------- three ------

// Arena atmosphere defaults — theme overrides via applyThemeAtmosphere()
let ARENA_SKY = 0x0c1020;
let ARENA_FOG = 0x12182c;
let ARENA_HORIZON = 0x1a2240;
let skyMesh = null;
let nextMorphAt = 0;
let morphMs = 120000;

// Day / night cycle (full loop ~3 minutes)
const DAY_NIGHT_PERIOD_S = 180;
let dayNightT = 0.22; // start late morning
let sunLight = null, moonLight = null, hemiLight = null, ambLight = null;
let sunMesh = null, moonMesh = null;
let themeSkyBase = null; // { top, mid, bottom, fog, sky, band } from last theme

function initThree() {
  if (renderer) return;
  // Mild AA softens block silhouettes without killing perf on high quality
  const aa = settings.quality !== 'low';
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: aa, powerPreference: 'high-performance',
    stencil: false, depth: true,
  });
  renderer.setPixelRatio(qualityPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Mild tone mapping so sun-lit surfaces don't blow out / look flat
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.sortObjects = true;
  if (renderer.capabilities.getMaxAnisotropy) {
    // applied on atlas after build
  }

  scene = new THREE.Scene();
  scene.background = new THREE.Color(ARENA_SKY);
  // NO distance fog — linear Fog draws a spherical falloff that reads as a
  // full-screen light-center / dark-edge circle and changes with FOV.
  scene.fog = null;

  // Gradient sky dome — stays inside camera.far (see applyGraphicsSettings)
  const skyGeo = new THREE.SphereGeometry(240, 32, 20);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x080a14) },
      midColor: { value: new THREE.Color(ARENA_HORIZON) },
      bottomColor: { value: new THREE.Color(0x1a1030) },
      bandColor: { value: new THREE.Color(0x00a0c0) },
      bandStrength: { value: 0.35 },
    },
    vertexShader: `
      varying vec3 vW;
      void main() {
        vW = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 midColor;
      uniform vec3 bottomColor;
      uniform vec3 bandColor;
      uniform float bandStrength;
      varying vec3 vW;
      void main() {
        float h = vW.y * 0.5 + 0.5;
        vec3 c = mix(bottomColor, midColor, smoothstep(0.0, 0.45, h));
        c = mix(c, topColor, smoothstep(0.45, 1.0, h));
        float band = exp(-pow((h - 0.38) * 8.0, 2.0)) * bandStrength;
        c += bandColor * band;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.frustumCulled = false;
  scene.add(skyMesh);

  // Day/night lights
  ambLight = new THREE.AmbientLight(0xffffff, 0.35);
  scene.add(ambLight);
  hemiLight = new THREE.HemisphereLight(0xb8d4ff, 0x3a2a18, 0.45);
  scene.add(hemiLight);
  sunLight = new THREE.DirectionalLight(0xfff2d6, 1.25);
  sunLight.position.set(40, 80, 20);
  scene.add(sunLight);
  moonLight = new THREE.DirectionalLight(0xa8c0ff, 0.0);
  moonLight.position.set(-40, 60, -20);
  scene.add(moonLight);
  // Slight fill opposite the sun so shadows aren't pure black
  const fill = new THREE.DirectionalLight(0x6a7a9a, 0.22);
  fill.position.set(-30, 40, -50);
  scene.add(fill);

  // Visible sun / moon discs in the sky
  const sunGeo = new THREE.SphereGeometry(8, 20, 16);
  sunMesh = new THREE.Mesh(
    sunGeo,
    new THREE.MeshBasicMaterial({ color: 0xfff0a8, fog: false, depthWrite: false })
  );
  sunMesh.frustumCulled = false;
  sunMesh.renderOrder = -1;
  scene.add(sunMesh);
  moonMesh = new THREE.Mesh(
    new THREE.SphereGeometry(5.5, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xd8e4ff, fog: false, depthWrite: false })
  );
  moonMesh.frustumCulled = false;
  moonMesh.renderOrder = -1;
  scene.add(moonMesh);

  renderFov = baseFov();
  camera = new THREE.PerspectiveCamera(renderFov, window.innerWidth / window.innerHeight, 0.08, 500);
  camera.rotation.order = 'YXZ';

  atlas = buildAtlas();
  try {
    const maxA = renderer.capabilities.getMaxAnisotropy?.() || 1;
    atlas.anisotropy = Math.min(8, maxA);
  } catch { /* ignore */ }
  // Standard material + real normals → sun/moon cast readable light/shadow falloff
  worldMat = new THREE.MeshStandardMaterial({
    map: atlas,
    vertexColors: true,
    side: THREE.FrontSide,
    fog: false,
    roughness: 0.82,
    metalness: 0.12,
    envMapIntensity: 0.45,
  });
  // Subtle living emissive shimmer on cool/cyan vertex colors (neon biomes)
  worldMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uLife = { value: 0 };
    worldMat.userData.shader = shader;
    shader.fragmentShader = 'uniform float uTime;\nuniform float uLife;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       #ifdef USE_COLOR
       float cool = clamp(vColor.b - vColor.r * 0.65, 0.0, 1.0);
       float pulse = 0.55 + 0.45 * sin(uTime * 2.2 + vColor.g * 6.0);
       totalEmissiveRadiance += vec3(vColor) * cool * pulse * uLife * 0.55;
       #endif`
    );
  };
  worldMat.customProgramCacheKey = () => 'worldMatLife_v2';

  worldGroup = new THREE.Group();
  scene.add(worldGroup);

  biomeLife = new BiomeLife(scene);
  biomeLife.setQuality(settings.quality);

  buildViewModel();
  buildMuzzleFlash();
  buildTracerPool();
  buildParticles();
  updateDayNight(0); // prime light positions

  window.addEventListener('resize', onResize);
  applyGraphicsSettings();
}

function applyGraphicsSettings() {
  if (!renderer || !camera || !scene) return;
  renderer.setPixelRatio(qualityPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  // Hard-kill fog every settings apply (never reintroduce the FOV circle)
  scene.fog = null;
  if (scene.background && scene.background.isColor) {
    scene.background.setHex(ARENA_SKY);
  }
  // Keep sky dome with the camera so infinite worlds never show a hard wall
  if (skyMesh && camera) {
    skyMesh.position.copy(camera.position);
  }
  const viewFar = qualityViewFar(0);
  camera.far = viewFar;
  // Sky must sit inside the far plane — a sphere larger than camera.far
  // clips into a circular silhouette against the clear color.
  if (skyMesh) {
    const skyR = Math.max(120, viewFar * 0.82);
    skyMesh.scale.setScalar(skyR / 240);
  }
  camera.fov = baseFov() + ((weaponDef().adsFov || baseFov()) - baseFov()) * adsBlend;
  camera.updateProjectionMatrix();
  const fpsEl = document.getElementById('hud-fps');
  if (fpsEl) fpsEl.classList.toggle('hidden', !settings.showFps);
}

// Per-theme palettes — cranked saturation / contrast for extreme biomes
function applyThemeAtmosphere(theme) {
  const id = theme?.id || 'neon';
  const palettes = {
    neon:     { sky: 0x050818, fog: 0x0a0e28, horizon: 0x1a1050, top: 0x02040c, bottom: 0x2a0848, band: [0.9, 0.15, 1.0], life: 1.0 },
    forest:   { sky: 0x020c06, fog: 0x06180c, horizon: 0x0a2814, top: 0x010804, bottom: 0x0c2010, band: [0.05, 0.9, 0.2], life: 0.15 },
    desert:   { sky: 0x2a1808, fog: 0x3a2410, horizon: 0x5a3818, top: 0x180c04, bottom: 0x4a2a10, band: [1.0, 0.45, 0.1], life: 0.1 },
    snow:     { sky: 0x0c1828, fog: 0x183048, horizon: 0x3a6088, top: 0x040810, bottom: 0x203850, band: [0.5, 0.75, 1.0], life: 0.2 },
    volcanic: { sky: 0x1a0404, fog: 0x2a0808, horizon: 0x5a1010, top: 0x0c0202, bottom: 0x3a0c08, band: [1.0, 0.15, 0.05], life: 0.55 },
    coast:    { sky: 0x041828, fog: 0x082838, horizon: 0x104868, top: 0x020c18, bottom: 0x0c3040, band: [0.1, 0.55, 0.95], life: 0.2 },
    farm:     { sky: 0x14100c, fog: 0x201810, horizon: 0x302818, top: 0x0a0806, bottom: 0x241c10, band: [0.55, 0.4, 0.15], life: 0.12 },
    canyon:   { sky: 0x201008, fog: 0x3a1c0c, horizon: 0x5a2c14, top: 0x100804, bottom: 0x3a180c, band: [0.95, 0.35, 0.1], life: 0.12 },
    storm:    { sky: 0x060814, fog: 0x0c1020, horizon: 0x1a2440, top: 0x02040a, bottom: 0x101828, band: [0.4, 0.5, 1.0], life: 0.65 },
    void:     { sky: 0x040208, fog: 0x0a0614, horizon: 0x140828, top: 0x020106, bottom: 0x10041a, band: [0.7, 0.2, 0.95], life: 0.9 },
    wilds:    { sky: 0x0a1820, fog: 0x143040, horizon: 0x4a7a90, top: 0x6eb0e0, bottom: 0x1a3040, band: [0.35, 0.65, 0.85], life: 0.2 },
  };
  const p = palettes[id] || palettes.neon;
  themeSkyBase = {
    top: p.top, mid: p.horizon, bottom: p.bottom, fog: p.fog, sky: p.sky,
    band: p.band, life: p.life ?? 0.2,
  };
  ARENA_SKY = p.sky;
  ARENA_FOG = p.fog;
  ARENA_HORIZON = p.horizon;
  currentTheme = theme || currentTheme;
  if (biomeLife) {
    biomeLife.setQuality(settings.quality);
    biomeLife.setTheme(id);
  }
  if (worldMat?.userData?.shader) {
    worldMat.userData.shader.uniforms.uLife.value = p.life ?? 0.2;
  }
  // Wilds / outdoor biomes get slightly brighter daylight fill
  if (hemiLight) {
    if (id === 'wilds') hemiLight.intensity = 0.72;
    else if (id === 'forest') hemiLight.intensity = 0.4;
    else hemiLight.intensity = 0.45;
  }
  updateDayNight(0);
  applyGraphicsSettings();
}

/** Smoothstep helper */
function _smooth01(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}

/**
 * Advance day/night. t=0 midnight, 0.25 dawn, 0.5 noon, 0.75 dusk.
 * Rotates sun/moon, fades lights, recolors sky + fog.
 */
function updateDayNight(dt) {
  dayNightT = (dayNightT + dt / DAY_NIGHT_PERIOD_S) % 1;

  // Sun elevation: above horizon ~0.2–0.8 of cycle
  const sunAng = dayNightT * Math.PI * 2 - Math.PI / 2; // noon at t=0.5
  const sunElev = Math.sin(sunAng); // -1..1
  const moonElev = Math.sin(sunAng + Math.PI);

  // Day amount 0 at night → 1 at full day
  const dayAmt = _smooth01((sunElev + 0.15) / 1.15);
  const nightAmt = 1 - dayAmt;
  // Golden hour boost near horizon
  const golden = _smooth01(1 - Math.abs(sunElev) * 1.8) * dayAmt;

  if (sunLight) {
    const r = 120;
    sunLight.position.set(
      Math.cos(sunAng) * r,
      Math.max(4, sunElev * r),
      Math.sin(sunAng * 0.35) * r * 0.4
    );
    sunLight.intensity = 0.15 + dayAmt * 1.15 + golden * 0.25;
    sunLight.color.setRGB(
      1.0,
      0.92 - golden * 0.12,
      0.78 - golden * 0.28
    );
    sunLight.visible = sunElev > -0.08;
  }
  if (moonLight) {
    const r = 110;
    const ma = sunAng + Math.PI;
    moonLight.position.set(
      Math.cos(ma) * r,
      Math.max(4, moonElev * r),
      Math.sin(ma * 0.35) * r * 0.4
    );
    moonLight.intensity = nightAmt * 0.42;
    moonLight.color.setHex(0xb0c4ff);
    moonLight.visible = moonElev > -0.05;
  }
  if (ambLight) {
    // Higher floor so night isn't a dark tunnel / false vignette
    ambLight.intensity = 0.32 + dayAmt * 0.4;
    ambLight.color.setRGB(
      0.8 + dayAmt * 0.2,
      0.82 + dayAmt * 0.15,
      0.95 - dayAmt * 0.1
    );
  }
  if (hemiLight) {
    hemiLight.intensity = 0.35 + dayAmt * 0.5;
    hemiLight.color.setRGB(0.55 + dayAmt * 0.4, 0.65 + dayAmt * 0.3, 0.95);
    hemiLight.groundColor.setRGB(0.25 + dayAmt * 0.2, 0.2 + dayAmt * 0.15, 0.15);
  }

  // Place sun/moon discs on the sky dome (far from player)
  if (camera && sunMesh && sunLight) {
    const dist = 300;
    const sdir = sunLight.position.clone().normalize();
    sunMesh.position.copy(camera.position).addScaledVector(sdir, dist);
    sunMesh.visible = sunElev > -0.12;
    sunMesh.material.color.setRGB(1, 0.92 - golden * 0.1, 0.55 + dayAmt * 0.2);
    const ss = 0.85 + dayAmt * 0.35;
    sunMesh.scale.setScalar(ss);
  }
  if (camera && moonMesh && moonLight) {
    const dist = 300;
    const mdir = moonLight.position.clone().normalize();
    moonMesh.position.copy(camera.position).addScaledVector(mdir, dist);
    moonMesh.visible = moonElev > -0.1;
    moonMesh.material.opacity = 0.55 + nightAmt * 0.45;
    moonMesh.material.transparent = true;
    moonMesh.scale.setScalar(0.9 + nightAmt * 0.25);
  }

  // Sky / fog blend day blues over theme night palette
  const base = themeSkyBase || {
    top: 0x080a14, mid: 0x1a2240, bottom: 0x1a1030, fog: 0x12182c, sky: 0x0c1020,
    band: [0, 0.55, 0.7],
  };
  // Day sky targets
  const dayTop = { r: 0.35, g: 0.55, b: 0.92 };
  const dayMid = { r: 0.55, g: 0.72, b: 0.95 };
  const dayBot = { r: 0.75, g: 0.78, b: 0.82 };
  const dayFog = { r: 0.55, g: 0.68, b: 0.85 };
  // Night from theme hex
  const nt = new THREE.Color(base.top);
  const nm = new THREE.Color(base.mid);
  const nb = new THREE.Color(base.bottom);
  const nf = new THREE.Color(base.fog);

  const mixC = (night, day, a) => ({
    r: night.r + (day.r - night.r) * a,
    g: night.g + (day.g - night.g) * a,
    b: night.b + (day.b - night.b) * a,
  });
  // Golden hour pulls mid toward orange
  const midDay = {
    r: dayMid.r + golden * 0.25,
    g: dayMid.g + golden * 0.05,
    b: dayMid.b - golden * 0.35,
  };
  const top = mixC(nt, dayTop, dayAmt);
  const mid = mixC(nm, midDay, dayAmt);
  const bot = mixC(nb, dayBot, dayAmt);
  const fog = mixC(nf, dayFog, dayAmt * 0.85);

  if (skyMesh?.material?.uniforms) {
    const u = skyMesh.material.uniforms;
    u.topColor.value.setRGB(top.r, top.g, top.b);
    u.midColor.value.setRGB(mid.r, mid.g, mid.b);
    u.bottomColor.value.setRGB(bot.r, bot.g, bot.b);
    if (u.bandColor) {
      u.bandColor.value.setRGB(
        base.band[0] * (0.4 + nightAmt * 0.6) + golden * 0.8,
        base.band[1] * (0.4 + nightAmt * 0.5) + golden * 0.35,
        base.band[2] * (0.4 + nightAmt * 0.6)
      );
      u.bandStrength.value = 0.15 + nightAmt * 0.25 + golden * 0.35;
    }
  }

  ARENA_SKY = new THREE.Color().setRGB(top.r, top.g, top.b).getHex();
  ARENA_FOG = new THREE.Color().setRGB(fog.r, fog.g, fog.b).getHex();
  ARENA_HORIZON = new THREE.Color().setRGB(mid.r, mid.g, mid.b).getHex();

  if (scene) {
    if (scene.background?.isColor) scene.background.setRGB(top.r, top.g, top.b);
    // Never re-enable distance fog (was the full-screen circle)
    scene.fog = null;
  }
}

function onResize() {
  if (!renderer) return;
  renderer.setPixelRatio(qualityPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}

// Streaming chunk meshes for infinite worlds — only mesh near the player.
// Radius was 5 (~80 blocks) which put the hard mesh edge mid-screen as a
// light-center / dark-horizon ring that changed size with FOV.
const CS = 16;
const MESH_RADIUS = 10;      // chunks around player (~160 blocks)
const MESH_UNLOAD = 13;      // unload beyond this
const chunkMeshes = new Map(); // "cx:cz" -> mesh
let meshBuild = null;
let morphFx = null; // digital morph overlay state

function chunkKey(cx, cz) { return cx + ':' + cz; }

function clearWorldMeshes() {
  for (const [, mesh] of chunkMeshes) {
    if (mesh) {
      worldGroup.remove(mesh);
      mesh.geometry?.dispose();
    }
  }
  chunkMeshes.clear();
  meshBuild = null;
}

function buildWorldMesh() {
  // Initial load: queue around origin (hub), then stream with movement
  clearWorldMeshes();
  if (world && world.ensureAround) world.ensureAround(0, 0, MESH_RADIUS + 1);
  queueChunkMeshesAround(0, 0, true);
}

function queueChunkMeshesAround(wx, wz, immediate) {
  if (!world) return;
  const ccx = Math.floor(wx / CS);
  const ccz = Math.floor(wz / CS);
  if (world.ensureAround) world.ensureAround(wx, wz, MESH_RADIUS + 1);

  const jobs = [];
  // Load a disk (not a square) so the stream edge is softer / farther on diagonals
  const r2 = MESH_RADIUS * MESH_RADIUS;
  for (let dz = -MESH_RADIUS; dz <= MESH_RADIUS; dz++) {
    for (let dx = -MESH_RADIUS; dx <= MESH_RADIUS; dx++) {
      if (dx * dx + dz * dz > r2 + 0.5) continue;
      const cx = ccx + dx, cz = ccz + dz;
      const k = chunkKey(cx, cz);
      if (!chunkMeshes.has(k)) jobs.push([cx, cz, k]);
    }
  }
  // Unload far chunks
  for (const [k, mesh] of [...chunkMeshes]) {
    const [sx, sz] = k.split(':').map(Number);
    if (Math.abs(sx - ccx) > MESH_UNLOAD || Math.abs(sz - ccz) > MESH_UNLOAD) {
      if (mesh) {
        worldGroup.remove(mesh);
        mesh.geometry?.dispose();
      }
      chunkMeshes.delete(k);
    }
  }
  if (!jobs.length) return;
  if (immediate) {
    for (const [cx, cz, k] of jobs) meshOneChunk(cx, cz, k);
    applyGraphicsSettings();
    return;
  }
  if (!meshBuild) meshBuild = { jobs, i: 0 };
  else meshBuild.jobs.push(...jobs);
  if (!meshBuild.pumping) {
    meshBuild.pumping = true;
    requestAnimationFrame(pumpMeshBuild);
  }
}

function meshOneChunk(cx, cz, k, matOverride) {
  if (chunkMeshes.has(k)) return;
  // buildChunk expects world coords origin at chunk*CS
  const geo = buildChunkAt(world, cx, cz, CS, 4);
  if (!geo) {
    // empty chunk placeholder so we don't requeue forever
    chunkMeshes.set(k, null);
    return;
  }
  const mesh = new THREE.Mesh(geo, matOverride || worldMat);
  mesh.position.set(0, 0, 0);
  mesh.frustumCulled = true;
  mesh.userData.ck = k;
  worldGroup.add(mesh);
  chunkMeshes.set(k, mesh);
}

// Absolute chunk indices (infinite world) — soft beveled mesh
function buildChunkAt(world, cx, cz, chunkSize, atlasCols) {
  return meshChunkGeometry(world, cx, cz, chunkSize, atlasCols);
}

function themeTint() {
  const id = currentTheme?.id || 'neon';
  if (id === 'forest') return [0.75, 1.15, 0.75];
  if (id === 'desert') return [1.25, 1.05, 0.65];
  if (id === 'snow') return [0.85, 0.95, 1.25];
  if (id === 'volcanic') return [1.3, 0.55, 0.45];
  if (id === 'coast') return [0.75, 0.95, 1.2];
  if (id === 'farm') return [1.1, 1.0, 0.75];
  if (id === 'canyon') return [1.25, 0.75, 0.45];
  if (id === 'storm') return [0.75, 0.85, 1.25];
  if (id === 'void') return [0.85, 0.65, 1.2];
  if (id === 'wilds') return [0.85, 1.05, 0.7];
  return [0.9, 0.85, 1.2]; // neon
}

let currentTheme = { id: 'neon', name: 'NEON DISTRICT' };

function pumpMeshBuild() {
  if (!meshBuild || !world) { if (meshBuild) meshBuild.pumping = false; return; }
  const budgetMs = settings.quality === 'low' ? 5 : 9;
  const t0 = performance.now();
  while (meshBuild.i < meshBuild.jobs.length && performance.now() - t0 < budgetMs) {
    const [cx, cz, k] = meshBuild.jobs[meshBuild.i++];
    meshOneChunk(cx, cz, k);
  }
  if (meshBuild.i < meshBuild.jobs.length) {
    requestAnimationFrame(pumpMeshBuild);
    return;
  }
  meshBuild = null;
  applyGraphicsSettings();
}

// ---- Sector morph: smooth blast-wave terrain replacement (~10s) ------------
// Both biomes are fully meshed with the REAL atlas material. A shared radius
// clips them via onBeforeCompile (not a custom ShaderMaterial — those broke).
// Result: continuous ground wave, not chunky tile swaps.
const MORPH_DURATION = 10.0;
const MORPH_EDGE = 5.5; // soft band width in blocks — thicker = smoother blast

function makeMorphWaveMaterial(isOld, uniforms) {
  // Clone the working world material so atlas + vertex colors still work
  const mat = worldMat.clone();
  mat.transparent = false;
  mat.opacity = 1;
  mat.fog = false;
  // Separate shader program per mode
  mat.customProgramCacheKey = () => (isOld ? 'morphWaveOld_v2' : 'morphWaveNew_v2');
  mat.onBeforeCompile = (shader) => {
    // Share the same uniform objects so one radius update drives both mats
    shader.uniforms.waveCenter = uniforms.waveCenter;
    shader.uniforms.waveRadius = uniforms.waveRadius;
    shader.uniforms.waveWidth = uniforms.waveWidth;
    shader.uniforms.waveTime = uniforms.waveTime;
    shader.uniforms.modeOld = { value: isOld ? 1.0 : 0.0 };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vMorphWorldPos;`
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vMorphWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    // After vertex colors multiply so we clip final look and tint the front
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec2 waveCenter;
        uniform float waveRadius;
        uniform float waveWidth;
        uniform float waveTime;
        uniform float modeOld;
        varying vec3 vMorphWorldPos;
        float morphHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float d = length(vMorphWorldPos.xz - waveCenter);
          float edge = max(waveWidth, 1.5);
          // Old terrain lives OUTSIDE the blast; new lives INSIDE
          if (modeOld > 0.5) {
            if (d < waveRadius - edge * 0.15) discard;
          } else {
            if (d > waveRadius + edge * 0.15) discard;
          }
          // Soft digital rim along the moving front (blast wave look)
          float band = 1.0 - smoothstep(0.0, edge, abs(d - waveRadius));
          if (band > 0.02) {
            float cell = morphHash(floor(vMorphWorldPos.xz * 5.0 + waveTime * 7.0));
            float scan = step(0.55, fract(vMorphWorldPos.y * 14.0 - waveTime * 11.0));
            vec3 digi = mix(vec3(0.15, 0.95, 1.0), vec3(1.0, 0.2, 0.75), scan);
            diffuseColor.rgb += digi * band * (0.35 + cell * 0.35);
            // shatter flecks only on the dying (old) face of the wave
            if (modeOld > 0.5 && cell > 0.82 && band > 0.45) discard;
          }
        }`
      );
  };
  mat.needsUpdate = true;
  return mat;
}

function disposeMorphMesh(mesh, disposeMat) {
  if (!mesh) return;
  if (mesh.parent) mesh.parent.remove(mesh);
  mesh.geometry?.dispose?.();
  if (disposeMat && mesh.material && mesh.material !== worldMat) {
    mesh.material.dispose?.();
  }
}

function morphWaveParticles(cx, cz, radius) {
  if (settings.particles === false || !world) return;
  // Sprinkle sparks along the circumference — reinforces the blast front
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const x = cx + Math.cos(a) * radius;
    const z = cz + Math.sin(a) * radius;
    const y = (typeof world.solidSurfaceY === 'function'
      ? world.solidSurfaceY(Math.floor(x), Math.floor(z))
      : (me?.y || 12)) + 0.4 + Math.random() * 1.5;
    addParticle(
      x, y, z,
      Math.cos(a) * (1 + Math.random() * 2),
      1 + Math.random() * 3,
      Math.sin(a) * (1 + Math.random() * 2),
      0.04 + Math.random() * 0.04,
      0.25 + Math.random() * 0.2,
      Math.random() > 0.45 ? [0.25, 2.3, 2.6] : [2.3, 0.45, 1.7],
      16
    );
  }
}

function abortMorphFx() {
  if (!morphFx) return;
  if (morphFx.oldGroup) {
    const kids = [...morphFx.oldGroup.children];
    for (const m of kids) disposeMorphMesh(m, false);
    if (morphFx.oldGroup.parent) morphFx.oldGroup.parent.remove(morphFx.oldGroup);
  }
  // New meshes live in chunkMeshes — reassign to worldMat if needed
  for (const [, mesh] of chunkMeshes) {
    if (mesh) mesh.material = worldMat;
  }
  morphFx.oldMat?.dispose?.();
  morphFx.newMat?.dispose?.();
  morphFx = null;
  const el = document.getElementById('morph-overlay');
  if (el) el.classList.add('hidden');
}

function startMorphFx(theme) {
  abortMorphFx();
  meshBuild = null;

  const px = me.x || 0, pz = me.z || 0;
  const maxR = MESH_RADIUS * CS * 1.4;
  const ccx = Math.floor(px / CS);
  const ccz = Math.floor(pz / CS);

  // Shared wave uniforms (one radius drives both biomes)
  const uniforms = {
    waveCenter: { value: new THREE.Vector2(px, pz) },
    waveRadius: { value: 0.01 },
    waveWidth: { value: MORPH_EDGE },
    waveTime: { value: 0 },
  };
  const oldMat = makeMorphWaveMaterial(true, uniforms);
  const newMat = makeMorphWaveMaterial(false, uniforms);

  // --- OLD terrain: keep geometry, swap to wave-clipped material ------------
  const oldGroup = new THREE.Group();
  oldGroup.name = 'morph-old';
  for (const [, mesh] of chunkMeshes) {
    if (!mesh) continue;
    worldGroup.remove(mesh);
    mesh.material = oldMat;
    mesh.position.y = 0;
    oldGroup.add(mesh);
  }
  chunkMeshes.clear();
  if (oldGroup.children.length) worldGroup.add(oldGroup);

  applyThemeAtmosphere(theme || currentTheme);

  // Mesh jobs nearest-first. Only build a small core NOW (avoids hitch);
  // the rest streams ahead of the blast wave each frame.
  const meshJobs = [];
  for (let dz = -MESH_RADIUS; dz <= MESH_RADIUS; dz++) {
    for (let dx = -MESH_RADIUS; dx <= MESH_RADIUS; dx++) {
      const cx = ccx + dx, cz = ccz + dz;
      const dist = Math.hypot(cx * CS + CS * 0.5 - px, cz * CS + CS * 0.5 - pz);
      meshJobs.push({ cx, cz, k: chunkKey(cx, cz), dist });
    }
  }
  meshJobs.sort((a, b) => a.dist - b.dist || a.cx - b.cx);

  // Immediate: gen+mesh only the center ring so the wave can start this frame
  if (world) world.ensureAround(px, pz, 2);
  let meshI = 0;
  const CORE = 9; // ~3×3 chunks
  while (meshI < meshJobs.length && meshI < CORE) {
    const j = meshJobs[meshI++];
    if (world) world.ensureChunk(j.cx, j.cz);
    meshOneChunk(j.cx, j.cz, j.k, newMat);
  }

  morphFx = {
    t: 0,
    dur: MORPH_DURATION,
    theme,
    uniforms,
    oldMat,
    newMat,
    oldGroup: oldGroup.children.length ? oldGroup : null,
    px, pz,
    maxR,
    lastBurstR: -10,
    meshJobs,
    meshI,
    meshedR: CORE > 0 ? (meshJobs[Math.min(meshI, meshJobs.length) - 1]?.dist || CS) : CS,
  };

  const el = document.getElementById('morph-overlay');
  if (el) {
    el.classList.remove('hidden');
    el.style.setProperty('--morph-u', '0');
    const title = el.querySelector('.morph-title');
    const sub = el.querySelector('.morph-sub');
    if (title) title.textContent = 'SECTOR REALIGN';
    if (sub) sub.textContent = theme?.name || '…';
  }
  addShake(0.045, 2.0);
  lastMeshWx = px;
  lastMeshWz = pz;
}

function updateMorphFx(dt) {
  if (!morphFx) return;
  morphFx.t += dt;
  const t = morphFx.t;
  const u = Math.min(1, t / morphFx.dur);

  // Stream new-biome meshes ahead of the wave (amortized — no startup hitch)
  let meshBudget = settings.quality === 'low' ? 6 : 4;
  while (morphFx.meshI < morphFx.meshJobs.length && meshBudget-- > 0) {
    const j = morphFx.meshJobs[morphFx.meshI++];
    if (world) {
      // light ensure: one chunk, not a huge radius
      world.ensureChunk(j.cx, j.cz);
    }
    meshOneChunk(j.cx, j.cz, j.k, morphFx.newMat);
    morphFx.meshedR = Math.max(morphFx.meshedR, j.dist);
  }

  // Blast-wave ease; never outrun the meshed front (prevents empty holes)
  const s = u * u * (3 - 2 * u);
  let waveR = Math.max(0.05, s * morphFx.maxR);
  const meshCap = (morphFx.meshedR || CS) + CS * 0.35;
  if (waveR > meshCap) waveR = meshCap;

  const wobble = 1 + Math.sin(t * 4.2) * 0.012 + Math.sin(t * 9.1) * 0.006;
  const r = waveR * wobble;

  const U = morphFx.uniforms;
  U.waveRadius.value = r;
  U.waveTime.value = t;
  U.waveWidth.value = MORPH_EDGE * (1.0 + Math.sin(t * 2.4) * 0.08);
  U.waveCenter.value.set(morphFx.px, morphFx.pz);

  const el = document.getElementById('morph-overlay');
  if (el) el.style.setProperty('--morph-u', String(u));

  if (r - morphFx.lastBurstR > 2.8) {
    morphFx.lastBurstR = r;
    morphWaveParticles(morphFx.px, morphFx.pz, r);
    if (u < 0.9) addShake(0.006, 3.5);
  }

  // Finish only when wave is done AND remaining meshes are built
  if (u >= 1 && morphFx.meshI >= morphFx.meshJobs.length) finishMorphFx();
  else if (u >= 1) {
    // force-finish meshing quickly at the end
    let flush = 12;
    while (morphFx.meshI < morphFx.meshJobs.length && flush-- > 0) {
      const j = morphFx.meshJobs[morphFx.meshI++];
      if (world) world.ensureChunk(j.cx, j.cz);
      meshOneChunk(j.cx, j.cz, j.k, morphFx.newMat);
    }
    if (morphFx.meshI >= morphFx.meshJobs.length) finishMorphFx();
  }
}

function finishMorphFx() {
  if (!morphFx) return;
  const px = morphFx.px, pz = morphFx.pz;

  // Drop old biome
  if (morphFx.oldGroup) {
    const kids = [...morphFx.oldGroup.children];
    for (const m of kids) disposeMorphMesh(m, false);
    if (morphFx.oldGroup.parent) morphFx.oldGroup.parent.remove(morphFx.oldGroup);
  }

  // Promote new meshes to the normal unclipped world material
  for (const [, mesh] of chunkMeshes) {
    if (mesh) {
      mesh.material = worldMat;
      mesh.position.y = 0;
    }
  }

  morphFx.oldMat?.dispose?.();
  morphFx.newMat?.dispose?.();
  morphFx = null;

  if (world) {
    world.ensureAround(px, pz, MESH_RADIUS + 1);
    queueChunkMeshesAround(px, pz, true);
  }
  lastMeshWx = px;
  lastMeshWz = pz;

  const el = document.getElementById('morph-overlay');
  if (el) {
    el.classList.add('hidden');
    el.style.setProperty('--morph-u', '0');
  }
  applyGraphicsSettings();
}

function updateMorphTimerHud() {
  const el = document.getElementById('morph-timer');
  if (!el || !nextMorphAt) return;
  const left = Math.max(0, nextMorphAt - Date.now());
  const s = Math.ceil(left / 1000);
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  el.textContent = `◈ SHIFT ${mm}:${ss}`;
  el.classList.toggle('warn', s <= 30 && s > 10);
  el.classList.toggle('imminent', s <= 10);
}

// Stream meshes as the player explores (Minecraft-style infinite terrain)
let lastMeshWx = NaN, lastMeshWz = NaN;
function maybeStreamChunks() {
  if (!world || !havePosition) return;
  if (morphFx) return; // don't fight the center-out reveal
  const wx = me.x, wz = me.z;
  // Rebuild queue when player moves ~half a chunk
  if (Math.abs(wx - lastMeshWx) < 8 && Math.abs(wz - lastMeshWz) < 8) return;
  lastMeshWx = wx;
  lastMeshWz = wz;
  queueChunkMeshesAround(wx, wz, false);
}

// Blocky first-person weapons. Models share one holder; ADS lerps to centre
// (sniper hides under the scope overlay when fully zoomed).
let viewHolder, viewModels = {}, viewBase, viewAdsBase;
let switchKick = 0; // brief dip when swapping weapons
// Reload animation progress 0..1 (visual only; server still owns ammo timing)
let reloadAnim = 0;
let reloadAnimActive = false;

function buildViewModel() {
  viewHolder = new THREE.Group();
  camera.add(viewHolder);
  scene.add(camera);
  // Local key light so PBR guns stay readable in dark biomes (does not affect world)
  const gunKey = new THREE.DirectionalLight(0xfff2e0, 0.85);
  gunKey.position.set(0.4, 0.8, 0.6);
  camera.add(gunKey);
  const gunFill = new THREE.DirectionalLight(0xa0c0ff, 0.28);
  gunFill.position.set(-0.5, 0.2, 0.3);
  camera.add(gunFill);

  // Physically-based gun materials (visual only — aim/fire logic unchanged).
  const M = {
    steel: new THREE.MeshStandardMaterial({ color: 0x4a5560, metalness: 0.82, roughness: 0.38 }),
    steelHi: new THREE.MeshStandardMaterial({ color: 0x6a7684, metalness: 0.88, roughness: 0.28 }),
    steelLo: new THREE.MeshStandardMaterial({ color: 0x2a3038, metalness: 0.75, roughness: 0.48 }),
    blued: new THREE.MeshStandardMaterial({ color: 0x1a2230, metalness: 0.9, roughness: 0.32 }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x1c2028, metalness: 0.12, roughness: 0.72 }),
    polymerTan: new THREE.MeshStandardMaterial({ color: 0x6a5a48, metalness: 0.08, roughness: 0.78 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x8b6239, metalness: 0.05, roughness: 0.82 }),
    woodDark: new THREE.MeshStandardMaterial({ color: 0x4a3018, metalness: 0.05, roughness: 0.88 }),
    mag: new THREE.MeshStandardMaterial({ color: 0x14181e, metalness: 0.35, roughness: 0.55 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xb8923a, metalness: 0.85, roughness: 0.35 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x0a1820, metalness: 0.2, roughness: 0.08,
      transparent: true, opacity: 0.55, emissive: 0x041018, emissiveIntensity: 0.15,
    }),
    accent: new THREE.MeshStandardMaterial({ color: 0xffc53d, metalness: 0.55, roughness: 0.4, emissive: 0x3a2800, emissiveIntensity: 0.25 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x121418, metalness: 0.05, roughness: 0.92 }),
    olive: new THREE.MeshStandardMaterial({ color: 0x2f6b32, metalness: 0.2, roughness: 0.65 }),
    oliveDark: new THREE.MeshStandardMaterial({ color: 0x1e4a22, metalness: 0.2, roughness: 0.7 }),
    smokeBody: new THREE.MeshStandardMaterial({ color: 0x8a929c, metalness: 0.45, roughness: 0.5 }),
    flashBody: new THREE.MeshStandardMaterial({ color: 0xc8b060, metalness: 0.55, roughness: 0.42 }),
    rocket: new THREE.MeshStandardMaterial({ color: 0xc45a20, metalness: 0.4, roughness: 0.5 }),
    warhead: new THREE.MeshStandardMaterial({ color: 0xff6b2d, metalness: 0.5, roughness: 0.4, emissive: 0x401000, emissiveIntensity: 0.2 }),
    stripe: new THREE.MeshStandardMaterial({ color: 0x3ecf7a, metalness: 0.3, roughness: 0.45 }),
  };
  const box = (parent, w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (rx || ry || rz) m.rotation.set(rx, ry, rz);
    m.castShadow = false;
    parent.add(m);
    return m;
  };
  const cyl = (parent, rTop, rBot, h, mat, x, y, z, rx = 0, ry = 0, rz = 0, seg = 10) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    parent.add(m);
    return m;
  };

  /**
   * Real iron sights you can look through.
   * Sight line is local Y = sy (usually 0). Body sits BELOW that so ADS center is open.
   * Rear = peep ring (open hole). Front = thin post. Camera looks −Z through both.
   * Geometry positions unchanged so aim feel stays the same.
   */
  const addIronSights = (parent, { sy = 0, rearZ = -0.06, frontZ = -0.52, peep = 0.028 } = {}) => {
    const rear = new THREE.Mesh(
      new THREE.RingGeometry(peep * 0.48, peep, 22),
      M.steelHi
    );
    rear.material = M.steelHi.clone();
    rear.material.side = THREE.DoubleSide;
    rear.position.set(0, sy, rearZ);
    rear.name = 'sightRear';
    parent.add(rear);
    box(parent, peep * 2.15, peep * 0.2, 0.01, M.steelLo, 0, sy + peep * 0.98, rearZ);
    box(parent, peep * 0.2, peep * 1.45, 0.01, M.steelLo, -peep * 0.98, sy, rearZ);
    box(parent, peep * 0.2, peep * 1.45, 0.01, M.steelLo, peep * 0.98, sy, rearZ);
    box(parent, 0.005, 0.028, 0.005, M.steelHi, 0, sy - 0.016, frontZ);
    const tip = box(parent, 0.007, 0.007, 0.007, M.accent, 0, sy, frontZ);
    tip.name = 'sightTip';
    box(parent, 0.026, 0.004, 0.01, M.steelLo, -0.018, sy - 0.03, frontZ);
    box(parent, 0.026, 0.004, 0.01, M.steelLo, 0.018, sy - 0.03, frontZ);
    box(parent, 0.007, 0.018, 0.007, M.steelLo, -0.02, sy - 0.02, frontZ);
    box(parent, 0.007, 0.018, 0.007, M.steelLo, 0.02, sy - 0.02, frontZ);
  };

  // Parts tagged adsHide are culled when ADS so they never clip into the camera
  const tagHide = (mesh) => { if (mesh) mesh.userData.adsHide = true; return mesh; };

  // ---- RIFLE: cylindrical barrel + PBR furniture (layout matches prior aim setup) ----
  const rifle = new THREE.Group();
  cyl(rifle, 0.018, 0.02, 0.58, M.blued, 0, -0.055, -0.28, -Math.PI / 2, 0, 0, 12); // barrel along -Z
  box(rifle, 0.065, 0.035, 0.18, M.steelHi, 0, -0.03, -0.20);
  box(rifle, 0.085, 0.055, 0.16, M.steelLo, 0, -0.07, -0.16);
  // muzzle device
  cyl(rifle, 0.024, 0.022, 0.045, M.steelHi, 0, -0.055, -0.58, -Math.PI / 2, 0, 0, 10);
  tagHide(box(rifle, 0.10, 0.12, 0.26, M.steelHi, 0, -0.09, 0.06));
  tagHide(box(rifle, 0.11, 0.03, 0.22, M.steel, 0, -0.02, 0.04));
  tagHide(box(rifle, 0.05, 0.13, 0.065, M.mag, 0, -0.20, 0.02));
  tagHide(box(rifle, 0.065, 0.16, 0.07, M.polymer, 0, -0.22, 0.14));
  tagHide(box(rifle, 0.075, 0.055, 0.18, M.polymer, 0, -0.08, 0.24));
  tagHide(box(rifle, 0.085, 0.11, 0.05, M.rubber, 0, -0.06, 0.32));
  addIronSights(rifle, { sy: 0, rearZ: -0.08, frontZ: -0.50, peep: 0.032 });
  rifle.scale.setScalar(0.92);
  viewHolder.add(rifle);
  viewModels.rifle = rifle;

  // ---- SMG ----
  const smg = new THREE.Group();
  cyl(smg, 0.016, 0.018, 0.32, M.blued, 0, -0.045, -0.14, -Math.PI / 2, 0, 0, 10);
  box(smg, 0.07, 0.04, 0.14, M.steelHi, 0, -0.025, -0.04);
  tagHide(box(smg, 0.10, 0.11, 0.20, M.polymer, 0, -0.08, 0.06));
  tagHide(box(smg, 0.04, 0.18, 0.06, M.mag, 0, -0.20, 0.04));
  tagHide(box(smg, 0.06, 0.14, 0.06, M.polymer, 0, -0.18, 0.12));
  tagHide(box(smg, 0.06, 0.04, 0.10, M.steelLo, 0, -0.06, 0.18));
  box(smg, 0.025, 0.025, 0.07, M.steel, 0.035, -0.10, -0.08);
  cyl(smg, 0.02, 0.02, 0.03, M.steelHi, 0, -0.045, -0.30, -Math.PI / 2, 0, 0, 8);
  addIronSights(smg, { sy: 0, rearZ: -0.06, frontZ: -0.34, peep: 0.03 });
  smg.scale.setScalar(0.95);
  smg.visible = false;
  viewHolder.add(smg);
  viewModels.smg = smg;

  // ---- SNIPER: long blued barrel, wood furniture, glass scope ----
  const sniper = new THREE.Group();
  cyl(sniper, 0.016, 0.02, 0.92, M.blued, 0, 0.04, -0.46, -Math.PI / 2, 0, 0, 12);
  box(sniper, 0.06, 0.03, 0.28, M.steel, 0, 0.07, -0.28);
  box(sniper, 0.10, 0.12, 0.30, M.wood, 0, -0.02, 0.02);
  box(sniper, 0.11, 0.08, 0.22, M.woodDark, 0, -0.04, 0.18);
  box(sniper, 0.10, 0.14, 0.06, M.woodDark, 0, -0.02, 0.30);
  box(sniper, 0.065, 0.18, 0.08, M.wood, 0, -0.16, 0.08);
  box(sniper, 0.05, 0.10, 0.06, M.mag, 0, -0.14, -0.02);
  cyl(sniper, 0.038, 0.038, 0.26, M.steelHi, 0, 0.12, -0.02, -Math.PI / 2, 0, 0, 12);
  cyl(sniper, 0.032, 0.032, 0.03, M.glass, 0, 0.12, -0.16, -Math.PI / 2, 0, 0, 12);
  cyl(sniper, 0.026, 0.026, 0.03, M.glass, 0, 0.12, 0.12, -Math.PI / 2, 0, 0, 12);
  box(sniper, 0.02, 0.04, 0.02, M.steel, 0, 0.07, -0.06);
  box(sniper, 0.02, 0.04, 0.02, M.steel, 0, 0.07, 0.06);
  cyl(sniper, 0.006, 0.006, 0.09, M.steelHi, -0.04, -0.08, -0.32, 0, 0, 0, 6);
  cyl(sniper, 0.006, 0.006, 0.09, M.steelHi, 0.04, -0.08, -0.32, 0, 0, 0, 6);
  box(sniper, 0.09, 0.02, 0.02, M.steel, 0, -0.04, -0.32);
  sniper.scale.setScalar(0.86);
  sniper.visible = false;
  viewHolder.add(sniper);
  viewModels.sniper = sniper;

  // ---- RPG ----
  const rpg = new THREE.Group();
  cyl(rpg, 0.055, 0.055, 0.85, M.steelLo, 0, 0.04, -0.28, -Math.PI / 2, 0, 0, 14);
  cyl(rpg, 0.062, 0.062, 0.12, M.steel, 0, 0.04, 0.18, -Math.PI / 2, 0, 0, 12);
  cyl(rpg, 0.062, 0.062, 0.1, M.steel, 0, 0.04, -0.68, -Math.PI / 2, 0, 0, 12);
  box(rpg, 0.08, 0.16, 0.1, M.polymer, 0, -0.12, 0.02);
  box(rpg, 0.06, 0.05, 0.22, M.wood, 0.02, -0.02, -0.15);
  box(rpg, 0.1, 0.12, 0.04, M.woodDark, 0.02, 0.02, 0.22);
  box(rpg, 0.04, 0.04, 0.12, M.steelHi, 0.06, 0.12, -0.08);
  box(rpg, 0.035, 0.035, 0.03, M.steel, 0.06, 0.12, -0.15);
  const rocketVm = cyl(rpg, 0.032, 0.032, 0.28, M.rocket, 0, 0.04, -0.45, -Math.PI / 2, 0, 0, 10);
  rocketVm.name = 'rpgRocket';
  cyl(rpg, 0.04, 0.02, 0.06, M.warhead, 0, 0.04, -0.60, -Math.PI / 2, 0, 0, 10);
  rpg.scale.setScalar(0.9);
  rpg.visible = false;
  viewHolder.add(rpg);
  viewModels.rpg = rpg;

  // ---- GRENADE ----
  const grenade = new THREE.Group();
  cyl(grenade, 0.052, 0.055, 0.12, M.olive, 0, 0, 0, 0, 0, 0, 12);
  box(grenade, 0.12, 0.04, 0.12, M.oliveDark, 0, 0.05, 0);
  box(grenade, 0.12, 0.04, 0.12, M.oliveDark, 0, -0.04, 0);
  cyl(grenade, 0.02, 0.022, 0.05, M.steelHi, 0, 0.1, 0, 0, 0, 0, 8);
  box(grenade, 0.03, 0.08, 0.02, M.steel, 0.04, 0.12, 0.02, 0, 0, 0.4);
  box(grenade, 0.02, 0.02, 0.02, M.accent, 0, 0.14, 0);
  grenade.scale.setScalar(1.05);
  grenade.visible = false;
  viewHolder.add(grenade);
  viewModels.grenade = grenade;

  // ---- SMOKE ----
  const smokeG = new THREE.Group();
  cyl(smokeG, 0.042, 0.042, 0.18, M.smokeBody, 0, 0, 0, 0, 0, 0, 12);
  box(smokeG, 0.1, 0.03, 0.1, M.steelLo, 0, 0.08, 0);
  box(smokeG, 0.1, 0.03, 0.1, M.steelLo, 0, -0.08, 0);
  cyl(smokeG, 0.018, 0.018, 0.04, M.steel, 0, 0.12, 0, 0, 0, 0, 8);
  box(smokeG, 0.11, 0.04, 0.02, M.stripe, 0, 0.02, 0.055);
  smokeG.visible = false;
  viewHolder.add(smokeG);
  viewModels.smoke = smokeG;

  // ---- FLASH ----
  const flashG = new THREE.Group();
  cyl(flashG, 0.048, 0.048, 0.13, M.flashBody, 0, 0, 0, 0, 0, 0, 12);
  box(flashG, 0.11, 0.03, 0.11, M.steelHi, 0, 0.06, 0);
  box(flashG, 0.11, 0.03, 0.11, M.steelHi, 0, -0.06, 0);
  cyl(flashG, 0.014, 0.014, 0.04, M.steel, 0, 0.1, 0, 0, 0, 0, 8);
  box(flashG, 0.02, 0.06, 0.02, M.polymer, 0.05, 0, 0);
  box(flashG, 0.02, 0.06, 0.02, M.polymer, -0.05, 0, 0);
  flashG.visible = false;
  viewHolder.add(flashG);
  viewModels.flash = flashG;

  // Hip: right-of-centre. ADS: yellow tip on look axis, gun held far enough
  // that stock/grip never clip into the near plane (that was “inside the gun”).
  viewBase = new THREE.Vector3(0.28, -0.24, -0.64);
  viewAdsBase = new THREE.Vector3(0.0, 0.0, -0.48);
  viewHolder.position.copy(viewBase);
  viewHolder.rotation.set(0, 0.05, 0);

  // Trajectory preview (lobbed throwables) — enough verts for full fuse sim @ 30Hz
  const TRAJ_MAX = 128;
  const tGeo = new THREE.BufferGeometry();
  tGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(TRAJ_MAX * 3), 3));
  trajLine = new THREE.Line(
    tGeo,
    new THREE.LineBasicMaterial({
      color: 0x00f0ff, transparent: true, opacity: 0.9,
      depthTest: true, depthWrite: false, fog: false,
    })
  );
  trajLine.frustumCulled = false;
  trajLine.visible = false;
  trajLine.renderOrder = 10;
  scene.add(trajLine);
  trajMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.22, 0.4, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffe14a, transparent: true, opacity: 0.95,
      side: THREE.DoubleSide, depthWrite: false, fog: false,
    })
  );
  trajMarker.rotation.x = -Math.PI / 2;
  trajMarker.visible = false;
  trajMarker.renderOrder = 11;
  scene.add(trajMarker);

  showViewWeapon(currentWeapon);
}

function showViewWeapon(id) {
  for (const [k, g] of Object.entries(viewModels)) g.visible = k === id;
  switchKick = 1;
}

function isLobThrowable(id) {
  return id === 'grenade' || id === 'smoke' || id === 'flash';
}

function armEquipment(id) {
  if (!running || deathCam) return;
  const def = throwableDef(id);
  if (!def) return;
  if ((throwCdMs[id] || 0) > 50) {
    addFeedLine(`${def.name} recharging…`);
    return;
  }
  // Toggle off if already armed
  if (armedEquip === id) {
    disarmEquipment();
    return;
  }
  armedEquip = id;
  aiming = false;
  showViewWeapon(id);
  updateThrowableHud();
  addFeedLine(`${def.name} armed — click to ${id === 'rpg' ? 'fire' : 'throw'}`);
}

function disarmEquipment() {
  armedEquip = null;
  showViewWeapon(currentWeapon);
  if (trajLine) trajLine.visible = false;
  if (trajMarker) trajMarker.visible = false;
  updateThrowableHud();
}

// ---- ballistic tracers (travel time = weapon bulletSpeed, path = hitreg) ----
const TRACER_SPEED = 300;     // fallback if weapon has no bulletSpeed
const TRACER_LEN = 7.5;       // long enough to read drop curve in flight
const TRACER_SEG_MAX = 64;
const TRACER_ALPHA = 0.62;

let tracerGeo, tracerMesh;
// Hitmarker / dmg numbers wait for "bullet arrival" so feedback matches the streak
const hitFeedbackQ = [];

function buildTracerPool() {
  tracerGeo = new THREE.BufferGeometry();
  tracerGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(TRACER_SEG_MAX * 6), 3));
  tracerGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(TRACER_SEG_MAX * 6), 3));
  tracerMesh = new THREE.LineSegments(
    tracerGeo,
    new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: TRACER_ALPHA,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    })
  );
  tracerMesh.frustumCulled = false;
  scene.add(tracerMesh);
}

function pathLength(path) {
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    d += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return d;
}

function pointOnPath(path, dist) {
  if (!path || path.length === 0) return [0, 0, 0];
  if (dist <= 0) return path[0].slice();
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1e-9;
    if (acc + seg >= dist) {
      const u = (dist - acc) / seg;
      return [
        a[0] + (b[0] - a[0]) * u,
        a[1] + (b[1] - a[1]) * u,
        a[2] + (b[2] - a[2]) * u,
      ];
    }
    acc += seg;
  }
  return path[path.length - 1].slice();
}

function tracerSpeedFor(weaponId, explicit) {
  if (explicit > 0) return explicit;
  const def = weaponDef(weaponId);
  return (def && def.bulletSpeed) || TRACER_SPEED;
}

/** Flight time (s) for a bullet over path distance — used for hit feedback delay. */
function bulletFlightTime(dist, weaponId) {
  const spd = Math.max(80, tracerSpeedFor(weaponId));
  // Cap so ultra-long shots still feel snappy; floor so point-blank isn't zero
  return Math.min(0.55, Math.max(0.04, dist / spd));
}

function spawnTracer(from, to, opts = {}) {
  let path = opts.path;
  if (!path || path.length < 2) path = [from, to];
  // Do NOT replace path[0] with a random muzzle — path must match hitreg curve
  if (from && (!opts.path || opts.path.length < 2)) {
    path = [from, to];
  }
  const dist = pathLength(path) || 0.001;
  const end = path[path.length - 1];
  // Impact direction from last path segment (respects drop), not eye→end chord
  let dx = 0, dy = 0, dz = -1;
  if (path.length >= 2) {
    const a = path[path.length - 2], b = path[path.length - 1];
    dx = b[0] - a[0]; dy = b[1] - a[1]; dz = b[2] - a[2];
  } else {
    dx = end[0] - path[0][0]; dy = end[1] - path[0][1]; dz = end[2] - path[0][2];
  }
  const dl = Math.hypot(dx, dy, dz) || 1;
  const weapon = opts.weapon || 'rifle';
  tracers.push({
    path,
    dist,
    travel: 0,
    done: false,
    hitPlayer: !!opts.hitPlayer,
    block: opts.block | 0,
    mine: !!opts.mine,
    weapon,
    speed: tracerSpeedFor(weapon, opts.speed),
    dir: [dx / dl, dy / dl, dz / dl],
    // Wall debris on arrival; player flesh waits for confirmed hitmarker
    noImpact: !!opts.noImpact,
  });
}

function updateTracers(dt) {
  if (!tracerGeo) return;
  const posAttr = tracerGeo.getAttribute('position');
  const colAttr = tracerGeo.getAttribute('color');
  let n = 0;
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    const speed = t.speed || tracerSpeedFor(t.weapon);
    t.travel += speed * dt;

    if (!t.done && t.travel >= t.dist) {
      t.done = true;
      t.fade = 0.55;
      const hit = pointOnPath(t.path, t.dist);
      if (!t.noImpact) {
        spawnImpact(hit[0], hit[1], hit[2], t.dir, t.hitPlayer, t.block);
      }
    }
    if (t.done) {
      t.fade -= dt * 5.5;
      if (t.fade <= 0) { tracers.splice(i, 1); continue; }
    }
    if (n >= TRACER_SEG_MAX - 2) continue;

    const headD = Math.min(t.travel, t.dist);
    const trailLen = t.hitPlayer ? TRACER_LEN * 1.2 : TRACER_LEN;
    const tailD = Math.max(0, headD - trailLen);
    const a = (t.done ? t.fade : 1) * 0.85;
    const head = pointOnPath(t.path, headD);
    const mid = pointOnPath(t.path, (headD + tailD) * 0.55);
    const tail = pointOnPath(t.path, tailD);

    // Soft weapon tint (much less neon than before)
    let hr = 1.4, hg = 1.2, hb = 0.55;
    let tr = 0.35, tg = 0.22, tb = 0.1;
    if (t.weapon === 'smg') {
      hr = 0.55; hg = 1.15; hb = 1.5; tr = 0.15; tg = 0.35; tb = 0.55;
    } else if (t.weapon === 'sniper') {
      hr = 1.55; hg = 0.95; hb = 0.4; tr = 0.4; tg = 0.2; tb = 0.08;
    }
    if (t.hitPlayer) { hr *= 1.15; hg *= 1.1; hb *= 1.1; }

    // Single soft streak tail → head
    posAttr.setXYZ(n * 2, tail[0], tail[1], tail[2]);
    posAttr.setXYZ(n * 2 + 1, mid[0], mid[1], mid[2]);
    colAttr.setXYZ(n * 2, tr * a, tg * a, tb * a);
    colAttr.setXYZ(n * 2 + 1, hr * a * 0.7, hg * a * 0.7, hb * a * 0.7);
    n++;
    posAttr.setXYZ(n * 2, mid[0], mid[1], mid[2]);
    posAttr.setXYZ(n * 2 + 1, head[0], head[1], head[2]);
    colAttr.setXYZ(n * 2, hr * a * 0.75, hg * a * 0.75, hb * a * 0.75);
    colAttr.setXYZ(n * 2 + 1, hr * a, hg * a, hb * a);
    n++;
  }
  tracerGeo.setDrawRange(0, n * 2);
  posAttr.needsUpdate = true;
  colAttr.needsUpdate = true;
}

// ---- particles: voxel-flavoured debris cubes -------------------------------

const PARTICLE_MAX = 420;
let particleMesh, particleData = [];
const _pm = new THREE.Matrix4(), _pq = new THREE.Quaternion(), _pv = new THREE.Vector3(), _ps = new THREE.Vector3();

function buildParticles() {
  particleMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({
      vertexColors: false,
      fog: false, // fog was eating impacts at range
      transparent: true,
      depthWrite: false,
      toneMapped: false, // keep spark colors bright under ACES
    }),
    PARTICLE_MAX
  );
  particleMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PARTICLE_MAX * 3), 3);
  particleMesh.frustumCulled = false;
  particleMesh.count = 0;
  particleMesh.renderOrder = 20;
  scene.add(particleMesh);
}

// average colour per block type, so sparks match what you shot
const BLOCK_TINT = {
  [V.GRASS]: [0.42, 0.66, 0.29], [V.DIRT]: [0.52, 0.38, 0.26],
  [V.STONE]: [0.50, 0.50, 0.52], [V.COBBLE]: [0.45, 0.45, 0.47],
  [V.PLANKS]: [0.63, 0.50, 0.31], [V.LOG]: [0.40, 0.31, 0.19],
  [V.LEAVES]: [0.24, 0.52, 0.20], [V.SAND]: [0.84, 0.78, 0.58],
  [V.BRICK]: [0.59, 0.29, 0.24], [V.IRON]: [0.69, 0.71, 0.75],
};

function addParticle(x, y, z, vx, vy, vz, size, life, color, gravity) {
  if (particleData.length >= PARTICLE_MAX) particleData.shift();
  particleData.push({ x, y, z, vx, vy, vz, size, life, maxLife: life, color, gravity });
}

/** Normalize aim/impact direction from {x,y,z}, THREE.Vector3, or [x,y,z]. */
function impactDirXYZ(dir) {
  if (!dir) return [0, 0, -1];
  if (Array.isArray(dir)) {
    const x = +dir[0] || 0, y = +dir[1] || 0, z = +dir[2] || 0;
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  }
  const x = +(dir.x) || 0, y = +(dir.y) || 0, z = +(dir.z) || 0;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// Brief additive flash at impact — always visible even if debris is subtle
const impactFlashes = [];
function spawnImpactFlash(x, y, z, hitPlayer) {
  if (!scene) return;
  const mat = new THREE.SpriteMaterial({
    color: hitPlayer ? 0xff3344 : 0xffe08a,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    sizeAttenuation: true,
  });
  const sp = new THREE.Sprite(mat);
  sp.position.set(x, y, z);
  const s = hitPlayer ? 0.45 : 0.38;
  sp.scale.set(s, s, s);
  sp.renderOrder = 30;
  scene.add(sp);
  impactFlashes.push({ sp, life: 0.14, max: 0.14, base: s });
}

function updateImpactFlashes(dt) {
  for (let i = impactFlashes.length - 1; i >= 0; i--) {
    const f = impactFlashes[i];
    f.life -= dt;
    const u = Math.max(0, f.life / f.max);
    f.sp.material.opacity = u * 0.95;
    const s = f.base * (0.7 + (1 - u) * 1.4);
    f.sp.scale.set(s, s, s);
    if (f.life <= 0) {
      scene.remove(f.sp);
      f.sp.material.dispose();
      impactFlashes.splice(i, 1);
    }
  }
}

function spawnImpact(x, y, z, dir, hitPlayer, block) {
  // lookDir/applySpread return {x,y,z} — array indexing was NaN'ing all debris
  const [nx, ny, nz] = impactDirXYZ(dir);
  // Nudge firmly out of the solid so debris isn't born inside a block
  const px = x - nx * 0.28;
  const py = y - ny * 0.28;
  const pz = z - nz * 0.28;

  if (hitPlayer) Audio.fleshImpact({ x: px, y: py, z: pz });
  else Audio.impact(block || V.STONE, { x: px, y: py, z: pz });

  spawnImpactFlash(px, py, pz, !!hitPlayer);

  if (settings.particles === false) return;

  if (hitPlayer) {
    for (let i = 0; i < 18; i++) {
      addParticle(
        px, py, pz,
        (Math.random() - 0.5) * 3.5 - nx * 1.5,
        (Math.random() - 0.2) * 3.5,
        (Math.random() - 0.5) * 3.5 - nz * 1.5,
        0.09 + Math.random() * 0.08, 0.55 + Math.random() * 0.35,
        [0.85 + Math.random() * 0.15, 0.06, 0.08], 12
      );
    }
    return;
  }
  const tint = BLOCK_TINT[block] || BLOCK_TINT[V.STONE] || [0.55, 0.55, 0.58];
  // Chunk debris
  for (let i = 0; i < 20; i++) {
    const j = 0.55;
    addParticle(
      px, py, pz,
      -nx * (2.5 + Math.random() * 5) + (Math.random() - 0.5) * 3.5,
      -ny * (2.5 + Math.random() * 5) + Math.random() * 4.5,
      -nz * (2.5 + Math.random() * 5) + (Math.random() - 0.5) * 3.5,
      0.09 + Math.random() * 0.12, 0.7 + Math.random() * 0.55,
      [
        Math.min(1.5, tint[0] * (0.85 + Math.random() * j) + 0.2),
        Math.min(1.5, tint[1] * (0.85 + Math.random() * j) + 0.18),
        Math.min(1.5, tint[2] * (0.85 + Math.random() * j) + 0.14),
      ],
      14
    );
  }
  // Hot sparks
  for (let i = 0; i < 12; i++) {
    addParticle(
      px, py, pz,
      -nx * 6 + (Math.random() - 0.5) * 7,
      -ny * 6 + Math.random() * 6,
      -nz * 6 + (Math.random() - 0.5) * 7,
      0.06 + Math.random() * 0.04, 0.32 + Math.random() * 0.22,
      [1.2, 0.85 + Math.random() * 0.2, 0.3], 6
    );
  }
}

function updateParticles(dt) {
  if (!particleMesh) return;
  let n = 0;
  for (let i = particleData.length - 1; i >= 0; i--) {
    const p = particleData[i];
    p.life -= dt;
    if (p.life <= 0) { particleData.splice(i, 1); continue; }
    p.vy -= (p.gravity || 12) * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    // Soft collision — bounce off solids without teleporting away from wall hits
    if (world && world.isSolid(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) {
      p.x -= p.vx * dt * 1.2;
      p.y -= p.vy * dt * 1.2;
      p.z -= p.vz * dt * 1.2;
      p.vx *= -0.35;
      p.vy = Math.abs(p.vy) * 0.25;
      p.vz *= -0.35;
    }
    if (n >= PARTICLE_MAX) continue;
    const k = Math.min(1, p.life / p.maxLife);
    const s = p.size * (0.45 + k * 0.7);
    _pv.set(p.x, p.y, p.z);
    _ps.set(s, s, s);
    _pm.compose(_pv, _pq, _ps);
    particleMesh.setMatrixAt(n, _pm);
    particleMesh.instanceColor.setXYZ(
      n,
      Math.min(2, p.color[0]),
      Math.min(2, p.color[1]),
      Math.min(2, p.color[2])
    );
    n++;
  }
  particleMesh.count = n;
  particleMesh.instanceMatrix.needsUpdate = true;
  if (particleMesh.instanceColor) particleMesh.instanceColor.needsUpdate = true;
}

// ---- muzzle flash + shell casings ------------------------------------------

let muzzle, muzzleLife = 0;
const MUZZLE_TINT = {
  rifle: 0xffd86b,
  smg: 0x7ec8ff,
  sniper: 0xff9f4a,
};
function buildMuzzleFlash() {
  // Sprite always faces the camera correctly. A PlaneMesh parented under the
  // viewmodel + copy(camera.quaternion) double-rotated and showed as a square
  // when ADS-shooting.
  const mat = new THREE.SpriteMaterial({
    color: 0xffd86b,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    fog: false,
    sizeAttenuation: true,
  });
  muzzle = new THREE.Sprite(mat);
  muzzle.position.set(0, 0, -0.62);
  muzzle.scale.set(0.35, 0.35, 0.35);
  muzzle.renderOrder = 999;
  viewHolder.add(muzzle);
}

function updateMuzzle(dt) {
  if (!muzzle) return;
  // Muzzle sits on the barrel tip of the active viewmodel (local view-space).
  const equip = armedEquip || currentWeapon;
  // Hide for throwables and any real ADS — flash at center-screen reads as a square.
  const hideFlash = isLobThrowable(equip) || adsBlend > 0.35;
  const mo = muzzleLocalOffset();
  muzzle.position.set(mo.x, mo.y, mo.z);
  const decay = equip === 'smg' ? 28 : equip === 'sniper' ? 12 : equip === 'rpg' ? 10 : 18;
  muzzleLife = Math.max(0, muzzleLife - dt * decay);
  // Sprite billboards automatically — never copy camera quaternion
  muzzle.material.opacity = hideFlash ? 0 : muzzleLife * (equip === 'sniper' ? 1.1 : 0.95);
  const s = (equip === 'sniper' ? 0.28 : equip === 'rpg' ? 0.42 : 0.32)
    + muzzleLife * (equip === 'smg' ? 0.22 : 0.35);
  muzzle.scale.set(s, s * 0.9, 1);
  muzzle.visible = !hideFlash && muzzleLife > 0.01 && viewHolder && viewHolder.visible;
}

// World-space gun tip + barrel direction (viewmodel → world).
const _muzzleWorld = new THREE.Vector3();
const _barrelDir = new THREE.Vector3();
const _viewQ = new THREE.Quaternion();
function muzzleLocalOffset() {
  // Tip of barrel in viewHolder local space (sight line is y≈0; barrel sits below)
  const equip = armedEquip || currentWeapon;
  const sc = equip === 'smg' ? 0.95 : equip === 'sniper' ? 0.86 : 0.92;
  if (equip === 'sniper') return { x: 0, y: 0.04 * sc, z: -0.92 * sc };
  if (equip === 'smg') return { x: 0, y: -0.045 * sc, z: -0.30 * sc };
  if (equip === 'rpg') return { x: 0, y: 0.04 * sc, z: -0.72 * sc };
  return { x: 0, y: -0.055 * sc, z: -0.55 * sc }; // rifle
}
function getMuzzleWorldPos() {
  if (!viewHolder || !camera) return null;
  const o = muzzleLocalOffset();
  if (muzzle) muzzle.position.set(o.x, o.y, o.z);
  // Sample tip from viewHolder so hip lean is included
  _muzzleWorld.set(o.x, o.y, o.z);
  viewHolder.localToWorld(_muzzleWorld);
  return _muzzleWorld;
}
function getBarrelDir() {
  // Barrel = viewHolder local −Z in world space (tracks ADS parallel + hip lean)
  if (!viewHolder) {
    if (!camera) return null;
    _barrelDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    return _barrelDir;
  }
  viewHolder.getWorldQuaternion(_viewQ);
  _barrelDir.set(0, 0, -1).applyQuaternion(_viewQ);
  return _barrelDir;
}

function spawnShellCasing() {
  if (settings.particles === false || !camera) return;
  // Eject to the right of the camera in world space
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const ox = camera.position.x + right.x * 0.18 + up.x * -0.08 + fwd.x * 0.15;
  const oy = camera.position.y + right.y * 0.18 + up.y * -0.08 + fwd.y * 0.15;
  const oz = camera.position.z + right.z * 0.18 + up.z * -0.08 + fwd.z * 0.15;
  const speed = currentWeapon === 'smg' ? 3.2 : currentWeapon === 'sniper' ? 4.5 : 3.8;
  addParticle(
    ox, oy, oz,
    right.x * speed + (Math.random() - 0.5) * 1.2 + fwd.x * 0.4,
    up.y * (1.5 + Math.random() * 2.2) + 1.5,
    right.z * speed + (Math.random() - 0.5) * 1.2 + fwd.z * 0.4,
    0.035 + Math.random() * 0.02,
    0.55 + Math.random() * 0.25,
    currentWeapon === 'smg' ? [0.55, 0.75, 1.1] : [1.6, 1.25, 0.35],
    18
  );
}

// ------------------------------------------------------- remote avatars -----

function playerColor(id) {
  const hue = (id * 137.508) % 360;
  return new THREE.Color().setHSL(hue / 360, 0.62, 0.55);
}

function makeNameplate(text, pronouns) {
  const cv = document.createElement('canvas');
  cv.width = 384; cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgba(10,12,16,0.72)';
  g.fillRect(0, 0, 384, 64);
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  // Name and pronouns are drawn as one centred run so the pair stays visually
  // attached, with the pronouns set smaller and dimmer than the name.
  const nameFont = 'bold 30px ui-monospace, Menlo, monospace';
  const prFont = '20px ui-monospace, Menlo, monospace';
  const pr = pronouns ? `(${pronouns})` : '';
  g.font = nameFont;
  const nameW = g.measureText(text).width;
  g.font = prFont;
  const prW = pr ? g.measureText(pr).width + 10 : 0;
  const startX = 192 - (nameW + prW) / 2;

  g.font = nameFont;
  g.fillStyle = '#fff';
  g.textAlign = 'left';
  g.fillText(text, startX, 32);
  if (pr) {
    g.font = prFont;
    g.fillStyle = '#9fb0c8';
    g.fillText(pr, startX + nameW + 10, 33);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.LinearFilter;
  // depthTest must stay ON: without it nameplates draw over terrain and you can
  // track enemies through solid walls, which is a wallhack when kills pay money.
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, fog: false }));
  sp.scale.set(2.55, 0.42, 1);
  sp.position.y = 2.25;
  return sp;
}

function createAvatar(p) {
  const group = new THREE.Group();
  const color = playerColor(p.id);
  const skin = new THREE.MeshBasicMaterial({ color });
  const dark = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(0.62) });
  const face = new THREE.MeshBasicMaterial({ color: 0xf0c9a0 });

  const yawGroup = new THREE.Group();
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.52, 0.52), face);
  head.position.y = 1.52;
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.72, 0.3), skin);
  body.position.y = 0.9;
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.7, 0.2), skin);
  armL.position.set(-0.37, 0.92, 0);
  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.7, 0.2), skin);
  armR.position.set(0.37, 0.92, 0);
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.76, 0.22), dark);
  legL.position.set(-0.14, 0.16, 0);
  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.76, 0.22), dark);
  legR.position.set(0.14, 0.16, 0);
  // stubby gun so you can read which way they're aiming
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.5), new THREE.MeshBasicMaterial({ color: 0x3b4048 }));
  gun.position.set(0.37, 0.92, -0.32);

  yawGroup.add(head, body, armL, armR, legL, legR, gun);
  group.add(yawGroup);

  const plate = makeNameplate(p.u, p.pr);
  group.add(plate);
  scene.add(group);

  return {
    group, yawGroup, head, body, legL, legR, gun, plate,
    walkPhase: 0, pronouns: p.pr || '', crouching: false,
  };
}

function removeAvatar(id) {
  const a = remote.get(id);
  if (!a) return;
  scene.remove(a.group);
  a.group.traverse((o) => { o.geometry?.dispose(); });
  a.plate.material.map?.dispose();
  remote.delete(id);
}

// ---- map power-ups (ZERO-G pods) -------------------------------------------

const powerupMeshes = new Map(); // id -> { group, kind, bob }
let lowGravSparkAcc = 0;
let chaosEndsAt = 0;
let chaosVisibleId = null;

function powerupColor(kind) {
  const def = (C.powerups && C.powerups[kind]) || {};
  if (def.color != null) return def.color;
  if (kind === 'haste') return 0xffe14a;
  if (kind === 'superJump') return 0x9b7bff;
  if (kind === 'overcharge') return 0xff2d6a;
  if (kind === 'armor') return 0x4d9dff;
  return 0x66ffcc;
}

function makePowerupMesh(kind) {
  const group = new THREE.Group();
  const col = powerupColor(kind);
  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.38, 0),
    new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.92,
      depthWrite: false, fog: false, toneMapped: false,
    })
  );
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.04, 8, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.55,
      depthWrite: false, fog: false, toneMapped: false,
    })
  );
  ring.rotation.x = Math.PI / 2;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    color: col, transparent: true, opacity: 0.45,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
  }));
  glow.scale.set(1.6, 1.6, 1.6);
  group.add(core, ring, glow);
  group.userData = { core, ring, glow };
  return group;
}

function clearPowerupMeshes() {
  for (const [, m] of powerupMeshes) {
    scene.remove(m.group);
    m.group.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((x) => x.dispose?.());
        else o.material.dispose?.();
      }
    });
  }
  powerupMeshes.clear();
}

function syncPowerups(list) {
  if (!scene || !list) return;
  const seen = new Set();
  for (const pu of list) {
    seen.add(pu.id);
    let m = powerupMeshes.get(pu.id);
    if (!pu.active) {
      if (m) m.group.visible = false;
      continue;
    }
    if (!m) {
      const group = makePowerupMesh(pu.kind || 'lowGrav');
      scene.add(group);
      m = { group, kind: pu.kind || 'lowGrav', bob: Math.random() * Math.PI * 2, baseY: pu.y };
      powerupMeshes.set(pu.id, m);
    }
    m.group.visible = true;
    m.baseY = pu.y;
    m.group.position.set(pu.x, pu.y, pu.z);
    m.kind = pu.kind || m.kind;
  }
  for (const id of [...powerupMeshes.keys()]) {
    if (!seen.has(id)) {
      const m = powerupMeshes.get(id);
      scene.remove(m.group);
      m.group.traverse((o) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
      powerupMeshes.delete(id);
    }
  }
}

function updatePowerupMeshes(dt) {
  const t = performance.now() * 0.001;
  for (const [, m] of powerupMeshes) {
    if (!m.group.visible) continue;
    m.bob += dt;
    m.group.position.y = m.baseY + Math.sin(t * 2.4 + m.bob) * 0.22;
    m.group.rotation.y += dt * 1.6;
    if (m.group.userData.ring) m.group.userData.ring.rotation.z += dt * 2.2;
    if (m.group.userData.glow) {
      const s = 1.4 + Math.sin(t * 3 + m.bob) * 0.25;
      m.group.userData.glow.scale.set(s, s, s);
    }
  }
}

const BUFF_KEYS = [
  { key: 'lowGravT', id: 'lowGrav', cls: 'buff-zerog', label: 'ZERO-G' },
  { key: 'hasteT', id: 'haste', cls: 'buff-haste', label: 'HASTE' },
  { key: 'superJumpT', id: 'superJump', cls: 'buff-jump', label: 'LAUNCH' },
  { key: 'overchargeT', id: 'overcharge', cls: 'buff-rage', label: 'OVERCHARGE' },
  { key: 'armorT', id: 'armor', cls: 'buff-armor', label: 'PLATE' },
];

function updateBuffHud() {
  const root = document.getElementById('hud-buffs');
  if (!root) return;
  let html = '';
  for (const b of BUFF_KEYS) {
    const t = me[b.key] || 0;
    if (t <= 0.05) continue;
    const def = (C.powerups && C.powerups[b.id]) || {};
    const max = def.duration || 14;
    const pct = Math.max(0, Math.min(100, (t / max) * 100));
    html += `<div class="hud-buff ${b.cls}"><span class="bf-label">${b.label}</span>`
      + `<div class="bf-bar"><i style="width:${pct.toFixed(0)}%"></i></div>`
      + `<span class="bf-time">${t.toFixed(1)}</span></div>`;
  }
  root.innerHTML = html;
  document.body.classList.toggle('low-grav', (me.lowGravT || 0) > 0.05 || (me.eventGravMul || 1) < 0.85);
  document.body.classList.toggle('haste-on', (me.hasteT || 0) > 0.05);
  document.body.classList.toggle('rage-on', (me.overchargeT || 0) > 0.05);
}

function updateClimbHud() {
  const el = document.getElementById('hud-climb');
  if (!el) return;
  el.classList.toggle('hidden', !(me.onWall && keys.jump));
}

function pulsePowerupPickup(kind) {
  const col = powerupColor(kind);
  const r = ((col >> 16) & 255) / 255;
  const g = ((col >> 8) & 255) / 255;
  const b = (col & 255) / 255;
  if (settings.particles !== false && havePosition) {
    for (let i = 0; i < 28; i++) {
      addParticle(
        me.x + (Math.random() - 0.5) * 0.7,
        me.y + 0.4 + Math.random() * 1.3,
        me.z + (Math.random() - 0.5) * 0.7,
        (Math.random() - 0.5) * 3.5,
        1 + Math.random() * 4,
        (Math.random() - 0.5) * 3.5,
        0.08 + Math.random() * 0.07,
        0.55 + Math.random() * 0.4,
        [r * 1.2, g * 1.2, b * 1.2],
        4
      );
    }
  }
  updateBuffHud();
}

function showChaosBanner(msg, announce) {
  const el = document.getElementById('hud-chaos');
  if (!el || !msg) return;
  chaosEndsAt = msg.endsAt || (Date.now() + (msg.duration || 15) * 1000);
  chaosVisibleId = msg.id || msg.name;
  el.classList.remove('hidden');
  el.style.setProperty('--chaos-color', msg.color || '#00f0ff');
  const title = el.querySelector('.ch-title');
  const blurb = el.querySelector('.ch-blurb');
  const timer = el.querySelector('.ch-timer');
  if (title) title.textContent = msg.name || 'CHAOS';
  if (blurb) blurb.textContent = msg.blurb || '';
  if (timer) timer.textContent = '';
  if (announce) {
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }
}

function hideChaosBanner(soft) {
  const el = document.getElementById('hud-chaos');
  if (!el) return;
  if (soft && chaosVisibleId && Date.now() < chaosEndsAt - 200) return;
  chaosVisibleId = null;
  chaosEndsAt = 0;
  el.classList.add('hidden');
}

function updateChaosHud() {
  if (!chaosEndsAt) return;
  const el = document.getElementById('hud-chaos');
  if (!el || el.classList.contains('hidden')) return;
  const left = Math.max(0, (chaosEndsAt - Date.now()) / 1000);
  const timer = el.querySelector('.ch-timer');
  if (timer) timer.textContent = left.toFixed(1);
  if (left <= 0) hideChaosBanner();
}

function tickBuffFx(dt) {
  // Predict combat buff decay between 30Hz state frames
  if (me.overchargeT > 0) me.overchargeT = Math.max(0, me.overchargeT - dt);
  if (me.armorT > 0) me.armorT = Math.max(0, me.armorT - dt);
  updateBuffHud();
  updateChaosHud();
  if (!havePosition || settings.particles === false) return;
  lowGravSparkAcc += dt;
  if (lowGravSparkAcc < 0.08) return;
  lowGravSparkAcc = 0;
  const zeroG = (me.lowGravT || 0) > 0 || (me.eventGravMul || 1) < 0.85;
  const haste = (me.hasteT || 0) > 0 || (me.eventSpeedMul || 1) > 1.2;
  if (zeroG) {
    addParticle(
      me.x + (Math.random() - 0.5) * 0.8,
      me.y + 0.2 + Math.random() * 1.5,
      me.z + (Math.random() - 0.5) * 0.8,
      (Math.random() - 0.5) * 0.4, 0.4 + Math.random() * 1.2, (Math.random() - 0.5) * 0.4,
      0.05, 0.45, [0.35, 0.95, 0.8], 2
    );
  }
  if (haste) {
    addParticle(
      me.x + (Math.random() - 0.5) * 0.4,
      me.y + 0.1 + Math.random() * 0.4,
      me.z + (Math.random() - 0.5) * 0.4,
      -me.vx * 0.1, 0.2, -me.vz * 0.1,
      0.06, 0.25, [1.0, 0.85, 0.25], 1
    );
  }
}

// ---- practice dummies ------------------------------------------------------

function createDummy(d) {
  const group = new THREE.Group();
  // Neon-orange training mannequin so it never confuses with real players
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0xff6b2d });
  const darkMat = new THREE.MeshBasicMaterial({ color: 0xc44a18 });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xffc53d });
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), headMat);
  head.position.y = 1.52;
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.75, 0.32), bodyMat);
  body.position.y = 0.9;
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.72, 0.22), darkMat);
  legL.position.set(-0.14, 0.16, 0);
  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.72, 0.22), darkMat);
  legR.position.set(0.14, 0.16, 0);
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.65, 0.18), bodyMat);
  armL.position.set(-0.38, 0.95, 0);
  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.65, 0.18), bodyMat);
  armR.position.set(0.38, 0.95, 0);
  // Target marker ring on chest
  const badge = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.28, 0.06),
    new THREE.MeshBasicMaterial({ color: 0x00f0ff })
  );
  badge.position.set(0, 1.05, 0.18);
  group.add(head, body, legL, legR, armL, armR, badge);

  const plate = makeNameplate(d.u || 'TARGET', 'bot');
  plate.position.y = 2.2;
  group.add(plate);
  group.position.set(d.x, d.y, d.z);
  group.rotation.y = d.yaw || 0;
  scene.add(group);

  // HP bar sprite above head
  const hpCv = document.createElement('canvas');
  hpCv.width = 128; hpCv.height = 16;
  const hpTex = new THREE.CanvasTexture(hpCv);
  const hpSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: hpTex, transparent: true, depthTest: true, fog: false,
  }));
  hpSprite.scale.set(1.2, 0.15, 1);
  hpSprite.position.y = 2.0;
  group.add(hpSprite);

  return { group, plate, hpCv, hpTex, hpSprite, hp: d.hp };
}

function drawDummyHp(dum, hp, maxHp = 100) {
  const g = dum.hpCv.getContext('2d');
  g.clearRect(0, 0, 128, 16);
  g.fillStyle = 'rgba(0,0,0,0.65)';
  g.fillRect(0, 0, 128, 16);
  const pct = Math.max(0, Math.min(1, hp / maxHp));
  g.fillStyle = pct > 0.4 ? '#00f0ff' : pct > 0.18 ? '#ffe14a' : '#ff2d6a';
  g.fillRect(2, 2, 124 * pct, 12);
  dum.hpTex.needsUpdate = true;
}

function removeDummy(id) {
  const d = dummies.get(id);
  if (!d) return;
  scene.remove(d.group);
  d.group.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) {
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
  dummies.delete(id);
}

function updateDummies(list) {
  if (!list) return;
  const seen = new Set();
  for (const d of list) {
    seen.add(d.id);
    let dum = dummies.get(d.id);
    if (!d.alive) {
      if (dum) dum.group.visible = false;
      continue;
    }
    if (!dum) {
      dum = createDummy(d);
      dummies.set(d.id, dum);
    }
    dum.group.visible = true;
    dum.group.position.set(d.x, d.y, d.z);
    dum.group.rotation.y = d.yaw || 0;
    if (dum.hp !== d.hp) {
      dum.hp = d.hp;
      drawDummyHp(dum, d.hp);
    }
  }
  for (const id of [...dummies.keys()]) if (!seen.has(id)) removeDummy(id);
}

// --------------------------------------------------------------- network ----

// Tear down a socket without letting its onclose schedule another reconnect.
// Critical when connect() is called while a previous socket is still open:
// the server closes the old one with 4000 ("replaced"), and that onclose used
// to start a competing reconnect loop that fights the live connection forever.
function discardSocket(socket) {
  if (!socket) return;
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    try { socket.close(); } catch {}
  }
}

let joinBotArena = false;

/** @param {{ botArena?: boolean }} [opts] */
function connect(newHooks, opts = {}) {
  if (newHooks) hooks = newHooks;
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'botArena')) {
    joinBotArena = !!opts.botArena;
  }
  intentionalExit = false;
  clearTimeout(reconnectTimer);

  // Already connected / connecting on the live socket — don't open a second
  // one (double-clicking Play, or a stray reconnect timer, used to do this).
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  discardSocket(ws);
  ws = null;

  initThree();
  Audio.init();
  try { if (localStorage.getItem('bounty.sound') === '0') Audio.setEnabled(false); } catch {}
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = joinBotArena ? '?mode=bots' : '';
  const socket = new WebSocket(`${proto}//${location.host}/ws${q}`);
  ws = socket;
  socket.binaryType = 'arraybuffer';

  socket.onopen = () => {
    if (ws !== socket) return;
    reconnectAttempt = 0;
    running = true;
    lastTime = lastStepTime = performance.now();
    accumulator = 0;
    if (!rafId) rafId = requestAnimationFrame(frame);
    clearInterval(physTimer);
    physTimer = setInterval(stepInput, 1000 / 60);
    setInterval0();
  };
  socket.onmessage = (e) => {
    if (ws !== socket) return;
    try {
      if (typeof e.data === 'string') { handleMessage(JSON.parse(e.data)); return; }
      handleVoiceFrame(new Uint8Array(e.data));
    } catch (err) {
      // Never let a bad frame kill the message handler for subsequent ones.
      console.error('[bounty] message handler', err);
    }
  };
  socket.onclose = (e) => {
    // Superseded by a newer connect() — ignore, the live socket is elsewhere.
    if (ws !== socket) return;
    running = false;
    clearInterval(physTimer);
    physTimer = null;
    if (intentionalExit) return;
    // 4000 = this account opened another socket (other tab or a newer connect).
    // Reconnecting here would immediately kick that other socket and loop.
    if (e.code === 4000) {
      addFeedLine('Disconnected — another session took over.');
      exit();
      return;
    }
    if (e.code === 4001) { exit(); return; } // insufficient funds
    if (e.code === 4002) { exit(); return; } // left intentionally
    if (reconnectAttempt < 6) {
      const delay = Math.min(4000, 400 * 2 ** reconnectAttempt++);
      addFeedLine(`Connection lost — reconnecting (${reconnectAttempt})…`);
      reconnectTimer = setTimeout(() => connect(), delay);
    } else {
      addFeedLine('Disconnected.');
      exit();
    }
  };
  socket.onerror = () => {};
}

let pingTimer = null;
function setInterval0() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
  }, 2000);
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function sendBinary(bytes) {
  if (ws && ws.readyState === 1) ws.send(bytes);
}

// A voice frame is [0x01][uint32 speakerId][mulaw payload]. It is played at the
// speaker's interpolated render position, so the voice tracks the avatar you
// can actually see rather than where they were when the packet was sent.
function handleVoiceFrame(bytes) {
  if (bytes.length < 6 || bytes[0] !== 0x01) return;
  const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
  const av = remote.get(id);
  const pos = av ? av.group.position : null;
  Voice.receive(id, bytes.subarray(5), pos);
}

function leave() {
  intentionalExit = true;
  joinBotArena = false;
  clearTimeout(reconnectTimer);
  send({ type: 'leave' });
  discardSocket(ws);
  ws = null;
  exit();
}

function exit() {
  intentionalExit = true;
  running = false;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  clearInterval(physTimer);
  physTimer = null;
  discardSocket(ws);
  ws = null;
  Voice.stop();     // release the microphone when leaving the arena
  if (document.pointerLockElement) document.exitPointerLock();
  for (const id of [...remote.keys()]) removeAvatar(id);
  for (const id of [...dummies.keys()]) removeDummy(id);
  snapshots.length = 0;
  pending.length = 0;
  tracers.length = 0;
  particleData.length = 0;
  smoothErr.x = smoothErr.y = smoothErr.z = 0;
  stepLift = 0;
  havePosition = false;
  aiming = false;
  adsBlend = 0;
  closeChat();
  chatLog.innerHTML = '';
  endDeathSequence(true);
  abortMorphFx();
  document.getElementById('overlay-dead').classList.add('hidden');
  document.getElementById('overlay-broke').classList.add('hidden');
  document.getElementById('overlay-click').classList.add('hidden');
  const scope = document.getElementById('scope-overlay');
  if (scope) scope.classList.add('hidden');
  const morphEl = document.getElementById('morph-overlay');
  if (morphEl) morphEl.classList.add('hidden');
  document.getElementById('killfeed').innerHTML = '';
  hooks.onExit?.();
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome': {
      selfId = msg.id;
      myName = msg.username;
      // Restart prediction cleanly. The server resets its acknowledged
      // sequence on every (re)join, so the client must match — and any inputs
      // still pending from the previous connection are now meaningless and
      // would be replayed on top of the authoritative position as a lurch.
      inputSeq = 0;
      pending.length = 0;
      accumulator = 0;
      smoothErr.x = smoothErr.y = smoothErr.z = 0;
      stepLift = 0;
      Object.assign(C, msg.constants);
      if (msg.constants?.weapons) C.weapons = msg.constants.weapons;
      if (msg.constants?.weaponKeys) C.weaponKeys = msg.constants.weaponKeys;
      if (msg.constants?.defaultWeapon) C.defaultWeapon = msg.constants.defaultWeapon;
      if (msg.constants?.throwables) C.throwables = msg.constants.throwables;
      if (msg.constants?.throwableKeys) C.throwableKeys = msg.constants.throwableKeys;
      if (msg.constants?.powerups) C.powerups = msg.constants.powerups;
      if (msg.constants?.powerupKeys) C.powerupKeys = msg.constants.powerupKeys;
      currentWeapon = C.defaultWeapon || 'rifle';
      aiming = false;
      adsBlend = 0;
      me.lowGravT = 0; me.hasteT = 0; me.superJumpT = 0;
      me.overchargeT = 0; me.armorT = 0;
      me.eventGravMul = 1; me.eventJumpMul = 1; me.eventSpeedMul = 1;
      throwCdMs = { grenade: 0, smoke: 0, flash: 0, rpg: 0 };
      showViewWeapon(currentWeapon);
      updateThrowableHud();
      setBalance(msg.balance);
      elo = msg.elo ?? elo;
      document.getElementById('hud-elo').textContent = elo;
      document.getElementById('hud-match').textContent = `#${msg.matchId}`;
      // Seed + epoch define the map; chunks stream as you explore (infinite XZ).
      world = new V.World(msg.world.w, msg.world.h, msg.world.d, msg.seed);
      if (msg.epoch) world.morph(msg.epoch);
      currentTheme = msg.theme || { id: world.theme?.id || 'neon', name: world.theme?.name || 'NEON DISTRICT' };
      nextMorphAt = msg.nextMorphAt || (Date.now() + (msg.constants?.morphMs || 120000));
      morphMs = msg.constants?.morphMs || 120000;
      applyThemeAtmosphere(currentTheme);
      lastMeshWx = NaN; lastMeshWz = NaN;
      buildWorldMesh();
      if (msg.powerups) syncPowerups(msg.powerups);
      if (msg.chaos) showChaosBanner(msg.chaos, false);
      document.getElementById('overlay-click').classList.remove('hidden');
      buildCompass();
      killStreak = 0;
      updateStreakHud();
      myHp = C.maxHp || 100;
      updateCombatGrade(myHp);
      updateMorphTimerHud();
      updateBuffHud();
      addFeedLine(`◈ SECTOR: ${currentTheme.name}`);
      if (msg.botArena) {
        addFeedLine(`◇ BOT ARENA — ${msg.botCount || 30} AI operators (mid→ace skill mix)`);
      } else {
        addFeedLine('◇ Climb walls · grab pods · survive CHAOS events');
      }
      break;
    }

    case 'morph': {
      // Server-authoritative full sector rewrite (new seed + epoch + theme)
      currentTheme = msg.theme || currentTheme;
      nextMorphAt = msg.nextMorphAt || (Date.now() + morphMs);
      if (world && typeof world.morph === 'function') {
        const newSeed = msg.seed != null ? (msg.seed | 0) : undefined;
        world.morph(msg.epoch | 0, newSeed);
      }
      startMorphFx(currentTheme);
      me.lowGravT = 0;
      clearPowerupMeshes();
      break;
    }

    case 'powerup': {
      if (msg.id === selfId) {
        const d = msg.duration || 12;
        if (msg.kind === 'lowGrav') me.lowGravT = Math.max(me.lowGravT || 0, d);
        if (msg.kind === 'haste') me.hasteT = Math.max(me.hasteT || 0, d);
        if (msg.kind === 'superJump') me.superJumpT = Math.max(me.superJumpT || 0, d);
        if (msg.kind === 'overcharge') me.overchargeT = Math.max(me.overchargeT || 0, d);
        if (msg.kind === 'armor') me.armorT = Math.max(me.armorT || 0, d);
        pulsePowerupPickup(msg.kind);
      }
      updateBuffHud();
      break;
    }

    case 'chaos': {
      if (msg.phase === 'start') showChaosBanner(msg, true);
      else hideChaosBanner();
      break;
    }

    case 'state': {
      snapshots.push({ t: performance.now(), players: msg.players });
      if (snapshots.length > 20) snapshots.shift();
      if (msg.self) reconcile(msg.self, msg.seq);
      if (msg.powerups) syncPowerups(msg.powerups);
      if (msg.chaos) showChaosBanner(msg.chaos, false);
      else if (!msg.chaos) hideChaosBanner(true);
      ammo = msg.ammo;
      // Do NOT snap currentWeapon from server state every tick — that races the
      // local setWeapon() and reverts 1/2/3/Q/E before the switch input is acked.
      // Client intent is authoritative; every input packet already sends weapon.
      reloadingMs = msg.reloading;
      updateHud(msg.players);
      for (const s of msg.shots || []) {
        if (s.id === selfId) continue;  // own tracer/report is spawned on fire
        spawnTracer(s.from, s.to, {
          path: s.path,
          hitPlayer: s.hitPlayer,
          block: s.block,
          weapon: s.weapon,
          speed: tracerSpeedFor(s.weapon),
          // Remote wall sparks on arrival; player hits show on their client
          noImpact: !!s.hitPlayer,
        });
        Audio.shoot({ x: s.from[0], y: s.from[1], z: s.from[2] });
      }
      updateDummies(msg.dummies);
      if (msg.reloading > 0 && reloadingWas === 0) {
        Audio.reload();
        startReloadAnim();
      }
      if (msg.reloading <= 0 && reloadingWas > 0) finishReloadAnim();
      reloadingWas = msg.reloading;
      if (msg.throwCd) {
        for (const id of Object.keys(msg.throwCd)) throwCdMs[id] = msg.throwCd[id] | 0;
        updateThrowableHud();
      }
      if (msg.explosions?.length) {
        for (const ex of msg.explosions) spawnExplosionFx(ex);
      }
      if (msg.blocks?.length) applyBlockChanges(msg.blocks);
      break;
    }

    case 'throw': {
      spawnThrownProjectile(msg);
      break;
    }

    case 'throwCooldown': {
      if (msg.id) throwCdMs[msg.id] = Math.max(0, (msg.readyAt || 0) - Date.now());
      updateThrowableHud();
      break;
    }

    case 'flashbang': {
      beginFlashbang(msg.strength || 1, msg.dur || 2.5);
      Audio.flashbang?.();
      break;
    }

    case 'pong':
      latency = Math.round(performance.now() - msg.t);
      document.getElementById('hud-net').textContent = `${latency} ms`;
      break;

    case 'kill':
      addKillFeed(msg.killer, msg.victim, msg.headshot, msg.weapon, msg.label || msg.zone);
      if (msg.killerId === selfId) {
        killStreak++;
        showKillCard(msg.victim, msg.headshot, msg.weapon, killStreak, msg.label || msg.zone);
        pulseCombatGrade('killflash');
        updateStreakHud();
        addShake(0.09 + Math.min(0.06, killStreak * 0.012), 2.8);
        renderFov = Math.min(renderFov + 2.5 + Math.min(3, killStreak * 0.4), baseFov() + 10);
      }
      if (msg.victimId === selfId) {
        killStreak = 0;
        updateStreakHud();
      } else if (msg.victimId) {
        triggerRemoteDeath(msg.victimId, msg.x, msg.y, msg.z, msg.yaw);
      }
      break;

    case 'balance':
      setBalance(msg.balance);
      if (msg.elo) { elo = msg.elo; document.getElementById('hud-elo').textContent = elo; }
      // Keep cash SFX for ledger events but no floating $ spam
      if (msg.delta > 0) Audio.cash(true);
      break;

    case 'hitmarker':
      // Wait for flight time so feedback lands with the streak (not on click)
      queueHitFeedback(msg);
      break;

    case 'hurt':
      myHp = msg.hp ?? myHp;
      flashDamage();
      showHitDirection(msg.dir);
      updateCombatGrade(myHp);
      addShake(0.085, 3.4);
      renderFov = Math.min(renderFov + 1.4, baseFov() + 7);
      Audio.hurt();
      break;

    case 'died':
      killStreak = 0;
      updateStreakHud();
      myHp = 0;
      updateCombatGrade(0);
      setBalance(msg.balance);
      if (msg.elo) { elo = msg.elo; document.getElementById('hud-elo').textContent = elo; }
      beginDeathSequence(msg);
      break;

    case 'broke':
      setBalance(msg.balance);
      document.getElementById('overlay-dead').classList.add('hidden');
      document.getElementById('broke-balance').textContent = fmt(msg.balance);
      document.getElementById('overlay-broke').classList.remove('hidden');
      if (document.pointerLockElement) document.exitPointerLock();
      break;

    case 'chat':
      addChatMessage(msg.from, msg.text, msg.pronouns);
      break;

    case 'feed':
      addFeedLine(msg.text);
      break;

    case 'error':
      addFeedLine(msg.message);
      break;
  }
}

// Snap to the authoritative state, then replay every input the server hasn't
// acknowledged yet. Without the replay the player would be yanked backwards by
// one round-trip's worth of movement on every single state frame.
function reconcile(auth, ackSeq) {
  const hadPosition = havePosition;
  const beforeX = me.x, beforeY = me.y, beforeZ = me.z;

  // While dead, freeze prediction at the death pose — don't scrub the corpse
  if (deathCam) {
    me.vx = 0; me.vz = 0; me.vy = 0;
    me.onGround = true;
    // Still ack inputs so queue doesn't explode
    while (pending.length && pending[0].seq <= ackSeq) pending.shift();
    return;
  }

  me.x = auth.x; me.y = auth.y; me.z = auth.z;
  me.vy = auth.vy; me.onGround = auth.onGround;
  if (auth.vx != null) me.vx = auth.vx;
  if (auth.vz != null) me.vz = auth.vz;
  if (auth.crouching !== undefined) me.crouching = !!auth.crouching;
  if (auth.lowGravT != null) me.lowGravT = Math.max(0, +auth.lowGravT || 0);
  if (auth.hasteT != null) me.hasteT = Math.max(0, +auth.hasteT || 0);
  if (auth.superJumpT != null) me.superJumpT = Math.max(0, +auth.superJumpT || 0);
  if (auth.overchargeT != null) me.overchargeT = Math.max(0, +auth.overchargeT || 0);
  if (auth.armorT != null) me.armorT = Math.max(0, +auth.armorT || 0);
  if (auth.eventGravMul != null) me.eventGravMul = +auth.eventGravMul || 1;
  if (auth.eventJumpMul != null) me.eventJumpMul = +auth.eventJumpMul || 1;
  if (auth.eventSpeedMul != null) me.eventSpeedMul = +auth.eventSpeedMul || 1;
  havePosition = true;

  while (pending.length && pending[0].seq <= ackSeq) pending.shift();
  for (const p of pending) V.step(world, me, p);

  // The correction lands on the simulation immediately, but the camera must not
  // teleport 30 times a second. Roll the difference into a visual offset that
  // decays over ~100ms, so a small mispredict reads as a gentle drift instead
  // of a snap. A large difference means a respawn or teleport — show that
  // instantly rather than sliding the player across the map.
  if (hadPosition) {
    const ex = beforeX - me.x, ey = beforeY - me.y, ez = beforeZ - me.z;
    lastMispredict = Math.hypot(ex, ey, ez);
    if (Math.hypot(ex, ey, ez) < 3) {
      smoothErr.x += ex; smoothErr.y += ey; smoothErr.z += ez;
    } else {
      smoothErr.x = smoothErr.y = smoothErr.z = 0;
      stepLift = 0;
    }
    const mag = Math.hypot(smoothErr.x, smoothErr.y, smoothErr.z);
    if (mag > 3) { smoothErr.x = smoothErr.y = smoothErr.z = 0; stepLift = 0; }
  }

  mePrev.x = me.x; mePrev.y = me.y; mePrev.z = me.z;
  lastStepAt = performance.now();
}

// ----------------------------------------------------------------- input ----

const KEYMAP = {
  KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b',
  KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r',
};

function inGame() { return !document.getElementById('screen-game').classList.contains('hidden'); }

window.addEventListener('keydown', (e) => {
  if (!inGame()) return;

  // While the chat box is open every keystroke belongs to it — otherwise
  // typing "was" would walk you off a ledge mid-sentence.
  if (chatOpen) {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { sendChat(); e.preventDefault(); }
    else if (e.code === 'Escape') { closeChat(); e.preventDefault(); }
    return;
  }

  if (e.code === 'KeyT' || e.code === 'Enter' || e.code === 'NumpadEnter') {
    openChat();
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyM') {
    const on = Audio.setEnabled(!Audio.isEnabled());
    try { localStorage.setItem('bounty.sound', on ? '1' : '0'); } catch {}
    addFeedLine(on ? 'Sound on' : 'Sound muted');
    return;
  }
  if (e.code === 'KeyV') {
    if (!Voice.active) { startVoice(); return; }
    const muted = Voice.setMicMuted(!Voice.micMuted);
    addFeedLine(muted ? 'Mic muted' : 'Mic live');
    updateVoiceHud();
    return;
  }
  if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = true; e.preventDefault(); }
  if (e.code === 'Space') { keys.jump = true; e.preventDefault(); }
  if (e.code === 'KeyR') keys.reload = true;
  // Crouch: Control or C. Sprint: Shift (hold).
  if (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyC') {
    keys.crouch = true; e.preventDefault();
  }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    keys.sprint = true; e.preventDefault();
  }
  // Throwables: 4–7 arm in hand; click fires/throws. 1–3 return to guns.
  if (e.code === 'Digit4' || e.code === 'Numpad4') { armEquipment('grenade'); e.preventDefault(); return; }
  if (e.code === 'Digit5' || e.code === 'Numpad5') { armEquipment('smoke'); e.preventDefault(); return; }
  if (e.code === 'Digit6' || e.code === 'Numpad6') { armEquipment('flash'); e.preventDefault(); return; }
  if (e.code === 'Digit7' || e.code === 'Numpad7') { armEquipment('rpg'); e.preventDefault(); return; }
  if (e.code === 'KeyG') { armEquipment('grenade'); e.preventDefault(); return; }
  // Weapon slots 1 / 2 / 3 — always force a gun view
  if (e.code === 'Digit1' || e.code === 'Numpad1') { setWeapon('rifle'); e.preventDefault(); return; }
  if (e.code === 'Digit2' || e.code === 'Numpad2') { setWeapon('smg'); e.preventDefault(); return; }
  if (e.code === 'Digit3' || e.code === 'Numpad3') { setWeapon('sniper'); e.preventDefault(); return; }
  // Q: cancel throwable if armed, otherwise previous gun. E: next gun.
  if (e.code === 'KeyQ') {
    if (armedEquip) disarmEquipment();
    else cycleWeapon(-1);
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyE') { cycleWeapon(1); e.preventDefault(); return; }
});
window.addEventListener('keyup', (e) => {
  if (chatOpen) return;
  if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = false; e.preventDefault(); }
  if (e.code === 'Space') keys.jump = false;
  if (e.code === 'KeyR') keys.reload = false;
  if (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyC') {
    keys.crouch = false;
  }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.sprint = false;
});

function setWeapon(id) {
  // Accept either full weapons map or fallback defaults
  const ok = (C.weapons && C.weapons[id]) || DEFAULT_WEAPONS[id];
  if (!ok) return;
  // Selecting a gun always leaves throwable mode
  armedEquip = null;
  if (trajLine) trajLine.visible = false;
  if (trajMarker) trajMarker.visible = false;
  currentWeapon = id;
  showViewWeapon(id);
  updateThrowableHud();
  // Drop ADS visual briefly on switch so the new gun reads hip-first.
  aiming = false;
  adsBlend = Math.min(adsBlend, 0.2);
  // Refresh strip / name immediately (don't wait for next state packet)
  const wEl = document.getElementById('weapon-name');
  if (wEl) {
    const def = weaponDef(id);
    wEl.textContent = def.name || id.toUpperCase();
    wEl.classList.toggle('sniper', id === 'sniper');
    wEl.classList.toggle('smg', id === 'smg');
    wEl.classList.toggle('rifle', id === 'rifle');
  }
  const strip = document.getElementById('weapon-strip');
  if (strip) {
    for (const btn of strip.querySelectorAll('[data-weapon]')) {
      btn.classList.toggle('active', btn.getAttribute('data-weapon') === id);
    }
  }
}

function cycleWeapon(dir) {
  // If holding a throwable, first Q/E/scroll returns to the current gun
  if (armedEquip) {
    disarmEquipment();
    return;
  }
  const list = (C.weaponKeys && C.weaponKeys.length)
    ? C.weaponKeys
    : Object.keys(C.weapons || DEFAULT_WEAPONS);
  let i = list.indexOf(currentWeapon);
  if (i < 0) i = 0;
  const next = list[(i + dir + list.length) % list.length];
  setWeapon(next);
}

// ---- voice -----------------------------------------------------------------

let voiceStarting = false;

async function startVoice() {
  if (voiceStarting || Voice.active) return;
  voiceStarting = true;
  const s = await Voice.start(Audio.context, sendBinary, updateVoiceHud);
  voiceStarting = false;
  updateVoiceHud();
  if (s === 'insecure') {
    addFeedLine('Voice needs HTTPS — open the https:// link, not the LAN address.');
  } else if (s === 'denied') {
    addFeedLine('Microphone blocked. Allow it in the address bar, then press V.');
  } else if (s === 'unsupported') {
    addFeedLine('Voice chat is not supported in this browser.');
  } else if (s === 'live') {
    addFeedLine('Voice chat on — nearby players can hear you. V to mute.');
  }
}

function updateVoiceHud() {
  const el = document.getElementById('voice-indicator');
  if (!el) return;
  const label = document.getElementById('voice-label');
  const on = Voice.active && !Voice.micMuted;
  el.classList.toggle('hidden', !Voice.active && Voice.status !== 'denied' && Voice.status !== 'insecure');
  el.classList.toggle('muted', Voice.active && Voice.micMuted);
  el.classList.toggle('talking', on && Voice.transmitting);
  if (!Voice.active) label.textContent = Voice.status === 'insecure' ? 'VOICE NEEDS HTTPS' : 'MIC BLOCKED';
  else label.textContent = Voice.micMuted ? 'MIC MUTED' : (Voice.transmitting ? 'TRANSMITTING' : 'MIC LIVE');
}

// Names of nearby players currently talking, so you know who you're hearing.
function updateVoiceSpeakers() {
  const el = document.getElementById('voice-speakers');
  if (!el) return;
  const ids = Voice.speakingIds();
  if (ids.length === 0) { el.innerHTML = ''; return; }
  const snap = snapshots[snapshots.length - 1];
  el.innerHTML = ids.map((id) => {
    const p = snap?.players.find((x) => x.id === id);
    return `<div class="vs">🔊 ${esc(p ? p.u : 'nearby player')}</div>`;
  }).join('');
}

// ---- chat ------------------------------------------------------------------

let chatOpen = false;
const chatInput = document.getElementById('chat-input');
const chatLog = document.getElementById('chat-log');

function openChat() {
  if (chatOpen) return;
  chatOpen = true;
  // Release every held key, or you keep sprinting while you type.
  for (const k of Object.keys(keys)) keys[k] = false;
  firing = false;
  aiming = false;
  chatInput.classList.remove('hidden');
  chatInput.value = '';
  chatInput.focus();
  unfadeChat();
}

function closeChat() {
  if (!chatOpen) return;
  chatOpen = false;
  chatInput.blur();
  chatInput.classList.add('hidden');
  fadeChatSoon();
}

function sendChat() {
  const text = chatInput.value.trim();
  if (text) send({ type: 'chat', text: text.slice(0, 120) });
  closeChat();
}

let chatFadeTimer = null;
function unfadeChat() {
  clearTimeout(chatFadeTimer);
  for (const el of chatLog.children) el.classList.remove('faded');
}
function fadeChatSoon() {
  clearTimeout(chatFadeTimer);
  chatFadeTimer = setTimeout(() => {
    for (const el of chatLog.children) el.classList.add('faded');
  }, 8000);
}

function addChatMessage(from, text, pronouns) {
  const el = document.createElement('div');
  el.className = 'cm' + (from === myName ? ' me' : '');
  const pr = pronouns ? `<span class="pr">(${esc(pronouns)})</span> ` : '';
  el.innerHTML = `<b>${esc(from)}</b> ${pr}${esc(text)}`;
  chatLog.appendChild(el);
  while (chatLog.children.length > 8) chatLog.firstChild.remove();
  unfadeChat();
  if (!chatOpen) fadeChatSoon();
}
window.addEventListener('blur', () => {
  for (const k of Object.keys(keys)) keys[k] = false;
  firing = false;
  aiming = false;
});

// The click-to-play prompt is a full-screen overlay, so it sits on top of the
// canvas and would swallow the very click meant to dismiss it. Listen on the
// whole game screen instead, and skip clicks on actual controls.
document.getElementById('screen-game').addEventListener('click', (e) => {
  if (!inGame()) return;
  // Browsers keep audio suspended until a real gesture — this is that gesture,
  // and it's also where the microphone permission prompt belongs.
  Audio.unlock();
  if (settings.music !== false) Audio.startMusic?.();
  startVoice();
  if (e.target.closest('button') || e.target.closest('.chat')) return;
  if (chatOpen) { closeChat(); return; }
  if (!document.getElementById('overlay-broke').classList.contains('hidden')) return;
  if (document.pointerLockElement) return;
  canvas.requestPointerLock();
});

// Some environments refuse pointer lock outright — embedded webviews, and
// iframes without allow="pointer-lock". Without a fallback the player is
// trapped at the click-to-play prompt with no way into the game, so drop to
// free-look (raw cursor deltas) instead of failing closed.
let lookFallback = false;
let lastMouse = null;

document.addEventListener('pointerlockerror', () => {
  if (lookFallback || !inGame()) return;
  lookFallback = true;
  document.getElementById('overlay-click').classList.add('hidden');
  addFeedLine('Mouse lock blocked here — using free-look. Open the game in a normal browser tab for proper FPS aiming.');
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (locked) lookFallback = false;
  const prompt = document.getElementById('overlay-click');
  const dead = !document.getElementById('overlay-dead').classList.contains('hidden');
  const broke = !document.getElementById('overlay-broke').classList.contains('hidden');
  if (inGame() && !locked && !lookFallback && !dead && !broke) prompt.classList.remove('hidden');
  else prompt.classList.add('hidden');
  if (!locked) { firing = false; aiming = false; }
});

const SENS = 0.0022;
function lookSens() {
  // ADS slows the mouse so fine aim is possible; sniper scopes slow more.
  const def = weaponDef();
  const user = settings.sens || 1;
  return SENS * user * (1 - adsBlend * (1 - (def.adsSens ?? 0.6)));
}
document.addEventListener('mousemove', (e) => {
  const sens = lookSens();
  if (document.pointerLockElement === canvas) {
    yaw -= e.movementX * sens;
    pitch -= e.movementY * sens;
    pitch = Math.max(-1.54, Math.min(1.54, pitch));
    lastMouse = null;
    return;
  }
  if (!lookFallback || !inGame()) return;
  if (lastMouse) {
    yaw -= (e.clientX - lastMouse.x) * sens;
    pitch -= (e.clientY - lastMouse.y) * sens;
    pitch = Math.max(-1.54, Math.min(1.54, pitch));
  }
  lastMouse = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener('mousedown', (e) => {
  if (chatOpen) return;
  if (!(document.pointerLockElement === canvas || lookFallback)) return;
  if (e.button === 0) { firing = true; e.preventDefault(); }
  // RMB toggles ADS (click once to aim, click again to hip)
  if (e.button === 2) { aiming = !aiming; e.preventDefault(); }
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) firing = false;
  // ADS is toggle — do not clear on release
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  if (!inGame() || chatOpen) return;
  cycleWeapon(e.deltaY > 0 ? 1 : -1);
  e.preventDefault();
}, { passive: false });

document.getElementById('btn-leave').onclick = leave;
document.getElementById('throwable-strip')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-throw]');
  if (!btn) return;
  armEquipment(btn.getAttribute('data-throw'));
  e.preventDefault();
});
document.getElementById('weapon-strip')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-weapon]');
  if (!btn) return;
  setWeapon(btn.getAttribute('data-weapon'));
  e.preventDefault();
});

// ------------------------------------------------------------------ loop ----

// Viewmodel kick (0..1-ish), spring-smoothed. Camera aim kick is separate.
let recoil = 0, recoilVel = 0;
let aimKickP = 0, aimKickY = 0;     // recovered additive look offset
let aimKickPV = 0, aimKickYV = 0;  // velocities for spring
let breathPhase = 0;
let bobPhase = 0, lastFireLocal = 0, voiceHudAcc = 0;
// Smooth walk bob (position + head tilt) so it doesn't chatter with physics steps
let bobSmoothX = 0, bobSmoothY = 0, bobSmoothP = 0, bobSmoothR = 0;

/** How much spring kick folds into real aim (camera + bullets + server input). */
function getAimKickMul() {
  return 0.7 + adsBlend * 0.25; // hip ~0.7, ADS ~0.95
}

/**
 * Authoritative look for this frame: base mouse + recoil spring.
 * Camera, tracers, and server fire input all use this so they stay aligned.
 */
function getAimAngles() {
  const km = getAimKickMul();
  return {
    yaw: yaw + aimKickY * km,
    pitch: Math.max(-1.54, Math.min(1.54, pitch + aimKickP * km)),
    kickMul: km,
  };
}

// Simulation and rendering run on separate clocks on purpose. Driving inputs
// from requestAnimationFrame would tie the player's ability to act to their
// frame rate — and rAF stops entirely when a tab is backgrounded, which would
// silently freeze a live player who is still standing in the arena worth $3.
function stepInput() {
  if (!running || !world || !havePosition) return;
  // Dead / spectating: no prediction, no fire
  if (deathCam) {
    lastStepTime = performance.now();
    return;
  }
  const now = performance.now();
  let dt = (now - lastStepTime) / 1000;
  lastStepTime = now;
  if (dt > 0.25) dt = 0.25;

  // Fixed-timestep prediction. The server applies these exact same steps, so
  // running them at a fixed rate is what makes reconciliation exact rather
  // than approximate.
  accumulator += dt;
  let steps = 0;
  while (accumulator >= V.PHYS.STEP && steps < 8) {
    accumulator -= V.PHYS.STEP;
    steps++;
    mePrev.x = me.x; mePrev.y = me.y; mePrev.z = me.z;
    const wasGround = me.onGround;
    const vyBefore = me.vy;

    // Sprint is hold-to-run: only while Shift is down, moving forward, not
    // crouched, and not ADS. The physics module re-enforces the same rules.
    const sprinting = keys.sprint && keys.f && !keys.crouch && !aiming;

    // Apply gun recoil BEFORE building this tick's aim so the fire packet,
    // tracer, and camera all share the same post-recoil direction.
    let localShot = false;
    if (firing && !armedEquip && !deathCam) {
      localShot = applyShotRecoil(now);
    }

    const aim = getAimAngles();
    const input = {
      seq: ++inputSeq,
      f: keys.f, b: keys.b, l: keys.l, r: keys.r,
      jump: keys.jump,
      crouch: keys.crouch,
      sprint: sprinting,
      aim: aiming,
      fire: firing && !armedEquip,
      reload: keys.reload,
      weapon: currentWeapon,
      yaw: aim.yaw,
      pitch: aim.pitch,
    };
    V.step(world, me, input);
    lastStepAt = performance.now();

    // Footsteps are distance-based rather than time-based, so the cadence
    // matches how far you actually moved (strafing, wall-sliding and stepping
    // all stay in sync instead of drifting against a timer).
    if (me.onGround) {
      strideDist += Math.hypot(me.x - mePrev.x, me.z - mePrev.z);
      if (strideDist >= STRIDE) {
        strideDist = 0;
        Audio.footstep(blockUnder(me.x, me.y, me.z));
      }
    } else {
      strideDist = STRIDE * 0.72;   // land already mid-stride so the next step isn't late
    }
    if (!wasGround && me.onGround && vyBefore < -6) {
      Audio.land(blockUnder(me.x, me.y, me.z), Math.min(1, -vyBefore / 18));
    }

    // Climbing a block teleports the body +1m in one physics tick. Keep the
    // camera continuous by: (1) lifting mePrev so frame interp doesn't re-add
    // the jump, (2) parking the delta in stepLift and easing it out over time.
    if (me.steppedUp) {
      stepLift -= me.steppedUp;
      mePrev.y += me.steppedUp;
    }

    pending.push(input);
    if (pending.length > 160) pending.shift();
    send({ type: 'input', ...input });

    if (localShot) {
      fireTracerLocal(aim.yaw, aim.pitch);
    } else if (firing && armedEquip) {
      // One-shot arm: throw/fire then release so we don't spam
      fireArmedEquipment(now);
      firing = false;
    }
  }
}

let fpsFrames = 0, fpsLast = performance.now(), fpsValue = 0;

function frame() {
  rafId = requestAnimationFrame(frame);
  const now = performance.now();
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  // Clamp huge spikes (tab backgrounded) without inventing motion.
  if (dt > 0.05) dt = 0.05;

  updateDeathCam(dt);
  updateCamera(dt);
  updateMorphFx(dt);
  maybeStreamChunks();
  updateMorphTimerHud();
  updateLocalProjectiles(dt);
  updateSmokeClouds(dt);
  updateFlashbang(dt);
  updateThrowTrajectory();
  Audio.tickMusic?.(dt);
  // Local throwable cooldown countdown between state frames
  for (const id of (C.throwableKeys || [])) {
    if (throwCdMs[id] > 0) throwCdMs[id] = Math.max(0, throwCdMs[id] - dt * 1000);
  }
  if (Math.floor(performance.now() / 200) !== Math.floor((performance.now() - dt * 1000) / 200)) {
    updateThrowableHud();
  }
  // Keep sky dome glued to camera so infinite terrain has no hard horizon wall
  if (skyMesh && camera) skyMesh.position.copy(camera.position);
  updateDayNight(dt);
  // Living biomes + material pulse
  if (worldMat?.userData?.shader) {
    worldMat.userData.shader.uniforms.uTime.value = performance.now() * 0.001;
    if (themeSkyBase?.life != null) {
      worldMat.userData.shader.uniforms.uLife.value = themeSkyBase.life;
    }
  }
  if (biomeLife && world && me) {
    biomeLife.particlesEnabled = settings.particles !== false;
    biomeLife.update(dt, world, me.x, me.y, me.z);
  }
  updateCompass();
  updateRemotes(dt);
  updateTracers(dt);
  updateHitFeedback();
  updateImpactFlashes(dt);
  updatePowerupMeshes(dt);
  tickBuffFx(dt);
  updateClimbHud();
  if (settings.particles !== false) updateParticles(dt);
  if (!deathCam) {
    updateMuzzle(dt);
    updateViewModel(dt);
  } else if (viewHolder) {
    viewHolder.visible = false;
  }
  // Local countdown so the reload bar is smooth between 30Hz state frames.
  if (reloadingMs > 0) {
    reloadingMs = Math.max(0, reloadingMs - dt * 1000);
    const def = weaponDef();
    const bar = document.getElementById('reload-bar');
    const hint = document.getElementById('reload-hint');
    if (bar && def.reload) {
      const pct = Math.max(0, Math.min(1, 1 - reloadingMs / (def.reload * 1000)));
      bar.style.setProperty('--reload-pct', `${(pct * 100).toFixed(1)}%`);
      bar.classList.toggle('hidden', reloadingMs <= 0);
    }
    if (hint) hint.classList.toggle('hidden', reloadingMs <= 0);
  }

  voiceHudAcc += dt;
  if (voiceHudAcc > 0.12) {
    voiceHudAcc = 0;
    Voice.prune();
    updateVoiceHud();
    updateVoiceSpeakers();
  }

  if (settings.showFps) {
    fpsFrames++;
    if (now - fpsLast >= 500) {
      fpsValue = Math.round((fpsFrames * 1000) / (now - fpsLast));
      fpsFrames = 0;
      fpsLast = now;
      const el = document.getElementById('hud-fps');
      if (el) el.textContent = `${fpsValue} FPS`;
    }
  }

  if (renderer) renderer.render(scene, camera);
}

function updateCamera(dt) {
  // Death sequence owns the camera (fall / killer POV)
  if (deathCam && applyDeathCamera(dt)) return;

  // Interpolate between the last two physics states using real elapsed time.
  // Sampling the raw position instead leaves the camera frozen on any frame
  // that falls between steps — the render and physics clocks are independent,
  // so that happens constantly and reads as stutter.
  const alpha = Math.max(0, Math.min(1, (performance.now() - lastStepAt) / (V.PHYS.STEP * 1000)));
  // Smoothstep alpha — slightly softer than linear between physics ticks.
  const a = alpha * alpha * (3 - 2 * alpha);
  const px = mePrev.x + (me.x - mePrev.x) * a;
  const py = mePrev.y + (me.y - mePrev.y) * a;
  const pz = mePrev.z + (me.z - mePrev.z) * a;

  // Decay the visual offset toward zero, frame-rate independently.
  const k = Math.exp(-dt * 14);
  smoothErr.x *= k; smoothErr.y *= k; smoothErr.z *= k;
  if (Math.abs(smoothErr.x) < 1e-4) smoothErr.x = 0;
  if (Math.abs(smoothErr.y) < 1e-4) smoothErr.y = 0;
  if (Math.abs(smoothErr.z) < 1e-4) smoothErr.z = 0;

  // Step-up lift: slower ease (~180ms to settle a full block) so climbing a
  // ledge feels like a step, not a teleport. Critically damped-ish exp.
  if (stepLift !== 0) {
    stepLift *= Math.exp(-dt * 7.5);
    if (Math.abs(stepLift) < 0.0005) stepLift = 0;
  }

  // Soft camera shake (fire/hit) — lower frequency, damped so it's not jitter
  shake = Math.max(0, shake - dt * shakeDecay);
  shakePhase += dt * 22;
  const s = shake * shake * 0.65;

  // ---- Recoil spring — gentle recover (especially ADS) so kick isn't snappy ----
  const rk = aiming ? 14 : 48;
  const rd = aiming ? 7 : 13;
  aimKickPV += (-rk * aimKickP - rd * aimKickPV) * dt;
  aimKickYV += (-rk * aimKickY - rd * aimKickYV) * dt;
  aimKickP += aimKickPV * dt;
  aimKickY += aimKickYV * dt;
  if (Math.abs(aimKickP) < 1e-5 && Math.abs(aimKickPV) < 1e-5) { aimKickP = 0; aimKickPV = 0; }
  if (Math.abs(aimKickY) < 1e-5 && Math.abs(aimKickYV) < 1e-5) { aimKickY = 0; aimKickYV = 0; }

  // ---- Breathing / idle sway (human presence) ----
  const horizSpd = Math.hypot(me.vx || 0, me.vz || 0);
  // Use real velocity so sliding/strafe still bobs; keys alone miss some motion
  const moving = me.onGround && horizSpd > 0.45;
  const sprinting = keys.sprint && keys.f && !keys.crouch && !aiming && me.onGround && horizSpd > 1.5;
  // Breath slows and softens when ADS; almost vanishes while sprinting
  const breathRate = aiming ? 1.05 : (moving ? 1.6 : 1.25);
  const breathAmt = (aiming ? 0.0011 : 0.0024) * (sprinting ? 0.15 : (moving ? 0.45 : 1));
  breathPhase += dt * breathRate * Math.PI * 2 * 0.22;
  const breathP = Math.sin(breathPhase) * breathAmt;
  const breathY = Math.cos(breathPhase * 0.73) * breathAmt * 0.55;
  const breathZ = Math.sin(breathPhase * 0.5) * breathAmt * 0.35; // roll
  const breathBob = Math.sin(breathPhase) * (aiming ? 0.004 : 0.009) * (sprinting ? 0.2 : 1);

  // Eye height eases on crouch so the camera dips instead of teleporting.
  const eyeTarget = V.eyeOf(me);
  eyeSmooth += (eyeTarget - eyeSmooth) * Math.min(1, dt * 12);

  // ---- Walk bob: left → right → left (human gait) ---------------------------
  // bobPhase: 0 → 2π = one full cycle = LEFT foot + RIGHT foot.
  //   • Lateral  sin(φ)     → body shifts L then R once per cycle
  //   • Vertical (1-cos2φ)/2 → dips on each footfall (twice per cycle)
  //   • Roll     sin(φ)     → shoulders lean over the stance foot
  //   • Pitch    -sin(2φ)   → slight nod down at each plant
  //
  // Cadence from distance: ~1.7m per full L+R cycle at walk (slow, deliberate).
  const cycleDist = sprinting ? 2.35 : me.crouching ? 1.55 : 2.05; // blocks per L+R
  if (moving) {
    bobPhase += (horizSpd * dt / cycleDist) * Math.PI * 2;
  } else {
    const settle = Math.exp(-dt * 6.5);
    bobSmoothX *= settle;
    bobSmoothY *= settle;
    bobSmoothP *= settle;
    bobSmoothR *= settle;
  }

  const bobAmt = Math.max(0.06, 1 - adsBlend * 0.92);
  const crouchMul = me.crouching ? 0.55 : 1;
  // Ramp in with speed so first steps aren’t a sudden jolt
  const spd01 = Math.min(1, Math.max(0, (horizSpd - 0.45) / (V.PHYS.SPEED * 0.85)));
  const amp = bobAmt * crouchMul * (0.2 + 0.8 * spd01);

  // Pure sines — no abs()/pow corners that read as jitter
  const s1 = Math.sin(bobPhase);       // once per L+R (lateral / roll)
  const c2 = Math.cos(bobPhase * 2);   // twice per cycle (per foot)
  const s2 = Math.sin(bobPhase * 2);

  // Vertical: low at foot plant, rise between steps. Walk needs readable up/down.
  // Sprint: a bit taller bounce, not faster-looking chaos.
  const yAmp = (sprinting ? 0.078 : 0.068) * amp;
  const bobTY = (1 - c2) * 0.5 * yAmp;

  // Lateral: clear left / right weight shift (this is the “foot reflects upper body”)
  const xAmp = (sprinting ? 0.038 : 0.042) * amp;
  const bobTX = s1 * xAmp;

  // Head follows the same phase: nod on plant, roll over stance leg
  const bobTP = -s2 * (sprinting ? 0.007 : 0.009) * amp;
  const bobTR = s1 * (sprinting ? 0.008 : 0.011) * amp;

  // Heavy low-pass (~4–5 Hz) so motion is fluid, not snappy
  const blend = 1 - Math.exp(-dt * 7);
  if (moving) {
    bobSmoothX += (bobTX - bobSmoothX) * blend;
    bobSmoothY += (bobTY - bobSmoothY) * blend;
    bobSmoothP += (bobTP - bobSmoothP) * blend;
    bobSmoothR += (bobTR - bobSmoothR) * blend;
  }

  camera.position.set(
    px + smoothErr.x + bobSmoothX,
    py + smoothErr.y + stepLift + eyeSmooth + breathBob + bobSmoothY,
    pz + smoothErr.z
  );

  // ADS FOV zoom — RPG has its own tube-sight zoom; lobbed nades don't ADS-zoom
  const def = weaponDef();
  const swayMul = Math.max(0, 1 - adsBlend * 0.9);
  const breathMul = Math.max(0.02, 1 - adsBlend * 0.95);
  // Bob pitch/roll are visual-only (not in getAimAngles / hitreg)
  const aim = getAimAngles();
  camera.rotation.set(
    aim.pitch + breathP * breathMul + bobSmoothP + Math.sin(shakePhase * 1.4) * s * 0.35 * swayMul,
    aim.yaw + breathY * breathMul + Math.cos(shakePhase * 1.8) * s * 0.35 * swayMul,
    breathZ * breathMul + bobSmoothR + Math.sin(shakePhase * 2.2) * s * 0.15 * swayMul
  );

  const adsTarget = aiming && armedEquip !== 'grenade' && armedEquip !== 'smoke' && armedEquip !== 'flash' ? 1 : 0;
  adsBlend += (adsTarget - adsBlend) * Math.min(1, dt * (armedEquip === 'rpg' ? 8 : 10));
  if (Math.abs(adsBlend - adsTarget) < 0.001) adsBlend = adsTarget;
  let adsFov = def.adsFov;
  if (armedEquip === 'rpg') adsFov = 38; // unique tube optic FOV
  const targetFov = baseFov() + (adsFov - baseFov()) * adsBlend;
  renderFov += (targetFov - renderFov) * Math.min(1, dt * 11);
  if (camera && Math.abs(camera.fov - renderFov) > 0.02) {
    camera.fov = renderFov;
    camera.updateProjectionMatrix();
  }

  Audio.setListener(camera.position, V.lookDir(aim.yaw, aim.pitch), { x: 0, y: 1, z: 0 });

  updateAdsHud();
}

function startReloadAnim() {
  reloadAnimActive = true;
  reloadAnim = 0;
  // Drop ADS so the reload plays in view (especially sniper scope blackout)
  aiming = false;
}

function finishReloadAnim() {
  reloadAnimActive = false;
  reloadAnim = 0;
}

// Phased reload pose from progress t ∈ [0,1].
// 0.00–0.18 lower & roll out
// 0.18–0.42 mag drop (down / yaw)
// 0.42–0.72 mag seat
// 0.72–0.90 bolt rack
// 0.90–1.00 settle
function reloadPose(t) {
  t = Math.max(0, Math.min(1, t));
  const ease = (a, b, u) => a + (b - a) * u;
  const smoothstep = (u) => u * u * (3 - 2 * u);

  let x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0;

  if (t < 0.18) {
    const u = smoothstep(t / 0.18);
    y = ease(0, -0.08, u);
    z = ease(0, 0.06, u);
    rx = ease(0, 0.55, u);
    rz = ease(0, 0.35, u);
    ry = ease(0, -0.12, u);
  } else if (t < 0.42) {
    const u = smoothstep((t - 0.18) / 0.24);
    y = ease(-0.08, -0.22, u);
    x = ease(0, 0.06, u);
    z = 0.06;
    rx = ease(0.55, 0.85, u);
    rz = ease(0.35, 0.55, u);
    ry = ease(-0.12, -0.25, u);
  } else if (t < 0.72) {
    const u = smoothstep((t - 0.42) / 0.30);
    y = ease(-0.22, -0.06, u);
    x = ease(0.06, 0.02, u);
    z = ease(0.06, 0.04, u);
    rx = ease(0.85, 0.4, u);
    rz = ease(0.55, 0.2, u);
    ry = ease(-0.25, -0.08, u);
  } else if (t < 0.90) {
    // bolt rack: sharp pull-back then return
    const u = (t - 0.72) / 0.18;
    const rack = u < 0.45 ? smoothstep(u / 0.45) : smoothstep(1 - (u - 0.45) / 0.55);
    y = -0.06;
    z = 0.04 + rack * 0.1;
    rx = 0.4 - rack * 0.25;
    rz = 0.2;
    ry = -0.08 + rack * 0.06;
    x = 0.02;
  } else {
    const u = smoothstep((t - 0.90) / 0.10);
    y = ease(-0.06, 0, u);
    x = ease(0.02, 0, u);
    z = ease(0.04, 0, u);
    rx = ease(0.4, 0, u);
    rz = ease(0.2, 0, u);
    ry = ease(-0.08, 0, u);
  }

  // Sniper is longer — exaggerate the dip so the bolt read is clear
  if (currentWeapon === 'sniper') {
    y *= 1.15; rx *= 1.1; z *= 1.2;
  }
  // SMG: quicker, tighter motion
  if (currentWeapon === 'smg') {
    y *= 0.85; rx *= 0.9; z *= 0.9;
  }

  return { x, y, z, rx, ry, rz };
}

function updateViewModel(dt) {
  if (!viewHolder) return;
  // Spring the viewmodel kick (heavier sniper, light SMG)
  const def = weaponDef();
  const targetRecoil = 0;
  const stiff = armedEquip === 'rpg' ? 22 : def.scope ? 28 : 40;
  const damp = armedEquip === 'rpg' ? 8 : def.scope ? 9 : 12;
  recoilVel += ((targetRecoil - recoil) * stiff - recoilVel * damp) * dt;
  recoil += recoilVel * dt;
  if (recoil < 0) { recoil = 0; recoilVel = 0; }

  switchKick = Math.max(0, switchKick - dt * 4.2);
  const bobAmt = 1 - adsBlend * 0.88;

  // Drive reload anim from remaining time so it stays in sync with the bar
  let relPose = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
  if (!armedEquip && reloadingMs > 0 && def.reload > 0) {
    reloadAnimActive = true;
    reloadAnim = Math.max(0, Math.min(1, 1 - reloadingMs / (def.reload * 1000)));
    relPose = reloadPose(reloadAnim);
  } else if (reloadAnimActive && !armedEquip) {
    // brief settle if server finished
    reloadAnim = Math.min(1, reloadAnim + dt * 4);
    if (reloadAnim >= 1) finishReloadAnim();
    else relPose = reloadPose(reloadAnim);
  }

  // Lerp hip → ADS. Iron-sight guns stay visible; you look through the peep.
  const adsVis = (reloadAnimActive || isLobThrowable(armedEquip)) ? 0 : adsBlend;
  let baseX = viewBase.x, baseY = viewBase.y, baseZ = viewBase.z;
  // ADS: sight line (model y=0) on camera center — gun body hangs below
  let adsX = viewAdsBase.x, adsY = viewAdsBase.y, adsZ = viewAdsBase.z;
  if (armedEquip === 'rpg') {
    baseX = 0.22; baseY = -0.2; baseZ = -0.62;
    adsX = 0.0; adsY = -0.06; adsZ = -0.36;
  } else if (isLobThrowable(armedEquip)) {
    baseX = 0.32; baseY = -0.28; baseZ = -0.55;
    adsX = 0.18; adsY = -0.2; adsZ = -0.48;
  } else if (def.scope) {
    // Sniper: mesh hides for HUD; keep parallel pull-in
    adsX = 0.0; adsY = 0.0; adsZ = -0.42;
  } else if (currentWeapon === 'smg') {
    // Hold further out so body never intersects near plane
    adsX = 0.0; adsY = 0.0; adsZ = -0.42;
  } else {
    // Rifle: tip still on center, whole gun stays in front of camera
    adsX = 0.0; adsY = 0.0; adsZ = -0.48;
  }
  const ax = baseX + (adsX - baseX) * adsVis;
  const ay = baseY + (adsY - baseY) * adsVis;
  const az = baseZ + (adsZ - baseZ) * adsVis;
  const stepDip = Math.min(0.04, Math.abs(stepLift) * 0.03);
  const swapDip = switchKick * 0.08;
  const swapBack = switchKick * 0.05;
  // Weapon tracks the same L/R gait so upper body reads with the feet
  const gBreath = Math.sin(breathPhase) * 0.006 * (1 - adsBlend * 0.92) * (reloadAnimActive ? 0.25 : 1);
  const bobMul = reloadAnimActive ? 0.08 : (1 - adsVis * 0.94) * 0.9;
  const hip = 1 - adsVis;

  viewHolder.position.set(
    ax + bobSmoothX * 1.05 * bobMul + gBreath * 0.4 + relPose.x * hip,
    ay + bobSmoothY * 1.1 * bobMul - recoil * (0.04 * hip + 0.008 * adsVis) - stepDip - swapDip + gBreath + relPose.y * hip,
    az + recoil * (0.08 * hip + 0.018 * adsVis) + swapBack + relPose.z * hip
  );
  viewHolder.rotation.x =
    (recoil * 0.28 + switchKick * 0.12 + aimKickP * 0.18 + relPose.rx) * hip
    + recoil * 0.04 * adsVis
    + bobSmoothP * 0.5 * bobMul;
  viewHolder.rotation.y =
    0.05 * hip + aimKickY * 0.1 * hip + relPose.ry * hip
    + bobSmoothX * 0.15 * bobMul; // slight yaw with lateral weight shift
  viewHolder.rotation.z =
    (switchKick * 0.07 + Math.sin(breathPhase * 0.7) * 0.008 + relPose.rz) * hip
    + bobSmoothR * 0.65 * bobMul;

  // Hide stock/grip/mag under ADS so they can't clip into the camera
  const hideRear = adsVis > 0.45 && !reloadAnimActive;
  const activeGun = viewModels[armedEquip || currentWeapon];
  if (activeGun) {
    activeGun.traverse((o) => {
      if (o.userData && o.userData.adsHide) o.visible = !hideRear;
    });
  }

  // Keep iron-sight guns visible. Only sniper scope / RPG tube swap to 2D HUD.
  const hideGunForAim =
    !reloadAnimActive && (
      (def.scope && adsBlend > 0.72) ||
      (armedEquip === 'rpg' && adsBlend > 0.55)
    );
  viewHolder.visible = !hideGunForAim;
}

function updateAdsHud() {
  const def = weaponDef();
  // Scope blackout ONLY when sniper/RPG is fully ADS — never leave this on hip/rifle.
  const sniperScoped = !armedEquip && !!def.scope && aiming && adsBlend > 0.72;
  const rpgScoped = armedEquip === 'rpg' && aiming && adsBlend > 0.58;
  const ironAds = !armedEquip && !def.scope && adsBlend > 0.55;
  const scoped = sniperScoped || rpgScoped;
  const cross = document.getElementById('crosshair');
  const scope = document.getElementById('scope-overlay');
  if (cross) {
    const hideCross = scoped || isLobThrowable(armedEquip) || ironAds;
    cross.classList.toggle('ads', adsBlend > 0.35 && !def.scope && !armedEquip && !ironAds);
    cross.classList.toggle('hidden', hideCross);
    cross.classList.toggle('smg', currentWeapon === 'smg' && !armedEquip);
    cross.classList.toggle('rifle', currentWeapon === 'rifle' && !armedEquip);
    // Dynamic gap: hip fire + movement open the reticle; ADS pinches it.
    const moving = (keys.f || keys.b || keys.l || keys.r) && me.onGround;
    const sprinting = keys.sprint && keys.f && !keys.crouch && !aiming;
    let gap = 10;
    if (currentWeapon === 'smg') gap = 14;
    if (currentWeapon === 'sniper') gap = 18;
    if (armedEquip === 'rpg') gap = 6;
    if (moving) gap += sprinting ? 10 : 5;
    if (me.crouching) gap *= 0.75;
    gap *= 1 - adsBlend * 0.85;
    gap = Math.max(4, Math.min(28, gap));
    cross.style.width = `${gap * 2}px`;
    cross.style.height = `${gap * 2}px`;
  }
  if (scope) {
    // Force clear the dark radial “hole” whenever we’re not truly scoped
    if (!scoped) {
      scope.classList.add('hidden');
      scope.classList.remove('rpg', 'sniper');
    } else {
      scope.classList.remove('hidden');
      scope.classList.toggle('rpg', rpgScoped);
      scope.classList.toggle('sniper', sniperScoped);
    }
  }
}

// ---- unified fire: recoil → aim → server input → tracer (same direction) ----

/** Returns true if a shot was consumed this call (rate / ammo ok). */
function applyShotRecoil(now) {
  if (reloadingMs > 0 || ammo <= 0) return false;
  const def = weaponDef();
  if (now - lastFireLocal < def.fireCooldown * 1000) return false;
  lastFireLocal = now;

  const adsMul = 0.9 + adsBlend * 0.2;
  const baseKick = def.scope ? 0.55 : (currentWeapon === 'smg' ? 0.38 : 0.62);
  const kick = baseKick * adsMul;
  recoilVel += kick * 7;
  recoil = Math.min(1.1, recoil + kick * 0.28);

  const pitchKick = (def.recoilPitch || 0.012) * (def.scope ? 0.9 : 1.0) * adsMul;
  // Instant kick so THIS shot's aim (and tracer) already includes recoil
  aimKickP += pitchKick * 0.55;
  aimKickY += (Math.random() - 0.5) * pitchKick * 0.25;
  aimKickPV += pitchKick * 18;
  aimKickYV += (Math.random() - 0.5) * pitchKick * 8;
  pitch = Math.min(1.54, pitch + pitchKick * (def.scope ? 0.22 : 0.28));

  muzzleLife = 1;
  if (muzzle) muzzle.material.color.setHex(MUZZLE_TINT[currentWeapon] || MUZZLE_TINT.rifle);
  spawnShellCasing();
  addShake(
    (def.scope ? 0.028 : currentWeapon === 'smg' ? 0.014 : 0.024) * adsMul,
    def.scope ? 2.8 : 3.8
  );
  Audio.shoot();
  renderFov = Math.min(
    renderFov + (def.scope ? 0.9 : currentWeapon === 'smg' ? 0.4 : 0.65),
    baseFov() + 5
  );
  return true;
}

/**
 * Client bullet = same yaw/pitch + ballistic cast the server uses for hitreg.
 * Streak follows that curve at bulletSpeed; impacts wait for arrival.
 * (Muzzle offset was shifting the path so the line could "miss" a true hit.)
 */
function fireTracerLocal(aimYaw, aimPitch) {
  if (!world || !me) return;
  const def = weaponDef();
  const rawDir = V.lookDir(aimYaw, aimPitch);
  const spread = aiming ? def.adsSpread : def.hipSpread;
  const dir = V.applySpread(rawDir, spread, selfId || 0, inputSeq);
  const ox = me.x, oy = me.y + V.eyeOf(me), oz = me.z;
  const speed = def.bulletSpeed || 320;
  const drop = def.bulletDrop == null ? 5.5 : def.bulletDrop;
  const cast = V.ballisticCast(world, ox, oy, oz, dir, def.range, speed, drop);

  let bestDist = cast.dist;
  let impact = [cast.x, cast.y, cast.z];
  let hitPlayer = false;
  const hw = V.PHYS.WIDTH / 2;

  for (const [, av] of remote) {
    if (!av.group.visible) continue;
    const p = av.group.position;
    const ph = av.crouching ? V.PHYS.CROUCH_HEIGHT : V.PHYS.HEIGHT;
    const hit = V.ballisticHitAABB(
      cast.path, p.x - hw, p.y, p.z - hw, p.x + hw, p.y + ph, p.z + hw
    );
    if (hit.t >= 0 && hit.t < bestDist) {
      bestDist = hit.t;
      impact = [hit.x, hit.y, hit.z];
      hitPlayer = true;
    }
  }
  for (const [, dum] of dummies) {
    if (!dum.group.visible) continue;
    const p = dum.group.position;
    const hit = V.ballisticHitAABB(
      cast.path, p.x - hw, p.y, p.z - hw, p.x + hw, p.y + V.PHYS.HEIGHT, p.z + hw
    );
    if (hit.t >= 0 && hit.t < bestDist) {
      bestDist = hit.t;
      impact = [hit.x, hit.y, hit.z];
      hitPlayer = true;
    }
  }

  // True hitreg path, trimmed to impact (includes drop samples)
  const path = [];
  let acc = 0;
  path.push(cast.path[0]);
  for (let i = 1; i < cast.path.length; i++) {
    const a = cast.path[i - 1], b = cast.path[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (acc + seg >= bestDist) {
      const u = (bestDist - acc) / (seg || 1);
      path.push([
        a[0] + (b[0] - a[0]) * u,
        a[1] + (b[1] - a[1]) * u,
        a[2] + (b[2] - a[2]) * u,
      ]);
      break;
    }
    acc += seg;
    path.push(b);
  }
  if (path.length < 2) path.push(impact);

  // Nudge first sample slightly ahead of the eye so the streak is visible
  // (still on the same ray — does not change hitreg curve after that).
  if (path.length >= 2) {
    path[0] = [
      ox + dir.x * 0.22,
      oy + dir.y * 0.22,
      oz + dir.z * 0.22,
    ];
  }

  let block = 0;
  if (!hitPlayer && cast.hit) {
    block = world.get(cast.bx, cast.by, cast.bz) || V.STONE;
  }

  const idir = cast.impactDir
    ? [cast.impactDir.x, cast.impactDir.y, cast.impactDir.z]
    : [dir.x, dir.y, dir.z];

  spawnTracer(path[0], impact, {
    path,
    hitPlayer,
    block,
    mine: true,
    weapon: currentWeapon,
    speed,
    // Walls spark when the streak arrives; flesh waits for server hitmarker
    // so a predicted body hit that the server rejects doesn't fake blood.
    noImpact: !!hitPlayer,
    impactDir: idir,
  });
}

/** Delay hitmarker / dmg numbers until the bullet would arrive (path / speed). */
function queueHitFeedback(msg) {
  let delayMs = 45;
  if (msg.at && Array.isArray(msg.at) && havePosition) {
    const eyeY = me.y + V.eyeOf(me);
    const dist = Math.hypot(msg.at[0] - me.x, msg.at[1] - eyeY, msg.at[2] - me.z);
    delayMs = bulletFlightTime(dist, msg.weapon || currentWeapon) * 1000;
  }
  hitFeedbackQ.push({ readyAt: performance.now() + delayMs, msg });
}

function updateHitFeedback() {
  const now = performance.now();
  for (let i = hitFeedbackQ.length - 1; i >= 0; i--) {
    if (now < hitFeedbackQ[i].readyAt) continue;
    const msg = hitFeedbackQ[i].msg;
    hitFeedbackQ.splice(i, 1);
    showHitmarker(msg.headshot, msg.lethal, msg.zone);
    spawnDamageNumber(msg.damage || 0, msg.headshot, msg.lethal, msg.at, msg.label, msg.zone);
    Audio.hitmarker(msg.headshot, msg.lethal);
    addShake(msg.lethal ? 0.05 : msg.headshot ? 0.035 : 0.02, 4);
    renderFov = Math.min(renderFov + (msg.lethal ? 2.2 : msg.headshot ? 1.2 : 0.5), baseFov() + 8);
    // Flesh impact at confirmed server hit point when the "bullet" lands
    if (msg.at && Array.isArray(msg.at) && !msg.dummy) {
      spawnImpact(msg.at[0], msg.at[1], msg.at[2], null, true, 0);
    } else if (msg.at && msg.dummy) {
      spawnImpact(msg.at[0], msg.at[1], msg.at[2], null, true, 0);
    }
  }
}

// ---- camera shake ----------------------------------------------------------

let shake = 0, shakeDecay = 1;
function addShake(amount, decay) {
  shake = Math.min(0.22, shake + amount);
  shakeDecay = decay;
}

// Remote players are rendered ~100ms in the past and interpolated between
// snapshots, which hides jitter and packet loss at the cost of a small,
// constant visual delay. The server still resolves hits against its own
// current state, so this never changes who actually got shot.
const INTERP_MS = 100;

function updateRemotes(dt) {
  if (snapshots.length === 0) return;
  const target = performance.now() - INTERP_MS;
  let a = snapshots[0], b = snapshots[snapshots.length - 1];
  for (let i = 0; i < snapshots.length - 1; i++) {
    if (snapshots[i].t <= target && snapshots[i + 1].t >= target) { a = snapshots[i]; b = snapshots[i + 1]; break; }
  }
  const span = b.t - a.t;
  const f = span > 0 ? Math.max(0, Math.min(1, (target - a.t) / span)) : 1;

  const seen = new Set();
  for (const pb of b.players) {
    if (pb.id === selfId) continue;
    seen.add(pb.id);

    let av = remote.get(pb.id);

    // Dead: keep corpse on the ground with a fall animation (don't vanish)
    if (!pb.alive) {
      if (!av) {
        av = createAvatar(pb);
        remote.set(pb.id, av);
        av.dead = true;
        av.deathFall = 0;
        av.deathRoll = Math.random() < 0.5 ? 1 : -1;
      }
      if (!av.dead) {
        av.dead = true;
        av.deathFall = 0;
        av.deathRoll = av.deathRoll || (Math.random() < 0.5 ? 1 : -1);
        av.plate.visible = false;
      }
      av.deathFall = Math.min(1, (av.deathFall || 0) + dt * 1.4);
      const u = easeOutCubic(av.deathFall);
      // Freeze at last known / state position
      av.group.position.set(pb.x, pb.y + 0.05 * u, pb.z);
      av.yawGroup.rotation.y = pb.yaw;
      av.yawGroup.rotation.z = (Math.PI / 2) * u * (av.deathRoll || 1);
      av.yawGroup.rotation.x = 0.12 * u;
      av.yawGroup.scale.y = 1;
      av.legL.rotation.x = 0.2 * u;
      av.legR.rotation.x = -0.15 * u;
      av.group.visible = true;
      av.plate.visible = false;
      // Fade corpse slightly after fully down
      const fade = u >= 1 ? 0.75 : 0.95;
      av.group.traverse((o) => {
        if (o.material && o.material.opacity !== undefined) o.material.opacity = fade;
      });
      continue;
    }

    if (!av) { av = createAvatar(pb); remote.set(pb.id, av); }
    // Respawn: reset death pose
    if (av.dead) {
      av.dead = false;
      av.deathFall = 0;
      av.yawGroup.rotation.z = 0;
      av.yawGroup.rotation.x = 0;
      av.plate.visible = true;
    }
    av.group.visible = true;

    // Rebuild the plate if they changed pronouns mid-match.
    if ((pb.pr || '') !== av.pronouns) {
      av.pronouns = pb.pr || '';
      av.group.remove(av.plate);
      av.plate.material.map?.dispose();
      av.plate.material.dispose();
      av.plate = makeNameplate(pb.u, av.pronouns);
      av.group.add(av.plate);
    }

    const pa = a.players.find((p) => p.id === pb.id) || pb;
    const x = pa.x + (pb.x - pa.x) * f;
    const y = pa.y + (pb.y - pa.y) * f;
    const z = pa.z + (pb.z - pa.z) * f;
    const yw = pa.yaw + angleDelta(pa.yaw, pb.yaw) * f;

    const moved = Math.hypot(x - av.group.position.x, z - av.group.position.z);

    // Enemy footsteps are a real tactical signal, not ambience — hearing which
    // side someone is approaching from is often what decides the fight.
    if (av.group.position.lengthSq() > 0 && moved > 0 && moved < 2) {
      av.stepDist = (av.stepDist || 0) + moved;
      if (av.stepDist >= STRIDE) {
        av.stepDist = 0;
        Audio.footstep(blockUnder(x, y, z), { x, y, z }, 0.9);
      }
    }

    av.group.position.set(x, y, z);
    av.yawGroup.rotation.y = yw;
    av.yawGroup.rotation.z = 0;
    av.yawGroup.rotation.x = 0;
    av.head.rotation.x = -(pa.pitch + (pb.pitch - pa.pitch) * f);

    // Crouch: squash the remote avatar so you can read posture at range.
    av.crouching = !!pb.crouch;
    const crouchScale = pb.crouch ? V.PHYS.CROUCH_HEIGHT / V.PHYS.HEIGHT : 1;
    av.yawGroup.scale.y = crouchScale;
    av.plate.position.y = pb.crouch ? 1.55 : 2.25;
    av.plate.visible = true;

    // Weapon silhouette on remotes — sniper long, SMG stubby, rifle default.
    if (av.gun) {
      const w = pb.w;
      if (w === 'sniper') {
        av.gun.scale.set(0.85, 0.85, 1.55);
        av.gun.position.set(0.37, 0.92, -0.42);
      } else if (w === 'smg') {
        av.gun.scale.set(0.9, 0.9, 0.75);
        av.gun.position.set(0.37, 0.92, -0.22);
      } else {
        av.gun.scale.set(1, 1, 1);
        av.gun.position.set(0.37, 0.92, -0.32);
      }
    }

    // leg swing so movement reads at a distance
    av.walkPhase += moved * 5.5;
    const swing = Math.sin(av.walkPhase) * (pb.crouch ? 0.35 : 0.7);
    av.legL.rotation.x = swing;
    av.legR.rotation.x = -swing;

    av.group.traverse((o) => { if (o.material && o.material.opacity !== undefined) o.material.opacity = pb.gone ? 0.45 : 1; });
    av.plate.material.opacity = pb.prot ? 0.55 : 1;

    // ZERO-G indicator on other players (soft cyan lift bob)
    if (pb.lg) {
      av.group.position.y += 0.06 + Math.sin(performance.now() * 0.006 + pb.id) * 0.04;
      if (!av.lgAura) {
        av.lgAura = new THREE.Sprite(new THREE.SpriteMaterial({
          color: 0x66ffcc, transparent: true, opacity: 0.35,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
        }));
        av.lgAura.scale.set(1.4, 1.8, 1);
        av.lgAura.position.y = 1.0;
        av.group.add(av.lgAura);
      }
      av.lgAura.visible = true;
    } else if (av.lgAura) {
      av.lgAura.visible = false;
    }
  }

  for (const id of [...remote.keys()]) if (!seen.has(id)) removeAvatar(id);
}

function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ------------------------------------------------------------------- HUD ----

const fmt = (cents) => `$${(cents / 100).toFixed(2)}`;

function setBalance(cents) {
  balance = cents;
  const el = document.getElementById('hud-balance');
  if (el) el.textContent = fmt(cents);
  hooks.onBalance?.(cents);
}

function updateHud(players) {
  const p = players.find((x) => x.id === selfId);
  if (!p) return;
  myHp = p.hp;
  const hpPct = Math.max(0, p.hp / C.maxHp) * 100;
  const hpBar = document.getElementById('hp-bar');
  hpBar.style.width = `${hpPct}%`;
  hpBar.classList.toggle('low', hpPct <= 35);
  hpBar.classList.toggle('critical', hpPct <= 18);
  document.getElementById('hp-num').textContent = Math.max(0, Math.round(p.hp));
  document.getElementById('hud-kd').textContent = `${p.k} / ${p.d}`;
  updateCombatGrade(p.hp);
  const def = weaponDef();
  const ammoEl = document.getElementById('ammo');
  if (ammoEl) {
    ammoEl.innerHTML = `${ammo}<span>/${def.magSize}</span>`;
    ammoEl.classList.toggle('low', ammo > 0 && ammo <= Math.ceil(def.magSize * 0.25));
    ammoEl.classList.toggle('empty', ammo <= 0);
  }
  const reloadHint = document.getElementById('reload-hint');
  const reloadBar = document.getElementById('reload-bar');
  const reloading = reloadingMs > 0;
  if (reloadHint) reloadHint.classList.toggle('hidden', !reloading);
  if (reloadBar) {
    reloadBar.classList.toggle('hidden', !reloading);
    if (reloading && def.reload) {
      // Server sends remaining ms; invert to progress 0→1
      const pct = Math.max(0, Math.min(1, 1 - reloadingMs / (def.reload * 1000)));
      reloadBar.style.setProperty('--reload-pct', `${(pct * 100).toFixed(1)}%`);
    }
  }
  const wEl = document.getElementById('weapon-name');
  if (wEl) {
    wEl.textContent = def.name || currentWeapon.toUpperCase();
    wEl.classList.toggle('sniper', currentWeapon === 'sniper');
    wEl.classList.toggle('smg', currentWeapon === 'smg');
    wEl.classList.toggle('rifle', currentWeapon === 'rifle');
  }
  const tag = document.getElementById('weapon-tag');
  if (tag) {
    const tags = {
      rifle: 'MID · BALANCED',
      smg: 'CQB · HIGH ROF',
      sniper: 'LONG · PRECISION',
    };
    tag.textContent = tags[currentWeapon] || '';
  }
  // Weapon strip: highlight active slot
  const strip = document.getElementById('weapon-strip');
  if (strip) {
    for (const btn of strip.querySelectorAll('[data-weapon]')) {
      const id = btn.getAttribute('data-weapon');
      const wdef = weaponDef(id);
      btn.classList.toggle('active', id === currentWeapon);
      const magEl = btn.querySelector('.ws-mag');
      if (magEl && wdef) magEl.textContent = id === currentWeapon ? `${ammo}` : `${wdef.magSize}`;
    }
  }
  // Only clear death UI once server says alive AND sequence is done / shouldn't block
  if (p.alive && deathCam) {
    endDeathSequence();
  } else if (p.alive && !deathCam) {
    const od = document.getElementById('overlay-dead');
    if (od) od.classList.add('hidden');
  }
}

// ---- Throwables (grenade / smoke / flash / RPG) ----------------------------

function throwableDef(id) {
  return (C.throwables && C.throwables[id]) || DEFAULT_THROWABLES[id];
}

/** Fire/throw whatever is currently armed (called once per click). */
function fireArmedEquipment(now) {
  if (!armedEquip || !running || !havePosition || deathCam) return;
  const id = armedEquip;
  const def = throwableDef(id);
  if (!def) return;
  if ((throwCdMs[id] || 0) > 50) {
    addFeedLine(`${def.name} recharging…`);
    return;
  }
  throwCdMs[id] = (def.cooldown || 20) * 1000;
  updateThrowableHud();

  // Same post-recoil aim as guns (matches trajectory preview + server input)
  const aim = getAimAngles();
  const launch = V.throwLaunch(
    { x: me.x, y: me.y, z: me.z, crouching: !!me.crouching },
    aim.yaw,
    aim.pitch,
    def
  );
  const ox = launch.x, oy = launch.y, oz = launch.z;
  const vx = launch.vx, vy = launch.vy, vz = launch.vz;

  if (id === 'rpg') {
    recoilVel += 1.4;
    aimKickPV += 0.08;
    addShake(0.09, 2.5);
    Audio.rpgLaunch?.();
  } else {
    Audio.throwWhoosh?.();
  }

  spawnThrownProjectile({
    projId: 'local-' + Date.now(),
    ownerId: selfId,
    id,
    kind: def.kind || id,
    from: [ox, oy, oz],
    vel: [vx, vy, vz],
    fuse: def.fuse || 0,
    direct: !!def.direct || id === 'rpg',
    local: true,
  });

  send({ type: 'throw', id, yaw: aim.yaw, pitch: aim.pitch });
  // Return to last gun after throwing (RPG too — tube empty)
  disarmEquipment();
}

function makeWorldGrenadeMesh(kind) {
  const g = new THREE.Group();
  const box = (w, h, d, color, x, y, z) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshBasicMaterial({ color })
    );
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  if (kind === 'smoke') {
    box(0.16, 0.32, 0.16, 0x8a929c, 0, 0, 0);
    box(0.18, 0.05, 0.18, 0x6a727c, 0, 0.14, 0);
    box(0.18, 0.06, 0.04, 0x3ecf7a, 0, 0.02, 0.09);
  } else if (kind === 'flash') {
    box(0.18, 0.22, 0.18, 0xc8b060, 0, 0, 0);
    box(0.2, 0.05, 0.2, 0x5c6674, 0, 0.1, 0);
    box(0.04, 0.1, 0.04, 0x22262c, 0.08, 0, 0);
  } else if (kind === 'rpg') {
    box(0.12, 0.12, 0.55, 0xc45a20, 0, 0, 0);
    box(0.16, 0.16, 0.1, 0xff6b2d, 0, 0, -0.28);
    box(0.08, 0.08, 0.12, 0x3a414c, 0, 0, 0.28);
  } else {
    // HE pineapple
    box(0.18, 0.22, 0.18, 0x2f6b32, 0, 0, 0);
    box(0.2, 0.05, 0.2, 0x245028, 0, 0.06, 0);
    box(0.2, 0.05, 0.2, 0x245028, 0, -0.05, 0);
    box(0.07, 0.08, 0.07, 0x5c6674, 0, 0.14, 0);
    box(0.04, 0.1, 0.03, 0x3a414c, 0.06, 0.16, 0.03);
  }
  return g;
}

const THROW_STEP = 1 / 30; // must match server tickProjectiles

function spawnThrownProjectile(msg) {
  if (!scene) return;
  const f = msg.from || [0, 0, 0];
  const v = msg.vel || [0, 0, 0];
  // Reconcile our predicted nade with the authoritative launch so the mesh
  // follows the same 30Hz path as the yellow marker / server detonation.
  if (!msg.local && msg.ownerId === selfId) {
    for (let i = localProjectiles.length - 1; i >= 0; i--) {
      const lp = localProjectiles[i];
      if (lp.local && lp.throwableId === msg.id) {
        lp.id = msg.projId;
        lp.local = false;
        lp.ownerId = msg.ownerId;
        lp.x = f[0]; lp.y = f[1]; lp.z = f[2];
        lp.vx = v[0]; lp.vy = v[1]; lp.vz = v[2];
        lp.onGround = false;
        lp.bounces = 0;
        lp.accum = 0;
        lp.life = 0;
        if (lp.mesh) lp.mesh.position.set(lp.x, lp.y, lp.z);
        return;
      }
    }
  }
  const kind = msg.kind || msg.id || 'grenade';
  const mesh = makeWorldGrenadeMesh(kind);
  mesh.position.set(f[0], f[1], f[2]);
  scene.add(mesh);
  const def = throwableDef(msg.id) || {};
  localProjectiles.push({
    id: msg.projId,
    throwableId: msg.id,
    ownerId: msg.ownerId,
    kind,
    mesh,
    x: f[0], y: f[1], z: f[2],
    vx: v[0], vy: v[1], vz: v[2],
    gravity: def.gravity != null ? def.gravity : ((kind === 'rpg' ? 5 : 28)),
    bounce: def.bounce != null ? def.bounce : 0.38,
    direct: !!msg.direct || kind === 'rpg',
    fuse: msg.fuse || 0,
    life: 0,
    accum: 0,
    onGround: false,
    bounces: 0,
    local: !!msg.local,
  });
}

function updateLocalProjectiles(dt) {
  for (let i = localProjectiles.length - 1; i >= 0; i--) {
    const p = localProjectiles[i];
    p.life += dt;
    // Fixed 30Hz steps — variable rAF dt made the mesh diverge from the aim line
    p.accum = (p.accum || 0) + dt;
    if (p.accum > 0.25) p.accum = 0.25; // don't spiral after a long hitch
    if (world) {
      const def = throwableDef(p.throwableId) || {};
      const bounce = def.bounce != null ? def.bounce : p.bounce;
      const gravity = def.gravity != null ? def.gravity : p.gravity;
      while (p.accum >= THROW_STEP) {
        p.accum -= THROW_STEP;
        world.ensureAround(p.x, p.z, 2);
        V.stepProjectile(world, p, THROW_STEP, {
          gravity,
          bounce,
          direct: p.direct,
          radius: V.PROJ_RADIUS,
          friction: 0.84,
          airDrag: 0.995,
        });
      }
    } else {
      while (p.accum >= THROW_STEP) {
        p.accum -= THROW_STEP;
        p.vy -= p.gravity * THROW_STEP;
        p.x += p.vx * THROW_STEP;
        p.y += p.vy * THROW_STEP;
        p.z += p.vz * THROW_STEP;
      }
    }
    p.mesh.position.set(p.x, p.y, p.z);
    if (p.direct) {
      const spd = Math.hypot(p.vx, p.vy, p.vz) || 1;
      p.mesh.lookAt(p.x + p.vx, p.y + p.vy, p.z + p.vz);
      if (settings.particles !== false && spd > 2) {
        for (let k = 0; k < 2; k++) {
          addParticle(
            p.x - p.vx * 0.02 * k, p.y - p.vy * 0.02 * k, p.z - p.vz * 0.02 * k,
            -p.vx * 0.08 + (Math.random() - 0.5),
            0.3 + Math.random(),
            -p.vz * 0.08 + (Math.random() - 0.5),
            0.08 + Math.random() * 0.06,
            0.35 + Math.random() * 0.2,
            Math.random() > 0.4 ? [2.4, 1.3, 0.35] : [1.2, 1.2, 1.2],
            6
          );
        }
      }
    } else {
      // Roll visually while moving on the ground
      const roll = Math.hypot(p.vx, p.vz);
      if (roll > 0.05) {
        p.mesh.rotation.x += p.vz * dt * 6;
        p.mesh.rotation.z -= p.vx * dt * 6;
        p.mesh.rotation.y += roll * dt * 2;
      } else if (!p.onGround) {
        p.mesh.rotation.x += dt * 8;
        p.mesh.rotation.z += dt * 5;
      }
    }
    // Visual timeout; server explosion is authoritative
    if (p.life > 8) {
      scene.remove(p.mesh);
      p.mesh.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      localProjectiles.splice(i, 1);
    }
  }
}

/**
 * Exact server-matched throw preview.
 * Server tick = 30Hz + stepProjectile + throwLaunch — same here.
 * Returns path samples + detonation point (after full fuse).
 */
function simulateThrowPath(def) {
  const fallback = {
    pts: [new THREE.Vector3(me.x, me.y + 1.2, me.z)],
    explode: { x: me.x, y: me.y, z: me.z },
  };
  if (!world || !def || !me) return fallback;

  const aim = getAimAngles();
  const launch = V.throwLaunch(
    { x: me.x, y: me.y, z: me.z, crouching: !!me.crouching },
    aim.yaw,
    aim.pitch,
    def
  );
  const gravity = def.gravity != null ? def.gravity : 28;
  const bounce = def.bounce != null ? def.bounce : 0.35;
  const fuse = def.fuse > 0 ? def.fuse : 2.1;
  const dt = THROW_STEP;

  const p = {
    x: launch.x, y: launch.y, z: launch.z,
    vx: launch.vx, vy: launch.vy, vz: launch.vz,
    onGround: false,
    bounces: 0,
  };
  const pts = [];
  const steps = Math.max(8, Math.ceil(fuse / dt));
  for (let i = 0; i <= steps; i++) {
    // Stream terrain under the live sim path (bounces leave the aim ray)
    world.ensureAround(p.x, p.z, 2);
    pts.push(new THREE.Vector3(p.x, p.y, p.z));
    if (i === steps) break;
    V.stepProjectile(world, p, dt, {
      gravity,
      bounce,
      direct: false,
      radius: V.PROJ_RADIUS,
      friction: 0.84,
      airDrag: 0.995,
    });
  }
  return { pts, explode: { x: p.x, y: p.y, z: p.z }, launch };
}

function updateThrowTrajectory() {
  if (!trajLine || !trajMarker) return;
  const show = !!(armedEquip && isLobThrowable(armedEquip) && havePosition && !deathCam && world);
  trajLine.visible = show;
  trajMarker.visible = show;
  if (!show) return;

  const def = throwableDef(armedEquip);
  // Prefer server-sent defs (bounce/gravity/fuse) over sparse defaults
  const full = Object.assign({}, DEFAULT_THROWABLES[armedEquip] || {}, def || {});
  // Mirror server config fallbacks used in tryThrow
  if (full.bounce == null) full.bounce = 0.35;
  if (full.gravity == null) full.gravity = 28;

  const { pts, explode } = simulateThrowPath(full);
  if (!pts.length) return;

  const arr = trajLine.geometry.attributes.position.array;
  const maxV = (arr.length / 3) | 0;
  // Write every sim sample in order (no re-indexing — that was making the line wrong)
  const n = Math.min(maxV, pts.length);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = pts[i].x;
    arr[i * 3 + 1] = pts[i].y + 0.04; // slight lift so it doesn't z-fight ground
    arr[i * 3 + 2] = pts[i].z;
  }
  const last = pts[n - 1];
  for (let i = n; i < maxV; i++) {
    arr[i * 3] = last.x;
    arr[i * 3 + 1] = last.y + 0.04;
    arr[i * 3 + 2] = last.z;
  }
  trajLine.geometry.setDrawRange(0, n);
  trajLine.geometry.attributes.position.needsUpdate = true;
  trajLine.geometry.computeBoundingSphere();

  // Marker = predicted detonation point (same 30Hz sim as the server)
  const ex = explode || { x: last.x, y: last.y, z: last.z };
  let my = ex.y + 0.05;
  if (world.solidSurfaceY) {
    const sy = world.solidSurfaceY(Math.floor(ex.x), Math.floor(ex.z));
    // Pin ring to ground when the nade has settled (not mid-air)
    if (ex.y <= sy + 0.6) my = sy + 0.06;
  }
  trajMarker.position.set(ex.x, my, ex.z);
}

function removeProjectileVisual(projId, meta) {
  for (let i = localProjectiles.length - 1; i >= 0; i--) {
    const p = localProjectiles[i];
    const idMatch = projId != null && p.id === projId;
    // Local predicted nades may still be tagged local-* if the throw ack was late
    const localMine = p.local && p.ownerId === selfId;
    const mineKind = meta && p.ownerId === selfId
      && (p.throwableId === meta.throwableId || p.kind === meta.kind);
    if (idMatch || localMine || mineKind || (projId == null && p.local)) {
      scene.remove(p.mesh);
      p.mesh.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      localProjectiles.splice(i, 1);
    }
  }
}

function spawnExplosionFx(ex) {
  if (!ex) return;
  removeProjectileVisual(ex.id, {
    throwableId: ex.throwableId,
    kind: ex.kind,
    ownerId: ex.ownerId,
    x: ex.x, y: ex.y, z: ex.z,
  });
  const x = ex.x, y = ex.y, z = ex.z;
  const kind = ex.kind || 'he';
  const R = ex.radius || 5;

  if (kind === 'smoke') {
    const smokeR = Math.max(8, ex.radius || 9);
    // Dense multi-sphere fog volume — hard to see through
    const group = new THREE.Group();
    const layers = [
      { s: 1.0, o: 0.72 },
      { s: 0.72, o: 0.55 },
      { s: 1.25, o: 0.4 },
      { s: 0.55, o: 0.65 },
    ];
    for (const L of layers) {
      const sph = new THREE.Mesh(
        new THREE.SphereGeometry(smokeR * L.s, 16, 12),
        new THREE.MeshBasicMaterial({
          color: 0x6a7078,
          transparent: true,
          opacity: L.o,
          depthWrite: false,
          fog: false,
        })
      );
      sph.position.set(
        (Math.random() - 0.5) * 1.5,
        Math.random() * 1.2,
        (Math.random() - 0.5) * 1.5
      );
      group.add(sph);
    }
    group.position.set(x, y + 1.2, z);
    scene.add(group);
    smokeClouds.push({
      x, y: y + 1.2, z,
      r: smokeR,
      life: ex.smokeDur || 16,
      maxLife: ex.smokeDur || 16,
      group,
    });
    if (settings.particles !== false) {
      for (let i = 0; i < 80; i++) {
        addParticle(
          x + (Math.random() - 0.5) * smokeR * 0.6,
          y + Math.random() * 2,
          z + (Math.random() - 0.5) * smokeR * 0.6,
          (Math.random() - 0.5) * 2, 0.8 + Math.random() * 2, (Math.random() - 0.5) * 2,
          0.35 + Math.random() * 0.3, 3 + Math.random() * 3,
          [0.4, 0.42, 0.45], 0.6
        );
      }
    }
    Audio.smokePop?.({ x, y, z });
    return;
  }

  if (kind === 'flash') {
    if (settings.particles !== false) {
      for (let i = 0; i < 24; i++) {
        addParticle(
          x, y, z,
          (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 12,
          0.08, 0.35, [2.5, 2.5, 2.0], 2
        );
      }
    }
    Audio.flashbang?.({ x, y, z });
    return;
  }

  // HE / RPG fireball
  const count = kind === 'rpg' ? 55 : 38;
  if (settings.particles !== false) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const elev = (Math.random() - 0.15) * Math.PI * 0.6;
      const sp = 4 + Math.random() * (kind === 'rpg' ? 14 : 10);
      addParticle(
        x, y, z,
        Math.cos(a) * Math.cos(elev) * sp,
        Math.sin(elev) * sp + 2,
        Math.sin(a) * Math.cos(elev) * sp,
        0.1 + Math.random() * 0.12,
        0.45 + Math.random() * 0.4,
        Math.random() > 0.35 ? [2.5, 1.2, 0.25] : [1.8, 0.4, 0.1],
        12
      );
    }
    // smoke linger
    for (let i = 0; i < 16; i++) {
      addParticle(
        x + (Math.random() - 0.5) * R * 0.4,
        y + Math.random() * 1.5,
        z + (Math.random() - 0.5) * R * 0.4,
        (Math.random() - 0.5) * 2, 2 + Math.random() * 3, (Math.random() - 0.5) * 2,
        0.2, 1.2, [0.35, 0.35, 0.38], 3
      );
    }
  }
  addShake(kind === 'rpg' ? 0.16 : 0.11, 2.2);
  if (kind === 'rpg') Audio.rpgExplode?.({ x, y, z });
  else Audio.explode?.({ x, y, z });
}

function updateSmokeClouds(dt) {
  for (let i = smokeClouds.length - 1; i >= 0; i--) {
    const c = smokeClouds[i];
    c.life -= dt;
    const u = Math.max(0, c.life / (c.maxLife || 1));
    if (c.group) {
      c.group.scale.setScalar(1 + (1 - u) * 0.35);
      c.group.rotation.y += dt * 0.15;
      c.group.traverse((o) => {
        if (o.material && o.material.opacity != null) {
          o.material.opacity = Math.min(0.85, (o.userData.baseOp || o.material.opacity) * Math.min(1, u * 1.4));
          if (!o.userData.baseOp) o.userData.baseOp = o.material.opacity / Math.max(0.2, Math.min(1, u * 1.4));
        }
      });
    }
    // continuous dense particles
    if (settings.particles !== false && Math.random() > 0.25) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * c.r * 0.85;
      addParticle(
        c.x + Math.cos(a) * rr, c.y + Math.random() * 3, c.z + Math.sin(a) * rr,
        (Math.random() - 0.5) * 0.6, 0.4 + Math.random() * 0.8, (Math.random() - 0.5) * 0.6,
        0.4 + Math.random() * 0.35, 2.2, [0.42, 0.44, 0.48], 0.5
      );
    }
    // No full-screen smoke vignette — radial HUD overlays read as the FOV circle
    if (c.life <= 0) {
      if (c.group) {
        scene.remove(c.group);
        c.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      }
      smokeClouds.splice(i, 1);
    }
  }
}

function beginFlashbang(strength, dur) {
  flashFx = { t: 0, dur: Math.max(0.6, dur || 2.5), strength: Math.min(1, strength || 1) };
  const el = document.getElementById('flash-overlay');
  if (el) {
    el.classList.remove('hidden');
    el.style.opacity = String(0.55 + flashFx.strength * 0.45);
  }
}

function updateFlashbang(dt) {
  if (!flashFx) return;
  flashFx.t += dt;
  const u = flashFx.t / flashFx.dur;
  const el = document.getElementById('flash-overlay');
  if (u >= 1) {
    flashFx = null;
    if (el) { el.style.opacity = '0'; el.classList.add('hidden'); }
    return;
  }
  // hold white then ease out
  const op = u < 0.2
    ? (0.7 + flashFx.strength * 0.3)
    : (1 - (u - 0.2) / 0.8) * (0.7 + flashFx.strength * 0.3);
  if (el) el.style.opacity = String(Math.max(0, op));
}

function applyBlockChanges(blocks) {
  if (!world || !blocks?.length) return;
  const dirty = new Set();
  // Coalesce last-write-wins per cell (destroys + rare step fills)
  const map = new Map();
  for (const b of blocks) {
    const x = b[0] | 0, y = b[1] | 0, z = b[2] | 0, v = b[3] | 0;
    map.set(`${x},${y},${z}`, v);
  }
  for (const [key, v] of map) {
    const [xs, ys, zs] = key.split(',');
    const x = +xs, y = +ys, z = +zs;
    world.set(x, y, z, v);
    const cx = Math.floor(x / CS), cz = Math.floor(z / CS);
    dirty.add(chunkKey(cx, cz));
    dirty.add(chunkKey(cx - 1, cz));
    dirty.add(chunkKey(cx + 1, cz));
    dirty.add(chunkKey(cx, cz - 1));
    dirty.add(chunkKey(cx, cz + 1));
  }
  for (const k of dirty) {
    const mesh = chunkMeshes.get(k);
    if (mesh) {
      worldGroup.remove(mesh);
      mesh.geometry?.dispose?.();
      chunkMeshes.delete(k);
    } else if (chunkMeshes.has(k)) {
      chunkMeshes.delete(k);
    }
    const [cx, cz] = k.split(':').map(Number);
    if (Number.isFinite(cx) && Number.isFinite(cz)) meshOneChunk(cx, cz, k, worldMat);
  }
}

function updateThrowableHud() {
  const root = document.getElementById('throwable-strip');
  if (!root) return;
  for (const btn of root.querySelectorAll('[data-throw]')) {
    const id = btn.getAttribute('data-throw');
    const def = throwableDef(id);
    const cd = throwCdMs[id] || 0;
    const total = (def?.cooldown || 20) * 1000;
    const ready = cd <= 50;
    btn.classList.toggle('ready', ready);
    btn.classList.toggle('cooling', !ready);
    btn.classList.toggle('armed', armedEquip === id);
    const bar = btn.querySelector('.th-cd');
    if (bar) {
      const pct = ready ? 0 : Math.min(1, cd / total);
      bar.style.setProperty('--cd', `${(pct * 100).toFixed(1)}%`);
    }
    const tEl = btn.querySelector('.th-time');
    if (tEl) {
      if (armedEquip === id) tEl.textContent = 'ARM';
      else tEl.textContent = ready ? 'RDY' : `${Math.ceil(cd / 1000)}s`;
    }
  }
}

// ---- feedback juice: damage numbers, kill card, compass, hit dirs ----------

let myHp = 100;
let killStreak = 0;
let killCardTimer = null;
let gradeFlashTimer = null;
const _proj = new THREE.Vector3();
let hitTimer = null;
function showHitmarker(headshot, lethal, zone) {
  const el = document.getElementById('hitmarker');
  el.classList.remove('hidden', 'hs', 'lethal');
  if (lethal || zone === 'brain') el.classList.add('lethal');
  else if (headshot || zone === 'head' || zone === 'heart') el.classList.add('hs');
  const big = lethal || zone === 'brain' || zone === 'heart';
  el.style.transform = `translate(-50%,-50%) scale(${big ? 1.65 : headshot ? 1.4 : 1.12})`;
  clearTimeout(hitTimer);
  hitTimer = setTimeout(() => el.classList.add('hidden'), 150);
}

function spawnDamageNumber(damage, headshot, lethal, at, label, zone) {
  if (!damage) return;
  const root = document.getElementById('dmg-numbers');
  if (!root) return;
  let sx = window.innerWidth * 0.5 + (Math.random() - 0.5) * 40;
  let sy = window.innerHeight * 0.42 + (Math.random() - 0.5) * 30;
  if (at && camera && Array.isArray(at)) {
    _proj.set(at[0], at[1], at[2]).project(camera);
    if (_proj.z < 1) {
      sx = (_proj.x * 0.5 + 0.5) * window.innerWidth + (Math.random() - 0.5) * 24;
      sy = (-_proj.y * 0.5 + 0.5) * window.innerHeight - 12;
    }
  }
  const el = document.createElement('div');
  let cls = 'dmg-num bod';
  const z = zone || '';
  if (z === 'brain' || (headshot && lethal)) cls = 'dmg-num hs lethal';
  else if (lethal) cls = 'dmg-num lethal';
  else if (z === 'heart') cls = 'dmg-num heart';
  else if (z === 'chest') cls = 'dmg-num chest';
  else if (z === 'head' || headshot) cls = 'dmg-num hs';
  else if (z === 'arm' || z === 'leg' || z === 'foot') cls = 'dmg-num limb';
  el.className = cls;
  const tag = label || (z ? z.toUpperCase() : '');
  const bang = z === 'brain' || z === 'heart' || headshot || lethal;
  el.innerHTML = `${bang ? damage + '!' : damage}${tag ? `<span class="zone-tag">${tag}</span>` : ''}`;
  el.style.left = `${sx}px`;
  el.style.top = `${sy}px`;
  root.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

function showKillCard(victim, headshot, weapon, streak, zoneLabel) {
  const card = document.getElementById('kill-card');
  if (!card) return;
  document.getElementById('kc-name').textContent = victim || '—';
  const wname = (weaponDef(weapon || currentWeapon).name || weapon || '').toUpperCase();
  const bits = [];
  const zl = (zoneLabel || '').toUpperCase();
  if (zl === 'BRAIN') bits.push('<span class="hs-tag">BRAIN SHOT</span>');
  else if (zl === 'HEART') bits.push('<span class="hs-tag">HEART SHOT</span>');
  else if (headshot || zl === 'HEAD') bits.push('<span class="hs-tag">HEADSHOT</span>');
  else if (zl) bits.push(`<span class="hs-tag">${esc(zl)}</span>`);
  if (wname) bits.push(wname);
  if (streak >= 2) bits.push(`${streak} STREAK`);
  document.getElementById('kc-meta').innerHTML = bits.join(' · ');
  card.classList.remove('hidden', 'out');
  void card.offsetWidth;
  clearTimeout(killCardTimer);
  killCardTimer = setTimeout(() => {
    card.classList.add('out');
    setTimeout(() => card.classList.add('hidden'), 280);
  }, 1600);

  if (streak >= 2) {
    const sp = document.getElementById('streak-pop');
    if (sp) {
      sp.textContent = streak >= 5 ? 'UNSTOPPABLE' : streak >= 3 ? 'ON FIRE' : 'DOUBLE';
      if (streak === 4) sp.textContent = 'MULTI';
      if (streak >= 6) sp.textContent = 'GODLIKE';
      sp.classList.remove('hidden');
      void sp.offsetWidth;
      setTimeout(() => sp.classList.add('hidden'), 900);
    }
  }
}

function updateStreakHud() {
  const el = document.getElementById('hud-streak');
  if (!el) return;
  el.classList.toggle('hidden', killStreak < 2);
  const b = el.querySelector('b');
  if (b) b.textContent = String(killStreak);
}

function updateCombatGrade(hp) {
  const el = document.getElementById('combat-grade');
  if (!el) return;
  const max = C.maxHp || 100;
  const pct = Math.max(0, hp) / max;
  el.classList.remove('low', 'critical');
  if (pct <= 0.18 && pct > 0) el.classList.add('critical');
  else if (pct <= 0.4 && pct > 0) el.classList.add('low');
}

function pulseCombatGrade(cls) {
  const el = document.getElementById('combat-grade');
  if (!el) return;
  el.classList.add(cls);
  clearTimeout(gradeFlashTimer);
  gradeFlashTimer = setTimeout(() => el.classList.remove(cls), 380);
}

// Hit direction: 8 sectors relative to look yaw
function showHitDirection(worldDir) {
  if (worldDir == null || !Number.isFinite(worldDir)) return;
  let rel = worldDir - yaw;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel < -Math.PI) rel += Math.PI * 2;
  // 0 = ahead, + = right
  const deg = ((rel * 180) / Math.PI + 360) % 360;
  const sectors = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  const idx = Math.round(deg / 45) % 8;
  const name = sectors[idx];
  const node = document.querySelector(`.hit-dirs .hd.${name}`);
  if (!node) return;
  node.classList.remove('on');
  void node.offsetWidth;
  node.classList.add('on');
  setTimeout(() => node.classList.remove('on'), 560);
}

// Compass: NSEW + degree numbers every 15°
let compassReady = false;
const COMPASS_STEP = 15; // degrees per tick
const COMPASS_TICK_W = 36; // px per tick (CSS must match)
function buildCompass() {
  const track = document.getElementById('compass-track');
  if (!track || compassReady) return;
  const labels = [];
  const perCircle = 360 / COMPASS_STEP;
  // Three full circles so we can scroll without a seam
  for (let rep = 0; rep < 3; rep++) {
    for (let i = 0; i < perCircle; i++) {
      const deg = i * COMPASS_STEP;
      const cardinal =
        deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S' : deg === 270 ? 'W' : '';
      labels.push({ deg, cardinal });
    }
  }
  track.innerHTML = labels.map((t) => {
    if (t.cardinal) {
      const cls = t.cardinal === 'N' ? 'compass-tick cardinal n' : 'compass-tick cardinal';
      return `<span class="${cls}" style="width:${COMPASS_TICK_W}px">${t.cardinal}</span>`;
    }
    // Intermediate: show degree number (compact)
    const major = t.deg % 45 === 0;
    const cls = major ? 'compass-tick deg major' : 'compass-tick deg';
    return `<span class="${cls}" style="width:${COMPASS_TICK_W}px">${t.deg}</span>`;
  }).join('');
  compassReady = true;
}

function updateCompass() {
  const track = document.getElementById('compass-track');
  if (!track) return;
  if (!compassReady) buildCompass();
  // yaw 0 looks -Z (north). Convert to degrees.
  let deg = (-yaw * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  const pxPerDeg = COMPASS_TICK_W / COMPASS_STEP;
  const ticksPerCircle = 360 / COMPASS_STEP;
  const centerOffset = ticksPerCircle * COMPASS_TICK_W; // start of middle circle
  const x = centerOffset + deg * pxPerDeg;
  track.style.transform = `translateX(${-x}px)`;
}

let vigTimer = null;
function flashDamage() {
  const el = document.getElementById('damage-vignette');
  if (!el) return;
  // Restore default red damage look (smoke may have overwritten background)
  el.style.background = '';
  delete el.dataset.smoke;
  el.style.opacity = '1';
  clearTimeout(vigTimer);
  vigTimer = setTimeout(() => { el.style.opacity = '0'; }, 200);
}

// ---- Death sequence: fall → death card fade → 15s killer POV ---------------
let deathCam = null;
let deathCountTimer = null;

function easeOutCubic(t) {
  const u = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - u, 3);
}
function easeInOut(t) {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
}

function beginDeathSequence(msg) {
  // Cancel any prior sequence
  endDeathSequence(true);

  firing = false;
  aiming = false;
  adsBlend = 0;
  pending.length = 0;
  if (viewHolder) viewHolder.visible = false;
  const scope = document.getElementById('scope-overlay');
  if (scope) {
    scope.classList.add('hidden');
    scope.classList.remove('rpg', 'sniper');
  }
  const vig = document.getElementById('damage-vignette');
  if (vig) { vig.style.opacity = '0'; vig.style.background = ''; delete vig.dataset.smoke; }

  const fallS = msg.fallS ?? 1.2;
  const cardS = msg.cardS ?? 0.8;
  const spectateS = msg.spectateS ?? (msg.killerId ? 4 : 0);

  deathCam = {
    phase: 'fall',
    t: 0,
    fallS,
    cardS,
    spectateS,
    killerId: msg.killerId || null,
    killerName: msg.by || '—',
    respawnAt: msg.respawnAt || (Date.now() + 6000),
    canAfford: msg.canAfford !== false,
    // freeze death pose
    x: msg.x != null ? msg.x : me.x,
    y: msg.y != null ? msg.y : me.y,
    z: msg.z != null ? msg.z : me.z,
    yaw: msg.yaw != null ? msg.yaw : yaw,
    pitch: msg.pitch != null ? msg.pitch : pitch,
    eye: V.eyeOf(me),
    rollDir: Math.random() < 0.5 ? 1 : -1,
    // tip slightly toward killer direction if known
    tipYaw: 0,
  };

  // Tip fall toward the last known look slightly randomized
  deathCam.tipYaw = deathCam.yaw + deathCam.rollDir * 0.35;

  // Spawn a third-person corpse at death spot (visible during fall + if others watch)
  spawnLocalCorpse(deathCam);

  const overlay = document.getElementById('overlay-dead');
  const info = document.getElementById('dead-info');
  const loss = document.querySelector('#overlay-dead .money-loss');
  const banner = document.getElementById('spectate-banner');
  if (info) info.textContent = msg.by ? `by ${msg.by}` : 'eliminated';
  if (loss) {
    loss.textContent = msg.delta ? 'eliminated' : 'no contest';
    loss.style.color = '#ff6bff';
  }
  if (overlay) {
    overlay.classList.remove('hidden', 'phase-fall', 'phase-card', 'phase-spectate');
    overlay.classList.add('phase-fall');
  }
  if (banner) {
    banner.classList.add('hidden');
    const nm = document.getElementById('spectate-name');
    if (nm) nm.textContent = deathCam.killerName;
  }

  tickDeathCountdown();
  if (msg.delta) Audio.cash(false);
  addShake(0.14, 1.8);
}

function tickDeathCountdown() {
  clearTimeout(deathCountTimer);
  if (!deathCam) return;
  const count = document.getElementById('respawn-count');
  const spTimer = document.getElementById('spectate-timer');
  const left = Math.max(0, Math.ceil((deathCam.respawnAt - Date.now()) / 1000));
  if (count) {
    if (!deathCam.canAfford) count.textContent = 'Insufficient funds to respawn';
    else count.textContent = left > 0 ? `Respawning in ${left}…` : 'Respawning…';
  }
  if (spTimer && deathCam.phase === 'spectate') {
    // countdown just the spectate remainder
    const specLeft = Math.max(0, Math.ceil(
      (deathCam.respawnAt - Date.now()) / 1000
    ));
    spTimer.textContent = `${specLeft}s`;
  }
  if (left > 0 && deathCam) {
    deathCountTimer = setTimeout(tickDeathCountdown, 200);
  }
}

function setDeathPhase(phase) {
  if (!deathCam || deathCam.phase === phase) return;
  deathCam.phase = phase;
  deathCam.phaseT = 0;
  const overlay = document.getElementById('overlay-dead');
  if (overlay) {
    overlay.classList.remove('phase-fall', 'phase-card', 'phase-spectate');
    overlay.classList.add('phase-' + phase);
  }
  const banner = document.getElementById('spectate-banner');
  if (banner) {
    const show = phase === 'spectate' && deathCam.killerId;
    banner.classList.toggle('hidden', !show);
  }
}

function updateDeathCam(dt) {
  if (!deathCam) return;
  deathCam.t += dt;
  deathCam.phaseT = (deathCam.phaseT || 0) + dt;

  if (deathCam.phase === 'fall' && deathCam.t >= deathCam.fallS) {
    setDeathPhase('card');
  } else if (deathCam.phase === 'card' && deathCam.phaseT >= deathCam.cardS) {
    if (deathCam.killerId && deathCam.spectateS > 0) setDeathPhase('spectate');
    // else stay on card until respawn
  }

  // Stream terrain around killer while spectating
  if (deathCam.phase === 'spectate' && deathCam.killerId) {
    const kp = findPlayerState(deathCam.killerId);
    if (kp && world) world.ensureAround(kp.x, kp.z, MESH_RADIUS);
  }
}

// Returns true if death cam fully owns the camera this frame
function applyDeathCamera(dt) {
  if (!deathCam || !camera) return false;

  if (deathCam.phase === 'fall' || deathCam.phase === 'card') {
    // First-person collapse: pitch into dirt, roll sideways, drop to ground
    const u = easeOutCubic(Math.min(1, deathCam.t / Math.max(0.05, deathCam.fallS)));
    const groundY = deathCam.y + 0.28;
    const eyeY = deathCam.y + deathCam.eye;
    const camY = eyeY + (groundY - eyeY) * u;
    // Slight backward drift so you "see" yourself fall
    const back = u * 0.35;
    const fx = Math.sin(deathCam.yaw);
    const fz = Math.cos(deathCam.yaw);
    camera.position.set(
      deathCam.x - fx * back * 0.2,
      camY,
      deathCam.z - fz * back * 0.2
    );
    const pitchEnd = 1.15; // face the dirt
    const rollEnd = deathCam.rollDir * 1.25;
    const yawEnd = deathCam.tipYaw;
    camera.rotation.set(
      deathCam.pitch + (pitchEnd - deathCam.pitch) * u,
      deathCam.yaw + (yawEnd - deathCam.yaw) * u * 0.6,
      rollEnd * u
    );
    // Local corpse anim sync
    updateLocalCorpse(u);
    Audio.setListener(camera.position, V.lookDir(camera.rotation.y, camera.rotation.x), { x: 0, y: 1, z: 0 });
    return true;
  }

  if (deathCam.phase === 'spectate' && deathCam.killerId) {
    const kp = findPlayerState(deathCam.killerId);
    if (kp) {
      const eye = kp.crouch ? V.PHYS.CROUCH_EYE : V.PHYS.EYE;
      // Smooth follow so killer motion isn't jerky
      if (deathCam._sx == null) {
        deathCam._sx = kp.x; deathCam._sy = kp.y + eye; deathCam._sz = kp.z;
        deathCam._syaw = kp.yaw; deathCam._spitch = kp.pitch || 0;
      }
      const k = 1 - Math.exp(-dt * 14);
      deathCam._sx += (kp.x - deathCam._sx) * k;
      deathCam._sy += (kp.y + eye - deathCam._sy) * k;
      deathCam._sz += (kp.z - deathCam._sz) * k;
      // angle wrap
      let dy = kp.yaw - deathCam._syaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      deathCam._syaw += dy * k;
      deathCam._spitch += ((kp.pitch || 0) - deathCam._spitch) * k;

      camera.position.set(deathCam._sx, deathCam._sy, deathCam._sz);
      camera.rotation.set(deathCam._spitch, deathCam._syaw, 0);
      const d = V.lookDir(deathCam._syaw, deathCam._spitch);
      Audio.setListener(camera.position, d, { x: 0, y: 1, z: 0 });
      return true;
    }
    // Killer gone/disconnected — hold last fall pose
  }

  // Card-only / no killer: stay on fallen cam
  if (deathCam.phase === 'card' || !deathCam.killerId) {
    camera.position.set(deathCam.x, deathCam.y + 0.28, deathCam.z);
    camera.rotation.set(1.15, deathCam.tipYaw, deathCam.rollDir * 1.25);
    return true;
  }
  return false;
}

function findPlayerState(id) {
  if (!id) return null;
  // Prefer latest snapshot
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const p = snapshots[i].players.find((x) => x.id === id);
    if (p && p.alive) return p;
    if (p) return p; // even if dead, last known
  }
  return null;
}

function endDeathSequence(silent) {
  clearTimeout(deathCountTimer);
  deathCountTimer = null;
  deathCam = null;
  removeLocalCorpse();
  const overlay = document.getElementById('overlay-dead');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.classList.remove('phase-fall', 'phase-card', 'phase-spectate');
  }
  const banner = document.getElementById('spectate-banner');
  if (banner) banner.classList.add('hidden');
  if (!silent) {
    // Don't respawn still staring into the dirt from the fall cam
    pitch = 0;
    aimKickP = 0; aimKickY = 0; aimKickPV = 0; aimKickYV = 0;
    if (viewHolder) viewHolder.visible = true;
    smoothErr.x = smoothErr.y = smoothErr.z = 0;
  }
}

// Local corpse shown during own death fall (third-person body at feet)
let localCorpse = null;
function spawnLocalCorpse(dc) {
  removeLocalCorpse();
  if (!scene) return;
  // Reuse avatar builder shape
  const fake = { id: selfId || 1, u: myName || 'you', pr: '' };
  const av = createAvatar(fake);
  av.group.position.set(dc.x, dc.y, dc.z);
  av.yawGroup.rotation.y = dc.yaw;
  av.plate.visible = false;
  // Dim slightly
  av.group.traverse((o) => {
    if (o.material && o.material.color) {
      o.material = o.material.clone();
      o.material.transparent = true;
      o.material.opacity = 0.95;
    }
  });
  localCorpse = av;
}
function updateLocalCorpse(u) {
  if (!localCorpse) return;
  // Fall onto side
  localCorpse.yawGroup.rotation.z = (Math.PI / 2) * easeOutCubic(u);
  localCorpse.yawGroup.rotation.x = 0.15 * u;
  localCorpse.group.position.y = deathCam.y + 0.05 * u;
}
function removeLocalCorpse() {
  if (!localCorpse) return;
  scene.remove(localCorpse.group);
  localCorpse.group.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
      else {
        o.material.map?.dispose?.();
        o.material.dispose?.();
      }
    }
  });
  localCorpse = null;
}

function triggerRemoteDeath(id, x, y, z, yaw) {
  let av = remote.get(id);
  if (!av) {
    // create placeholder corpse from last known / given pose
    av = createAvatar({ id, u: '…', pr: '' });
    remote.set(id, av);
  }
  av.dead = true;
  av.deathT = 0;
  av.deathFall = 0;
  if (x != null) av.group.position.set(x, y, z);
  if (yaw != null) av.yawGroup.rotation.y = yaw;
  av.group.visible = true;
  av.plate.visible = false;
  av.deathRoll = Math.random() < 0.5 ? 1 : -1;
}

function addKillFeed(killer, victim, headshot, weapon, zoneLabel) {
  const w = weapon ? `<span class="v"> · ${(weaponDef(weapon).name || weapon)}</span>` : '';
  const zl = (zoneLabel || '').toUpperCase();
  const mark = (zl === 'BRAIN' || zl === 'HEART' || headshot)
    ? `<span class="hs">${zl === 'BRAIN' ? '◈' : zl === 'HEART' ? '♥' : '☠'}</span>`
    : '▸';
  const zone = zl ? ` <span class="hs">${esc(zl)}</span>` : '';
  addFeedNode(`<b>${esc(killer)}</b> ${mark} <span class="v">${esc(victim)}</span>${zone}${w}`);
}
function addFeedLine(text) { addFeedNode(`<span class="v">${esc(text)}</span>`); }
function addFeedNode(html) {
  const feed = document.getElementById('killfeed');
  const el = document.createElement('div');
  el.className = 'kf';
  el.innerHTML = html;
  feed.appendChild(el);
  while (feed.children.length > 5) feed.firstChild.remove();
  setTimeout(() => el.remove(), 6000);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Debug surface. Netcode problems are invisible from the outside — this
// exposes enough state to tell "the client never sent it" apart from "the
// server rejected it" without attaching a debugger.
function debug() {
  return {
    running, havePosition, lookFallback,
    locked: document.pointerLockElement === canvas,
    firing, aiming, weapon: currentWeapon, adsBlend: +adsBlend.toFixed(2),
    keys: { ...keys },
    pos: { x: +me.x.toFixed(2), y: +me.y.toFixed(2), z: +me.z.toFixed(2) },
    onGround: me.onGround, crouching: !!me.crouching,
    yaw: +yaw.toFixed(2), pitch: +pitch.toFixed(2),
    inputSeq, pendingInputs: pending.length,
    lastMispredict: +lastMispredict.toFixed(4),
    smoothErr: +Math.hypot(smoothErr.x, smoothErr.y, smoothErr.z).toFixed(4),
    ammo, reloadingMs, latency, remotePlayers: remote.size,
    audio: {
      state: Audio.context ? Audio.context.state : 'none',
      enabled: Audio.isEnabled(),
      voices: Audio.voices,
    },
  };
}

// Test hook: lets the audio output be tapped and measured, so "is it actually
// making sound" is answerable without a pair of ears.
window.__bountyAudio = Audio;

function setMusicEnabled(on) {
  settings.music = on !== false;
  saveSettings();
  Audio.setMusicEnabled?.(settings.music);
}

window.BountyGame = {
  connect, leave, debug, settings, saveSettings, applyGraphicsSettings, setMusicEnabled,
};
