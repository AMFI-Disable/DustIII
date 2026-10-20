// characters.js — procedural CT / T player models for DUST (three.js r170)
// Built in METERS, feet at origin, facing -Z. Skinned (one SkinnedMesh per material, shared skeleton),
// procedural locomotion / aiming / IK / actions and a verlet ragdoll for deaths.
import * as THREE from 'three';

const V3 = THREE.Vector3, Q4 = THREE.Quaternion, M4 = THREE.Matrix4;
const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const wrapA = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
function hash1(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise3(x, y, z) { // value noise, smooth
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const h = (a, b, c) => hash1(a * 157 + b * 113 + c * 271);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v), w) * 2 - 1;
}
const g2 = (x, y, cx, cy, sx, sy) => { const a = (x - cx) / sx, b = (y - cy) / sy; return Math.exp(-(a * a + b * b)); };
function interpKeys(keys, x, col) { // piecewise-linear (smoothed) interpolation of table rows [x, ...]
  if (x <= keys[0][0]) return keys[0][col];
  const n = keys.length;
  if (x >= keys[n - 1][0]) return keys[n - 1][col];
  for (let i = 0; i < n - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (x <= b[0]) {
      let t = (x - a[0]) / (b[0] - a[0]);
      // Catmull-Rom for smoothness
      const p0 = keys[Math.max(0, i - 1)][col], p1 = a[col], p2 = b[col], p3 = keys[Math.min(n - 1, i + 2)][col];
      const t2 = t * t, t3 = t2 * t;
      return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    }
  }
  return keys[n - 1][col];
}

// =====================================================================================
// Skeleton (bind pose, body space, meters). All bind rotations are identity.
// =====================================================================================
const ARM_A = 0.5, sA = Math.sin(ARM_A), cA = Math.cos(ARM_A);
const LU = 0.29, LF = 0.255;
const SH = [0.185, 1.455, 0.012];
const ELB = [SH[0] + LU * sA, SH[1] - LU * cA, SH[2]];
const WRI = [ELB[0] + LF * sA, ELB[1] - LF * cA, SH[2]];
const HIPJ = [0.092, 0.925, 0.0], KNEE = [0.098, 0.497, -0.008], ANK = [0.104, 0.085, 0.02];
const TOE = [0.112, 0.022, -0.118];
const HC = new V3(0, 1.705, -0.004); // head (skull) centre
const EYE_X = 0.0315, EYE_Y = 0.006;
const mx = (a) => [-a[0], a[1], a[2]];
const BONE_DEF = [
  ['hips', -1, [0, 0.975, 0.0]], ['spine', 0, [0, 1.095, 0.004]], ['chest', 1, [0, 1.285, 0.0]],
  ['neck', 2, [0, 1.512, 0.018]], ['head', 3, [0, 1.618, 0.006]],
  ['clavL', 2, [-0.028, 1.47, -0.01]], ['uarmL', 5, mx(SH)], ['farmL', 6, mx(ELB)], ['handL', 7, mx(WRI)],
  ['clavR', 2, [0.028, 1.47, -0.01]], ['uarmR', 9, SH], ['farmR', 10, ELB], ['handR', 11, WRI],
  ['thighL', 0, mx(HIPJ)], ['shinL', 13, mx(KNEE)], ['footL', 14, mx(ANK)],
  ['thighR', 0, HIPJ], ['shinR', 16, KNEE], ['footR', 17, ANK],
];
const B = {}; BONE_DEF.forEach((d, i) => { B[d[0]] = i; });
const NB = BONE_DEF.length;
const PARENT = BONE_DEF.map((d) => d[1]);
const BIND = BONE_DEF.map((d) => new V3(...d[2]));
const OFF = BIND.map((p, i) => (PARENT[i] < 0 ? p.clone() : p.clone().sub(BIND[PARENT[i]])));
const SIDES = {
  R: { s: 1, clav: B.clavR, uarm: B.uarmR, farm: B.farmR, hand: B.handR, thigh: B.thighR, shin: B.shinR, foot: B.footR },
  L: { s: -1, clav: B.clavL, uarm: B.uarmL, farm: B.farmL, hand: B.handL, thigh: B.thighL, shin: B.shinL, foot: B.footL },
};
const armDir = (s) => new V3(s * sA, -cA, 0);
const armLat = (s) => new V3(s * cA, sA, 0); // dorsal / outward
const LT = BIND[B.shinR].distanceTo(BIND[B.thighR]), LS = BIND[B.footR].distanceTo(BIND[B.shinR]);
// capsules for baked AO: {a, b, r, ex: bones whose vertices ignore this capsule}
const AO_CAPS = (() => {
  const v = (x) => new V3(...x);
  const C = [
    { a: v([0, 0.92, 0.0]), b: v([0, 1.42, 0.0]), r: 0.15, ex: [B.hips, B.spine, B.chest, B.neck, B.clavL, B.clavR] },
    { a: v([0, 1.66, 0.0]), b: v([0, 1.76, 0.0]), r: 0.095, ex: [B.head, B.neck] },
    { a: v([-0.035, 1.615, -0.045]), b: v([0.035, 1.615, -0.045]), r: 0.05, ex: [B.head] },
  ];
  for (const sd of ['R', 'L']) {
    const S = SIDES[sd]; const m = sd === 'L' ? mx : (x) => x;
    C.push({ a: v(m(SH)), b: v(m(ELB)), r: 0.055, ex: [S.uarm, S.clav, S.farm] });
    C.push({ a: v(m(ELB)), b: v(m(WRI)), r: 0.045, ex: [S.farm, S.uarm, S.hand] });
    C.push({ a: v(m(HIPJ)), b: v(m(KNEE)), r: 0.085, ex: [S.thigh, S.shin, B.hips] });
    C.push({ a: v(m(KNEE)), b: v(m(ANK)), r: 0.06, ex: [S.shin, S.thigh, S.foot] });
  }
  return C;
})();

// =====================================================================================
// Mesh data helpers ("M": plain arrays)
// =====================================================================================
function mNew() { return { p: [], n: [], uv: [], duv: [], idx: [], wear: [] }; }
const _t0 = new V3(), _t1 = new V3(), _t2 = new V3(), _t3 = new V3();

// parametric surface. fn(u,v,out) ; returns M with uv=(u,v), metric duv
function surf(nu, nv, fn, o = {}) {
  const M = mNew(); const W = nu + 1;
  const pts = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const p = new V3();
      fn(o.closeU && i === nu ? 0 : i / nu, j / nv, p, i, j);
      pts.push(p);
    }
  }
  // metric coords
  const du = new Float32Array(pts.length), dv = new Float32Array(pts.length);
  for (let j = 0; j <= nv; j++) for (let i = 1; i <= nu; i++) { const k = j * W + i; du[k] = du[k - 1] + pts[k].distanceTo(pts[k - 1]); }
  for (let i = 0; i <= nu; i++) for (let j = 1; j <= nv; j++) { const k = j * W + i; dv[k] = dv[k - W] + pts[k].distanceTo(pts[k - W]); }
  for (let k = 0; k < pts.length; k++) {
    const i = k % W, j = (k / W) | 0;
    M.p.push(pts[k].x, pts[k].y, pts[k].z); M.uv.push(i / nu, j / nv);
    M.duv.push(du[k] + (o.duOff || 0), dv[k] + (o.dvOff || 0)); M.wear.push(o.wearFn ? o.wearFn(i / nu, j / nv) : 0);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    if (o.skip && o.skip(i, j, (i + 0.5) / nu, (j + 0.5) / nv)) continue;
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    M.idx.push(a, b, d, a, d, c);
  }
  if (o.flip) flipM(M);
  else if (o.auto !== false) autoOrient(M);
  if (!o.noNormals) computeNormals(M);
  return M;
}
function flipM(M) { for (let k = 0; k < M.idx.length; k += 3) { const t = M.idx[k + 1]; M.idx[k + 1] = M.idx[k + 2]; M.idx[k + 2] = t; } }
function orientOut(M, ctr) { // flip so normals point away from ctr
  computeNormals(M); let sc = 0;
  for (let k = 0; k < M.p.length; k += 3) sc += M.n[k] * (M.p[k] - ctr.x) + M.n[k + 1] * (M.p[k + 1] - ctr.y) + M.n[k + 2] * (M.p[k + 2] - ctr.z);
  if (sc < 0) { flipM(M); computeNormals(M); }
  return M;
}
function autoOrient(M) {
  let cx = 0, cy = 0, cz = 0; const nv = M.p.length / 3;
  for (let k = 0; k < M.p.length; k += 3) { cx += M.p[k]; cy += M.p[k + 1]; cz += M.p[k + 2]; }
  cx /= nv; cy /= nv; cz /= nv;
  let s = 0;
  for (let k = 0; k < M.idx.length; k += 3) {
    const a = M.idx[k] * 3, b = M.idx[k + 1] * 3, c = M.idx[k + 2] * 3;
    _t0.set(M.p[b] - M.p[a], M.p[b + 1] - M.p[a + 1], M.p[b + 2] - M.p[a + 2]);
    _t1.set(M.p[c] - M.p[a], M.p[c + 1] - M.p[a + 1], M.p[c + 2] - M.p[a + 2]);
    _t0.cross(_t1);
    s += _t0.x * (M.p[a] - cx) + _t0.y * (M.p[a + 1] - cy) + _t0.z * (M.p[a + 2] - cz);
  }
  if (s < 0) flipM(M);
}
function computeNormals(M) {
  const nv = M.p.length / 3; const acc = new Float32Array(nv * 3);
  for (let k = 0; k < M.idx.length; k += 3) {
    const a = M.idx[k], b = M.idx[k + 1], c = M.idx[k + 2];
    _t0.set(M.p[b * 3] - M.p[a * 3], M.p[b * 3 + 1] - M.p[a * 3 + 1], M.p[b * 3 + 2] - M.p[a * 3 + 2]);
    _t1.set(M.p[c * 3] - M.p[a * 3], M.p[c * 3 + 1] - M.p[a * 3 + 1], M.p[c * 3 + 2] - M.p[a * 3 + 2]);
    _t0.cross(_t1);
    for (const v of [a, b, c]) { acc[v * 3] += _t0.x; acc[v * 3 + 1] += _t0.y; acc[v * 3 + 2] += _t0.z; }
  }
  const key = (v) => Math.round(M.p[v * 3] * 2e4) + ',' + Math.round(M.p[v * 3 + 1] * 2e4) + ',' + Math.round(M.p[v * 3 + 2] * 2e4);
  const map = new Map();
  for (let v = 0; v < nv; v++) {
    const k = key(v); let e = map.get(k);
    if (!e) { e = [0, 0, 0]; map.set(k, e); }
    e[0] += acc[v * 3]; e[1] += acc[v * 3 + 1]; e[2] += acc[v * 3 + 2];
  }
  M.n.length = 0;
  for (let v = 0; v < nv; v++) {
    const e = map.get(key(v)); const l = Math.hypot(e[0], e[1], e[2]) || 1;
    M.n.push(e[0] / l, e[1] / l, e[2] / l);
  }
}
function xformM(M, m) {
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  for (let k = 0; k < M.p.length; k += 3) {
    _t0.set(M.p[k], M.p[k + 1], M.p[k + 2]).applyMatrix4(m); M.p[k] = _t0.x; M.p[k + 1] = _t0.y; M.p[k + 2] = _t0.z;
    _t0.set(M.n[k], M.n[k + 1], M.n[k + 2]).applyMatrix3(nm).normalize(); M.n[k] = _t0.x; M.n[k + 1] = _t0.y; M.n[k + 2] = _t0.z;
  }
  if (m.determinant() < 0) flipM(M);
  return M;
}
function deformM(M, fn) { // fn(p:V3, n:V3) modifies in place
  for (let k = 0; k < M.p.length; k += 3) {
    _t2.set(M.p[k], M.p[k + 1], M.p[k + 2]); _t3.set(M.n[k], M.n[k + 1], M.n[k + 2]);
    fn(_t2, _t3); _t3.normalize();
    M.p[k] = _t2.x; M.p[k + 1] = _t2.y; M.p[k + 2] = _t2.z; M.n[k] = _t3.x; M.n[k + 1] = _t3.y; M.n[k + 2] = _t3.z;
  }
  return M;
}
// bend around vertical axis: surface facing -Z curves backward (radius R)
function bendY(M, R) {
  return deformM(M, (p, n) => {
    const th = p.x / R, r = R - p.z;
    p.x = r * Math.sin(th); p.z = R - r * Math.cos(th);
    const c = Math.cos(-th), s = Math.sin(-th); const nx = n.x * c + n.z * s, nz = -n.x * s + n.z * c; n.x = nx; n.z = nz;
  });
}
function bendX(M, R) { // surface facing -Z curves backward top/bottom (around horizontal axis)
  return deformM(M, (p, n) => {
    const th = p.y / R, r = R - p.z;
    p.y = r * Math.sin(th); p.z = R - r * Math.cos(th);
    const c = Math.cos(th), s = Math.sin(th); const ny = n.y * c + n.z * s, nz = -n.y * s + n.z * c; n.y = ny; n.z = nz;
  });
}

// rounded box: per-face region uv via o.reg(face) -> region name (atlas remap later via M.reg)
const FACES6 = [
  ['px', [1, 0, 0], [0, 0, -1], [0, 1, 0]], ['nx', [-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  ['py', [0, 1, 0], [1, 0, 0], [0, 0, -1]], ['ny', [0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ['pz', [0, 0, 1], [1, 0, 0], [0, 1, 0]], ['nz', [0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];
function roundedBox(w, h, d, r, o = {}) {
  if (o.cheap) { // 24-vertex box (12 tris), normals bent slightly outward to fake bevel highlights
    const g = new THREE.BoxGeometry(w, h, d); const M = mNew(); M.reg = [];
    const pa = g.attributes.position, na = g.attributes.normal, ua = g.attributes.uv;
    for (let k = 0; k < pa.count; k++) {
      const x = pa.getX(k), y = pa.getY(k), z = pa.getZ(k);
      M.p.push(x, y, z); const n = new V3(na.getX(k), na.getY(k), na.getZ(k)).multiplyScalar(2).add(new V3(x / w, y / h, z / d)).normalize();
      M.n.push(n.x, n.y, n.z); M.uv.push(ua.getX(k), ua.getY(k)); M.duv.push(ua.getX(k) * w, ua.getY(k) * h); M.wear.push(0.7); M.reg.push(o.reg ? o.reg('px') : null);
    }
    for (let k = 0; k < g.index.count; k++) M.idx.push(g.index.getX(k));
    return M;
  }
  const M = mNew(); M.reg = [];
  const hx = w / 2, hy = h / 2, hz = d / 2; r = Math.min(r, hx * 0.95, hy * 0.95, hz * 0.95);
  const ext = [hx, hy, hz]; const inner = [hx - r, hy - r, hz - r];
  for (const [name, N, U, Vv] of FACES6) {
    const ia = Math.abs(N[0]) ? 0 : Math.abs(N[1]) ? 1 : 2;
    const ua = Math.abs(U[0]) ? 0 : Math.abs(U[1]) ? 1 : 2, va = Math.abs(Vv[0]) ? 0 : Math.abs(Vv[1]) ? 1 : 2;
    const eu = ext[ua], ev = ext[va];
    const cu = [-eu, -eu + r, eu - r, eu], cv = [-ev, -ev + r, ev - r, ev];
    const base = M.p.length / 3; const reg = o.reg ? o.reg(name) : null;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const p = [0, 0, 0];
      p[ia] = N[ia] * ext[ia];
      p[ua] = cu[i] * (U[ua]); p[va] = cv[j] * (Vv[va]);
      const q = [clamp(p[0], -inner[0], inner[0]), clamp(p[1], -inner[1], inner[1]), clamp(p[2], -inner[2], inner[2])];
      let nx = p[0] - q[0], ny = p[1] - q[1], nz = p[2] - q[2]; const l = Math.hypot(nx, ny, nz);
      const edge = l > 1e-6 && (Math.abs(p[ua]) > inner[ua] + 1e-6 || Math.abs(p[va]) > inner[va] + 1e-6);
      if (l < 1e-9) { nx = N[0]; ny = N[1]; nz = N[2]; } else { nx /= l; ny /= l; nz /= l; }
      M.p.push(q[0] + nx * r, q[1] + ny * r, q[2] + nz * r); M.n.push(nx, ny, nz);
      const su = (cu[i] + eu) / (2 * eu), sv = (cv[j] + ev) / (2 * ev);
      M.uv.push(su, sv); M.duv.push(su * 2 * eu, sv * 2 * ev); M.wear.push(edge ? 1 : 0); M.reg.push(reg);
    }
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const a = base + j * 4 + i, b = a + 1, c = a + 4, dd = c + 1;
      M.idx.push(a, b, dd, a, dd, c);
    }
  }
  autoOrient(M);
  return M;
}
function lathe(prof, nu, o = {}) { // prof: [[r,y],...] bottom->top; around Y
  const nv = prof.length - 1;
  return surf(nu, nv, (u, v, p, i, j) => { const a = u * TAU; const r = prof[j][0]; p.set(Math.sin(a) * r, prof[j][1], -Math.cos(a) * r); }, { closeU: true, ...o });
}
// tube through path points with per-point radius (number or [rN, rB]) ; frames from 'ref'
function tubePath(path, radii, nu, o = {}) {
  const n = path.length; const T = [], N = [], L = [];
  const ref = o.ref || new V3(0, 0, -1);
  for (let j = 0; j < n; j++) {
    const t = new V3().subVectors(path[Math.min(n - 1, j + 1)], path[Math.max(0, j - 1)]).normalize();
    let nn = ref.clone().addScaledVector(t, -ref.dot(t));
    if (nn.lengthSq() < 1e-8) nn = (j > 0 ? N[j - 1].clone() : new V3(1, 0, 0)); nn.normalize();
    if (j > 0 && o.transport) { nn = N[j - 1].clone().addScaledVector(t, -N[j - 1].dot(t)).normalize(); }
    T.push(t); N.push(nn); L.push(new V3().crossVectors(nn, t));
  }
  const sq = o.square || 0; // superellipse exponent factor (0 round, ~0.8 boxy)
  return surf(nu, n - 1, (u, v, p, i, j) => {
    const a = u * TAU; let ca = Math.cos(a), sa = Math.sin(a);
    if (sq) { ca = Math.sign(ca) * Math.pow(Math.abs(ca), 1 - sq); sa = Math.sign(sa) * Math.pow(Math.abs(sa), 1 - sq); }
    const r = radii[j]; const rn = Array.isArray(r) ? r[0] : r, rb = Array.isArray(r) ? r[1] : r;
    p.copy(path[j]).addScaledVector(N[j], ca * rn).addScaledVector(L[j], sa * rb);
  }, { closeU: true, ...o });
}
function sphereM(r, nu, nv, o = {}) {
  return surf(nu, nv, (u, v, p) => { const a = u * TAU, ph = (v - 0.5) * Math.PI; p.set(Math.sin(a) * Math.cos(ph) * r, Math.sin(ph) * r, -Math.cos(a) * Math.cos(ph) * r); }, { closeU: true, ...o });
}
function catmull(pts, segs) { // smooth path through control points
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  return curve.getPoints(segs);
}
const mat4 = (pos, quat, scl) => new M4().compose(pos || new V3(), quat || new Q4(), scl || new V3(1, 1, 1));
const qe = (x, y, z, ord = 'XYZ') => new Q4().setFromEuler(new THREE.Euler(x, y, z, ord));

// =====================================================================================
// Atlas regions (must match tools/chars_gen_textures.py)
// =====================================================================================
const REG = {
  LEG: [0.0, 0.5, 0.25, 1.0], ARM: [0.25, 0.625, 0.5, 1.0], TORSO: [0.5, 0.75, 1.0, 1.0], MOLLE: [0.5, 0.5, 0.75, 0.75],
  POUCH: [0.75, 0.5, 0.875, 0.625], PLAIN: [0.875, 0.5, 1.0, 0.625], GLOVE: [0.75, 0.625, 1.0, 0.75], WRAP: [0.0, 0.0, 0.5, 0.5],
  BOOT: [0.5, 0.25, 0.75, 0.5], STRAP: [0.75, 0.375, 1.0, 0.5], CARGO: [0.25, 0.5, 0.5, 0.625], SOFT: [0.75, 0.25, 1.0, 0.375],
  KNIT: [0.5, 0.0, 0.75, 0.25], NYLON: [0.75, 0.0, 1.0, 0.25],
};

// =====================================================================================
// Builder: accumulates skinned vertices per material
// =====================================================================================
const MATS = ['cloth', 'pattern', 'skin', 'hard', 'gloss'];
const _col = new THREE.Color();
function colLin(hex) { _col.setHex(hex); return [_col.r, _col.g, _col.b]; } // sRGB hex -> linear
class Builder {
  constructor() { this.g = {}; for (const m of MATS) this.g[m] = { p: [], n: [], uv: [], duv: [], c: [], si: [], sw: [], ex: [], idx: [] }; }
  // o: { m: Matrix4, col: hex | fn(p)->hex , reg: region name | null, w: boneIndex | fn(p, side), rough, metal, wear, dust, mirror, uvFn(u,v,p)->[u,v], tint fn }
  add(mat, M, o = {}) {
    this._add(mat, M, o, false);
    if (o.mirror) this._add(mat, M, o, true);
  }
  _add(mat, M, o, mirror) {
    const G = this.g[mat]; const base = G.p.length / 3; const nv = M.p.length / 3;
    if (globalThis.__charStats) { const ln = (new Error().stack.split('\n')[mirror ? 4 : 3] || '').replace(/.*characters\.js[^:]*:(\d+).*/, '$1'); globalThis.__charStats.push([ln, mat, M.idx.length / 3]); }
    const m = o.m || null; const nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
    const side = mirror ? 'L' : (o.side || 'R');
    const p = new V3(), n = new V3();
    const rough = o.rough ?? (mat === 'cloth' || mat === 'pattern' ? 0.9 : 0.6), metal = o.metal ?? 0, wearAmt = o.wear ?? 0.6, dust = o.dust ?? 1.0;
    for (let k = 0; k < nv; k++) {
      p.set(M.p[k * 3], M.p[k * 3 + 1], M.p[k * 3 + 2]); n.set(M.n[k * 3], M.n[k * 3 + 1], M.n[k * 3 + 2]);
      if (m) { p.applyMatrix4(m); n.applyMatrix3(nm).normalize(); }
      if (mirror) { p.x = -p.x; n.x = -n.x; }
      G.p.push(p.x, p.y, p.z); G.n.push(n.x, n.y, n.z);
      let u = M.uv[k * 2], v = M.uv[k * 2 + 1];
      if (o.uvFn) [u, v] = o.uvFn(u, v, p);
      const rg = (M.reg && M.reg[k]) || o.reg;
      if (rg && REG[rg]) { const R = REG[rg]; u = R[0] + clamp(u, 0.004, 0.996) * (R[2] - R[0]); v = R[1] + clamp(v, 0.004, 0.996) * (R[3] - R[1]); }
      G.uv.push(u, v); G.duv.push(M.duv[k * 2] * (o.duvScale || 1), M.duv[k * 2 + 1] * (o.duvScale || 1));
      let c = typeof o.col === 'function' ? o.col(p, k, M) : (o.col ?? 0xffffff);
      const cl = Array.isArray(c) ? c : colLin(c);
      G.c.push(cl[0], cl[1], cl[2]);
      // skin weights
      let wl;
      if (typeof o.w === 'number') wl = [[o.w, 1]];
      else if (typeof o.w === 'function') wl = o.w(p, side);
      else wl = [[B.hips, 1]];
      if (mirror && typeof o.w === 'number') wl = [[MIRB[o.w], 1]];
      wl = wl.filter((e) => e[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
      let s = 0; for (const e of wl) s += e[1];
      for (let q = 0; q < 4; q++) { G.si.push(wl[q] ? wl[q][0] : 0); G.sw.push(wl[q] ? wl[q][1] / s : 0); }
      G.ex.push(rough, metal, (M.wear[k] || 0) * wearAmt + (o.wearBase || 0), dust);
    }
    for (let k = 0; k < M.idx.length; k += 3) {
      if (mirror) G.idx.push(base + M.idx[k], base + M.idx[k + 2], base + M.idx[k + 1]);
      else G.idx.push(base + M.idx[k], base + M.idx[k + 1], base + M.idx[k + 2]);
    }
  }
  // analytic ambient occlusion from body capsules (bind pose), baked into vertex colours
  bakeAO(strength = 1) {
    const caps = AO_CAPS;
    const p = new V3(), n = new V3(), q = new V3(), d = new V3();
    for (const m of MATS) {
      const G = this.g[m]; const nv = G.p.length / 3;
      for (let k = 0; k < nv; k++) {
        p.set(G.p[k * 3], G.p[k * 3 + 1], G.p[k * 3 + 2]); n.set(G.n[k * 3], G.n[k * 3 + 1], G.n[k * 3 + 2]);
        const dom = G.si[k * 4];
        let occ = 0;
        for (const c of caps) {
          if (c.ex.includes(dom)) continue;
          // closest point on segment
          d.subVectors(c.b, c.a); const t = clamp(q.subVectors(p, c.a).dot(d) / d.lengthSq(), 0, 1);
          q.copy(c.a).addScaledVector(d, t).sub(p); const dist = q.length();
          if (dist < c.r * 0.9) continue;
          const cosT = q.dot(n) / dist;
          if (cosT <= 0) continue;
          occ += cosT * (c.r * c.r) / (dist * dist);
        }
        // ground occlusion near the feet
        occ += 0.25 * smooth(0.12, 0.0, p.y) * Math.max(0, -n.y + 0.3);
        const ao = 1 - clamp(occ * 0.75 * strength, 0, 0.6);
        G.c[k * 3] *= ao; G.c[k * 3 + 1] *= ao; G.c[k * 3 + 2] *= ao;
      }
    }
  }
  build() {
    this.bakeAO();
    const out = {}; let tris = 0;
    for (const m of MATS) {
      const G = this.g[m]; if (!G.idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(G.p, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(G.n, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(G.uv, 2));
      geo.setAttribute('duv', new THREE.Float32BufferAttribute(G.duv, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(G.c, 3));
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(G.si, 4));
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(G.sw, 4));
      geo.setAttribute('extra', new THREE.Float32BufferAttribute(G.ex, 4));
      geo.setIndex(G.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(G.idx, 1) : new THREE.Uint16BufferAttribute(G.idx, 1));
      geo.boundingSphere = new THREE.Sphere(new V3(0, 0.9, 0), 2.2);
      out[m] = geo; tris += G.idx.length / 3;
    }
    return { geos: out, tris };
  }
}
const MIRB = []; for (let i = 0; i < NB; i++) {
  const nm = BONE_DEF[i][0]; let o = nm;
  if (nm.endsWith('L')) o = nm.slice(0, -1) + 'R'; else if (nm.endsWith('R')) o = nm.slice(0, -1) + 'L';
  MIRB[i] = B[o];
}

// =====================================================================================
// Skin weights
// =====================================================================================
function wTorso(p) {
  const y = p.y, ax = Math.abs(p.x), R = p.x >= 0;
  const keys = [[0.98, B.hips], [1.14, B.spine], [1.32, B.chest], [1.57, B.neck]];
  let w;
  if (y <= keys[0][0]) w = [[B.hips, 1]];
  else if (y >= keys[3][0]) w = [[B.neck, 1]];
  else for (let k = 0; k < 3; k++) if (y <= keys[k + 1][0]) { const t = smooth(keys[k][0], keys[k + 1][0], y); w = [[keys[k][1], 1 - t], [keys[k + 1][1], t]]; break; }
  const th = smooth(0.95, 0.80, y) * smooth(0.0, 0.08, ax) * 0.55;
  if (th > 0) { w.forEach((e) => { e[1] *= 1 - th; }); w.push([R ? B.thighR : B.thighL, th]); }
  const cl = smooth(1.36, 1.47, y) * smooth(0.08, 0.17, ax) * 0.6;
  if (cl > 0) { w.forEach((e) => { e[1] *= 1 - cl; }); w.push([R ? B.clavR : B.clavL, cl]); }
  return w;
}
function wArm(p, side) {
  const S = SIDES[side]; const sh = BIND[S.uarm], d = armDir(S.s);
  const t = (p.x - sh.x) * d.x + (p.y - sh.y) * d.y + (p.z - sh.z) * d.z;
  const f = smooth(0.25, 0.33, t), h = smooth(0.535, 0.57, t), c = smooth(0.05, -0.055, t) * 0.85;
  return [[S.clav, c], [S.uarm, (1 - c) * (1 - f)], [S.farm, f * (1 - h)], [S.hand, h]];
}
function wLeg(p, side) {
  const S = SIDES[side]; const y = p.y;
  const hp = smooth(0.9, 1.0, y) * 0.5, sh = smooth(0.535, 0.465, y), ft = smooth(0.14, 0.09, y) * 0.35;
  return [[B.hips, hp], [S.thigh, (1 - hp) * (1 - sh)], [S.shin, sh * (1 - ft)], [S.foot, sh * ft]];
}
function wShaft(p, side) { const S = SIDES[side]; const k = smooth(0.1, 0.21, p.y) * 0.6; return [[S.foot, 1 - k], [S.shin, k]]; }
function wNeck(p) { const t = smooth(1.53, 1.64, p.y); const c = smooth(1.53, 1.48, p.y); return [[B.chest, c], [B.neck, (1 - t) * (1 - c)], [B.head, t]]; }
function wHead(p) { const t = smooth(1.6, 1.66, p.y); return [[B.neck, 1 - t], [B.head, t]]; }

// =====================================================================================
// Body geometry
// =====================================================================================
// torso profile: y, W(half width), Df(front depth), Db(back depth), zc
const TORSO_KEYS = [
  [0.770, 0.020, 0.015, 0.015, 0.0], [0.790, 0.115, 0.065, 0.072, 0.0], [0.84, 0.158, 0.085, 0.095, 0.0],
  [0.90, 0.172, 0.092, 0.108, 0.0], [0.96, 0.170, 0.096, 0.104, 0.0], [1.03, 0.160, 0.098, 0.092, 0.0],
  [1.10, 0.152, 0.098, 0.083, 0.0], [1.18, 0.158, 0.104, 0.084, 0.0], [1.26, 0.170, 0.112, 0.088, 0.0],
  [1.34, 0.180, 0.118, 0.093, 0.0], [1.41, 0.188, 0.114, 0.099, 0.0], [1.455, 0.188, 0.102, 0.098, 0.005],
  [1.495, 0.17, 0.09, 0.092, 0.010], [1.53, 0.125, 0.074, 0.078, 0.015], [1.555, 0.074, 0.06, 0.066, 0.020], [1.565, 0.06, 0.05, 0.055, 0.02],
];
function torsoPoint(al, y, inflate, out) {
  const W = interpKeys(TORSO_KEYS, y, 1) + inflate, Df = interpKeys(TORSO_KEYS, y, 2) + inflate, Db = interpKeys(TORSO_KEYS, y, 3) + inflate, zc = interpKeys(TORSO_KEYS, y, 4);
  const s = Math.sin(al), c = Math.cos(al); const e = 2 / 2.6;
  const x = W * Math.sign(s) * Math.pow(Math.abs(s), e);
  const z = zc - (c > 0 ? Df : Db) * Math.sign(c) * Math.pow(Math.abs(c), e);
  return out.set(x, y, z);
}
function torsoMesh(y0, y1, inflate, nu, nv, o = {}) {
  return surf(nu, nv, (u, v, p) => {
    const y = lerp(y0, y1, v);
    torsoPoint(u * TAU, y, (typeof inflate === 'function' ? inflate(u * TAU, y) : inflate), p);
    if (o.deform) o.deform(p, u * TAU, y);
  }, { closeU: true, ...o });
}

// --- leg (right side), pants radius table (y, R)
const PANTS_KEYS = {
  cargo: [[0.105, 0.062], [0.14, 0.061], [0.2, 0.06], [0.28, 0.065], [0.37, 0.07], [0.44, 0.069], [0.5, 0.071], [0.56, 0.077], [0.65, 0.087], [0.75, 0.096], [0.85, 0.104], [0.92, 0.106], [0.965, 0.095], [0.995, 0.03]],
  slim: [[0.105, 0.052], [0.14, 0.050], [0.2, 0.051], [0.28, 0.058], [0.37, 0.064], [0.44, 0.063], [0.5, 0.065], [0.56, 0.07], [0.65, 0.078], [0.75, 0.086], [0.85, 0.094], [0.92, 0.098], [0.965, 0.09], [0.995, 0.03]],
};
function legCenter(y, out) {
  if (y >= KNEE[1]) { const t = (y - KNEE[1]) / (HIPJ[1] - KNEE[1]); return out.set(lerp(KNEE[0], HIPJ[0], t), y, lerp(KNEE[2], HIPJ[2], t)); }
  const t = (y - ANK[1]) / (KNEE[1] - ANK[1]); return out.set(lerp(ANK[0], KNEE[0], t), y, lerp(ANK[2], KNEE[2], t));
}
function legRadius(keys, al, y, extra) {
  let r = interpKeys(keys, y, 1) + extra;
  const s = Math.sin(al), c = Math.cos(al);
  r *= 1 - 0.16 * Math.max(0, -s) * smooth(0.74, 0.93, y);           // inner thigh flattening near crotch
  r *= 1 + 0.06 * c * smooth(0.55, 0.7, y) * smooth(0.95, 0.85, y);   // quads
  r *= 1 + 0.08 * (-c) * smooth(0.2, 0.3, y) * smooth(0.46, 0.38, y);  // calf
  r *= 1 + 0.035 * Math.cos(2 * al) * smooth(0.6, 0.9, y);
  return r;
}
function legMesh(style, extra = 0, hem = 0.105) {
  const keys = PANTS_KEYS[style] || PANTS_KEYS.cargo;
  const c = new V3();
  return surf(14, 20, (u, v, p) => {
    const y = lerp(hem, 0.995, v); const al = u * TAU; legCenter(y, c);
    let r = legRadius(keys, al, y, extra);
    if (hem > 0.12) r += 0.007 * smooth(hem + 0.07, hem, y);   // bloused over the boot
    // subtle cloth bunching noise
    r += 0.0025 * vnoise3(al * 1.3, y * 18, 3.1) * smooth(0.95, 0.85, y);
    p.set(c.x + Math.sin(al) * r, y, c.z - Math.cos(al) * r);
  }, { closeU: true });
}
// --- arm sleeve (right side). s along arm from the shoulder joint; v: 0 = wrist end, 1 = top
const SLEEVE_KEYS = [[-0.07, 0.0], [-0.062, 0.03], [-0.045, 0.052], [-0.02, 0.062], [0.01, 0.066], [0.06, 0.063], [0.12, 0.058], [0.18, 0.055], [0.24, 0.052], [0.29, 0.05], [0.33, 0.05], [0.38, 0.051], [0.44, 0.046], [0.5, 0.042], [0.535, 0.041], [0.56, 0.043]];
function armPoint(s, al, r, side, out) {
  const S = SIDES[side]; const d = armDir(S.s), lat = armLat(S.s);
  const c = BIND[S.uarm];
  return out.set(c.x + d.x * s + lat.x * Math.sin(al) * r, c.y + d.y * s + lat.y * Math.sin(al) * r, c.z - Math.cos(al) * r);
}
function sleeveMesh(s0, s1, extra, keys = SLEEVE_KEYS, v0 = 0, v1 = 1) {
  return surf(12, 16, (u, v, p) => {
    const s = lerp(s1, s0, v); const al = u * TAU;
    let r = interpKeys(keys, s, 1);
    if (r > 0.01) r += extra;
    r *= 1 + 0.07 * Math.cos(2 * al) * smooth(0.0, 0.1, s);          // flatter forearm
    r *= 1 + 0.08 * Math.sin(al) * smooth(0.08, -0.02, s);           // deltoid outward
    r += 0.0018 * vnoise3(al * 1.4, s * 25, 7.7) * (r > 0.01 ? 1 : 0);
    armPoint(s, al, r, 'R', p);
  }, { closeU: true });
}

// --- hand (right). Canonical frame: X' dorsal, Y' finger dir, Z' thumb side. curl = grip
function handMesh(o = {}) {
  const parts = [];
  const glove = !!o.glove;
  const g = glove ? 0.0018 : 0;
  // palm
  const palm = roundedBox(0.029 + g * 2, 0.088, 0.084 + g * 2, 0.012, {});
  deformM(palm, (p) => { p.x += -0.004 * (1 - (p.z / 0.045) ** 2); }); // cup
  xformM(palm, mat4(new V3(-0.004, 0.048, 0.003)));
  parts.push(palm);
  // wrist/cuff
  const cuffR = glove ? 0.036 : 0.029;
  parts.push(tubePath([new V3(-0.002, -0.035, 0.0), new V3(-0.002, -0.0, 0.0), new V3(-0.003, 0.02, 0.002)], [[cuffR * 0.85, cuffR], [cuffR * 0.8, cuffR * 0.98], [0.019, 0.034]], 10, { ref: new V3(1, 0, 0) }));
  // fingers
  const F = [[0.031, [0.043, 0.026, 0.021], 0.0098], [0.010, [0.047, 0.029, 0.022], 0.0102], [-0.010, [0.044, 0.027, 0.021], 0.0096], [-0.029, [0.035, 0.021, 0.019], 0.0086]];
  const curl = o.curl || [0.95, 1.45, 0.75];
  F.forEach(([z, L, rr], fi) => {
    const pts = [], rad = []; let ang = 0; const p = new V3(0.0, 0.088 - Math.abs(fi - 1.2) * 0.004, z);
    const spread = (fi - 1.5) * 0.04;
    pts.push(p.clone().add(new V3(0.003, -0.012, 0))); rad.push(rr * 1.05 + g);
    for (let k = 0; k < 3; k++) {
      ang += curl[k] * (1 + (fi === 3 ? 0.08 : 0));
      const dir = new V3(-Math.sin(ang), Math.cos(ang), spread);
      pts.push(p.clone()); rad.push(rr * (1 - k * 0.07) + g);
      p.addScaledVector(dir.normalize(), L[k]);
    }
    pts.push(p.clone()); rad.push(rr * 0.8 + g);
    // tip cap
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const dd = last.clone().sub(prev).normalize();
    pts.push(last.clone().addScaledVector(dd, rr * 0.45)); rad.push(rr * 0.68 + g);
    pts.push(last.clone().addScaledVector(dd, rr * 0.75)); rad.push(rr * 0.4);
    pts.push(last.clone().addScaledVector(dd, rr * 0.88)); rad.push(0.0005);
    parts.push(tubePath(pts, rad, 5, { ref: new V3(0, 0, 1) }));
  });
  // thumb (wraps across the palm side)
  {
    const tc = o.thumbPts || [[-0.004, 0.012, 0.022], [-0.016, 0.04, 0.041], [-0.033, 0.062, 0.038], [-0.046, 0.077, 0.024]];
    const pts = tc.map((q) => new V3(...q)); const rad = [0.0145 + g, 0.012 + g, 0.0105 + g, 0.0095 + g];
    const last = pts[3], dd = last.clone().sub(pts[2]).normalize();
    pts.push(last.clone().addScaledVector(dd, 0.004)); rad.push(0.0068 + g);
    pts.push(last.clone().addScaledVector(dd, 0.0075)); rad.push(0.0038);
    pts.push(last.clone().addScaledVector(dd, 0.0088)); rad.push(0.0005);
    parts.push(tubePath(pts, rad, 6, { ref: new V3(1, 0, 0), transport: true }));
  }
  return parts;
}
function handFrame(side) { // canonical hand -> bind body space
  const S = SIDES[side];
  const X = armLat(S.s), Y = armDir(S.s), Z = new V3().crossVectors(X, Y);
  const m = new M4().makeBasis(X, Y, Z); m.setPosition(BIND[S.hand]);
  return m;
}

// --- boot / shoe (right foot) in body coordinates
function bootMeshes(o = {}) {
  const sneaker = o.type === 'sneaker';
  const ax = ANK[0], az = ANK[2];
  const zH = az + 0.078, zT = az - 0.205;
  const WK = [[0, 0.031], [0.18, 0.034], [0.4, 0.037], [0.62, 0.044], [0.78, 0.045], [0.9, 0.041], [0.96, 0.034], [0.99, 0.022], [1.0, 0.01]];
  const HK = sneaker ? [[0, 0.088], [0.2, 0.108], [0.38, 0.102], [0.55, 0.082], [0.72, 0.068], [0.88, 0.062], [0.96, 0.054], [0.99, 0.046], [1.0, 0.04]]
    : [[0, 0.112], [0.2, 0.13], [0.38, 0.116], [0.55, 0.09], [0.72, 0.074], [0.88, 0.066], [0.96, 0.058], [0.99, 0.05], [1.0, 0.042]];
  const yb = sneaker ? 0.027 : 0.023;
  const out = {};
  out.upper = surf(14, 14, (u, v, p) => {
    const t = v; const z = lerp(zH, zT, t);
    const W = interpKeys(WK, t, 1) * (o.wide || 1), H = interpKeys(HK, t, 1);
    const b = u * TAU; const sb = Math.sin(b), cb = Math.cos(b);
    let x, yy;
    if (cb >= 0) { x = ax + 0.004 + t * 0.012 + W * Math.sign(sb) * Math.pow(Math.abs(sb), 0.75); yy = yb + (H - yb) * (0.5 + 0.5 * Math.pow(cb, 0.8)); }
    else { x = ax + 0.004 + t * 0.012 + W * Math.sign(sb) * Math.pow(Math.abs(sb), 0.3); yy = yb + (H - yb) * 0.5 * (1 - Math.pow(-cb, 0.35)); }
    const zz = z + (t < 0.02 ? 0 : 0) - (t > 0.97 ? 0 : 0);
    // heel rounding: pull back corners in
    const heel = smooth(0.12, 0.0, t);
    p.set(x - (x - ax - 0.004) * heel * 0.25, yy, zz + heel * 0.012 * (1 - Math.abs(sb)));
  }, { closeU: true });
  // shaft
  const top = sneaker ? 0.13 : 0.215;
  out.shaft = surf(12, 5, (u, v, p) => {
    const y = lerp(0.07, top, v); const al = u * TAU;
    const r = (sneaker ? 0.044 : 0.047) + (v > 0.85 ? 0.004 : 0) + 0.007 * (1 - v) * Math.max(0, -Math.cos(al));
    p.set(ax + 0.002 + Math.sin(al) * r * 0.95, y, az + 0.008 - Math.cos(al) * r * (Math.cos(al) > 0 ? 1.05 : 1.0));
  }, { closeU: true });
  // sole (extruded footprint)
  const shp = new THREE.Shape(); const N = 13;
  for (let k = 0; k <= N; k++) {
    const t = k / N; const W = interpKeys(WK, Math.min(t, 0.985), 1) * (o.wide || 1) + 0.0035;
    const x = ax + 0.004 + t * 0.012 + W; const z = lerp(zH + 0.004, zT - 0.005, t);
    if (k === 0) shp.moveTo(x, -z); else shp.lineTo(x, -z);
  }
  for (let k = N; k >= 0; k--) {
    const t = k / N; const W = interpKeys(WK, Math.min(t, 0.985), 1) * (o.wide || 1) + 0.0035;
    const x = ax + 0.004 + t * 0.012 - W; const z = lerp(zH + 0.004, zT - 0.005, t);
    shp.lineTo(x, -z);
  }
  const sh = sneaker ? 0.027 : 0.021;
  const eg = new THREE.ExtrudeGeometry(shp, { depth: sh - 0.006, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 1, curveSegments: 4 });
  eg.rotateX(-Math.PI / 2); eg.translate(0, 0.003, 0);
  const S = mNew(); const pa = eg.attributes.position, na = eg.attributes.normal;
  for (let k = 0; k < pa.count; k++) {
    S.p.push(pa.getX(k), pa.getY(k), pa.getZ(k)); S.n.push(na.getX(k), na.getY(k), na.getZ(k));
    S.uv.push(0, 0); S.duv.push(pa.getX(k), pa.getZ(k)); S.wear.push(pa.getY(k) > sh - 0.004 ? 0.6 : 0.2); S.idx.push(k);
  }
  out.sole = S;
  return out;
}

// --- head: radial function on a (theta, phi) grid, UV = equirect (matches python)
function headBase(dx, dy, dz) {
  const a = 0.0785 * (1 - 0.11 * smooth(-0.05, -0.8, dy));
  const b = dy > 0 ? 0.1215 : 0.124;
  const c = dz < 0 ? 0.101 * (1 - 0.05 * smooth(-0.3, -0.9, dy)) : 0.106;
  const n = 2.4;
  const S = Math.pow(Math.pow(Math.abs(dx / a), n) + Math.pow(Math.abs(dz / c), n), 2 / n) + (dy / b) * (dy / b);
  return 1 / Math.sqrt(S);
}
function headDisp(fx, fy, dx, dy, dz, o) {
  const fr = smooth(-0.2, -0.75, dz); const ax = Math.abs(fx);
  let d = 0;
  // occipital & parietal shaping
  d += 0.004 * Math.exp(-(((dy - 0.05) / 0.35) ** 2)) * smooth(0.4, 0.9, dz);
  // jaw angle
  d += 0.006 * g2(ax, fy, 0.064, -0.072, 0.014, 0.02) * smooth(0.7, 0.2, Math.abs(dz));
  if (fr <= 0) return d;
  let f = 0;
  // forehead & brow
  f += 0.0045 * g2(ax, fy, 0.03, 0.025, 0.026, 0.008) + 0.002 * g2(ax, fy, 0, 0.03, 0.02, 0.012);
  f -= 0.0018 * g2(ax, fy, 0.065, 0.025, 0.012, 0.02); // temples
  // eye socket
  f -= 0.0062 * g2(ax, fy, EYE_X, EYE_Y + 0.001, 0.0175, 0.0115);
  const ex = (ax - EYE_X) / 0.0135, ey = (fy - EYE_Y + 0.0006) / 0.0046;
  const hb = Math.pow(Math.max(0, 1 - ex * ex), 0.65);
  const lid = smooth(-0.35, 0.1, Math.abs(ey) - hb) * Math.exp(-((ex / 1.45) ** 4)) * Math.exp(-((ey / 2.3) ** 2));
  f += 0.0072 * lid * (ey > 0 ? 1.0 : 0.85);
  // cheekbones, cheeks
  f += 0.0055 * g2(ax, fy, 0.046, -0.013, 0.016, 0.012);
  f -= 0.0025 * g2(ax, fy, 0.05, -0.05, 0.015, 0.016);
  // nose
  const nh = 0.0055 + 0.0148 * smooth(0.012, -0.031, fy);
  const nw = lerp(0.0062, 0.0105, smooth(0.01, -0.03, fy));
  const nmask = smooth(0.02, 0.008, fy) * smooth(-0.043, -0.033, fy);
  f += nh * nmask * Math.exp(-((fx / nw) ** 2));
  f += 0.0065 * g2(ax, fy, 0.0135, -0.034, 0.0065, 0.0055); // alae
  f -= 0.002 * g2(ax, fy, 0.022, -0.036, 0.004, 0.006);
  // nasolabial
  const nl = Math.exp(-(((ax - (0.018 + (-0.035 - fy) * 0.33)) / 0.003) ** 2)) * smooth(-0.03, -0.04, fy) * smooth(-0.072, -0.06, fy);
  f -= 0.0015 * nl;
  // mouth area
  f += 0.007 * g2(fx, fy, 0, -0.056, 0.03, 0.02);
  f += 0.0035 * g2(fx * 0.95, fy, 0, -0.0535, 0.02, 0.0038) + 0.004 * g2(fx, fy, 0, -0.0635, 0.018, 0.0045);
  f -= 0.0022 * Math.exp(-(((fy + 0.058) / 0.0016) ** 2)) * smooth(0.028, 0.02, ax);
  f -= 0.0015 * g2(fx, fy, 0, -0.046, 0.004, 0.005); // philtrum
  // chin
  f += 0.0075 * g2(fx, fy, 0, -0.092, 0.019, 0.013);
  f -= 0.0022 * g2(fx, fy, 0, -0.075, 0.014, 0.004);
  d += f * fr;
  // beard volume
  if (o.beard) {
    const ath = Math.abs(Math.atan2(dx, -dz));
    const cb = interpArr([0.0, 0.12, 0.3, 0.8, 1.25, 1.38, 1.5], [-0.041, -0.040, -0.030, -0.024, -0.006, -0.02, -0.12], ath);
    let bm = smooth(cb + 0.004, cb - 0.012, fy) * (ath < 1.5 ? 1 : 0);
    bm = Math.max(bm, smooth(-0.45, -0.7, dy) * smooth(1.9, 1.5, ath));
    const lipm = g2(fx, fy, 0, -0.059, 0.026, 0.012);
    d += o.beard * bm * (1 - lipm * 0.85) * (0.6 + 0.4 * smooth(-0.05, -0.1, fy));
  }
  return d;
}
function interpArr(xs, ys, x) {
  if (x <= xs[0]) return ys[0]; for (let i = 0; i < xs.length - 1; i++) if (x <= xs[i + 1]) return lerp(ys[i], ys[i + 1], (x - xs[i]) / (xs[i + 1] - xs[i]));
  return ys[ys.length - 1];
}
// non-uniform grid distribution via density integration
function distrib(n, a, b, dens) {
  const S = 400; const xs = [], cs = [0];
  for (let i = 0; i <= S; i++) xs.push(a + (b - a) * i / S);
  for (let i = 1; i <= S; i++) cs.push(cs[i - 1] + (dens(xs[i - 1]) + dens(xs[i])) * 0.5);
  const tot = cs[S]; const out = [];
  for (let k = 0; k <= n; k++) {
    const tgt = tot * k / n; let i = 1; while (i < S && cs[i] < tgt) i++;
    const t = (tgt - cs[i - 1]) / (cs[i] - cs[i - 1] || 1); out.push(lerp(xs[i - 1], xs[i], t));
  }
  return out;
}
const HEAD_TH = distrib(40, -Math.PI, Math.PI, (t) => 1 + 2.6 * Math.exp(-((t / 0.6) ** 2)));
const HEAD_PH = distrib(30, -1.22, Math.PI / 2, (p) => 1 + 3.0 * Math.exp(-(((p - 0.03) / 0.2) ** 2)) + 1.0 * Math.exp(-(((p + 0.42) / 0.35) ** 2)));
function headDir(th, ph, out) { const c = Math.cos(ph); return out.set(Math.sin(th) * c, Math.sin(ph), -Math.cos(th) * c); }
function headPoint(th, ph, o, out, offset = 0) {
  headDir(th, ph, _t0); const r0 = headBase(_t0.x, _t0.y, _t0.z);
  const r = r0 + (o.noFeatures ? 0 : headDisp(_t0.x * r0, _t0.y * r0, _t0.x, _t0.y, _t0.z, o)) + offset;
  return out.set(HC.x + _t0.x * r, HC.y + _t0.y * r, HC.z + _t0.z * r);
}
function headMesh(o = {}) {
  const nu = HEAD_TH.length - 1, nv = HEAD_PH.length - 1;
  const skip = o.covered ? (i, j) => o.covered((HEAD_TH[i] + HEAD_TH[i + 1]) / 2, (HEAD_PH[j] + HEAD_PH[j + 1]) / 2) && o.covered(HEAD_TH[i], HEAD_PH[j]) && o.covered(HEAD_TH[i + 1], HEAD_PH[j + 1]) && o.covered(HEAD_TH[i + 1], HEAD_PH[j]) && o.covered(HEAD_TH[i], HEAD_PH[j + 1]) : undefined;
  const M = surf(nu, nv, (u, v, p, i, j) => headPoint(HEAD_TH[i], HEAD_PH[j], o, p, o.offsetFn ? o.offsetFn(HEAD_TH[i], HEAD_PH[j]) : 0), { closeU: true, auto: false, noNormals: true, skip });
  // uv: equirect
  for (let k = 0; k < M.uv.length; k += 2) {
    const i = Math.round(M.uv[k] * nu), j = Math.round(M.uv[k + 1] * nv);
    M.uv[k] = (HEAD_TH[i] / Math.PI + 1) / 2; M.uv[k + 1] = (HEAD_PH[j] + Math.PI / 2) / Math.PI;
  }
  autoOrient(M); computeNormals(M);
  M.nu = nu; M.nv = nv;
  return M;
}
function faceCoordsDir(fx, fy) { // find (th, ph) whose base point has face coords (fx, fy)
  let th = Math.asin(clamp(fx / 0.09, -1, 1)), ph = Math.asin(clamp(fy / 0.11, -1, 1));
  for (let k = 0; k < 30; k++) {
    headDir(th, ph, _t0); const r = headBase(_t0.x, _t0.y, _t0.z);
    th += (fx - _t0.x * r) / (r * Math.cos(ph)); ph += (fy - _t0.y * r) / r;
  }
  return [th, ph];
}
// split a mesh's triangles into two sets by predicate on triangle centroid uv/pos
function splitM(M, pred) {
  const A = { ...M, idx: [] }, Bm = { ...M, idx: [] };
  for (let k = 0; k < M.idx.length; k += 3) {
    const a = M.idx[k], b = M.idx[k + 1], c = M.idx[k + 2];
    const cx = (M.p[a * 3] + M.p[b * 3] + M.p[c * 3]) / 3, cy = (M.p[a * 3 + 1] + M.p[b * 3 + 1] + M.p[c * 3 + 1]) / 3, cz = (M.p[a * 3 + 2] + M.p[b * 3 + 2] + M.p[c * 3 + 2]) / 3;
    (pred(cx, cy, cz, k / 3) ? A : Bm).idx.push(a, b, c);
  }
  return [A, Bm];
}
function earMesh() {
  const M = sphereM(1, 10, 8);
  deformM(M, (p, n) => {
    // local: x outward thickness, y height, z width (front-back)
    const ox = p.x, oy = p.y, oz = p.z;
    let x = ox * 0.007, y = oy * 0.031, z = oz * 0.017;
    const rr = Math.hypot(oy, oz);
    if (ox > 0) x -= 0.0055 * smooth(0.75, 0.35, rr); // concha bowl
    x += 0.004 * smooth(0.5, 0.95, rr) * (ox > -0.2 ? 1 : 0); // helix rim thickness
    p.set(x, y, z);
    n.set(ox / 0.007, oy / 0.031, oz / 0.017);
  });
  return M;
}

// =====================================================================================
// Variant definitions
// =====================================================================================
const C = {
  navy: 0x1f2938, navyD: 0x171f2b, charcoal: 0x2a2c2f, black: 0x19191b, ranger: 0x3b4134, rangerD: 0x30362b, wolf: 0x4b4f53, shirtGray: 0x585d63,
  coyote: 0x6a5a45, olive: 0x535238, oliveD: 0x44432e, sand: 0xa58c66, khaki: 0x8f7c58, tan: 0x987f5c, brown: 0x5b4431, brownD: 0x3f3226,
  rust: 0x7a3e2c, gray: 0x7d7c78, offwhite: 0xc9c1b1, rubber: 0x1e1d1c, metal: 0x3a3b3c, brass: 0x9a7a3e, polymer: 0x232425,
};
const VARIANTS = {
  ct: [
    { face: 'ct0', torso: C.shirtGray, sleeve: C.navy, pants: C.navy, pantsStyle: 'cargo', boots: { type: 'boot', col: C.black }, gloves: C.black,
      head: { type: 'helmet', col: C.charcoal, nvg: true, cover: false }, mask: { type: 'balaclava', col: C.black }, headset: C.polymer,
      carrier: { col: 0x222326, mags: 3, radio: true, admin: true }, kneepads: C.black, holster: true, belt: C.black, eyes: 'none' },
    { face: 'ct1', torso: C.rangerD, sleeve: C.ranger, pants: C.charcoal, pantsStyle: 'cargo', boots: { type: 'boot', col: 0x2c2620 }, gloves: 0x45463a,
      head: { type: 'cap', col: C.black }, headset: 0x34362f, beard: 0.0035, carrier: { col: C.ranger, mags: 3, radio: true, admin: false }, holster: true, belt: C.rangerD,
      eyes: 'sun', lens: 0x101820 },
    { face: 'ct2', torso: C.charcoal, sleeve: C.charcoal, pants: 0x26282b, pantsStyle: 'cargo', boots: { type: 'boot', col: C.black }, gloves: C.black,
      head: { type: 'helmet', col: C.black, nvg: false }, mask: { type: 'balaclava', col: 0x1c1d20 }, headset: C.polymer, goggles: true,
      carrier: { col: 0x1d1e20, mags: 3, radio: true, admin: true, heavy: true }, kneepads: C.black, holster: true, belt: C.black },
    { face: 'ct3', torso: C.wolf, sleeve: C.wolf, pants: C.rangerD, pantsStyle: 'cargo', boots: { type: 'boot', col: 0x3a3128 }, gloves: 0x3d4035,
      head: { type: 'helmet', col: C.ranger, nvg: true, cover: true }, headset: 0x2f332a, carrier: { col: C.ranger, mags: 3, radio: true, admin: true },
      kneepads: C.rangerD, holster: false, dump: true, belt: C.rangerD, eyes: 'clear', lens: 0x8a6a2a },
    { face: 'ct4', torso: C.navyD, sleeve: C.navy, pants: C.navy, pantsStyle: 'slim', boots: { type: 'boot', col: C.black }, gloves: 0x24262a,
      head: { type: 'helmet', col: 0x2d3440, nvg: false, light: true }, headset: C.polymer, carrier: { col: 0x262a30, mags: 2, radio: false, admin: true },
      kneepads: 0x262a30, holster: true, belt: C.black, eyes: 'sun', lens: 0x1a1410, pack: { col: 0x232a35, size: 0.85 } },
  ],
  t: [
    { face: 't0', torso: C.sand, sleeve: C.sand, pants: C.olive, pantsStyle: 'cargo', boots: { type: 'sneaker', col: C.gray, sole: C.offwhite }, gloves: null,
      tunic: C.sand, head: { type: 'wrapfull', col: 0xb3a585, pat: 0x2d241c }, rig: { col: C.brown, mags: 4 }, beard: 0.003 },
    { face: 't1', torso: C.brown, sleeve: C.brown, pants: C.khaki, pantsStyle: 'cargo', boots: { type: 'boot', col: 0x4a3626 }, gloves: null,
      jacket: { col: 0x5e4630, collar: true }, mask: { type: 'balaclava', col: 0x1e1d1b }, bandolier: { col: 0x4d3a28 }, belt: 0x3a2c20 },
    { face: 't2', torso: C.khaki, sleeve: C.khaki, rolled: true, pants: C.oliveD, pantsStyle: 'cargo', boots: { type: 'sneaker', col: 0x5a5650, sole: 0xb0a898 }, gloves: null,
      head: { type: 'beanie', col: 0x3c3a2c }, beard: 0.0055, scarf: { col: 0xa9946c }, rig: { col: C.tan, mags: 3 } },
    { face: 't3', torso: 0xa8946f, sleeve: 0xa8946f, pants: C.olive, pantsStyle: 'cargo', boots: { type: 'boot', col: 0x6b5641 }, gloves: null,
      head: { type: 'turban', col: 0xa89a7c, pat: 0x6b2a20 }, beard: 0.006, vest: { col: C.brownD }, bandolier: { col: 0x5a4430 }, belt: 0x3d3024 },
    { face: 't4', torso: C.olive, sleeve: C.olive, pants: C.sand, pantsStyle: 'cargo', boots: { type: 'boot', col: 0x8a7556 }, gloves: 0x7d6a4e,
      jacket: { col: 0x4f5036, collar: true }, mask: { type: 'balaclava', col: 0x9b8763 }, neckwrap: { col: 0xc4b797, pat: 0x5a2a20 }, goggles: 'forehead',
      rig: { col: 0x6f5d43, mags: 3 }, pack: { col: 0x6b5a40, size: 1.0 } },
  ],
};

// =====================================================================================
// Character geometry assembly
// =====================================================================================
function buildVariant(team, vi) {
  const V = VARIANTS[team][vi];
  const bd = new Builder();
  const isT = team === 't';
  const clothRough = 0.92;

  // ---------- torso / shirt ----------
  const jacket = V.jacket;
  const torsoInfl = jacket ? 0.014 : 0.0;
  const pantsTop = 1.06;
  const shirtCol = jacket ? jacket.col : V.torso;
  {
    const M = torsoMesh(0.77, 1.565, (al, y) => torsoInfl * smooth(0.98, 1.08, y) + 0.004 * vnoise3(al * 2, y * 14, 1.3), 20, 19);
    bd.add('cloth', M, { reg: 'TORSO', w: wTorso, col: (p) => (p.y < pantsTop - (jacket ? 0.13 : 0) && !V.tunic ? V.pants : shirtCol), rough: clothRough, uvFn: (u, v, p) => [u, (p.y - 0.8) / 0.75] });
  }
  if (jacket) {
    // jacket hem (lower part hanging over hips)
    const M = surf(26, 3, (u, v, p) => { const y = lerp(0.9, 0.99, v); torsoPoint(u * TAU, y, 0.017 + 0.004 * (1 - v), p); }, { closeU: true });
    bd.add('cloth', M, { reg: 'TORSO', w: wTorso, col: jacket.col, uvFn: (u, v, p) => [u, (p.y - 0.8) / 0.75] });
    // collar
    const col = tubePath(catmull([new V3(0, 1.505, -0.075), new V3(0.075, 1.52, -0.035), new V3(0.08, 1.545, 0.04), new V3(0, 1.56, 0.078), new V3(-0.08, 1.545, 0.04), new V3(-0.075, 1.52, -0.035), new V3(0, 1.505, -0.075)], 20),
      Array(21).fill([0.009, 0.026]), 6, { ref: new V3(0, 1, 0), transport: true });
    bd.add('cloth', col, { reg: 'PLAIN', w: wNeck, col: jacket.col });
    // chest pockets
    for (const s of [-1, 1]) {
      const pk = roundedBox(0.105, 0.12, 0.016, 0.005, { reg: () => 'CARGO' });
      bendY(pk, 0.3);
      xformM(pk, mat4(new V3(s * 0.085, 1.33, -0.128), qe(0.12, -s * 0.33, 0)));
      bd.add('cloth', pk, { w: wTorso, col: jacket.col });
    }
  }
  if (V.tunic) {
    // long untucked shirt skirt over hips/thighs
    const M = surf(26, 6, (u, v, p) => {
      const y = lerp(0.70, 1.0, v); const al = u * TAU;
      const fl = smooth(0.95, 0.72, y);
      torsoPoint(al, Math.max(y, 0.9), 0.016 + fl * 0.056 + 0.007 * vnoise3(al * 3, y * 9, 4.4), p);
      p.y = y; p.x *= 1 + fl * 0.16;
    }, { closeU: true });
    bd.add('cloth', M, { reg: 'TORSO', col: V.tunic, w: (p) => {
      const ax = Math.abs(p.x); const s = p.x >= 0 ? 'R' : 'L';
      const k = smooth(0.97, 0.8, p.y) * smooth(0.0, 0.06, ax) * 0.85;
      return [[B.hips, 1 - k], [SIDES[s].thigh, k]];
    }, uvFn: (u, v, p) => [u, clamp((p.y - 0.8) / 0.75, 0, 1)] });
  }
  // shirt collar (mock neck) for non-jacket
  if (!jacket && !V.scarf && !(V.head && V.head.type === 'wrapfull')) {
    const ring = surf(18, 2, (u, v, p) => { const al = u * TAU; const y = lerp(1.5, 1.578, v) - 0.016 * Math.cos(al); const r = lerp(0.085, 0.072, v);
      p.set(Math.sin(al) * r * 0.95, y, 0.02 - Math.cos(al) * r); }, { closeU: true });
    bd.add('cloth', ring, { reg: 'PLAIN', w: wNeck, col: V.torso });
  }

  // ---------- legs ----------
  bd.add('cloth', legMesh(V.pantsStyle, 0, V.boots.type === 'boot' ? 0.165 : 0.105), { reg: 'LEG', w: wLeg, mirror: true, col: V.tunic ? (p) => (p.y > 0.8 ? V.tunic : V.pants) : V.pants, uvFn: (u, v, p) => [u, (p.y - 0.10) / 0.89] });
  // cargo pockets on thighs (outer side)
  if (V.pantsStyle === 'cargo' && !V.tunic) {
    const pk = roundedBox(0.135, 0.17, 0.03, 0.008, { reg: () => 'CARGO' });
    bendY(pk, 0.09);
    xformM(pk, mat4(new V3(HIPJ[0] + 0.088, 0.70, -0.008), qe(0, Math.PI / 2 - 0.1, 0)));
    bd.add('cloth', pk, { w: wLeg, mirror: true, col: V.pants });
  }

  // ---------- arms ----------
  if (V.rolled) {
    const sk = SLEEVE_KEYS.filter((k) => k[0] < 0.2).concat([[0.2, 0.06], [0.215, 0.064], [0.235, 0.062], [0.25, 0.05]]);
    const sl = surf(14, 16, (u, v, p) => { const s = lerp(0.25, -0.07, v); const al = u * TAU; let r = interpKeys(sk, s, 1);
      r *= 1 + 0.08 * Math.sin(al) * smooth(0.08, -0.02, s); r += 0.003 * vnoise3(al * 2, s * 30, 2) * (s > 0.18 ? 1 : 0.4); armPoint(s, al, r, 'R', p); }, { closeU: true });
    bd.add('cloth', sl, { reg: 'ARM', w: wArm, mirror: true, col: V.sleeve, uvFn: (u, v, p) => [u, v * 0.42 + 0.58] });
    const FK = [[0.19, 0.05], [0.26, 0.047], [0.32, 0.046], [0.38, 0.046], [0.45, 0.04], [0.52, 0.033], [0.56, 0.03], [0.6, 0.029]];
    const fa = surf(12, 10, (u, v, p) => { const s = lerp(0.6, 0.19, v); const al = u * TAU; let r = interpKeys(FK, s, 1); r *= 1 + 0.1 * Math.cos(2 * al) * smooth(0.3, 0.45, s); armPoint(s, al, r, 'R', p); }, { closeU: true });
    bd.add('skin', fa, { w: wArm, mirror: true, uvFn: (u, v) => [0.1 + u * 0.8, 0.012 + v * 0.06] });
  } else {
    bd.add('cloth', sleeveMesh(-0.07, 0.56, jacket ? 0.008 : 0.0), { reg: 'ARM', w: wArm, mirror: true, col: jacket ? jacket.col : V.sleeve });
  }

  // ---------- hands ----------
  {
    const glove = V.gloves != null;
    const parts = handMesh({ glove });
    const hf = handFrame('R');
    for (const P of parts) {
      xformM(P, hf);
      if (glove) bd.add('cloth', P, { reg: 'GLOVE', w: B.handR, mirror: true, col: V.gloves, rough: 0.8, uvFn: (u, v) => [u, v] });
      else bd.add('skin', P, { w: B.handR, mirror: true, uvFn: (u, v) => [0.05 + u * 0.9, 0.01 + v * 0.065] });
    }
    if (glove) { // knuckle guard
      const kn = roundedBox(0.012, 0.022, 0.07, 0.005, { cheap: true });
      bendY(kn, 0.06);
      xformM(kn, mat4(new V3(0.014, 0.092, 0.002)));
      xformM(kn, hf);
      bd.add('hard', kn, { w: B.handR, mirror: true, col: 0x202122, rough: 0.55, wear: 0.8 });
    }
  }

  // ---------- feet ----------
  {
    const bt = bootMeshes(V.boots);
    const sneaker = V.boots.type === 'sneaker';
    bd.add('cloth', bt.upper, { reg: 'BOOT', w: SIDES.R.foot, mirror: true, col: (p) => {
      const t = (ANK[2] + 0.078 - p.z) / 0.283; // heel->toe
      const toe = smooth(0.8, 0.86, t), heel = smooth(0.2, 0.14, t), low = smooth(0.05, 0.035, p.y);
      const k = Math.max(toe, heel, low) * (sneaker ? 0.6 : 0.35);
      const c = colLin(V.boots.col);
      const sh = sneaker ? colLin(V.boots.sole) : c.map((x) => x * 0.55);
      return [lerp(c[0], sh[0], k), lerp(c[1], sh[1], k), lerp(c[2], sh[2], k)];
    }, uvFn: (u, v) => [u * 0.5, v], rough: 0.85, wear: 0.9 });
    bd.add('cloth', bt.shaft, { reg: 'BOOT', w: wShaft, mirror: true, col: V.boots.col, uvFn: (u, v) => [0.5 + u * 0.5, v], rough: 0.85, wear: 0.9 });
    bd.add('hard', bt.sole, { w: SIDES.R.foot, mirror: true, col: sneaker ? V.boots.sole : C.rubber, rough: 0.92, wear: 0.4 });
  }

  // ---------- neck ----------
  const maskBal = V.mask && V.mask.type === 'balaclava';
  {
    const nk = surf(16, 6, (u, v, p) => { const al = u * TAU; const y = lerp(1.47, 1.665, v);
      const r = lerp(0.084, 0.064, smooth(0.0, 0.6, v)); p.set(Math.sin(al) * r * 1.03, y, lerp(0.02, 0.01, v) - Math.cos(al) * r * (Math.cos(al) > 0 ? 1.04 : 1.0)); }, { closeU: true });
    if (maskBal) bd.add('cloth', nk, { reg: 'KNIT', w: wNeck, col: V.mask.col });
    else bd.add('skin', nk, { w: wNeck, uvFn: (u, v) => [0.05 + u * 0.9, 0.012 + v * 0.06] });
  }

  // ---------- head ----------
  const beard = V.beard || 0;
  {
    const hdT = (V.head || {}).type;
    const covered = (th, ph) => {
      const ath = Math.abs(th);
      if (hdT === 'helmet') return ph > interpArr([0, 0.6, 1.0, 1.25, 1.95, 2.35, 2.7, Math.PI], [0.36, 0.33, 0.22, 0.16, 0.16, 0.0, -0.13, -0.15], ath) + 0.24;
      if (hdT === 'cap') return ph > interpArr([0, 0.8, 1.5, 2.4, Math.PI], [0.36, 0.32, 0.12, -0.05, -0.08], ath) + 0.12;
      if (hdT === 'beanie') return ph > interpArr([0, 0.8, 1.5, 2.4, Math.PI], [0.42, 0.38, 0.2, 0.0, -0.06], ath) + 0.12;
      headDir(th, ph, _t1); const r0 = headBase(_t1.x, _t1.y, _t1.z); const fx = _t1.x * r0, fy = _t1.y * r0;
      if (hdT === 'wrapfull') return !(_t1.z < -0.3 && Math.abs(fx) < 0.075 && fy > -0.028 && fy < 0.036) && ph > -0.95;
      if (hdT === 'turban') { const e = interpArr([0, 0.8, 1.3, 1.9, 2.5, Math.PI], [0.034, 0.028, 0.012, 0.006, -0.05, -0.06], ath); return fy > e + 0.02; }
      return false;
    };
    const H = headMesh({ beard: maskBal ? 0 : beard, covered });
    if (maskBal) {
      // eye window stays skin; rest = knit, inflated a bit. Window snapped to the head grid -> clean straight edges.
      const near = (arr, x) => { let bi = 0; for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - x) < Math.abs(arr[bi] - x)) bi = i; return bi; };
      const jLo = near(HEAD_PH, faceCoordsDir(0.03, -0.0115)[1]), jHi = near(HEAD_PH, faceCoordsDir(0.03, 0.0215)[1]);
      const thW = HEAD_TH[near(HEAD_TH, faceCoordsDir(0.057, 0.005)[0])];
      const phLo = HEAD_PH[jLo], phHi = HEAD_PH[jHi];
      const win = (x, y, z) => { const dx = x - HC.x, dy = y - HC.y, dz = z - HC.z; const l = Math.hypot(dx, dy, dz);
        const th = Math.atan2(dx, -dz), ph = Math.asin(dy / l); return Math.abs(th) < thW && ph > phLo && ph < phHi; };
      for (let k = 0; k < H.p.length; k += 3) {
        const fx = H.p[k] - HC.x, fy = H.p[k + 1] - HC.y, fz = H.p[k + 2] - HC.z; const l = Math.hypot(fx, fy, fz);
        const th = Math.atan2(fx, -fz), ph = Math.asin(fy / l);
        const inside = Math.abs(th) < thW + 1e-4 && ph > phLo - 1e-4 && ph < phHi + 1e-4;
        if (!inside) { const add = 0.0028; H.p[k] += fx / l * add; H.p[k + 1] += fy / l * add; H.p[k + 2] += fz / l * add; }
      }
      computeNormals(H);
      const [skinPart, clothPart] = splitM(H, win);
      bd.add('skin', skinPart, { w: wHead });
      bd.add('cloth', clothPart, { reg: 'KNIT', w: wHead, col: V.mask.col });
    } else {
      bd.add('skin', H, { w: wHead });
    }
    // eyes
    for (const s of [1, -1]) {
      const [th, ph] = faceCoordsDir(s * EYE_X, EYE_Y);
      headDir(th, ph, _t1); const r0 = headBase(_t1.x, _t1.y, _t1.z);
      const ctr = HC.clone().addScaledVector(_t1, r0 - 0.0119);
      const ER = 0.0125; const angs = [0, 0.12, 0.2, 0.3, 0.42, 0.5, 0.75, 1.1, 1.6, 2.3, Math.PI];
      const eye = lathe(angs.map((a) => [Math.sin(a) * ER, Math.cos(a) * ER + (a < 0.45 ? 0.0008 * Math.cos(a / 0.45 * Math.PI / 2) : 0)]).reverse(), 8);
      const fwd = new V3(s * 0.04, -0.03, -1).normalize();
      const irisC = VARIANTS[team][vi].iris || (isT ? [0.07, 0.04, 0.02] : [0.1, 0.075, 0.05]);
      const scl = [0.33, 0.29, 0.26];
      bd.add('gloss', xformM(eye, mat4(ctr, new Q4().setFromUnitVectors(new V3(0, 1, 0), fwd))), { w: B.head, rough: 0.1, col: (p) => {
        const a = Math.acos(clamp(_t2.copy(p).sub(ctr).normalize().dot(fwd), -1, 1));
        if (a < 0.16) return [0.005, 0.004, 0.003];
        if (a < 0.46) { const k = smooth(0.16, 0.44, a); return [irisC[0] * (0.7 + 0.5 * k), irisC[1] * (0.7 + 0.5 * k), irisC[2] * (0.8 + 0.3 * k)]; }
        return a < 0.6 ? [scl[0] * 0.8, scl[1] * 0.78, scl[2] * 0.76] : scl;
      } });
    }
    // ears (if visible)
    const hidden = maskBal || (V.head && V.head.type === 'wrapfull');
    if (!hidden) {
      for (const s of [1, -1]) {
        const e = earMesh();
        const m = mat4(new V3(HC.x + s * 0.0725, HC.y - 0.008, HC.z + 0.014), qe(0, s * -0.16, s * 0.08, 'YXZ'));
        if (s < 0) m.multiply(new M4().makeScale(-1, 1, 1));
        bd.add('skin', xformM(e, m), { w: B.head, uvFn: (u, v) => [0.1 + u * 0.8, 0.015 + v * 0.05] });
      }
    }
  }

  // ---------- headgear ----------
  const hd = V.head || {};
  if (hd.type === 'helmet') addHelmet(bd, hd, V);
  if (hd.type === 'cap') addCap(bd, hd, V);
  if (hd.type === 'beanie') addBeanie(bd, hd);
  if (hd.type === 'wrapfull') addWrap(bd, hd, true);
  if (hd.type === 'turban') addWrap(bd, hd, false);
  if (V.headset && hd.type !== 'helmet') addHeadset(bd, V.headset, hd.type === 'cap');
  if (V.eyes === 'sun' || V.eyes === 'clear') addGlasses(bd, V);
  if (V.goggles === true) addGoggles(bd, 0x1d1e1f, false);
  if (V.goggles === 'forehead') addGoggles(bd, 0x6a5a40, true);
  if (V.neckwrap) addNeckWrap(bd, V.neckwrap);
  if (V.scarf) addScarf(bd, V.scarf);

  // ---------- gear ----------
  if (V.belt != null) addBelt(bd, V.belt, isT);
  if (!isT) addCTExtras(bd, V);
  if (V.carrier) addCarrier(bd, V.carrier);
  if (V.rig) addRig(bd, V.rig, torsoInfl + (V.tunic ? 0.012 : 0));
  if (V.vest) addVest(bd, V.vest);
  if (V.bandolier) addBandolier(bd, V.bandolier, torsoInfl);
  if (V.kneepads != null) addKneepads(bd, V.kneepads);
  if (V.holster) addHolster(bd);
  if (V.dump) addDump(bd, V.carrier ? V.carrier.col : C.rangerD);
  if (V.pack) addPack(bd, V.pack, !!V.carrier);
  return bd.build();
}

// ---------------- headgear ----------------
function helmetPoint(th, t, offset, out) {
  // high-cut shell; t 0 = rim, 1 = crown
  const ath = Math.abs(th);
  const rim = interpArr([0, 0.6, 1.0, 1.25, 1.95, 2.35, 2.7, Math.PI], [0.36, 0.33, 0.22, 0.16, 0.16, 0.0, -0.13, -0.15], ath);
  const ph = lerp(rim, Math.PI / 2, Math.pow(t, 0.95));
  headDir(th, ph, _t0);
  const a = 0.1065, b = 0.124, c = _t0.z < 0 ? 0.124 : 0.128;
  const n = 2.2; const d = _t0;
  const S = Math.pow(Math.pow(Math.abs(d.x / a), n) + Math.pow(Math.abs(d.z / c), n), 2 / n) + (d.y / b) ** 2;
  const r = 1 / Math.sqrt(S) + offset;
  return out.set(d.x * r, 1.73 + d.y * r, 0.004 + d.z * r);
}
function addHelmet(bd, hd, V) {
  const shell = surf(26, 8, (u, v, p) => helmetPoint((u * 2 - 1) * Math.PI, v, 0, p), { closeU: true });
  for (let k = 0; k < shell.wear.length; k++) shell.wear[k] = shell.uv[k * 2 + 1] < 0.12 ? 1 : 0.15;
  if (hd.cover) bd.add('cloth', shell, { reg: 'SOFT', w: B.head, col: hd.col });
  else bd.add('hard', shell, { w: B.head, col: hd.col, rough: 0.62, wear: 0.9 });
  // inner liner band (blocks sight-lines into the shell from below)
  { const ln = orientOut(surf(24, 2, (u, v, p) => helmetPoint((u * 2 - 1) * Math.PI, v * 0.5, -0.011, p), { closeU: true, auto: false }), new V3(0, 1.73, 0.004));
    flipM(ln); computeNormals(ln);
    bd.add('hard', ln, { w: B.head, col: 0x121212, rough: 0.9 }); }
  // rim trim (rubber edge)
  const rimPts = []; for (let k = 0; k <= 24; k++) rimPts.push(helmetPoint((k / 24 * 2 - 1) * Math.PI, 0.0, 0.0, new V3()));
  bd.add('hard', tubePath(rimPts, Array(25).fill([0.0055, 0.004]), 4, { ref: new V3(0, 1, 0), transport: true }), { w: B.head, col: 0x161616, rough: 0.8 });
  // side rails
  for (const s of [1, -1]) {
    const pts = []; for (let k = 0; k <= 6; k++) pts.push(helmetPoint(s * lerp(1.0, 2.1, k / 6), 0.18, 0.005, new V3()));
    bd.add('hard', tubePath(pts, Array(7).fill([0.006, 0.011]), 4, { ref: new V3(0, 1, 0), square: 0.75 }), { w: B.head, col: 0x1e1f20, rough: 0.5, metal: 0.3, wear: 1 });
  }
  // velcro patches
  const vel = orientOut(surf(6, 4, (u, v, p) => helmetPoint(lerp(-0.45, 0.45, u), lerp(0.62, 0.9, v), 0.003, p), { auto: false }), HC);
  bd.add('cloth', vel, { reg: 'SOFT', w: B.head, col: hd.cover ? 0x2b2f26 : 0x2e2f31 });
  const vel2 = orientOut(surf(6, 3, (u, v, p) => helmetPoint(Math.PI + lerp(-0.4, 0.4, u), lerp(0.22, 0.45, v), 0.003, p), { auto: false }), HC);
  bd.add('cloth', vel2, { reg: 'SOFT', w: B.head, col: 0x2e2f31 });
  // NVG shroud
  const fr = helmetPoint(0, 0.12, 0, new V3());
  const shroud = roundedBox(0.048, 0.034, 0.014, 0.004, {});
  bd.add('hard', xformM(shroud, mat4(fr.clone().add(new V3(0, 0.004, -0.004)), qe(-0.55, 0, 0))), { w: B.head, col: 0x1b1b1c, rough: 0.45, metal: 0.4, wear: 1 });
  if (hd.nvg) {
    // flipped-up mount + binocular NVG
    const arm = roundedBox(0.03, 0.05, 0.03, 0.006, { cheap: true });
    bd.add('hard', xformM(arm, mat4(fr.clone().add(new V3(0, 0.024, -0.01)), qe(-0.2, 0, 0))), { w: B.head, col: 0x1a1a1a, rough: 0.5, metal: 0.3, wear: 1 });
    for (const s of [1, -1]) {
      const tube = lathe([[0.0, 0], [0.016, 0.0], [0.017, 0.004], [0.017, 0.055], [0.019, 0.058], [0.019, 0.07], [0.012, 0.073], [0.0, 0.073]], 10);
      bd.add('hard', xformM(tube, mat4(fr.clone().add(new V3(s * 0.025, 0.04, -0.012)), qe(1.05, 0, 0))), { w: B.head, col: 0x202122, rough: 0.5, metal: 0.2, wear: 1 });
      const lens = lathe([[0, 0.0], [0.0125, 0.0], [0.0125, 0.002], [0, 0.003]], 10);
      bd.add('gloss', xformM(lens, mat4(fr.clone().add(new V3(s * 0.025, 0.04, -0.012)).add(new V3(0, 0.0727 * Math.cos(1.05), 0.0727 * Math.sin(1.05))), qe(1.05, 0, 0))), { w: B.head, col: 0x0a1810 });
    }
    // counterweight pouch at the back
    const cw = roundedBox(0.09, 0.05, 0.03, 0.01, { reg: () => 'POUCH' });
    bendY(cw, 0.12);
    const bp = helmetPoint(Math.PI, 0.22, 0.012, new V3());
    bd.add('cloth', xformM(cw, mat4(bp, qe(0.25, Math.PI, 0))), { w: B.head, col: 0x2a2b2c });
  }
  if (hd.light) {
    for (const s of [1]) {
      const lp = helmetPoint(s * 1.5, 0.22, 0.016, new V3());
      const body = lathe([[0, 0], [0.012, 0], [0.012, 0.07], [0.015, 0.075], [0.015, 0.09], [0, 0.09]], 10);
      bd.add('hard', xformM(body, mat4(lp.clone().add(new V3(0, 0, 0.03)), qe(-Math.PI / 2, 0, 0))), { w: B.head, col: 0x1a1a1a, rough: 0.4, metal: 0.5, wear: 1 });
    }
  }
  // ear cups (headset under the helmet)
  addHeadset(bd, V.headset, false, true);
  // chin strap
  for (const s of [1, -1]) {
    const a = helmetPoint(s * 1.25, 0.0, -0.004, new V3());
    const pts = catmull([a, new V3(s * 0.07, 1.665, -0.055), new V3(s * 0.045, 1.615, -0.075), new V3(0, 1.603, -0.082)], 8);
    bd.add('cloth', tubePath(pts, Array(9).fill([0.0025, 0.009]), 4, { ref: new V3(s, 0, 0), square: 0.7 }), { reg: 'STRAP', w: B.head, col: 0x1c1c1c });
  }
}
function addHeadset(bd, col, band, underHelmet) {
  for (const s of [1, -1]) {
    const cup = lathe([[0, 0], [0.036, 0], [0.042, 0.006], [0.043, 0.02], [0.038, 0.032], [0.02, 0.036], [0, 0.036]], 10);
    const q = qe(0, 0, -s * Math.PI / 2);
    const pos = new V3(s * (0.072), HC.y - 0.004, HC.z + 0.012);
    bd.add('hard', xformM(cup, mat4(pos, q)), { w: B.head, col, rough: 0.55, wear: 0.8 });
    // cushion
    const cush = lathe([[0.0, 0], [0.034, 0.0], [0.04, 0.005], [0.036, 0.011], [0.0, 0.011]], 10);
    bd.add('hard', xformM(cush, mat4(pos.clone().add(new V3(-s * 0.006, 0, 0)), q)), { w: B.head, col: 0x151515, rough: 0.7 });
  }
  if (band) {
    const pts = []; for (let k = 0; k <= 12; k++) { const a = lerp(-1.25, 1.25, k / 12); pts.push(new V3(Math.sin(a) * 0.108, HC.y + 0.0 + Math.cos(a) * 0.128, HC.z + 0.012)); }
    bd.add('hard', tubePath(pts, Array(13).fill([0.004, 0.014]), 4, { ref: new V3(0, 0, 1), square: 0.7 }), { w: B.head, col, rough: 0.5 });
  }
  // boom mic (right side)
  const bm = catmull([new V3(0.098, HC.y - 0.02, HC.z - 0.005), new V3(0.09, HC.y - 0.05, HC.z - 0.06), new V3(0.04, HC.y - 0.06, HC.z - 0.115), new V3(0.018, HC.y - 0.055, HC.z - 0.122)], 10);
  bd.add('hard', tubePath(bm, Array(11).fill(0.0028), 4), { w: B.head, col: 0x161616, rough: 0.5 });
  const mic = sphereM(0.008, 8, 6); deformM(mic, (p) => { p.x *= 1.6; });
  bd.add('cloth', xformM(mic, mat4(bm[bm.length - 1])), { reg: 'SOFT', w: B.head, col: 0x161616 });
}
function addCap(bd, hd, V) {
  const crown = surf(30, 8, (u, v, p) => {
    const th = (u * 2 - 1) * Math.PI; const ath = Math.abs(th);
    const rim = interpArr([0, 0.8, 1.5, 2.4, Math.PI], [0.36, 0.32, 0.12, -0.05, -0.08], ath);
    const ph = lerp(rim, Math.PI / 2, v);
    headPoint(th, ph, { noFeatures: true }, p, 0.008 + 0.006 * v);
  }, { closeU: true });
  bd.add('cloth', crown, { reg: 'PLAIN', w: B.head, col: hd.col });
  // brim
  const fp = headPoint(0, 0.36, { noFeatures: true }, new V3(), 0.008);
  const brimTop = surf(12, 4, (u, v, p) => {
    const a = (u * 2 - 1) * 1.15; const rr = lerp(0.0, 0.075, v);
    const x = Math.sin(a) * (0.085 + rr * 0.15); const z = -Math.cos(a) * 0.075 - rr * Math.cos(a) * 0.9 * (1 + 0.1 * Math.cos(a));
    p.set(x, fp.y - 0.004 - 0.012 * rr / 0.075 - 0.02 * (Math.sin(a) ** 2) * v, z + HC.z + 0.0);
  }, { auto: false });
  const bot = { ...brimTop, p: brimTop.p.slice(), idx: brimTop.idx.slice(), n: brimTop.n.slice() };
  for (let k = 1; k < bot.p.length; k += 3) bot.p[k] -= 0.004;
  // orient: top facing up
  computeNormals(brimTop); if (brimTop.n[1 + 3 * 30] < 0) flipM(brimTop), computeNormals(brimTop);
  flipM(bot); computeNormals(bot);
  bd.add('cloth', brimTop, { reg: 'PLAIN', w: B.head, col: hd.col });
  bd.add('cloth', bot, { reg: 'PLAIN', w: B.head, col: hd.col });
  // button
  bd.add('cloth', xformM(sphereM(0.007, 6, 4), mat4(new V3(0, HC.y + 0.125, HC.z), null, new V3(1, 0.5, 1))), { reg: 'PLAIN', w: B.head, col: hd.col });
}
function addBeanie(bd, hd) {
  const b = surf(30, 9, (u, v, p) => {
    const th = (u * 2 - 1) * Math.PI; const ath = Math.abs(th);
    const rim = interpArr([0, 0.8, 1.5, 2.4, Math.PI], [0.42, 0.38, 0.2, 0.0, -0.06], ath);
    const ph = lerp(rim, Math.PI / 2, v);
    const cuff = v < 0.22 ? 0.007 : 0;
    headPoint(th, ph, { noFeatures: true }, p, 0.006 + cuff + 0.016 * v * v + 0.0015 * vnoise3(th * 3, ph * 8, 2));
  }, { closeU: true });
  bd.add('cloth', b, { reg: 'KNIT', w: B.head, col: hd.col });
}
function addWrap(bd, hd, full) {
  // shemagh wrapped around the head; full: face covered except an eye slit
  const nu = 44, nv = 24;
  const W = surf(nu, nv, (u, v, p) => {
    const th = (u * 2 - 1) * Math.PI; const ph = lerp(-1.1, Math.PI / 2, v);
    headDir(th, ph, _t1);
    const r0 = headBase(_t1.x, _t1.y, _t1.z);
    const fx = _t1.x * r0, fy = _t1.y * r0;
    const ridge = (x) => Math.pow(Math.abs(Math.sin(x)), 0.55);
    let off = 0.013 + 0.004 * vnoise3(th * 2.2, ph * 3, 1.1);
    if (full) {
      off += 0.01 * smooth(-0.2, 0.9, _t1.y);                                         // bulk on top
      off += 0.011 * ridge(th * 1.6 + ph * 5.2 + 0.8 * vnoise3(th, ph * 2, 5)) * smooth(-0.9, -0.3, ph); // wrap bands
      off += 0.016 * Math.exp(-(((th + 1.9) / 0.35) ** 2 + ((ph - 0.25) / 0.3) ** 2));  // tuck/knot at the left back
      if (_t1.z < 0) off += 0.006 * smooth(-0.02, -0.06, fy) * Math.exp(-((fx / 0.05) ** 2)); // over nose/mouth
      off += 0.005 * smooth(-0.03, -0.08, fy) * (_t1.z < 0 ? 1 : 0);                  // loose lower face layer
    } else {
      const band = smooth(0.0, 0.35, ph);
      off += 0.022 * band + 0.01 * smooth(0.5, 1.2, ph);                               // turban bulk
      off += 0.009 * ridge(th * 1.25 - ph * 6.5 + 0.6 * vnoise3(th * 1.5, ph * 2, 9)) * band; // wrapped layers
      off += 0.008 * smooth(0.0, -0.7, ph) * smooth(-0.6, 0.0, _t1.z);                   // back drape
      off += 0.012 * Math.exp(-(((th - 0.35) / 0.3) ** 2 + ((ph - 0.55) / 0.25) ** 2));   // front fold
    }
    p.set(HC.x + _t1.x * (r0 + off), HC.y + _t1.y * (r0 + off), HC.z + _t1.z * (r0 + off));
    if (full && _t1.z < 0) { // pull below the jaw tighter -> flows into neck drape
      const k = smooth(-0.5, -1.0, _t1.y); p.z += 0.01 * k; }
  }, { closeU: true, skip: (i, j, u, v) => {
    const th = (u * 2 - 1) * Math.PI; const ph = lerp(-1.1, Math.PI / 2, v);
    headDir(th, ph, _t1); const r0 = headBase(_t1.x, _t1.y, _t1.z); const fx = _t1.x * r0, fy = _t1.y * r0;
    if (full && _t1.z > -0.3) return false;
    if (full) return Math.abs(fx) < 0.058 && fy > -0.013 && fy < 0.02;
    const ath = Math.abs(th);
    const edge = interpArr([0, 0.8, 1.3, 1.9, 2.5, Math.PI], [0.034, 0.028, 0.012, 0.006, -0.05, -0.06], ath);
    return fy < edge;   // turban: only above the brow / ear line
  } });
  bd.add('pattern', W, { reg: 'WRAP', w: wHead, col: hd.col, duvScale: 1 });
  // neck drape / tail
  if (full) {
    const D = surf(30, 7, (u, v, p) => {
      const al = u * TAU; const y = lerp(1.625, 1.42, v);
      const front = Math.max(0, -Math.cos(al));
      const r = lerp(0.082, 0.165, v * v) + 0.013 * Math.pow(Math.abs(Math.sin(al * 5 + v * 2.5)), 0.6) * v + 0.006 * vnoise3(al * 2, v * 3, 7);
      p.set(Math.sin(al) * r * (1 + 0.22 * v), y - front * v * 0.09, 0.02 - Math.cos(al) * r * (1.0 + 0.12 * v));
    }, { closeU: true });
    bd.add('pattern', D, { reg: 'WRAP', w: (p) => { const k = smooth(1.58, 1.47, p.y); return [[B.head, (1 - k) * 0.6], [B.neck, (1 - k) * 0.4], [B.chest, k]]; }, col: hd.col });
  } else {
    // tail hanging at back left
    const pts = catmull([new V3(-0.06, 1.74, 0.08), new V3(-0.075, 1.66, 0.105), new V3(-0.085, 1.56, 0.11), new V3(-0.1, 1.46, 0.12)], 8);
    bd.add('pattern', tubePath(pts, pts.map((_, i) => [0.006, 0.035 + i * 0.002]), 6, { ref: new V3(0, 0, 1) }), { reg: 'WRAP', w: (p) => { const k = smooth(1.62, 1.5, p.y); return [[B.head, 1 - k], [B.chest, k]]; }, col: hd.col });
  }
}
function addNeckWrap(bd, nw) {
  const D = surf(26, 5, (u, v, p) => {
    const al = u * TAU; const y = lerp(1.6, 1.47, v);
    const r = lerp(0.072, 0.12, v * v) + 0.008 * Math.sin(al * 6 + v * 4) + 0.006 * vnoise3(al * 2, v * 4, 3);
    const front = Math.max(0, -Math.cos(al));
    p.set(Math.sin(al) * r * (1 + 0.2 * v), y - front * v * 0.05, 0.022 - Math.cos(al) * r * 1.05);
  }, { closeU: true });
  bd.add('pattern', D, { reg: 'WRAP', w: (p) => { const k = smooth(1.58, 1.48, p.y); return [[B.neck, 1 - k], [B.chest, k]]; }, col: nw.col });
}
function addScarf(bd, sc) {
  const ring = catmull([0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => { const a = k / 8 * TAU; return new V3(Math.sin(a) * 0.09, 1.525 - 0.02 * Math.cos(a), 0.022 - Math.cos(a) * 0.095); }), 24);
  bd.add('cloth', tubePath(ring, ring.map((_, i) => 0.026 + 0.005 * Math.sin(i * 1.7)), 8, { ref: new V3(0, 1, 0), transport: true }), { reg: 'WRAP', w: wNeck, col: sc.col });
  for (const s of [1, -1]) {
    const pts = catmull([new V3(s * 0.03, 1.5, -0.1), new V3(s * 0.045, 1.42, -0.135), new V3(s * 0.05, 1.33, -0.14)], 6);
    bd.add('cloth', tubePath(pts, pts.map(() => [0.008, 0.04]), 6, { ref: new V3(0, 0, -1) }), { reg: 'WRAP', w: wTorso, col: sc.col });
  }
}
function addGlasses(bd, V) {
  const lens = surf(16, 3, (u, v, p) => {
    const fx = lerp(-0.068, 0.068, u);
    const bot = -0.013 + 0.011 * Math.exp(-((fx / 0.011) ** 2)) - 0.003 * (Math.abs(fx) / 0.068) ** 2;
    const top = 0.0165 - 0.003 * (Math.abs(fx) / 0.068) ** 2;
    const fy = lerp(bot, top, v);
    const [th, ph] = faceCoordsDir(fx * 0.92, fy + EYE_Y);
    headPoint(th, ph, { noFeatures: true }, p, 0.02 - 0.008 * (Math.abs(fx) / 0.068) ** 2 + 0.006 * Math.exp(-((fx / 0.02) ** 2)));
  }, { auto: false });
  orientOut(lens, HC);
  bd.add('gloss', lens, { w: B.head, col: V.lens || 0x101010, rough: 0.05 });
  // frame top bar
  const bar = []; for (let k = 0; k <= 10; k++) { const fx = lerp(-0.07, 0.07, k / 10); const [th, ph] = faceCoordsDir(fx * 0.92, 0.0172 + EYE_Y - 0.003 * (Math.abs(fx) / 0.068) ** 2); bar.push(headPoint(th, ph, { noFeatures: true }, new V3(), 0.021 - 0.008 * (Math.abs(fx) / 0.068) ** 2 + 0.006 * Math.exp(-((fx / 0.02) ** 2)))); }
  bd.add('hard', tubePath(bar, Array(11).fill([0.0025, 0.004]), 4), { w: B.head, col: 0x151515, rough: 0.4 });
  for (const s of [1, -1]) {
    const a = bar[s > 0 ? 10 : 0];
    const pts = [a, new V3(s * 0.08, HC.y + 0.012, HC.z - 0.04), new V3(s * 0.081, HC.y + 0.008, HC.z + 0.01)];
    bd.add('hard', tubePath(pts, Array(3).fill(0.0022), 4), { w: B.head, col: 0x151515, rough: 0.4 });
  }
}
function addGoggles(bd, col, forehead) {
  const yOff = forehead ? 0.06 : EYE_Y;
  const frame = surf(16, 3, (u, v, p) => {
    const fx = lerp(-0.075, 0.075, u); const fy = lerp(-0.02, 0.02, v);
    const [th, ph] = faceCoordsDir(fx * 0.9, clamp(fy + yOff, -0.1, 0.09));
    headPoint(th, ph, { noFeatures: true }, p, (forehead ? 0.016 : 0.022) + 0.006 * (1 - Math.abs(v - 0.5) * 2) - 0.008 * (Math.abs(fx) / 0.075) ** 2);
  }, { auto: false });
  orientOut(frame, HC);
  bd.add('hard', frame, { w: B.head, col, rough: 0.6, wear: 0.6 });
  const lens = surf(12, 2, (u, v, p) => {
    const fx = lerp(-0.06, 0.06, u); const fy = lerp(-0.014, 0.014, v);
    const [th, ph] = faceCoordsDir(fx * 0.9, clamp(fy + yOff, -0.1, 0.09));
    headPoint(th, ph, { noFeatures: true }, p, (forehead ? 0.024 : 0.03) - 0.008 * (Math.abs(fx) / 0.075) ** 2);
  }, { auto: false });
  orientOut(lens, HC);
  bd.add('gloss', lens, { w: B.head, col: forehead ? 0x3a2a12 : 0x111518, rough: 0.05 });
  // strap around head
  const pts = []; for (let k = 0; k <= 16; k++) { const th = lerp(0.95, TAU - 0.95, k / 16); const [, ph] = faceCoordsDir(0, yOff); pts.push(headPoint(th, forehead ? ph + 0.05 : ph + 0.03, { noFeatures: true }, new V3(), forehead ? 0.014 : 0.026)); }
  bd.add('cloth', tubePath(pts, Array(17).fill([0.0025, 0.012]), 4, { ref: new V3(1, 0, 0), square: 0.7 }), { reg: 'STRAP', w: B.head, col: 0x1b1b1b });
}

// ---------------- torso gear ----------------
function addBelt(bd, col, rigger) {
  const belt = surf(26, 3, (u, v, p) => { const y = lerp(1.035, 1.085, v); torsoPoint(u * TAU, y, 0.011 + (v > 0.2 && v < 0.8 ? 0.003 : 0), p); }, { closeU: true });
  bd.add('cloth', belt, { reg: 'STRAP', w: wTorso, col, uvFn: (u, v) => [v, u] });
  const buckle = roundedBox(0.055, 0.04, 0.012, 0.003, { cheap: true });
  const fp = torsoPoint(0, 1.06, 0.018, new V3());
  bd.add('hard', xformM(buckle, mat4(fp)), { w: B.hips, col: rigger ? 0x6a6150 : 0x1c1c1c, rough: 0.35, metal: rigger ? 0.8 : 0.2, wear: 1 });
}
function addCTExtras(bd, V) {
  // shoulder velcro patches (blank, flag-less)
  const arm = (s, al, r) => armPoint(s, al, r, 'R', new V3());
  for (const sd of [1]) {
    const c = arm(0.13, Math.PI / 2, 0.06);
    const pt = roundedBox(0.006, 0.07, 0.055, 0.002, { cheap: true });
    const d = armDir(1), lat = armLat(1); const m = new M4().makeBasis(lat, d.clone().negate(), new V3().crossVectors(lat, d.clone().negate()));
    m.setPosition(c);
    bd.add('cloth', xformM(pt, m), { reg: 'SOFT', w: wArm, mirror: true, col: V.carrier ? V.carrier.col : C.charcoal });
  }
  // belt pouches
  if (V.belt != null) {
    const p1 = roundedBox(0.075, 0.09, 0.035, 0.008, { reg: () => 'POUCH' });
    bd.add('cloth', xformM(p1, mat4(torsoPoint(-1.15, 1.02, 0.03, new V3()), qe(0, 1.15, 0))), { w: (p) => [[B.hips, 1]], col: V.carrier ? V.carrier.col : V.belt });
    const p2 = roundedBox(0.11, 0.08, 0.04, 0.012, { reg: () => 'POUCH' });
    bd.add('cloth', xformM(p2, mat4(torsoPoint(Math.PI + 0.35, 1.03, 0.03, new V3()), qe(0, Math.PI + 0.35, 0))), { w: (p) => [[B.hips, 1]], col: V.carrier ? V.carrier.col : V.belt });
  }
  // elbow pads for the heavy kit
  if (V.carrier && V.carrier.heavy) {
    const pad = roundedBox(0.075, 0.085, 0.02, 0.01, {});
    bendY(pad, 0.05);
    const c = arm(0.3, Math.PI, 0.055);
    const d = armDir(1); const m = new M4().makeBasis(armLat(1).negate(), d.clone().negate(), new V3(0, 0, -1));
    m.setPosition(c.add(new V3(0, 0, 0.008)));
    bd.add('hard', xformM(pad, m), { w: wArm, mirror: true, col: C.black, rough: 0.6, wear: 1 });
  }
}
function plateBag(w, h, d, R, frontReg) {
  const M = roundedBox(w, h, d, 0.012, { reg: (f) => (f === frontReg ? 'MOLLE' : 'NYLON') });
  bendY(M, R);
  return M;
}
function magPouch(bd, pos, rotY, col, magCol, o = {}) {
  const w = o.w || 0.072, h = o.h || 0.115, d = o.d || 0.04;
  const p = roundedBox(w, h, d, 0.008, { reg: () => 'POUCH' });
  deformM(p, (q) => { q.z -= 0.004 * (1 - (q.x / (w / 2)) ** 2) * (q.z < 0 ? 1 : 0); });
  const m = mat4(pos, qe(o.tilt || 0, rotY, 0));
  bd.add('cloth', xformM(p, m.clone()), { w: o.wfn || wTorso, col });
  // magazine top + bungee pull tab
  const mag = roundedBox(w * 0.72, 0.045, d * 0.62, 0.004, { cheap: !o.curved });
  if (o.curved) bendX(mag, 0.25);
  bd.add('hard', xformM(mag, m.clone().multiply(mat4(new V3(0, h / 2 + 0.01, 0.002)))), { w: o.wfn || wTorso, col: magCol, rough: 0.55, metal: o.metalMag ? 0.6 : 0.05, wear: 1 });
  if (!o.open) {
    const tab = tubePath(catmull([new V3(-w * 0.2, h / 2 - 0.005, -d / 2 - 0.002), new V3(0, h / 2 + 0.035, -d * 0.1), new V3(w * 0.2, h / 2 - 0.005, -d / 2 - 0.002)], 6), Array(7).fill(0.003), 4);
    bd.add('hard', xformM(tab, m.clone()), { w: o.wfn || wTorso, col: 0x151515, rough: 0.8 });
  }
}
function addCarrier(bd, cr) {
  const col = cr.col;
  const infl = 0.012;
  const zf = -(interpKeys(TORSO_KEYS, 1.27, 2) + infl + 0.024);
  const zb = interpKeys(TORSO_KEYS, 1.28, 3) + infl + 0.024;
  bd.add('cloth', xformM(plateBag(0.285, 0.33, 0.046, 0.42, 'nz'), mat4(new V3(0, 1.268, zf + 0.004), qe(0.06, 0, 0))), { w: wTorso, col });
  bd.add('cloth', xformM(plateBag(0.29, 0.35, 0.046, 0.42, 'pz'), mat4(new V3(0, 1.285, zb - 0.002), qe(-0.03, Math.PI, 0))), { w: wTorso, col });
  // cummerbund
  const cb = surf(28, 3, (u, v, p) => { const y = lerp(1.12, 1.27, v); torsoPoint(u * TAU, y, 0.013 + (v > 0.15 && v < 0.85 ? 0.01 : 0.004), p); }, { closeU: true });
  bd.add('cloth', cb, { reg: 'MOLLE', w: wTorso, col, uvFn: (u, v) => [u, v * 0.6 + 0.02] });
  // shoulder straps
  for (const s of [1, -1]) {
    const pts = catmull([new V3(s * 0.085, 1.42, zf + 0.01), new V3(s * 0.094, 1.49, -0.085), new V3(s * 0.105, 1.535, 0.0), new V3(s * 0.096, 1.5, 0.08), new V3(s * 0.09, 1.44, zb - 0.01)], 12);
    bd.add('cloth', tubePath(catmull(pts, 9), Array(10).fill([0.009, 0.03]), 4, { ref: new V3(0, 1, 0), square: 0.75 }), { reg: 'STRAP', w: wTorso, col });
    // shoulder pad
    if (cr.heavy) {
      const pad = roundedBox(0.11, 0.022, 0.13, 0.01, { reg: () => 'NYLON' });
      bd.add('cloth', xformM(pad, mat4(new V3(s * 0.14, 1.52, 0.0), qe(0, 0, -s * 0.32))), { w: (p, sd) => [[B.chest, 0.5], [p.x > 0 ? B.clavR : B.clavL, 0.5]], col });
    }
  }
  // magazine pouches
  const n = cr.mags;
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 0.078;
    magPouch(bd, new V3(x, 1.185, zf - 0.045 + Math.abs(x) * 0.12), x * 1.4, col, C.polymer);
  }
  if (cr.admin) {
    const ad = roundedBox(0.17, 0.085, 0.022, 0.008, { reg: () => 'POUCH' });
    bendY(ad, 0.3);
    bd.add('cloth', xformM(ad, mat4(new V3(0, 1.335, zf - 0.033), qe(0.07, 0, 0))), { w: wTorso, col });
  }
  if (cr.radio) {
    const rp = new V3(-0.115, 1.33, zf - 0.03);
    const pouch = roundedBox(0.062, 0.12, 0.04, 0.008, { reg: () => 'POUCH' });
    bd.add('cloth', xformM(pouch, mat4(rp, qe(0.05, -0.3, 0))), { w: wTorso, col });
    const radio = roundedBox(0.05, 0.05, 0.03, 0.005, { cheap: true });
    bd.add('hard', xformM(radio, mat4(rp.clone().add(new V3(0, 0.075, 0.0)), qe(0.05, -0.3, 0))), { w: wTorso, col: 0x1d1e1f, rough: 0.5, wear: 1 });
    const ant = catmull([rp.clone().add(new V3(0.01, 0.1, 0)), rp.clone().add(new V3(-0.01, 0.17, 0.04)), rp.clone().add(new V3(-0.03, 0.22, 0.1))], 6);
    bd.add('hard', tubePath(ant, ant.map((_, i) => 0.005 - i * 0.0005), 5), { w: (p) => [[B.chest, 1]], col: 0x121212, rough: 0.6 });
    // PTT cable to the head
    const cab = catmull([rp.clone().add(new V3(0.02, 0.09, 0.0)), new V3(-0.06, 1.47, -0.1), new V3(-0.075, 1.56, -0.04), new V3(-0.075, 1.66, 0.0)], 10);
    bd.add('hard', tubePath(cab, Array(11).fill(0.003), 4), { w: (p) => { const k = smooth(1.5, 1.62, p.y); return [[B.chest, 1 - k], [B.head, k]]; }, col: 0x121212, rough: 0.6 });
  }
  // back pouch (hydration/utility)
  const bp = roundedBox(0.2, 0.25, 0.05, 0.015, { reg: (f) => (f === 'pz' ? 'MOLLE' : 'NYLON') });
  bendY(bp, 0.35);
  bd.add('cloth', xformM(bp, mat4(new V3(0, 1.25, zb + 0.045), qe(-0.03, Math.PI, 0))), { w: wTorso, col });
}
function addRig(bd, rg, infl) {
  const col = rg.col;
  const y0 = 1.17;
  const zf = -(interpKeys(TORSO_KEYS, y0, 2) + infl + 0.016);
  const panel = roundedBox(0.3, 0.16, 0.022, 0.01, { reg: (f) => (f === 'nz' ? 'NYLON' : 'NYLON') });
  bendY(panel, 0.2);
  bd.add('cloth', xformM(panel, mat4(new V3(0, y0, zf))), { w: wTorso, col });
  const n = rg.mags;
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 0.074;
    magPouch(bd, new V3(x, y0 + 0.02, zf - 0.033 + Math.abs(x) * 0.18), x * 2.3, col, i % 2 ? 0x3a2a1c : 0x5e3a20,
      { w: 0.07, h: 0.15, d: 0.046, curved: true, open: true, metalMag: false });
  }
  // harness straps (H)
  for (const s of [1, -1]) {
    const pts = catmull([new V3(s * 0.11, y0 + 0.07, zf + 0.008), new V3(s * 0.1, 1.38, -0.125 - infl), new V3(s * 0.098, 1.5, -0.075), new V3(s * 0.1, 1.535, 0.0), new V3(s * 0.09, 1.48, 0.085 + infl), new V3(s * 0.05, 1.3, 0.1 + infl), new V3(-s * 0.06, 1.14, 0.095 + infl)], 16);
    bd.add('cloth', tubePath(pts, Array(17).fill([0.004, 0.022]), 4, { ref: new V3(0, 1, 0), square: 0.7 }), { reg: 'STRAP', w: wTorso, col });
  }
  // waist strap
  const ws = surf(24, 1, (u, v, p) => { torsoPoint(u * TAU, lerp(1.1, 1.13, v), infl + 0.009, p); }, { closeU: true });
  bd.add('cloth', ws, { reg: 'STRAP', w: wTorso, col, uvFn: (u, v) => [v, u] });
  // side utility pouch
  const sp = roundedBox(0.07, 0.09, 0.035, 0.01, { reg: () => 'POUCH' });
  bd.add('cloth', xformM(sp, mat4(torsoPoint(1.75, 1.15, infl + 0.03, new V3()), qe(0, -1.4, 0))), { w: wTorso, col });
}
function addVest(bd, vs) {
  const M = surf(26, 12, (u, v, p) => {
    const al = lerp(0.42, TAU - 0.42, u); const y = lerp(0.98, 1.5, v);
    torsoPoint(al, y, 0.012 + 0.002 * vnoise3(al * 3, y * 10, 2), p);
    if (y > 1.43) { // shoulder region narrows (armholes)
      const k = smooth(1.43, 1.5, y); p.x *= lerp(1, 0.7, k); }
  }, { skip: (i, j, u, v) => { const al = lerp(0.42, TAU - 0.42, u); const y = lerp(0.98, 1.5, v); return y > 1.3 && Math.abs(Math.sin(al)) > 0.82 && Math.abs(Math.cos(al)) < 0.6; } });
  // ensure outward
  bd.add('cloth', M, { reg: 'TORSO', w: wTorso, col: vs.col, uvFn: (u, v, p) => [u, (p.y - 0.8) / 0.75], flip: false });
  // vest pockets
  for (const s of [1, -1]) {
    const pk = roundedBox(0.09, 0.1, 0.02, 0.006, { reg: () => 'CARGO' });
    bendY(pk, 0.25);
    bd.add('cloth', xformM(pk, mat4(torsoPoint(s * 0.62, 1.1, 0.025, new V3()), qe(0, -s * 0.55, 0))), { w: wTorso, col: vs.col });
  }
}
function addBandolier(bd, bn, infl) {
  const P = [];
  const pts = [[-0.06, 1.53, -0.03], [-0.09, 1.45, -0.115], [-0.04, 1.33, -0.14], [0.05, 1.2, -0.135], [0.13, 1.08, -0.11], [0.175, 1.02, -0.02], [0.16, 1.04, 0.07],
    [0.08, 1.2, 0.115], [-0.03, 1.37, 0.115], [-0.09, 1.5, 0.075], [-0.07, 1.545, 0.02]];
  for (const q of pts) { const v = new V3(...q); v.z += Math.sign(v.z) * infl; P.push(v); }
  const path = catmull(P, 30);
  bd.add('cloth', tubePath(path, Array(31).fill([0.005, 0.03]), 4, { ref: new V3(0, 0, -1), square: 0.7 }), { reg: 'STRAP', w: wTorso, col: bn.col, rough: 0.7 });
  // pouches / cartridge loops on the front run
  for (let k = 0; k < 7; k++) {
    const t = 3 + k * 1.7; const i = Math.floor(t);
    const p = path[i].clone(), d = path[i + 1].clone().sub(path[i - 1]).normalize();
    const pk = roundedBox(0.045, 0.034, 0.024, 0.006, { reg: () => 'POUCH' });
    const q = new Q4().setFromUnitVectors(new V3(1, 0, 0), new V3(d.x, d.y, 0).normalize());
    const nrm = new V3(0, 0, -1);
    bd.add('cloth', xformM(pk, mat4(p.clone().addScaledVector(nrm, 0.014), q)), { w: wTorso, col: bn.col, rough: 0.75 });
  }
}
function addKneepads(bd, col) {
  const pad = roundedBox(0.095, 0.115, 0.03, 0.012, {});
  bendY(pad, 0.065); bendX(pad, 0.15);
  const k = new V3(...KNEE);
  bd.add('hard', xformM(pad, mat4(new V3(k.x, k.y - 0.01, k.z - 0.072), qe(0.05, 0, 0))), { w: SIDES.R.shin, mirror: true, col, rough: 0.6, wear: 1 });
  for (const dy of [0.075, -0.075]) {
    const ring = surf(16, 1, (u, v, p) => { const al = u * TAU; const y = k.y + dy + v * 0.022; const c = legCenter(y, new V3()); const r = legRadius(PANTS_KEYS.cargo, al, y, 0.004); p.set(c.x + Math.sin(al) * r, y, c.z - Math.cos(al) * r); }, { closeU: true });
    bd.add('cloth', ring, { reg: 'STRAP', w: dy > 0 ? SIDES.R.thigh : SIDES.R.shin, mirror: true, col: 0x161616 });
  }
}
function addHolster(bd) {
  const x = HIPJ[0] + 0.095, y = 0.76, z = 0.0;
  const plat = roundedBox(0.07, 0.15, 0.02, 0.008, { reg: () => 'NYLON' });
  bd.add('cloth', xformM(plat, mat4(new V3(x, y, z), qe(0, Math.PI / 2 - 0.08, 0))), { w: (p) => [[B.thighR, 1]], col: 0x1c1d1e });
  const hol = roundedBox(0.04, 0.16, 0.05, 0.012, {});
  bd.add('hard', xformM(hol, mat4(new V3(x + 0.025, y + 0.0, z - 0.008), qe(0, Math.PI / 2 - 0.08, 0.04))), { w: (p) => [[B.thighR, 1]], col: 0x18191a, rough: 0.5, wear: 1 });
  const grip = roundedBox(0.028, 0.07, 0.034, 0.008, { cheap: true });
  bd.add('hard', xformM(grip, mat4(new V3(x + 0.03, y + 0.105, z + 0.02), qe(-0.25, Math.PI / 2 - 0.08, 0))), { w: (p) => [[B.thighR, 1]], col: 0x141414, rough: 0.45, wear: 1 });
  // leg straps
  for (const yy of [0.70, 0.64]) {
    const ring = surf(16, 1, (u, v, p) => { const al = u * TAU; const y2 = yy + v * 0.02; const c = legCenter(y2, new V3()); const r = legRadius(PANTS_KEYS.cargo, al, y2, 0.003); p.set(c.x + Math.sin(al) * r, y2, c.z - Math.cos(al) * r); }, { closeU: true });
    bd.add('cloth', ring, { reg: 'STRAP', w: (p) => [[B.thighR, 1]], col: 0x161616 });
  }
  // hanger
  bd.add('cloth', tubePath([new V3(x - 0.02, 1.06, z), new V3(x - 0.005, 0.95, z), new V3(x + 0.0, 0.84, z)], Array(3).fill([0.004, 0.02]), 4, { ref: new V3(1, 0, 0), square: 0.7 }),
    { reg: 'STRAP', w: (p) => { const k = smooth(1.0, 0.86, p.y); return [[B.hips, 1 - k], [B.thighR, k]]; }, col: 0x161616 });
}
function addDump(bd, col) {
  const d = roundedBox(0.1, 0.09, 0.05, 0.02, { reg: () => 'SOFT' });
  bd.add('cloth', xformM(d, mat4(torsoPoint(-1.9, 1.0, 0.04, new V3()), qe(0, 1.9, 0))), { w: (p) => [[B.hips, 1]], col });
}
function addPack(bd, pk, carrier) {
  const s = pk.size;
  const zb = interpKeys(TORSO_KEYS, 1.28, 3) + (carrier ? 0.09 : 0.02);
  const bag = roundedBox(0.27 * s, 0.38 * s, 0.13 * s, 0.035, { reg: (f) => (f === 'pz' ? 'MOLLE' : 'NYLON') });
  bendY(bag, 0.5);
  bd.add('cloth', xformM(bag, mat4(new V3(0, 1.25, zb + 0.065 * s), qe(-0.04, Math.PI, 0))), { w: wTorso, col: pk.col });
  const lid = roundedBox(0.25 * s, 0.05, 0.14 * s, 0.02, { reg: () => 'NYLON' });
  bd.add('cloth', xformM(lid, mat4(new V3(0, 1.25 + 0.19 * s, zb + 0.065 * s), qe(-0.1, 0, 0))), { w: wTorso, col: pk.col });
  if (!carrier) for (const sd of [1, -1]) {
    const pts = catmull([new V3(sd * 0.08, 1.42, zb + 0.01), new V3(sd * 0.095, 1.53, 0.0), new V3(sd * 0.1, 1.48, -0.095), new V3(sd * 0.12, 1.35, -0.135), new V3(sd * 0.15, 1.15, -0.115), new V3(sd * 0.16, 1.08, 0.0)], 14);
    bd.add('cloth', tubePath(pts, Array(15).fill([0.006, 0.025]), 4, { ref: new V3(0, 1, 0), square: 0.7 }), { reg: 'STRAP', w: wTorso, col: pk.col });
  }
}

// =====================================================================================
// Shared assets (textures, materials)
// =====================================================================================
let SHARED = null; const FACE_TEX = {}; const PENDING = [];
const TEXBASE = 'assets/chars/';
function loadTex(url, srgb, wrap = true) {
  const loader = new THREE.TextureLoader();
  let res; const pr = new Promise((r) => { res = r; });
  const t = loader.load(TEXBASE + url, () => res(t), undefined, () => { console.warn('characters: missing texture', url); res(t); });
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  PENDING.push(pr);
  return t;
}
function patchCommon(sh) {
  sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
attribute vec2 duv; attribute vec4 extra; varying vec2 vDuv; varying vec4 vExtra; varying float vBindY;`)
    .replace('#include <uv_vertex>', `#include <uv_vertex>
vDuv = duv; vExtra = extra; vBindY = position.y;`);
}
function makeClothMaterial(S, pattern) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: S.clothM, normalMap: S.clothN, roughness: 1, metalness: 0 });
  m.normalScale.set(1, 1);
  m.userData.patCol = new THREE.Color(0x2d241c);
  if (pattern) m.defines = { PATTERN: '' };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tWeave = { value: S.weave }; sh.uniforms.tGrunge = { value: S.grunge }; sh.uniforms.tPat = { value: S.shemagh };
    sh.uniforms.uPatCol = { value: m.userData.patCol };
    patchCommon(sh);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform sampler2D tWeave; uniform sampler2D tGrunge; uniform sampler2D tPat; uniform vec3 uPatCol;
varying vec2 vDuv; varying vec4 vExtra; varying float vBindY; vec4 gWeave; vec4 gGr; vec4 gMacro; float gDust;`)
      .replace('#include <map_fragment>', `gWeave = texture2D(tWeave, vDuv * 25.0); gGr = texture2D(tGrunge, vDuv * 1.7); gMacro = texture2D(map, vMapUv);
diffuseColor.rgb *= gMacro.r * (0.80 + 0.40 * gWeave.a);`)
      .replace('#include <color_fragment>', `#include <color_fragment>
#ifdef PATTERN
{ float pt = texture2D(tPat, vDuv * 5.0).r; diffuseColor.rgb = mix(diffuseColor.rgb, uPatCol * (0.85 + 0.3*gWeave.a), pt * 0.92); }
#endif
{ float wear = clamp(gMacro.g * vExtra.z * (0.5 + 0.9 * gGr.b), 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.35 + vec3(0.02, 0.018, 0.014), wear * 0.6);
  vec4 gF = texture2D(tGrunge, vDuv * 7.3 + 0.37);
  float dmask = smoothstep(0.7, 0.0, vBindY) * 0.38 + 0.1 + gMacro.b * 0.25;
  gDust = clamp(dmask * vExtra.w * (0.35 + 0.45 * gF.r + 0.35 * gGr.r), 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.40, 0.32, 0.22), gDust * 0.55); }`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = clamp(vExtra.x * (0.9 + 0.2 * gWeave.a) + gDust * 0.2, 0.0, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `float metalnessFactor = vExtra.y;`)
      .replace('mapN.xy *= normalScale;', `mapN.xy *= normalScale; { vec3 wn = gWeave.xyz * 2.0 - 1.0; mapN = normalize(vec3(mapN.xy + wn.xy * 0.55, mapN.z)); }`);
  };
  m.customProgramCacheKey = () => 'dustcloth' + (pattern ? 'P' : '');
  return m;
}
function makeHardMaterial(S, gloss) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tGrunge = { value: S.grunge };
    patchCommon(sh);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform sampler2D tGrunge; varying vec2 vDuv; varying vec4 vExtra; varying float vBindY; vec4 gGr; float gDust;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
gGr = texture2D(tGrunge, vDuv * 2.3);
${gloss ? 'gDust = 0.0;' : `{ float w = clamp(vExtra.z * (gGr.g * 1.4 + gGr.r * 0.5 + 0.15), 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.5 + vec3(0.07, 0.065, 0.06), w * 0.75);
  diffuseColor.rgb += vec3(0.02) * gGr.g;
  vec4 gF = texture2D(tGrunge, vDuv * 7.3 + 0.37);
  float dmask = smoothstep(0.7, 0.0, vBindY) * 0.45 + 0.1;
  gDust = clamp(dmask * vExtra.w * (0.3 + 0.5 * gF.r + 0.3 * gGr.r), 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.40, 0.32, 0.22), gDust * 0.5); }`}`)
      .replace('#include <roughnessmap_fragment>', gloss ? 'float roughnessFactor = vExtra.x;' : `float roughnessFactor = clamp(vExtra.x + (gGr.g - 0.3) * 0.15 + gDust * 0.3 - vExtra.z * 0.1, 0.05, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `float metalnessFactor = vExtra.y;`);
  };
  m.customProgramCacheKey = () => (gloss ? 'chgloss' : 'chhard');
  return m;
}
function ensureShared(renderer) {
  if (SHARED) return SHARED;
  const S = {};
  S.clothN = loadTex('cloth_n.jpg', false, false); S.clothM = loadTex('cloth_m.jpg', false, false);
  S.weave = loadTex('weave.png', false); S.grunge = loadTex('grunge.jpg', false); S.shemagh = loadTex('shemagh.png', false);
  S.skinN = loadTex('skin_n.jpg', false, false);
  const an = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  for (const k of ['clothN', 'clothM', 'skinN']) S[k].anisotropy = an;
  S.cloth = makeClothMaterial(S, false);
  S.hard = makeHardMaterial(S, false);
  S.gloss = makeHardMaterial(S, true);
  S.patterns = {}; S.skins = {};
  SHARED = S;
  return S;
}
function patternMat(hex) {
  const S = ensureShared();
  if (!S.patterns[hex]) { const m = makeClothMaterial(S, true); m.userData.patCol.setHex(hex); S.patterns[hex] = m; }
  return S.patterns[hex];
}
function skinMat(face) {
  const S = ensureShared();
  if (!S.skins[face]) {
    if (!FACE_TEX[face]) FACE_TEX[face] = loadTex('face_' + face + '.jpg', true, false);
    const m = new THREE.MeshPhysicalMaterial({ map: FACE_TEX[face], normalMap: S.skinN, roughness: 0.56, metalness: 0,
      sheen: 0.25, sheenRoughness: 0.55, sheenColor: new THREE.Color(0.55, 0.36, 0.3), specularIntensity: 0.5 });
    m.normalScale.set(0.35, 0.35);
    S.skins[face] = m;
  }
  return S.skins[face];
}

export async function preloadCharacterAssets(renderer) {
  ensureShared(renderer);
  for (const team of ['ct', 't']) for (let i = 0; i < 5; i++) { getVariantGeo(team, i); skinMat(VARIANTS[team][i].face); }
  for (const team of ['ct', 't']) for (const V of VARIANTS[team]) { if (V.head && V.head.pat) patternMat(V.head.pat); if (V.neckwrap) patternMat(V.neckwrap.pat); }
  await Promise.all(PENDING);
}
const GEO_CACHE = {};
function getVariantGeo(team, vi) {
  const key = team + vi;
  if (!GEO_CACHE[key]) GEO_CACHE[key] = buildVariant(team, vi);
  return GEO_CACHE[key];
}

// =====================================================================================
// Hold presets (weapon frame vectors). palm = palm centre relative to grip origin.
// =====================================================================================
const HOLD = {
  rifle: { off: [0.1, -0.085, -0.25], pitchK: 1, yawK: 1, blade: -0.3,
    R: { palm: [0.013, -0.012, 0.018], fin: [-0.25, 0.5, -1], dor: [1, 0.3, 0.15] },
    L: { palm: [-0.014, -0.018, -0.30], fin: [0.75, 0.15, -0.6], dor: [-0.4, -0.95, -0.05] }, elbowR: [0.75, -1, 0.3], elbowL: [-0.35, -1, 0.1] },
  pistol: { off: [0.035, -0.075, -0.53], pitchK: 1, yawK: 1, blade: -0.1,
    R: { palm: [0.012, -0.014, 0.016], fin: [-0.25, 0.55, -1], dor: [1, 0.25, 0.1] },
    L: { palm: [-0.024, -0.03, 0.004], fin: [0.2, 0.55, -0.8], dor: [-1, -0.15, 0.1] }, elbowR: [0.8, -1, 0.3], elbowL: [-0.8, -1, 0.3] },
  knife: { off: [0.19, -0.42, -0.3], pitchK: 0.3, yawK: 1, blade: -0.15, pitchBias: -0.1,
    R: { palm: [0.012, 0.0, 0.004], fin: [-0.2, -0.55, -0.8], dor: [1, -0.1, -0.15] }, L: null, elbowR: [0.6, -1, 0.5], elbowL: [-0.6, -1, 0.4],
    freeL: [-0.2, -0.36, -0.2] },
  grenade: { off: [0.16, -0.03, -0.26], pitchK: 0.5, yawK: 1, blade: -0.2,
    R: { palm: [0.012, -0.03, 0.01], fin: [-0.25, 0.75, -0.55], dor: [1, 0.05, 0.3] }, L: null, elbowR: [0.7, -1, 0.4], elbowL: [-0.6, -1, 0.3],
    freeL: [-0.17, -0.27, -0.28] },
  c4: { off: [0.0, -0.4, -0.3], pitchK: 0.2, yawK: 1, blade: -0.05, pitchBias: 0.0,
    R: { palm: [0.07, -0.005, 0.02], fin: [-0.15, 0.25, -1], dor: [1, 0.1, 0.05] },
    L: { palm: [-0.07, -0.005, 0.02], fin: [0.15, 0.25, -1], dor: [-1, 0.1, 0.05] }, elbowR: [0.8, -1, 0.4], elbowL: [-0.8, -1, 0.4] },
  none: { off: [0.0, -0.4, -0.1], pitchK: 0, yawK: 1, blade: 0 },
};
const PALM_LOCAL = { R: armDir(1).multiplyScalar(0.072).addScaledVector(armLat(1), -0.017), L: armDir(-1).multiplyScalar(0.072).addScaledVector(armLat(-1), -0.017) };
const _m3 = new M4();
function basisQuat(x, y, out) { const z = _t0.crossVectors(x, y); _m3.makeBasis(x, y, z); return out.setFromRotationMatrix(_m3); }
// bind bases (inverse) for IK-driven bones
const Q0INV = [];
(function initBases() {
  for (const sd of ['R', 'L']) {
    const S = SIDES[sd];
    const ad = armDir(S.s), lat = armLat(S.s);
    Q0INV[S.uarm] = basisQuat(new V3(0, 0, 1), ad, new Q4()).invert();
    Q0INV[S.farm] = basisQuat(new V3(0, 0, 1), ad, new Q4()).invert();
    Q0INV[S.hand] = basisQuat(lat, ad, new Q4()).invert();
    const td = BIND[S.shin].clone().sub(BIND[S.thigh]).normalize();
    const sdd = BIND[S.foot].clone().sub(BIND[S.shin]).normalize();
    Q0INV[S.thigh] = basisQuat(new V3(0, 0, -1).addScaledVector(td, -(-td.z)).normalize(), td, new Q4()).invert();
    Q0INV[S.shin] = basisQuat(new V3(0, 0, -1).addScaledVector(sdd, -(-sdd.z)).normalize(), sdd, new Q4()).invert();
  }
})();
function handQuatInWeapon(side, preset, out) {
  const f = new V3(...preset.fin).normalize();
  const d = new V3(...preset.dor); d.addScaledVector(f, -d.dot(f)).normalize();
  basisQuat(d, f, out); return out.multiply(Q0INV[SIDES[side].hand]);
}

// =====================================================================================
// Character
// =====================================================================================
const _v = [new V3(), new V3(), new V3(), new V3(), new V3(), new V3(), new V3(), new V3()];
const _q = [new Q4(), new Q4(), new Q4(), new Q4(), new Q4()];
const _e = new THREE.Euler();
const X_AX = new V3(1, 0, 0), Y_AX = new V3(0, 1, 0), Z_AX = new V3(0, 0, 1);
function qEuler(x, y, z, out, ord = 'YXZ') { _e.set(x, y, z, ord); return out.setFromEuler(_e); }
function perpTo(v, axis, out) { out.copy(v).addScaledVector(axis, -v.dot(axis)); const l = out.length(); if (l < 1e-6) return null; return out.multiplyScalar(1 / l); }

class Character {
  constructor(team, variant) {
    this.team = team; this.variant = variant;
    const V = VARIANTS[team][variant];
    const S = ensureShared();
    const built = getVariantGeo(team, variant);
    this.triangles = built.tris;
    this.root = new THREE.Group(); this.root.name = 'character_' + team + variant;
    this.body = new THREE.Group(); this.root.add(this.body);
    this.bones = [];
    for (let i = 0; i < NB; i++) {
      const b = new THREE.Bone(); b.name = BONE_DEF[i][0]; b.position.copy(OFF[i]);
      this.bones.push(b);
      if (PARENT[i] < 0) this.body.add(b); else this.bones[PARENT[i]].add(b);
    }
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this.bones);
    this.meshes = [];
    const pat = (V.head && V.head.pat) || (V.neckwrap && V.neckwrap.pat) || 0x2d241c;
    const mats = { cloth: S.cloth, pattern: patternMat(pat), skin: skinMat(V.face), hard: S.hard, gloss: S.gloss };
    for (const k of MATS) {
      const g = built.geos[k]; if (!g) continue;
      const m = new THREE.SkinnedMesh(g, mats[k]);
      m.bind(this.skeleton, new M4());
      m.castShadow = true; m.receiveShadow = true;
      m.boundingSphere = new THREE.Sphere(new V3(0, 0.9, 0), 2.3);
      m.name = k;
      this.body.add(m); this.meshes.push(m);
    }
    // pose state
    this.P = BIND.map((p) => p.clone()); this.Q = BIND.map(() => new Q4());
    this.feetYaw = 0; this.turning = false; this.time = Math.random() * 10; this.seed = Math.random();
    this.phase = 0; this.moveW = 0; this.lv = new V3(); this.lvS = new V3(); this.acc = new V3(); this.prevLv = new V3();
    this.crouchS = 0; this.airW = 0; this.airT = 0; this.land = 0; this.walkS = 0;
    this.rec = 0; this.recV = 0; this.reloadT = -1; this.reloadDur = 2.5; this.throwT = -1; this.kneel = 0; this.planting = false; this.defusing = false;
    this.weapon = null; this.holdType = 'none'; this.hold = HOLD.none; this.leftLocal = null;
    this.qGripR = new Q4(); this.qGripL = new Q4(); this.wristInW = new V3();
    this.footPlant = [new V3(), new V3()];
    this.dead = false; this.rag = null;
    this.hb = []; this._initHitboxes();
    this._prevYaw = 0;
    this.update(0, { vel: new V3(), yaw: 0, pitch: 0, crouch: 0, onGround: true, walking: false });
  }

  setWeapon(model, holdType) {
    if (this.weapon && this.weapon.parent) this.weapon.parent.remove(this.weapon);
    this.weapon = model || null;
    this.holdType = model ? (HOLD[holdType] && HOLD[holdType].R ? holdType : 'rifle') : 'none';
    this.hold = HOLD[this.holdType];
    this.leftLocal = null;
    if (!model) return;
    const H = this.hold;
    // hand rotation in weapon frame
    handQuatInWeapon('R', H.R, this.qGripR);
    const palmR = new V3(...H.R.palm);
    this.wristInW.copy(palmR).sub(PALM_LOCAL.R.clone().applyQuaternion(this.qGripR));
    // weapon local transform relative to the right hand bone = inverse(handInWeapon)
    const hiw = mat4(this.wristInW, this.qGripR); const inv = hiw.invert();
    inv.decompose(model.position, model.quaternion, model.scale);
    model.scale.set(1, 1, 1);
    this.bones[B.handR].add(model);
    // left hand target
    if (H.L) {
      handQuatInWeapon('L', H.L, this.qGripL);
      const ud = model.userData || {};
      const lh = ud.leftHand;
      if (lh) {
        model.updateMatrixWorld(true);
        const mw = new M4().copy(model.matrixWorld).invert().multiply(lh.matrixWorld);
        this.leftLocal = new V3().setFromMatrixPosition(mw);
        // leftHand anchors mark the handguard axis / grip: put the palm on the surface below-left of it
        if (this.holdType === 'rifle') {
          const hg = ud.handguard;
          this.leftLocal.x += hg ? -0.3 * hg.w : -0.008; this.leftLocal.y += hg ? -0.5 * hg.h - 0.003 : -0.026;
        } else if (this.holdType === 'pistol') this.leftLocal.x += -0.022;
      } else this.leftLocal = new V3(...H.L.palm);
    }
  }

  fire() { this.recV += 9; }
  reload(timeSec) { this.reloadT = 0; this.reloadDur = Math.max(0.6, timeSec || 2.5); }
  throwGrenade() { this.throwT = 0; }
  plant(active) { this.planting = !!active; }
  defuse(active) { this.defusing = !!active; }
  setVisible(v) { this.root.visible = !!v; }
  dispose() {
    if (this.weapon && this.weapon.parent) this.weapon.parent.remove(this.weapon);
    if (this.root.parent) this.root.parent.remove(this.root);
    this.skeleton.dispose();
  }
  revive() {
    this.dead = false; this.rag = null; this.reloadT = -1; this.throwT = -1; this.planting = this.defusing = false; this.kneel = 0;
    this.rec = this.recV = 0; this.airW = 0; this.land = 0;
    if (this.weapon && !this.weapon.parent) this.bones[B.handR].add(this.weapon);
    if (this.weapon) this.weapon.visible = true;
  }

  // -------------------------------------------------------------------------------- update
  update(dt, s) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    this.time += dt;
    if (this.dead) { if (!this.rag || !this.rag.applied) { this._ragStep(dt); this._ragApply(); this._writeBones(); if (this.rag && this.rag.rest) this.rag.applied = true; } return; }
    const P = this.P, Q = this.Q;
    const vel = s.vel || _v[0].set(0, 0, 0);
    const vx = vel.x / 39.37, vz = vel.z / 39.37;
    const spd = Math.hypot(vx, vz);
    const onGround = s.onGround !== false;
    const yaw = s.yaw || 0, pitch = clamp(s.pitch || 0, -1.45, 1.45);

    // --- lower body yaw
    let diff = wrapA(yaw - this.feetYaw); let turnRate = 0;
    if (spd > 0.5 || !onGround || this.kneel > 0.5) { const k = 1 - Math.exp(-14 * dt); this.feetYaw += diff * k; turnRate = diff * k / Math.max(dt, 1e-3); this.turning = false; }
    else {
      if (Math.abs(diff) > 0.95) this.turning = true;
      if (this.turning) { const st = Math.sign(diff) * Math.min(Math.abs(diff), 4.5 * dt); this.feetYaw += st; turnRate = st / Math.max(dt, 1e-3); if (Math.abs(diff) < 0.06) this.turning = false; }
    }
    this.feetYaw = wrapA(this.feetYaw);
    this.body.rotation.y = this.feetYaw;
    const aimYaw = wrapA(yaw - this.feetYaw);
    // --- local velocity
    const cy = Math.cos(this.feetYaw), sy = Math.sin(this.feetYaw);
    this.lv.set(vx * cy - vz * sy, 0, vx * sy + vz * cy);
    const ka = 1 - Math.exp(-8 * dt);
    if (dt > 0) { _v[1].copy(this.lv).sub(this.prevLv).multiplyScalar(1 / dt); this.acc.lerp(_v[1].clampLength(0, 12), ka); }
    this.prevLv.copy(this.lv);
    this.lvS.lerp(this.lv, 1 - Math.exp(-12 * dt));
    this.crouchS += (clamp(s.crouch || 0, 0, 1) - this.crouchS) * (1 - Math.exp(-14 * dt));
    this.walkS += ((s.walking ? 1 : 0) - this.walkS) * (1 - Math.exp(-6 * dt));
    // airborne / landing
    if (!onGround) { this.airT += dt; } else { if (this.airT > 0.18) this.land = Math.min(1, 0.4 + this.airT * 0.8); this.airT = 0; }
    this.airW += ((!onGround && this.airT > 0.05 ? 1 : 0) - this.airW) * (1 - Math.exp(-(onGround ? 16 : 9) * dt));
    this.land *= Math.exp(-7 * dt);
    // kneel (plant/defuse)
    const kneelTarget = (this.planting || this.defusing) ? 1 : 0;
    this.kneel += (kneelTarget - this.kneel) * (1 - Math.exp(-7 * dt));
    // recoil spring
    this.recV -= (this.rec * 260 + this.recV * 24) * dt; this.rec += this.recV * dt; this.rec = clamp(this.rec, -0.3, 1.2);
    if (this.reloadT >= 0) { this.reloadT += dt; if (this.reloadT > this.reloadDur) this.reloadT = -1; }
    if (this.throwT >= 0) { this.throwT += dt; if (this.throwT > 0.75) this.throwT = -1; }
    if (this.weapon) this.weapon.visible = !(this.defusing && this.kneel > 0.3);

    // ========== locomotion ==========
    const crouch = this.crouchS * (1 - this.kneel);
    const gSpd = Math.max(spd, Math.abs(turnRate) * 0.22);
    this.moveW += ((gSpd > 0.25 ? 1 : 0) - this.moveW) * (1 - Math.exp(-7 * dt));
    const run = smooth(2.6, 5.2, spd) * (1 - crouch) * (1 - this.walkS * 0.85);
    let cyc = lerp(lerp(1.62, 2.15, run), 1.15, crouch);
    cyc = Math.min(cyc, 0.55 + gSpd * 0.42);
    const stance = lerp(lerp(0.6, 0.4, run), 0.62, crouch);
    const lift = lerp(lerp(0.075, 0.16, run), 0.06, crouch) * this.moveW;
    if (onGround) this.phase = (this.phase + gSpd * dt / cyc) % 1;
    const mdx = spd > 0.05 ? this.lvS.x / Math.max(0.05, this.lvS.length()) : 0, mdz = spd > 0.05 ? this.lvS.z / Math.max(0.05, this.lvS.length()) : -1;
    const fwdness = -mdz; // +1 forward
    const lat = Math.abs(mdx);
    let L = stance * cyc * (spd > 0.05 ? Math.min(1, spd / Math.max(gSpd, 0.01)) : 0);
    L = Math.min(L, lerp(0.95, 0.5, lat));
    // home positions
    const blade = this.hold.blade * (1 - 0.6 * this.moveW) * (1 - this.kneel);
    if (!this._tmp) this._tmp = { homeL: new V3(), homeR: new V3(), ft: [new V3(), new V3()], pole: new V3(), feet: [{ home: null, ph: 0 }, { home: null, ph: 0 }], ftPitch: [0, 0], ftYaw: [0, 0] };
    const TM = this._tmp; const homeL = TM.homeL, homeR = TM.homeR;
    const idleL = [-0.115, -0.07], idleR = [0.13, 0.085], crL = [-0.13, -0.17], crR = [0.125, 0.15], mvW = 0.1 + lat * 0.05;
    homeL.set(lerp(lerp(idleL[0], -mvW, this.moveW), crL[0], crouch), 0, lerp(lerp(idleL[1] * (blade ? 1 : 0.4), 0, this.moveW), lerp(crL[1], -0.05, this.moveW), crouch));
    homeR.set(lerp(lerp(idleR[0], mvW, this.moveW), crR[0], crouch), 0, lerp(lerp(idleR[1] * (blade ? 1 : 0.4), 0, this.moveW), lerp(crR[1], 0.05, this.moveW), crouch));
    // feet
    const feet = TM.feet; feet[0].home = homeL; feet[0].ph = this.phase; feet[1].home = homeR; feet[1].ph = (this.phase + 0.5) % 1;
    const ftT = TM.ft; const ftPitch = TM.ftPitch, ftYaw = TM.ftYaw;
    const back = fwdness < -0.3 ? -1 : 1;
    for (let k = 0; k < 2; k++) {
      const f = feet[k]; let rel, h = 0, pch = 0;
      if (f.ph < stance) {
        const t = f.ph / stance; rel = lerp(L / 2, -L / 2, t);
        pch = (t < 0.15 ? lerp(0.28, 0, t / 0.15) : t > 0.6 ? -lerp(0, 0.65, (t - 0.6) / 0.4) : 0) * back;
      } else {
        const t = (f.ph - stance) / (1 - stance);
        const td = clamp((t - 0.18 * run) / (1 - 0.18 * run), 0, 1); const e = td * td * (3 - 2 * td);   // running: heel kicks up first
        rel = lerp(-L / 2, L / 2, e);
        const hp = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.08)), 0.85);
        h = lift * (hp + run * 0.8 * Math.sin(Math.PI * clamp(t / 0.6, 0, 1)) * (1 - t));
        pch = (t < 0.35 ? lerp(-0.65, -0.25, t / 0.35) : lerp(-0.25, 0.28, (t - 0.35) / 0.65)) * back;
      }
      pch *= this.moveW * lerp(1, 0.55, lat) * (1 - crouch * 0.5);
      const latScale = 1 - 0.35 * lat;
      ftT[k].set(f.home.x + mdx * rel * latScale * this.moveW, 0.085 + h, f.home.z + mdz * rel * this.moveW);
      // roll lift
      ftT[k].y += pch > 0 ? Math.sin(pch) * 0.07 : Math.sin(-pch) * 0.125;
      ftPitch[k] = pch;
      ftYaw[k] = (k === 0 ? 0.08 : -0.08) * (1 - this.moveW) + blade * 0.5 * (1 - this.moveW);
    }
    // crouch: right foot on toes (heel raised)
    if (crouch > 0) {
      const k = crouch * (1 - this.moveW);
      ftPitch[1] = lerp(ftPitch[1], -0.75, k); ftT[1].y += 0.075 * k; ftT[1].z += 0.0 * k;
    }
    // kneel pose (plant/defuse): right knee on the ground
    if (this.kneel > 0.001) {
      const k = this.kneel;
      ftT[0].lerp(_v[6].set(-0.13, 0.085, -0.28), k); ftPitch[0] = lerp(ftPitch[0], 0, k);
      ftT[1].lerp(_v[6].set(0.12, 0.1, 0.36), k); ftPitch[1] = lerp(ftPitch[1], -1.2, k);
      ftYaw[0] *= 1 - k; ftYaw[1] *= 1 - k;
    }
    // airborne: tuck legs
    if (this.airW > 0.001) {
      const k = this.airW;
      ftT[0].lerp(_v[6].set(-0.11, 0.3, -0.12), k); ftT[1].lerp(_v[6].set(0.12, 0.22, 0.13), k);
      ftPitch[0] = lerp(ftPitch[0], 0.15, k); ftPitch[1] = lerp(ftPitch[1], -0.45, k);
    }
    // --- hips
    const breathe = Math.sin(this.time * 1.6 + this.seed * 6);
    const sway = Math.sin(this.time * 0.7 + this.seed * 3) * (1 - this.moveW);
    let hipY = lerp(lerp(0.958, 0.53, crouch), 0.53, this.kneel) - this.land * 0.14 + this.airW * 0.04;
    const bobPh = this.phase * TAU * 2;
    hipY += this.moveW * (run > 0.5 ? -0.028 * Math.cos(bobPh) : 0.014 * Math.cos(bobPh)) * (1 - crouch * 0.6);
    hipY += -0.004 * (1 - this.moveW) * (0.5 + 0.5 * sway);
    let hipZ = lerp(0.0, 0.07, crouch) + this.kneel * 0.04 + this.airW * 0.02;
    let hipX = 0.012 * sway + this.moveW * 0.012 * Math.sin(this.phase * TAU) * (1 - lat);
    // hip rotations
    const hipYaw = blade * 0.35 + this.moveW * 0.13 * Math.sin(this.phase * TAU) * (1 - lat) * (1 - crouch * 0.5);
    const hipRoll = this.moveW * 0.05 * Math.cos(this.phase * TAU) * (1 - crouch) + 0.02 * sway;
    let hipPitch = -(lerp(0.04, 0.3, crouch) + this.kneel * 0.38 + run * 0.06 * this.moveW);
    // reach clamp
    _q[0].setFromEuler(_e.set(hipPitch, hipYaw, hipRoll, 'YXZ'));
    for (let k = 0; k < 2; k++) {
      const S = SIDES[k ? 'R' : 'L'];
      _v[6].copy(OFF[S.thigh]).applyQuaternion(_q[0]);
      const hx = hipX + _v[6].x, hz = hipZ + _v[6].z;
      const dxz = Math.hypot(ftT[k].x - hx, ftT[k].z - hz);
      const reach = (LT + LS) * 0.992;
      const maxY = ftT[k].y + Math.sqrt(Math.max(0, reach * reach - dxz * dxz)) - _v[6].y;
      if (hipY > maxY) hipY = lerp(hipY, maxY, 0.85);
    }
    P[0].set(hipX, hipY, hipZ); Q[0].copy(_q[0]);
    // --- spine chain with aim
    const accF = clamp(-this.acc.z * 0.012, -0.1, 0.12), accS = clamp(this.acc.x * 0.01, -0.08, 0.08);
    const spPitch = pitch * 0.18 * (this.hold.pitchK > 0.5 ? 1 : 0.6) - 0.05 * run * this.moveW - accF * 0.5 + crouch * 0.1 - this.kneel * 0.3 + 0.006 * breathe;
    const twist = aimYaw * this.hold.yawK;
    this._setLocal(1, spPitch, twist * 0.3 + blade * 0.35 - hipYaw * 0.6, -hipRoll * 0.6 - accS * 0.5);
    const chPitch = pitch * 0.22 * (this.hold.pitchK > 0.5 ? 1 : 0.5) - accF * 0.5 - this.kneel * 0.22 + 0.01 * breathe + this.rec * 0.04 + crouch * 0.03;
    this._setLocal(2, chPitch, twist * 0.32 + blade * 0.45 - hipYaw * 0.3, -hipRoll * 0.3 - accS * 0.5);
    // clavicles / arms / weapon
    this._upperBody(dt, aimYaw, pitch, breathe);
    // head look
    const hq = _q[1]; qEuler(lerp(pitch * 0.92 - (this.holdType === 'rifle' ? 0.17 : 0.04), -0.55, this.kneel), aimYaw * (1 - this.kneel), (this.holdType === 'rifle' ? -0.12 : 0) * (1 - this.kneel), hq);
    this._chainPos(3); Q[3].slerpQuaternions(Q[2], hq, 0.45);
    this._chainPos(4); Q[4].copy(hq);
    // --- legs IK
    for (let k = 0; k < 2; k++) {
      const sd = k ? 'R' : 'L'; const S = SIDES[sd];
      this._chainPos(S.thigh);
      const fy = ftYaw[k] + (crouch > 0 ? (k ? -0.25 : 0.1) * crouch : 0);
      // knee pole: forward of foot yaw, slightly outward
      const pole = TM.pole.set(-Math.sin(fy) + (k ? 0.18 : -0.18), (crouch + this.kneel) * -0.05, -Math.cos(fy)).normalize();
      if (this.kneel > 0.01 && k === 1) pole.lerp(_v[7].set(0.1, -0.6, -0.8).normalize(), this.kneel).normalize();
      this._legIK(S, ftT[k], pole, fy, ftPitch[k]);
    }
    this._writeBones();
  }

  _setLocal(i, x, y, z, keepAsIs) { // compose local rotation on top of parent's body rotation
    if (keepAsIs) { qEuler(x, y, z, _q[2]); this.Q[i].multiply(_q[2]); return; }
    qEuler(x, y, z, _q[2]);
    this.Q[i].copy(this.Q[PARENT[i]]).multiply(_q[2]);
    this._chainPos(i);
  }
  _chainPos(i) { const p = PARENT[i]; this.P[i].copy(OFF[i]).applyQuaternion(this.Q[p]).add(this.P[p]); }

  _upperBody(dt, aimYaw, pitch, breathe) {
    const P = this.P, Q = this.Q, H = this.hold;
    const t = this.time;
    // aim frame
    const qAim = _q[3];
    const pk = H.pitchK; const pb = H.pitchBias || 0;
    qEuler(pitch * pk + pb, aimYaw, 0, qAim);
    // weapon position from chest pivot
    const piv = (this._piv || (this._piv = new V3())).set(0, 0.215, -0.02).applyQuaternion(Q[2]).add(P[2]);
    const Pw = this._Pw || (this._Pw = new V3()); const Qw = this._Qw || (this._Qw = new Q4());
    Pw.set(...H.off);
    // idle sway & breathing
    Pw.y += 0.004 * breathe; Pw.x += 0.003 * Math.sin(t * 0.9 + this.seed * 5);
    // moving bob
    Pw.y += this.moveW * 0.012 * Math.sin(this.phase * TAU * 2 + 0.6);
    Pw.x += this.moveW * 0.01 * Math.sin(this.phase * TAU + 0.3);
    // recoil
    Pw.z += this.rec * 0.035; Pw.y += this.rec * 0.008;
    Qw.copy(qAim);
    qEuler(this.rec * 0.07, 0, this.rec * 0.015, _q[4]); Qw.multiply(_q[4]);
    // reload: weapon tilts, pulls in
    let relK = 0, rl = 0;
    if (this.reloadT >= 0) {
      rl = this.reloadT / this.reloadDur; relK = smooth(0, 0.12, rl) * smooth(1, 0.86, rl);
      Pw.x += -0.04 * relK; Pw.y += -0.03 * relK; Pw.z += 0.07 * relK;
      qEuler(-0.1 * relK, 0.15 * relK, -0.55 * relK, _q[4]); Qw.multiply(_q[4]);
    }
    // throw
    let thK = 0, thT = 0;
    if (this.throwT >= 0 && this.holdType === 'grenade') { thT = this.throwT; thK = 1; }
    // kneel: bring the weapon/c4 down to the ground
    if (this.kneel > 0.01 && this.holdType !== 'c4') {
      const k = this.kneel * 0.8;
      Pw.lerp(_v[1].set(0.1, -0.45, -0.32), k);
      qEuler(-0.6 * k, 0.4 * k, 0, _q[4]); Qw.multiply(_q[4]);
    }
    if (this.holdType === 'c4' && this.kneel > 0.01) {
      // c4 on the ground in front
      const k = this.kneel;
      const gp = _v[1].set(0.0, 0.1, -0.4); // body space
      const pw = _v[2].copy(Pw).applyQuaternion(qAim).add(piv);
      pw.lerp(gp, k);
      Pw.copy(pw).sub(piv).applyQuaternion(_q[4].copy(qAim).invert());
      qEuler(0, aimYaw * (1 - k), 0, _q[4]); Qw.slerp(_q[4], k);
      if (this.planting) Pw.y += 0.01 * Math.max(0, Math.sin(t * 18)) * k;
    }
    // to body space
    const wpos = _v[1].copy(Pw).applyQuaternion(qAim).add(piv);
    if (this.holdType === 'none') wpos.set(0, 0, 0);
    // clavicles
    for (const sd of ['L', 'R']) {
      const S = SIDES[sd];
      const reach = this.holdType === 'none' ? 0 : clamp(-(wpos.z) * 2.2 + (sd === 'L' ? 0.4 : 0), 0, 1);
      const up = this.holdType === 'none' ? 0 : clamp((wpos.y - 1.25) * 2.5, -0.5, 1);
      qEuler(0, S.s * (sd === 'L' ? -0.38 : -0.15) * reach, S.s * (0.1 * up + 0.03 * breathe), _q[4]);
      Q[S.clav].copy(Q[2]).multiply(_q[4]); this._chainPos(S.clav); this._chainPos(S.uarm);
    }
    // ---- right hand target
    const qhR = _q[0];
    const wristR = _v[2];
    if (this.holdType === 'none') {
      wristR.set(0.24, 0.98, 0.03).applyQuaternion(_q[4].setFromAxisAngle(Y_AX, 0)); // hang
      qhR.copy(Q[2]);
      wristR.copy(P[B.uarmR]).add(_v[3].set(0.05, -0.53, 0.04 + 0.04 * Math.sin(this.phase * TAU) * this.moveW));
    } else {
      qhR.copy(Qw).multiply(this.qGripR);
      wristR.copy(this.wristInW).applyQuaternion(Qw).add(wpos);
    }
    // throw animation overrides right hand
    if (thK > 0) {
      const tt = thT;
      const key = [[0, [0.16, -0.03, -0.26]], [0.24, [0.27, 0.27, 0.2]], [0.36, [0.22, 0.3, -0.05]], [0.45, [0.14, 0.12, -0.52]], [0.6, [0.02, -0.3, -0.42]], [0.75, [0.16, -0.03, -0.26]]];
      let a = key[0], b = key[key.length - 1];
      for (let i = 0; i < key.length - 1; i++) if (tt >= key[i][0] && tt <= key[i + 1][0]) { a = key[i]; b = key[i + 1]; break; }
      const u = smooth(0, 1, (tt - a[0]) / Math.max(1e-3, b[0] - a[0]));
      const off = _v[3].set(lerp(a[1][0], b[1][0], u), lerp(a[1][1], b[1][1], u), lerp(a[1][2], b[1][2], u));
      const tw = (tt < 0.3 ? -smooth(0, 0.22, tt) * 0.5 : lerp(-0.5, 0.35, smooth(0.3, 0.5, tt))) * smooth(0.75, 0.6, tt);
      // twist chest for the throw
      qEuler(0, tw * 0.6, 0, _q[4]); Q[2].multiply(_q[4]);
      for (const sd of ['L', 'R']) { const S = SIDES[sd]; Q[S.clav].copy(Q[2]); this._chainPos(S.clav); this._chainPos(S.uarm); }
      const wp = _v[6].copy(off).applyQuaternion(qAim).add(_v[7].set(0, 0.215, -0.02).applyQuaternion(Q[2]).add(P[2]));
      qhR.copy(qAim).multiply(this.qGripR);
      qEuler(lerp(0.9, -0.5, smooth(0.25, 0.48, tt)), 0, 0, _q[4]); qhR.multiply(_q[4]);
      wristR.copy(this.wristInW).applyQuaternion(qhR.clone().multiply(_q[4].copy(this.qGripR).invert())).add(wp);
    }
    this._armIK(SIDES.R, wristR, qhR, _v[3].set(...(H.elbowR || [1, -1, 0.3])).applyQuaternion(qAim));
    // ---- left hand
    const qhL = _q[1]; const wristL = _v[5];
    let haveL = false;
    if (this.leftLocal && this.holdType !== 'none') {
      qhL.copy(Qw).multiply(this.qGripL);
      const palmW = _v[4].copy(this.leftLocal).applyQuaternion(Qw).add(wpos);
      wristL.copy(palmW).sub(_v[6].copy(PALM_LOCAL.L).applyQuaternion(qhL));
      haveL = true;
    }
    if (!haveL) {
      const fl = H.freeL || [-0.2, -0.45, -0.05];
      wristL.set(...fl).applyQuaternion(qAim).add(piv);
      if (this.holdType === 'none') wristL.copy(P[B.uarmL]).add(_v[3].set(-0.05, -0.53, 0.04 - 0.04 * Math.sin(this.phase * TAU) * this.moveW));
      qEuler(-0.4, 0.3, 1.2, qhL); qhL.premultiply(Q[2]);
      if (thK > 0) { const k = smooth(0.0, 0.15, thT) * smooth(0.75, 0.5, thT); wristL.lerp(_v[6].set(-0.12, 0.05, -0.5).applyQuaternion(qAim).add(piv), k); }
    }
    // reload choreography for the left hand
    if (this.reloadT >= 0 && this.holdType !== 'none') {
      const magW = _v[6].set(0, -0.11, this.holdType === 'pistol' ? 0.01 : -0.13).applyQuaternion(Qw).add(wpos);
      const pouch = _v[7].set(-0.05, 0.1, -0.2).applyQuaternion(Q[1]).add(P[1]);
      let tgt = null; let k = 0;
      if (rl < 0.18) { k = smooth(0.0, 0.18, rl); tgt = magW; }
      else if (rl < 0.32) { k = 1; tgt = magW.clone().addScaledVector(_v[3].set(0, -1, 0).applyQuaternion(Qw), 0.1 * smooth(0.18, 0.32, rl)); }
      else if (rl < 0.5) { k = 1; tgt = magW.clone().lerp(pouch, Math.sin(smooth(0.32, 0.5, rl) * Math.PI) * 0.9); }
      else if (rl < 0.66) { k = 1; tgt = magW.clone().addScaledVector(_v[3].set(0, -1, 0).applyQuaternion(Qw), 0.06 * (1 - smooth(0.5, 0.64, rl))); }
      else if (rl < 0.82 && this.holdType === 'rifle') { k = 1; tgt = _v[3].set(-0.03, 0.04, -0.12).applyQuaternion(Qw).add(wpos).clone(); }
      else { k = 1 - smooth(0.66, 0.95, rl); tgt = magW; }
      if (tgt) {
        wristL.lerp(tgt.clone().sub(_v[3].copy(PALM_LOCAL.L).applyQuaternion(qhL)), k);
        qEuler(0.6 * k, 0, -0.8 * k, _q[4]); qhL.multiply(_q[4]);
      }
    }
    // kneel: defuse hands on the ground
    if (this.kneel > 0.01 && this.defusing) {
      const k = this.kneel; const f = Math.sin(t * 7) * 0.02;
      wristR.lerp(_v[6].set(0.1 + f, 0.17, -0.36), k); wristL.lerp(_v[7].set(-0.08, 0.18 - f, -0.37), k);
      qEuler(-1.2, 0.4, 0, _q[4]); qhR.slerp(_q[4], k); qEuler(-1.2, -0.4, 0, _q[4]); qhL.slerp(_q[4], k);
      this._armIK(SIDES.R, wristR, qhR, _v[3].set(1, -0.3, 0.2));
    }
    // long weapons: protract the left shoulder further if the support hand is out of reach
    { const S = SIDES.L; const dd = wristL.distanceTo(P[S.uarm]); const over = dd - (LU + LF) * 0.97;
      if (over > 0) { qEuler(0, Math.min(0.5, over * 3.2), 0, _q[4]); Q[S.clav].multiply(_q[4]); this._chainPos(S.uarm); } }
    this._armIK(SIDES.L, wristL, qhL, _v[3].set(...(H.elbowL || [-1, -1, 0.3])).applyQuaternion(qAim));
  }

  _armIK(S, target, qHand, pole) {
    const P = this.P, Q = this.Q;
    const sh = P[S.uarm];
    const d = _v[6].copy(target).sub(sh); let dist = d.length();
    const maxR = (LU + LF) * 0.999, minR = Math.abs(LU - LF) + 0.02;
    dist = clamp(dist, minR, maxR); d.normalize();
    const n = perpTo(pole, d, _v[7]) || perpTo(Z_AX, d, _v[7]);
    const a = (LU * LU - LF * LF + dist * dist) / (2 * dist); const h = Math.sqrt(Math.max(0, LU * LU - a * a));
    const elbow = this._elb || (this._elb = new V3());
    elbow.copy(sh).addScaledVector(d, a).addScaledVector(n, h);
    const yU = _t1.copy(elbow).sub(sh).normalize();
    const xU = perpTo(n, yU, _t2) || perpTo(Z_AX, yU, _t2);
    basisQuat(xU, yU, Q[S.uarm]).multiply(Q0INV[S.uarm]);
    this._chainPos(S.farm);
    const tgt = _t3.copy(sh).addScaledVector(d, dist);
    const yF = _t1.copy(tgt).sub(P[S.farm]).normalize();
    const xF = perpTo(n, yF, _t2) || perpTo(Z_AX, yF, _t2);
    basisQuat(xF, yF, Q[S.farm]).multiply(Q0INV[S.farm]);
    // forearm twist: take half of hand twist
    const rel = _q[4].copy(Q[S.farm]).invert().multiply(qHand);
    const ax = armDir(S.s); const dot = rel.x * ax.x + rel.y * ax.y + rel.z * ax.z;
    const tw = _q[2].set(ax.x * dot, ax.y * dot, ax.z * dot, rel.w); const tl = Math.hypot(tw.x, tw.y, tw.z, tw.w);
    if (tl > 1e-6) { tw.x /= tl; tw.y /= tl; tw.z /= tl; tw.w /= tl; Q[S.farm].multiply(_q[4].identity().slerp(tw, 0.5)); }
    this._chainPos(S.hand);
    Q[S.hand].copy(qHand);
  }

  _legIK(S, ankleT, pole, footYaw, footPitch) {
    const P = this.P, Q = this.Q;
    const hip = P[S.thigh];
    const d = _v[6].copy(ankleT).sub(hip); let dist = d.length();
    dist = clamp(dist, 0.2, (LT + LS) * 0.9995); d.normalize();
    const n = perpTo(pole, d, _v[7]) || perpTo(_t0.set(0, 0, -1), d, _v[7]);
    const a = (LT * LT - LS * LS + dist * dist) / (2 * dist); const h = Math.sqrt(Math.max(0, LT * LT - a * a));
    const knee = _t3.copy(hip).addScaledVector(d, a).addScaledVector(n, h);
    const yT = _t1.copy(knee).sub(hip).normalize();
    const xT = perpTo(n, yT, _t2) || perpTo(_t0.set(0, 0, -1), yT, _t2);
    basisQuat(xT, yT, Q[S.thigh]).multiply(Q0INV[S.thigh]);
    this._chainPos(S.shin);
    const tgt = _t3.copy(hip).addScaledVector(d, dist);
    const yS = _t1.copy(tgt).sub(P[S.shin]).normalize();
    const xS = perpTo(n, yS, _t2) || perpTo(_t0.set(0, 0, -1), yS, _t2);
    basisQuat(xS, yS, Q[S.shin]).multiply(Q0INV[S.shin]);
    this._chainPos(S.foot);
    qEuler(footPitch, footYaw, 0, Q[S.foot]);
  }

  _writeBones() {
    const P = this.P, Q = this.Q;
    for (let i = 0; i < NB; i++) {
      const b = this.bones[i];
      if (PARENT[i] < 0) { b.position.copy(P[0]); b.quaternion.copy(Q[0]); }
      else { b.quaternion.copy(Q[PARENT[i]]).invert().multiply(Q[i]); b.position.copy(OFF[i]); }
    }
  }

  // -------------------------------------------------------------------------------- death / ragdoll
  die(dir, headshot) {
    if (this.dead) return;
    this.dead = true; this.reloadT = -1; this.throwT = -1; this.planting = this.defusing = false;
    if (this.weapon && this.weapon.parent && this.dropWeaponOnDeath !== false) this.weapon.parent.remove(this.weapon);
    const P = this.P, Q = this.Q;
    const pts = [];
    const add = (v, r) => { pts.push({ p: v.clone(), o: v.clone(), r }); };
    const headC = _v[0].set(0, 0.092, -0.012).applyQuaternion(Q[B.head]).add(P[B.head]);
    add(P[0], 0.12); add(P[B.neck], 0.11); add(headC, 0.105);
    add(P[B.uarmL], 0.075); add(P[B.uarmR], 0.075); add(P[B.farmL], 0.05); add(P[B.farmR], 0.05);
    add(_v[1].copy(armDir(-1)).multiplyScalar(0.06).applyQuaternion(Q[B.handL]).add(P[B.handL]), 0.04);
    add(_v[1].copy(armDir(1)).multiplyScalar(0.06).applyQuaternion(Q[B.handR]).add(P[B.handR]), 0.04);
    add(P[B.thighL], 0.1); add(P[B.thighR], 0.1); add(P[B.shinL], 0.065); add(P[B.shinR], 0.065);
    add(P[B.footL], 0.06); add(P[B.footR], 0.06);
    add(_v[1].set(...mx(TOE)).sub(BIND[B.footL]).applyQuaternion(Q[B.footL]).add(P[B.footL]), 0.03);
    add(_v[1].set(...TOE).sub(BIND[B.footR]).applyQuaternion(Q[B.footR]).add(P[B.footR]), 0.03);
    add(P[B.chest], 0.15);
    // initial velocity: body motion + impulse (dir world -> body local)
    const dl = _v[2].copy(dir || _v[3].set(0, 0, 1)); dl.y = 0;
    if (dl.lengthSq() < 1e-6) dl.set(0, 0, 1); dl.normalize();
    const cy = Math.cos(-this.feetYaw), sy = Math.sin(-this.feetYaw);
    const lx = dl.x * cy + dl.z * sy, lz = -dl.x * sy + dl.z * cy; dl.set(lx, 0, lz);
    const rnd = (k) => hash1(this.seed * 97 + k) * 2 - 1;
    const base = _v[4].copy(this.lv).multiplyScalar(0.8);
    const dt = 1 / 120;
    const imp = headshot ? { 2: 2.6, 1: 1.0, 17: 0.5 } : { 1: 2.0, 17: 2.2, 0: 1.1, 3: 1.2, 4: 1.2, 2: 1.2 };
    pts.forEach((q, i) => {
      const v = base.clone().addScaledVector(dl, (imp[i] || 0.25) * (1 + 0.25 * rnd(i)));
      v.x += 0.25 * rnd(i + 30); v.z += 0.25 * rnd(i + 60);
      if (headshot && (i === 11 || i === 12)) v.add(_v[5].set(0, -0.2, -0.9)); // knees buckle forward
      if (headshot && i === 0) v.y -= 0.8;
      q.o.addScaledVector(v, -dt);
    });
    const C = [];
    const st = (a, b, k = 1, mode = 0) => C.push([a, b, pts[a].p.distanceTo(pts[b].p), k, mode]);
    // torso
    st(0, 17); st(17, 1); st(0, 9); st(0, 10); st(9, 10); st(1, 3); st(1, 4); st(3, 4);
    st(17, 3, 0.8); st(17, 4, 0.8); st(17, 9, 0.8); st(17, 10, 0.8);
    st(3, 9, 0.35); st(4, 10, 0.35); st(3, 10, 0.35); st(4, 9, 0.35); st(1, 0, 1, 1);
    // head
    st(1, 2); st(3, 2, headshot ? 0.12 : 0.45); st(4, 2, headshot ? 0.12 : 0.45); st(17, 2, 1, 1);
    // arms
    st(3, 5); st(5, 7); st(4, 6); st(6, 8); st(3, 7, 1, 2); st(4, 8, 1, 2);
    // legs
    st(9, 11); st(11, 13); st(10, 12); st(12, 14); st(13, 15); st(14, 16); st(11, 15, 0.7); st(12, 16, 0.7);
    st(9, 13, 1, 3); st(10, 14, 1, 3);
    this.rag = { pts, C, t: 0, acc: 0, head: !!headshot, muscle: headshot ? 0 : 1, rest: false };
  }
  _ragStep(dt) {
    const R = this.rag; if (!R || R.rest) return;
    R.acc += dt; const h = 1 / 120;
    let steps = 0;
    while (R.acc >= h && steps < 24) {
      R.acc -= h; steps++; R.t += h;
      const t = R.t;
      const damp = t > 0.65 ? lerp(0.988, 0.86, smooth(0.65, 1.25, t)) : 0.994;
      const muscle = R.head ? 0 : smooth(0.45, 0.0, t);
      for (const q of R.pts) {
        const vx = (q.p.x - q.o.x) * damp, vy = (q.p.y - q.o.y) * damp, vz = (q.p.z - q.o.z) * damp;
        q.o.copy(q.p);
        q.p.x += vx; q.p.y += vy - 13.5 * h * h; q.p.z += vz;
      }
      for (let it = 0; it < 8; it++) {
        for (const c of R.C) {
          const a = R.pts[c[0]].p, b = R.pts[c[1]].p;
          _t0.subVectors(b, a); const d = _t0.length() || 1e-6;
          let rest = c[2], k = c[3];
          if (c[4] === 1 && d > rest * 0.88) continue;        // min distance (spine/head fold)
          if (c[4] === 1) rest *= 0.88;
          if (c[4] === 2) { if (d > 0.22) continue; rest = 0.22; }
          if (c[4] === 3) { // hip-ankle: min 0.32 + muscle keeps legs extended briefly
            const mn = lerp(0.32, rest * 0.97, muscle * 0.75);
            if (d > mn) continue; rest = mn;
          }
          const diff = (d - rest) / d * 0.5 * k;
          a.addScaledVector(_t0, diff); b.addScaledVector(_t0, -diff);
        }
        // knee hinge: knee must be in front of hip-ankle line wrt pelvis forward
        const pl = R.pts[9].p, pr = R.pts[10].p, pc = R.pts[0].p, pu = R.pts[17].p;
        const right = _t1.subVectors(pr, pl).normalize(); const up = _t2.subVectors(pu, pc).normalize();
        const fwd = _t3.crossVectors(up, right).normalize(); // -Z when standing
        for (const [hi, ki, ai] of [[9, 11, 13], [10, 12, 14]]) {
          const H = R.pts[hi].p, K = R.pts[ki].p, A = R.pts[ai].p;
          _v[6].addVectors(H, A).multiplyScalar(0.5);
          const off = _v[7].subVectors(K, _v[6]).dot(fwd);
          if (off < 0.02) { const c = (0.02 - off); K.addScaledVector(fwd, c * 0.7); H.addScaledVector(fwd, -c * 0.15); A.addScaledVector(fwd, -c * 0.15); }
        }
        // elbows bend backwards-ish: keep elbow behind the shoulder-wrist line wrt chest forward
        for (const [si, ei, wi] of [[3, 5, 7], [4, 6, 8]]) {
          const Sh = R.pts[si].p, E = R.pts[ei].p, W = R.pts[wi].p;
          _v[6].addVectors(Sh, W).multiplyScalar(0.5);
          const off = _v[7].subVectors(E, _v[6]).dot(fwd);
          if (off > 0.0) { E.addScaledVector(fwd, -off * 0.5); }
        }
        // ground
        const gy = this.groundY || 0;
        for (const q of R.pts) if (q.p.y < gy + q.r) { q.p.y = gy + q.r; }
      }
      // ground friction
      const gy2 = this.groundY || 0;
      for (const q of R.pts) if (q.p.y <= gy2 + q.r + 0.002) {
        q.o.x = lerp(q.o.x, q.p.x, 0.35); q.o.z = lerp(q.o.z, q.p.z, 0.35);
        if (q.o.y < q.p.y) q.o.y = lerp(q.o.y, q.p.y, 0.5);
      }
    }
    if (R.t > 2.6) R.rest = true;
  }
  _ragApply() {
    const R = this.rag; if (!R) return; const P = this.P, Q = this.Q; const p = (i) => R.pts[i].p;
    const x = _v[0], y = _v[1];
    // hips
    x.subVectors(p(10), p(9)).normalize(); perpTo(_v[2].subVectors(p(17), p(0)), x, y) || y.set(0, 1, 0);
    basisQuat(x, y, Q[0]); P[0].copy(p(0));
    const qh = _q[0].copy(Q[0]);
    x.subVectors(p(4), p(3)).normalize(); perpTo(_v[2].subVectors(p(1), p(17)), x, y) || y.set(0, 1, 0);
    const qc = basisQuat(x, y, _q[1]);
    Q[1].slerpQuaternions(qh, qc, 0.5); this._chainPos(1);
    Q[2].copy(qc); this._chainPos(2);
    perpTo(_v[2].subVectors(p(2), p(1)), x, y) || y.set(0, 1, 0);
    const qhd = basisQuat(x, y, _q[2]);
    Q[3].slerpQuaternions(qc, qhd, 0.5); this._chainPos(3); Q[4].copy(qhd); this._chainPos(4);
    for (const sd of ['L', 'R']) {
      const S = SIDES[sd]; const o = sd === 'L' ? 0 : 1;
      Q[S.clav].copy(Q[2]); this._chainPos(S.clav); this._chainPos(S.uarm);
      const sh = p(3 + o), el = p(5 + o), wr = p(7 + o);
      const back = _v[3].set(0, 0, 1).applyQuaternion(qc);
      const mid = _v[4].addVectors(sh, wr).multiplyScalar(0.5); const nn = _v[5].subVectors(el, mid);
      const n = nn.lengthSq() > 1e-6 ? nn : back;
      let yy = _t1.subVectors(el, sh).normalize(); let xx = perpTo(n, yy, _t2) || perpTo(back, yy, _t2);
      basisQuat(xx, yy, Q[S.uarm]).multiply(Q0INV[S.uarm]); this._chainPos(S.farm);
      yy = _t1.subVectors(wr, el).normalize(); xx = perpTo(n, yy, _t2) || perpTo(back, yy, _t2);
      basisQuat(xx, yy, Q[S.farm]).multiply(Q0INV[S.farm]); this._chainPos(S.hand);
      Q[S.hand].copy(Q[S.farm]);
      // legs
      this._chainPos(S.thigh);
      const hp = p(9 + o), kn = p(11 + o), an = p(13 + o), toe = p(15 + o);
      const fwd = _v[3].set(0, 0, -1).applyQuaternion(qh);
      const m2 = _v[4].addVectors(hp, an).multiplyScalar(0.5); const n2 = _v[5].subVectors(kn, m2);
      const nl = n2.lengthSq() > 1e-6 ? n2 : fwd;
      yy = _t1.subVectors(kn, hp).normalize(); xx = perpTo(nl, yy, _t2) || perpTo(fwd, yy, _t2);
      basisQuat(xx, yy, Q[S.thigh]).multiply(Q0INV[S.thigh]); this._chainPos(S.shin);
      yy = _t1.subVectors(an, kn).normalize(); xx = perpTo(nl, yy, _t2) || perpTo(fwd, yy, _t2);
      basisQuat(xx, yy, Q[S.shin]).multiply(Q0INV[S.shin]); this._chainPos(S.foot);
      // foot: map bind toe dir onto current toe dir
      const fd0 = _v[6].set(...(sd === 'L' ? mx(TOE) : TOE)).sub(BIND[S.foot]).normalize();
      const fd1 = _v[7].subVectors(toe, an).normalize();
      const lat1 = _v[2].set(1, 0, 0).applyQuaternion(Q[S.shin]);
      const xa = perpTo(X_AX, fd0, _v[3]), xb = perpTo(lat1, fd1, _v[4]);
      if (xa && xb) { const qa = basisQuat(xa, fd0, _q[3]); const qb = basisQuat(xb, fd1, _q[4]); Q[S.foot].copy(qb.multiply(qa.invert())); }
    }
  }

  // -------------------------------------------------------------------------------- hitboxes
  _initHitboxes() {
    const H = (group, type, bA, la, bB, lb, r) => ({ group, type, a: new V3(), b: new V3(), r: 0, _d: [bA, new V3(...la), bB, new V3(...lb), r] });
    const ad = (s, l) => armDir(s).multiplyScalar(l).toArray();
    this.hb = [
      H('head', 'sphere', B.head, [0, 0.094, -0.012], B.head, [0, 0.094, -0.012], 0.108),
      H('chest', 'capsule', B.chest, [0, 0.0, 0.0], B.chest, [0, 0.165, 0.0], 0.165),
      H('stomach', 'capsule', B.hips, [0, -0.04, 0.0], B.spine, [0, 0.1, 0.0], 0.155),
      H('arm', 'capsule', B.uarmL, [0, 0, 0], B.farmL, [0, 0, 0], 0.058),
      H('arm', 'capsule', B.uarmR, [0, 0, 0], B.farmR, [0, 0, 0], 0.058),
      H('arm', 'capsule', B.farmL, [0, 0, 0], B.handL, ad(-1, 0.07), 0.048),
      H('arm', 'capsule', B.farmR, [0, 0, 0], B.handR, ad(1, 0.07), 0.048),
      H('leg', 'capsule', B.thighL, [0, 0, 0], B.shinL, [0, 0, 0], 0.088),
      H('leg', 'capsule', B.thighR, [0, 0, 0], B.shinR, [0, 0, 0], 0.088),
      H('leg', 'capsule', B.shinL, [0, 0, 0], B.footL, [0, -0.02, -0.03], 0.065),
      H('leg', 'capsule', B.shinR, [0, 0, 0], B.footR, [0, -0.02, -0.03], 0.065),
    ];
  }
  getHitboxes(out = []) {
    this.root.updateWorldMatrix(true, false);
    this.body.updateMatrix();
    const M = _m3.multiplyMatrices(this.root.matrixWorld, this.body.matrix);
    const sc = _t3.setFromMatrixScale(this.root.matrixWorld).x;
    out.length = 0;
    for (const h of this.hb) {
      const d = h._d;
      h.a.copy(d[1]).applyQuaternion(this.Q[d[0]]).add(this.P[d[0]]).applyMatrix4(M);
      h.b.copy(d[3]).applyQuaternion(this.Q[d[2]]).add(this.P[d[2]]).applyMatrix4(M);
      h.r = d[4] * sc;
      out.push(h);
    }
    return out;
  }
}

export function createCharacter(team, variant = 0) {
  team = team === 't' ? 't' : 'ct';
  variant = ((variant | 0) % 5 + 5) % 5;
  return new Character(team, variant);
}
export const CHARACTER_INFO = { bones: BONE_DEF.map((d) => d[0]), variants: { ct: 5, t: 5 }, height: 1.83 };
