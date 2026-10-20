// world_nav.js — nav graph on a 16u grid (multi-level columns) baked offline by tools/world_bake.mjs.
// A* (binary heap, octile heuristic, per-node wall-proximity costs) + string pulling via grid line-of-walk.
import * as THREE from 'three';

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

export class NavGrid {
  constructor(def, buf, raycast) {
    this.def = def; this.cell = def.cell; this.nx = def.nx; this.nz = def.nz; this.x0 = def.x0; this.z0 = def.z0;
    this.N = def.nodes;
    this.y = new Float32Array(buf, def.y, this.N);
    this.col = new Int32Array(buf, def.col, this.N);
    this.colStart = new Int32Array(buf, def.colStart, this.nx * this.nz + 1);
    this.nbr = new Int32Array(buf, def.nbr, this.N * 8);
    this.cost = new Uint8Array(buf, def.cost, this.N);
    this.comp = new Uint8Array(buf, def.comp, this.N);   // 0 dead, 1 main component, 2 island
    this.raycast = raycast;
    // search scratch
    this.g = new Float32Array(this.N); this.f = new Float32Array(this.N);
    this.parent = new Int32Array(this.N); this.stamp = new Uint32Array(this.N); this.closed = new Uint32Array(this.N); this.gen = 0;
    this.heap = new Int32Array(this.N + 8); this.hpos = new Int32Array(this.N);
    this.named = {};
    this.nxs = new Float32Array(this.N); this.nzs = new Float32Array(this.N);
    for (let n = 0; n < this.N; n++) { this.nxs[n] = this.x0 + (this.col[n] % this.nx) * this.cell; this.nzs[n] = this.z0 + ((this.col[n] / this.nx) | 0) * this.cell; }
    this.hWeight = 1.3;
  }
  // ---------------------------------------------------------- basic queries
  nodeX(n) { return this.nxs[n]; }
  nodeZ(n) { return this.nzs[n]; }
  nodePos(n, out = new THREE.Vector3()) { return out.set(this.nodeX(n), this.y[n], this.nodeZ(n)); }
  colIndex(x, z) {
    const i = Math.round((x - this.x0) / this.cell), j = Math.round((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return -1;
    return j * this.nx + i;
  }
  /** node in the column at (x,z) best matching height y (surface at or below y+maxUp preferred) */
  nodeAt(x, z, y = 1e4, maxUp = 40, mainOnly = true) {
    const c = this.colIndex(x, z); if (c < 0) return -1;
    let best = -1, bd = 1e9;
    for (let m = this.colStart[c]; m < this.colStart[c + 1]; m++) {
      if (!this.comp[m] || (mainOnly && this.comp[m] !== 1)) continue;
      const dy = this.y[m] - y;
      const score = dy > maxUp ? 1e6 + dy : Math.abs(dy);
      if (score < bd) { bd = score; best = m; }
    }
    return best;
  }
  /** nearest walkable node to pos (searches outward ring by ring) */
  nearestNode(pos, maxRadius = 400) {
    const ci = Math.round((pos.x - this.x0) / this.cell), cj = Math.round((pos.z - this.z0) / this.cell);
    const R = Math.ceil(maxRadius / this.cell);
    let best = -1, bd = 1e18;
    for (let r = 0; r <= R; r++) {
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
        const c = j * this.nx + i;
        for (let m = this.colStart[c]; m < this.colStart[c + 1]; m++) {
          if (this.comp[m] !== 1) continue;
          const dx = this.nodeX(m) - pos.x, dz = this.nodeZ(m) - pos.z, dy = (this.y[m] - pos.y);
          const d = dx * dx + dz * dz + (dy > 30 ? dy * dy * 9 : dy * dy * 1.5) + (this.cost[m] - 1) * 60;
          if (d < bd) { bd = d; best = m; }
        }
      }
      if (best >= 0 && r * this.cell > Math.sqrt(bd) + this.cell) break;
    }
    return best;
  }
  nearestWalkable(pos, maxRadius = 400) { const n = this.nearestNode(pos, maxRadius); return n < 0 ? null : this.nodePos(n); }
  heightAt(x, z, y = 1e4) {
    const n = this.nodeAt(x, z, y, 40, false);
    if (n >= 0) return this.y[n];
    const h = this.raycast(new THREE.Vector3(x, y === 1e4 ? 2000 : y + 40, z), new THREE.Vector3(0, -1, 0), 4000);
    return h ? h.point.y : 0;
  }
  isWalkable(x, z, y = 1e4) { return this.nodeAt(x, z, y, 40, true) >= 0; }
  randomPointNear(pos, radius = 300, tries = 40) {
    const start = this.nearestNode(pos, radius + 200);
    for (let t = 0; t < tries; t++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * radius;
      const x = pos.x + Math.cos(a) * r, z = pos.z + Math.sin(a) * r;
      const n = this.nodeAt(x, z, pos.y + 60, 80, true);
      if (n >= 0 && this.cost[n] <= 2 && Math.abs(this.y[n] - pos.y) < 200) return this.nodePos(n);
    }
    return start >= 0 ? this.nodePos(start) : pos.clone();
  }
  // ---------------------------------------------------------- A*
  _push(n) { const h = this.heap; let i = ++this.hsize; while (i > 1) { const p = i >> 1; if (this.f[h[p]] <= this.f[n]) break; h[i] = h[p]; this.hpos[h[i]] = i; i = p; } h[i] = n; this.hpos[n] = i; }
  _up(n) { const h = this.heap; let i = this.hpos[n]; while (i > 1) { const p = i >> 1; if (this.f[h[p]] <= this.f[n]) break; h[i] = h[p]; this.hpos[h[i]] = i; i = p; } h[i] = n; this.hpos[n] = i; }
  _pop() {
    const h = this.heap; const top = h[1]; const last = h[this.hsize--]; let i = 1;
    while (true) { let c = i * 2; if (c > this.hsize) break; if (c < this.hsize && this.f[h[c + 1]] < this.f[h[c]]) c++; if (this.f[h[c]] >= this.f[last]) break; h[i] = h[c]; this.hpos[h[i]] = i; i = c; }
    h[i] = last; this.hpos[last] = i; return top;
  }
  /** raw node path (array of node ids) or null */
  findNodePath(s, t, maxIter = 120000) {
    if (s < 0 || t < 0) return null;
    if (s === t) return [s];
    const gen = ++this.gen; this.hsize = 0;
    const X = this.nxs, Z = this.nzs, Y = this.y, G = this.g, F = this.f, NB = this.nbr, CO = this.cost, CP = this.comp, ST = this.stamp, CL = this.closed, PA = this.parent;
    const PEN = this.pen || null;
    const tx = X[t], tz = Z[t], ty = Y[t], W = this.hWeight;
    const H = (n) => { const dx = Math.abs(X[n] - tx), dz = Math.abs(Z[n] - tz); return ((dx > dz ? dx + 0.4142 * dz : dz + 0.4142 * dx) + Math.abs(Y[n] - ty) * 0.5) * W; };
    ST[s] = gen; G[s] = 0; F[s] = H(s); PA[s] = -1; this._push(s);
    let it = 0;
    while (this.hsize > 0 && it++ < maxIter) {
      const u = this._pop();
      if (u === t) { const out = []; for (let n = t; n >= 0; n = PA[n]) out.push(n); return out.reverse(); }
      CL[u] = gen;
      const uy = Y[u], gu = G[u], cu = CO[u];
      for (let k = 0; k < 8; k++) {
        const v = NB[u * 8 + k]; if (v < 0 || CL[v] === gen || CP[v] === 0) continue;
        const dy = Y[v] - uy;
        let step = (k & 1 ? 22.627 : 16) * (CO[v] + cu) * 0.5 + (PEN ? PEN[v] : 0);
        if (dy < -18.5) step += 40 - dy; else if (dy > 0) step += dy * 0.4;
        const ng = gu + step;
        if (ST[v] !== gen) { ST[v] = gen; G[v] = ng; F[v] = ng + H(v); PA[v] = u; this._push(v); }
        else if (ng < G[v]) { G[v] = ng; F[v] = ng + H(v); PA[v] = u; this._up(v); }
      }
    }
    return null;
  }
  /** walkable straight line between nodes a and b on the grid (no big height jumps, no blocked/near-wall cells) */
  lineWalkable(a, b, allowCost = 2) {
    const ax = this.nodeX(a), az = this.nodeZ(a), bx = this.nodeX(b), bz = this.nodeZ(b);
    const len = Math.hypot(bx - ax, bz - az); const steps = Math.ceil(len / (this.cell * 0.5));
    let cur = a, y = this.y[a];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps; const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const c = this.colIndex(x, z); if (c < 0) return false;
      if (c === this.col[cur]) continue;
      // must be reachable from cur via a neighbour edge (respects walls and steps)
      let next = -1;
      for (let k = 0; k < 8; k++) { const v = this.nbr[cur * 8 + k]; if (v >= 0 && this.col[v] === c) { next = v; break; } }
      if (next < 0) {
        // diagonal skip: try two-step through an orthogonal neighbour
        for (let k = 0; k < 8 && next < 0; k += 2) { const v = this.nbr[cur * 8 + k]; if (v < 0) continue; for (let q = 0; q < 8; q++) { const w = this.nbr[v * 8 + q]; if (w >= 0 && this.col[w] === c) { next = w; break; } } }
        if (next < 0) return false;
      }
      if (this.cost[next] > allowCost) return false;
      if (this.pen && this.pen[next] > 0) return false;   // never shortcut through learned bad spots
      if (this.y[next] < y - 18.5) return false;  // no drops on shortcuts
      y = this.y[next]; cur = next;
    }
    return cur === b || this.col[cur] === this.col[b];
  }
  /** smoothed world-space path (Vector3[] at floor height) */
  findPath(from, to, opts = {}) {
    const s = this.nearestNode(from), t = this.nearestNode(to);
    const np = this.findNodePath(s, t);
    if (!np) return [];
    if (opts.raw) return np.map(n => this.nodePos(n));
    // string pulling
    const out = [np[0]];
    let i = 0;
    while (i < np.length - 1) {
      let j = np.length - 1;
      const lim = Math.min(np.length - 1, i + 160);
      j = lim;
      while (j > i + 1 && !this.lineWalkable(np[i], np[j], Math.max(this.cost[np[i]], 2))) j = j - Math.max(1, ((j - i) >> 3));
      out.push(np[j]); i = j;
    }
    const pts = out.map(n => this.nodePos(n));
    if (opts.exact !== false && to) { const last = pts[pts.length - 1]; if (Math.hypot(last.x - to.x, last.z - to.z) < this.cell * 1.5) last.set(to.x, last.y, to.z); }
    return pts;
  }
  /** learned avoidance: make nodes around pos expensive (bots call this where they got physically stuck) */
  penalize(pos, radius = 40, amount = 400) {
    if (!this.pen) this.pen = new Float32Array(this.y.length);
    const r2 = radius * radius;
    for (let n = 0; n < this.y.length; n++) {
      const dx = this.nxs[n] - pos.x, dz = this.nzs[n] - pos.z;
      if (dx * dx + dz * dz < r2 && Math.abs(this.y[n] - pos.y) < 120) this.pen[n] = Math.min(4000, this.pen[n] + amount);
    }
  }
  /** path through a list of waypoints (e.g. botPoints.routes['long A']) */
  findRoute(waypoints, opts) {
    const out = [];
    for (let i = 1; i < waypoints.length; i++) {
      const seg = this.findPath(waypoints[i - 1], waypoints[i], opts);
      if (!seg.length) continue;
      if (out.length) seg.shift();
      out.push(...seg);
    }
    return out;
  }
  pathLength(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += pts[i].distanceTo(pts[i - 1]); return s; }
  // ---------------------------------------------------------- debug
  debugPoints() {
    const pos = [], col = [];
    for (let n = 0; n < this.N; n++) {
      if (!this.comp[n]) continue;
      pos.push(this.nodeX(n), this.y[n] + 3, this.nodeZ(n));
      const c = this.comp[n] === 2 ? [0.9, 0.2, 0.9] : (this.cost[n] >= 4 ? [1, 0.3, 0.1] : this.cost[n] >= 2 ? [1, 0.8, 0.1] : [0.1, 1, 0.3]);
      col.push(...c);
    }
    return { pos, col };
  }
  namedPoint(name) { const p = this.named[name]; return p ? p.clone() : null; }
}
