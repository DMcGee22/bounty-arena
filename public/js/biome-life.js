// Living biome FX — grass, bushes, soft trees, weather. Visual-only.
// (No neon light pillars / orbiting point lights — those looked bad.)

import * as THREE from '/vendor/three.module.js';

const _tmp = new THREE.Object3D();

function hash(x, z, s) {
  let h = (x | 0) * 374761393 + (z | 0) * 668265263 + (s | 0) * 1442695040;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class BiomeLife {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'biomeLife';
    scene.add(this.root);

    this.themeId = 'neon';
    this.t = 0;
    this.player = new THREE.Vector3();
    this.quality = 'high';

    this.grass = null;
    this.bushes = null;
    this.weather = null;
    this.embers = null;
    this.dust = null;
    this.snow = null;
    this.wisps = null;
    this.trees = null;

    this._builtFor = '';
  }

  setQuality(q) {
    this.quality = q || 'high';
  }

  clearLayer(name) {
    const g = this[name];
    if (!g) return;
    this.root.remove(g);
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
    this[name] = null;
  }

  clearAll() {
    for (const k of ['grass', 'bushes', 'weather', 'embers', 'dust', 'snow', 'wisps', 'trees']) {
      this.clearLayer(k);
    }
    this._builtFor = '';
  }

  setTheme(themeId) {
    if (themeId === this.themeId && this._builtFor === themeId) return;
    this.themeId = themeId || 'neon';
    this.rebuild();
  }

  rebuild() {
    this.clearAll();
    const id = this.themeId;
    this._builtFor = id;
    const low = this.quality === 'low';

    if (id === 'forest' || id === 'farm' || id === 'wilds' || id === 'coast') {
      this.grass = this._makeGrass(id, low ? 900 : 2200);
      this.root.add(this.grass);
      this.bushes = this._makeBushes(id, low ? 80 : 180);
      this.root.add(this.bushes);
    }
    if (id === 'forest' || id === 'wilds') {
      this.trees = this._makeSoftTrees(id, low ? 40 : 90);
      this.root.add(this.trees);
    }
    // No floating neon light pillars / point lights — they read as trash props.
    if (id === 'volcanic') {
      this.embers = this._makeParticles(0xff5522, low ? 120 : 280, 0.08);
      this.root.add(this.embers);
    }
    if (id === 'desert' || id === 'canyon' || id === 'farm') {
      this.dust = this._makeParticles(0xc9a86a, low ? 80 : 180, 0.12);
      this.root.add(this.dust);
    }
    if (id === 'snow') {
      this.snow = this._makeParticles(0xe8f2ff, low ? 160 : 360, 0.06);
      this.root.add(this.snow);
    }
    if (id === 'storm' || id === 'coast') {
      this.weather = this._makeRain(id === 'coast' ? 0xa0d0ff : 0x88aaff, low ? 200 : 500);
      this.root.add(this.weather);
    }
    if (id === 'void') {
      this.wisps = this._makeParticles(0xb060ff, low ? 60 : 140, 0.1);
      this.root.add(this.wisps);
    }
  }

  _makeGrass(themeId, count) {
    const blade = new THREE.BufferGeometry();
    // Simple cross-plane blade (two quads)
    const hw = 0.07, h = 0.38;
    const pos = new Float32Array([
      -hw, 0, 0,  hw, 0, 0,  hw, h, 0,  -hw, h, 0,
      0, 0, -hw,  0, 0, hw,  0, h, hw,  0, h, -hw,
    ]);
    const idx = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const nrm = new Float32Array(8 * 3);
    for (let i = 0; i < 8; i++) { nrm[i * 3 + 1] = 1; }
    blade.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    blade.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    blade.setIndex(new THREE.BufferAttribute(idx, 1));

    let color = 0x3d9a45;
    if (themeId === 'farm') color = 0x6a9a3a;
    if (themeId === 'coast') color = 0x4a8a58;
    if (themeId === 'wilds') color = 0x4aab52;

    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.92,
      metalness: 0.0,
      side: THREE.DoubleSide,
      flatShading: true,
    });
    const mesh = new THREE.InstancedMesh(blade, mat, count);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.count = count;
    mesh.userData.kind = 'grass';
    mesh.userData.theme = themeId;
    // Initialize off-screen
    _tmp.scale.set(0, 0, 0);
    _tmp.updateMatrix();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, _tmp.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  _makeBushes(themeId, count) {
    const geo = new THREE.SphereGeometry(0.45, 6, 5);
    let color = 0x2d6b34;
    if (themeId === 'farm') color = 0x5a7a30;
    if (themeId === 'coast') color = 0x2a6040;
    if (themeId === 'wilds') color = 0x356b3a;
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.95,
      metalness: 0.0,
      flatShading: true,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.count = count;
    mesh.userData.kind = 'bush';
    _tmp.scale.set(0, 0, 0);
    _tmp.updateMatrix();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, _tmp.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  _makeSoftTrees(themeId, count) {
    const g = new THREE.Group();
    // Crossed billboard canopy + trunk as one merged-ish instance using two instanced meshes
    const trunkGeo = new THREE.CylinderGeometry(0.08, 0.14, 1.6, 5);
    const canopyGeo = new THREE.SphereGeometry(0.85, 6, 5);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.9, metalness: 0.05 });
    const leafCol = themeId === 'wilds' ? 0x2f8a3a : 0x1f6a2c;
    const leafMat = new THREE.MeshStandardMaterial({ color: leafCol, roughness: 0.88, metalness: 0.0, flatShading: true });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    const canopies = new THREE.InstancedMesh(canopyGeo, leafMat, count);
    trunks.frustumCulled = false;
    canopies.frustumCulled = false;
    trunks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    canopies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    trunks.userData.count = count;
    canopies.userData.count = count;
    trunks.userData.kind = 'trunk';
    canopies.userData.kind = 'canopy';
    _tmp.scale.set(0, 0, 0);
    _tmp.updateMatrix();
    for (let i = 0; i < count; i++) {
      trunks.setMatrixAt(i, _tmp.matrix);
      canopies.setMatrixAt(i, _tmp.matrix);
    }
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    g.add(trunks);
    g.add(canopies);
    g.userData.trunks = trunks;
    g.userData.canopies = canopies;
    g.userData.count = count;
    return g;
  }

  _makeParticles(color, count, size) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = 0; pos[i * 3 + 1] = -99; pos[i * 3 + 2] = 0;
      vel[i * 3] = (Math.random() - 0.5) * 0.4;
      vel[i * 3 + 1] = Math.random() * 0.5 + 0.1;
      vel[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color, size, transparent: true, opacity: 0.75,
      depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.userData.vel = vel;
    pts.userData.count = count;
    return pts;
  }

  _makeRain(color, count) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = 0; pos[i * 3 + 1] = -99; pos[i * 3 + 2] = 0;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color, size: 0.08, transparent: true, opacity: 0.55,
      depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.userData.count = count;
    pts.userData.kind = 'rain';
    return pts;
  }

  /**
   * Place soft props near the player using world surface heights.
   * world: BountyVoxel.World, px/pz player position
   */
  update(dt, world, px, py, pz) {
    this.t += dt;
    this._dt = dt;
    this.player.set(px, py, pz);
    if (!world) return;

    const seed = (world.seed + (world.epoch | 0) * 91) | 0;

    if (this.grass) this._scatterGround(this.grass, world, px, pz, seed, 28, 0.55, 1);
    if (this.bushes) this._scatterGround(this.bushes, world, px, pz, seed + 3, 34, 0.35, 0.7);
    if (this.trees) this._scatterTrees(world, px, pz, seed + 9, 48);
    if (this.particlesEnabled !== false) {
      if (this.embers) this._updateFloatParticles(this.embers, px, py, pz, 22, 0.6, 2.2, true);
      if (this.dust) this._updateFloatParticles(this.dust, px, py, pz, 30, 0.15, 0.5, false);
      if (this.snow) this._updateFloatParticles(this.snow, px, py, pz, 28, -0.9, 0.2, false);
      if (this.wisps) this._updateFloatParticles(this.wisps, px, py, pz, 20, 0.35, 1.4, true);
      if (this.weather) this._updateRain(this.weather, px, py, pz, 26);
    }

    // Soft grass sway only — no emissive pillar/hue thrash
    if (this.grass?.material) {
      const wind = 0.97 + Math.sin(this.t * 1.8) * 0.03;
      this.grass.material.emissive = this.grass.material.emissive || new THREE.Color(0x000000);
      this.grass.material.emissive.setRGB(0.015 * wind, 0.03 * wind, 0.008);
    }
  }

  _scatterGround(mesh, world, px, pz, seed, radius, dens, yScale) {
    const count = mesh.userData.count | 0;
    const cs = world.chunkSize || 16;
    let i = 0;
    // Deterministic ring of samples around player
    const step = Math.max(1.2, radius / Math.sqrt(count));
    const x0 = Math.floor(px - radius);
    const z0 = Math.floor(pz - radius);
    const x1 = Math.ceil(px + radius);
    const z1 = Math.ceil(pz + radius);
    for (let z = z0; z <= z1 && i < count; z += step) {
      for (let x = x0; x <= x1 && i < count; x += step) {
        const jx = x + (hash(x | 0, z | 0, seed) - 0.5) * step;
        const jz = z + (hash(z | 0, x | 0, seed + 1) - 0.5) * step;
        const dx = jx - px, dz = jz - pz;
        if (dx * dx + dz * dz > radius * radius) continue;
        if (hash(jx | 0, jz | 0, seed + 2) > dens) continue;
        // Skip hub plaza hardscape
        if (Math.hypot(jx, jz) < 16) continue;
        world.ensureAround(jx, jz, 1);
        const sy = world.solidSurfaceY(jx, jz);
        // Prefer grass-like tops
        const top = world.get(Math.floor(jx), sy - 1, Math.floor(jz));
        if (top !== 1 /* GRASS */ && top !== 2 /* DIRT */ && this.themeId !== 'wilds') {
          if (this.themeId === 'coast' && top !== 8 /* SAND */) continue;
          if (this.themeId !== 'farm' && this.themeId !== 'forest') continue;
        }
        const s = 0.7 + hash(jx | 0, jz | 0, seed + 5) * 0.9;
        _tmp.position.set(jx, sy, jz);
        _tmp.rotation.set(0, hash(jx | 0, jz | 0, seed + 6) * Math.PI * 2, 0);
        // Wind lean
        _tmp.rotation.x = Math.sin(this.t * 1.7 + jx * 0.3) * 0.08;
        _tmp.rotation.z = Math.cos(this.t * 1.3 + jz * 0.25) * 0.06;
        _tmp.scale.set(s, s * yScale * (0.85 + hash(jx | 0, jz | 0, seed + 7) * 0.4), s);
        _tmp.updateMatrix();
        mesh.setMatrixAt(i++, _tmp.matrix);
      }
    }
    // Hide unused
    _tmp.scale.set(0, 0, 0);
    _tmp.position.set(0, -99, 0);
    _tmp.updateMatrix();
    while (i < count) mesh.setMatrixAt(i++, _tmp.matrix);
    mesh.instanceMatrix.needsUpdate = true;
  }

  _scatterTrees(world, px, pz, seed, radius) {
    const g = this.trees;
    if (!g) return;
    const trunks = g.userData.trunks;
    const canopies = g.userData.canopies;
    const count = g.userData.count | 0;
    let i = 0;
    const step = Math.max(3.5, radius / Math.sqrt(count * 0.7));
    for (let z = Math.floor(pz - radius); z <= pz + radius && i < count; z += step) {
      for (let x = Math.floor(px - radius); x <= px + radius && i < count; x += step) {
        const jx = x + (hash(x, z, seed) - 0.5) * step;
        const jz = z + (hash(z, x, seed + 1) - 0.5) * step;
        if ((jx - px) ** 2 + (jz - pz) ** 2 > radius * radius) continue;
        if (Math.hypot(jx, jz) < 20) continue;
        if (hash(jx | 0, jz | 0, seed + 2) > 0.42) continue;
        world.ensureAround(jx, jz, 1);
        const sy = world.solidSurfaceY(jx, jz);
        const h = 1.3 + hash(jx | 0, jz | 0, seed + 3) * 1.4;
        const sc = 0.85 + hash(jx | 0, jz | 0, seed + 4) * 0.5;
        _tmp.position.set(jx, sy + h * 0.5, jz);
        _tmp.rotation.set(0, hash(jx | 0, jz | 0, seed + 5) * 6.28, 0);
        _tmp.scale.set(sc, h / 1.6 * sc, sc);
        _tmp.updateMatrix();
        trunks.setMatrixAt(i, _tmp.matrix);
        const cs = 0.9 + hash(jx | 0, jz | 0, seed + 6) * 0.7;
        _tmp.position.set(jx, sy + h * 0.95, jz);
        _tmp.scale.set(cs, cs * 0.85, cs);
        _tmp.updateMatrix();
        canopies.setMatrixAt(i, _tmp.matrix);
        i++;
      }
    }
    _tmp.scale.set(0, 0, 0);
    _tmp.position.set(0, -99, 0);
    _tmp.updateMatrix();
    while (i < count) {
      trunks.setMatrixAt(i, _tmp.matrix);
      canopies.setMatrixAt(i, _tmp.matrix);
      i++;
    }
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
  }

  _updateFloatParticles(pts, px, py, pz, radius, vyBase, _lift, swirl) {
    const pos = pts.geometry.attributes.position.array;
    const vel = pts.userData.vel;
    const count = pts.userData.count | 0;
    const dt = Math.min(0.05, this._dt || 0.016);
    for (let i = 0; i < count; i++) {
      let x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (y < py - 8 || y > py + 18 || (x - px) ** 2 + (z - pz) ** 2 > radius * radius) {
        x = px + (Math.random() - 0.5) * radius * 2;
        y = py + Math.random() * 10;
        z = pz + (Math.random() - 0.5) * radius * 2;
        vel[i * 3] = (Math.random() - 0.5) * 0.5;
        vel[i * 3 + 1] = vyBase * (0.5 + Math.random());
        vel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
      }
      if (swirl) {
        vel[i * 3] += Math.sin(this.t + i) * 0.35 * dt;
        vel[i * 3 + 2] += Math.cos(this.t + i * 0.7) * 0.35 * dt;
      }
      x += vel[i * 3] * dt * 8;
      y += vel[i * 3 + 1] * dt;
      z += vel[i * 3 + 2] * dt * 8;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
    }
    pts.geometry.attributes.position.needsUpdate = true;
  }

  _updateRain(pts, px, py, pz, radius) {
    const pos = pts.geometry.attributes.position.array;
    const count = pts.userData.count | 0;
    const dt = Math.min(0.05, this._dt || 0.016);
    const speed = 14;
    for (let i = 0; i < count; i++) {
      let x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      y -= speed * dt;
      if (y < py - 2 || (x - px) ** 2 + (z - pz) ** 2 > radius * radius) {
        x = px + (Math.random() - 0.5) * radius * 2;
        y = py + 8 + Math.random() * 10;
        z = pz + (Math.random() - 0.5) * radius * 2;
      }
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
    }
    pts.geometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.clearAll();
    this.scene.remove(this.root);
  }
}

export default BiomeLife;
