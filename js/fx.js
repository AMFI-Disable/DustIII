// fx.js — visual effects for DUST (CS2-faithful Dust2 5v5). three.js r170.
//
//   const fx = new FX({ scene, renderer, camera, world });
//   await fx.load();
//   // every frame, before rendering:
//   fx.update(dt, camera);
//
// Rendering cost: 3 draw calls total (particles, decals, shell casings) + 1 for the in-smoke overlay when the
// camera is inside a smoke. All particles (smoke, fire, sparks, flashes, tracers, blood, dust…) live in one
// globally back-to-front sorted instanced batch, so they composite correctly against each other.
//
// SOFT PARTICLES / DEPTH: by default FX captures the opaque scene depth automatically (blit of the bound
// framebuffer's depth right before the particle draw — works with direct rendering and with an EffectComposer
// RenderPass, MSAA included). Engines with their own depth pre-pass can instead call
//     fx.setDepthTexture(depthTexture, near, far)   // a THREE.DepthTexture NOT attached to the target FX draw into
// and fx.setDepthTexture(null) to return to automatic capture. fx.autoDepth = false disables both (FX then use
// geometric soft fades only).
//
// LIGHTING: FX read the first DirectionalLight / HemisphereLight in the scene (+ scene.environment estimate)
// automatically; override with fx.setLighting({ sunDir, sunColor, skyColor, groundColor }) (colours are
// irradiance-like linear RGB, i.e. color * intensity).
//
// FX OWN 4 PointLights (always in the scene, intensity 0 when idle, never added/removed → no shader recompiles).
import * as THREE from 'three';
import { buildFXTextures, CELL, DECAL } from './fx_atlas.js';
import { ParticleSystem, PSpec, M_BILL, M_AXIAL, M_FLAT, M_PIVOT } from './fx_particles.js';
import { DecalSystem } from './fx_decals.js';
import { DepthGrabber } from './fx_depth.js';
import { SmokeCloud } from './fx_smoke.js';
import { Fire } from './fx_fire.js';
import { RNG, clamp, smoothstep, distSqPointSegment, clipSegmentAABB } from './fx_util.js';

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _n1 = new THREE.Vector3(), _t1 = new THREE.Vector3(), _b1 = new THREE.Vector3();
const _col = new THREE.Color(), _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s3 = new THREE.Vector3(), _e = new THREE.Euler();
const _clip = [0, 0];

// ------------------------------------------------------------------------------------------- lights
class LightPool {
  constructor(scene, n = 4) {
    this.slots = [];
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 400, 2);
      l.castShadow = false; l.name = 'fx_light_' + i; l.matrixAutoUpdate = true;
      scene.add(l);
      this.slots.push({ i, light: l, owner: null, prio: -1, flash: false, t0: 0, dur: 0, peak: 0, r: 1, g: 1, b: 1, range: 400, I: 0, touched: 0 });
    }
    this.now = 0;
  }
  acquire(owner, prio) {
    let best = null;
    for (const s of this.slots) if (!s.owner) { best = s; break; }
    if (!best) {
      for (const s of this.slots) {
        if (s.prio < prio || (s.prio === prio && s.flash)) {
          if (!best || s.prio < best.prio || (s.prio === best.prio && s.t0 < best.t0)) best = s;
        }
      }
    }
    if (!best) return null;
    best.owner = owner; best.prio = prio; best.flash = false; best.t0 = this.now; best.I = 0;
    return best;
  }
  set(s, pos, r, g, b, I, range) {
    s.light.position.copy(pos); s.r = r; s.g = g; s.b = b; s.I = I; s.range = range; s.touched = this.now;
  }
  flash(pos, r, g, b, peak, range, dur, prio) {
    const s = this.acquire('flash', prio); if (!s) return null;
    s.flash = true; s.t0 = this.now; s.dur = dur; s.peak = peak;
    this.set(s, pos, r, g, b, peak, range);
    return s;
  }
  release(s) { s.owner = null; s.prio = -1; s.I = 0; s.flash = false; }
  update(now, uPos, uCol) {
    this.now = now;
    for (const s of this.slots) {
      if (s.owner && s.flash) {
        const u = (now - s.t0) / s.dur;
        if (u >= 1) this.release(s); else s.I = s.peak * (1 - u) * (1 - u);
      } else if (s.owner && now - s.touched > 0.25) this.release(s);   // owner stopped driving it
      const l = s.light;
      l.intensity = s.owner ? s.I : 0; l.distance = s.range; l.color.setRGB(s.r, s.g, s.b);
      const k = s.i;
      uPos.value[k].set(l.position.x, l.position.y, l.position.z, s.range);
      uCol.value[k].set(s.r * l.intensity, s.g * l.intensity, s.b * l.intensity);
    }
  }
  clear() { for (const s of this.slots) this.release(s); }
}

// ------------------------------------------------------------------------------------------- surfaces
const SURF_COLORS = {
  plaster: { dust: [0.74, 0.66, 0.54], chip: [0.82, 0.74, 0.62], decal: DECAL.HOLE, tint: [1, 1, 1], size: [5, 7.5] },
  stone: { dust: [0.6, 0.53, 0.43], chip: [0.62, 0.55, 0.45], decal: DECAL.HOLE, tint: [0.8, 0.76, 0.7], size: [4.5, 6.5] },
  sand: { dust: [0.66, 0.52, 0.34], chip: [0.6, 0.47, 0.3], decal: DECAL.DENT, tint: [0.62, 0.5, 0.36], size: [5, 7] },
  wood: { dust: [0.42, 0.31, 0.19], chip: [0.58, 0.42, 0.25], decal: DECAL.HOLE_WOOD, tint: [1, 1, 1], size: [5, 7] },
  metal: { dust: [0.42, 0.42, 0.42], chip: [0.5, 0.5, 0.5], decal: DECAL.HOLE_METAL, tint: [1, 1, 1], size: [3.6, 5] },
  glass: { dust: [0.8, 0.82, 0.84], chip: [0.85, 0.9, 0.92], decal: DECAL.HOLE, tint: [0.9, 0.95, 1], size: [4, 6] },
};
function surfaceClass(s) {
  if (!s) return 'plaster';
  s = String(s).toLowerCase();
  if (SURF_COLORS[s]) return s;
  if (/wood|crate|plank|door|box_w|barrel_w/.test(s)) return 'wood';
  if (/metal|steel|iron|tin|pipe|vent|grate|car|rail/.test(s)) return 'metal';
  if (/sand|dirt|ground|gravel|soil|mud/.test(s)) return 'sand';
  if (/glass|window/.test(s)) return 'glass';
  if (/stone|rock|cobble|flag|brick|concrete|tile|roof|block|cement|asphalt/.test(s)) return 'stone';
  return 'plaster';
}

// ------------------------------------------------------------------------------------------- FX
export class FX {
  constructor({ scene, renderer, camera, world }) {
    this.scene = scene; this.renderer = renderer; this.camera = camera; this.world = world || null;
    this.rng = new RNG(1337);
    this.time = 0; this.loaded = false;
    this.autoDepth = true; this.autoExtinguish = true;
    this.rayBudget = 32;   // max world raycasts per 1/60 s for all spreading smokes / fires together (flood fill)
    this._rayStop = 0;
    this._down = new THREE.Vector3(0, -1, 0); this._up = new THREE.Vector3(0, 1, 0);
    this.sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
    this.lights = new LightPool(scene, 4);
    this.smokes = []; this.fires = []; this.c4lights = [];
    this.holes = []; for (let i = 0; i < 12; i++) this.holes.push({ ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, r0: 0, r: 0, s: 0, t0: -1, dur: 1, sphere: false });
    this._lineHole = 0; this._sphHole = 0;
    this._sp = new PSpec();
    this.stats = { rays: 0, particles: 0, cpuMs: 0 };
    this._lightOverride = null; this._manualDepth = null;
    this._sun = null; this._hemi = null; this._envEst = null; this._scanT = -1;
    this.tracers = [];
    this.uniforms = {
      uSunDir: { value: this.sunDir }, uSunColor: { value: new THREE.Color(3, 2.85, 2.6) },
      uSkyColor: { value: new THREE.Color(1.2, 1.3, 1.5) }, uGroundColor: { value: new THREE.Color(0.8, 0.68, 0.52) },
      uPLPos: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, -1e5, 0, 1)) },
      uPLCol: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
      uDepth: { value: null }, uDepthParams: { value: new THREE.Vector4(0, 1, 1000, 0) }, uInvRes: { value: new THREE.Vector2(1, 1) },
      uHoleA: { value: this.holes.map(() => new THREE.Vector4()) }, uHoleB: { value: this.holes.map(() => new THREE.Vector4()) },
    };
  }

  seed(n) { this.rng.seed(n); }

  async load(base = 'assets/fx/') {
    const tex = (this.tex = await buildFXTextures(base));
    this.P = new ParticleSystem(6144, tex, this.uniforms);
    this.decals = new DecalSystem(tex);
    this.depth = new DepthGrabber(this.renderer);
    this.uniforms.uDepth.value = this.depth.texture;
    const self = this;
    this.P.mesh.onBeforeRender = function (renderer, scene, camera) { self._beforeParticles(renderer, camera); };
    this.scene.add(this.decals.mesh);
    this.scene.add(this.P.mesh);
    this._makeOverlay();
    this._makeShells();
    this.loaded = true;
    this._scanLights();
  }

  // ---------------------------------------------------------------- public config hooks
  setDepthTexture(tex, near, far) {
    this._manualDepth = tex ? { tex, near, far } : null;
  }
  setLighting(o) { this._lightOverride = o ? Object.assign({}, o) : null; }

  // ---------------------------------------------------------------- world access
  _ray(origin, dir, maxDist) {
    this.stats.rays++;
    const w = this.world; if (!w || !w.raycast) return null;
    return w.raycast(origin, dir, maxDist);
  }
  _groundY(x, y, z, maxDist) {
    _v4.set(x, y, z); const h = this._ray(_v4, this._down, maxDist); return h ? h.point.y : null;
  }

  // ---------------------------------------------------------------- lighting
  _scanLights() {
    this._sun = null; this._hemi = null;
    this.scene.traverse((o) => {
      if (!this._sun && o.isDirectionalLight && o.visible) this._sun = o;
      if (!this._hemi && o.isHemisphereLight && o.visible) this._hemi = o;
    });
    // estimate environment radiance (upper / lower hemisphere) from an equirect background image if any
    this._envEst = null;
    const bg = this.scene.background;
    if (this.scene.environment && bg && bg.isTexture && bg.image && bg.image.width) {
      try {
        const c = document.createElement('canvas'); c.width = 32; c.height = 16;
        const ctx = c.getContext('2d'); ctx.drawImage(bg.image, 0, 0, 32, 16);
        const d = ctx.getImageData(0, 0, 32, 16).data; const up = [0, 0, 0], dn = [0, 0, 0];
        const dec = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        for (let j = 0; j < 16; j++) for (let i = 0; i < 32; i++) {
          const o = (j * 32 + i) * 4, acc = j < 8 ? up : dn;
          acc[0] += dec(d[o]); acc[1] += dec(d[o + 1]); acc[2] += dec(d[o + 2]);
        }
        for (let k = 0; k < 3; k++) { up[k] /= 256; dn[k] /= 256; }
        this._envEst = { up, dn };
      } catch (e) { this._envEst = null; }
    }
  }
  _updateLighting() {
    const U = this.uniforms;
    const o = this._lightOverride;
    if (o) {
      if (o.sunDir) this.sunDir.copy(o.sunDir).normalize();
      if (o.sunColor) U.uSunColor.value.copy(o.sunColor);
      if (o.skyColor) U.uSkyColor.value.copy(o.skyColor);
      if (o.groundColor) U.uGroundColor.value.copy(o.groundColor);
      return;
    }
    if (this.time > this._scanT) { this._scanT = this.time + 2; if (!this._sun) this._scanLights(); }
    const s = this._sun;
    if (s) {
      s.updateMatrixWorld(); s.target.updateMatrixWorld();
      _v1.setFromMatrixPosition(s.matrixWorld); _v2.setFromMatrixPosition(s.target.matrixWorld);
      this.sunDir.subVectors(_v1, _v2).normalize();
      U.uSunColor.value.copy(s.color).multiplyScalar(s.intensity);
    }
    const sky = U.uSkyColor.value, gr = U.uGroundColor.value;
    if (this._hemi) {
      sky.copy(this._hemi.color).multiplyScalar(this._hemi.intensity);
      gr.copy(this._hemi.groundColor).multiplyScalar(this._hemi.intensity);
    } else { sky.setRGB(0.25, 0.28, 0.33); gr.setRGB(0.2, 0.17, 0.13); }
    // sun bounce off the bright desert floor (the env map alone underestimates it for floating smoke)
    if (s) { const sc = U.uSunColor.value; gr.r += sc.r * 0.42; gr.g += sc.g * 0.36; gr.b += sc.b * 0.27; }
    if (this.scene.environment) {
      const ei = (this.scene.environmentIntensity ?? 1) * Math.PI;
      const e = this._envEst || { up: [0.55, 0.62, 0.75], dn: [0.35, 0.3, 0.24] };
      sky.r += e.up[0] * ei; sky.g += e.up[1] * ei; sky.b += e.up[2] * ei;
      gr.r += e.dn[0] * ei; gr.g += e.dn[1] * ei; gr.b += e.dn[2] * ei;
    }
  }

  // ---------------------------------------------------------------- depth hook (called by the particle mesh)
  _beforeParticles(renderer, camera) {
    const U = this.uniforms, dp = U.uDepthParams.value;
    dp.y = camera.near; dp.z = camera.far;
    if (!this.autoDepth || !camera.isPerspectiveCamera) { dp.x = 0; return; }
    if (this._manualDepth) {
      const m = this._manualDepth; U.uDepth.value = m.tex; dp.x = 1;
      if (m.near != null) dp.y = m.near; if (m.far != null) dp.z = m.far;
      const img = m.tex.image; if (img && img.width) U.uInvRes.value.set(1 / img.width, 1 / img.height);
      return;
    }
    const ok = this.depth.grab();
    U.uDepth.value = this.depth.texture;
    dp.x = ok ? 1 : 0;
    if (ok) U.uInvRes.value.set(1 / this.depth.w, 1 / this.depth.h);
  }

  // ---------------------------------------------------------------- smoke holes
  addSmokeHole(a, b, r, dur, sphere) {
    let i;
    if (sphere) { i = 10 + this._sphHole; this._sphHole = (this._sphHole + 1) % 2; }
    else { i = this._lineHole; this._lineHole = (this._lineHole + 1) % 10; }
    const H = this.holes[i];
    H.ax = a.x; H.ay = a.y; H.az = a.z; H.bx = b.x; H.by = b.y; H.bz = b.z;
    H.r0 = r; H.r = sphere ? r * 0.2 : r; H.s = 1; H.t0 = this.time; H.dur = dur; H.sphere = sphere;
  }
  _updateHoles() {
    const A = this.uniforms.uHoleA.value, B = this.uniforms.uHoleB.value;
    for (let i = 0; i < 12; i++) {
      const H = this.holes[i];
      if (H.t0 >= 0) {
        const age = this.time - H.t0;
        if (H.sphere) {
          H.r = H.r0 * (0.2 + 0.8 * smoothstep(0, 0.15, age)) * (1 - 0.35 * smoothstep(H.dur, H.dur + 1.4, age));
          H.s = 1 - smoothstep(H.dur, H.dur + 1.4, age);
          if (age > H.dur + 1.4) { H.s = 0; H.t0 = -1; }
        } else {
          const u = age / H.dur;
          H.s = 1 - smoothstep(0.3, 1, u); H.r = H.r0 * (1 - 0.35 * u);
          if (u >= 1) { H.s = 0; H.t0 = -1; }
        }
      } else H.s = 0;
      A[i].set(H.ax, H.ay, H.az, H.r); B[i].set(H.bx, H.by, H.bz, H.s);
    }
  }
  _distSqSeg(x, y, z, H) { return distSqPointSegment(x, y, z, H.ax, H.ay, H.az, H.bx, H.by, H.bz); }
  _holeFactor(x, y, z) {
    let f = 1;
    for (let i = 0; i < 12; i++) {
      const H = this.holes[i]; if (H.s <= 0) continue;
      const d = Math.sqrt(this._distSqSeg(x, y, z, H));
      f *= 1 - H.s * (1 - smoothstep(H.r * 0.55, H.r * 1.35, d));
    }
    return f;
  }
  // Every bullet that crosses a smoke should call this (cheap bbox early-out). tracer() calls it automatically.
  smokeBullet(from, to, radius = 9, duration = 1.1) {
    for (const s of this.smokes) {
      if (!s.alive) continue; const h = s.half;
      if (clipSegmentAABB(from.x, from.y, from.z, to.x, to.y, to.z, s.ox - h, s.minY, s.oz - h, s.ox + h, s.maxY, s.oz + h, _clip)) {
        // keep the carved segment local to the cloud (+ margin) for precision
        const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, L = Math.hypot(dx, dy, dz) || 1, m = 40 / L;
        const t0 = Math.max(0, _clip[0] - m), t1 = Math.min(1, _clip[1] + m);
        _v1.set(from.x + dx * t0, from.y + dy * t0, from.z + dz * t0); _v2.set(from.x + dx * t1, from.y + dy * t1, from.z + dz * t1);
        this.addSmokeHole(_v1, _v2, radius, duration, false);
      }
    }
  }

  // ---------------------------------------------------------------- smoke API
  smoke(pos, opts) {
    if (!this.loaded) return { pos, alive: false, density: () => 0, segmentOpacity: () => 0, clearRadius() {}, carveLine() {}, dispose() {} };
    const s = new SmokeCloud(this, pos, opts);
    this.smokes.push(s);
    // canister pop: a few fast small puffs
    const sp = this._sp, rng = this.rng;
    for (let i = 0; i < 6; i++) {
      sp.reset(); sp.x = s.ox; sp.y = s.gy + 8; sp.z = s.oz;
      rng.unit(_v1); _v1.y = Math.abs(_v1.y) * 0.6 + 0.2;
      sp.vx = _v1.x * 260; sp.vy = _v1.y * 260; sp.vz = _v1.z * 260; sp.drag = 5;
      sp.life = rng.range(0.6, 0.9); sp.s0 = 6; sp.s1 = 34; sp.sPow = 2; sp.cell = CELL.SMOKE0 + rng.int(16);
      sp.r = sp.g = sp.b = 0.62; sp.a = 0.7; sp.fadeIn = 0.05; sp.fadeOut = 0.4; sp.rot = rng.range(0, 6.28); sp.phase = 0.8;
      this.P.emit(sp);
    }
    return s.handle;
  }
  smokeLineBlocked(a, b) { return this.smokeOpacity(a, b) > 0.9; }
  smokeOpacity(a, b) {
    let T = 1;
    for (const s of this.smokes) if (s.alive) { T *= 1 - s.segmentOpacity(a, b); if (T < 0.01) return 1; }
    return 1 - T;
  }
  smokeDensity(p) {
    let d = 0; for (const s of this.smokes) if (s.alive) d += s.density(p);
    return Math.min(1, d);
  }
  _smokeExtinguish(cloud) {
    if (!this.autoExtinguish) return;
    for (const f of this.fires) {
      if (!f.alive || f.ext >= 0) continue;
      const dx = f.ox - cloud.ox, dz = f.oz - cloud.oz;
      if (dx * dx + dz * dz > (cloud.R + 20) * (cloud.R + 20)) continue;
      if (cloud._densRaw(f.ox, f.gy + 20, f.oz) > 0.05 || dx * dx + dz * dz < 50 * 50) f.extinguish();
    }
  }

  // ---------------------------------------------------------------- fire API
  fire(pos, { team = 't', radius, duration } = {}) {
    if (!this.loaded) return { alive: false, pos, team, damageAt: () => false, extinguish() {} };
    const f = new Fire(this, pos, { team, radius, duration });
    this.fires.push(f);
    // molotov landing in smoke fizzles
    _v1.set(pos.x, f.gy + 20, pos.z);
    if (this.autoExtinguish && this.smokeDensity(_v1) > 0.25) {
      f.extinguish();
      this._glassShatter(f.pos);
    } else this._glassShatter(f.pos);
    return f.handle;
  }
  _glassShatter(p) {
    const sp = this._sp, rng = this.rng;
    for (let i = 0; i < 10; i++) {
      sp.reset(); sp.x = p.x; sp.y = p.y + 6; sp.z = p.z;
      rng.unit(_v1); _v1.y = Math.abs(_v1.y);
      const v = rng.range(120, 320); sp.vx = _v1.x * v; sp.vy = _v1.y * v + 60; sp.vz = _v1.z * v;
      sp.grav = 800; sp.bounceY = p.y + 0.5; sp.bounce = 0.25; sp.life = rng.range(0.5, 0.9);
      sp.s0 = sp.s1 = rng.range(0.4, 0.8); sp.cell = CELL.CHIP; sp.r = 0.35; sp.g = 0.5; sp.b = 0.3; sp.a = 1; sp.fadeOut = 0.7;
      sp.rotV = rng.range(-20, 20); sp.soft = -0.5; sp.nearK = 0; sp.phase = 0;
      this.P.emit(sp);
    }
  }

  // ---------------------------------------------------------------- muzzle flash
  muzzleFlash(pos, dir, { silenced = false, size = 1 } = {}) {
    if (!this.loaded) return;
    const P = this.P, sp = this._sp, rng = this.rng;
    const d = _n1.copy(dir).normalize();
    const s = size * (silenced ? 0.38 : 1);
    const k = silenced ? 0.45 : 1;
    // view facing factor (front star shows when looking down the barrel)
    _v1.copy(pos).sub(this.camera.position).normalize();
    const facing = Math.abs(_v1.dot(d));
    // side flame (axial, muzzle at u=0)
    sp.reset();
    const L = rng.range(20, 30) * s;
    sp.x = pos.x; sp.y = pos.y; sp.z = pos.z; sp.mode = M_AXIAL; sp.ax = d.x * L; sp.ay = d.y * L; sp.az = d.z * L;
    sp.s0 = sp.s1 = rng.range(4.6, 6.2) * s; sp.life = 0.05; sp.fadeIn = 0; sp.fadeOut = 0.35; sp.cell = CELL.MSIDE;
    sp.r = sp.g = sp.b = 0; sp.er = 6 * k; sp.eg = 4.3 * k; sp.eb = 2.6 * k; sp.add = 0.9; sp.a = 1 - 0.5 * facing * facing; sp.soft = -1.5; sp.nearK = 0;
    P.emit(sp);
    // front star
    sp.reset();
    sp.x = pos.x + d.x * 1.5 * s; sp.y = pos.y + d.y * 1.5 * s; sp.z = pos.z + d.z * 1.5 * s;
    sp.s0 = sp.s1 = rng.range(7.5, 10) * s; sp.life = 0.05; sp.fadeIn = 0; sp.fadeOut = 0.35; sp.cell = CELL.MFRONT; sp.rot = rng.range(0, 6.28);
    sp.r = sp.g = sp.b = 0; sp.er = 6 * k; sp.eg = 4.4 * k; sp.eb = 2.6 * k; sp.add = 0.9; sp.a = 0.3 + 0.7 * facing; sp.soft = 0.5; sp.nearK = 0;
    P.emit(sp);
    // halo glow
    sp.reset();
    sp.x = pos.x + d.x * 4 * s; sp.y = pos.y + d.y * 4 * s; sp.z = pos.z + d.z * 4 * s;
    sp.s0 = sp.s1 = 20 * s; sp.life = 0.06; sp.fadeIn = 0; sp.fadeOut = 0.2; sp.cell = CELL.GLOW;
    sp.r = sp.g = sp.b = 0; sp.er = 1.6 * k; sp.eg = 0.9 * k; sp.eb = 0.4 * k; sp.add = 1; sp.a = 1; sp.soft = 0.5; sp.nearK = 0;
    P.emit(sp);
    // sparks
    if (!silenced) {
      const n = rng.int(3);
      for (let i = 0; i < n; i++) {
        sp.reset(); rng.cone(_v2, d, 0.25); const v = rng.range(900, 1500);
        sp.x = pos.x; sp.y = pos.y; sp.z = pos.z; sp.vx = _v2.x * v; sp.vy = _v2.y * v; sp.vz = _v2.z * v; sp.grav = 400;
        sp.mode = M_AXIAL; sp.stretch = 0.012; sp.minLen = 0.5; sp.s0 = sp.s1 = 0.3; sp.life = rng.range(0.06, 0.12); sp.cell = CELL.SPARK;
        sp.r = sp.g = sp.b = 0; sp.er = 8; sp.eg = 5; sp.eb = 2; sp.add = 1; sp.fadeIn = 0; sp.fadeOut = 0.5; sp.soft = -1; sp.nearK = 0;
        P.emit(sp);
      }
    }
    // smoke wisp
    const nw = silenced ? 2 : 1;
    for (let i = 0; i < nw; i++) {
      sp.reset();
      sp.x = pos.x + d.x * 3; sp.y = pos.y + d.y * 3; sp.z = pos.z + d.z * 3;
      const v = rng.range(30, 70); sp.vx = d.x * v + rng.range(-6, 6); sp.vy = d.y * v + rng.range(4, 14); sp.vz = d.z * v + rng.range(-6, 6);
      sp.drag = 2.6; sp.buoy = 10; sp.turb = 10; sp.life = rng.range(0.7, 1.2); sp.s0 = 2.5 * size; sp.s1 = rng.range(11, 16) * size; sp.sPow = 2;
      sp.cell = CELL.MSMOKE; sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-0.8, 0.8); sp.flip = rng.sign();
      sp.r = sp.g = sp.b = 0.6; sp.a = silenced ? 0.3 : 0.22; sp.fadeIn = 0.1; sp.fadeOut = 0.3; sp.phase = 0.8; sp.soft = 0.5; sp.nearK = 0.6;
      P.emit(sp);
    }
    if (!silenced) {
      _v3.copy(pos).addScaledVector(d, 10);
      this.lights.flash(_v3, 1, 0.68, 0.36, 2.2e4 * size, 360, 0.06, 1);
    }
  }

  // ---------------------------------------------------------------- tracer
  tracer(from, to, { silenced = false, speed = 8000 } = {}) {
    if (!this.loaded) return;
    this.smokeBullet(from, to);
    const dist = from.distanceTo(to); if (dist < 60) return;
    const sp = this._sp;
    sp.reset();
    sp.ctrl = 1; sp.life = -1; sp.mode = M_AXIAL; sp.cell = CELL.TRACER; sp.r = sp.g = sp.b = 0;
    const k = silenced ? 0.45 : 1;
    sp.er = 7 * k; sp.eg = 4.6 * k; sp.eb = 1.9 * k; sp.add = 1; sp.size = silenced ? 0.6 : 0.85; sp.alpha = 1; sp.soft = -2; sp.nearK = 0;
    const id = this.P.emit(sp); if (id < 0) return;
    const T = this.tracers.find((t) => !t.on) || (this.tracers.length < 96 ? (this.tracers[this.tracers.length] = { on: false, from: new THREE.Vector3(), dir: new THREE.Vector3() }) : null);
    if (!T) { this.P.kill(id); return; }
    T.on = true; T.id = id; T.from.copy(from); T.dir.subVectors(to, from).divideScalar(dist); T.dist = dist;
    T.speed = speed * this.rng.range(0.95, 1.05); T.len = this.rng.range(150, 210); T.age = 0; T.start = this.rng.range(30, 60);
    this._updateTracer(T, 0);
  }
  _updateTracer(T, dt) {
    T.age += dt;
    const travel = T.start + T.speed * T.age;            // unclamped head distance along the shot
    const head = Math.min(T.dist, travel);
    const tail = Math.max(T.start * 0.5, travel - T.len); // after the head arrives the streak drains into the hit
    const P = this.P, id = T.id;
    if (tail >= T.dist - 1 || head - tail < 1) { P.kill(id); T.on = false; return; }
    P.x[id] = T.from.x + T.dir.x * tail; P.y[id] = T.from.y + T.dir.y * tail; P.z[id] = T.from.z + T.dir.z * tail;
    const L = head - tail; P.ax[id] = T.dir.x * L; P.ay[id] = T.dir.y * L; P.az[id] = T.dir.z * L;
  }

  // ---------------------------------------------------------------- bullet impacts
  _fitDecal(point, normal, size) {
    // shrink the decal until its corners sit on the surface (no hanging over edges)
    if (Math.abs(normal.y) < 0.99) _t1.set(-normal.z, 0, normal.x).normalize(); else _t1.set(1, 0, 0);
    _b1.crossVectors(normal, _t1);
    _v4.copy(normal).negate();
    for (let attempt = 0; attempt < 3; attempt++) {
      const h = size * 0.42; let ok = true;
      for (let c = 0; c < 4 && ok; c++) {
        const sx = c & 1 ? h : -h, sy = c & 2 ? h : -h;
        _v3.copy(point).addScaledVector(_t1, sx).addScaledVector(_b1, sy).addScaledVector(normal, 1.5);
        const hit = this._ray(_v3, _v4, 4);
        if (!hit || hit.normal.dot(normal) < 0.85) ok = false;
      }
      if (ok) return size;
      size *= 0.6;
    }
    return size < 2.5 ? 0 : size;
  }

  impact(point, normal, surface) {
    if (!this.loaded) return;
    const cls = surfaceClass(surface); const S = SURF_COLORS[cls];
    const P = this.P, sp = this._sp, rng = this.rng;
    const n = _n1.copy(normal).normalize();
    const px = point.x + n.x * 0.6, py = point.y + n.y * 0.6, pz = point.z + n.z * 0.6;
    const floorY = n.y > 0.6 ? point.y : point.y - 200;
    // --- dust puff (all but metal → small grey smoke)
    const nPuff = cls === 'metal' ? 1 : cls === 'sand' ? 2 : 3;
    for (let i = 0; i < nPuff; i++) {
      sp.reset(); rng.cone(_v1, n, 0.6); const v = rng.range(60, 170) * (i === 0 ? 1.3 : 1);
      sp.x = px; sp.y = py; sp.z = pz; sp.vx = _v1.x * v; sp.vy = _v1.y * v + 6; sp.vz = _v1.z * v; sp.drag = 3.2; sp.grav = 6; sp.turb = 8;
      sp.life = rng.range(0.6, 1.1); sp.s0 = rng.range(1.5, 3); sp.s1 = rng.range(12, 18) * (cls === 'metal' ? 0.6 : 1); sp.sPow = 3;
      sp.cell = i === 0 ? CELL.DUST : CELL.SMOKE0 + rng.int(16); sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-0.6, 0.6);
      const c = S.dust; sp.r = c[0]; sp.g = c[1]; sp.b = c[2]; sp.a = cls === 'metal' ? 0.25 : rng.range(0.32, 0.45); sp.fadeIn = 0.03; sp.fadeOut = 0.2;
      sp.phase = 0.6; sp.soft = 0.5; sp.nearK = 0.6; sp.flip = rng.sign();
      P.emit(sp);
    }
    // fast thin dust jet along the normal
    if (cls !== 'metal') {
      sp.reset(); const v = rng.range(240, 360);
      sp.x = px; sp.y = py; sp.z = pz; sp.vx = n.x * v; sp.vy = n.y * v; sp.vz = n.z * v; sp.drag = 7;
      sp.life = 0.35; sp.s0 = 1.2; sp.s1 = 5; sp.mode = M_AXIAL; sp.stretch = 0.05; sp.minLen = 3; sp.cell = CELL.SOFT;
      const c = S.dust; sp.r = c[0]; sp.g = c[1]; sp.b = c[2]; sp.a = 0.45; sp.fadeIn = 0; sp.fadeOut = 0.2; sp.soft = -1.5; sp.nearK = 0.5;
      P.emit(sp);
    }
    // --- debris
    if (cls === 'sand') {
      for (let i = 0; i < 16; i++) {
        sp.reset(); rng.cone(_v1, n, 0.75); const v = rng.range(110, 360);
        sp.x = px; sp.y = py; sp.z = pz; sp.vx = _v1.x * v; sp.vy = _v1.y * v + 50; sp.vz = _v1.z * v; sp.grav = 700; sp.drag = 1.2;
        sp.life = rng.range(0.45, 0.85); sp.s0 = rng.range(0.6, 1.4); sp.s1 = sp.s0 * 2.2; sp.cell = i & 1 ? CELL.DUST : CELL.SOFT;
        sp.mode = M_AXIAL; sp.stretch = 0.025; sp.minLen = 0.6;
        const c = S.chip; sp.r = c[0]; sp.g = c[1]; sp.b = c[2]; sp.a = 0.85; sp.fadeIn = 0; sp.fadeOut = 0.55; sp.soft = -1; sp.nearK = 0;
        P.emit(sp);
      }
    } else if (cls === 'wood') {
      for (let i = 0; i < 7; i++) {
        sp.reset(); rng.cone(_v1, n, 0.7); const v = rng.range(160, 420);
        sp.x = px; sp.y = py; sp.z = pz; sp.vx = _v1.x * v; sp.vy = _v1.y * v + 40; sp.vz = _v1.z * v; sp.grav = 800; sp.drag = 0.8;
        sp.bounceY = floorY; sp.life = rng.range(0.6, 1.2); sp.s0 = sp.s1 = rng.range(0.35, 0.6); sp.cell = CELL.SPLINTER;
        sp.mode = M_AXIAL; sp.stretch = 0.004; sp.minLen = rng.range(1.5, 3.2);
        const c = S.chip, g = rng.range(0.8, 1.15); sp.r = c[0] * g; sp.g = c[1] * g; sp.b = c[2] * g; sp.a = 1; sp.fadeIn = 0; sp.fadeOut = 0.7; sp.soft = -0.5; sp.nearK = 0;
        P.emit(sp);
      }
    } else if (cls !== 'metal') {
      const nc = cls === 'glass' ? 10 : 8;
      for (let i = 0; i < nc; i++) {
        sp.reset(); rng.cone(_v1, n, 0.8); const v = rng.range(150, 420);
        sp.x = px; sp.y = py; sp.z = pz; sp.vx = _v1.x * v; sp.vy = _v1.y * v + 40; sp.vz = _v1.z * v; sp.grav = 800;
        sp.bounceY = floorY; sp.bounce = 0.3; sp.life = rng.range(0.5, 1.0); sp.s0 = sp.s1 = rng.range(0.3, 0.75);
        sp.cell = CELL.CHIP; sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-25, 25);
        const c = S.chip, g = rng.range(0.75, 1.1); sp.r = c[0] * g; sp.g = c[1] * g; sp.b = c[2] * g; sp.a = 1; sp.fadeIn = 0; sp.fadeOut = 0.75;
        sp.soft = -0.5; sp.nearK = 0; sp.phase = 0;
        P.emit(sp);
      }
    }
    // --- sparks (metal: lots; stone: a couple)
    const ns = cls === 'metal' ? 14 + rng.int(6) : cls === 'stone' ? rng.int(3) : cls === 'plaster' ? rng.int(2) : 0;
    for (let i = 0; i < ns; i++) {
      sp.reset(); rng.cone(_v1, n, 1.1); const v = rng.range(250, 900);
      sp.x = px; sp.y = py; sp.z = pz; sp.vx = _v1.x * v; sp.vy = _v1.y * v + 60; sp.vz = _v1.z * v; sp.grav = 800; sp.drag = 1.4;
      sp.bounceY = floorY; sp.bounce = 0.35; sp.life = rng.range(0.15, cls === 'metal' ? 0.55 : 0.2);
      sp.mode = M_AXIAL; sp.stretch = 0.022; sp.minLen = 0.4; sp.s0 = sp.s1 = rng.range(0.22, 0.38); sp.cell = CELL.SPARK;
      const h = rng.range(0.8, 1.2); sp.r = sp.g = sp.b = 0; sp.er = 10 * h; sp.eg = 6 * h; sp.eb = 2.4 * h; sp.add = 1;
      sp.fadeIn = 0; sp.fadeOut = 0.4; sp.soft = -1; sp.nearK = 0;
      P.emit(sp);
    }
    if (cls === 'metal') {
      sp.reset(); sp.x = px + n.x; sp.y = py + n.y; sp.z = pz + n.z; sp.s0 = 3; sp.s1 = 6; sp.life = 0.06; sp.cell = CELL.STAR; sp.rot = rng.range(0, 6.28);
      sp.r = sp.g = sp.b = 0; sp.er = 6; sp.eg = 4.5; sp.eb = 2.5; sp.add = 1; sp.fadeIn = 0; sp.fadeOut = 0.2; sp.soft = 0.4; sp.nearK = 0;
      P.emit(sp);
    }
    // --- decal
    let size = rng.range(S.size[0], S.size[1]);
    size = this._fitDecal(point, n, size);
    if (size > 0) {
      const t = S.tint, g = rng.range(0.9, 1.05);
      _col.setRGB(t[0] * g, t[1] * g, t[2] * g);
      this.decals.add(S.decal, point, n, size, rng.range(0, Math.PI * 2), _col, cls === 'sand' ? 0.85 : 1, false);
    }
  }

  // ---------------------------------------------------------------- blood
  blood(point, dir, { headshot = false } = {}) {
    if (!this.loaded) return;
    const P = this.P, sp = this._sp, rng = this.rng;
    const d = _n1.copy(dir).normalize();
    const big = headshot ? 1.7 : 1;
    // mist
    for (let i = 0; i < (headshot ? 4 : 2); i++) {
      sp.reset(); const v = rng.range(40, 110) * big;
      sp.x = point.x; sp.y = point.y; sp.z = point.z; sp.vx = d.x * v + rng.range(-20, 20); sp.vy = d.y * v + rng.range(-5, 25); sp.vz = d.z * v + rng.range(-20, 20);
      sp.drag = 4; sp.grav = 20; sp.life = rng.range(0.35, 0.55) * (headshot ? 1.3 : 1); sp.s0 = 3 * big; sp.s1 = rng.range(12, 18) * big; sp.sPow = 3;
      sp.cell = CELL.BMIST; sp.rot = rng.range(0, 6.28); sp.flip = rng.sign();
      sp.r = 0.2; sp.g = 0.012; sp.b = 0.01; sp.a = 0.85; sp.fadeIn = 0.02; sp.fadeOut = 0.25; sp.phase = 0.6; sp.soft = 0.4; sp.nearK = 0.5;
      P.emit(sp);
    }
    if (headshot) {
      for (let i = 0; i < 3; i++) {
        sp.reset(); const v = rng.range(60, 140);
        sp.x = point.x; sp.y = point.y; sp.z = point.z; sp.vx = d.x * v + rng.range(-25, 25); sp.vy = d.y * v + rng.range(0, 30); sp.vz = d.z * v + rng.range(-25, 25);
        sp.drag = 3.5; sp.life = rng.range(0.5, 0.8); sp.s0 = 4; sp.s1 = rng.range(16, 24); sp.sPow = 2.5; sp.cell = CELL.SMOKE0 + rng.int(16);
        sp.r = 0.2; sp.g = 0.014; sp.b = 0.012; sp.a = 0.55; sp.fadeIn = 0.03; sp.fadeOut = 0.3; sp.rot = rng.range(0, 6.28); sp.phase = 0.6; sp.nearK = 0.5;
        P.emit(sp);
      }
    }
    // droplets
    const nd = headshot ? 22 : 9;
    for (let i = 0; i < nd; i++) {
      sp.reset(); rng.cone(_v1, d, headshot ? 0.7 : 0.45); const v = rng.range(120, 420);
      sp.x = point.x; sp.y = point.y; sp.z = point.z; sp.vx = _v1.x * v; sp.vy = _v1.y * v + 50; sp.vz = _v1.z * v;
      sp.grav = 800; sp.drag = 0.6; sp.life = rng.range(0.35, 0.7); sp.s0 = sp.s1 = rng.range(0.3, 0.6) * (headshot ? 1.2 : 1);
      sp.mode = M_AXIAL; sp.stretch = 0.018; sp.minLen = 0.6; sp.cell = CELL.DOT;
      sp.r = 0.13; sp.g = 0.006; sp.b = 0.005; sp.a = 1; sp.fadeIn = 0; sp.fadeOut = 0.7; sp.phase = 0.2; sp.soft = -0.5; sp.nearK = 0;
      P.emit(sp);
    }
    // splatter decal on the surface behind (or the floor)
    _v1.copy(point).addScaledVector(d, 2);
    let hit = this._ray(_v1, d, 150);
    if (!hit) {
      _v2.set(d.x * 0.45, -1, d.z * 0.45).normalize();
      hit = this._ray(point, _v2, 150);
    }
    if (hit) {
      const dist = hit.distance;
      let size = (28 + dist * 0.2 + rng.range(-4, 6)) * (headshot ? 1.35 : 1);
      size = this._fitDecal(hit.point, hit.normal, size) || size * 0.35;
      const g = rng.range(0.7, 1);
      _col.setRGB(g, g * 0.9, g * 0.9);
      this.decals.add(DECAL.BLOOD0 + rng.int(4), hit.point, hit.normal, size, rng.range(0, 6.28), _col, rng.range(0.85, 1), true);
    }
  }

  // ---------------------------------------------------------------- HE grenade
  explosion(pos, { scale = 1 } = {}) {
    if (!this.loaded) return { shake: 0, shakeBase: scale };
    const P = this.P, sp = this._sp, rng = this.rng, s = scale;
    const gy0 = this._groundY(pos.x, pos.y + 8, pos.z, 140);
    const gy = gy0 ?? pos.y - 200;
    const nearGround = gy0 != null && pos.y - gy < 60;
    // flash core
    sp.reset(); sp.x = pos.x; sp.y = pos.y + 8; sp.z = pos.z; sp.s0 = 50 * s; sp.s1 = 150 * s; sp.sPow = 3; sp.life = 0.16; sp.fadeIn = 0; sp.fadeOut = 0;
    sp.cell = CELL.GLOW; sp.r = sp.g = sp.b = 0; sp.er = 14; sp.eg = 10; sp.eb = 6; sp.add = 1; sp.soft = -30; sp.nearK = 0.3;
    P.emit(sp);
    sp.reset(); sp.x = pos.x; sp.y = pos.y + 8; sp.z = pos.z; sp.s0 = 30 * s; sp.s1 = 70 * s; sp.sPow = 2; sp.life = 0.1; sp.fadeIn = 0; sp.fadeOut = 0;
    sp.cell = CELL.STAR; sp.rot = rng.range(0, 6.28); sp.r = sp.g = sp.b = 0; sp.er = 9; sp.eg = 7; sp.eb = 4; sp.add = 1; sp.soft = -30; sp.nearK = 0.3;
    P.emit(sp);
    // fireball: short-lived orange puffs that cool into grey-brown smoke
    for (let i = 0; i < Math.round(9 * s); i++) {
      sp.reset(); rng.unit(_v1); if (nearGround) _v1.y = Math.abs(_v1.y) * 0.8 + 0.15;
      const v = rng.range(260, 520) * s;
      sp.x = pos.x + _v1.x * 8; sp.y = pos.y + 10 + _v1.y * 8; sp.z = pos.z + _v1.z * 8;
      sp.vx = _v1.x * v; sp.vy = _v1.y * v + 50; sp.vz = _v1.z * v; sp.drag = 5.5; sp.buoy = 26; sp.turb = 20;
      sp.life = rng.range(1.6, 2.4); sp.s0 = 14 * s; sp.s1 = rng.range(50, 75) * s; sp.sPow = 4;
      sp.cell = CELL.SMOKE0 + rng.int(16); sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-0.5, 0.5); sp.flip = rng.sign();
      const g = rng.range(0.16, 0.22); sp.r = g; sp.g = g * 0.93; sp.b = g * 0.84; sp.a = 0.88; sp.fadeIn = 0.02; sp.fadeOut = 0.3;
      sp.er = 5.5; sp.eg = 2.1; sp.eb = 0.55; sp.eDecay = rng.range(6, 9); sp.add = 0.2; sp.phase = 0.5; sp.ao = 0.75; sp.nearK = 0.8; sp.dens = 2;
      P.emit(sp);
    }
    // grey-brown dust/smoke cloud that lingers a couple of seconds
    for (let i = 0; i < Math.round(9 * s); i++) {
      sp.reset(); rng.unit(_v1); _v1.y = Math.abs(_v1.y) * 0.6 + 0.25;
      const v = rng.range(120, 300) * s;
      sp.x = pos.x + _v1.x * 12; sp.y = pos.y + 14; sp.z = pos.z + _v1.z * 12;
      sp.vx = _v1.x * v; sp.vy = _v1.y * v; sp.vz = _v1.z * v; sp.drag = 3; sp.buoy = 18; sp.turb = 15;
      sp.life = rng.range(2.6, 4.0); sp.s0 = 20 * s; sp.s1 = rng.range(70, 110) * s; sp.sPow = 3;
      sp.cell = CELL.SMOKE0 + rng.int(16); sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-0.3, 0.3); sp.flip = rng.sign();
      sp.r = 0.4; sp.g = 0.36; sp.b = 0.3; sp.a = 0.7; sp.fadeIn = 0.06; sp.fadeOut = 0.35;
      sp.er = 1.5; sp.eg = 0.5; sp.eb = 0.1; sp.eDecay = 12; sp.phase = 0.6; sp.ao = 0.8; sp.hole = 1; sp.nearK = 0.8; sp.dens = 2;
      P.emit(sp);
    }
    // licks of flame
    for (let i = 0; i < 6; i++) {
      sp.reset(); rng.unit(_v1); _v1.y = Math.abs(_v1.y);
      sp.x = pos.x + _v1.x * 14 * s; sp.y = pos.y + 4 + _v1.y * 10; sp.z = pos.z + _v1.z * 14 * s;
      sp.vx = _v1.x * 120; sp.vy = 140; sp.vz = _v1.z * 120; sp.drag = 4;
      sp.life = rng.range(0.14, 0.24); sp.s0 = rng.range(26, 40) * s; sp.s1 = sp.s0 * 1.4; sp.mode = M_PIVOT; sp.cell = CELL.FIRE0; sp.frames = 16; sp.fps = 40; sp.frame0 = rng.int(16);
      sp.r = sp.g = sp.b = 0; sp.er = 3.2; sp.eg = 2.2; sp.eb = 1.4; sp.add = 0.7; sp.fadeIn = 0; sp.fadeOut = 0.4; sp.soft = 0.4; sp.nearK = 0.4; sp.flip = rng.sign();
      P.emit(sp);
    }
    // ground dust ring
    if (nearGround) {
      const nr = Math.round(14 * s);
      for (let i = 0; i < nr; i++) {
        sp.reset(); const a = (i / nr) * Math.PI * 2 + rng.range(-0.2, 0.2); const v = rng.range(380, 720) * s;
        sp.x = pos.x + Math.cos(a) * 12; sp.y = gy + 14; sp.z = pos.z + Math.sin(a) * 12;
        sp.vx = Math.cos(a) * v; sp.vy = rng.range(15, 70); sp.vz = Math.sin(a) * v; sp.drag = 3.4; sp.buoy = 6; sp.turb = 15;
        sp.life = rng.range(2.4, 3.6); sp.s0 = 20 * s; sp.s1 = rng.range(70, 110) * s; sp.sPow = 2.5;
        sp.cell = CELL.SMOKE0 + rng.int(16); sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-0.3, 0.3);
        sp.r = 0.6; sp.g = 0.51; sp.b = 0.39; sp.a = 0.6; sp.fadeIn = 0.04; sp.fadeOut = 0.35; sp.phase = 0.6; sp.ao = 0.85; sp.floorY = gy; sp.nearK = 0.8;
        P.emit(sp);
      }
      // shockwave ring on the ground
      sp.reset(); sp.x = pos.x; sp.y = gy + 1.5; sp.z = pos.z; sp.mode = M_FLAT; sp.ax = 0; sp.ay = 1; sp.az = 0; sp.cell = CELL.RING;
      sp.s0 = 20 * s; sp.s1 = 330 * s; sp.sPow = 3; sp.life = 0.38; sp.fadeIn = 0; sp.fadeOut = 0.1;
      sp.r = 0.75; sp.g = 0.66; sp.b = 0.52; sp.a = 0.55; sp.er = 0.5; sp.eg = 0.35; sp.eb = 0.15; sp.eDecay = 10; sp.soft = -3; sp.nearK = 0; sp.rot = rng.range(0, 6.28);
      P.emit(sp);
    }
    // debris + sparks
    for (let i = 0; i < Math.round(26 * s); i++) {
      sp.reset(); rng.unit(_v1); if (nearGround) _v1.y = Math.abs(_v1.y);
      const v = rng.range(350, 1000);
      sp.x = pos.x; sp.y = pos.y + 6; sp.z = pos.z; sp.vx = _v1.x * v; sp.vy = _v1.y * v + 120; sp.vz = _v1.z * v; sp.grav = 800;
      sp.bounceY = gy; sp.bounce = 0.3; sp.life = rng.range(0.9, 1.8); sp.s0 = sp.s1 = rng.range(0.6, 1.5); sp.cell = CELL.CHIP; sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-15, 15);
      const g = rng.range(0.25, 0.45); sp.r = g; sp.g = g * 0.9; sp.b = g * 0.78; sp.a = 1; sp.fadeIn = 0; sp.fadeOut = 0.8; sp.soft = -1; sp.nearK = 0; sp.phase = 0;
      P.emit(sp);
    }
    for (let i = 0; i < Math.round(34 * s); i++) {
      sp.reset(); rng.unit(_v1); if (nearGround) _v1.y = Math.abs(_v1.y) * 0.9 + 0.1;
      const v = rng.range(600, 1600);
      sp.x = pos.x; sp.y = pos.y + 8; sp.z = pos.z; sp.vx = _v1.x * v; sp.vy = _v1.y * v; sp.vz = _v1.z * v; sp.grav = 600; sp.drag = 1.8;
      sp.life = rng.range(0.2, 0.55); sp.mode = M_AXIAL; sp.stretch = 0.03; sp.minLen = 1; sp.s0 = sp.s1 = rng.range(0.35, 0.6); sp.cell = CELL.SPARK;
      sp.r = sp.g = sp.b = 0; sp.er = 10; sp.eg = 5.5; sp.eb = 2; sp.add = 1; sp.fadeIn = 0; sp.fadeOut = 0.4; sp.soft = -1; sp.nearK = 0;
      P.emit(sp);
    }
    // light, scorch, smoke clearing
    _v1.set(pos.x, pos.y + 24, pos.z);
    this.lights.flash(_v1, 1, 0.62, 0.32, 7e5 * s, 1200 * s, 0.4, 5);
    if (gy0 != null && pos.y - gy < 80) {
      _v1.set(pos.x, pos.y + 8, pos.z); const h = this._ray(_v1, this._down, 120);
      if (h) this.decals.add(DECAL.SCORCH, h.point, h.normal, rng.range(140, 175) * s, rng.range(0, 6.28), null, 0.92, true);
    }
    for (const sm of this.smokes) if (sm.alive && sm.pos.distanceTo(pos) < sm.R + 260 * s) { this.addSmokeHole(pos, pos, 210 * s, 1.0, true); break; }
    const cd = this.camera.position.distanceTo(pos);
    return { shake: s * Math.pow(clamp(1 - cd / 1400, 0, 1), 1.5), shakeBase: s };
  }

  // ---------------------------------------------------------------- flashbang pop
  flashPop(pos) {
    if (!this.loaded) return;
    const P = this.P, sp = this._sp, rng = this.rng;
    sp.reset(); sp.x = pos.x; sp.y = pos.y; sp.z = pos.z; sp.s0 = 40; sp.s1 = 130; sp.sPow = 3; sp.life = 0.14; sp.fadeIn = 0; sp.fadeOut = 0;
    sp.cell = CELL.GLOW; sp.r = sp.g = sp.b = 0; sp.er = 30; sp.eg = 30; sp.eb = 32; sp.add = 1; sp.soft = -30; sp.nearK = 0.2;
    P.emit(sp);
    sp.reset(); sp.x = pos.x; sp.y = pos.y; sp.z = pos.z; sp.s0 = 60; sp.s1 = 90; sp.life = 0.09; sp.fadeIn = 0; sp.fadeOut = 0;
    sp.cell = CELL.STAR; sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-3, 3); sp.r = sp.g = sp.b = 0; sp.er = 16; sp.eg = 16; sp.eb = 18; sp.add = 1; sp.soft = -30; sp.nearK = 0.2;
    P.emit(sp);
    for (let i = 0; i < 14; i++) {
      sp.reset(); rng.unit(_v1); const v = rng.range(400, 900);
      sp.x = pos.x; sp.y = pos.y; sp.z = pos.z; sp.vx = _v1.x * v; sp.vy = _v1.y * v; sp.vz = _v1.z * v; sp.drag = 3; sp.grav = 300;
      sp.life = rng.range(0.12, 0.25); sp.mode = M_AXIAL; sp.stretch = 0.025; sp.minLen = 1; sp.s0 = sp.s1 = 0.4; sp.cell = CELL.SPARK;
      sp.r = sp.g = sp.b = 0; sp.er = 10; sp.eg = 10; sp.eb = 10; sp.add = 1; sp.fadeIn = 0; sp.fadeOut = 0.3; sp.soft = -1; sp.nearK = 0;
      P.emit(sp);
    }
    for (let i = 0; i < 4; i++) {
      sp.reset(); rng.unit(_v1); const v = rng.range(30, 80);
      sp.x = pos.x; sp.y = pos.y; sp.z = pos.z; sp.vx = _v1.x * v; sp.vy = _v1.y * v + 10; sp.vz = _v1.z * v; sp.drag = 2; sp.buoy = 6; sp.turb = 8;
      sp.life = rng.range(1.8, 2.8); sp.s0 = 8; sp.s1 = rng.range(28, 40); sp.sPow = 2.5; sp.cell = CELL.SMOKE0 + rng.int(16);
      sp.r = sp.g = sp.b = 0.62; sp.a = 0.35; sp.fadeIn = 0.05; sp.fadeOut = 0.3; sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-0.4, 0.4); sp.phase = 0.8; sp.nearK = 0.6;
      sp.er = 3; sp.eg = 3; sp.eb = 3; sp.eDecay = 25;
      P.emit(sp);
    }
    this.lights.flash(pos, 1, 0.97, 0.92, 3.5e5, 1100, 0.16, 6);
  }

  // ---------------------------------------------------------------- C4
  c4Explosion(pos) {
    if (!this.loaded) return { shake: 0, shakeBase: 3 };
    const P = this.P, sp = this._sp, rng = this.rng;
    const gy = this._groundY(pos.x, pos.y + 10, pos.z, 200) ?? pos.y;
    // blinding core
    sp.reset(); sp.x = pos.x; sp.y = gy + 60; sp.z = pos.z; sp.s0 = 200; sp.s1 = 700; sp.sPow = 3; sp.life = 0.4; sp.fadeIn = 0; sp.fadeOut = 0;
    sp.cell = CELL.GLOW; sp.r = sp.g = sp.b = 0; sp.er = 14; sp.eg = 8; sp.eb = 3.5; sp.add = 1; sp.soft = -30; sp.nearK = 0.3;
    P.emit(sp);
    // fireball
    for (let i = 0; i < 48; i++) {
      sp.reset(); rng.unit(_v1); _v1.y = Math.abs(_v1.y) * 0.9 + 0.1;
      const v = rng.range(250, 800);
      sp.x = pos.x + _v1.x * 40; sp.y = gy + 30 + _v1.y * 40; sp.z = pos.z + _v1.z * 40;
      sp.vx = _v1.x * v; sp.vy = _v1.y * v + rng.range(100, 450); sp.vz = _v1.z * v; sp.drag = 2.0; sp.buoy = 70; sp.turb = 40;
      sp.life = rng.range(4.5, 7.5); sp.s0 = rng.range(40, 70); sp.s1 = rng.range(170, 290); sp.sPow = 2.8;
      sp.cell = CELL.SMOKE0 + rng.int(16); sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-0.3, 0.3); sp.flip = rng.sign();
      const g = rng.range(0.1, 0.16); sp.r = g; sp.g = g * 0.93; sp.b = g * 0.85; sp.a = 0.9; sp.fadeIn = 0.02; sp.fadeOut = 0.55;
      sp.er = 5.2; sp.eg = 1.9; sp.eb = 0.45; sp.eDecay = rng.range(1.8, 3.4); sp.add = 0.1; sp.phase = 0.5; sp.ao = 0.7; sp.hole = 0; sp.nearK = 0.9; sp.dens = 2;
      P.emit(sp);
    }
    // smoke column + mushroom cap (lingering)
    for (let i = 0; i < 30; i++) {
      sp.reset(); const a = rng.range(0, 6.28), r = rng.range(0, 60);
      sp.x = pos.x + Math.cos(a) * r; sp.y = gy + 40; sp.z = pos.z + Math.sin(a) * r;
      const cap = i >= 18;
      sp.vx = Math.cos(a) * (cap ? rng.range(80, 220) : rng.range(10, 40)); sp.vz = Math.sin(a) * (cap ? rng.range(80, 220) : rng.range(10, 40));
      sp.vy = cap ? rng.range(600, 850) : rng.range(200, 650); sp.drag = cap ? 0.95 : 1.1; sp.buoy = 22; sp.turb = 25;
      sp.life = rng.range(10, 15); sp.s0 = 50; sp.s1 = cap ? rng.range(260, 380) : rng.range(170, 280); sp.sPow = 2.2;
      sp.cell = CELL.SMOKE0 + rng.int(16); sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-0.12, 0.12); sp.flip = rng.sign();
      const g = rng.range(0.24, 0.32); sp.r = g; sp.g = g * 0.93; sp.b = g * 0.84; sp.a = 0.75; sp.fadeIn = 0.05; sp.fadeOut = 0.55;
      sp.er = 3.2; sp.eg = 1.1; sp.eb = 0.25; sp.eDecay = 2.8; sp.add = 0.05; sp.phase = 0.5; sp.ao = 0.75; sp.hole = 1; sp.nearK = 0.9; sp.dens = 2;
      P.emit(sp);
    }
    // dust wave across ~1000u
    const nav = this.world && this.world.nav;
    for (let ring = 0; ring < 2; ring++) {
      const nr = ring ? 34 : 60;
      for (let i = 0; i < nr; i++) {
        sp.reset(); const a = (i / nr) * Math.PI * 2 + rng.range(-0.1, 0.1);
        const v = ring ? rng.range(450, 800) : rng.range(1100, 1500);
        sp.x = pos.x + Math.cos(a) * 30; sp.y = gy + 24; sp.z = pos.z + Math.sin(a) * 30;
        sp.vx = Math.cos(a) * v; sp.vy = rng.range(10, 50); sp.vz = Math.sin(a) * v; sp.drag = 1.35; sp.buoy = 4; sp.turb = 30;
        sp.life = rng.range(4.5, 7); sp.s0 = 40; sp.s1 = rng.range(190, 320); sp.sPow = 2;
        sp.cell = CELL.SMOKE0 + rng.int(16); sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-0.2, 0.2); sp.flip = rng.sign();
        sp.r = 0.62; sp.g = 0.53; sp.b = 0.4; sp.a = ring ? 0.6 : 0.5; sp.fadeIn = 0.03; sp.fadeOut = 0.45; sp.phase = 0.6; sp.ao = 0.85; sp.nearK = 0.9;
        sp.floorY = gy;
        P.emit(sp);
      }
    }
    // shockwave rings
    sp.reset(); sp.x = pos.x; sp.y = gy + 2; sp.z = pos.z; sp.mode = M_FLAT; sp.ax = 0; sp.ay = 1; sp.az = 0; sp.cell = CELL.RING;
    sp.s0 = 50; sp.s1 = 1300; sp.sPow = 2.5; sp.life = 0.75; sp.fadeIn = 0; sp.fadeOut = 0.15; sp.r = 0.75; sp.g = 0.66; sp.b = 0.52; sp.a = 0.6;
    sp.er = 1.2; sp.eg = 0.8; sp.eb = 0.4; sp.eDecay = 5; sp.soft = -4; sp.nearK = 0;
    P.emit(sp);
    // debris & sparks & burning chunks
    for (let i = 0; i < 90; i++) {
      sp.reset(); rng.unit(_v1); _v1.y = Math.abs(_v1.y);
      const v = rng.range(500, 1700);
      sp.x = pos.x; sp.y = gy + 20; sp.z = pos.z; sp.vx = _v1.x * v; sp.vy = _v1.y * v + 200; sp.vz = _v1.z * v; sp.grav = 800;
      sp.bounceY = gy; sp.bounce = 0.3; sp.life = rng.range(1.5, 3); sp.s0 = sp.s1 = rng.range(0.8, 2.6); sp.cell = CELL.CHIP; sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-12, 12);
      const g = rng.range(0.2, 0.4); sp.r = g; sp.g = g * 0.9; sp.b = g * 0.8; sp.a = 1; sp.fadeIn = 0; sp.fadeOut = 0.85; sp.soft = -1; sp.nearK = 0; sp.phase = 0;
      if (i < 18) { sp.er = 9; sp.eg = 3.5; sp.eb = 0.8; sp.eDecay = 1.2; sp.mode = M_AXIAL; sp.stretch = 0.02; sp.minLen = 2; sp.cell = CELL.DOT; }
      P.emit(sp);
    }
    for (let i = 0; i < 80; i++) {
      sp.reset(); rng.unit(_v1); _v1.y = Math.abs(_v1.y) * 0.9 + 0.1;
      const v = rng.range(800, 2400);
      sp.x = pos.x; sp.y = gy + 30; sp.z = pos.z; sp.vx = _v1.x * v; sp.vy = _v1.y * v; sp.vz = _v1.z * v; sp.grav = 600; sp.drag = 1.2;
      sp.life = rng.range(0.4, 1.1); sp.mode = M_AXIAL; sp.stretch = 0.03; sp.minLen = 2; sp.s0 = sp.s1 = rng.range(0.6, 1.1); sp.cell = CELL.SPARK;
      sp.r = sp.g = sp.b = 0; sp.er = 10; sp.eg = 5; sp.eb = 1.8; sp.add = 1; sp.fadeIn = 0; sp.fadeOut = 0.5; sp.soft = -1; sp.nearK = 0;
      P.emit(sp);
    }
    _v1.set(pos.x, gy + 120, pos.z);
    this.lights.flash(_v1, 1, 0.6, 0.28, 6e6, 3500, 1.6, 9);
    _v1.set(pos.x, gy + 10, pos.z); const h = this._ray(_v1, this._down, 60);
    if (h) {
      this.decals.add(DECAL.SCORCH, h.point, h.normal, 440, rng.range(0, 6.28), null, 0.95, true);
      this.decals.add(DECAL.BURN, h.point, h.normal, 300, rng.range(0, 6.28), null, 0.7, true);
    }
    for (const sm of this.smokes) if (sm.alive && sm.pos.distanceTo(pos) < 1100) this.addSmokeHole(sm.pos, sm.pos, 400, 2.0, true);
    const cd = this.camera.position.distanceTo(pos);
    return { shake: 3 * Math.pow(clamp(1 - cd / 3200, 0, 1), 1.2), shakeBase: 3 };
  }

  c4Light(pos) {
    const sp = this._sp; const P = this.P;
    sp.reset(); sp.ctrl = 1; sp.life = -1; sp.cell = CELL.GLOW; sp.r = sp.g = sp.b = 0; sp.er = 6; sp.eg = 0.25; sp.eb = 0.12; sp.add = 1;
    sp.size = 1.6; sp.alpha = 0.55; sp.soft = 0.5; sp.nearK = 0;
    const id = this.loaded ? P.emit(sp) : -1;
    if (id >= 0) { P.x[id] = pos.x; P.y[id] = pos.y; P.z[id] = pos.z; }
    const L = { id, pos: pos.clone(), tb: -10, alive: true };
    this.c4lights.push(L);
    const fx = this;
    return {
      get pos() { return L.pos; },
      blink() { L.tb = fx.time; fx.lights.flash(L.pos, 1, 0.08, 0.04, 2500, 140, 0.12, 0); },
      setPosition(p) { L.pos.copy(p); if (L.id >= 0) { P.x[L.id] = p.x; P.y[L.id] = p.y; P.z[L.id] = p.z; } },
      dispose() { if (L.alive) { L.alive = false; if (L.id >= 0) P.kill(L.id); L.id = -1; } },
    };
  }

  // ---------------------------------------------------------------- dust puff (footsteps / landing)
  dustPuff(pos, size = 1) {
    if (!this.loaded) return;
    const P = this.P, sp = this._sp, rng = this.rng;
    const n = 2 + Math.round(Math.min(3, size * 1.5));
    for (let i = 0; i < n; i++) {
      sp.reset(); const a = rng.range(0, 6.28), v = rng.range(25, 70) * Math.sqrt(size);
      sp.x = pos.x + Math.cos(a) * 3; sp.y = pos.y + 3 * size; sp.z = pos.z + Math.sin(a) * 3;
      sp.vx = Math.cos(a) * v; sp.vy = rng.range(6, 24); sp.vz = Math.sin(a) * v; sp.drag = 2.6; sp.buoy = 3; sp.turb = 6;
      sp.life = rng.range(0.8, 1.3) * (0.8 + 0.3 * size); sp.s0 = 4 * size; sp.s1 = rng.range(14, 22) * size; sp.sPow = 2.4;
      sp.cell = i & 1 ? CELL.DUST : CELL.SMOKE0 + rng.int(16); sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-0.5, 0.5); sp.flip = rng.sign();
      sp.r = 0.64; sp.g = 0.54; sp.b = 0.4; sp.a = clamp(0.24 * size, 0.08, 0.4); sp.fadeIn = 0.1; sp.fadeOut = 0.3; sp.phase = 0.6; sp.floorY = pos.y - 1; sp.nearK = 0.6;
      P.emit(sp);
    }
  }

  // ---------------------------------------------------------------- shell casings
  _makeShells() {
    const cap = (this.shellCap = 64);
    const g = new THREE.CylinderGeometry(0.2, 0.22, 1.25, 7, 1); g.rotateZ(Math.PI / 2);
    const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.78, 0.55, 0.22), metalness: 1, roughness: 0.32 });
    this.shellMesh = new THREE.InstancedMesh(g, m, cap);
    this.shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shellMesh.frustumCulled = false; this.shellMesh.castShadow = false; this.shellMesh.receiveShadow = true; this.shellMesh.name = 'fx_shells';
    _m4.makeScale(0, 0, 0); for (let i = 0; i < cap; i++) this.shellMesh.setMatrixAt(i, _m4);
    this.shells = []; for (let i = 0; i < cap; i++) this.shells.push({ on: false, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), floor: 0, age: 0, bounces: 0 });
    this.shellNext = 0; this.shellActive = 0;
    this.scene.add(this.shellMesh);
  }
  shellCase(pos, vel) {
    if (!this.loaded) return;
    const S = this.shells[this.shellNext]; this.shellNext = (this.shellNext + 1) % this.shellCap;
    const rng = this.rng;
    S.on = true; S.p.copy(pos); S.v.copy(vel); S.age = 0; S.bounces = 0;
    S.r.set(rng.range(0, 6), rng.range(0, 6), rng.range(0, 6)); S.w.set(rng.range(-25, 25), rng.range(-25, 25), rng.range(-25, 25));
    S.floor = this._groundY(pos.x, pos.y, pos.z, 300) ?? pos.y - 300;
    S.floor += 0.22;
  }
  _updateShells(dt) {
    let any = false; const M = this.shellMesh;
    for (let i = 0; i < this.shellCap; i++) {
      const S = this.shells[i]; if (!S.on) continue; any = true;
      S.age += dt;
      if (S.age > 3) { S.on = false; _m4.makeScale(0, 0, 0); M.setMatrixAt(i, _m4); continue; }
      if (S.bounces < 4) {
        S.v.y -= 800 * dt; S.p.addScaledVector(S.v, dt);
        S.r.x += S.w.x * dt; S.r.y += S.w.y * dt; S.r.z += S.w.z * dt;
        if (S.p.y < S.floor) {
          S.p.y = S.floor; S.v.y = -S.v.y * 0.35; S.v.x *= 0.5; S.v.z *= 0.5; S.w.multiplyScalar(0.5); S.bounces++;
          if (Math.abs(S.v.y) < 25) { S.bounces = 4; S.r.x = 0; S.r.z = 0; }
        }
      }
      const sink = S.age > 2.6 ? (S.age - 2.6) / 0.4 : 0;
      _q.setFromEuler(S.r); _s3.setScalar(1 - sink); _m4.compose(S.p, _q, _s3); M.setMatrixAt(i, _m4);
    }
    if (any || this.shellActive) M.instanceMatrix.needsUpdate = true;
    this.shellActive = any;
  }

  // ---------------------------------------------------------------- in-smoke overlay
  _makeOverlay() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uDens: { value: 0 }, uDepth: this.uniforms.uDepth, uDepthParams: this.uniforms.uDepthParams, uInvRes: this.uniforms.uInvRes },
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uDens; uniform sampler2D uDepth; uniform vec4 uDepthParams; uniform vec2 uInvRes;
        void main(){
          float a;
          if (uDepthParams.x > 0.5) {
            float d = texture2D(uDepth, gl_FragCoord.xy * uInvRes).r;
            float n = uDepthParams.y, f = uDepthParams.z;
            float dist = -(n * f) / ((f - n) * d - f);
            a = 1.0 - exp(-uDens * 0.06 * dist);
          } else a = smoothstep(0.05, 0.8, uDens);
          gl_FragColor = vec4(uColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          gl_FragColor.rgb *= a;
        }`,
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.overlay = new THREE.Mesh(g, mat);
    this.overlay.frustumCulled = false; this.overlay.renderOrder = 40; this.overlay.visible = false; this.overlay.name = 'fx_smoke_overlay';
    this.scene.add(this.overlay);
  }
  _updateOverlay(camPos) {
    let d = 0;
    for (const s of this.smokes) if (s.alive) d += s.density(camPos);
    d = Math.min(1, d);
    this.overlay.visible = d > 0.01;
    if (!this.overlay.visible) return;
    const U = this.overlay.material.uniforms; U.uDens.value = d;
    // lit smoke colour seen from inside (albedo 0.6, mostly ambient + some sun)
    const sky = this.uniforms.uSkyColor.value, sun = this.uniforms.uSunColor.value, gr = this.uniforms.uGroundColor.value;
    const k = 0.6 / Math.PI;
    U.uColor.value.setRGB((sky.r * 0.6 + gr.r * 0.4 + sun.r * 0.35) * k, (sky.g * 0.6 + gr.g * 0.4 + sun.g * 0.35) * k, (sky.b * 0.6 + gr.b * 0.4 + sun.b * 0.35) * k);
  }

  // ---------------------------------------------------------------- main update
  update(dt, camera = this.camera) {
    if (!this.loaded) return;
    const t0 = performance.now();
    if (camera) this.camera = camera;
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += dt;
    this._updateLighting();
    this._updateHoles();
    this._rayStop = this.stats.rays + Math.max(12, Math.round(this.rayBudget * Math.min(2, dt * 60)));
    const prof = this.profile; let tp = prof ? performance.now() : 0;
    for (let i = this.smokes.length - 1; i >= 0; i--) { const s = this.smokes[i]; s.update(dt); if (!s.alive) this.smokes.splice(i, 1); }
    if (prof) { const n = performance.now(); prof.smoke = Math.max(prof.smoke || 0, n - tp); tp = n; }
    for (let i = this.fires.length - 1; i >= 0; i--) { const f = this.fires[i]; f.update(dt); if (!f.alive) this.fires.splice(i, 1); }
    if (prof) { const n = performance.now(); prof.fire = Math.max(prof.fire || 0, n - tp); tp = n; }
    for (const T of this.tracers) if (T.on) this._updateTracer(T, dt);
    for (let i = this.c4lights.length - 1; i >= 0; i--) {
      const L = this.c4lights[i]; if (!L.alive) { this.c4lights.splice(i, 1); continue; }
      if (L.id >= 0) { const b = Math.exp(-(this.time - L.tb) * 12); this.P.size[L.id] = 1.6 + 2.6 * b; this.P.alpha[L.id] = 0.45 + 0.55 * b; this.P.er[L.id] = 6 + 14 * b; }
    }
    this.P.simulate(dt, this.time);
    this.lights.update(this.time, this.uniforms.uPLPos, this.uniforms.uPLCol);
    this.camera.updateMatrixWorld();
    _v1.setFromMatrixPosition(this.camera.matrixWorld);
    if (prof) { const n = performance.now(); prof.sim = Math.max(prof.sim || 0, n - tp); tp = n; }
    this.P.write(_v1);
    if (prof) { const n = performance.now(); prof.write = Math.max(prof.write || 0, n - tp); tp = n; }
    this._updateShells(dt);
    this._updateOverlay(_v1);
    this.stats.particles = this.P.n;
    this.stats.cpuMs = this.stats.cpuMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  // ---------------------------------------------------------------- reset
  clear() {
    if (!this.loaded) return;
    for (const s of this.smokes) s.kill(); this.smokes.length = 0;
    for (const f of this.fires) f.kill(); this.fires.length = 0;
    for (const L of this.c4lights) L.alive = false; this.c4lights.length = 0;
    for (const T of this.tracers) T.on = false;
    this.P.clear(); this.decals.clear(); this.lights.clear();
    for (const H of this.holes) { H.s = 0; H.t0 = -1; }
    for (const S of this.shells) S.on = false;
    _m4.makeScale(0, 0, 0); for (let i = 0; i < this.shellCap; i++) this.shellMesh.setMatrixAt(i, _m4);
    this.shellMesh.instanceMatrix.needsUpdate = true;
    this.overlay.visible = false;
  }

  dispose() {
    this.clear();
    for (const o of [this.P.mesh, this.decals.mesh, this.shellMesh, this.overlay]) { this.scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
    for (const s of this.lights.slots) this.scene.remove(s.light);
    this.depth.dispose();
    this.tex.atlasTex.dispose(); this.tex.smokeTex.dispose(); this.tex.decalTex.dispose();
  }
}

// ------------------------------------------------------------------------------------------- flashbang rules
// CS2-style flash strength for one viewer.
//  eyePos, viewDir (unit), flashPos: THREE.Vector3; world: { raycast }; smokeBlocked(a,b) → bool (e.g. fx.smokeLineBlocked.bind(fx))
//  → { intensity 0..1 (peak whiteness), duration seconds (total blind incl. fade) }
const _fe = new THREE.Vector3(), _fd = new THREE.Vector3(), _fo = new THREE.Vector3(), _fs = new THREE.Vector3(), _ft = new THREE.Vector3();
export function computeFlash(eyePos, viewDir, flashPos, world, smokeBlocked) {
  _fd.subVectors(flashPos, eyePos); const dist = _fd.length();
  if (dist > 1600) return { intensity: 0, duration: 0 };
  if (dist < 1) return { intensity: 1, duration: 4.87 };
  _fd.divideScalar(dist);
  // visibility: centre + 4 offset samples around the flash (partial occlusion around corners)
  if (Math.abs(_fd.y) < 0.95) _fs.set(-_fd.z, 0, _fd.x).normalize(); else _fs.set(1, 0, 0);
  _ft.crossVectors(_fs, _fd);
  let vis = 0;
  for (let k = 0; k < 5; k++) {
    _fo.copy(flashPos);
    if (k === 1) _fo.addScaledVector(_fs, 9); else if (k === 2) _fo.addScaledVector(_fs, -9);
    else if (k === 3) _fo.addScaledVector(_ft, 9); else if (k === 4) _fo.addScaledVector(_ft, -9);
    _fe.subVectors(_fo, eyePos); const L = _fe.length(); _fe.divideScalar(L);
    const hit = world && world.raycast ? world.raycast(eyePos, _fe, L - 3) : null;
    if (!hit) vis += k === 0 ? 0.4 : 0.15;
  }
  if (vis <= 0.01) return { intensity: 0, duration: 0 };
  if (smokeBlocked && smokeBlocked(eyePos, flashPos)) return { intensity: 0, duration: 0 };
  // distance falloff: full within ~250u, useless beyond ~1500u
  const fd = dist < 250 ? 1 : clamp(1 - Math.pow((dist - 250) / 1250, 1.35), 0, 1);
  // view angle (CS: looking at it = full, sideways = reduced, behind = short partial)
  const dot = viewDir.x * _fd.x + viewDir.y * _fd.y + viewDir.z * _fd.z;
  let fa;
  if (dot >= 0.8) fa = 1;
  else if (dot >= 0.4) fa = 0.62 + (dot - 0.4) / 0.4 * 0.38;
  else if (dot >= -0.2) fa = 0.32 + (dot + 0.2) / 0.6 * 0.3;
  else fa = 0.18 + (dot + 1) / 0.8 * 0.14;
  const strength = fd * fa * Math.min(1, vis);
  const duration = 4.87 * strength;
  if (duration < 0.12) return { intensity: 0, duration: 0 };
  const intensity = clamp(Math.pow(strength, 0.6) * 1.15, 0, 1);
  return { intensity, duration };
}

export { surfaceClass };
