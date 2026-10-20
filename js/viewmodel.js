// viewmodel.js — CS2-style first-person view model: procedural gloved hands/arms, weapon framing,
// procedural sway/bob, and keyframed actions (draw, fire, reload, inspect, knife, grenade, C4, bolt cycling).
// Built in meters; rendered by the engine in its own scene/camera over the world (depth cleared).
import * as THREE from 'three';
import { createWeaponModel, MAT, getWeaponTexture, preloadWeaponAssets } from './weapon_models.js';
import { WEAPONS } from './weapon_data.js';

const D2R = Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const ease = {
  lin: (t) => t,
  io: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  in2: (t) => t * t,
  out2: (t) => 1 - (1 - t) * (1 - t),
  s: smooth,
  back: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outBounce: (t) => { const s = 1 - t; return 1 - s * s * (1 + 2.2 * t * Math.sin(t * 9) * 0.2); },
};
// keyframe sampler: keys [[t, v(number|array), easeName?], ...] ; ease applies to segment ending at that key
function kf(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const a = keys[i - 1], b = keys[i];
      const u = (ease[b[2] || 'io'])((t - a[0]) / Math.max(1e-6, b[0] - a[0]));
      if (Array.isArray(a[1])) return a[1].map((x, k) => x + (b[1][k] - x) * u);
      return a[1] + (b[1] - a[1]) * u;
    }
  }
  return keys[keys.length - 1][1];
}

// =====================================================================================================
// Geometry helpers (local copies, minimal)
// =====================================================================================================
function latheY(pts, seg = 16) {
  // pts [[r, y], ...] bottom->top. smooth normals. returns BufferGeometry around +Y
  const g = new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(Math.max(p[0], 1e-5), p[1])), seg);
  g.deleteAttribute('uv');
  return g;
}
function capsuleSeg(len, r0, r1, seg = 10, rings = 3) {
  // tapered capsule along +Y from 0..len, hemispherical-ish caps of radius r0 (bottom) and r1 (top)
  const pts = [];
  for (let i = 0; i <= rings; i++) { const a = -Math.PI / 2 + (Math.PI / 2) * i / rings; pts.push([r0 * Math.cos(a), r0 * Math.sin(a) * 0.9]); }
  for (let i = 1; i <= 3; i++) { const t = i / 4; pts.push([lerp(r0, r1, t), len * t]); }
  for (let i = 0; i <= rings; i++) { const a = (Math.PI / 2) * i / rings; pts.push([r1 * Math.cos(a), len + r1 * Math.sin(a) * 0.9]); }
  return latheY(pts, seg);
}
function ellipsoid(rx, ry, rz, seg = 12) { seg = Math.min(seg, 12); const g = new THREE.SphereGeometry(1, seg, Math.max(6, seg * 0.6 | 0)); g.deleteAttribute('uv'); g.scale(rx, ry, rz); return g; }
function rboxG(w, h, d, r, seg = 2) {
  const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1); // replaced by rounded version below
  return roundedBox(w, h, d, r, seg);
}
function roundedBox(w, h, d, r, seg = 2) {
  // superellipsoid-ish rounded box via spherical mapping of a subdivided cube
  const n = 2 + Math.min(seg, 1) * 2;
  const g = new THREE.BoxGeometry(1, 1, 1, n, n, n);
  const p = g.attributes.position, v = new THREE.Vector3();
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const cx = clamp(v.x * w, -hx, hx), cy = clamp(v.y * h, -hy, hy), cz = clamp(v.z * d, -hz, hz);
    const dx = v.x * w - cx, dy = v.y * h - cy, dz = v.z * d - cz;
    const l = Math.hypot(dx, dy, dz) || 1;
    p.setXYZ(i, cx + dx / l * r, cy + dy / l * r, cz + dz / l * r);
  }
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const merged = mergeVerts(g);
  merged.computeVertexNormals();
  return merged;
}
function mergeVerts(g) {
  // weld identical positions (BoxGeometry faces are separate)
  const p = g.attributes.position, idx = g.index.array, map = new Map(), np = [], remap = new Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const k = Math.round(p.getX(i) * 1e6) + ',' + Math.round(p.getY(i) * 1e6) + ',' + Math.round(p.getZ(i) * 1e6);
    if (!map.has(k)) { map.set(k, np.length / 3); np.push(p.getX(i), p.getY(i), p.getZ(i)); }
    remap[i] = map.get(k);
  }
  const ni = []; for (let i = 0; i < idx.length; i += 3) { const a = remap[idx[i]], b = remap[idx[i + 1]], c = remap[idx[i + 2]]; if (a !== b && b !== c && a !== c) ni.push(a, b, c); }
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.Float32BufferAttribute(np, 3)); out.setIndex(ni);
  return out;
}
function addWear(g, w = 0.3, seed = Math.random() * 10) {
  const n = g.attributes.position.count, a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = typeof w === 'function' ? w(g.attributes.position.getX(i), g.attributes.position.getY(i), g.attributes.position.getZ(i)) : w; a[i * 2 + 1] = seed; }
  g.setAttribute('aWear', new THREE.BufferAttribute(a, 2));
  if (!g.index) { const ix = []; for (let i = 0; i < n; i++) ix.push(i); g.setIndex(ix); }
  return g;
}
function mesh(g, mat, w = 0.3) { addWear(g, w); const m = new THREE.Mesh(g, typeof mat === 'string' ? MAT[mat] : mat); m.castShadow = true; m.receiveShadow = true; return m; }

// =====================================================================================================
// Hand rig
// =====================================================================================================
// Hand frame: origin at wrist joint, +Y toward fingers, +Z palm normal, +X toward thumb (right hand).
const FINGERS = [
  // name, mcp position, segment lengths, radii (base, tip), spread(deg)
  { n: 'index', p: [0.0285, 0.090, -0.001], L: [0.043, 0.026, 0.021], r: [0.0098, 0.0080], s: -4 },
  { n: 'middle', p: [0.0090, 0.094, -0.0015], L: [0.047, 0.029, 0.022], r: [0.0101, 0.0082], s: 0 },
  { n: 'ring', p: [-0.0105, 0.090, -0.001], L: [0.044, 0.027, 0.021], r: [0.0096, 0.0078], s: 4 },
  { n: 'pinky', p: [-0.0285, 0.081, 0.0], L: [0.035, 0.021, 0.019], r: [0.0086, 0.0071], s: 9 },
];
const THUMB = { p: [0.015, 0.016, 0.008], L: [0.038, 0.030, 0.025], r: [0.0135, 0.0092] };

function teamStyle(team) {
  return team === 't'
    ? { glove: 'gloveT', glove2: 'gloveT2', fingerless: true, sleeve: 'fabricT', cuff: 'fabricT2', pad: 'gloveT2', watch: true, tape: true }
    : { glove: 'gloveCT', glove2: 'gloveCT2', fingerless: false, sleeve: 'fabricCT', cuff: 'fabricCT2', pad: 'rubber', watch: false, tape: false };
}

function buildHand(team, isLeft) {
  const st = teamStyle(team);
  const root = new THREE.Group(); root.name = 'hand';
  const hand = { root, fingers: [], thumb: null, team };
  const G = st.glove, G2 = st.glove2;
  // ---- palm (loft of ellipses along Y), knuckle line arc
  {
    const secs = [
      [-0.012, 0.052, 0.029, 0.000], [0.000, 0.056, 0.030, 0.001], [0.025, 0.068, 0.033, 0.002], [0.050, 0.079, 0.032, 0.002],
      [0.075, 0.083, 0.030, 0.0015], [0.090, 0.082, 0.027, 0.002], [0.101, 0.077, 0.022, 0.003], [0.106, 0.068, 0.014, 0.004],
    ];
    const M = 22, pos = [], idx = [];
    for (let i = 0; i < secs.length; i++) {
      const [y, w, d, zc] = secs[i];
      for (let j = 0; j < M; j++) {
        const a = j / M * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        // superellipse-ish cross-section (flatter back, rounder palm side)
        const ex = 2.6, sx = Math.sign(c) * Math.pow(Math.abs(c), 2 / ex), sz = Math.sign(s) * Math.pow(Math.abs(s), 2 / ex);
        let x = sx * w / 2, z = sz * d / 2 * (s > 0 ? 1.05 : 0.95) + zc;
        // knuckle arc: shorten toward pinky side at the distal end
        let yy = y;
        if (y > 0.07) { const k = (y - 0.07) / 0.03; yy = 0.07 + (y - 0.07) * (1 - 0.32 * clamp((-x + 0.012) / 0.03, 0, 1.3)) - k * 0.004 * Math.max(0, x / 0.03) * 0; }
        pos.push(x, yy, z);
      }
    }
    for (let i = 0; i < secs.length - 1; i++) for (let j = 0; j < M; j++) {
      const a = i * M + j, b = i * M + (j + 1) % M, c = (i + 1) * M + (j + 1) % M, d = (i + 1) * M + j;
      idx.push(a, d, c, a, c, b);
    }
    // caps
    const base = pos.length / 3; pos.push(0, secs[0][0] - 0.004, secs[0][3]);
    for (let j = 0; j < M; j++) idx.push(base, j, (j + 1) % M);
    const top = pos.length / 3; const L = secs.length - 1; pos.push(-0.002, secs[L][0] + 0.004, secs[L][3]);
    for (let j = 0; j < M; j++) idx.push(top, L * M + (j + 1) % M, L * M + j);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    fixOutward(g, new THREE.Vector3(0, 0.045, 0));
    root.add(mesh(g, G, 0.35));
    // thenar & hypothenar pads
    { const m = mesh(ellipsoid(0.021, 0.036, 0.015, 18), G, 0.4); m.position.set(0.017, 0.036, 0.008); m.rotation.z = -0.35; root.add(m); }
    { const m = mesh(ellipsoid(0.013, 0.030, 0.010, 16), G, 0.4); m.position.set(-0.024, 0.040, 0.008); root.add(m); }
    // palm reinforcement patch (second material)
    const pp = mesh(ellipsoid(0.027, 0.030, 0.004, 18), G2, 0.6); pp.position.set(-0.004, 0.052, 0.0148); root.add(pp);
    // knuckle guard / back padding
    for (const F of FINGERS) { const kb = mesh(ellipsoid(F.r[0] * 1.05, F.r[0] * 1.15, F.r[0] * 0.9, 14), G, 0.6); kb.position.set(F.p[0], F.p[1] - 0.002, F.p[2] - 0.003); root.add(kb); }
    if (team === 'ct') {
      // molded hard-knuckle guard: a row of linked rounded pads following the knuckle arc
      for (let i = 0; i < 4; i++) {
        const F = FINGERS[i];
        const kg = mesh(roundedBox(0.019, 0.017, 0.008, 0.0036, 2), st.pad, 0.6);
        kg.position.set(F.p[0], F.p[1] - 0.001, -0.0175); kg.rotation.set(-0.15, 0, F.s * D2R * 0.6 + (F.p[0] > 0 ? -0.05 : 0.08)); root.add(kg);
      }
      const kgb = mesh(roundedBox(0.068, 0.007, 0.006, 0.0028, 2), st.pad, 0.5); kgb.position.set(0.0, 0.074, -0.0165); kgb.rotation.z = 0.05; root.add(kgb);
      for (let i = 0; i < 3; i++) { const rb = mesh(roundedBox(0.050 - i * 0.004, 0.0065, 0.004, 0.0019, 2), G2, 0.5); rb.position.set(0.002, 0.030 + i * 0.013, -0.0158 + i * 0.0003); root.add(rb); }
      // seams on back
      for (const x of [-0.026, 0.030]) { const sm = mesh(new THREE.CylinderGeometry(0.0007, 0.0007, 0.07, 6), G2, 0.2); sm.position.set(x, 0.048, -0.0158 + (x > 0 ? 0 : 0.002)); root.add(sm); }
    } else {
      // leather back with a strap
      // wrist strap with a small buckle, stitched seam lines on the back
      const ws = mesh(roundedBox(0.050, 0.013, 0.004, 0.0018, 2), G2, 0.6); ws.position.set(0.004, 0.010, -0.0158); root.add(ws);
      const bk = mesh(roundedBox(0.010, 0.012, 0.003, 0.0012, 1), 'steel', 0.6); bk.position.set(0.022, 0.010, -0.0172); root.add(bk);
      for (const x of [-0.022, 0.026]) { const sm = mesh(new THREE.CylinderGeometry(0.0006, 0.0006, 0.06, 5), G2, 0.2); sm.position.set(x, 0.052, -0.0152); root.add(sm); }
    }
    // wrist blend (the glove cuff itself lives on the forearm so it follows the arm when the wrist bends)
    { const wb = mesh(ellipsoid(0.0275, 0.026, 0.0185, 18), G, 0.4); wb.position.set(0.0, -0.004, 0.0); root.add(wb); }
  }
  // ---- fingers
  for (const F of FINGERS) {
    const j1 = new THREE.Group(); j1.position.set(...F.p); j1.rotation.order = 'ZXY'; j1.rotation.z = F.s * D2R;
    root.add(j1);
    const joints = [j1];
    let parent = j1;
    const rr = [F.r[0], lerp(F.r[0], F.r[1], 0.45), lerp(F.r[0], F.r[1], 0.8), F.r[1]];
    for (let k = 0; k < 3; k++) {
      const L = F.L[k];
      const skin = st.fingerless && k >= 1;
      const segG = capsuleSeg(L, rr[k], rr[k + 1], 11, 3);
      // slightly flattened, fuller on the pad (palm) side
      segG.scale(1.04, 1, 0.9); segG.translate(0, 0, rr[k] * 0.06);
      const sm = mesh(segG, skin ? 'skin' : G, k === 0 ? 0.5 : 0.35);
      parent.add(sm);
      if (!skin && team === 'ct' && k === 0) { const pad = mesh(roundedBox(rr[0] * 1.5, L * 0.6, 0.005, 0.0022, 1), st.pad, 0.6); pad.position.set(0, L * 0.5, -rr[0] * 0.92); parent.add(pad); }
      if (!skin && k < 2) for (const sx of [-1, 1]) { const seam = mesh(new THREE.CylinderGeometry(0.00055, 0.00055, L * 0.95, 5), G2, 0.2); seam.position.set(sx * rr[k] * 0.97, L * 0.5, 0.0); parent.add(seam); }
      if (st.fingerless && k === 0) { // rolled cut edge
        const ring = mesh(new THREE.TorusGeometry(rr[1] * 1.02, 0.0016, 4, 12), G, 0.6); ring.position.set(0, L, 0); ring.rotation.x = Math.PI / 2; parent.add(ring);
      }
      if (skin && k === 2) { // nail
        const nail = mesh(ellipsoid(rr[3] * 0.68, L * 0.36, 0.0018, 12), MAT.skin, 0.1);
        nail.position.set(0, L * 0.62, -rr[3] * 0.8); parent.add(nail);
      }
      if (st.tape && F.n === 'middle' && k === 0) { const tp = mesh(latheY([[rr[0] * 1.06, L * 0.25], [rr[0] * 1.07, L * 0.45]], 14), 'tapeTan', 0.6); parent.add(tp); }
      if (k < 2) { const nj = new THREE.Group(); nj.position.set(0, L, 0); parent.add(nj); joints.push(nj); parent = nj; }
    }
    hand.fingers.push({ name: F.n, joints, L: F.L, r: rr, def: F });
  }
  // ---- thumb
  {
    const T = THUMB;
    const base = new THREE.Group(); base.position.set(...T.p); root.add(base);
    // two base orientations: 'rest' (thumb alongside, pointing up/out radially, pad toward fingers)
    // and 'opposed' (thumb crossing to the palm side, pad facing forward; flexion wraps it around a grip)
    const frame = (y, zr) => { const yAx = new THREE.Vector3(...y).normalize(); const zRef = new THREE.Vector3(...zr).normalize();
      const xAx = new THREE.Vector3().crossVectors(yAx, zRef).normalize(); const zAx = new THREE.Vector3().crossVectors(xAx, yAx).normalize();
      return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAx, yAx, zAx)); };
    const qRest = frame([0.50, 0.80, 0.33], [-0.55, 0.05, 0.83]);
    const qOpp = frame([0.22, 0.30, 0.93], [-0.15, 0.95, -0.25]);
    base.quaternion.copy(qRest);
    const j1 = new THREE.Group(); j1.rotation.order = 'ZXY'; base.add(j1);
    const joints = [j1]; let parent = j1;
    const rr = [T.r[0] * 1.15, T.r[0], lerp(T.r[0], T.r[1], 0.6), T.r[1]];
    for (let k = 0; k < 3; k++) {
      const L = T.L[k];
      const skin = st.fingerless && k === 2;
      const g = capsuleSeg(L, rr[k], rr[k + 1], 11, 3); g.scale(1.05, 1, 0.9);
      parent.add(mesh(g, skin ? 'skin' : G, 0.45));
      if (st.fingerless && k === 1) { const ring = mesh(new THREE.TorusGeometry(rr[2] * 1.03, 0.0017, 4, 12), G, 0.6); ring.position.set(0, L, 0); ring.rotation.x = Math.PI / 2; parent.add(ring); }
      if (skin) { const nail = mesh(ellipsoid(rr[3] * 0.72, L * 0.34, 0.002, 12), MAT.skin, 0.1); nail.position.set(0, L * 0.6, -rr[3] * 0.82); parent.add(nail); }
      if (!skin && k >= 1) for (const sx of [-1, 1]) { const seam = mesh(new THREE.CylinderGeometry(0.00055, 0.00055, L * 0.9, 5), G2, 0.2); seam.position.set(sx * rr[k] * 1.0, L * 0.5, 0); parent.add(seam); }
      if (k < 2) { const nj = new THREE.Group(); nj.position.set(0, L, 0); parent.add(nj); joints.push(nj); parent = nj; }
    }
    hand.thumb = { base, joints, L: T.L, r: rr, qRest, qOpp };
  }
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return hand;
}
function fixOutward(g, center) {
  const p = g.attributes.position, n = g.attributes.normal; let flip = 0, tot = 0; const v = new THREE.Vector3(), nn = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 7) { v.fromBufferAttribute(p, i).sub(center); nn.fromBufferAttribute(n, i); flip += v.dot(nn) < 0 ? 1 : 0; tot++; }
  if (flip > tot / 2) { const idx = g.index.array; for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } g.computeVertexNormals(); }
}

// ---- finger poses: { f: [[mcp,pip,dip,spread]...4], t: [cmcX, cmcZ, mcp, ip] } (degrees)
const POSE = {
  relaxed: { f: [[20, 25, 12, -4], [24, 28, 14, 0], [28, 30, 15, 4], [32, 32, 16, 9]], t: [0.45, 10, 12, 12] },
  open: { f: [[6, 6, 4, -7], [6, 6, 4, 0], [6, 6, 4, 7], [8, 6, 4, 13]], t: [0.0, -8, 0, 0] },
  fist: { f: [[85, 95, 60, -2], [88, 98, 60, 0], [90, 98, 60, 3], [92, 98, 60, 6]], t: [0.8, 20, 35, 40] },
  point: { f: [[10, 10, 5, -2], [85, 95, 60, 0], [88, 98, 60, 3], [90, 98, 60, 6]], t: [0.8, 20, 30, 30] },
  trigger: { f: [[30, 55, 25, -2]] },
  pinch: { f: [[45, 40, 20, -4], [55, 50, 25, 0], [65, 60, 30, 4], [70, 65, 30, 8]], t: [0.7, 15, 20, 20] },
  cup: { f: [[40, 45, 25, -4], [42, 48, 25, 0], [45, 50, 25, 4], [48, 52, 25, 8]], t: [0.45, 10, 15, 15] },
};

function applyPose(hand, pose) {
  hand.fingers.forEach((F, i) => {
    const a = pose.f[i] || pose.f[0];
    F.joints[0].rotation.x = a[0] * D2R; F.joints[1].rotation.x = a[1] * D2R; F.joints[2].rotation.x = a[2] * D2R;
    F.joints[0].rotation.z = (a[3] ?? F.def.s) * D2R;
  });
  if (pose.t) { const t = pose.t, T = hand.thumb; T.base.quaternion.copy(T.qRest).slerp(T.qOpp, clamp(t[0], 0, 1)); T.joints[0].rotation.x = t[1] * D2R; T.joints[1].rotation.x = t[2] * D2R; T.joints[2].rotation.x = t[3] * D2R; }
}
function readPose(hand) {
  return {
    f: hand.fingers.map((F) => [F.joints[0].rotation.x / D2R, F.joints[1].rotation.x / D2R, F.joints[2].rotation.x / D2R, F.joints[0].rotation.z / D2R]),
    t: [hand.thumb.opp ?? 0.25, hand.thumb.joints[0].rotation.x / D2R, hand.thumb.joints[1].rotation.x / D2R, hand.thumb.joints[2].rotation.x / D2R],
  };
}
function blendPose(a, b, k) {
  return {
    f: a.f.map((fa, i) => { const fb = b.f[i] || b.f[0]; return fa.map((x, j) => lerp(x, fb[j] ?? x, k)); }),
    t: a.t.map((x, j) => lerp(x, b.t[j], k)),
  };
}
function fullPose(p) { const base = POSE.relaxed; return { f: [0, 1, 2, 3].map((i) => (p.f && (p.f[i] || (p.f.length === 1 && i === 0 ? p.f[0] : null))) || base.f[i]), t: p.t || base.t }; }

// ---- SDF shapes for the grasp solver: {type:'box', m: Matrix4 (shape->world inverse), half:[x,y,z], r} or sphere/capsule
function sdShape(sh, wp) {
  const p = _sp.copy(wp).applyMatrix4(sh.inv);
  if (sh.type === 'sphere') return p.length() - sh.r;
  if (sh.type === 'capsule') { const y = clamp(p.y, -sh.h, sh.h); return Math.hypot(p.x, p.y - y, p.z) - sh.r; }
  const qx = Math.abs(p.x) - sh.half[0] + sh.r, qy = Math.abs(p.y) - sh.half[1] + sh.r, qz = Math.abs(p.z) - sh.half[2] + sh.r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - sh.r;
}
const _sp = new THREE.Vector3(), _wp = new THREE.Vector3(), _pp = new THREE.Vector3();
function sdScene(shapes, wp) { let d = 1e9; for (const s of shapes) d = Math.min(d, sdShape(s, wp)); return d; }

// Curl each finger joint until its segment touches the shapes. Hand must have up-to-date world matrices.
function graspSolve(hand, shapes, opts = {}) {
  const skip = opts.skip || [];
  const maxA = opts.max || [92, 105, 75];
  const minA = opts.min || [0, 5, 3];
  const chains = hand.fingers.map((F, i) => ({ F, i, joints: F.joints, L: F.L, r: F.r }));
  if (opts.thumb) chains.push({ F: null, i: 4, joints: hand.thumb.joints, L: hand.thumb.L, r: hand.thumb.r, thumb: true });
  for (const c of chains) {
    if (skip.includes(c.i)) continue;
    if (c.thumb) { const T = hand.thumb; T.opp = opts.thumb.opp ?? 0.5; T.base.quaternion.copy(T.qRest).slerp(T.qOpp, T.opp); c.joints[0].rotation.x = (opts.thumb.cmc ?? 0) * D2R; T.base.updateMatrixWorld(true); }
    const pad = (k) => c.r[k + 1] * 0.95 + (opts.pad ?? 0.001);
    for (let k = c.thumb ? 1 : 0; k < 3; k++) {
      const j = c.joints[k];
      const lo = (c.thumb ? [0, 0, 0] : minA)[k] * D2R, hi = (c.thumb ? (opts.thumbMax || [40, 70, 70]) : maxA)[k] * D2R;
      const hits = (ang) => {
        j.rotation.x = ang; j.updateMatrixWorld(true);
        for (const t of [0.35, 0.7, 1.0]) { _pp.set(0, c.L[k] * t, 0).applyMatrix4(j.matrixWorld); if (sdScene(shapes, _pp) < pad(k)) return true; }
        return false;
      };
      let a = lo;
      if (hits(lo)) { j.rotation.x = lo; j.updateMatrixWorld(true); continue; }
      let found = false;
      for (let s = lo; s <= hi; s += 5 * D2R) { if (hits(s)) { let A = s - 5 * D2R, B = s; for (let it = 0; it < 5; it++) { const m = (A + B) / 2; if (hits(m)) B = m; else A = m; } a = A; found = true; break; } }
      if (!found) a = hi;
      j.rotation.x = a; j.updateMatrixWorld(true);
    }
  }
  return readPose(hand);
}

// =====================================================================================================
// Forearm / sleeve
// =====================================================================================================
function buildForearm(team, isLeft) {
  const st = teamStyle(team);
  const root = new THREE.Group(); root.name = 'forearm';
  // forearm runs along +Y from wrist (0) to elbow (0.30). Sleeve with folds.
  const NY = 44, NT = 30, pos = [];
  const rng = mulberry(team === 't' ? 7 : 3);
  const folds = []; for (let i = 0; i < 22; i++) folds.push({ y: 0.03 + rng() * 0.29, a: rng() * Math.PI * 2, w: 0.004 + rng() * 0.007, amp: 0.0012 + rng() * 0.0026, span: 0.35 + rng() * 0.8, tw: (rng() - 0.5) * 40 });
  const y0 = 0.018, y1 = 0.34;
  for (let i = 0; i <= NY; i++) {
    const t = i / NY, y = lerp(y0, y1, t);
    const rx = lerp(0.0375, 0.054, smooth(t)) + (t < 0.08 ? (0.08 - t) * 0.04 : 0), rz = lerp(0.029, 0.048, smooth(t));
    for (let j = 0; j < NT; j++) {
      const a = j / NT * Math.PI * 2;
      let d = 0;
      for (const f of folds) { const aa = a - f.a - (y - f.y) * f.tw; const da = Math.atan2(Math.sin(aa), Math.cos(aa)) / f.span; const dy = (y - f.y - da * f.w * 1.5) / f.w; d += f.amp * Math.exp(-dy * dy * 1.5 - da * da * 1.2) * (1.0 - 0.35 * dy * dy); }
      if (team === 't') { const ry = (y - 0.034) / 0.011; d += 0.0085 * Math.exp(-ry * ry) * (1 + 0.25 * Math.sin(a * 5 + 1.3) + 0.15 * Math.sin(a * 11)); }
      else { d += 0.0010 * Math.sin(a * 3 + y * 45) * Math.exp(-(y - y0) * 20); }
      // bunching rings near cuff
      d += 0.0018 * Math.sin(y * 260 + Math.sin(a * 3) * 0.8) * Math.exp(-(y - y0) * 18);
      d += 0.0006 * Math.sin(a * 5 + y * 40);
      pos.push(Math.cos(a) * (rx + d), y, Math.sin(a) * (rz + d));
    }
  }
  const idx = [];
  for (let i = 0; i < NY; i++) for (let j = 0; j < NT; j++) { const a = i * NT + j, b = i * NT + (j + 1) % NT, c = (i + 1) * NT + (j + 1) % NT, d = (i + 1) * NT + j; idx.push(a, b, c, a, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  fixOutward(g, new THREE.Vector3(0, 0.15, 0));
  root.add(mesh(g, st.sleeve, 0.4));
  // seams along the sleeve + hem stitching + team details
  {
    const ring = (y) => { const t = (y - y0) / (y1 - y0); return [lerp(0.0375, 0.054, smooth(t)), lerp(0.029, 0.048, smooth(t))]; };
    for (const a0 of [Math.PI * 0.62, -Math.PI * 0.35]) {
      const pts = []; for (let i = 0; i <= 8; i++) { const y = lerp(y0 + 0.03, y1 - 0.01, i / 8); const [rx, rz] = ring(y); const a = a0 + Math.sin(y * 20) * 0.03; pts.push(new THREE.Vector3(Math.cos(a) * (rx + 0.0012), y, Math.sin(a) * (rz + 0.0012))); }
      const sg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.0011, 5, false); sg.deleteAttribute('uv');
      root.add(mesh(sg, st.sleeve, 0.5));
    }
    if (team === 'ct') {
      // forearm utility pocket with velcro flap on the outer side
      const pk = mesh(roundedBox(0.034, 0.055, 0.007, 0.0028, 1), st.sleeve, 0.5); pk.position.set(0.0, 0.17, 0.040); root.add(pk);
      const fl = mesh(roundedBox(0.036, 0.016, 0.006, 0.0025, 1), st.cuff, 0.6); fl.position.set(0.0, 0.142, 0.0428); root.add(fl);
    } else {
      // field-repair tape wrapped around the sleeve
      for (const [y, w] of [[0.155, 0.022], [0.205, 0.012]]) { const [rx, rz] = ring(y); const tp = mesh(latheY([[1.0, -w / 2], [1.012, 0], [1.0, w / 2]].map((p) => [p[0], p[1]]), 26), 'tapeTan', 0.7); tp.scale.set(rx + 0.0025, 1, rz + 0.0025); tp.position.y = y; tp.rotation.y = 0.3; root.add(tp); }
    }
  }
  // glove cuff / gauntlet (forearm space)
  {
    const G = st.glove, G2 = st.glove2;
    const cp = [[0.0215, -0.012], [0.0262, -0.006], [0.0292, 0.004], [0.0312, 0.020], [0.0330, 0.040], [0.0338, 0.055], [0.0322, 0.060]];
    const cuff = mesh(latheY(cp, 20), team === 'ct' ? G2 : G, 0.4); cuff.scale.set(1.0, 1, 0.74); root.add(cuff);
    const strap = mesh(roundedBox(0.032, 0.018, 0.006, 0.0025, 2), team === 'ct' ? st.pad : G2, 0.6); strap.position.set(-0.004, 0.030, 0.0245); strap.rotation.x = 0.06; root.add(strap);
    if (team === 'ct') { const pull = mesh(roundedBox(0.010, 0.022, 0.003, 0.0012, 1), 'rubber', 0.5); pull.position.set(0.014, 0.024, 0.0262); root.add(pull); }
    else { const bk = mesh(roundedBox(0.009, 0.014, 0.003, 0.001, 1), 'steel', 0.6); bk.position.set(0.012, 0.030, 0.0275); root.add(bk); }
  }
  // inner lining (dark) so the open sleeve end looks hollow
  const inner = mesh(latheY([[0.0365, y0 - 0.0015], [0.038, y0 + 0.03]], 24), 'dark', 0); inner.scale.set(1, 1, 0.78); root.add(inner);
  inner.material = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 1, side: THREE.BackSide });
  // cuff band
  const cuffPts = []; for (let i = 0; i <= 6; i++) { const t = i / 6; cuffPts.push([0.0385 + Math.sin(t * Math.PI) * 0.0022 - (t < 0.15 ? 0.0015 : 0), y0 - 0.002 + t * 0.026]); }
  const cuff = mesh(latheY(cuffPts, 22), st.cuff, 0.5); cuff.scale.set(1, 1, 0.80); root.add(cuff);
  if (team === 'ct') {
    // velcro cuff tab
    const tab = mesh(roundedBox(0.026, 0.022, 0.004, 0.0018, 2), st.cuff, 0.6); tab.position.set(0.034, 0.03, -0.022); tab.rotation.y = -0.9; root.add(tab);
  } else {
    // rolled sleeve: thick roll ring
    // (rolled cuff is sculpted into the sleeve geometry)
  }
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return root;
}
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function buildWatch() {
  const g = new THREE.Group();
  const caseM = mesh(latheY([[0.0, -0.004], [0.017, -0.004], [0.0185, -0.002], [0.0185, 0.003], [0.016, 0.0045], [0.0, 0.0045]], 28), 'steel', 0.6);
  g.add(caseM);
  const bezel = mesh(new THREE.TorusGeometry(0.0168, 0.0016, 8, 32), 'paintBlk', 0.7); bezel.rotation.x = Math.PI / 2; bezel.position.y = 0.0045; g.add(bezel);
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.0148, 32), new THREE.MeshPhysicalMaterial({ map: watchFace(), roughness: 0.2, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 }));
  face.rotation.x = -Math.PI / 2; face.position.y = 0.0047; g.add(face);
  const strap = mesh(latheY([[0.036, -0.009], [0.036, 0.009]], 32), 'fabricT2', 0.5); strap.scale.set(1, 1, 0.8); strap.rotation.z = Math.PI / 2; strap.position.y = -0.036 * 0.8 + 0.0;
  g.userData.strap = strap;
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
function watchFace() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c = cv.getContext('2d');
  c.fillStyle = '#141614'; c.fillRect(0, 0, 128, 128);
  c.translate(64, 64);
  for (let i = 0; i < 12; i++) { c.save(); c.rotate(i * Math.PI / 6); c.fillStyle = '#c8d4b0'; c.fillRect(-2, -58, 4, i % 3 === 0 ? 14 : 8); c.restore(); }
  c.strokeStyle = '#d8e0c0'; c.lineWidth = 5; c.lineCap = 'round';
  c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.sin(2.1) * 32, -Math.cos(2.1) * 32); c.stroke();
  c.lineWidth = 3.5; c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.sin(5.2) * 48, -Math.cos(5.2) * 48); c.stroke();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// =====================================================================================================
// Arm = hand + forearm, with mirrored (left) support.
// =====================================================================================================
const MX = new THREE.Matrix4().makeScale(-1, 1, 1);
// two-bone IK: elbow position for shoulder S, wrist W, upper arm a, forearm b, pole direction P (all same space)
const _ik = { d: new THREE.Vector3(), p: new THREE.Vector3() };
function solveElbow(S, W, a, b, P, out) {
  const d = _ik.d.subVectors(W, S); let L = d.length();
  if (L < 1e-5) return out.copy(S).add(P);
  d.multiplyScalar(1 / L);
  L = Math.min(L, (a + b) * 0.995); L = Math.max(L, Math.abs(a - b) + 1e-3);
  const x = (a * a - b * b + L * L) / (2 * L), h = Math.sqrt(Math.max(0, a * a - x * x));
  const p = _ik.p.copy(P).addScaledVector(d, -P.dot(d)).normalize();
  return out.copy(S).addScaledVector(d, x).addScaledVector(p, h);
}
class Arm {
  constructor(team, isLeft) {
    this.isLeft = isLeft; this.team = team;
    this.hand = buildHand(team, isLeft);
    this.forearm = buildForearm(team, isLeft);
    this.handRoot = this.hand.root; this.handRoot.matrixAutoUpdate = false;
    this.forearm.matrixAutoUpdate = false;
    this.group = new THREE.Group(); this.group.add(this.handRoot); this.group.add(this.forearm);
    if (team === 't' && isLeft) {
      this.watch = buildWatch();
      this.watch.position.set(0.0, 0.072, 0.0372); this.watch.rotation.x = Math.PI / 2; this.watch.scale.set(1, 1, 1);
      this.forearm.add(this.watch);
      const strapG = latheY([[0.0425, -0.008], [0.0432, 0.0], [0.0425, 0.008]], 32); const strap = mesh(strapG, 'fabricT2', 0.5); strap.position.y = 0.072; strap.scale.set(1, 1, 0.86); this.forearm.add(strap);
    }
    this.pose = fullPose(POSE.relaxed);
    applyPose(this.hand, this.pose);
  }
  // W: rigid hand transform (wrist frame) in "right-handed" space (mirrored space for the left arm), E: elbow position in same space.
  place(W, E) {
    const wrist = _a.setFromMatrixPosition(W);
    const yAx = _b.subVectors(E, wrist).normalize();
    // forearm twist follows the hand: its +Z (back) is the back of the hand (-Z_h) projected off the arm axis
    const zAx = _d.setFromMatrixColumn(W, 2).negate();
    zAx.addScaledVector(yAx, -zAx.dot(yAx));
    if (zAx.lengthSq() < 0.04) { const hx = _c.setFromMatrixColumn(W, 0); zAx.crossVectors(hx, yAx); }
    zAx.normalize();
    const xAx = _e.crossVectors(yAx, zAx).normalize();
    _F.makeBasis(xAx, yAx, zAx).setPosition(wrist);
    // forearm shifted slightly toward the back of the hand so the sleeve centres on the wrist
    if (this.isLeft) { this.handRoot.matrix.multiplyMatrices(MX, W); this.forearm.matrix.multiplyMatrices(MX, _F); }
    else { this.handRoot.matrix.copy(W); this.forearm.matrix.copy(_F); }
    this.handRoot.matrixWorldNeedsUpdate = true; this.forearm.matrixWorldNeedsUpdate = true;
  }
  setPose(p) { this.pose = p; applyPose(this.hand, p); }
}
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3(), _F = new THREE.Matrix4();

export { ACTIONS, buildHand, buildForearm, Arm, POSE, applyPose, graspSolve, fullPose, blendPose, kf, ease };

// =====================================================================================================
// Hold configurations (camera-space framing per hold type; meters, degrees)
// =====================================================================================================
const HOLD = {
  rifle: { pos: [0.190, -0.170, -0.375], rot: [0.0, 13.0, -6.0], elbowR: [0.22, -0.40, 0.02], elbowL: [-0.12, -0.42, -0.12], shR: [0.20, -0.30, 0.10], shL: [-0.02, -0.34, 0.06], poleL: [-0.3, -1.0, 0.2] },
  pistol: { pos: [0.126, -0.100, -0.345], rot: [2.5, 15.0, -4.0], elbowR: [0.17, -0.36, 0.02], elbowL: [-0.06, -0.46, -0.06], shR: [0.17, -0.30, 0.08], shL: [-0.12, -0.32, 0.06], poleL: [-0.8, -1.0, 0.0] },
  knife: { pos: [0.11, -0.14, -0.245], rot: [38, 24, -10], elbowR: [0.26, -0.30, 0.12], elbowL: [-0.22, -0.45, 0.05] },
  grenade: { pos: [0.11, -0.085, -0.27], rot: [8, 12, -10], elbowR: [0.21, -0.36, 0.03], elbowL: [-0.16, -0.42, 0.02] },
  c4: { pos: [0.02, -0.105, -0.37], rot: [44, 0, 0], elbowR: [0.24, -0.38, 0.05], elbowL: [-0.22, -0.38, 0.05] },
};
// per-weapon framing tweaks (added to HOLD)
const FRAME = {
  ak47: {}, galilar: { pos: [0.004, -0.004, -0.035] }, m4a4: { pos: [0.006, 0.0, -0.05] }, m4a1_s: { pos: [0.006, 0.0, -0.05] },
  famas: { pos: [0.010, -0.022, -0.17] }, aug: { pos: [0.004, -0.022, -0.12] }, sg556: { pos: [0.004, -0.016, -0.07] },
  awp: { pos: [0.010, -0.022, -0.10] }, ssg08: { pos: [0.010, -0.020, -0.09] }, g3sg1: { pos: [0.008, -0.020, -0.08] }, scar20: { pos: [0.008, -0.020, -0.08] },
  m249: { pos: [0.010, -0.016, -0.06] }, negev: { pos: [0.010, -0.016, -0.06] },
  mac10: { pos: [-0.045, 0.012, -0.07] }, mp9: { pos: [-0.040, 0.012, -0.07] }, mp7: { pos: [-0.040, 0.010, -0.07] }, mp5sd: { pos: [-0.005, 0.0, -0.02] }, ump45: { pos: [-0.020, 0.004, -0.04] },
  p90: { pos: [-0.04, -0.006, -0.17] }, bizon: { pos: [-0.012, 0.0, -0.03] },
  nova: { pos: [0.004, -0.004, -0.04] }, xm1014: { pos: [0.004, -0.004, -0.04] }, sawedoff: { pos: [-0.02, 0.0, -0.03] }, mag7: { pos: [-0.025, 0.0, -0.04] },
  deagle: { pos: [0.004, -0.004, -0.01] }, revolver: { pos: [0.004, -0.004, -0.01] }, elite: { pos: [-0.01, -0.008, -0.02], rot: [0, -4, -6] }, tec9: { pos: [0.0, 0.0, -0.02] },
  molotov: { pos: [0.01, -0.06, -0.07] }, hegrenade: {},
};

export class ViewModel {
  constructor(renderer, { envMap } = {}) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.environment = envMap || null;
    this.camera = new THREE.PerspectiveCamera(53.7, 16 / 9, 0.01, 10);   // CS2 viewmodel_fov 68 (4:3 horizontal) == 53.7 deg vertical
    this.scene.add(this.camera);
    // lights
    this.sun = new THREE.DirectionalLight(0xfff0dc, 3.0);
    this.sun.castShadow = true; this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera; sc.left = sc.bottom = -0.5; sc.right = sc.top = 0.5; sc.near = 0.05; sc.far = 3;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.003;
    this.scene.add(this.sun); this.scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbcd0f0, 0x8a7458, 0.55); this.scene.add(this.hemi);
    this.flash = new THREE.PointLight(0xffb060, 0, 1.4, 2); this.scene.add(this.flash);
    this.sunDirWorld = new THREE.Vector3(0.42, 0.74, 0.52).normalize();
    this.sunBase = 3.0; this.shadowAmt = 0;
    // rig hierarchy (rig follows camera orientation; everything below is camera-relative)
    this.rig = new THREE.Group(); this.scene.add(this.rig);
    this.swayG = new THREE.Group(); this.rig.add(this.swayG);
    this.gunG = new THREE.Group(); this.swayG.add(this.gunG);       // base framing + action offsets
    this.fx = new THREE.Group(); this.rig.add(this.fx);
    this.team = 'ct';
    this.arms = {};
    this.models = new Map();
    this.weapon = null; this.id = null; this.wd = null;
    this.hidden = false; this.scoped = false;
    this.action = null;       // current keyframed action
    this.poseCache = new Map();
    this.drawn = new Set();
    // procedural motion state
    this.t = 0;
    this.sw = { x: 0, y: 0, vx: 0, vy: 0 };          // mouse-lag spring (radians)
    this.bobPhase = 0; this.bobAmt = 0;
    this.land = { y: 0, v: 0 }; this.air = 0; this.crouch = 0;
    this.recoil = { p: 0, vp: 0, z: 0, vz: 0, yaw: 0, vyaw: 0, roll: 0, vroll: 0 };
    this.shells = []; this.flashT = 0; this.flashSprites = [];
    this.dropped = [];
    this._initFX();
    this.setTeam('ct');
  }
  // ------------------------------------------------------------------------------------------- team
  setTeam(team) {
    team = team === 't' ? 't' : 'ct';
    if (this.armR && this.team === team) return;
    this.team = team;
    for (const a of [this.armR, this.armL]) if (a) { this.swayG.remove(a.group); a.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
    this.armR = new Arm(team, false); this.armL = new Arm(team, true);
    this.swayG.add(this.armR.group); this.swayG.add(this.armL.group);
    this.poseCache.clear();
    if (this.id) this._setupWeapon(this.id);
  }
  // ------------------------------------------------------------------------------------------- weapon setup
  _getModel(id) {
    if (!this.models.has(id)) {
      const m = createWeaponModel(id, { lod: 'high' });
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.models.set(id, m);
    }
    return this.models.get(id);
  }
  _setupWeapon(id) {
    if (this.weapon) { this.gunG.remove(this.weapon); const s2 = this.weapon.userData.second; if (s2 && s2.parent) { s2.parent.remove(s2); this.weapon.add(s2); s2.matrixAutoUpdate = true; } }
    this.id = id; this.wd = WEAPONS[id] || { hold: 'rifle' };
    this.weapon = this._getModel(id);
    this.gunG.add(this.weapon);
    const ud = this.weapon.userData;
    this.dual = !!ud.dual; this._kick2 = this.dual ? { p: 0, vp: 0, z: 0, vz: 0 } : null; this._fireSide = 0;
    if (this.dual && ud.secondData) { const sd = ud.secondData; if (sd.mag) sd.mag.userData.rest = sd.mag.userData.rest || { p: sd.mag.position.clone(), q: sd.mag.quaternion.clone() }; if (sd.bolt) sd.bolt.userData.rest = sd.bolt.userData.rest || { p: sd.bolt.position.clone(), q: sd.bolt.quaternion.clone() }; }
    this.hold = ud.hold || this.wd.hold || 'rifle';
    const H = HOLD[this.hold] || HOLD.rifle, F = FRAME[id] || {};
    this.base = { pos: H.pos.map((v, i) => v + ((F.pos && F.pos[i]) || 0)), rot: H.rot.map((v, i) => v + ((F.rot && F.rot[i]) || 0)) };
    this.elbowR = new THREE.Vector3(...H.elbowR); this.elbowL = new THREE.Vector3(...H.elbowL);
    this.holdCfg = Object.assign({}, H, F.arms || {});
    const hc = this.holdCfg;
    this.shoulderR = new THREE.Vector3(...(hc.shR || [0.17, -0.27, 0.06]));
    this.shoulderLm = new THREE.Vector3(...(hc.shL || [-0.17, -0.26, 0.04])); this.shoulderLm.x *= -1;   // mirrored space
    this.poleR = new THREE.Vector3(...(hc.poleR || [0.7, -1.0, 0.1])).normalize();
    this.poleLm = new THREE.Vector3(...(hc.poleL || [-0.6, -1.0, 0.1])).normalize(); this.poleLm.x *= -1;
    // reset animated parts
    if (ud.mag) { ud.mag.userData.rest = ud.mag.userData.rest || { p: ud.mag.position.clone(), q: ud.mag.quaternion.clone() }; ud.mag.position.copy(ud.mag.userData.rest.p); ud.mag.quaternion.copy(ud.mag.userData.rest.q); ud.mag.visible = true; }
    if (ud.bolt) { ud.bolt.userData.rest = ud.bolt.userData.rest || { p: ud.bolt.position.clone(), q: ud.bolt.quaternion.clone() }; }
    this._resetParts();
    this.handPoses = this._solvePoses();
  }
  _resetParts() {
    const ud = this.weapon.userData;
    if (ud.mag) { const r = ud.mag.userData.rest; ud.mag.position.copy(r.p); ud.mag.quaternion.copy(r.q); ud.mag.visible = true; }
    if (ud.bolt) { const r = ud.bolt.userData.rest; ud.bolt.position.copy(r.p); ud.bolt.quaternion.copy(r.q); }
    if (ud.parts) for (const k in ud.parts) { const p = ud.parts[k]; if (p.userData.rest) { p.position.copy(p.userData.rest.p); p.quaternion.copy(p.userData.rest.q); } }
  }
  // hand placement matrices in gun space ("right-hand" frames; left ones are in mirrored gun space)
  _handFrames() {
    const ud = this.weapon.userData, hold = this.hold;
    const R = new THREE.Matrix4(), L = new THREE.Matrix4();
    // Place a hand so that the palm contact point (hand coords) lies at a contact point (gun coords) with given axes.
    const placeHand = (M, X, Y, palmPt, contact) => {
      const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
      Y = new THREE.Vector3().crossVectors(Z, X).normalize();
      M.makeBasis(X, Y, Z);
      const off = new THREE.Vector3(...palmPt).applyMatrix4(new THREE.Matrix4().extractRotation(M));
      M.setPosition(new THREE.Vector3(...contact).sub(off));
      return M;
    };
    if (ud.handR) R.copy(ud.handR);
    else {
      const a = ud.gripAngle ?? 15 * D2R;
      const t = Object.assign({ beta: -32, tilt: 8, roll: 0, contact: [0.0135, -0.016, -0.006], palm: [0.004, 0.050, 0.0165] }, ud.gripR || {});
      // grip frame
      const gx = new THREE.Vector3(1, 0, 0), gu = new THREE.Vector3(0, Math.cos(a), -Math.sin(a)), gf = new THREE.Vector3(0, -Math.sin(a), -Math.cos(a));
      const b = t.beta * D2R;
      let X = gu.clone();
      let Y = gf.clone().multiplyScalar(Math.cos(b)).addScaledVector(gx, -Math.sin(b));
      // tilt: rotate fingers toward -grip axis (ulnar deviation)
      const tl = t.tilt * D2R; const Y2 = Y.clone().multiplyScalar(Math.cos(tl)).addScaledVector(X, -Math.sin(tl)); X = X.clone().multiplyScalar(Math.cos(tl)).addScaledVector(Y, Math.sin(tl)); Y = Y2;
      if (t.roll) { const q = new THREE.Quaternion().setFromAxisAngle(Y, t.roll * D2R); X.applyQuaternion(q); }
      const gc0 = hold === 'pistol' && ud.gripBox ? new THREE.Vector3(...ud.gripBox.c) : new THREE.Vector3();
      const c = gc0.clone().addScaledVector(gx, t.contact[0]).addScaledVector(gf, t.contact[1]).addScaledVector(gu, t.contact[2]);
      placeHand(R, X, Y, t.palm, c.toArray());
    }
    if (ud.handL) L.copy(ud.handL);
    else if (hold === 'pistol') {
      // support hand: in mirrored space a right hand wrapped around the grip outside the shooting hand
      const a = ud.gripAngle ?? 18 * D2R;
      const t = Object.assign({ beta: -18, tilt: 22, contact: [0.030, 0.010, -0.020], palm: [0.004, 0.050, 0.0165] }, ud.gripL || {});
      const gx = new THREE.Vector3(1, 0, 0), gu = new THREE.Vector3(0, Math.cos(a), -Math.sin(a)), gf = new THREE.Vector3(0, -Math.sin(a), -Math.cos(a));
      const b = t.beta * D2R, tl = t.tilt * D2R;
      let X = gu.clone(); let Y = gf.clone().multiplyScalar(Math.cos(b)).addScaledVector(gx, -Math.sin(b));
      const Y2 = Y.clone().multiplyScalar(Math.cos(tl)).addScaledVector(X, -Math.sin(tl)); X = X.clone().multiplyScalar(Math.cos(tl)).addScaledVector(Y, Math.sin(tl)); Y = Y2;
      const gc = ud.gripBox ? new THREE.Vector3(...ud.gripBox.c) : new THREE.Vector3();
      const c = gc.clone().addScaledVector(gx, t.contact[0]).addScaledVector(gf, t.contact[1]).addScaledVector(gu, t.contact[2]);
      placeHand(L, X, Y, t.palm, c.toArray());
    } else if (ud.leftHand && hold === 'rifle') {
      const hg = ud.handguard || { w: 0.05, h: 0.045, y: ud.leftHand.position.y, u: -ud.leftHand.position.z };
      const t = Object.assign({ near: true, gamma: 34, yaw: -22, contact: [hg.w * 0.34, -hg.h * 0.58, 0], palm: [0.0, 0.050, 0.0195] }, ud.gripL || {});
      const g = t.gamma * D2R;
      let X, Y;
      const n = new THREE.Vector3(-Math.sin(g), Math.cos(g), 0);
      if (t.near) {
        // fingers wrap up the camera-side of the handguard (knuckles visible), wrist tucked underneath
        Y = new THREE.Vector3(Math.cos(g), Math.sin(g), 0);
        X = new THREE.Vector3().crossVectors(Y, n);
      } else {
        X = new THREE.Vector3(0, 0, -1);
        Y = new THREE.Vector3().crossVectors(n, X);
      }
      if (t.yaw) { const q = new THREE.Quaternion().setFromAxisAngle(n, t.yaw * D2R); X.applyQuaternion(q); Y.applyQuaternion(q); }
      placeHand(L, X, Y, t.palm, [t.contact[0], hg.y + t.contact[1], -hg.u + t.contact[2]]);
    } else if (hold === 'grenade') {
      // support hand idles low-left, relaxed
      L.copy(R).premultiply(new THREE.Matrix4().makeTranslation(0.11, -0.10, 0.07));
    } else {
      L.copy(R);
    }
    return { R, L };
  }
  _shapes(kind) {
    const ud = this.weapon.userData, out = [];
    const box = (c, rotX, half, r) => { const m = new THREE.Matrix4().makeRotationX(rotX || 0).setPosition(...c); return { type: 'box', inv: m.clone().invert(), half, r }; };
    if (kind === 'grip') {
      const a = ud.gripAngle ?? 15 * D2R;
      const g = ud.gripBox || { c: [0, -0.008, 0.0024], half: [0.0152, 0.058, 0.0205], r: 0.0105 };
      out.push(box(g.c, -a, g.half, g.r));
    } else if (kind === 'fore') {
      const hg = ud.handguard || { w: 0.05, h: 0.045, y: 0.08, u: 0.25 };
      out.push(box([0, hg.y, -hg.u], 0, [hg.w / 2, hg.h / 2, 0.12], Math.min(hg.w, hg.h) * 0.35));
    }
    if (ud.extraShapes && ud.extraShapes[kind]) for (const s of ud.extraShapes[kind]) out.push(box(s.c, s.rx || 0, s.half, s.r));
    return out;
  }
  _solvePoses() {
    const key = this.team + ':' + this.id;
    if (this.poseCache.has(key)) return this.poseCache.get(key);
    const fr = this._handFrames();
    const res = { frames: fr };
    // solve in gun space: detach hand roots from the rig temporarily
    const pR = this.armR.hand.root.parent, pL = this.armL.hand.root.parent;
    pR.remove(this.armR.hand.root); pL.remove(this.armL.hand.root);
    // right hand on grip
    const hR = this.armR.hand;
    hR.root.matrix.copy(fr.R); hR.root.matrixWorld.copy(fr.R); applyPose(hR, fullPose(POSE.relaxed));
    hR.root.updateMatrixWorld(true);
    if (this.hold === 'rifle' || this.hold === 'pistol' || this.hold === 'knife' || this.hold === 'grenade' || this.hold === 'c4') {
      const ud = this.weapon.userData;
      const p = graspSolve(hR, this._shapes('grip'), { skip: [0], thumb: ud.thumbR || { opp: 0.9, cmc: 0 }, pad: 0.0008 });
      if (this.hold === 'rifle' || this.hold === 'pistol') { const tr = ud.triggerPose || POSE.trigger.f[0]; p.f[0] = tr.slice(); }
      else { // knife / grenade / c4: index wraps too
        const p2 = graspSolve(hR, this._shapes('grip'), { skip: [1, 2, 3], thumb: ud.thumbR || { opp: 0.9, cmc: 0 }, pad: 0.0008 }); p.f[0] = p2.f[0];
      }
      res.R = p;
    } else res.R = fullPose(POSE.fist);
    // left hand
    const hL = this.armL.hand;
    const ML = new THREE.Matrix4().multiplyMatrices(MX, fr.L);
    hL.root.matrix.copy(ML); hL.root.matrixWorld.copy(ML); applyPose(hL, fullPose(POSE.relaxed));
    hL.root.updateMatrixWorld(true);
    if (this.hold === 'rifle') res.L = graspSolve(hL, this._shapes('fore'), { thumb: { opp: 0.55, cmc: -10 }, pad: 0.001, max: [80, 95, 70] });
    else if (this.hold === 'c4') res.L = graspSolve(hL, this._shapes('grip'), { thumb: { opp: 0.3, cmc: 0 }, pad: 0.001 });
    else if (this.hold === 'pistol') {
      const sh = this._shapes('grip').map((s) => Object.assign({}, s, { half: [s.half[0] + 0.012, s.half[1], s.half[2] + 0.014], r: s.r + 0.008 }));
      res.L = graspSolve(hL, sh, { thumb: { opp: 0.2, cmc: 0 }, pad: 0.001, max: [85, 95, 70] });
    }
    else res.L = fullPose(POSE.relaxed);
    pR.add(this.armR.hand.root); pL.add(this.armL.hand.root);
    this.poseCache.set(key, res);
    return res;
  }
  equip(id, drawTime = 1.0) {
    this._clearAction();
    this._thrown = false; this._slideLocked = false; if (this._handShell) this._handShell.visible = false;
    this._setupWeapon(id);
    this.drawTime = drawTime;
    this._startAction('draw', drawTime, { first: !this.drawn.has(id) });
    this.drawn.add(id);
  }
  resetFirstDraw() { this.drawn.clear(); }
  setHidden(h) { this.hidden = !!h; }
  setScoped(s) { this.scoped = !!s; }
  setAspect(a) { this.camera.aspect = a; this.camera.updateProjectionMatrix(); }
  // ------------------------------------------------------------------------------------------- lighting
  setLighting(o = {}) {
    if (o.sunDir) this.sunDirWorld.copy(o.sunDir).normalize();
    if (o.sunColor) this.sun.color.copy(o.sunColor);
    if (o.sunIntensity !== undefined) this.sunBase = o.sunIntensity;
    if (o.ambientColor) { this.hemi.color.copy(o.ambientColor); }
    if (o.ambientIntensity !== undefined) this.hemi.intensity = o.ambientIntensity;
    if (o.envIntensity !== undefined) this.scene.environmentIntensity = o.envIntensity;
    if (o.shadow !== undefined) this.shadowAmt = clamp(o.shadow, 0, 1);
    if (o.envMap) this.scene.environment = o.envMap;
  }
  syncCamera(mainCamera) { if (mainCamera) { this.rig.quaternion.copy(mainCamera.quaternion); this.camera.quaternion.copy(mainCamera.quaternion); } }
  // ------------------------------------------------------------------------------------------- muzzle
  getMuzzleWorld(mainCamera, out = new THREE.Vector3()) {
    if (!this.weapon || !this.weapon.userData.muzzle) return out.copy(mainCamera.position);
    this.scene.updateMatrixWorld(true);
    const mz = (this.dual && this._fireSide === 1 && this.weapon.userData.secondData) ? this.weapon.userData.secondData.muzzle : this.weapon.userData.muzzle;
    const p = mz.getWorldPosition(new THREE.Vector3());
    // vm camera space -> NDC -> main camera ray at ~28 world units
    this.camera.updateMatrixWorld(); p.project(this.camera);
    const ray = new THREE.Vector3(p.x, p.y, 0.5).unproject(mainCamera).sub(mainCamera.position).normalize();
    return out.copy(mainCamera.position).addScaledVector(ray, 28);
  }
  // build all models once and precompile their shaders (call during loading to avoid hitches)
  async warmup(ids) {
    ids = ids || Object.keys(WEAPONS);
    const holder = new THREE.Group(); holder.position.set(0, 0, -0.5); this.scene.add(holder);
    for (const id of ids) { const m = this._getModel(id); holder.add(m); }
    this.scene.updateMatrixWorld(true);
    try { if (this.renderer.compileAsync) await this.renderer.compileAsync(this.scene, this.camera); else this.renderer.compile(this.scene, this.camera); } catch (e) { console.warn('vm warmup', e); }
    for (const id of ids) { const m = this._getModel(id); holder.remove(m); }
    this.scene.remove(holder);
    if (this.weapon && !this.weapon.parent) this.gunG.add(this.weapon);
  }
  dispose() {
    this.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.models.clear();
  }
}

// =====================================================================================================
// Update / composition
// =====================================================================================================
const _ER = new THREE.Vector3(), _EL = new THREE.Vector3();
const _M1 = new THREE.Matrix4(), _M2 = new THREE.Matrix4(), _M3 = new THREE.Matrix4(), _Q1 = new THREE.Quaternion(), _V1 = new THREE.Vector3(), _V2 = new THREE.Vector3(), _E1 = new THREE.Euler();
function lerpMatrix(a, b, k, out) {
  const pa = new THREE.Vector3(), qa = new THREE.Quaternion(), sa = new THREE.Vector3(), pb = new THREE.Vector3(), qb = new THREE.Quaternion(), sb = new THREE.Vector3();
  a.decompose(pa, qa, sa); b.decompose(pb, qb, sb);
  pa.lerp(pb, k); qa.slerp(qb, k); sa.lerp(sb, k);
  return out.compose(pa, qa, sa);
}
function trs(p, rDeg, order = 'XYZ') { return new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(rDeg[0] * D2R, rDeg[1] * D2R, rDeg[2] * D2R, order)), new THREE.Vector3(1, 1, 1)); }

Object.assign(ViewModel.prototype, {
  update(dt, o = {}) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.t += dt;
    if (o.camera) this.syncCamera(o.camera);
    if (!this.weapon) return;
    // ---------------------------------------------------------------- procedural motion
    const speed = o.speed || 0, maxS = o.maxSpeed || 250;
    const sp = clamp(speed / maxS, 0, 1.2) * (o.onGround === false ? 0 : 1) * (o.walking ? 0.55 : 1);
    this.bobAmt = lerp(this.bobAmt, sp, 1 - Math.exp(-dt * 6));
    this.bobPhase += dt * (6.2 + 3.2 * this.bobAmt) * (this.bobAmt > 0.02 ? 1 : 0.6);
    // mouse lag spring
    const k = 120, c = 2 * Math.sqrt(k) * 0.72;
    const tx = clamp(-(o.yawDelta || 0) * 1.8, -0.09, 0.09), ty = clamp(-(o.pitchDelta || 0) * 1.8, -0.07, 0.07);
    const sw = this.sw;
    sw.vx += (tx * 60 * dt * 6 - sw.x * k - sw.vx * c) * dt; sw.x += sw.vx * dt;
    sw.vy += (ty * 60 * dt * 6 - sw.y * k - sw.vy * c) * dt; sw.y += sw.vy * dt;
    sw.x = clamp(sw.x, -0.08, 0.08); sw.y = clamp(sw.y, -0.06, 0.06);
    // landing / jumping
    if (o.landed) this.land.v -= 0.9 * clamp(o.landed, 0, 1);
    this.land.v += (-this.land.y * 160 - this.land.v * 16) * dt; this.land.y += this.land.v * dt;
    this.air = lerp(this.air, o.onGround === false ? 1 : 0, 1 - Math.exp(-dt * 7));
    this.crouch = lerp(this.crouch, o.crouching ? 1 : 0, 1 - Math.exp(-dt * 8));
    // recoil springs
    const R = this.recoil;
    R.vp += (-R.p * 260 - R.vp * 24) * dt; R.p += R.vp * dt;
    R.vz += (-R.z * 300 - R.vz * 26) * dt; R.z += R.vz * dt;
    R.vyaw += (-R.yaw * 200 - R.vyaw * 20) * dt; R.yaw += R.vyaw * dt;
    R.vroll += (-R.roll * 200 - R.vroll * 18) * dt; R.roll += R.vroll * dt;
    const t = this.t, ph = this.bobPhase, ba = this.bobAmt;
    const breathe = Math.sin(t * 1.3) * 0.0012, breathe2 = Math.sin(t * 0.83 + 1.1) * 0.0008;
    const bobX = Math.sin(ph) * 0.0105 * ba, bobY = -Math.abs(Math.cos(ph)) * 0.0095 * ba + 0.004 * ba;
    const sPos = [bobX + sw.x * 0.08 + breathe2, bobY + breathe - sw.y * 0.06 + this.land.y * 0.05 - this.air * 0.006 - this.crouch * 0.006, 0.006 * ba + this.air * 0.004];
    const sRot = [(-sw.y * 0.9 + Math.cos(ph * 2) * 0.004 * ba + this.air * -0.03 + this.land.y * 0.3) , (sw.x * 0.9 + Math.sin(ph) * 0.010 * ba), (sw.x * 1.4 + Math.sin(ph) * 0.016 * ba + this.crouch * 0.03)];
    this.swayG.position.set(...sPos);
    this.swayG.rotation.set(sRot[0], sRot[1], sRot[2]);
    if (this._kick2) { const k = this._kick2; k.vp += (-k.p * 260 - k.vp * 24) * dt; k.p += k.vp * dt; k.vz += (-k.z * 300 - k.vz * 26) * dt; k.z += k.vz * dt; }
    // molotov rag flame flicker (+ warm light on the hands)
    const fl = this.weapon.userData.flame;
    if (fl) {
      const f = 0.75 + 0.25 * Math.sin(this.t * 31) * Math.sin(this.t * 17.3 + 1) + 0.15 * Math.random();
      fl.scale.set(0.8 + 0.15 * Math.random(), f * 0.85, 0.8 + 0.15 * Math.random()); fl.rotation.z = Math.sin(this.t * 7) * 0.2;
      if (this.flashT <= 0 && fl.visible && this.weapon.visible) { fl.updateWorldMatrix(true, false); this.flash.position.setFromMatrixPosition(fl.matrixWorld); this.flash.intensity = 0.35 * f; this.flash.color.setHex(0xff9030); }
    } else if (this.flashT <= 0) this.flash.intensity = 0;
    // ---------------------------------------------------------------- action
    const A = this._evalAction(dt);
    const bp = this.base.pos, br = this.base.rot;
    const gp = A.gp || [0, 0, 0], gr = A.gr || [0, 0, 0];
    this.gunG.position.set(bp[0] + gp[0], bp[1] + gp[1], bp[2] + gp[2] + R.z);
    _E1.set((br[0] + gr[0]) * D2R + R.p, (br[1] + gr[1]) * D2R + R.yaw, (br[2] + gr[2]) * D2R + R.roll, 'YXZ');
    this.gunG.quaternion.setFromEuler(_E1);
    if (A.gunExtra) this.gunG.quaternion.multiply(A.gunExtra);
    this.gunG.updateMatrix();
    // ---------------------------------------------------------------- arms
    this._placeArms(A);
    // visibility
    this.rig.visible = !this.hidden && !this.scoped && !A.hideAll;
    if (this.weapon) this.weapon.visible = !A.hideWeapon;
    // ---------------------------------------------------------------- lighting (sun into rig space)
    _V1.copy(this.sunDirWorld);
    this.sun.position.copy(_V1).multiplyScalar(1.5);
    this.sun.target.position.set(0, 0, 0);
    this.sun.position.add(this.camera.position);
    const sh = this.shadowAmt;
    this.sun.intensity = this.sunBase * (1 - sh * 0.88);
    this._updateFX(dt);
  },
  _placeArms(A) {
    const G = this.gunG.matrix;
    const fr = this.handPoses.frames;
    // right
    let WR = _M1.multiplyMatrices(G, A.rh || fr.R);
    if (A.rhRig) WR = lerpMatrix(WR, A.rhRig.m, A.rhRig.k, _M1);
    const H = this.holdCfg;
    _V1.setFromMatrixPosition(WR);
    const eR = solveElbow(this.shoulderR, _V1, H.upper ?? 0.29, H.fore ?? 0.27, this.poleR, _ER);
    this.armR.place(WR, A.elbowR || eR);
    this.armR.setPose(A.rhPose || this.handPoses.R);
    this.armR.group.visible = !A.hideR;
    // left (mirrored space)
    const SGS = _M2.multiplyMatrices(MX, G).multiply(MX);
    let WL;
    if (this.dual) {
      // dual pistols: left hand holds the second gun, mirror-symmetric to the right one
      const G2 = this._G2 || (this._G2 = new THREE.Matrix4());
      G2.copy(G);
      if (A.g2) G2.multiply(A.g2);
      if (this._kick2) G2.multiply(new THREE.Matrix4().makeRotationX(this._kick2.p).setPosition(0, 0, this._kick2.z));
      WL = _M3.multiplyMatrices(G2, fr.R);
      const sec = this.weapon.userData.second;
      sec.matrixAutoUpdate = false;
      sec.matrix.multiplyMatrices(MX, G2);
      if (sec.parent !== this.swayG) this.swayG.add(sec);
      sec.matrixWorldNeedsUpdate = true;
    } else WL = _M3.multiplyMatrices(SGS, A.lh || fr.L);
    if (A.lhRig) WL = lerpMatrix(WL, A.lhRig.m, A.lhRig.k, _M3);
    _V1.setFromMatrixPosition(WL);
    const eL = solveElbow(this.shoulderLm, _V1, H.upper ?? 0.29, H.fore ?? 0.27, this.poleLm, _EL);
    this.armL.place(WL, A.elbowL ? _V2.copy(A.elbowL).setX(-A.elbowL.x) : eL);
    this.armL.setPose(this.dual ? (A.lhPose || this.handPoses.R) : (A.lhPose || this.handPoses.L));
    this.armL.group.visible = !A.hideL && this.hold !== 'knife' && !(this.hold === 'grenade' && !A.lh);
  },
  // ------------------------------------------------------------------------------------------- actions
  _startAction(name, dur, opts = {}) {
    if (this.action && this.action.name === 'inspect' && name !== 'inspect') this.action = null;
    this.action = { name, t: 0, dur: Math.max(0.05, dur), opts, fired: {} };
  },
  _clearAction() {
    if (this.weapon) this._resetParts();
    this.action = null;
  },
  _evalAction(dt) {
    const A = { };
    const a = this.action;
    if (!a) { this._idleParts(A); return A; }
    a.t += dt;
    const u = clamp(a.t / a.dur, 0, 1);
    const fn = ACTIONS[a.name];
    if (fn) fn.call(this, A, u, a.t, a);
    if (a.t >= a.dur && !a.hold) { this.action = null; this._resetParts(); }
    else if (a.t >= a.dur && a.hold) { a.t = a.dur; }
    return A;
  },
  _idleParts(A) {},
  // ------------------------------------------------------------------------------------------- FX
  _initFX() {
    const mk = (tex, w, h) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })); m.visible = false; m.renderOrder = 10; return m; };
    this.flashFront = mk(getWeaponTexture('flash_front'), 0.11, 0.11);
    this.flashSide1 = mk(getWeaponTexture('flash_side'), 0.16, 0.08);
    this.flashSide2 = mk(getWeaponTexture('flash_side'), 0.16, 0.08);
    this.flashG = new THREE.Group(); this.flashG.add(this.flashFront, this.flashSide1, this.flashSide2);
    this.smokeMat = new THREE.MeshBasicMaterial({ map: getWeaponTexture('smoke'), transparent: true, depthWrite: false, opacity: 0.0 });
    this.smokes = [];
    // shell geometry pool
    this.shellGeo = new THREE.CylinderGeometry(0.0055, 0.0058, 0.039, 10, 1); this.shellGeo.rotateX(Math.PI / 2);
    this.shellGeoPistol = new THREE.CylinderGeometry(0.0048, 0.0049, 0.019, 10, 1); this.shellGeoPistol.rotateX(Math.PI / 2);
    this.shellGeoShot = new THREE.CylinderGeometry(0.0105, 0.0105, 0.065, 12, 1); this.shellGeoShot.rotateX(Math.PI / 2);
  },
  _updateFX(dt) {
    // muzzle flash
    if (this.flashT > 0) {
      this.flashT -= dt;
      const k = clamp(this.flashT / this.flashDur, 0, 1);
      this.flash.intensity = this.flashPeak * k * k;
      this.flashG.traverse((m) => { if (m.material) m.material.opacity = k; });
      if (this.flashT <= 0) { this.flashG.visible = false; this.flash.intensity = 0; }
    }
    if (this.flashG.visible && this.weapon) {
      const mz = (this._flashUD || this.weapon.userData).muzzle;
      mz.updateWorldMatrix(true, false);
      this.fx.updateWorldMatrix(true, false);
      this.flashG.matrix.copy(this.fx.matrixWorld).invert().multiply(mz.matrixWorld); this.flashG.matrixAutoUpdate = false; this.flashG.matrixWorldNeedsUpdate = true;
      this.flash.position.setFromMatrixPosition(mz.matrixWorld);
    }
    // shells
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.age += dt;
      s.v.y -= 9.8 * dt * 0.55;
      s.m.position.addScaledVector(s.v, dt);
      s.m.rotation.x += s.w.x * dt; s.m.rotation.y += s.w.y * dt; s.m.rotation.z += s.w.z * dt;
      if (s.age > 0.9) { s.m.material.opacity = Math.max(0, 1 - (s.age - 0.9) / 0.3); s.m.material.transparent = true; }
      if (s.age > 1.2) { this.fx.remove(s.m); this.shells.splice(i, 1); }
    }
    // dropped mags etc
    for (let i = this.dropped.length - 1; i >= 0; i--) {
      const s = this.dropped[i]; s.age += dt;
      s.v.y -= 9.8 * dt; s.o.position.addScaledVector(s.v, dt);
      s.o.rotation.x += s.w.x * dt; s.o.rotation.z += s.w.z * dt;
      if (s.age > 1.0) { this.fx.remove(s.o); this.dropped.splice(i, 1); }
    }
    // smoke puffs
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i]; s.age += dt;
      s.m.position.addScaledVector(s.v, dt); s.v.multiplyScalar(1 - dt * 2.5); s.v.y += dt * 0.05;
      const k = s.age / s.life; s.m.scale.setScalar(s.s0 * (1 + k * 3));
      s.m.material.opacity = 0.22 * (1 - k) * Math.min(1, s.age * 20);
      s.m.quaternion.copy(this.camera.quaternion);
      if (s.age > s.life) { this.fx.remove(s.m); s.m.material.dispose(); this.smokes.splice(i, 1); }
    }
  },
});
const ACTIONS = {};


// =====================================================================================================
// Test harness (used by test_weapons.html?vm=...)
// =====================================================================================================
export async function runTest(renderer, env, sky, P) {
  await preloadWeaponAssets(renderer);
  if (P.get('hands')) return handTest(renderer, env, sky, P);
  const id = P.get('vm');
  const vm = new ViewModel(renderer, { envMap: env });
  vm.setTeam(P.get('team') || (WEAPONS[id] && WEAPONS[id].team === 't' ? 't' : 'ct'));
  vm.setAspect(innerWidth / innerHeight);
  // world backdrop: sandy ground + sky
  const world = new THREE.Scene();
  world.background = sky; world.environment = env;
  const mainCam = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 1, 20000);
  mainCam.position.set(0, 64, 0);
  const yaw = (+(P.get('cyaw') || 25)) * D2R, pitch = (+(P.get('cpitch') || -4)) * D2R;
  mainCam.rotation.set(pitch, yaw, 0, 'YXZ');
  const gtex = new THREE.TextureLoader().load('assets/tex/sand_albedo.jpg'); gtex.wrapS = gtex.wrapT = THREE.RepeatWrapping; gtex.repeat.set(40, 40); gtex.colorSpace = THREE.SRGBColorSpace;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshStandardMaterial({ map: gtex, color: 0xd8c8a8, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2; world.add(ground);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(600, 300, 40), new THREE.MeshStandardMaterial({ color: 0xc8b088, roughness: 0.9 }));
  wall.position.set(-200, 150, -700); world.add(wall);
  const sun = new THREE.DirectionalLight(0xfff0dc, 3); sun.position.set(0.42, 0.74, 0.52); world.add(sun); world.add(new THREE.HemisphereLight(0xbfd4ff, 0x8a7458, 0.6));
  vm.setLighting({ sunDir: new THREE.Vector3(0.42, 0.74, 0.52), sunIntensity: 3.0, ambientIntensity: 0.6, envIntensity: 1.0, shadow: +(P.get('shadow') || 0) });
  vm.equip(id, (WEAPONS[id] && WEAPONS[id].draw) || 1);
  const anim = P.get('anim'), at = +(P.get('t') || 0);
  // advance to the requested frame (deterministic stepping)
  const step = (dt, extra = {}) => vm.update(dt, Object.assign({ speed: +(P.get('speed') || 0), maxSpeed: 250, onGround: true, camera: mainCam }, extra));
  if (!anim) { vm.action = null; vm._resetParts(); step(0.016); step(2.0); }
  else {
    vm.action = null; vm._resetParts(); for (let i = 0; i < 10; i++) step(0.1);
    vm.t = 0;
    const startFn = {
      draw: () => vm.equip(id, (WEAPONS[id] && WEAPONS[id].draw) || 1),
      reload: () => vm.reload(+(P.get('dur') || (WEAPONS[id] && WEAPONS[id].reload) || 2.5), { empty: !!P.get('empty') }),
      inspect: () => vm.inspect(),
      fire: () => vm.fire({ shotIndex: 0, lastShot: !!P.get('last') }),
      dry: () => vm.dryFire(),
      slash: () => vm.knifeAttack(false), stab: () => vm.knifeAttack(true),
      pull: () => vm.grenadePull(), throw: () => { vm.grenadePull(); for (let i = 0; i < 20; i++) step(0.05); vm.grenadeThrow(+(P.get('str') || 1)); },
      plant: () => vm.c4Plant(true),
      rstart: () => vm.reloadStart(0.5), rshell: () => { vm.reloadStart(0.5); for (let i = 0; i < 10; i++) step(0.05); vm.reloadShell(0.5); }, rend: () => vm.reloadEnd(0.6),
    }[anim];
    if (startFn) startFn();
    let tt = 0; while (tt < at - 1e-6) { const d = Math.min(1 / 60, at - tt); step(d); tt += d; }
    step(0);
  }
  const ext = P.get('ext');
  let extCam = null;
  if (P.get('zoom')) {
    // same eye position, narrow fov aimed at the left/right hand (inspect what the player sees)
    vm.scene.updateMatrixWorld(true);
    extCam = new THREE.PerspectiveCamera(+(P.get('efov') || 18), innerWidth / innerHeight, 0.01, 10);
    extCam.position.copy(vm.camera.position); extCam.quaternion.copy(vm.camera.quaternion);
    const tgt = (P.get('zoom') === 'r' ? vm.armR : vm.armL).hand.root.getWorldPosition(new THREE.Vector3());
    extCam.up.set(0, 1, 0).applyQuaternion(vm.camera.quaternion); extCam.lookAt(tgt);
  }
  if (ext) {
    // external debug camera, positioned relative to the weapon (gun space): right | left | below | top | front | x,y,z
    extCam = new THREE.PerspectiveCamera(+(P.get('efov') || 35), innerWidth / innerHeight, 0.01, 10);
    const presets = { right: [0.55, 0.12, -0.05], left: [-0.55, 0.12, -0.05], below: [0.15, -0.5, -0.1], top: [0.05, 0.6, -0.1], front: [0.25, 0.1, -0.9], back: [0.25, 0.2, 0.5] };
    const e = presets[ext] || ext.split(',').map(Number);
    vm.scene.updateMatrixWorld(true);
    const gw = vm.weapon.matrixWorld;
    const tgt = new THREE.Vector3(0, 0.04, -(+(P.get('eu') || 0.12))).applyMatrix4(gw);
    extCam.position.set(e[0], e[1], e[2] - (+(P.get('eu') || 0.12))).applyMatrix4(gw);
    extCam.up.set(0, 1, 0).applyQuaternion(vm.rig.quaternion);
    extCam.lookAt(tgt);
  }
  const live = !!P.get('live');
  // composite renderer: world, then viewmodel over it (depth cleared)
  const holder = new THREE.Object3D();
  holder.onBeforeRender = () => {};
  const scene = new THREE.Scene();
  let quad = null;
  if (ext === 'quad') {
    vm.scene.updateMatrixWorld(true);
    const gw = vm.weapon.matrixWorld, eu = +(P.get('eu') || 0.12), sc = +(P.get('ed') || 1);
    quad = [[0.5, 0.1, 0.0], [-0.5, 0.1, 0.0], [0.05, -0.55, 0.0], [0.15, 0.12, -0.6]].map((e) => {
      const c = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.01, 10);
      c.position.set(e[0] * sc, 0.04 + e[1] * sc, -eu + e[2] * sc).applyMatrix4(gw);
      c.up.set(0, 1, 0).applyQuaternion(vm.rig.quaternion); c.lookAt(new THREE.Vector3(0, 0.04, -eu).applyMatrix4(gw)); return c;
    });
  }
  const render = () => {
    if (quad) {
      const w = innerWidth / 2, h = innerHeight / 2; renderer.setScissorTest(true);
      quad.forEach((c, i) => { const x = (i % 2) * w, y = (1 - (i >> 1)) * h; renderer.setViewport(x, y, w, h); renderer.setScissor(x, y, w, h); renderer.setClearColor(0x506070); renderer.clear(); renderer.render(vm.scene, c); });
      renderer.setScissorTest(false); renderer.setViewport(0, 0, innerWidth, innerHeight); return;
    }
    renderer.autoClear = true; renderer.render(world, mainCam);
    renderer.autoClear = false; renderer.clearDepth(); renderer.render(vm.scene, extCam || vm.camera); renderer.autoClear = true;
  };
  return {
    camera: mainCam, scene: new THREE.Group(), vm,
    tick: (time, dt) => { if (live) step(dt); render(); },
    customRender: render,
  };
}

// hand studio: both hands in a pose, 4 views
function handTest(renderer, env, sky, P) {
  const team = P.get('team') || 'ct';
  const scene = new THREE.Scene(); scene.environment = env; scene.background = new THREE.Color(0x56606a);
  const sun = new THREE.DirectionalLight(0xfff0dc, 3); sun.position.set(0.42, 0.74, 0.52); scene.add(sun); scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x8a7458, 0.6));
  const arm = new Arm(team, false);
  const pose = POSE[P.get('pose') || 'relaxed'] || POSE.relaxed;
  arm.setPose(fullPose(pose));
  const W = new THREE.Matrix4(); arm.place(W, new THREE.Vector3(0, -0.3, 0.02));
  scene.add(arm.group);
  const arm2 = new Arm(team, true); arm2.setPose(fullPose(pose)); arm2.place(new THREE.Matrix4().makeTranslation(0.0, 0, 0), new THREE.Vector3(0, -0.3, 0.02)); arm2.group.position.x = -0.16; scene.add(arm2.group);
  const views = [[0.0, 0.05, 0.35], [0.0, 0.05, -0.35], [0.35, 0.08, 0.0], [-0.25, 0.3, 0.2]];
  const cams = views.map((v) => { const c = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.01, 10); c.position.set(v[0] - 0.08, v[1] + 0.03, v[2]); c.lookAt(-0.08, 0.03, 0); return c; });
  return {
    camera: cams[0], scene: new THREE.Group(), vm: { setAspect() {} },
    tick: () => {
      const w = innerWidth / 2, h = innerHeight / 2; renderer.setScissorTest(true);
      cams.forEach((c, i) => { const x = (i % 2) * w, y = (1 - (i >> 1)) * h; renderer.setViewport(x, y, w, h); renderer.setScissor(x, y, w, h); renderer.setClearColor(0x56606a); renderer.clear(); renderer.render(scene, c); });
      renderer.setScissorTest(false); renderer.setViewport(0, 0, innerWidth, innerHeight);
    },
  };
}

// =====================================================================================================
// Actions
// =====================================================================================================
const SX = new THREE.Matrix4().makeScale(-1, 1, 1);
function mirrorM(m, out = new THREE.Matrix4()) { return out.copy(SX).multiply(m).multiply(SX); }
function frameFrom(X, Y, pos) {
  X = X.clone().normalize(); const Z = new THREE.Vector3().crossVectors(X, Y).normalize(); Y = new THREE.Vector3().crossVectors(Z, X).normalize();
  return new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(pos);
}
// hand frame such that hand point `palm` sits at `contact` with axes X (thumb/curl), Y (fingers)
function handAt(X, Y, palm, contact) {
  const M = frameFrom(X, Y, new THREE.Vector3());
  const off = new THREE.Vector3(...palm).applyMatrix4(new THREE.Matrix4().extractRotation(M));
  return M.setPosition(contact.clone().sub(off));
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const pulse = (u, a, b) => clamp((u - a) / (b - a), 0, 1);       // 0..1 ramp within [a,b]
const bell = (u, a, b) => { const k = pulse(u, a, b); return Math.sin(k * Math.PI); };

Object.assign(ViewModel.prototype, {
  // ------------------------------------------------------------------ public API
  fire({ shotIndex = 0, lastShot = false } = {}) {
    if (!this.weapon) return;
    if (this.action && this.action.name === 'inspect') this.action = null;
    const ud = this.weapon.userData, wd = this.wd || {};
    const hold = this.hold;
    if (hold === 'knife') return this.knifeAttack(false);
    if (hold === 'grenade' || hold === 'c4') return;
    const strength = clamp((wd.recoil || 20) / 30, 0.3, 3.0);
    const isPistol = hold === 'pistol';
    const sniper = ud.charge === 'bolt';
    const R = this.recoil;
    if (this.dual) {
      this._fireSide = (shotIndex % 2);
      if (this._fireSide === 1) {
        const k = this._kick2; k.vz += 0.5; k.vp += 2.0 * strength;
        this._muzzleFlash(false, strength, hold, false, ud.secondData);
        this._ejectShell(ud.secondData, false);
        this._startAction('shot2', 0.12, { lastShot });
        return;
      }
    }
    R.vz += (isPistol ? 0.55 : 0.75) * (0.7 + 0.3 * strength) * (sniper ? 1.6 : 1);
    R.vp += (isPistol ? 2.2 : 1.1) * strength * (0.8 + Math.random() * 0.4);
    R.vyaw += (Math.random() - 0.5) * 0.5 * strength;
    R.vroll += (Math.random() - 0.5) * 0.6 * strength;
    // muzzle flash
    if (wd.id !== 'taser') this._muzzleFlash(!!wd.silenced, strength, hold);
    else this._muzzleFlash(false, 0.3, hold, true);
    // shell
    if (!ud.noShell && !(ud.charge === 'bolt') && !(ud.charge === 'pump') && wd.id !== 'taser' && !ud.revolver) this._ejectShell();
    // mechanical cycle
    if (sniper) { this._startAction('boltcycle', Math.max(0.6, (wd.cycle || 1.4) - 0.15), { lastShot }); return; }
    if (ud.charge === 'pump') { this._startAction('pump', Math.min(0.75, (wd.cycle || 0.85) * 0.85), { lastShot }); return; }
    if (ud.revolver) { this._startAction('revolve', Math.min(0.45, wd.cycle || 0.5), {}); return; }
    this._startAction('shot', Math.max(0.1, Math.min(0.2, wd.cycle || 0.1)), { lastShot, shotIndex, keep: true });
  },
  dryFire() {
    if (!this.weapon) return;
    this.recoil.vp += 0.15; this.recoil.vz += 0.05;
    this._startAction('dry', 0.25, {});
  },
  reload(timeSec = 2.5, { empty = false } = {}) {
    if (!this.weapon) return;
    const ud = this.weapon.userData;
    if (this.hold !== 'rifle' && this.hold !== 'pistol') return;
    this._resetParts();
    if (this.dual) return this._startAction('reloadDual', timeSec, { empty });
    if (!ud.mag) {
      if (ud.revolver) return this._startAction('reloadRevolver', Math.max(0.5, timeSec), {});
      if (ud.shellType === 'shotgun') return this._startAction('reloadShells', Math.max(0.6, timeSec), { empty });
      return;
    }
    this._startAction(ud.reloadType || (this.hold === 'pistol' ? 'reloadPistol' : 'reloadMag'), timeSec, { empty });
  },
  reloadStart(t = 0.5) { this._startAction('shellStart', t, {}); this._shellState = 'start'; },
  reloadShell(t = 0.5) { this._startAction('shellIn', t, {}); },
  reloadEnd(t = 0.6) { this._startAction('shellEnd', t, {}); },
  inspect() {
    if (!this.weapon || (this.action && this.action.name !== 'inspect')) return;
    const h = this.hold;
    this._startAction(h === 'knife' ? 'inspectKnife' : h === 'grenade' || h === 'c4' ? 'inspectSmall' : 'inspect', h === 'knife' ? 3.2 : 3.4, {});
  },
  knifeAttack(heavy = false) {
    if (!this.weapon) return;
    this._slashSide = !this._slashSide;
    this._startAction(heavy ? 'stab' : 'slash', heavy ? 0.95 : 0.42, { left: this._slashSide });
  },
  grenadePull() { if (this.weapon && this.hold === 'grenade') this._startAction('pull', 0.55, { hold: true }); },
  grenadeThrow(strength = 1) { if (this.weapon && this.hold === 'grenade') this._startAction('throw', 0.62, { strength }); },
  c4Plant(active = true) {
    if (!this.weapon || this.hold !== 'c4') return;
    if (active) { this._startAction('plant', 3.2, {}); this._setLCD(''); }
    else { if (this.action && this.action.name === 'plant') this.action = null; this._setLCD(''); }
  },
  // ------------------------------------------------------------------ FX
  _muzzleFlash(silenced, strength, hold, taser, udAlt) {
    const ud = udAlt || this.weapon.userData;
    this._flashUD = ud;
    if (!this.flashG.parent) this.fx.add(this.flashG);
    this.flashG.visible = true;
    const s = silenced ? 0.3 : (hold === 'pistol' ? 1.1 : 1.6) * (0.85 + Math.random() * 0.3) * (ud.flashScale || 1);
    const rot = Math.random() * Math.PI * 2;
    this.flashFront.scale.setScalar(s); this.flashFront.position.set(0, 0, -0.004); this.flashFront.rotation.set(0, 0, rot);
    this.flashSide1.scale.set(s, s * (0.8 + Math.random() * 0.4), 1); this.flashSide1.position.set(0, 0, -0.07 * s); this.flashSide1.rotation.set(0, Math.PI / 2, 0);
    this.flashSide1.rotation.order = 'YXZ';
    this.flashSide1.quaternion.setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)).multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), rot));
    this.flashSide2.scale.copy(this.flashSide1.scale); this.flashSide2.position.copy(this.flashSide1.position);
    this.flashSide2.quaternion.setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)).multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), rot + Math.PI / 2));
    // side plume sprite is authored along +x from muzzle; rotate so +x points forward (-Z)
    this.flashSide1.position.z = -0.075 * s; this.flashSide2.position.z = -0.075 * s;
    const col = taser ? 0x80b0ff : 0xffffff;
    this.flashG.traverse((m) => { if (m.material) m.material.color.setHex(col); });
    this.flashSide1.visible = this.flashSide2.visible = !silenced;
    this.flashDur = silenced ? 0.03 : 0.05; this.flashT = this.flashDur;
    this.flashPeak = silenced ? 0.4 : (taser ? 3 : 7 * (hold === 'pistol' ? 0.7 : 1));
    this.flash.color.setHex(taser ? 0x80a0ff : 0xffa850);
    // smoke puff
    if (this.smokes.length < 12) {
      const sm = this.smokeMat; const keep = sm.userData; sm.userData = {}; const smc = sm.clone(); sm.userData = keep;
      const m = new THREE.Mesh(this._smokePlane || (this._smokePlane = new THREE.PlaneGeometry(0.05, 0.05)), smc);
      ud.muzzle.updateWorldMatrix(true, false);
      this.rig.updateMatrixWorld(true);
      m.position.setFromMatrixPosition(ud.muzzle.matrixWorld); this.fx.worldToLocal(m.position);
      this.fx.add(m);
      const dir = V(0, 0, -1).transformDirection(ud.muzzle.matrixWorld); const inv = new THREE.Quaternion().copy(this.rig.quaternion).invert(); dir.applyQuaternion(inv);
      this.smokes.push({ m, v: dir.multiplyScalar(silenced ? 0.15 : 0.5).add(V(0, 0.05, 0)), age: 0, life: silenced ? 0.5 : 0.9, s0: silenced ? 0.6 : 1 });
    }
  },
  _ejectShell(udAlt, mirrored) {
    const ud = udAlt || this.weapon.userData;
    if (!ud.eject) return;
    const hold = this.hold;
    const geo = ud.shellType === 'shotgun' ? this.shellGeoShot : (hold === 'pistol' || ud.shellType === 'pistol') ? this.shellGeoPistol : this.shellGeo;
    // pooled per-shell materials (cloning a wear material deep-copies its userData via JSON → huge allocations)
    const base = ud.shellType === 'shotgun' ? MAT.paintRed : MAT.brass;
    const pool = this._shellMatPool || (this._shellMatPool = new Map());
    let list = pool.get(base); if (!list) { list = { i: 0, mats: [] }; pool.set(base, list); }
    let mat = list.mats[list.i % 26];
    if (!mat) { const keep = base.userData; base.userData = {}; mat = base.clone(); base.userData = keep; mat.userData = keep; mat.onBeforeCompile = base.onBeforeCompile; if (base.customProgramCacheKey) mat.customProgramCacheKey = base.customProgramCacheKey; list.mats[list.i % 26] = mat; }
    list.i++;
    mat.opacity = 1; mat.transparent = false;
    const m = new THREE.Mesh(geo, mat); m.castShadow = true;
    ud.eject.updateWorldMatrix(true, false); this.rig.updateMatrixWorld(true);
    m.position.setFromMatrixPosition(ud.eject.matrixWorld); this.fx.worldToLocal(m.position);
    const inv = new THREE.Quaternion().copy(this.rig.quaternion).invert();
    const right = V(mirrored ? -1 : 1, 0, 0).transformDirection(ud.eject.matrixWorld).applyQuaternion(inv);
    const up = V(0, 1, 0).transformDirection(this.weapon.matrixWorld).applyQuaternion(inv);
    const back = V(0, 0, 1).transformDirection(this.weapon.matrixWorld).applyQuaternion(inv);
    const v = right.multiplyScalar(1.1 + Math.random() * 0.5).addScaledVector(up, 0.7 + Math.random() * 0.4).addScaledVector(back, 0.15 + Math.random() * 0.2);
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().extractRotation(this.weapon.matrixWorld)).premultiply(inv);
    this.fx.add(m);
    this.shells.push({ m, v, w: V((Math.random() - 0.5) * 30, 20 + Math.random() * 25, (Math.random() - 0.5) * 20), age: 0 });
    if (this.shells.length > 24) { const o = this.shells.shift(); this.fx.remove(o.m); }
  },
  _dropObject(obj, vel, spin) {
    // clone obj (with current world transform) into fx space and let it fall
    if (!obj) return;
    obj.updateWorldMatrix(true, true); this.rig.updateMatrixWorld(true);
    const c = obj.clone(true);
    const M = new THREE.Matrix4().copy(this.fx.matrixWorld).invert().multiply(obj.matrixWorld);
    M.decompose(c.position, c.quaternion, c.scale);
    this.fx.add(c);
    this.dropped.push({ o: c, v: vel || V(0, -0.4, 0.1), w: spin || V(3, 0, 2), age: 0 });
  },
  // ------------------------------------------------------------------ hand targets
  _gunToMirror(m) { return mirrorM(m); },
  _magGrip() {
    const ud = this.weapon.userData;
    const key = this.team + ':' + this.id + ':mag';
    if (this.poseCache.has(key)) return this.poseCache.get(key);
    const mag = ud.mag;
    const res = {};
    if (!mag) { res.H = this.handPoses.frames.L.clone(); res.pose = fullPose(POSE.fist); this.poseCache.set(key, res); return res; }
    this._resetParts();
    this.weapon.updateMatrixWorld(true);
    // bounding box of the magazine in gun space
    const inv = new THREE.Matrix4().copy(this.weapon.matrixWorld).invert();
    const box = new THREE.Box3();
    mag.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); const b = o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)); box.union(b); } });
    const ctr = box.getCenter(V()), size = box.getSize(V());
    const g = ud.magGrip || {};
    // mirrored space: palm against the mag front, thumb pointing up, fingers wrap round the (mirrored) left side
    const yLevel = g.y ?? (box.min.y + size.y * 0.42);
    const zf = box.min.z; // front face (most negative z)
    // front face at this height: approximate by sampling (curved mags): use box front lerped toward center
    const frontZ = g.z ?? lerp(zf, ctr.z, 0.25);
    const contact = V(0, yLevel, frontZ - 0.003);
    let X = V(0, 1, 0), Y = V(-1, 0, 0.35);
    if (g.tilt) X.applyAxisAngle(V(1, 0, 0), g.tilt * D2R);
    res.H = handAt(X, Y, [0.004, 0.048, 0.017], contact);
    res.box = { c: ctr.toArray(), half: [size.x / 2, size.y / 2, size.z / 2] };
    // solve fingers around the mag box (in mirrored gun space the box is symmetric)
    const hL = this.armL.hand, parent = hL.root.parent; parent.remove(hL.root);
    const M = new THREE.Matrix4().multiplyMatrices(MX, res.H);
    hL.root.matrix.copy(M); hL.root.matrixWorld.copy(M); applyPose(hL, fullPose(POSE.open)); hL.root.updateMatrixWorld(true);
    const sh = { type: 'box', inv: new THREE.Matrix4().makeTranslation(ctr.x, ctr.y, ctr.z).invert(), half: res.box.half, r: Math.min(size.x, size.z) * 0.25 };
    res.pose = graspSolve(hL, [sh], { thumb: { opp: 0.6, cmc: 10 }, pad: 0.0012, max: [85, 95, 70] });
    parent.add(hL.root);
    this.poseCache.set(key, res);
    return res;
  },
  // grab point for the charging handle / slide (mirrored gun space hand frame)
  _chargeGrip() {
    const ud = this.weapon.userData;
    const c = ud.chargePt ? ud.chargePt.clone() : V(0.03, 0.09, -0.08);
    const mc = V(-c.x, c.y, c.z); // mirrored
    const side = Math.sign(mc.x) || -1;
    if (ud.chargeFrom !== 'over') {
      // hand comes from below, fingers hook the knob from the front, palm facing rearward
      const Y = V(side * 0.25, 1, 0.15), X = V(-side, 0.2, 0);
      return handAt(X, Y, [0.0, 0.098, 0.004], mc.add(V(0, 0.0, -0.014)));
    }
    // hand comes over the top, pinching the handle: palm down, fingers pointing toward the handle side
    const X = V(0, 0, -1);
    const Y = V(side * 0.5, -0.85, 0.0);
    return handAt(X, Y, [0.0, 0.085, 0.012], mc.add(V(side * 0.004, 0.01, 0)));
  },
});

// helpers used by actions
function lhBlend(vm, A, M, k, pose, poseK) {
  // M: target left-hand frame in mirrored gun space; k blend from default
  const base = vm.handPoses.frames.L;
  A.lh = k >= 1 ? M : lerpMatrix(base, M, ease.io(clamp(k, 0, 1)), new THREE.Matrix4());
  if (pose) {
    const p0 = vm.handPoses.L;
    const kk = poseK === undefined ? k : poseK;
    const mid = fullPose(POSE.open);
    A.lhPose = kk < 0.5 ? blendPose(p0, mid, ease.io(kk * 2)) : blendPose(mid, pose, ease.io((kk - 0.5) * 2));
  }
}
function rhBlend(vm, A, M, k, pose) {
  const base = vm.handPoses.frames.R;
  A.rh = k >= 1 ? M : lerpMatrix(base, M, ease.io(clamp(k, 0, 1)), new THREE.Matrix4());
  if (pose) { const p0 = vm.handPoses.R; A.rhPose = blendPose(p0, pose, ease.io(clamp(k, 0, 1))); }
}
function setBolt(vm, d) {
  const ud = vm.weapon.userData; const b = ud.bolt; if (!b) return;
  const r = b.userData.rest; if (!r) return;
  const ax = ud.boltAxis || V(0, 0, 1);
  b.position.copy(r.p).addScaledVector(ax, d * (ud.boltTravel || 0.05));
}
function setPart(vm, name, d, rotAxis, rotAng) {
  const ud = vm.weapon.userData; const p = ud.parts && ud.parts[name]; if (!p) return;
  if (!p.userData.rest) p.userData.rest = { p: p.position.clone(), q: p.quaternion.clone() };
  const r = p.userData.rest; const ax = (ud.partAxis && ud.partAxis[name]) || V(0, 0, 1);
  p.position.copy(r.p).addScaledVector(ax, d);
  p.quaternion.copy(r.q); if (rotAxis) p.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(rotAxis, rotAng));
}
function setMag(vm, off, rotX = 0, visible = true) {
  const ud = vm.weapon.userData; const m = ud.mag; if (!m) return;
  const r = m.userData.rest;
  m.position.copy(r.p).add(off);
  m.quaternion.copy(r.q).multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), rotX));
  m.visible = visible;
}
function magMatrix(vm, off, rotX) {
  // transform of the mag relative to its rest pose, in gun space (pivot = mag group origin)
  const ud = vm.weapon.userData; const r = ud.mag ? ud.mag.userData.rest.p : V();
  const T = new THREE.Matrix4().makeTranslation(r.x + off.x, r.y + off.y, r.z + off.z);
  T.multiply(new THREE.Matrix4().makeRotationX(rotX));
  T.multiply(new THREE.Matrix4().makeTranslation(-r.x, -r.y, -r.z));
  return T;
}

// ---------------------------------------------------------------- draw / deploy
ACTIONS.draw = function (A, u, t, a) {
  const ud = this.weapon.userData, hold = this.hold;
  const first = a.opts.first;
  const special = first && ud.charge && ud.charge !== 'none' && this.wd.cat !== 'grenade';
  const raiseEnd = special ? 0.45 : 0.75;
  const k = ease.out(pulse(u, 0, raiseEnd));
  const kb = ease.back(pulse(u, 0, raiseEnd));
  if (hold === 'knife') {
    // knife flip: spins once in hand while rising
    const sp = pulse(u, 0.05, 0.6);
    A.gp = [0.03 * (1 - k), -0.16 * (1 - kb), 0.04 * (1 - k)];
    A.gr = [-60 * (1 - k), 0, 0];
    A.gunExtra = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -ease.io(sp) * Math.PI * 2);
    return;
  }
  A.gp = [0.04 * (1 - k), -0.17 * (1 - kb), 0.05 * (1 - k)];
  A.gr = [-45 * (1 - kb), -12 * (1 - k), 30 * (1 - k)];
  if (hold === 'grenade' || hold === 'c4') return;
  if (!special) { if (hold === 'rifle') { const kh = pulse(u, 0.2, 0.75); lhBlend(this, A, this.handPoses.frames.L, 1, null); A.lh = lerpMatrix(mirrorM(trs([0, -0.15, 0.05], [0, 0, 0])).multiply(this.handPoses.frames.L), this.handPoses.frames.L, ease.out(kh), new THREE.Matrix4()); } return; }
  chargeAnim.call(this, A, pulse(u, 0.4, 1.0), true);
};
// charging handle / slide rack / bolt sub-animation (k: 0..1)
function chargeAnim(A, k, fromDraw) {
  const ud = this.weapon.userData;
  const type = ud.charge;
  if (type === 'bolt') { boltAnim.call(this, A, k); return; }
  if (type === 'pump') { pumpAnim.call(this, A, k); return; }
  const G = this._chargeGrip();
  const reach = pulse(k, 0.0, 0.3), pull = pulse(k, 0.32, 0.5), rel = pulse(k, 0.55, 0.62), back = pulse(k, 0.62, 0.95);
  // gun cants to expose the handle side
  const cant = bell(k, 0.0, 1.0);
  const sideSign = ud.chargePt && ud.chargePt.x < 0 ? -1 : 1;
  A.gr = A.gr || [0, 0, 0]; A.gp = A.gp || [0, 0, 0];
  A.gr = [A.gr[0] + 6 * cant, A.gr[1] - 6 * cant * sideSign, A.gr[2] + 22 * cant * sideSign];
  A.gp = [A.gp[0] - 0.02 * cant, A.gp[1] + 0.015 * cant, A.gp[2] + 0.01 * cant];
  const travel = (ud.boltTravel || 0.06) * ease.io(pull) * (1 - ease.in(rel));
  const ax = ud.boltAxis || V(0, 0, 1);
  const Gm = G.clone().premultiply(new THREE.Matrix4().makeTranslation(-ax.x * 0 + 0, ax.y * travel, ax.z * travel));
  if (this.hold === 'pistol' && !ud.chargeLeft) {
    // pistols: left hand racks the slide overhand
    lhBlend(this, A, Gm, reach * (1 - back), fullPose(POSE.pinch), reach * (1 - back));
  } else {
    lhBlend(this, A, Gm, reach * (1 - back), fullPose(POSE.pinch), reach * (1 - back));
  }
  setBolt(this, (ud.boltTravel ? travel / ud.boltTravel : 0));
  if (rel > 0 && rel < 1) { /* snap */ }
}

// ---------------------------------------------------------------- fire cycle
ACTIONS.shot = function (A, u, t, a) {
  const ud = this.weapon.userData;
  // bolt / slide cycles in ~60ms
  const c = t / 0.06;
  let d = c < 0.4 ? ease.out(c / 0.4) : c < 1 ? 1 - ease.in((c - 0.4) / 0.6) : 0;
  if (a.opts.lastShot && this.hold === 'pistol' && c >= 0.4) d = 1;   // slide lock
  setBolt(this, d * (this.hold === 'pistol' ? 1 : 0.85));
  if (ud.parts && ud.parts.hammer && this.hold === 'pistol') setPart(this, 'hammer', 0, V(1, 0, 0), -0.6 * (1 - ease.out(clamp(c, 0, 1))));
  // trigger finger squeeze
  const sq = bell(u, 0, 0.6);
  const p = this.handPoses.R; A.rhPose = { f: p.f.map((f, i) => (i === 0 ? [f[0] + 6 * sq, f[1] + 12 * sq, f[2] + 6 * sq, f[3]] : f)), t: p.t };
  if (a.opts.lastShot && this.hold === 'pistol') { a.hold = false; this._slideLocked = true; }
};
ACTIONS.shot2 = function (A, u, t, a) {
  const sd = this.weapon.userData.secondData; if (!sd || !sd.bolt) return;
  const c = t / 0.06; let d = c < 0.4 ? ease.out(c / 0.4) : c < 1 ? 1 - ease.in((c - 0.4) / 0.6) : 0;
  const r = sd.bolt.userData.rest; if (r) sd.bolt.position.copy(r.p).add(V(0, 0, d * (sd.boltTravel || 0.04)));
  const sq = bell(u, 0, 0.6); const p = this.handPoses.R; A.lhPose = { f: p.f.map((f, i) => (i === 0 ? [f[0] + 6 * sq, f[1] + 12 * sq, f[2] + 6 * sq, f[3]] : f)), t: p.t };
};
ACTIONS.dry = function (A, u) { const sq = bell(u, 0, 0.7); const p = this.handPoses.R; A.rhPose = { f: p.f.map((f, i) => (i === 0 ? [f[0] + 6 * sq, f[1] + 14 * sq, f[2] + 6 * sq, f[3]] : f)), t: p.t }; if (this._slideLocked) setBolt(this, 1); };
ACTIONS.revolve = function (A, u) { const ud = this.weapon.userData; setPart(this, 'cylinder', 0, V(0, 0, 1), ease.io(pulse(u, 0.1, 0.8)) * Math.PI / 4); setPart(this, 'hammer', 0, V(1, 0, 0), -0.5 * bell(u, 0, 1)); };
function boltAnim(A, k) {
  const ud = this.weapon.userData;
  // right hand leaves the grip, lifts the bolt handle, pulls, pushes, closes, returns
  const go = pulse(k, 0, 0.18), lift = pulse(k, 0.18, 0.3), pull = pulse(k, 0.3, 0.5), push = pulse(k, 0.55, 0.72), close = pulse(k, 0.72, 0.82), ret = pulse(k, 0.82, 1);
  const ang = (ease.io(lift) - ease.io(close)) * (ud.boltLift || 1.05);
  const tr = ease.io(pull) - ease.io(push);
  const b = ud.bolt;
  if (b) {
    const r = b.userData.rest;
    b.position.copy(r.p).addScaledVector(ud.boltAxis || V(0, 0, 1), tr * (ud.boltTravel || 0.09));
    b.quaternion.copy(r.q).multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), ang));
  }
  // right hand target: at bolt knob
  const kn = (ud.boltKnob || V(0.035, 0.07, 0.03)).clone();
  // rotate knob around bore axis with bolt, translate with travel
  const bore = ud.boreY ?? 0.07;
  const rel = V(kn.x, kn.y - bore, 0).applyAxisAngle(V(0, 0, 1), ang);
  const pos = V(rel.x, rel.y + bore, kn.z + tr * (ud.boltTravel || 0.09));
  const X = V(0, -0.3, 1), Y = V(-0.4, 0.9, 0.1);
  const H = handAt(X, Y, [0.0, 0.125, 0.012], pos.add(V(0.004, -0.002, 0)));
  const kk = ease.io(go) * (1 - ease.io(ret));
  rhBlend(this, A, H, kk, fullPose(POSE.pinch));
  if (kk < 1) A.rhPose = blendPose(this.handPoses.R, fullPose(POSE.pinch), kk);
  A.gr = [6 * bell(k, 0, 1), -4 * bell(k, 0, 1), 10 * bell(k, 0, 1)];
  A.gp = [-0.01 * bell(k, 0, 1), 0.01 * bell(k, 0, 1), 0.01 * bell(k, 0, 1)];
}
ACTIONS.boltcycle = function (A, u) { boltAnim.call(this, A, pulse(u, 0.08, 1)); };
function pumpAnim(A, k) {
  const ud = this.weapon.userData;
  const back = ease.io(pulse(k, 0.0, 0.42)), fwd = ease.io(pulse(k, 0.5, 0.92));
  const d = (back - fwd) * (ud.pumpTravel || 0.075);
  setPart(this, 'pump', d);
  setBolt(this, back - fwd);
  A.lh = mirrorM(new THREE.Matrix4().makeTranslation(0, 0, d)).multiply(this.handPoses.frames.L);
  A.gr = [3 * bell(k, 0, 1), 0, -5 * bell(k, 0, 1)];
  A.gp = [0, 0, 0.012 * bell(k, 0, 0.9)];
}
ACTIONS.pump = function (A, u) { pumpAnim.call(this, A, pulse(u, 0.15, 1)); };

// ---------------------------------------------------------------- magazine reload (rifles / smgs / mgs)
ACTIONS.reloadMag = function (A, u, t, a) {
  const ud = this.weapon.userData, empty = a.opts.empty;
  const style = ud.magDrop || 'straight';
  const G = this._magGrip();
  const T = ud.reloadTimes || {};
  const g0 = T.g0 ?? 0.05, g1 = T.g1 ?? 0.17, o1 = T.o1 ?? 0.29, away = T.away ?? 0.40, b0 = T.b0 ?? 0.43, b1 = T.b1 ?? 0.58, i1 = T.i1 ?? 0.67;
  const endTilt = empty ? 0.86 : 0.80;
  const tilt = kf([[0, 0], [0.13, 1, 'io'], [endTilt, 1], [1, 0, 'io']], u);
  const tl = ud.reloadTilt || [10, 9, -30];
  A.gr = [tl[0] * tilt, tl[1] * tilt, tl[2] * tilt];
  A.gp = [-0.045 * tilt, 0.04 * tilt, 0.02 * tilt];
  // mag path
  const outV = style === 'rock' ? V(0, -0.09, -0.015) : style === 'bullpup' ? V(0, -0.10, 0.02) : style === 'top' ? V(0, 0.07, 0.04) : V(0, -0.12, 0.0);
  const outR = style === 'rock' ? 0.42 : style === 'bullpup' ? -0.15 : style === 'top' ? -0.25 : 0.05;
  const awayV = V(0, -0.40, 0.10), awayR = 0.9;
  let off = V(), rot = 0, vis = true, attached = false;
  if (u < g1) { off.set(0, 0, 0); }
  else if (u < o1) {
    const k = pulse(u, g1, o1);
    if (style === 'rock') { const k1 = ease.io(pulse(k, 0, 0.45)), k2 = ease.in2(pulse(k, 0.35, 1)); rot = outR * k1; off.copy(outV).multiplyScalar(k2); }
    else { const kk = ease.in2(k); off.copy(outV).multiplyScalar(kk); rot = outR * kk; }
    attached = true;
  } else if (u < b0) {
    if (!a.fired.drop) { a.fired.drop = true; setMag(this, outV, outR, true); const inv = new THREE.Quaternion().copy(this.rig.quaternion).invert(); const dn = V(0, -1.2, 0); this._dropObject(ud.mag, dn, V(4 * (Math.random() - 0.5), 0, 3)); }
    vis = false; off.copy(awayV); rot = awayR;
  } else if (u < i1) {
    const k = pulse(u, b0, b1);
    const pre = style === 'rock' ? V(0, -0.045, -0.012) : style === 'top' ? V(0, 0.05, 0.03) : V(0, -0.06, 0.0);
    const preR = style === 'rock' ? 0.30 : style === 'top' ? -0.2 : 0.0;
    if (u < b1) { const kk = ease.out(k); off.lerpVectors(awayV, pre, kk); rot = lerp(awayR, preR, kk); }
    else {
      const k2 = pulse(u, b1, i1);
      if (style === 'rock') { const ka = ease.io(pulse(k2, 0, 0.5)), kb = ease.back(pulse(k2, 0.45, 1)); off.lerpVectors(pre, V(0, 0, 0), ka); rot = lerp(preR, 0, kb); }
      else { const kk = ease.back(k2); off.lerpVectors(pre, V(), kk); rot = lerp(preR, 0, kk); }
    }
    attached = true;
  }
  setMag(this, off, rot, vis);
  // gun reacts to the insert
  const slap = bell(u, i1 - 0.03, i1 + 0.06);
  A.gp[1] += 0.008 * slap; A.gr[0] += 2.5 * slap;
  // left hand
  const MM = mirrorM(magMatrix(this, off, rot)).multiply(G.H);
  if (u < g1) { const k = pulse(u, g0, g1); lhBlend(this, A, MM, k, G.pose, k); }
  else if (u < o1) { A.lh = MM; A.lhPose = G.pose; }
  else if (u < b0) {
    const k = ease.io(pulse(u, o1, away));
    const Mout = mirrorM(magMatrix(this, outV, outR)).multiply(G.H);
    const Maway = mirrorM(magMatrix(this, awayV, awayR)).multiply(G.H);
    A.lh = lerpMatrix(Mout, Maway, k, new THREE.Matrix4());
    A.lhPose = blendPose(G.pose, fullPose(POSE.open), bell(u, o1, away + 0.02));
  } else if (u < i1 + 0.02) { A.lh = MM; A.lhPose = G.pose; }
  else {
    if (empty && ud.charge && ud.charge !== 'none') {
      // from the mag to the charging handle, then back to the handguard
      const k = pulse(u, i1 + 0.02, 0.97);
      const Min = mirrorM(magMatrix(this, V(), 0)).multiply(G.H);
      const reach = pulse(k, 0, 0.3);
      if (reach < 1) { const C = this._chargeGrip(); A.lh = lerpMatrix(Min, C, ease.io(reach), new THREE.Matrix4()); A.lhPose = blendPose(G.pose, fullPose(POSE.pinch), reach); }
      else { const A2 = {}; chargeAnim.call(this, A2, 0.3 + (k - 0.3), false); A.lh = A2.lh; A.lhPose = A2.lhPose; A.gr = [A.gr[0] + (A2.gr ? A2.gr[0] * 0.3 : 0), A.gr[1], A.gr[2]]; }
      if (k >= 0.95) { A.lh = lerpMatrix(A.lh || this.handPoses.frames.L, this.handPoses.frames.L, pulse(u, 0.95, 1), new THREE.Matrix4()); }
    } else {
      const k = ease.io(pulse(u, i1 + 0.02, 0.84));
      const Min = mirrorM(magMatrix(this, V(), 0)).multiply(G.H);
      A.lh = lerpMatrix(Min, this.handPoses.frames.L, k, new THREE.Matrix4());
      A.lhPose = blendPose(G.pose, this.handPoses.L, k);
    }
  }
  if (u > 0.98) this._slideLocked = false;
};
// pistols: mag drops free, support hand fetches a new one, slide release / rack when empty
ACTIONS.reloadPistol = function (A, u, t, a) {
  const ud = this.weapon.userData, empty = a.opts.empty;
  const tilt = kf([[0, 0], [0.12, 1, 'io'], [0.82, 1], [1, 0, 'io']], u);
  A.gr = [8 * tilt, -8 * tilt, 16 * tilt];
  A.gp = [-0.02 * tilt, 0.02 * tilt, 0.01 * tilt];
  if (empty) { const rk = bell(u, 0.64, 1.0); A.gp[0] -= 0.03 * rk; A.gp[2] -= 0.05 * rk; A.gr[2] -= 20 * rk; A.gr[1] += 10 * rk; }
  const drop = pulse(u, 0.12, 0.24);
  let off = V(), vis = true;
  const dropV = V(0, -0.11, 0.01);
  if (u >= 0.12 && u < 0.24) { off.copy(dropV).multiplyScalar(ease.in2(drop)); }
  else if (u >= 0.24 && u < 0.42) { if (!a.fired.drop) { a.fired.drop = true; setMag(this, dropV, 0, true); this._dropObject(ud.mag, V(0, -1.5, 0.1), V(2, 0, 1)); } vis = false; }
  else if (u >= 0.42 && u < 0.64) {
    const k = pulse(u, 0.42, 0.56);
    if (u < 0.56) off.lerpVectors(V(0, -0.35, 0.05), V(0, -0.06, 0.0), ease.out(k));
    else off.lerpVectors(V(0, -0.06, 0), V(), ease.back(pulse(u, 0.56, 0.64)));
  }
  setMag(this, off, 0, vis);
  // thumb on mag release
  if (u < 0.2) { const p = this.handPoses.R; const k = bell(u, 0.06, 0.2); A.rhPose = { f: p.f, t: [p.t[0], p.t[1] + 12 * k, p.t[2] + 15 * k, p.t[3]] }; }
  // left hand: support -> down -> holds new mag below grip -> pushes in -> (rack slide) -> support
  const G = this._magGrip();
  const MM = mirrorM(magMatrix(this, off, 0)).multiply(G.H);
  const Maway = mirrorM(magMatrix(this, V(0, -0.35, 0.05), 0)).multiply(G.H);
  if (u < 0.42) { const k = pulse(u, 0.08, 0.3); lhBlend(this, A, Maway, k, fullPose(POSE.open), k); }
  else if (u < 0.66) { A.lh = MM; A.lhPose = G.pose; }
  else if (empty) {
    const k = pulse(u, 0.66, 0.97);
    const C = this._chargeGrip();
    const reach = pulse(k, 0, 0.3);
    if (reach < 1) { A.lh = lerpMatrix(MM, C, ease.io(reach), new THREE.Matrix4()); A.lhPose = blendPose(G.pose, fullPose(POSE.pinch), reach); setBolt(this, 1); }
    else { const A2 = {}; chargeAnim.call(this, A2, k, false); A.lh = A2.lh; A.lhPose = A2.lhPose; const pull = pulse(k, 0.32, 0.5), rel = pulse(k, 0.55, 0.62); setBolt(this, 1 - ease.in(rel)); }
  } else { const k = ease.io(pulse(u, 0.66, 0.86)); A.lh = lerpMatrix(MM, this.handPoses.frames.L, k, new THREE.Matrix4()); A.lhPose = blendPose(G.pose, this.handPoses.L, k); if (this._slideLocked) setBolt(this, 1); }
  if (u > 0.98) this._slideLocked = false;
};
// shotgun tube loading
function shellPose(vm) {
  const ud = vm.weapon.userData;
  const p = ud.loadPort ? ud.loadPort.clone() : V(0, 0.04, -0.12);
  const X = V(0, 0, -1), Y = V(-0.2, 0.9, -0.1);
  return handAt(X, Y, [0.0, 0.085, 0.004], V(-p.x, p.y - 0.004, p.z + 0.02));
}
ACTIONS.shellStart = function (A, u) {
  const k = ease.io(u);
  A.gr = [10 * k, -8 * k, -38 * k]; A.gp = [-0.04 * k, 0.03 * k, 0.03 * k];
  lhBlend(this, A, shellPose(this), k, fullPose(POSE.pinch), k);
  this._shellHeld = false;
};
ACTIONS.shellIn = function (A, u) {
  A.gr = [10, -8, -38]; A.gp = [-0.04, 0.03, 0.03];
  const P0 = shellPose(this);
  const down = mirrorM(trs([0, -0.16, 0.08], [0, 0, 0])).multiply(P0);
  const push = mirrorM(trs([0, 0.016, -0.03], [0, 0, 0])).multiply(P0);
  let M;
  if (u < 0.3) M = lerpMatrix(P0, down, ease.in2(pulse(u, 0, 0.3)), new THREE.Matrix4());
  else if (u < 0.65) M = lerpMatrix(down, P0, ease.out(pulse(u, 0.3, 0.65)), new THREE.Matrix4());
  else if (u < 0.82) M = lerpMatrix(P0, push, ease.io(pulse(u, 0.65, 0.82)), new THREE.Matrix4());
  else M = lerpMatrix(push, P0, ease.io(pulse(u, 0.82, 1)), new THREE.Matrix4());
  A.lh = M; A.lhPose = fullPose(POSE.pinch);
  this._showShell(u > 0.22 && u < 0.8);
  A.gp[1] += 0.004 * bell(u, 0.75, 0.9);
};
ACTIONS.shellEnd = function (A, u) {
  const k = 1 - ease.io(u);
  A.gr = [10 * k, -8 * k, -38 * k]; A.gp = [-0.04 * k, 0.03 * k, 0.03 * k];
  A.lh = lerpMatrix(this.handPoses.frames.L, shellPose(this), k, new THREE.Matrix4());
  A.lhPose = blendPose(this.handPoses.L, fullPose(POSE.pinch), k);
  this._showShell(false);
};
ACTIONS.reloadDual = function (A, u, t, a) {
  const ud = this.weapon.userData, sd = ud.secondData;
  const tilt = kf([[0, 0], [0.15, 1, 'io'], [0.8, 1], [1, 0, 'io']], u);
  A.gr = [25 * tilt, 0, 10 * tilt]; A.gp = [0.01 * tilt, 0.02 * tilt, 0.0];
  A.g2 = new THREE.Matrix4();
  const off = u < 0.15 ? V() : u < 0.28 ? V(0, -0.12 * ease.in2(pulse(u, 0.15, 0.28)), 0) : u < 0.55 ? V(0, -0.4, 0) : u < 0.72 ? V(0, -0.3 * (1 - ease.out(pulse(u, 0.55, 0.72))), 0) : V();
  if (u >= 0.28 && !a.fired.drop) { a.fired.drop = true; this._dropObject(ud.mag, V(0, -1.3, 0.1), V(2, 0, 1)); if (sd && sd.mag) this._dropObject(sd.mag, V(0, -1.3, 0.1), V(2, 0, -1)); }
  setMag(this, off, 0, !(u >= 0.28 && u < 0.55));
  if (sd && sd.mag && sd.mag.userData.rest) { sd.mag.position.copy(sd.mag.userData.rest.p).add(off); sd.mag.visible = !(u >= 0.28 && u < 0.55); }
  // both hands swing down to "slap" new mags in (gun dip)
  const dip = bell(u, 0.5, 0.8); A.gp[1] -= 0.05 * dip; A.gr[0] += 15 * dip;
};
// revolver: swing the cylinder, eject, reload with the support hand, close
ACTIONS.reloadRevolver = function (A, u) {
  const tilt = kf([[0, 0], [0.12, 1, 'io'], [0.85, 1], [1, 0, 'io']], u);
  A.gr = [25 * tilt, -10 * tilt, 35 * tilt]; A.gp = [-0.03 * tilt, 0.03 * tilt, 0.02 * tilt];
  const swing = ease.io(pulse(u, 0.1, 0.22)) * (1 - ease.io(pulse(u, 0.78, 0.86)));
  const ud = this.weapon.userData;
  if (ud.parts && ud.parts.cylinder) { const c = ud.parts.cylinder; if (!c.userData.rest) c.userData.rest = { p: c.position.clone(), q: c.quaternion.clone() }; c.position.copy(c.userData.rest.p).add(V(-0.03 * swing, -0.012 * swing, 0)); c.quaternion.copy(c.userData.rest.q).multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), u * 6)); }
  const away = mirrorM(trs([0, -0.22, 0.06], [0, 0, 0])).multiply(this.handPoses.frames.L);
  const near = mirrorM(trs([0.02, -0.03, -0.04], [0, 0, 0])).multiply(this.handPoses.frames.L);
  let M;
  if (u < 0.3) M = lerpMatrix(this.handPoses.frames.L, away, ease.io(pulse(u, 0.15, 0.3)), new THREE.Matrix4());
  else if (u < 0.55) M = lerpMatrix(away, near, ease.out(pulse(u, 0.35, 0.55)), new THREE.Matrix4());
  else if (u < 0.75) M = near; else M = lerpMatrix(near, this.handPoses.frames.L, ease.io(pulse(u, 0.85, 1)), new THREE.Matrix4());
  A.lh = M; A.lhPose = blendPose(this.handPoses.L, fullPose(POSE.pinch), bell(u, 0.15, 0.95));
};
// shotgun reload when the engine uses the single reload() call: one combined load cycle
ACTIONS.reloadShells = function (A, u, t, a) {
  if (u < 0.25) ACTIONS.shellStart.call(this, A, u / 0.25);
  else if (u < 0.8) { ACTIONS.shellIn.call(this, A, ((u - 0.25) / 0.55 * 2) % 1); }
  else ACTIONS.shellEnd.call(this, A, (u - 0.8) / 0.2);
};
// ---------------------------------------------------------------- inspect
ACTIONS.inspect = function (A, u) {
  const k1 = ease.io(pulse(u, 0.0, 0.2)), k2 = ease.io(pulse(u, 0.42, 0.62)), k3 = ease.io(pulse(u, 0.8, 1.0));
  const drift = Math.sin(u * Math.PI * 3) * 0.6;
  // pose 1: rotate to show the right side, raised toward centre; pose 2: tilt to show the top/left
  const p1 = { r: [-6, 48, -38], p: [-0.075, 0.05, 0.05] }, p2 = { r: [22, -12, 38], p: [-0.04, 0.025, 0.02] };
  const r = [0, 1, 2].map((i) => lerp(lerp(0, p1.r[i], k1), p2.r[i], k2) * (1 - k3));
  const p = [0, 1, 2].map((i) => lerp(lerp(0, p1.p[i], k1), p2.p[i], k2) * (1 - k3));
  A.gr = [r[0] + drift, r[1] + drift * 0.6, r[2]]; A.gp = p;
  if (this.hold === 'pistol') { // pistol: support hand drops away
    const kk = ease.io(pulse(u, 0.0, 0.15)) * (1 - ease.io(pulse(u, 0.85, 1)));
    lhBlend(this, A, mirrorM(trs([0, -0.25, 0.08], [0, 0, 0])).multiply(this.handPoses.frames.L), kk, fullPose(POSE.relaxed), kk);
  }
};
ACTIONS.inspectSmall = function (A, u) {
  const k1 = ease.io(pulse(u, 0, 0.25)), k2 = ease.io(pulse(u, 0.45, 0.65)), k3 = ease.io(pulse(u, 0.8, 1));
  A.gr = [lerp(lerp(0, 25, k1), -10, k2) * (1 - k3), lerp(lerp(0, -60, k1), 50, k2) * (1 - k3), lerp(0, 20, k1) * (1 - k3)];
  A.gp = [-0.04 * (k1) * (1 - k3), 0.04 * k1 * (1 - k3), 0.03 * k1 * (1 - k3)];
};
ACTIONS.inspectKnife = function (A, u) {
  // raise, show blade side, flip in fingers (spin about handle axis), show other side, return
  const k1 = ease.io(pulse(u, 0, 0.2)), sp = ease.io(pulse(u, 0.4, 0.6)), k3 = ease.io(pulse(u, 0.82, 1));
  A.gp = [-0.07 * k1 * (1 - k3), 0.06 * k1 * (1 - k3), 0.05 * k1 * (1 - k3)];
  A.gr = [15 * k1 * (1 - k3), 35 * k1 * (1 - k3), -70 * k1 * (1 - k3)];
  A.gunExtra = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), sp * Math.PI * (1 - k3));
};
// ---------------------------------------------------------------- knife
ACTIONS.slash = function (A, u, t, a) {
  const L = a.opts.left ? 1 : -1;
  const w = ease.out(pulse(u, 0, 0.18)), s = ease.io(pulse(u, 0.14, 0.42)), r = ease.io(pulse(u, 0.5, 1));
  const start = { p: [0.05 * L, 0.05, 0.02], r: [-15, -40 * L, -45 * L] }, end = { p: [-0.16 * L, -0.06, -0.06], r: [-10, 60 * L, 35 * L] };
  const pp = [0, 1, 2].map((i) => lerp(lerp(0, start.p[i], w), end.p[i], s) * (1 - r));
  const rr = [0, 1, 2].map((i) => lerp(lerp(0, start.r[i], w), end.r[i], s) * (1 - r));
  A.gp = pp; A.gr = rr;
};
ACTIONS.stab = function (A, u) {
  const w = ease.io(pulse(u, 0, 0.35)), s = ease.out(pulse(u, 0.35, 0.5)), r = ease.io(pulse(u, 0.6, 1));
  A.gp = [lerp(lerp(0, 0.02, w), -0.07, s) * (1 - r), lerp(lerp(0, 0.06, w), -0.01, s) * (1 - r), lerp(lerp(0, 0.06, w), -0.17, s) * (1 - r)];
  A.gr = [lerp(lerp(0, 35, w), -20, s) * (1 - r), lerp(lerp(0, -15, w), 15, s) * (1 - r), lerp(lerp(0, -30, w), 10, s) * (1 - r)];
};
// ---------------------------------------------------------------- grenades
ACTIONS.pull = function (A, u, t, a) {
  const ud = this.weapon.userData;
  // left hand to ring, pull pin, both hands ready (right arm cocked back a bit)
  const reach = ease.io(pulse(u, 0, 0.35)), pull = ease.io(pulse(u, 0.35, 0.6)), ready = ease.io(pulse(u, 0.55, 1));
  const ring = (ud.ringPt || V(0.02, 0.06, 0)).clone();
  const mr = V(-ring.x, ring.y, ring.z);
  const H = handAt(V(0, 0, 1), V(-0.45, 0.9, 0), [0.0, 0.118, 0.012], mr.clone().add(V(0.006, -0.004, 0)));
  const pulled = mirrorM(trs([-0.06 * pull, -0.03 * pull, 0.02 * pull], [0, 0, 0])).multiply(H);
  if (ud.parts && ud.parts.pin) {
    A.lh = lerpMatrix(lerpMatrix(this.handPoses.frames.L, H, reach, new THREE.Matrix4()), pulled, pull, new THREE.Matrix4());
    A.lhPose = blendPose(this.handPoses.L, fullPose(POSE.pinch), reach);
  }
  if (ud.parts && ud.parts.pin) {
    const pin = ud.parts.pin; if (!pin.userData.rest) pin.userData.rest = { p: pin.position.clone(), q: pin.quaternion.clone() };
    pin.position.copy(pin.userData.rest.p).add(V(0.06 * pull, -0.03 * pull, 0.02 * pull));
    pin.quaternion.copy(pin.userData.rest.q).multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), -0.8 * pull));
    if (ud.parts.spoon) setPart(this, 'spoon', 0);
  }
  const mid = bell(u, 0.05, 0.8);
  A.gp = [-0.035 * mid, 0.025 * mid + 0.03 * ready, 0.03 * ready]; A.gr = [12 * ready, -5 * ready, 8 * ready - 10 * mid];
  if (u >= 1) a.hold = true;
};
ACTIONS.throw = function (A, u, t, a) {
  const str = a.opts.strength ?? 1;
  const over = str > 0.75;
  const back = ease.out(pulse(u, 0, 0.3)), fwd = ease.in2(pulse(u, 0.3, 0.55)), follow = ease.out(pulse(u, 0.55, 1));
  if (over) {
    A.gp = [lerp(lerp(0, 0.02, back), -0.10, fwd), lerp(lerp(0.03, 0.065, back), 0.02, fwd) - 0.3 * follow, lerp(lerp(0.03, 0.06, back), -0.22, fwd) + 0.1 * follow];
    A.gr = [lerp(lerp(12, 75, back), -50, fwd) - 20 * follow, lerp(0, -10, back), lerp(8, 25, back) * (1 - fwd)];
  } else {
    A.gp = [lerp(lerp(0, 0.02, back), -0.06, fwd), lerp(lerp(0.03, -0.12, back), -0.02, fwd) - 0.25 * follow, lerp(lerp(0.03, 0.08, back), -0.18, fwd)];
    A.gr = [lerp(lerp(12, -40, back), 30, fwd) - 10 * follow, 0, 0];
  }
  A.hideWeapon = u > 0.45;
  // left hand drops away
  A.lh = mirrorM(trs([0.05, -0.25 * ease.io(pulse(u, 0, 0.5)), 0.05], [0, 0, 0])).multiply(this.handPoses.frames.L);
  A.lhPose = fullPose(POSE.relaxed);
  if (u > 0.9) A.hideAll = true;
  if (u >= 1) { a.hold = true; this._thrown = true; }
};
// ---------------------------------------------------------------- C4
ACTIONS.plant = function (A, u, t, a) {
  const ud = this.weapon.userData;
  const code = '7355608';
  const keys = ud.keys || [];
  const n = Math.min(code.length, Math.floor(u * 1.25 * code.length));
  const kt = (u * 1.25 * code.length) % 1;
  const lower = ease.io(pulse(u, 0, 0.12));
  A.gp = [-0.02 * lower, -0.015 * lower, 0.07 * lower]; A.gr = [16 * lower, 8 * lower, 0];
  if (n < code.length && keys.length) {
    const kp = keys[(code.charCodeAt(n) - 48) % keys.length] || keys[0];
    const prev = n > 0 ? (keys[(code.charCodeAt(n - 1) - 48) % keys.length] || keys[0]) : kp;
    const pos = V().lerpVectors(prev, kp, ease.io(pulse(kt, 0, 0.5)));
    const press = bell(kt, 0.5, 1.0);
    // index fingertip above key
    const H = handAt(V(-0.35, 0, 0.85), V(-0.85, -0.45, -0.35), [0.0285, 0.172, 0.004], pos.clone().add(V(0, 0.010 - 0.007 * press, 0.0)));
    const k = ease.io(pulse(u, 0.02, 0.1));
    rhBlend(this, A, H, k, fullPose(POSE.point));
  }
  const shown = '*'.repeat(n);
  if (this._lcdText !== shown) this._setLCD(shown);
  if (u >= 1) { a.hold = true; }
};
Object.assign(ViewModel.prototype, {
  _setLCD(text) {
    this._lcdText = text;
    const ud = this.weapon && this.weapon.userData; if (!ud || !ud.lcd) return;
    const { ctx, tex, w, h } = ud.lcd;
    ctx.fillStyle = '#1b2a12'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#9fe070'; ctx.font = `bold ${Math.floor(h * 0.7)}px "DejaVu Sans Mono", monospace`; ctx.textBaseline = 'middle';
    ctx.fillText(text || '', 6, h * 0.55);
    tex.needsUpdate = true;
  },
  _showShell(v) {
    if (!this._handShell) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.0105, 0.0105, 0.055, 14), MAT.paintRed); body.position.y = 0.0;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.0112, 0.0112, 0.012, 14), MAT.brass); base.position.y = -0.03;
      g.add(body, base); g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this._handShell = g;
    }
    const hand = this.armL.hand.root;
    if (v && this._handShell.parent !== hand) { hand.add(this._handShell); this._handShell.position.set(0.012, 0.115, 0.012); this._handShell.rotation.set(0, 0, Math.PI / 2); }
    this._handShell.visible = !!v;
  },
  _idleParts(A) {
    if (this._slideLocked) setBolt(this, 1);
    if (this._thrown) { A.hideAll = true; }
    if (this.hold === 'c4' && this.action == null) {}
  },
});

// exercise every weapon through every action (used by test_weapons.html?stress=1)
export function stressTest(vm, ids) {
  const errs = [];
  const step = (n, dt = 1 / 30) => { for (let i = 0; i < n; i++) vm.update(dt, { speed: 200, maxSpeed: 250, onGround: true, yawDelta: 0.01, pitchDelta: -0.005 }); };
  for (const id of ids) {
    try {
      vm.setTeam(Math.random() < 0.5 ? 't' : 'ct');
      vm.equip(id, 0.6); step(25);
      vm.fire({ shotIndex: 0, lastShot: false }); step(10); vm.fire({ shotIndex: 1, lastShot: true }); step(40);
      vm.dryFire(); step(10);
      vm.reload(2.0, { empty: true }); step(70);
      vm.reloadStart(0.4); step(14); vm.reloadShell(0.4); step(14); vm.reloadEnd(0.5); step(18);
      vm.inspect(); step(110);
      vm.knifeAttack(false); step(15); vm.knifeAttack(true); step(30);
      vm.grenadePull(); step(20); vm.grenadeThrow(1); step(25);
      vm.c4Plant(true); step(40); vm.c4Plant(false); step(5);
      vm.setScoped(true); step(2); vm.setScoped(false);
      vm.update(1 / 60, { landed: 1, onGround: true });
    } catch (e) { errs.push(id + ': ' + e.message + ' ' + (e.stack || '').split('\n')[1]); }
  }
  return errs;
}
