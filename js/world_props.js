// world_props.js — CS2-style Dust II set dressing (purely visual: never part of collision, BVH or nav).
// Placements are baked by tools/world_props_gen.mjs into assets/world/props.json; geometry is built here and merged
// into a handful of meshes: opaque (atlas), foliage (alpha-tested), emissive bulbs, glow sprites (+ a few point lights).
import * as THREE from 'three';

const CELL = 256, ATLAS = 1024;     // 4x4 atlas of 256px cells
const C = { wood: 0, woodDark: 1, shTeal: 2, shBlue: 3, shGreen: 4, shOchre: 5, glass: 6, metalW: 7, metalD: 8,
  clothR: 9, clothB: 10, clothG: 11, clothO: 12, bark: 13, grille: 14, plaster: 15 };
const SHUTTERS = [C.shTeal, C.shBlue, C.shGreen, C.shOchre];
const CLOTHS = [C.clothR, C.clothB, C.clothG, C.clothO];

// ---------------------------------------------------------------- procedural textures
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function makeAtlas() {
  const cv = document.createElement('canvas'); cv.width = cv.height = ATLAS; const g = cv.getContext('2d');
  const R = rng(7);
  const cell = (i) => [(i % 4) * CELL, Math.floor(i / 4) * CELL];
  const noise = (x0, y0, w, h, amt, n = 2600, size = 2) => { for (let k = 0; k < n; k++) { const v = R() < 0.5 ? 0 : 255; g.fillStyle = `rgba(${v},${v},${v},${R() * amt})`; g.fillRect(x0 + R() * w, y0 + R() * h, size * (0.5 + R()), size * (0.5 + R())); } };
  const wood = (i, base, dark) => {
    const [x, y] = cell(i); g.fillStyle = base; g.fillRect(x, y, CELL, CELL);
    for (let k = 0; k < 90; k++) { g.strokeStyle = `rgba(${dark},${R() * 0.35 + 0.05})`; g.lineWidth = 0.6 + R() * 2.2; g.beginPath(); const yy = y + R() * CELL; g.moveTo(x, yy); g.bezierCurveTo(x + 80, yy + (R() - 0.5) * 8, x + 170, yy + (R() - 0.5) * 8, x + CELL, yy + (R() - 0.5) * 6); g.stroke(); }
    for (let k = 0; k < 5; k++) { g.fillStyle = `rgba(${dark},0.45)`; g.beginPath(); g.ellipse(x + R() * CELL, y + R() * CELL, 3 + R() * 5, 2 + R() * 2, 0, 0, 7); g.fill(); }
    noise(x, y, CELL, CELL, 0.08);
  };
  wood(C.wood, '#8a6542', '40,24,12'); wood(C.woodDark, '#5e4a3a', '25,18,12');
  const shutter = (i, paint) => {
    const [x, y] = cell(i); g.fillStyle = '#6b5240'; g.fillRect(x, y, CELL, CELL);
    g.fillStyle = paint; g.fillRect(x, y, CELL, CELL);
    for (let yy = 8; yy < CELL; yy += 14) { g.fillStyle = 'rgba(0,0,0,0.32)'; g.fillRect(x + 10, y + yy + 9, CELL - 20, 3); g.fillStyle = 'rgba(255,255,255,0.14)'; g.fillRect(x + 10, y + yy, CELL - 20, 2); }
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x, y, 10, CELL); g.fillRect(x + CELL - 10, y, 10, CELL); g.fillRect(x, y, CELL, 6); g.fillRect(x, y + CELL - 6, CELL, 6);
    for (let k = 0; k < 26; k++) { g.fillStyle = `rgba(150,118,86,${0.5 + R() * 0.4})`; g.beginPath(); g.ellipse(x + R() * CELL, y + R() * CELL, 2 + R() * 12, 1 + R() * 5, R() * 3, 0, 7); g.fill(); }
    const gr = g.createLinearGradient(0, y, 0, y + CELL); gr.addColorStop(0, 'rgba(255,240,210,0.0)'); gr.addColorStop(1, 'rgba(120,90,60,0.25)'); g.fillStyle = gr; g.fillRect(x, y, CELL, CELL);
    noise(x, y, CELL, CELL, 0.1);
  };
  shutter(C.shTeal, '#2f8f8c'); shutter(C.shBlue, '#2d6fa8'); shutter(C.shGreen, '#4f8a4a'); shutter(C.shOchre, '#2a7f9e');
  { const [x, y] = cell(C.glass); const gr = g.createLinearGradient(x, y, x + CELL, y + CELL); gr.addColorStop(0, '#2a3138'); gr.addColorStop(0.5, '#141a20'); gr.addColorStop(1, '#232a2f'); g.fillStyle = gr; g.fillRect(x, y, CELL, CELL); noise(x, y, CELL, CELL, 0.05); }
  { const [x, y] = cell(C.metalW); g.fillStyle = '#d8d4cb'; g.fillRect(x, y, CELL, CELL); for (let k = 0; k < 14; k++) { g.fillStyle = `rgba(140,80,40,${0.08 + R() * 0.15})`; g.fillRect(x + R() * CELL, y + R() * 40, 2 + R() * 4, 60 + R() * 150); } noise(x, y, CELL, CELL, 0.12); }
  { const [x, y] = cell(C.metalD); g.fillStyle = '#2b2a28'; g.fillRect(x, y, CELL, CELL); noise(x, y, CELL, CELL, 0.12); }
  const cloth = (i, a, b2) => { const [x, y] = cell(i); for (let k = 0; k < 8; k++) { g.fillStyle = k % 2 ? b2 : a; g.fillRect(x + k * 32, y, 32, CELL); } for (let k = 0; k < 400; k++) { g.fillStyle = `rgba(0,0,0,${R() * 0.05})`; g.fillRect(x, y + R() * CELL, CELL, 1); } const gr = g.createLinearGradient(0, y, 0, y + CELL); gr.addColorStop(0, 'rgba(255,255,255,0.08)'); gr.addColorStop(1, 'rgba(90,60,30,0.3)'); g.fillStyle = gr; g.fillRect(x, y, CELL, CELL); noise(x, y, CELL, CELL, 0.06); };
  cloth(C.clothR, '#b23a2c', '#e9dcc0'); cloth(C.clothB, '#2c5d9a', '#e7dfc8'); cloth(C.clothG, '#3e7a4e', '#e5dcc2'); cloth(C.clothO, '#c98b2e', '#d9c6a0');
  { const [x, y] = cell(C.bark); g.fillStyle = '#7d6a52'; g.fillRect(x, y, CELL, CELL); for (let yy = 0; yy < CELL; yy += 12) for (let xx = (yy / 12) % 2 * 10; xx < CELL; xx += 20) { g.fillStyle = 'rgba(40,30,20,0.45)'; g.beginPath(); g.moveTo(x + xx, y + yy); g.lineTo(x + xx + 10, y + yy + 12); g.lineTo(x + xx + 20, y + yy); g.closePath(); g.fill(); } noise(x, y, CELL, CELL, 0.12); }
  { const [x, y] = cell(C.grille); g.fillStyle = '#cfcac0'; g.fillRect(x, y, CELL, CELL); g.fillStyle = '#3a3a38'; g.beginPath(); g.arc(x + 128, y + 128, 96, 0, 7); g.fill(); g.strokeStyle = '#bdb8ae'; g.lineWidth = 3; for (let r = 12; r < 96; r += 10) { g.beginPath(); g.arc(x + 128, y + 128, r, 0, 7); g.stroke(); } g.fillStyle = '#8a857c'; g.fillRect(x + 120, y + 30, 16, 196); g.fillRect(x + 30, y + 120, 196, 16); noise(x, y, CELL, CELL, 0.1); }
  { const [x, y] = cell(C.plaster); g.fillStyle = '#e8d6bb'; g.fillRect(x, y, CELL, CELL); noise(x, y, CELL, CELL, 0.12, 4000, 3); }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
// foliage: [0,0.5]x[0,1] palm frond, [0.5,1]x[0.5,1] vine leaves, [0.5,1]x[0,0.5] bush
function makeFoliage() {
  const S = 512; const cv = document.createElement('canvas'); cv.width = cv.height = S; const g = cv.getContext('2d'); const R = rng(11);
  g.clearRect(0, 0, S, S);
  // palm frond (rib along the canvas height, x center 128)
  for (let i = 0; i < 70; i++) {
    const t = i / 70, yy = 8 + t * (S - 16), len = 18 + 100 * Math.sin(Math.PI * Math.min(1, t * 1.1)) * (1 - t * 0.25);
    for (const side of [-1, 1]) {
      const col = `rgb(${40 + R() * 40 + t * 70},${95 + R() * 50 + t * 20},${30 + R() * 25})`;
      g.strokeStyle = col; g.lineWidth = 3.2 + R() * 1.5; g.beginPath(); g.moveTo(128, yy); g.quadraticCurveTo(128 + side * len * 0.6, yy - 6, 128 + side * len, yy + 14 + R() * 8); g.stroke();
    }
  }
  g.strokeStyle = '#6b6a3a'; g.lineWidth = 4; g.beginPath(); g.moveTo(128, 0); g.lineTo(128, S); g.stroke();
  // vine leaves
  const leaf = (x, y, r, col) => { g.fillStyle = col; g.beginPath(); g.ellipse(x, y, r, r * 0.7, R() * 6, 0, 7); g.fill(); };
  for (let k = 0; k < 900; k++) { const x = 256 + 10 + R() * 236, y = 10 + R() * 236 * Math.pow(R(), 0.6); leaf(x, y, 4 + R() * 6, `rgb(${40 + R() * 40},${90 + R() * 60},${30 + R() * 30})`); }
  for (let k = 0; k < 120; k++) { const x = 256 + 10 + R() * 236, y = 10 + R() * 236; leaf(x, y, 3 + R() * 4, `rgb(${170 + R() * 60},${60 + R() * 40},${110 + R() * 60})`); } // bougainvillea blossoms
  // bush
  for (let k = 0; k < 1300; k++) { const a = R() * 6.28, rr = Math.sqrt(R()) * 110; const x = 384 + Math.cos(a) * rr, y = 384 + Math.sin(a) * rr * 0.9; leaf(x, y, 4 + R() * 6, `rgb(${50 + R() * 50},${90 + R() * 60},${35 + R() * 30})`); }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

// ---------------------------------------------------------------- geometry accumulation
class Batch {
  constructor() { this.p = []; this.n = []; this.uv = []; }
  add(geo, m, rect) {   // rect = [u0, v0, u1, v1] in atlas space (0..1)
    const g = geo.index ? geo.toNonIndexed() : geo; g.applyMatrix4(m);
    const P = g.attributes.position.array, N = g.attributes.normal.array, U = g.attributes.uv.array;
    for (let i = 0; i < P.length; i++) { this.p.push(P[i]); this.n.push(N[i]); }
    for (let i = 0; i < U.length; i += 2) { this.uv.push(rect[0] + U[i] * (rect[2] - rect[0]), rect[1] + U[i + 1] * (rect[3] - rect[1])); }
    if (g !== geo) g.dispose(); geo.dispose();
  }
  tris() { return this.p.length / 9; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere(); g.computeBoundingBox(); return g;
  }
}
const cellRect = (i) => { const x = i % 4, y = Math.floor(i / 4), e = 3 / ATLAS; return [x / 4 + e, 1 - (y + 1) / 4 + e, (x + 1) / 4 - e, 1 - y / 4 - e]; };
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
function wallFrame(x, y, z, nx, nz) { // local x along wall (right), y up, z out of the wall
  const T = new THREE.Vector3(nz, 0, -nx), Y = new THREE.Vector3(0, 1, 0), N = new THREE.Vector3(nx, 0, nz);
  return new THREE.Matrix4().makeBasis(T, Y, N).setPosition(x, y, z);
}
const local = (F, x, y, z, rx = 0, ry = 0, rz = 0) => F.clone().multiply(_m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s));
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// ---------------------------------------------------------------- builders
function addWindow(B, E, w) {
  const [x, y, z, nx, nz, W, H, variant, open] = w; const F = wallFrame(x, y, z, nx, nz);
  const wood = cellRect(C.woodDark), sh = cellRect(SHUTTERS[variant % 4]);
  B.add(new THREE.PlaneGeometry(W - 6, H - 6), local(F, 0, 0, 0.6), cellRect(C.glass));
  B.add(box(4, H, 5), local(F, -W / 2 + 2, 0, 2.5), wood); B.add(box(4, H, 5), local(F, W / 2 - 2, 0, 2.5), wood);
  B.add(box(W + 8, 5, 6), local(F, 0, H / 2 + 2.5, 3), wood); B.add(box(W + 14, 4, 9), local(F, 0, -H / 2 - 2, 4.5), cellRect(C.plaster));
  B.add(box(2, H - 6, 2), local(F, 0, 0, 1.5), wood); B.add(box(W - 6, 2, 2), local(F, 0, H * 0.1, 1.5), wood);
  const sw = W / 2;
  if (open) { // shutters swung open (hinged at the frame sides, ~110 degrees)
    for (const sg of [-1, 1]) { const ang = sg * (1.75 + (variant % 3) * 0.12); const hx = sg * W / 2, vx = -sg * sw / 2;
      const cx = hx + vx * Math.cos(ang), cz = 4 - vx * Math.sin(ang);
      B.add(box(sw - 1, H - 2, 2), local(F, cx, 0, cz, 0, ang, 0), sh); }
  } else { // closed louvred shutters
    B.add(box(sw - 1, H - 2, 2), local(F, -sw / 2, 0, 6), sh); B.add(box(sw - 1, H - 2, 2), local(F, sw / 2, 0, 6), sh);
  }
}
function addWindowCanopy(B, w) {   // small cloth canopy over some windows
  const [x, y, z, nx, nz, W, H, variant, open, canopy] = w; if (canopy === undefined || canopy < 0) return;
  addAwning(B, [x, y + H / 2 + 22, z, nx, nz, W + (open ? 60 : 18), 30, canopy], 12);
}
function addBeam(B, b) {
  const [x, y, z, nx, nz, len] = b; const F = wallFrame(x, y, z, nx, nz);
  B.add(box(9, 9, len), local(F, 0, 0, len / 2 - 2, (Math.random() - 0.5) * 0.06, 0, (Math.random() - 0.5) * 0.3), cellRect(C.woodDark));
}
function addLamp(B, E, glows, l) {
  const [x, y, z, nx, nz, kind] = l; const F = wallFrame(x, y, z, nx, nz); const md = cellRect(C.metalD);
  if (kind === 1) { // flush caged tunnel lamp
    B.add(box(12, 4, 6), local(F, 0, -8, 3), md); B.add(box(12, 4, 6), local(F, 0, 8, 3), md);
    for (const sx of [-5, 5]) B.add(box(1.5, 16, 1.5), local(F, sx, 0, 6), md);
    E.add(box(7, 11, 5), local(F, 0, 0, 3), [0, 0, 1, 1]);
    glows.push(new THREE.Vector3(0, 0, 8).applyMatrix4(F));
  } else { // bracket + hanging lantern
    B.add(box(6, 10, 3), local(F, 0, 10, 1.5), md);
    B.add(box(2.5, 2.5, 24), local(F, 0, 12, 12), md); B.add(box(2, 9, 2), local(F, 0, 7.5, 22), md);
    B.add(box(11, 3, 11), local(F, 0, 2, 22), md); B.add(box(13, 2.5, 13), local(F, 0, -13, 22), md);
    for (const [sx, sz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) B.add(box(1.4, 14, 1.4), local(F, sx, -5.5, 22 + sz), md);
    E.add(box(8, 12, 8), local(F, 0, -5.5, 22), [0, 0, 1, 1]);
    glows.push(new THREE.Vector3(0, -5, 22).applyMatrix4(F));
  }
}
function addVine(Fo, v) {
  const [x, y, z, nx, nz, w, h] = v; const F = wallFrame(x, y, z, nx, nz); const r = rng(Math.abs(x * 13 + z * 7) | 0);
  const vr = [0.5, 0.5, 1, 1];
  for (let k = 0; k < 5; k++) { const ww = w * (0.5 + r() * 0.6), hh = h * (0.4 + r() * 0.6); Fo.add(new THREE.PlaneGeometry(ww, hh), local(F, (r() - 0.5) * w * 0.6, -hh / 2 + 4, 1.2 + k * 0.4), vr); }
  for (let k = 0; k < 3; k++) Fo.add(new THREE.PlaneGeometry(w * (0.3 + r() * 0.3), 16 + r() * 8), local(F, (r() - 0.5) * w * 0.6, 5, 4, -0.9 - r() * 0.4, (r() - 0.5) * 0.6, 0), vr);   // tufts spilling over the top
}
function addBanner(B, bn) {
  const [x, y, z, nx, nz, w, h, variant] = bn; const F = wallFrame(x, y, z, nx, nz);
  const g = new THREE.PlaneGeometry(w, h, 4, 8); const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, 2.5 + Math.sin(p.getY(i) * 0.08 + p.getX(i) * 0.05) * 1.2);
  g.computeVertexNormals();
  B.add(g, local(F, 0, -h / 2, 0), cellRect(CLOTHS[variant % 4]));
  B.add(box(w + 8, 2.5, 2.5), local(F, 0, 1, 3), cellRect(C.woodDark));
}
function addAwning(B, a, dropIn = 24) {
  const [x, y, z, nx, nz, w, depth, variant] = a; const F = wallFrame(x, y, z, nx, nz);
  const drop = dropIn; const L = Math.hypot(depth, drop); const ang = Math.atan2(drop, depth);
  const g = new THREE.PlaneGeometry(w, L, 6, 4); const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, -Math.sin((p.getY(i) / L + 0.5) * Math.PI) * 3.5 * Math.sin((p.getX(i) / w + 0.5) * Math.PI * 3) ** 2);
  g.computeVertexNormals();
  const cl = cellRect(CLOTHS[variant % 4]);
  B.add(g, local(F, 0, -drop / 2, depth / 2, -Math.PI / 2 + ang, 0, 0), cl);
  // scalloped valance
  const v = new THREE.PlaneGeometry(w, 10, 12, 1); const vp = v.attributes.position;
  for (let i = 0; i < vp.count; i++) if (vp.getY(i) < 0) vp.setY(i, -5 - Math.abs(Math.sin(vp.getX(i) / w * Math.PI * 6)) * 5);
  v.computeVertexNormals(); B.add(v, local(F, 0, -drop - 5, depth), cl);
  const md = cellRect(C.metalD);
  B.add(box(w + 4, 2.5, 2.5), local(F, 0, 0, 1.5), md); B.add(box(w, 2, 2), local(F, 0, -drop, depth), md);
  for (const s of [-1, 1]) B.add(box(1.6, 1.6, Math.hypot(depth, 12)), local(F, s * (w / 2 - 2), -drop - 6, depth / 2, -Math.atan2(12, depth), 0, 0), md);
}
function addRoofProp(B, r) {
  const [x, y, z, yaw, kind] = r; const F = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
  const mw = cellRect(C.metalW), md = cellRect(C.metalD);
  if (kind === 0) { // AC unit
    B.add(box(44, 30, 30), local(F, 0, 17, 0), mw); B.add(new THREE.PlaneGeometry(26, 26), local(F, -6, 17, 15.2), cellRect(C.grille));
    B.add(box(46, 2, 32), local(F, 0, 1, 0), md); B.add(box(3, 3, 26), local(F, 16, 8, -26), md);
  } else if (kind === 1) { // water tank on a stand
    for (const [sx, sz] of [[-14, -14], [14, -14], [-14, 14], [14, 14]]) B.add(box(3, 22, 3), local(F, sx, 11, sz), md);
    B.add(box(36, 2, 36), local(F, 0, 22, 0), md);
    B.add(new THREE.CylinderGeometry(20, 20, 40, 14, 1), local(F, 0, 43, 0), cellRect(C.metalW));
    B.add(new THREE.CylinderGeometry(6, 20, 6, 14, 1), local(F, 0, 66, 0), md);
  } else { // satellite dish
    B.add(box(3, 34, 3), local(F, 0, 17, 0), md);
    const d = new THREE.SphereGeometry(20, 14, 6, 0, Math.PI * 2, 0, 0.75); B.add(d, local(F, 0, 38, 4, -1.1, 0, 0), mw);
    B.add(box(1.5, 1.5, 22), local(F, 0, 34, 14, 0.5, 0, 0), md);
  }
}
function addBush(Fo, b) {
  const [x, y, z, r] = b; const br = [0.5, 0, 1, 0.5];
  for (let k = 0; k < 3; k++) { const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y + r * 0.45, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), k * Math.PI / 3), new THREE.Vector3(1, 1, 1)); Fo.add(new THREE.PlaneGeometry(r * 2, r * 1.1), m, br); }
}
function addPalm(B, Fo, pl) {
  const [x, y, z, height, lean, sd] = pl; const r = rng(sd * 97 + 5);
  const dir = r() * Math.PI * 2; const lx = Math.cos(dir) * lean * height, lz = Math.sin(dir) * lean * height;
  const pts = []; for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(new THREE.Vector3(x + lx * t * t, y + height * t, z + lz * t * t)); }
  const curve = new THREE.CatmullRomCurve3(pts);
  const tube = new THREE.TubeGeometry(curve, 10, 7, 7, false); const tp = tube.attributes.position; // taper
  for (let i = 0; i < tp.count; i++) { const t = (tp.getY(i) - y) / height; const c = curve.getPoint(Math.min(1, Math.max(0, t))); const k = 1.25 - t * 0.5; tp.setX(i, c.x + (tp.getX(i) - c.x) * k); tp.setZ(i, c.z + (tp.getZ(i) - c.z) * k); }
  tube.computeVertexNormals();
  B.add(tube, new THREE.Matrix4(), cellRect(C.bark));
  const top = curve.getPoint(1); const fr = [0, 0, 0.5, 1];
  const nF = 13;
  for (let k = 0; k < nF; k++) {
    const az = k / nF * Math.PI * 2 + r() * 0.3, L = 120 + r() * 50, droop = 0.3 + r() * 0.5;
    const g = new THREE.PlaneGeometry(46, L, 1, 6); const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const t = p.getY(i) / L + 0.5; p.setY(i, t * L); p.setZ(i, -t * t * L * droop); p.setX(i, p.getX(i) * (1 - t * 0.55)); }
    g.computeVertexNormals();
    // frond lies roughly horizontal, pointing outward at azimuth az, pitched up a little
    const m = new THREE.Matrix4().compose(top, new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + 0.25 + r() * 0.3, az, 0, 'YXZ')), new THREE.Vector3(1, 1, 1));
    Fo.add(g, m, fr);
  }
}
function addCable(B, E, c, bulbs, glows) {
  const [x0, y0, z0, x1, y1, z1, sag] = c; const pts = [];
  const N = 14; for (let i = 0; i <= N; i++) { const t = i / N; pts.push(new THREE.Vector3(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t - sag * 4 * t * (1 - t), z0 + (z1 - z0) * t)); }
  const curve = new THREE.CatmullRomCurve3(pts);
  B.add(new THREE.TubeGeometry(curve, N, 0.7, 4, false), new THREE.Matrix4(), cellRect(C.metalD));
  if (bulbs) { const n = Math.floor(curve.getLength() / 34); for (let i = 1; i < n; i++) { const p = curve.getPoint(i / n); E.add(new THREE.SphereGeometry(2.2, 6, 4), new THREE.Matrix4().makeTranslation(p.x, p.y - 3, p.z), [0, 0, 1, 1]); glows.push(p.clone().setY(p.y - 3)); } }
}

// ---------------------------------------------------------------- main
export async function createProps({ base = '', patchMaterial, layer = 5, quality = 'high' } = {}) {
  const group = new THREE.Group(); group.name = 'world_props';
  let P;
  try { const r = await fetch(base + 'assets/world/props.json'); if (!r.ok) return null; P = await r.json(); } catch (e) { console.warn('props: unavailable', e); return null; }
  const B = new Batch(), Fo = new Batch(), E = new Batch(); const glows = [];
  (P.windows || []).forEach(w => { addWindow(B, E, w); addWindowCanopy(B, w); });
  (P.beams || []).forEach(b => addBeam(B, b));
  (P.lamps || []).forEach(l => addLamp(B, E, glows, l));
  (P.vines || []).forEach(v => addVine(Fo, v));
  (P.banners || []).forEach(b => addBanner(B, b));
  (P.awnings || []).forEach(a => addAwning(B, a));
  (P.roof || []).forEach(r => addRoofProp(B, r));
  (P.bushes || []).forEach(b => addBush(Fo, b));
  (P.palms || []).forEach(p => addPalm(B, Fo, p));
  (P.cables || []).forEach(c => addCable(B, E, c, false, glows));
  (P.stringLights || []).forEach(c => addCable(B, E, c, true, glows));

  const atlas = makeAtlas(), fol = makeFoliage();
  const opaque = new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.82, metalness: 0.0, side: THREE.DoubleSide, bumpMap: atlas, bumpScale: 0.6 });
  opaque.shadowSide = THREE.DoubleSide; opaque.name = 'props_opaque';
  const foliage = new THREE.MeshStandardMaterial({ map: fol, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.45 });
  foliage.name = 'props_foliage';
  const emissive = new THREE.MeshBasicMaterial({ color: new THREE.Color(5.0, 3.3, 1.6), fog: true }); emissive.name = 'props_emissive';
  if (patchMaterial) { patchMaterial(opaque); patchMaterial(foliage); }
  const mk = (batch, mat, name, shadows = true) => {
    if (!batch.p.length) return null;
    const m = new THREE.Mesh(batch.build(), mat); m.name = name; m.castShadow = shadows; m.receiveShadow = shadows;
    m.layers.enable(layer); m.matrixAutoUpdate = false; m.updateMatrix(); group.add(m); return m;
  };
  mk(B, opaque, 'props_opaque'); mk(Fo, foliage, 'props_foliage'); mk(E, emissive, 'props_bulbs', false);
  // glow sprites around bulbs (one draw call)
  if (glows.length) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(glows.flatMap(v => [v.x, v.y, v.z]), 3));
    const gl = new THREE.TextureLoader().load(base + 'assets/fx/glow.png');
    const pm = new THREE.PointsMaterial({ map: gl, color: new THREE.Color(1.6, 1.0, 0.5), size: 34, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
    const pts = new THREE.Points(g, pm); pts.name = 'props_glow'; pts.renderOrder = 4; group.add(pts);
  }
  // a few real (shadowless) point lights: CT spawn lamps + one per tunnel
  const lights = []; const L = P.lights || [];
  const ct = L.filter(l => l[3] === 1).slice(0, 3), tun = L.filter(l => l[3] === 0);
  const pickTun = []; for (const l of tun) if (pickTun.every(o => Math.hypot(o[0] - l[0], o[2] - l[2]) > 600)) pickTun.push(l);
  for (const l of [...ct, ...pickTun.slice(0, 2)]) {
    const pl = new THREE.PointLight(0xffc27a, l[3] === 1 ? 14000 : 9000, 520, 2); pl.position.set(l[0], l[1], l[2]); pl.name = 'props_lamp_light';
    group.add(pl); lights.push(pl);
  }
  const tris = B.tris() + Fo.tris() + E.tris();
  const stats = { tris, opaqueTris: B.tris(), foliageTris: Fo.tris(), bulbTris: E.tris(), glows: glows.length, lights: lights.length, counts: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, v.length])) };
  console.log('props:', JSON.stringify(stats));
  return { group, lights, stats, materials: { opaque, foliage, emissive } };
}
