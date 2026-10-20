// fx_fire.js — molotov / incendiary inferno.
// Spreads over the ground with a distance-ordered flood fill on a 16u grid (raycast-validated: no climbing walls,
// small steps/stairs OK, drops down ledges ≤ 40u), irregular noisy outline within ~150u, ~1.3 s spread.
// Visual: animated flame sprites (fire_sheet, emissive, pivoted at their base) on every burning cell, flat ground
// glow, rising embers, thick dark smoke, one flickering FX point light. Burns 7 s then dies down cell by cell.
import * as THREE from 'three';
import { CELL, DECAL } from './fx_atlas.js';
import { M_PIVOT, M_FLAT, M_AXIAL, M_BILL } from './fx_particles.js';
import { clamp, smoothstep, IndexHeap } from './fx_util.js';

const CS = 16;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3(0, 1, 0), _p = new THREE.Vector3();
const _col = new THREE.Color();

export class Fire {
  constructor(fx, pos, opts = {}) {
    this.fx = fx; this.team = opts.team || 't';
    this.R = opts.radius ?? 150; this.life = opts.duration ?? 7;
    this.age = 0; this.alive = true; this.ext = -1;
    const gy = fx._groundY(pos.x, pos.y + 10, pos.z, 200);
    this.gy = gy ?? pos.y;
    this.pos = new THREE.Vector3(pos.x, this.gy, pos.z);
    this.ox = pos.x; this.oz = pos.z;
    const n = (this.n = 2 * Math.ceil((this.R + 24) / CS) + 1); this.ci = (n - 1) >> 1;
    const N = n * n;
    this.st = new Uint8Array(N); this.fl = new Float32Array(N); this.pd = new Float32Array(N).fill(Infinity);
    this.rt = new Float32Array(N); this.dt = new Float32Array(N).fill(1e9);
    this.heap = new IndexHeap(512, this.pd);
    const rng = (this.rng = fx.rng);
    // irregular outline: radius per direction
    this.ph = [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)];
    const c0 = this.ci * n + this.ci;
    this.pd[c0] = 0; this.fl[c0] = this.gy; this.st[c0] = 1; this.heap.push(c0);
    this.flames = []; this.cells = []; this.burning = 0;
    this.emEmber = 0; this.emSmoke = 0; this.light = null;
    this.cxSum = 0; this.czSum = 0; this.cySum = 0;
    this.minY = this.gy - 60; this.maxY = this.gy + 60;
    const self = this;
    this.handle = {
      get alive() { return self.alive; },
      get pos() { return self.pos; },
      team: this.team,
      damageAt: (p) => this.damageAt(p),
      extinguish: () => this.extinguish(),
      _fire: this,
    };
  }

  _rmax(x, z) {
    const a = Math.atan2(z - this.oz, x - this.ox), p = this.ph;
    const nz = 0.5 + 0.22 * Math.sin(a * 2 + p[0]) + 0.17 * Math.sin(a * 3 + p[1]) + 0.11 * Math.sin(a * 5 + p[2]);
    return this.R * (0.66 + 0.34 * nz);
  }
  cx(i) { return this.ox + ((i % this.n) - this.ci) * CS; }
  cz(i) { return this.oz + (((i / this.n) | 0) - this.ci) * CS; }

  _front() { // spread distance vs time (fast at first, then slows; ~1.3 s to full)
    const t = this.age; return this.R * 1.3 * (1 - Math.exp(-t * 2.4)) + 8;
  }

  _expand(budget) {
    const { n, st, fl, pd, heap } = this; const fx = this.fx;
    const front = this._front();
    const st0 = fx.stats, stop = fx._rayStop;
    while (heap.n && budget > 0 && st0.rays < stop && heap.peekKey() <= front) {
      const c = heap.pop(); if (st[c] === 2) continue;
      st[c] = 2; budget--;
      this.rt[c] = this.age;
      this.dt[c] = this.life - this.rng.range(0, 1.1);
      const x = this.cx(c), z = this.cz(c), f = fl[c];
      this.cells.push(c);
      this._ignite(c, x, z, f, pd[c]);
      const ix = c % n, iz = (c / n) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = ix + DIRS[k][0], nz = iz + DIRS[k][1];
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const ni = nz * n + nx; if (st[ni] === 2) continue;
        const wx = this.cx(ni), wz = this.cz(ni);
        const rr = Math.hypot(wx - this.ox, wz - this.oz);
        if (rr > this._rmax(wx, wz)) continue;
        const npd = Math.max(rr, pd[c] + CS * 0.75);
        if (npd >= pd[ni]) continue;
        // ground passage: low horizontal ray (fire never climbs walls), then floor probe
        _o.set(x, f + 15, z); _d.set((wx - x) / CS, 0, (wz - z) / CS);
        if (fx._ray(_o, _d, CS + 1)) continue;
        _o.set(wx, f + 15, wz);
        const hit = fx._ray(_o, fx._down, 60);
        if (!hit || hit.normal.y < 0.6) continue;
        const nf = hit.point.y;
        if (nf - f > 14 || f - nf > 40) continue;
        fl[ni] = nf; pd[ni] = npd; st[ni] = 1; heap.push(ni);
      }
    }
  }

  _ignite(c, x, z, f, pd) {
    const fx = this.fx, P = fx.P, sp = fx._sp, rng = this.rng;
    const centerK = 1 - clamp(pd / this.R, 0, 1);
    this.cxSum += x; this.czSum += z; this.cySum += f;
    const nFl = rng.next() < 0.55 + 0.35 * centerK ? 2 : 1;
    for (let k = 0; k < nFl; k++) {
      sp.reset();
      sp.ctrl = 1; sp.life = -1; sp.mode = M_PIVOT; sp.cell = CELL.FIRE0; sp.frames = 16; sp.fps = rng.range(18, 26); sp.frame0 = rng.int(16);
      sp.r = sp.g = sp.b = 0; sp.add = 0.55;
      const hot = rng.range(0.8, 1.25);
      sp.er = 2.6 * hot; sp.eg = 2.0 * hot; sp.eb = 1.6 * hot;
      sp.soft = 0.3; sp.nearK = 0.4; sp.flip = rng.sign();
      sp.size = 0; sp.alpha = 0; sp.aspect = rng.range(0.85, 1.15);
      const id = P.emit(sp); if (id < 0) return;
      const fs = (11 + 13 * centerK + rng.range(-2, 5)) * (k ? 0.75 : 1);
      P.x[id] = x + rng.range(-7, 7); P.y[id] = f - 1.5; P.z[id] = z + rng.range(-7, 7);
      P.age[id] = 0;
      this.flames.push({ id, c, fs, ph: rng.range(0, 6.28), w: rng.range(5, 9), t0: this.age + k * rng.range(0.05, 0.25) });
    }
    // charred ground (sparse lattice of soft burn decals, follows the burning shape)
    const ix = c % this.n, iz = (c / this.n) | 0;
    if ((ix - this.ci) % 3 === 0 && (iz - this.ci) % 3 === 0) {
      _p.set(x + rng.range(-4, 4), f, z + rng.range(-4, 4));
      _o.set(_p.x, f + 10, _p.z); const h = fx._ray(_o, fx._down, 30);
      if (h) fx.decals.add(DECAL.BURN, h.point, h.normal, rng.range(56, 72), rng.range(0, 6.28), null, 0.6, true);
    }
    // flat ground glow (every other cell)
    if (((c % this.n) + ((c / this.n) | 0)) % 2 === 0) {
      sp.reset();
      sp.ctrl = 1; sp.life = -1; sp.mode = M_FLAT; sp.ax = 0; sp.ay = 1; sp.az = 0; sp.cell = CELL.GLOW;
      sp.r = sp.g = sp.b = 0; sp.add = 1; sp.er = 1.1; sp.eg = 0.42; sp.eb = 0.12; sp.soft = -3; sp.nearK = 0;
      sp.size = 0; sp.alpha = 0; sp.rot = rng.range(0, 6.28);
      const id = P.emit(sp);
      if (id >= 0) { P.x[id] = x; P.y[id] = f + 1.2; P.z[id] = z; this.flames.push({ id, c, fs: 30, ph: rng.range(0, 6.28), w: 3, t0: this.age, glow: true }); }
    }
  }

  damageAt(p) {
    if (!this.alive || this.ext >= 0) return false;
    const fx = (p.x - this.ox) / CS + this.ci, fz = (p.z - this.oz) / CS + this.ci;
    const ix = Math.round(fx), iz = Math.round(fz); const n = this.n;
    if (ix < 0 || iz < 0 || ix >= n || iz >= n) return false;
    // check the cell and its neighbours (flames are ~16u wide)
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const jx = ix + dx, jz = iz + dz; if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
      const c = jz * n + jx; if (this.st[c] !== 2) continue;
      const cx = this.cx(c), cz = this.cz(c);
      if (Math.abs(p.x - cx) > 12 || Math.abs(p.z - cz) > 12) continue;
      if (this.age < this.rt[c] + 0.1 || this.age > this.dt[c]) continue;
      const h = p.y - this.fl[c];
      if (h >= -16 && h <= 30) return true;
    }
    return false;
  }

  extinguish() {
    if (!this.alive || this.ext >= 0) return;
    this.ext = this.age;
    const fx = this.fx, rng = this.rng, sp = fx._sp;
    // steam / smoke burst over the burning area
    const cnt = Math.min(14, 4 + (this.cells.length >> 3));
    for (let i = 0; i < cnt; i++) {
      const c = this.cells.length ? this.cells[rng.int(this.cells.length)] : -1;
      const x = c >= 0 ? this.cx(c) : this.ox, z = c >= 0 ? this.cz(c) : this.oz, y = c >= 0 ? this.fl[c] : this.gy;
      sp.reset();
      sp.x = x + rng.range(-8, 8); sp.y = y + 10; sp.z = z + rng.range(-8, 8);
      sp.vx = rng.range(-15, 15); sp.vy = rng.range(30, 70); sp.vz = rng.range(-15, 15); sp.drag = 0.8;
      sp.life = rng.range(1.6, 2.6); sp.s0 = 14; sp.s1 = rng.range(45, 70); sp.sPow = 2;
      sp.cell = CELL.SMOKE0 + rng.int(16); sp.r = sp.g = sp.b = 0.58; sp.a = 0.5; sp.fadeIn = 0.1; sp.fadeOut = 0.3;
      sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-0.4, 0.4); sp.phase = 0.6; sp.ao = 0.85;
      fx.P.emit(sp);
    }
  }

  update(dt) {
    if (!this.alive) return;
    this.age += dt;
    const fx = this.fx, P = fx.P, rng = this.rng, t = this.age, sp = fx._sp;
    const ending = this.ext >= 0;
    if (!ending && this.heap.n) this._expand(24);
    const endT = ending ? this.ext + 0.45 : this.life;
    if (t >= endT) { this.kill(); return; }
    // flames
    let burning = 0;
    for (let k = 0; k < this.flames.length; k++) {
      const F = this.flames[k]; const id = F.id;
      const te = t - F.t0;
      if (te < 0) { P.alpha[id] = 0; continue; }
      const d = this.dt[F.c];
      let s = smoothstep(0, 0.3, te);
      if (ending) s *= 1 - smoothstep(this.ext, this.ext + 0.4, t);
      else s *= 1 - smoothstep(d - 0.5, d, t);
      if (s > 0.5 && !F.glow) burning++;
      const fl = 1 + 0.12 * Math.sin(t * F.w + F.ph) + 0.08 * Math.sin(t * F.w * 2.3 + F.ph * 1.7);
      if (F.glow) {
        P.size[id] = F.fs * (0.85 + 0.25 * s); P.alpha[id] = s * (0.55 + 0.25 * Math.sin(t * 9 + F.ph));
      } else {
        P.size[id] = F.fs * s * fl; P.alpha[id] = Math.min(1, s * 1.2);
        P.age[id] = te; P.rot[id] = 0.08 * Math.sin(t * 1.3 + F.ph);
      }
    }
    this.burning = burning;
    // embers
    const nc = this.cells.length;
    if (nc && !ending) {
      this.emEmber += dt * Math.min(55, 10 + burning * 0.35);
      while (this.emEmber >= 1) {
        this.emEmber -= 1;
        const c = this.cells[rng.int(nc)]; if (t > this.dt[c]) continue;
        sp.reset();
        sp.x = this.cx(c) + rng.range(-8, 8); sp.y = this.fl[c] + rng.range(4, 30); sp.z = this.cz(c) + rng.range(-8, 8);
        sp.vx = rng.range(-25, 25); sp.vy = rng.range(60, 170); sp.vz = rng.range(-25, 25);
        sp.turb = 260; sp.drag = 0.6; sp.life = rng.range(0.7, 1.7); sp.s0 = rng.range(0.45, 0.8); sp.s1 = sp.s0 * 0.5;
        sp.mode = M_AXIAL; sp.stretch = 0.018; sp.minLen = 0.8; sp.cell = CELL.DOT;
        sp.r = sp.g = sp.b = 0; sp.add = 1; const h = rng.range(0.7, 1.3); sp.er = 9 * h; sp.eg = 3.6 * h; sp.eb = 0.9 * h;
        sp.fadeIn = 0.05; sp.fadeOut = 0.4; sp.soft = -1; sp.nearK = 0;
        P.emit(sp);
      }
      // dark smoke
      this.emSmoke += dt * Math.min(11, 3 + burning * 0.07);
      while (this.emSmoke >= 1) {
        this.emSmoke -= 1;
        const c = this.cells[rng.int(nc)]; if (t > this.dt[c] - 0.3) continue;
        sp.reset();
        sp.x = this.cx(c) + rng.range(-8, 8); sp.y = this.fl[c] + rng.range(25, 40); sp.z = this.cz(c) + rng.range(-8, 8);
        sp.vx = rng.range(-12, 12); sp.vy = rng.range(55, 95); sp.vz = rng.range(-12, 12); sp.buoy = 25; sp.drag = 0.25; sp.turb = 30;
        sp.life = rng.range(2.6, 3.8); sp.s0 = rng.range(16, 24); sp.s1 = rng.range(95, 140); sp.sPow = 1.6;
        sp.cell = CELL.SMOKE0 + rng.int(16); const g = rng.range(0.035, 0.06); sp.r = g; sp.g = g * 0.95; sp.b = g * 0.9;
        sp.a = rng.range(0.7, 0.85); sp.dens = 1.5; sp.fadeIn = 0.12; sp.fadeOut = 0.35; sp.rot = rng.range(0, 6.28); sp.rotV = rng.range(-0.3, 0.3);
        sp.phase = 0.35; sp.ao = 0.8; sp.hole = 1; sp.soft = 0.6;
        sp.er = 0.6; sp.eg = 0.22; sp.eb = 0.05; sp.eDecay = 2.2;     // glows orange at the base, cools as it rises
        P.emit(sp);
      }
    }
    // light
    if (nc) {
      const L = fx.lights;
      if (!this.light || this.light.owner !== this) this.light = L.acquire(this, 3);
      if (this.light) {
        const k = burning / Math.max(1, nc * 1.4);
        const fl = 0.82 + 0.1 * Math.sin(t * 17.3) + 0.08 * Math.sin(t * 31.1 + 1.3);
        _p.set(this.cxSum / nc, this.cySum / nc + 38, this.czSum / nc);
        L.set(this.light, _p, 1.0, 0.52, 0.2, 1.25e5 * Math.sqrt(Math.max(0.05, k)) * fl * (ending ? 1 - smoothstep(this.ext, this.ext + 0.4, t) : 1) * smoothstep(0, 0.15, t), 520);
      }
    }
  }

  kill() {
    if (!this.alive) return;
    this.alive = false;
    const P = this.fx.P;
    for (const F of this.flames) P.kill(F.id);
    this.flames.length = 0;
    if (this.light && this.light.owner === this) this.fx.lights.release(this.light);
    this.light = null;
  }
}
