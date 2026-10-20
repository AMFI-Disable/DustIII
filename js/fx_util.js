// fx_util.js — small helpers shared by the FX modules (deterministic RNG, math, binary heap).
import * as THREE from 'three';

// Deterministic, fast RNG (mulberry32). All FX randomness goes through one of these so test
// screenshots are reproducible (FX.seed(n)).
export class RNG {
  constructor(seed = 1) { this.s = seed >>> 0; }
  seed(s) { this.s = s >>> 0; }
  next() {
    let t = (this.s = (this.s + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(n) { return (this.next() * n) | 0; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  // uniformly distributed unit vector
  unit(out) {
    const z = this.next() * 2 - 1, a = this.next() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    out.x = r * Math.cos(a); out.y = z; out.z = r * Math.sin(a);
    return out;
  }
  // random unit vector inside a cone around unit axis `n` with half-angle `ang` (radians), cosine-weighted-ish
  cone(out, n, ang) {
    const ca = Math.cos(ang);
    const z = ca + (1 - ca) * this.next();
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = this.next() * Math.PI * 2;
    // basis around n
    let tx, ty, tz;
    if (Math.abs(n.y) < 0.99) { tx = n.z; ty = 0; tz = -n.x; } else { tx = 1; ty = 0; tz = 0; }
    const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
    const bx = n.y * tz - n.z * ty, by = n.z * tx - n.x * tz, bz = n.x * ty - n.y * tx;
    const c = Math.cos(phi) * r, s = Math.sin(phi) * r;
    out.x = n.x * z + tx * c + bx * s;
    out.y = n.y * z + ty * c + by * s;
    out.z = n.z * z + tz * c + bz * s;
    return out;
  }
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// distance from point p to segment ab (all THREE.Vector3-like), squared
export function distSqPointSegment(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 1e-8 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + abx * t - px, dy = ay + aby * t - py, dz = az + abz * t - pz;
  return dx * dx + dy * dy + dz * dz;
}

// Segment vs AABB clip (slab). Returns false when no overlap; writes t0/t1 into out[0..1].
export function clipSegmentAABB(ax, ay, az, bx, by, bz, minx, miny, minz, maxx, maxy, maxz, out) {
  let t0 = 0, t1 = 1;
  const d = [bx - ax, by - ay, bz - az], o = [ax, ay, az], mn = [minx, miny, minz], mx = [maxx, maxy, maxz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < mn[i] || o[i] > mx[i]) return false; continue; }
    let ta = (mn[i] - o[i]) / d[i], tb = (mx[i] - o[i]) / d[i];
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  out[0] = t0; out[1] = t1; return true;
}

// Tiny binary min-heap of integer ids keyed by a Float32Array of priorities.
export class IndexHeap {
  constructor(cap, keys) { this.a = new Int32Array(cap); this.n = 0; this.k = keys; }
  clear() { this.n = 0; }
  push(id) {
    if (this.n >= this.a.length) { const b = new Int32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    const a = this.a, k = this.k; let i = this.n++; a[i] = id;
    while (i > 0) { const p = (i - 1) >> 1; if (k[a[p]] <= k[a[i]]) break; const t = a[p]; a[p] = a[i]; a[i] = t; i = p; }
  }
  peekKey() { return this.n ? this.k[this.a[0]] : Infinity; }
  pop() {
    const a = this.a, k = this.k; const top = a[0]; const last = a[--this.n];
    if (this.n > 0) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < this.n && k[a[l]] < k[a[m]]) m = l;
        if (r < this.n && k[a[r]] < k[a[m]]) m = r;
        if (m === i) break; const t = a[m]; a[m] = a[i]; a[i] = t; i = m;
      }
    }
    return top;
  }
}

// Reusable scratch vectors (module-level, never escape a function call).
export const V = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), e: new THREE.Vector3() };
export const DOWN = new THREE.Vector3(0, -1, 0);
export const UP = new THREE.Vector3(0, 1, 0);
