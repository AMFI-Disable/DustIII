// fx_atlas.js — loads the FX sprites and packs them into GPU textures at runtime.
//
//  * smokeTex   : smoke_sheet.png (2048², 4×4 lit puffs) as an RG8 DataTexture (L·A premultiplied, A) — 8 MB
//  * atlasTex   : 2048² RGBA canvas atlas (premultiplied) with fire_sheet, muzzle flashes, glow, spark,
//                 tracer, dust, blood mist… plus procedurally drawn cells (chips, splinters, ring, dot)
//  * decalTex   : 2048×1024 RGBA canvas atlas (premultiplied) with bullet holes, blood 2×2, scorch
//
// All FX textures are stored *premultiplied & sRGB-encoded* and flagged NoColorSpace; shaders un-premultiply and
// decode sRGB themselves (avoids the dark-fringe problem of decoding premultiplied sRGB texels).
import * as THREE from 'three';

// ---- particle cell ids ----
export const CELL = {
  SMOKE0: 0,          // 0..15  smoke_sheet cells (smokeTex)
  FIRE0: 16,          // 16..31 fire_sheet frames (atlas)
  BIGPUFF: 32, DUST: 33, MSMOKE: 34, BMIST: 35, MFRONT: 36, MSIDE: 37, GLOW: 38, SPARK: 39, TRACER: 40,
  CHIP: 41, SPLINTER: 42, RING: 43, DOT: 44, STAR: 45, SOFT: 46,
  COUNT: 47,
};
// ---- decal ids ----
export const DECAL = { BLOOD0: 0, /*0..3*/ SCORCH: 4, HOLE: 5, HOLE_WOOD: 6, HOLE_METAL: 7, DENT: 8, BURN: 9, COUNT: 10 };

const loadImage = (url) => new Promise((res, rej) => {
  const im = new Image(); im.decoding = 'async';
  im.onload = () => res(im); im.onerror = () => rej(new Error('FX: failed to load ' + url)); im.src = url;
});

function makeCanvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// --- procedural cells -------------------------------------------------------------------------
function drawChip(ctx, x, y, s, seed) {
  // irregular rock chip, light grey with a bit of shading (tinted per surface in the shader)
  let r = seed;
  const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  ctx.save(); ctx.translate(x + s / 2, y + s / 2);
  const n = 7, pts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + rnd() * 0.5; const rr = s * (0.26 + rnd() * 0.16); pts.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
  const g = ctx.createLinearGradient(-s * 0.3, -s * 0.3, s * 0.3, s * 0.3);
  g.addColorStop(0, '#f2f2f2'); g.addColorStop(1, '#8a8a8a');
  ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts) ctx.lineTo(p[0], p[1]); ctx.closePath(); ctx.fill();
  ctx.restore();
}
function drawSplinter(ctx, x, y, w, h) {
  ctx.save(); ctx.translate(x, y + h / 2);
  const g = ctx.createLinearGradient(0, -h * 0.2, 0, h * 0.2);
  g.addColorStop(0, '#d9d9d9'); g.addColorStop(0.5, '#ffffff'); g.addColorStop(1, '#8c8c8c');
  ctx.fillStyle = g; ctx.beginPath();
  ctx.moveTo(w * 0.04, 0); ctx.lineTo(w * 0.25, -h * 0.16); ctx.lineTo(w * 0.7, -h * 0.1); ctx.lineTo(w * 0.97, -h * 0.02);
  ctx.lineTo(w * 0.8, h * 0.06); ctx.lineTo(w * 0.35, h * 0.14); ctx.closePath(); ctx.fill();
  ctx.restore();
}
function drawRadial(ctx, x, y, s, fn) {
  const id = ctx.createImageData(s, s); const d = id.data;
  for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
    const u = (i + 0.5) / s * 2 - 1, v = (j + 0.5) / s * 2 - 1; const r = Math.hypot(u, v);
    const [l, a] = fn(r, u, v); const o = (j * s + i) * 4;
    d[o] = d[o + 1] = d[o + 2] = Math.round(l * 255); d[o + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  }
  ctx.putImageData(id, x, y);
}
function drawStar(ctx, x, y, s) {
  // 4-6 ray star burst used for flashbang pop & metal impact glints
  drawRadial(ctx, x, y, s, (r, u, v) => {
    const ang = Math.atan2(v, u);
    const rays = Math.pow(Math.abs(Math.cos(ang * 3)), 40) * 0.8 + Math.pow(Math.abs(Math.cos(ang * 2 + 0.4)), 60) * 0.6;
    const core = Math.exp(-r * r * 30);
    const a = Math.min(1, core + rays * Math.max(0, 1 - r) * Math.max(0, 1 - r));
    return [1, a * (r < 1 ? 1 : 0)];
  });
}

// --- builder ------------------------------------------------------------------------------------
export async function buildFXTextures(base = 'assets/fx/') {
  const names = ['smoke_sheet', 'fire_sheet', 'smoke', 'dust', 'muzzle_smoke', 'blood_mist', 'muzzle_front', 'muzzle_side',
    'glow', 'spark', 'tracer', 'bullet_hole', 'bullet_hole_wood', 'bullet_hole_metal', 'blood', 'scorch'];
  const imgs = {};
  await Promise.all(names.map(async (n) => { imgs[n] = await loadImage(base + n + '.png'); }));

  // ---------- smoke sheet → RG8 premultiplied DataTexture ----------
  const SW = imgs.smoke_sheet.width, SH = imgs.smoke_sheet.height;
  const sc = makeCanvas(SW, SH); const sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(imgs.smoke_sheet, 0, 0);
  const sd = sctx.getImageData(0, 0, SW, SH).data;
  const rg = new Uint8Array(SW * SH * 2);
  for (let i = 0, j = 0, n = SW * SH; i < n; i++, j += 4) {
    const a = sd[j + 3]; rg[i * 2] = (sd[j] * a + 127) / 255 | 0; rg[i * 2 + 1] = a;
  }
  const smokeTex = new THREE.DataTexture(rg, SW, SH, THREE.RGFormat, THREE.UnsignedByteType);
  smokeTex.generateMipmaps = true; smokeTex.minFilter = THREE.LinearMipmapLinearFilter; smokeTex.magFilter = THREE.LinearFilter;
  smokeTex.wrapS = smokeTex.wrapT = THREE.ClampToEdgeWrapping; smokeTex.flipY = false; smokeTex.unpackAlignment = 1;
  smokeTex.colorSpace = THREE.NoColorSpace; smokeTex.needsUpdate = true;

  // ---------- particle atlas ----------
  const AW = 2048, AH = 2048;
  const ac = makeCanvas(AW, AH); const ctx = ac.getContext('2d');
  const rects = new Float32Array(CELL.COUNT * 5);
  const setRect = (id, x, y, w, h, inset = 1) => {
    const o = id * 5;
    rects[o] = (x + inset) / AW; rects[o + 1] = 1 - (y + h - inset) / AH; rects[o + 2] = (w - 2 * inset) / AW; rects[o + 3] = (h - 2 * inset) / AH; rects[o + 4] = 0;
  };
  const put = (id, img, x, y, w, h) => { ctx.drawImage(img, x, y, w, h); setRect(id, x, y, w, h); };
  // smoke sheet cells (texSel 1, DataTexture rows top-down → v increases downward, so dv is negative)
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const o = (CELL.SMOKE0 + r * 4 + c) * 5; const inset = 2 / SW;
    rects[o] = c / 4 + inset; rects[o + 1] = (r + 1) / 4 - inset; rects[o + 2] = 0.25 - 2 * inset; rects[o + 3] = -(0.25 - 2 * inset); rects[o + 4] = 1;
  }
  // fire sheet 4×4 → 1024² at (0,0)
  ctx.drawImage(imgs.fire_sheet, 0, 0, 1024, 1024);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) setRect(CELL.FIRE0 + r * 4 + c, c * 256, r * 256, 256, 256, 2);
  put(CELL.BIGPUFF, imgs.smoke, 1024, 0, 512, 512);
  put(CELL.DUST, imgs.dust, 1536, 0, 256, 256);
  put(CELL.MSMOKE, imgs.muzzle_smoke, 1792, 0, 256, 256);
  put(CELL.BMIST, imgs.blood_mist, 1536, 256, 256, 256);
  put(CELL.MFRONT, imgs.muzzle_front, 1792, 256, 256, 256);
  put(CELL.MSIDE, imgs.muzzle_side, 1024, 512, 512, 256);
  // GLOW: procedural, exactly zero at the quad edge (glow.png has a faint halo to its border which shows as a hard
  // edge when used with large HDR emissive multipliers)
  drawRadial(ctx, 1536, 512, 256, (r) => { const w = Math.max(0, 1 - r * r); return [1, Math.min(1, (Math.exp(-r * r * 9) * 0.85 + Math.exp(-r * r * 2.5) * 0.25) * w * w)]; });
  setRect(CELL.GLOW, 1536, 512, 256, 256); rects[CELL.GLOW * 5 + 4] = 2;   // texSel 2 → analytic glow in the shader
  put(CELL.SPARK, imgs.spark, 1792, 512, 128, 128);
  put(CELL.TRACER, imgs.tracer, 1024, 768, 512, 64);
  // procedural
  ctx.clearRect(1024, 832, 1024, 1216);
  drawChip(ctx, 1024, 832, 128, 1234567); setRect(CELL.CHIP, 1024, 832, 128, 128);
  drawSplinter(ctx, 1152, 832, 256, 128); setRect(CELL.SPLINTER, 1152, 832, 256, 128);
  drawRadial(ctx, 1408, 832, 256, (r) => { const ring = Math.exp(-Math.pow((r - 0.78) / 0.1, 2)); const inner = 0.25 * Math.max(0, 1 - Math.pow(r / 0.8, 3)) * (r < 0.78 ? 1 : 0); return [1, (ring + inner) * (r < 1 ? 1 : 0)]; });
  setRect(CELL.RING, 1408, 832, 256, 256);
  drawRadial(ctx, 1664, 832, 128, (r) => [1, Math.max(0, Math.min(1, (1 - r) * 3))]); setRect(CELL.DOT, 1664, 832, 128, 128);
  drawStar(ctx, 1792, 832, 256); setRect(CELL.STAR, 1792, 832, 256, 256);
  drawRadial(ctx, 1024, 1088, 256, (r) => [1, Math.pow(Math.max(0, 1 - r * r), 2)]); setRect(CELL.SOFT, 1024, 1088, 256, 256);

  const atlasTex = new THREE.CanvasTexture(ac);
  atlasTex.premultiplyAlpha = true; atlasTex.colorSpace = THREE.NoColorSpace;
  atlasTex.minFilter = THREE.LinearMipmapLinearFilter; atlasTex.magFilter = THREE.LinearFilter; atlasTex.generateMipmaps = true;
  atlasTex.anisotropy = 4; atlasTex.needsUpdate = true;

  // ---------- decal atlas ----------
  const DW = 2048, DH = 1024;
  const dc = makeCanvas(DW, DH); const dctx = dc.getContext('2d');
  const drects = new Float32Array(DECAL.COUNT * 4);
  const dset = (id, x, y, w, h, inset = 2) => { const o = id * 4; drects[o] = (x + inset) / DW; drects[o + 1] = 1 - (y + h - inset) / DH; drects[o + 2] = (w - 2 * inset) / DW; drects[o + 3] = (h - 2 * inset) / DH; };
  dctx.drawImage(imgs.blood, 0, 0, 1024, 1024);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) dset(DECAL.BLOOD0 + r * 2 + c, c * 512, r * 512, 512, 512);
  dctx.drawImage(imgs.scorch, 1024, 0, 512, 512); dset(DECAL.SCORCH, 1024, 0, 512, 512);
  dctx.drawImage(imgs.bullet_hole, 1536, 0, 256, 256); dset(DECAL.HOLE, 1536, 0, 256, 256);
  dctx.drawImage(imgs.bullet_hole_wood, 1792, 0, 256, 256); dset(DECAL.HOLE_WOOD, 1792, 0, 256, 256);
  dctx.drawImage(imgs.bullet_hole_metal, 1536, 256, 256, 256); dset(DECAL.HOLE_METAL, 1536, 256, 256, 256);
  // DENT: small dark crater for sand/dirt (procedural)
  drawRadial(dctx, 1792, 256, 256, (r, u, v) => {
    const n = 0.5 + 0.5 * Math.sin(u * 23 + v * 17) * Math.sin(u * 31 - v * 13);
    const core = r < 0.32 ? 0.12 : 0.12 + (r - 0.32) * 1.2;
    const a = r < 0.35 ? 0.92 : Math.max(0, 0.92 * (1 - (r - 0.35) / (0.5 + 0.15 * n)));
    return [Math.min(1, core), a];
  });
  dset(DECAL.DENT, 1792, 256, 256, 256);
  // BURN: soft charred ground patch for molotov aftermath (procedural, noisy)
  drawRadial(dctx, 1024, 512, 512, (r, u, v) => {
    const n = 0.5 + 0.25 * Math.sin(u * 9.1 + Math.sin(v * 7.3) * 2) + 0.25 * Math.sin(v * 11.7 - Math.cos(u * 5.1) * 2.5);
    const a = Math.max(0, Math.min(1, (1 - r) * 2.2 - 0.25 + (n - 0.5) * 0.9)) * 0.9;
    return [0.06 + 0.05 * n, a];
  });
  dset(DECAL.BURN, 1024, 512, 512, 512);
  const decalTex = new THREE.CanvasTexture(dc);
  decalTex.premultiplyAlpha = true; decalTex.colorSpace = THREE.NoColorSpace;
  decalTex.minFilter = THREE.LinearMipmapLinearFilter; decalTex.generateMipmaps = true; decalTex.anisotropy = 8; decalTex.needsUpdate = true;

  return { smokeTex, atlasTex, rects, decalTex, drects };
}
