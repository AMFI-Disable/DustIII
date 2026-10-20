// fx_smoke.js — CS2-style smoke grenade volume.
//
// Volume: the cloud spreads by a distance-ordered flood fill over a 16u grid from the landing point. Each step
// between neighbouring cells is validated with world raycasts (horizontal at two heights, so smoke flows over
// low crates but never through walls; down-probe for the new floor; up-probe for ceilings), so it hugs the ground,
// follows stairs/ledges, stays inside rooms and corridors and never leaks through walls. The flood front advances
// at ~210 u/s which doubles as the deploy animation.
//
// Rendering: ~150–220 large lit puffs (smoke_sheet) per cloud on a 32u lattice inside the filled cells, which bloom
// out of the canister, then churn slowly. Each puff is lit with self-shadowing (optical depth toward the sun
// marched through the density grid), a world shadow ray, height-based AO and the FX point lights.
//
// Queries (CPU, exact w.r.t. the flood-filled grid): density(p), segmentOpacity(a,b), plus carved holes.
import * as THREE from 'three';
import { CELL } from './fx_atlas.js';
import { M_BILL } from './fx_particles.js';
import { clamp, smoothstep, IndexHeap, clipSegmentAABB } from './fx_util.js';

const CS = 16;              // grid cell size (matches nav grid)
const SPEED = 210;          // flood front speed u/s
const SIGMA = 0.06;         // extinction per unit at density 1 (≈ 40u of core → 0.91 opacity)
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _clip = [0, 0];

export class SmokeCloud {
  constructor(fx, pos, opts = {}) {
    this.fx = fx;
    this.R = opts.radius ?? 144; this.H = opts.height ?? 130;
    this.life = opts.duration ?? 18; this.fadeDur = opts.fade ?? 3;
    this.age = 0; this.alive = true; this.done = false;
    const gy = fx._groundY(pos.x, pos.y + 12, pos.z, 300);
    this.gy = gy ?? pos.y;
    this.pos = new THREE.Vector3(pos.x, this.gy, pos.z);
    this.ox = pos.x; this.oz = pos.z;
    const n = (this.n = 2 * Math.ceil((this.R + 32) / CS) + 1); this.ci = (n - 1) >> 1;
    const N = n * n;
    this.st = new Uint8Array(N);              // 0 unknown, 1 queued, 2 filled, 3 out of range
    this.fl = new Float32Array(N); this.top = new Float32Array(N); this.rt = new Float32Array(N);
    this.pd = new Float32Array(N).fill(Infinity); this.dir = new Uint8Array(N); this.known = new Uint8Array(N);
    this.edge = new Float32Array(N).fill(1); this.hasPuff = new Uint8Array(N);
    this.heap = new IndexHeap(512, this.pd);
    const c0 = this.ci * n + this.ci;
    this.pd[c0] = 0; this.fl[c0] = this.gy; this.dir[c0] = 1; this.known[c0] = 1; this.st[c0] = 1; this.heap.push(c0);
    this.puffs = [];
    this.minY = this.gy - 40; this.maxY = this.gy + this.H + 40;
    this.half = (this.ci + 0.5) * CS;
    this.lightCursor = 0; this.extCheck = 0;
    this.rng = fx.rng;
    this.handle = this._makeHandle();
  }

  _makeHandle() {
    const s = this;
    return {
      get pos() { return s.pos; },
      get alive() { return s.alive; },
      get age() { return s.age; },
      radius: s.R,
      density: (p) => s.density(p),
      segmentOpacity: (a, b) => s.segmentOpacity(a, b),
      clearRadius: (p, r, dur = 1) => s.fx.addSmokeHole(p, p, r, dur, true),
      carveLine: (a, b, r = 10, dur = 1) => s.fx.addSmokeHole(a, b, r, dur, false),
      dispose: () => s.kill(),
      _cloud: s,
    };
  }

  cx(i) { return this.ox + ((i % this.n) - this.ci) * CS; }
  cz(i) { return this.oz + (((i / this.n) | 0) - this.ci) * CS; }

  // ---------------------------------------------------------------- flood fill
  _passage(x, z, f, wx, wz) {
    const fx = this.fx; const dx = (wx - x) / CS, dz = (wz - z) / CS;
    _d.set(dx, 0, dz);
    for (const h of [18, 50]) {
      _o.set(x, f + h, z);
      if (fx._ray(_o, _d, CS + 2)) continue;     // blocked at this height
      // open: find the neighbour floor below
      _o.set(wx, f + h, wz);
      const hit = fx._ray(_o, fx._down, h + 80);
      const nf = hit ? hit.point.y : f - 80;
      if (nf - f > 54) return NaN;
      return nf;
    }
    return NaN;
  }

  _expand(budget) {
    const { n, st, fl, pd, dir, heap, known } = this;
    const front = Math.min(this.R * 1.4, this.age * SPEED) + 6;
    const st0 = this.fx.stats, stop = this.fx._rayStop;
    // budget: cells AND world raycasts per frame (FX-wide ray budget keeps the deploy cost flat)
    while (heap.n && budget > 0 && st0.rays < stop && heap.peekKey() <= front) {
      const c = heap.pop(); if (st[c] === 2) continue;
      st[c] = 2; budget--;
      this.rt[c] = this.age;
      const x = this.cx(c), z = this.cz(c), f = fl[c];
      const r = Math.hypot(x - this.ox, z - this.oz);
      const rn = r / (this.R + 26);
      const prof = Math.sqrt(Math.max(0, 1 - Math.pow(rn, 2.6)));
      const dome = this.gy + this.H * (0.18 + 0.82 * prof);
      _o.set(x, f + 4, z);
      const up = this.fx._ray(_o, this.fx._up, Math.max(40, dome + 30 - f));
      const ceil = up ? up.point.y - 3 : Infinity;
      this.top[c] = Math.min(ceil, Math.max(dome, f + 40));
      if (this.top[c] + 40 > this.maxY) this.maxY = this.top[c] + 40;
      if (f - 20 < this.minY) this.minY = f - 20;
      const ix = c % n, iz = (c / n) | 0;
      if (((ix - this.ci) & 1) === 0 && ((iz - this.ci) & 1) === 0) this._spawnColumn(c, 0);
      for (let k = 0; k < 4; k++) {
        const nx = ix + DIRS[k][0], nz = iz + DIRS[k][1];
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const ni = nz * n + nx; if (st[ni] === 2) continue;
        const wx = this.cx(ni), wz = this.cz(ni);
        const rr = Math.hypot(wx - this.ox, wz - this.oz);
        if (rr > this.R + 4) { if (st[ni] === 0) st[ni] = 3; continue; }
        const outward = (wx - x) * (x - this.ox) + (wz - z) * (z - this.oz) >= 0;
        const direct = dir[c] && outward;
        const npd = direct ? rr : pd[c] + CS;
        if (npd > this.R * 1.25) { if (st[ni] === 0) st[ni] = 3; continue; }
        if (npd >= pd[ni]) continue;
        let nf;
        if (known[ni]) {
          _o.set(x, f + 18, z); _d.set((wx - x) / CS, 0, (wz - z) / CS);
          if (this.fx._ray(_o, _d, CS + 2)) {
            _o.y = f + 50; if (this.fx._ray(_o, _d, CS + 2)) continue;
          }
          nf = fl[ni];
          if (nf - f > 54) continue;
        } else {
          nf = this._passage(x, z, f, wx, wz);
          if (nf !== nf) continue;
          known[ni] = 1; fl[ni] = nf;
        }
        pd[ni] = npd; dir[ni] = direct ? 1 : 0; st[ni] = 1; heap.push(ni);
      }
    }
    if (!heap.n && !this.done) this._finish();
  }

  _finish() {
    this.done = true;
    const { n, st } = this; const N = n * n;
    // cells not covered by any lattice column (narrow corridors / odd-cell gaps) get their own column
    for (let c = 0; c < N; c++) {
      if (st[c] !== 2 || this.hasPuff[c]) continue;
      const ix = c % n, iz = (c / n) | 0; let covered = false;
      for (let dz = -1; dz <= 1 && !covered; dz++) for (let dx = -1; dx <= 1; dx++) {
        const jx = ix + dx, jz = iz + dz; if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
        if (st[jz * n + jx] === 2 && ((jx - this.ci) & 1) === 0 && ((jz - this.ci) & 1) === 0) { covered = true; break; }
      }
      if (!covered) this._spawnColumn(c, 0.15);
    }
    // edge factor: chamfer distance (in cells) to "open" boundary (out-of-range cells), walls don't fade density
    const D = new Float32Array(N).fill(99);
    for (let c = 0; c < N; c++) {
      const ix = c % n, iz = (c / n) | 0;
      if (st[c] !== 2) { D[c] = st[c] === 3 || ix === 0 || iz === 0 || ix === n - 1 || iz === n - 1 ? 0 : 99; }
    }
    for (let pass = 0; pass < 2; pass++) {
      const s = pass ? -1 : 1;
      for (let k = 0; k < N; k++) {
        const c = pass ? N - 1 - k : k; if (st[c] !== 2) continue;
        const ix = c % n, iz = (c / n) | 0; let m = D[c];
        const a1 = ix - s, b1 = iz - s;
        if (a1 >= 0 && a1 < n) m = Math.min(m, D[iz * n + a1] + 1);
        if (b1 >= 0 && b1 < n) { m = Math.min(m, D[b1 * n + ix] + 1); if (a1 >= 0 && a1 < n) m = Math.min(m, D[b1 * n + a1] + 1.414); const a2 = ix + s; if (a2 >= 0 && a2 < n) m = Math.min(m, D[b1 * n + a2] + 1.414); }
        D[c] = m;
      }
    }
    for (let c = 0; c < N; c++) if (st[c] === 2) this.edge[c] = clamp((D[c] - 0.3) / 2.2, 0.25, 1);
    // thin out deep-interior puffs (never visible from outside; the inside-smoke overlay covers the camera case)
    let alt = 0;
    for (const p of this.puffs) {
      const c = p.cell; const ix = c % n, iz = (c / n) | 0;
      let inner = this.edge[c] >= 1 && p.by < this.top[c] - 46 && p.by > this.fl[c] + 30;
      if (inner) for (const [dx, dz] of DIRS) { const jx = ix + dx * 2, jz = iz + dz * 2; if (jx < 0 || jz < 0 || jx >= n || jz >= n || st[jz * n + jx] !== 2) { inner = false; break; } }
      p.inner = inner;
      if (inner && (alt++ % 2 === 0)) p.cull = true;
    }
  }

  _spawnColumn(c, delay) {
    this.hasPuff[c] = 1;
    const rng = this.rng, fx = this.fx, P = fx.P, sp = fx._sp;
    const x0 = this.cx(c), z0 = this.cz(c), f = this.fl[c], top = this.top[c];
    const h = top - f;
    let y = f + 22;
    const layers = Math.max(1, Math.floor((h - 34) / 28) + 1);
    const step = layers > 1 ? (h - 40) / (layers - 1) : 0;
    for (let L = 0; L < layers; L++) {
      y = layers > 1 ? f + 22 + step * L : Math.min(f + 26, top - 14);
      const hf = clamp((y - f) / Math.max(1, h), 0, 1);
      const isTop = L === layers - 1;
      const size = (isTop ? 56 : 50) * rng.range(0.78, 1.25);
      sp.reset();
      sp.ctrl = 1; sp.life = -1; sp.mode = M_BILL; sp.cell = CELL.SMOKE0 + rng.int(16);
      const g = 0.8 + rng.range(-0.03, 0.03);
      sp.r = g; sp.g = g; sp.b = g * 0.985; sp.alpha = 0; sp.size = size * 0.3;
      sp.rot = rng.range(0, Math.PI * 2); sp.flip = rng.sign();
      sp.sunVis = 0.5 + 0.5 * hf; sp.ao = 0.62 + 0.38 * hf; sp.phase = 0.9; sp.hole = 1; sp.floorY = f - 2; sp.soft = 0.6; sp.nearK = 0.95; sp.dens = 4;
      const id = P.emit(sp); if (id < 0) return;
      P.x[id] = this.ox; P.y[id] = this.gy + 10; P.z[id] = this.oz;
      // macro normal of the cloud at this puff (smooth large-scale shading instead of per-puff balls)
      { const nx = (x0 - this.ox) / this.R, ny = (y - (this.gy + this.H * 0.3)) / (this.H * 0.55), nz = (z0 - this.oz) / this.R;
        const l = Math.hypot(nx, ny, nz) || 1; P.ax[id] = nx / l; P.ay[id] = ny / l; P.az[id] = nz / l; }
      this.puffs.push({
        id, cell: c, size, hf,
        bx: x0 + rng.range(-7, 7), by: y + rng.range(-5, 5), bz: z0 + rng.range(-7, 7),
        sx: this.ox + (x0 - this.ox) * 0.3 + rng.range(-6, 6), sy: this.gy + (y - this.gy) * 0.3 + rng.range(6, 14), sz: this.oz + (z0 - this.oz) * 0.3 + rng.range(-6, 6),
        t0: this.age + delay, rotV: rng.range(-0.07, 0.07),
        a1: rng.range(3, 8), w1: rng.range(0.25, 0.55), p1: rng.range(0, 6.28),
        a2: rng.range(2, 5), w2: rng.range(0.2, 0.45), p2: rng.range(0, 6.28),
        a3: rng.range(3, 8), w3: rng.range(0.25, 0.55), p3: rng.range(0, 6.28),
        fd: rng.range(0, 1), ws: -1, inner: false, cull: false, dead: false,
      });
    }
  }

  // ---------------------------------------------------------------- density
  _cellD(c, y) {
    if (this.st[c] !== 2) return 0;
    const f = this.fl[c], t = this.top[c];
    const v = smoothstep(f - 8, f + 4, y) * (1 - smoothstep(t - 16, t + 22, y));
    if (v <= 0) return 0;
    const ramp = clamp((this.age - this.rt[c] - 0.08) / 0.45, 0, 1);
    return v * ramp * this.edge[c];
  }
  _densRaw(x, y, z) {
    if (y < this.minY || y > this.maxY) return 0;
    const fx = (x - this.ox) / CS + this.ci, fz = (z - this.oz) / CS + this.ci;
    const ix = Math.floor(fx), iz = Math.floor(fz); const tx = fx - ix, tz = fz - iz; const n = this.n;
    if (ix < 0 || iz < 0 || ix >= n - 1 || iz >= n - 1) return 0;
    const c = iz * n + ix;
    return (this._cellD(c, y) * (1 - tx) + this._cellD(c + 1, y) * tx) * (1 - tz) +
           (this._cellD(c + n, y) * (1 - tx) + this._cellD(c + n + 1, y) * tx) * tz;
  }
  _timeFade() {
    const s = this.life - this.fadeDur;
    return 1 - smoothstep(s + 0.4, this.life - 0.3, this.age);
  }
  density(p) {
    if (!this.alive) return 0;
    const d = this._densRaw(p.x, p.y, p.z);
    if (d <= 0) return 0;
    return d * this._timeFade() * this.fx._holeFactor(p.x, p.y, p.z);
  }
  segmentOpacity(a, b) {
    if (!this.alive) return 0;
    const h = this.half;
    if (!clipSegmentAABB(a.x, a.y, a.z, b.x, b.y, b.z, this.ox - h, this.minY, this.oz - h, this.ox + h, this.maxY, this.oz + h, _clip)) return 0;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z; const len = Math.hypot(dx, dy, dz);
    const segLen = (_clip[1] - _clip[0]) * len; if (segLen <= 0) return 0;
    const steps = Math.max(1, Math.ceil(segLen / 6)); const st = segLen / steps;
    const tf = this._timeFade(); let tau = 0;
    for (let i = 0; i < steps; i++) {
      const t = _clip[0] + ((i + 0.5) / steps) * (_clip[1] - _clip[0]);
      const x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
      const d = this._densRaw(x, y, z);
      if (d > 0) tau += d * this.fx._holeFactor(x, y, z) * st;
    }
    return 1 - Math.exp(-tau * SIGMA * tf);
  }

  // ---------------------------------------------------------------- lighting
  _relight(p) {
    const fx = this.fx; const s = fx.sunDir;
    if (p.ws < 0) { // world shadow ray toward the sun (once, within the frame's ray budget)
      if (fx.stats.rays < fx._rayStop + 12) { _o.set(p.bx, p.by + 10, p.bz); p.ws = fx._ray(_o, s, 4000) ? 0.4 : 1; }
    }
    const ws = p.ws < 0 ? 1 : p.ws;
    let tau = 0;
    for (let k = 1; k <= 6; k++) {
      const d = k * 24;
      tau += this._densRaw(p.bx + s.x * d, p.by + s.y * d, p.bz + s.z * d) * 24;
    }
    const T = Math.exp(-tau * 0.016);
    // up-looking occlusion → ambient
    let occ = 0; for (let k = 1; k <= 3; k++) occ += this._densRaw(p.bx, p.by + k * 30, p.bz);
    const P = fx.P;
    P.sunVis[p.id] = ws * (0.3 + 0.7 * T);
    P.ao[p.id] = (0.62 + 0.38 * p.hf) * (1 - 0.12 * occ);
  }

  // ---------------------------------------------------------------- update
  update(dt) {
    if (!this.alive) return;
    this.age += dt;
    const fx = this.fx, P = fx.P, t = this.age;
    if (!this.done) this._expand(28);
    if (this.age > this.extCheck) { this.extCheck = this.age + 0.12; if (this.age < 2) fx._smokeExtinguish(this); }
    if (t >= this.life) { this.kill(); return; }
    const fadeStart = this.life - this.fadeDur;
    // relight a few puffs per frame (all of them right after the fill completes)
    const np = this.puffs.length;
    if (np) {
      const cnt = Math.min(np, 14);
      for (let k = 0; k < cnt; k++) { this.lightCursor = (this.lightCursor + 1) % np; const p = this.puffs[this.lightCursor]; if (!p.dead && t > p.t0 + 0.2) this._relight(p); }
    }
    const holes = fx.holes;
    for (let k = 0; k < np; k++) {
      const p = this.puffs[k]; if (p.dead) continue;
      const id = p.id;
      const te = t - p.t0;
      if (te < 0) { P.alpha[id] = 0; continue; }
      if (p.cull && this.done && te > 1.2) { P.kill(id); p.dead = true; continue; }
      const k1 = Math.min(1, te / 0.5); const e = 1 - (1 - k1) * (1 - k1) * (1 - k1);
      const ch = e;
      let x = p.sx + (p.bx - p.sx) * e + ch * p.a1 * Math.sin(t * p.w1 + p.p1);
      let y = p.sy + (p.by - p.sy) * e + ch * p.a2 * Math.sin(t * p.w2 + p.p2);
      let z = p.sz + (p.bz - p.sz) * e + ch * p.a3 * Math.cos(t * p.w3 + p.p3);
      let size = p.size * (0.3 + 0.7 * e) * (1 + 0.05 * Math.sin(t * 0.7 + p.p1 * 3));
      let a = Math.min(1, te / 0.12);
      if (t > fadeStart) {
        const fs = fadeStart + p.fd * (this.fadeDur - 2.0);
        const f = smoothstep(fs, fs + 2.0, t);
        a *= 1 - f; y += f * 24 * (0.5 + p.hf); size *= 1 + 0.25 * f;
        const out = f * 14; x += (x - this.ox) / (this.R) * out; z += (z - this.oz) / (this.R) * out;
      }
      P.x[id] = x; P.y[id] = y; P.z[id] = z; P.size[id] = size; P.alpha[id] = a; P.rot[id] += p.rotV * dt;
      // hole flag: only puffs near an active carve run the per-pixel hole loop
      let hf = 0;
      for (let h = 0; h < holes.length; h++) {
        const H = holes[h]; if (H.s <= 0) continue;
        const rr = size + H.r + 8;
        if (fx._distSqSeg(x, y, z, H) < rr * rr) { hf = 1; break; }
      }
      P.hole[id] = hf;
    }
  }

  kill() {
    if (!this.alive) return;
    this.alive = false;
    for (const p of this.puffs) if (!p.dead) { this.fx.P.kill(p.id); p.dead = true; }
    this.puffs.length = 0;
  }
}
