// weapon_models.js — procedural, battle-worn weapon models for DUST (CS2-style).
// All models are built in METERS. Convention: pistol grip (right-hand hold) at origin, barrel toward -Z, +Y up.
// Materials are MeshStandard/MeshPhysical with an injected "wear" shader: object-space triplanar detail textures,
// curvature-based edge wear (from screen-space derivatives of the interpolated normal), scratches, chips, grime,
// dust, hand-oil, varnish wear, stipple, and a physically-scaled bump.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WEAPONS } from './weapon_data.js';

const ASSET = 'assets/weapons/';
const TEX = {};          // shared detail textures
export const MAT = {};   // shared materials (by key)
let _ready = null;
let _maxAniso = 4;

// ============================================================================================
// Textures
// ============================================================================================
function loadTex(name, srgb = false) {
  if (TEX[name]) return TEX[name];
  const t = new THREE.TextureLoader().load(ASSET + name + '.png');
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = _maxAniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  TEX[name] = t;
  return t;
}
function loadTexAsync(name, srgb) {
  return new Promise((res) => {
    const t = new THREE.TextureLoader().load(ASSET + name + '.png', (tt) => res(tt), undefined, () => res(t));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = _maxAniso;
    TEX[name] = t;
  });
}

export async function preloadWeaponAssets(renderer) {
  if (_ready) return _ready;
  if (renderer && renderer.capabilities) _maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  _ready = (async () => {
    await Promise.all([
      loadTexAsync('noise'), loadTexAsync('scratch'), loadTexAsync('wood'), loadTexAsync('fabric'),
      loadTexAsync('flash_front', true), loadTexAsync('flash_side', true), loadTexAsync('smoke', true),
    ]);
    buildMaterials();
  })();
  return _ready;
}
export function getWeaponTexture(name) { return TEX[name] || loadTex(name, name.startsWith('flash') || name === 'smoke'); }

// ============================================================================================
// Wear shader
// ============================================================================================
const KIND = { metal: 0, poly: 1, wood: 2, fabric: 3, leather: 4, skin: 5, rubber: 6 };

const W_VERT_PARS = /* glsl */`
attribute vec2 aWear;
varying vec3 vOP;
varying vec3 vON;
varying vec2 vWear;
`;
const W_FRAG_PARS = /* glsl */`
uniform sampler2D tWNoise;
uniform sampler2D tWScratch;
uniform sampler2D tWDetail;
uniform vec4 uW0;      // x tex scale (1/m), y edge amount, z scratch amount, w grime
uniform vec4 uW1;      // x chip amount, y dust, z bump scale, w global wear
uniform vec4 uWE;      // x edge k0, y edge k1 (1/m curvature), z detail scale, w detail extra
uniform vec3 uWBare;   // exposed colour (bare metal / light wood / scuff colour)
uniform vec4 uWBareP;  // x bare metalness, y bare roughness, z oil, w polish
uniform vec3 uWDust;
uniform vec3 uWGrime;
varying vec3 vOP;
varying vec3 vON;
varying vec2 vWear;
vec3 wTriW(vec3 n){ vec3 w = pow(abs(n), vec3(5.0)); return w / (w.x + w.y + w.z + 1e-5); }
vec4 wTri(sampler2D t, vec3 p, vec3 w){ return texture(t, p.zy) * w.x + texture(t, p.zx) * w.y + texture(t, p.xy) * w.z; }
float wCurv(){
  vec3 p = -vViewPosition; vec3 n = vNormal;
  vec3 dpx = dFdx(p), dpy = dFdy(p), dnx = dFdx(n), dny = dFdy(n);
  float a = dot(dpx, dpx), b = dot(dpx, dpy), c = dot(dpy, dpy);
  float det = a * c - b * b;
  float m00 = dot(dpx, dnx), m01 = dot(dpx, dny), m10 = dot(dpy, dnx), m11 = dot(dpy, dny);
  return (c * m00 - b * (m01 + m10) + a * m11) / max(det, 1e-34);
}
`;
const W_FRAG_MAIN = /* glsl */`
vec3 wN = normalize(vON);
vec3 tw = wTriW(wN);
vec3 wSeed = vWear.y * vec3(7.13, 3.71, 5.29);
vec3 P = vOP * uW0.x + wSeed;
vec4 nL = wTri(tWNoise, P * 0.125, tw);
vec4 nM = wTri(tWNoise, P * 0.5 + 0.37, tw);
vec4 nF = wTri(tWNoise, P * 2.0, tw);
vec4 sc = wTri(tWScratch, P * 0.5, tw);
float curv = wCurv();
float edge = smoothstep(uWE.x, uWE.y, curv);
float cav = smoothstep(uWE.x * 0.5, uWE.y, -curv);
float wAmt = clamp(uW1.w + vWear.x, 0.0, 1.5);
float H = 0.0;
float wAO = 1.0;
float wVarnish = 1.0;
float wRough = roughness;
float wMetal = metalness;
vec3 col = diffuseColor.rgb;
float grime = clamp(cav * 0.9 + smoothstep(0.55, 0.95, nL.r * 0.65 + nM.g * 0.55) * 0.45, 0.0, 1.0) * uW0.w;
float dust = clamp(cav * 0.9 * smoothstep(0.3, 0.7, nM.g) + smoothstep(0.78, 0.98, nM.g * 0.55 + nL.g * 0.45 + max(wN.y, 0.0) * 0.12) * 0.6 + 0.06, 0.0, 1.0) * uW1.y;
#if W_KIND == 0
  // ---------------- metal finish (blued / parkerized / anodized / painted) ----------------
  float var = nL.r * 0.6 + nM.b * 0.4;
  col *= 0.75 + 0.5 * var;
  // aged finish: some areas drift to a plum/brown tone
  col = mix(col, col * vec3(1.35, 1.0, 0.75), smoothstep(0.45, 0.8, nL.b * 0.5 + nM.r * 0.5) * 0.6 * uWBareP.w);
  wRough = clamp(roughness + (nM.r - 0.5) * 0.3 + (nL.b - 0.5) * 0.2 + (nF.b - 0.5) * 0.06, 0.04, 1.0);
  float oil = smoothstep(0.55, 0.85, nL.g) * uWBareP.z;
  wRough *= 1.0 - oil * 0.45;
  // finish thinned in large handled zones (silvering)
  float Wm = nL.r * 0.55 + nM.g * 0.3 + nF.g * 0.15;
  float thin = smoothstep(0.72 - wAmt * 0.45, 0.95 - wAmt * 0.35, Wm);
  // edge wear broken up by noise, stronger where wear is high
  float brk = smoothstep(0.52, 0.82, nM.g * 0.6 + nL.r * 0.35 + wAmt * 0.35 + nF.g * 0.15);
  float bare = smoothstep(0.25, 0.6, edge * uW0.y * brk * 1.3) ;
  float edgeSoft = edge * (1.0 - brk) * 0.12;
  float chip = 0.0;
  if (uW1.x > 0.0) {
    float chipZone = clamp((nL.g * 0.7 + nM.r * 0.3) + edge * 0.6 + wAmt * 0.25 - (1.0 - uW1.x * 0.6), 0.0, 1.0);
    chip = smoothstep(0.45, 0.6, sc.a * smoothstep(0.0, 0.35, chipZone));
  }
  float scrZone = smoothstep(0.35, 0.8, nL.g * 0.7 + wAmt * 0.3 + nM.r * 0.2);
  float scr = sc.r * uW0.z * scrZone;
  float goug = smoothstep(0.35, 0.8, sc.g * uW0.z * (0.3 + scrZone));
  float wipe = sc.b * wAmt * 0.8 * scrZone;
  bare = max(bare, max(chip, goug * 0.85));
  float scrB = clamp(scr * 0.9 + wipe * 0.6, 0.0, 1.0) * (1.0 - bare);
  vec3 bareCol = uWBare * (0.8 + 0.4 * nF.b);
  vec3 c0 = col;
  col = mix(col, mix(col, uWBare * 0.4, 0.7), clamp(thin * 0.6 + edgeSoft, 0.0, 1.0));
  col = mix(col, bareCol, bare);
  col = mix(col, mix(c0, bareCol, 0.4), scrB);
  float rim = smoothstep(0.1, 0.45, sc.a) * (1.0 - chip) * step(0.001, uW1.x) * smoothstep(0.0, 0.3, (nL.g * 0.7 + nM.r * 0.3) + edge*0.6 + wAmt*0.25 - (1.0 - uW1.x*0.6));
  col *= 1.0 - rim * 0.25;
  wMetal = mix(wMetal, uWBareP.x, max(max(bare, scrB * 0.7), thin * 0.5));
  wRough = mix(wRough, uWBareP.y + nF.b * 0.12, max(bare, scrB * 0.5));
  wRough = mix(wRough, wRough * 0.8, thin);
  H -= (scr * 0.000012 + goug * 0.00005 + chip * 0.00004 + wipe * 0.000005) * uW1.z;
  H += (nF.b - 0.5) * 0.000003 * uW1.z;
#elif W_KIND == 1
  // ---------------- polymer ----------------
  col *= 0.88 + 0.24 * nL.r;
  float stip = wTri(tWNoise, P * uWE.z, tw).a;
  H += stip * 0.00004 * uW1.z * uWE.w;
  wRough = clamp(roughness + (stip - 0.5) * 0.12 * uWE.w + (nM.r - 0.5) * 0.1, 0.05, 1.0);
  float ew = smoothstep(0.3, 0.7, edge * uW0.y * (0.5 + nM.g));
  float pol = clamp(ew * 0.8 + wAmt * smoothstep(0.4, 0.8, nL.r) * 0.6, 0.0, 1.0);
  col = mix(col, col * 1.5 + uWBare * 0.08, ew * 0.7);
  wRough = mix(wRough, roughness * 0.55, pol);
  float scr = sc.r * uW0.z;
  float goug = smoothstep(0.25, 0.7, sc.g * uW0.z);
  col += (scr * 0.05 + goug * 0.1) * (uWBare + 0.05);
  H -= (scr * 0.00001 + goug * 0.00004) * uW1.z;
#elif W_KIND == 2
  // ---------------- varnished wood ----------------
  vec3 PW = vOP * uWE.z + wSeed * 0.3;
  vec4 wd = wTri(tWDetail, PW, tw);
  vec3 lightW = uWBare, darkW = diffuseColor.rgb;
  col = mix(darkW, lightW, pow(wd.r, 1.3)) * (0.78 + 0.44 * wd.b) * (0.9 + 0.2 * nL.r);
  float oilD = smoothstep(0.25, 0.85, wAmt * (0.35 + nL.r * 0.9));
  col *= 1.0 - oilD * 0.5;
  float vw = clamp(edge * uW0.y * (0.5 + nM.g * 0.9) + oilD * 0.35 + smoothstep(0.6, 0.9, nM.r) * wAmt * 0.5, 0.0, 1.0);
  wVarnish = 1.0 - smoothstep(0.3, 0.7, vw);
  col = mix(col * 1.25 + vec3(0.025, 0.018, 0.01), col, wVarnish);
  wRough = mix(0.72, roughness, wVarnish) + (nF.b - 0.5) * 0.1 + oilD * -0.1;
  float scr = sc.r * uW0.z * (0.4 + nL.g);
  float goug = smoothstep(0.2, 0.7, sc.g * uW0.z);
  col = mix(col, lightW * 1.15, clamp(scr * 0.55 + goug * 0.75, 0.0, 1.0));
  wVarnish *= 1.0 - clamp(scr + goug, 0.0, 1.0);
  H += (wd.a * 0.00003 - wd.g * 0.00003) * uW1.z - (goug * 0.00025 + scr * 0.00002) * uW1.z;
  H -= smoothstep(0.55, 1.0, nM.a * nL.g * 1.5) * 0.00015 * uW1.z * wAmt;
  wMetal = 0.0;
#elif W_KIND == 3
  // ---------------- fabric ----------------
  vec4 fb = wTri(tWDetail, vOP * uWE.z, tw);
  float weave = mix(fb.r, fb.a, step(0.5, uWBareP.w));
  col *= 0.8 + 0.3 * weave + (fb.g - 0.5) * 0.18;
  col *= 0.85 + 0.3 * nL.r;
  col = mix(col, col * 1.25, smoothstep(0.6, 0.95, nM.b) * 0.4);
  H += (weave * 0.00025 + fb.b * 0.0004 * uWE.w + fb.g * 0.00005) * uW1.z;
  // soft wrinkles / creases in the normal (mid and large scale)
  vec4 wrk = wTri(tWNoise, vOP * 9.0 + wSeed, tw);
  H += ((wrk.g - 0.5) * 0.0016 + (nL.r - 0.5) * 0.0012 + abs(wrk.r - 0.5) * -0.0012) * uW1.z;
  col *= 0.92 + 0.16 * wrk.g;
  wRough = clamp(roughness + (fb.g - 0.5) * 0.1, 0.3, 1.0);
  float ew = edge * uW0.y * (0.5 + nM.g);
  col = mix(col, col * 1.35 + uWBare * 0.05, clamp(ew, 0.0, 1.0) * 0.6);
  wMetal = 0.0;
#elif W_KIND == 4
  // ---------------- leather / synthetic glove ----------------
  float gr = wTri(tWNoise, P * uWE.z, tw).a;
  col *= 0.85 + 0.25 * nL.r + (gr - 0.5) * 0.12;
  H += gr * 0.00005 * uW1.z;
  float ew = smoothstep(0.25, 0.75, edge * uW0.y * (0.5 + nM.g) + wAmt * nL.r * 0.4);
  col = mix(col, col * 1.6 + uWBare * 0.06, ew * 0.7);
  wRough = clamp(roughness + (gr - 0.5) * 0.15 - ew * 0.2, 0.2, 1.0);
  float scr = sc.r * uW0.z;
  col += scr * 0.04;
  wMetal = 0.0;
#elif W_KIND == 5
  // ---------------- skin ----------------
  float pore = wTri(tWNoise, P * uWE.z, tw).a;
  col *= 0.9 + 0.18 * nL.r + (nM.b - 0.5) * 0.08;
  col = mix(col, col * vec3(1.05, 0.82, 0.78), cav * 0.6);
  H += pore * 0.00002 * uW1.z;
  wRough = clamp(roughness + (pore - 0.5) * 0.15 + (nM.r - 0.5) * 0.15, 0.25, 0.9);
  wMetal = 0.0;
#else
  // ---------------- rubber / plain matte ----------------
  col *= 0.85 + 0.3 * nL.r;
  float st = wTri(tWNoise, P * uWE.z, tw).a;
  H += st * 0.00003 * uW1.z * uWE.w + (nF.b - 0.5) * 0.000005 * uW1.z;
  float ew = smoothstep(0.3, 0.7, edge * uW0.y * (0.5 + nM.g));
  col = mix(col, col * 1.4 + uWBare * 0.05, ew * 0.6);
  wRough = clamp(roughness + (nM.r - 0.5) * 0.15 - ew * 0.2, 0.1, 1.0);
  wMetal = 0.0;
#endif
col = mix(col, col * uWGrime, grime * 0.75);
wRough = mix(wRough, min(1.0, wRough + 0.2), grime * 0.5);
col = mix(col, uWDust * (0.85 + 0.3 * nF.b), dust * 0.8);
wRough = mix(wRough, 0.95, dust * 0.9);
wMetal = mix(wMetal, 0.0, dust * 0.9);
H += dust * (nF.b - 0.3) * 0.00003 * uW1.z;
wAO = 1.0 - cav * 0.55 - grime * 0.1;
diffuseColor.rgb = col;
`;
const W_NORMAL = /* glsl */`
{
  vec3 sp = -vViewPosition;
  vec3 sx = dFdx(sp), sy = dFdy(sp);
  vec3 R1 = cross(sy, normal), R2 = cross(normal, sx);
  float det = dot(sx, R1) * faceDirection;
  vec2 dH = vec2(dFdx(H), dFdy(H));
  vec3 grad = sign(det) * (dH.x * R1 + dH.y * R2);
  normal = normalize(abs(det) * normal - grad);
}
`;

function wearify(mat, cfg) {
  const kind = KIND[cfg.kind] ?? 0;
  const u = {
    tWNoise: { value: TEX.noise }, tWScratch: { value: TEX.scratch },
    tWDetail: { value: cfg.kind === 'wood' ? TEX.wood : TEX.fabric },
    uW0: { value: new THREE.Vector4(cfg.scale ?? 16, cfg.edge ?? 1, cfg.scratch ?? 0.6, cfg.grime ?? 0.5) },
    uW1: { value: new THREE.Vector4(cfg.chip ?? 0, cfg.dust ?? 0.3, cfg.bump ?? 1, cfg.wear ?? 0) },
    uWE: { value: new THREE.Vector4(cfg.k0 ?? 260, cfg.k1 ?? 950, cfg.dscale ?? 30, cfg.dextra ?? 1) },
    uWBare: { value: new THREE.Color(cfg.bare ?? 0x9a9a9a) },
    uWBareP: { value: new THREE.Vector4(cfg.bareMetal ?? 1, cfg.bareRough ?? 0.25, cfg.oil ?? 0.5, cfg.kind === 'fabric' ? (cfg.knit ? 1 : 0) : (cfg.age ?? 0)) },
    uWDust: { value: new THREE.Color(cfg.dustCol ?? 0x9c8566) },
    uWGrime: { value: new THREE.Color(cfg.grimeCol ?? 0x4a4038) },
  };
  mat.userData.wear = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.defines = sh.defines || {};
    sh.defines.W_KIND = kind;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + W_VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOP = transformed; vON = objectNormal; vWear = aWear;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <clipping_planes_pars_fragment>', '#include <clipping_planes_pars_fragment>\n' + W_FRAG_PARS)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + W_FRAG_MAIN)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(wRough, 0.03, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp(wMetal, 0.0, 1.0);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + W_NORMAL)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\n material.clearcoat *= wVarnish;\n#endif')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= wAO; reflectedLight.indirectSpecular *= mix(1.0, wAO, 0.75);');
  };
  mat.customProgramCacheKey = () => 'wear' + kind + (mat.isMeshPhysicalMaterial ? 'p' : 's');
  return mat;
}

// ============================================================================================
// Materials
// ============================================================================================
function std(o) { return new THREE.MeshStandardMaterial(o); }
function phys(o) { return new THREE.MeshPhysicalMaterial(o); }

const MATDEF = {
  // ---- steels & metals
  blued:   { kind: 'metal', color: 0x1b1d21, metal: 0.82, rough: 0.36, bare: 0xa3a4a6, bareRough: 0.2, edge: 1.0, scratch: 0.8, grime: 0.55, dust: 0.25, oil: 0.6, wear: 0.12 , age: 1 },
  park:    { kind: 'metal', color: 0x2c2d2c, metal: 0.55, rough: 0.6, bare: 0x8f8e8a, bareRough: 0.28, edge: 1.0, scratch: 0.6, grime: 0.6, dust: 0.4, oil: 0.4 , age: 1 },
  parkDark:{ kind: 'metal', color: 0x1f2020, metal: 0.55, rough: 0.55, bare: 0x8a8986, bareRough: 0.28, edge: 0.9, scratch: 0.55, grime: 0.6, dust: 0.35 , age: 1 },
  anod:    { kind: 'metal', color: 0x222326, metal: 0.4, rough: 0.5, bare: 0xbdbec1, bareRough: 0.25, edge: 1.1, scratch: 0.7, grime: 0.5, dust: 0.35 },
  anodTan: { kind: 'metal', color: 0x6e5f47, metal: 0.35, rough: 0.55, bare: 0xbdbec1, bareRough: 0.25, edge: 1.0, scratch: 0.6, grime: 0.55, dust: 0.4 },
  steel:   { kind: 'metal', color: 0x5c5d5f, metal: 1.0, rough: 0.32, bare: 0xb4b4b4, bareRough: 0.18, edge: 0.8, scratch: 0.8, grime: 0.6, dust: 0.25 },
  chrome:  { kind: 'metal', color: 0x9a9b9d, metal: 1.0, rough: 0.2, bare: 0xd0d0d0, bareRough: 0.12, edge: 0.6, scratch: 0.7, grime: 0.7, dust: 0.2 },
  steelSS: { kind: 'metal', color: 0x8a8b8d, metal: 1.0, rough: 0.30, bare: 0xc8c8c8, bareRough: 0.18, edge: 0.7, scratch: 1.0, grime: 0.35, dust: 0.1, oil: 0.3, wear: 0.35 }, // stainless (deagle/knife)
  alu:     { kind: 'metal', color: 0x8d8f92, metal: 1.0, rough: 0.42, bare: 0xc8c9cb, bareRough: 0.25, edge: 0.8, scratch: 0.8, grime: 0.5, dust: 0.3 },
  brass:   { kind: 'metal', color: 0xb48a4a, metal: 1.0, rough: 0.28, bare: 0xe0c080, bareRough: 0.18, edge: 0.5, scratch: 0.4, grime: 0.35, dust: 0.1, oil: 0.2 },
  copper:  { kind: 'metal', color: 0xb06a42, metal: 1.0, rough: 0.3, bare: 0xd89470, bareRough: 0.2, edge: 0.3, scratch: 0.3, grime: 0.3, dust: 0.05 },
  edgeSteel:{ kind: 'metal', color: 0xb4b6b9, metal: 1.0, rough: 0.13, bare: 0xe2e2e2, bareRough: 0.07, edge: 0.15, scratch: 0.9, grime: 0.12, dust: 0.04, oil: 0.5 },
  satin:    { kind: 'metal', color: 0x9b9ca0, metal: 1.0, rough: 0.27, bare: 0xd2d2d2, bareRough: 0.13, edge: 0.4, scratch: 1.1, grime: 0.25, dust: 0.08, oil: 0.4 },
  stonewash:{ kind: 'metal', color: 0x84868a, metal: 1.0, rough: 0.48, bare: 0xc4c4c4, bareRough: 0.2, edge: 0.6, scratch: 1.2, grime: 0.35, dust: 0.12 },
  bladeBlk: { kind: 'metal', color: 0x141516, metal: 0.12, rough: 0.58, bare: 0xa9abae, bareMetal: 1, bareRough: 0.15, edge: 1.3, scratch: 1.0, chip: 0.45, grime: 0.3, dust: 0.15, wear: 0.1 },
  // ---- painted steel / cerakote
  paintOD:  { kind: 'metal', color: 0x3b4131, metal: 0.05, rough: 0.7, bare: 0x8f8e8a, bareMetal: 1, bareRough: 0.3, edge: 1.1, scratch: 0.7, chip: 0.55, grime: 0.6, dust: 0.45 },
  paintGrn: { kind: 'metal', color: 0x2f3b2a, metal: 0.05, rough: 0.6, bare: 0x8f8e8a, bareMetal: 1, bareRough: 0.3, edge: 1.1, scratch: 0.7, chip: 0.6, grime: 0.6, dust: 0.45 },
  paintBlk: { kind: 'metal', color: 0x1c1c1d, metal: 0.1, rough: 0.55, bare: 0x8f8e8a, bareMetal: 1, bareRough: 0.3, edge: 1.1, scratch: 0.7, chip: 0.45, grime: 0.55, dust: 0.4 },
  paintGry: { kind: 'metal', color: 0x4d5054, metal: 0.1, rough: 0.55, bare: 0x8f8e8a, bareMetal: 1, bareRough: 0.3, edge: 1.1, scratch: 0.7, chip: 0.5, grime: 0.55, dust: 0.4 },
  paintTan: { kind: 'metal', color: 0x8a7656, metal: 0.05, rough: 0.7, bare: 0x8f8e8a, bareMetal: 1, bareRough: 0.3, edge: 1.1, scratch: 0.7, chip: 0.55, grime: 0.6, dust: 0.45 },
  paintRed: { kind: 'metal', color: 0x7a1d16, metal: 0.05, rough: 0.55, bare: 0x8f8e8a, bareMetal: 1, bareRough: 0.3, edge: 1.0, scratch: 0.6, chip: 0.5, grime: 0.5, dust: 0.35 },
  paintYel: { kind: 'metal', color: 0xa88a22, metal: 0.05, rough: 0.55, bare: 0x8f8e8a, bareMetal: 1, bareRough: 0.3, edge: 1.0, scratch: 0.6, chip: 0.5, grime: 0.5, dust: 0.35 },
  paintWht: { kind: 'metal', color: 0xb8b4a8, metal: 0.05, rough: 0.6, bare: 0x8f8e8a, bareMetal: 1, bareRough: 0.3, edge: 1.0, scratch: 0.6, chip: 0.4, grime: 0.6, dust: 0.4 },
  // ---- polymers
  poly:     { kind: 'poly', color: 0x202122, metal: 0, rough: 0.62, bare: 0x8a8a8a, edge: 0.9, scratch: 0.6, grime: 0.6, dust: 0.45, dscale: 60, dextra: 1 },
  polyStip: { kind: 'poly', color: 0x1e1f20, metal: 0, rough: 0.75, bare: 0x8a8a8a, edge: 0.9, scratch: 0.5, grime: 0.65, dust: 0.5, dscale: 90, dextra: 3.5 },
  polyTan:  { kind: 'poly', color: 0x7c6a4c, metal: 0, rough: 0.66, bare: 0xd0c0a0, edge: 0.9, scratch: 0.5, grime: 0.6, dust: 0.4, dscale: 60, dextra: 1 },
  polyOD:   { kind: 'poly', color: 0x3e4130, metal: 0, rough: 0.66, bare: 0xa0a090, edge: 0.9, scratch: 0.5, grime: 0.6, dust: 0.45, dscale: 60, dextra: 1 },
  polyGry:  { kind: 'poly', color: 0x3a3c3e, metal: 0, rough: 0.6, bare: 0xa0a0a0, edge: 0.9, scratch: 0.6, grime: 0.6, dust: 0.45, dscale: 60, dextra: 1 },
  bakelite: { kind: 'poly', color: 0x3f1c12, metal: 0, rough: 0.38, bare: 0xb06040, edge: 0.9, scratch: 0.6, grime: 0.5, dust: 0.35, dscale: 60, dextra: 0.3, phys: { clearcoat: 0.3, clearcoatRoughness: 0.35 } },
  rubber:   { kind: 'rubber', color: 0x151515, metal: 0, rough: 0.85, bare: 0x606060, edge: 0.6, scratch: 0.3, grime: 0.6, dust: 0.5, dscale: 80, dextra: 1 },
  // ---- woods
  akWood:   { kind: 'wood', color: 0x240b04, metal: 0, rough: 0.32, bare: 0x7a3414, edge: 1.1, scratch: 0.7, grime: 0.55, dust: 0.35, dscale: 14, wear: 0.15, phys: { clearcoat: 0.55, clearcoatRoughness: 0.28 } },
  woodDark: { kind: 'wood', color: 0x1e0b05, metal: 0, rough: 0.35, bare: 0x6a3418, edge: 1.0, scratch: 0.6, grime: 0.55, dust: 0.35, dscale: 16, phys: { clearcoat: 0.4, clearcoatRoughness: 0.3 } },
  woodPale: { kind: 'wood', color: 0x3a2412, metal: 0, rough: 0.55, bare: 0x8a6440, edge: 1.0, scratch: 0.7, grime: 0.6, dust: 0.4, dscale: 12 },
  // ---- soft goods
  fabricCT: { kind: 'fabric', color: 0x232a36, metal: 0, rough: 0.9, bare: 0x8090a0, edge: 0.4, grime: 0.5, dust: 0.45, dscale: 220, dextra: 1, physSheen: 0x6a7890 },
  fabricCT2:{ kind: 'fabric', color: 0x2c2f33, metal: 0, rough: 0.9, bare: 0x8090a0, edge: 0.4, grime: 0.5, dust: 0.4, dscale: 260, dextra: 0, knit: 1, physSheen: 0x707070 },
  fabricT:  { kind: 'fabric', color: 0x6a5b40, metal: 0, rough: 0.92, bare: 0xd0c0a0, edge: 0.5, grime: 0.7, dust: 0.55, dscale: 200, dextra: 0, physSheen: 0xb0a080 },
  fabricT2: { kind: 'fabric', color: 0x4b4a33, metal: 0, rough: 0.92, bare: 0xb0b090, edge: 0.5, grime: 0.7, dust: 0.5, dscale: 260, dextra: 0, knit: 1, physSheen: 0x808060 },
  gloveCT:  { kind: 'leather', color: 0x232323, metal: 0, rough: 0.7, bare: 0x707070, edge: 0.8, scratch: 0.4, grime: 0.5, dust: 0.35, dscale: 240 },
  gloveCT2: { kind: 'leather', color: 0x3c3d3c, metal: 0, rough: 0.75, bare: 0x808080, edge: 0.8, scratch: 0.4, grime: 0.5, dust: 0.35, dscale: 320 },
  gloveT:   { kind: 'leather', color: 0x4a2e1a, metal: 0, rough: 0.6, bare: 0xa07040, edge: 1.0, scratch: 0.6, grime: 0.6, dust: 0.45, dscale: 200, wear: 0.4 },
  gloveT2:  { kind: 'leather', color: 0x2e2a22, metal: 0, rough: 0.75, bare: 0x807060, edge: 0.8, scratch: 0.4, grime: 0.6, dust: 0.5, dscale: 300 },
  skin:     { kind: 'skin', color: 0xa27760, metal: 0, rough: 0.55, bare: 0xffffff, edge: 0, scratch: 0, grime: 0.55, dust: 0.35, dscale: 200, k0: 400, k1: 1500, physSheen: 0x803020 },
  cord:     { kind: 'fabric', color: 0x1b1c1c, metal: 0, rough: 0.82, bare: 0x707070, edge: 0.5, grime: 0.6, dust: 0.5, dscale: 900, dextra: 0, physSheen: 0x505050 },
  tape:     { kind: 'fabric', color: 0x2a2a28, metal: 0, rough: 0.8, bare: 0x707070, edge: 0.6, grime: 0.6, dust: 0.5, dscale: 300, dextra: 0 },
  tapeTan:  { kind: 'fabric', color: 0x8a7a58, metal: 0, rough: 0.85, bare: 0xd0c0a0, edge: 0.6, grime: 0.7, dust: 0.55, dscale: 300, dextra: 0 },
  rag:      { kind: 'fabric', color: 0x8a7d66, metal: 0, rough: 0.95, bare: 0xd0c0a0, edge: 0.6, grime: 0.9, dust: 0.6, dscale: 160, dextra: 0, wear: 0.6 },
  c4Block:  { kind: 'poly', color: 0xb9ad8c, metal: 0, rough: 0.72, bare: 0xe0d8c0, edge: 0.6, scratch: 0.4, grime: 0.6, dust: 0.45, dscale: 50, dextra: 0.6 },
  pcb:      { kind: 'poly', color: 0x1f4a2a, metal: 0, rough: 0.45, bare: 0x60a070, edge: 0.6, scratch: 0.3, grime: 0.4, dust: 0.3, dscale: 60, dextra: 0.2 },
  wireR:    { kind: 'rubber', color: 0x8a1810, metal: 0, rough: 0.45, bare: 0xff8080, edge: 0.3, grime: 0.3, dust: 0.3, dscale: 60, dextra: 0 },
  wireB:    { kind: 'rubber', color: 0x12306a, metal: 0, rough: 0.45, bare: 0x8090ff, edge: 0.3, grime: 0.3, dust: 0.3, dscale: 60, dextra: 0 },
  wireY:    { kind: 'rubber', color: 0xa08a1a, metal: 0, rough: 0.45, bare: 0xffff80, edge: 0.3, grime: 0.3, dust: 0.3, dscale: 60, dextra: 0 },
  wireK:    { kind: 'rubber', color: 0x161616, metal: 0, rough: 0.45, bare: 0x808080, edge: 0.3, grime: 0.3, dust: 0.3, dscale: 60, dextra: 0 },
  dark:     { kind: 'rubber', color: 0x070707, metal: 0, rough: 0.9, bare: 0x202020, edge: 0, scratch: 0, grime: 0.2, dust: 0.1, dscale: 50, dextra: 0 },
};

function buildMaterials() {
  for (const [key, d] of Object.entries(MATDEF)) {
    const o = { color: d.color, metalness: d.metal, roughness: d.rough, envMapIntensity: d.env ?? 1.0 };
    let m;
    if (d.phys || d.physSheen) {
      m = phys(Object.assign(o, d.phys || {}));
      if (d.physSheen) { m.sheen = d.kind === 'skin' ? 0.25 : 0.6; m.sheenRoughness = 0.6; m.sheenColor = new THREE.Color(d.physSheen); }
    } else m = std(o);
    m.name = key;
    MAT[key] = wearify(m, d);
  }
  // non-wear special materials
  MAT.lens = phys({ color: 0x07080a, metalness: 0.0, roughness: 0.04, envMapIntensity: 2.2,
    iridescence: 1.0, iridescenceIOR: 1.9, iridescenceThicknessRange: [180, 520], clearcoat: 1, clearcoatRoughness: 0.02, name: 'lens' });
  MAT.lensInner = std({ color: 0x020203, metalness: 0, roughness: 0.3, name: 'lensInner' });
  MAT.glassBottle = phys({ color: 0x4a6a3a, metalness: 0, roughness: 0.08, transparent: true, opacity: 0.55, envMapIntensity: 1.6,
    clearcoat: 1, clearcoatRoughness: 0.05, depthWrite: false, name: 'glassBottle' });
  MAT.liquid = std({ color: 0x8a5a14, metalness: 0, roughness: 0.15, transparent: true, opacity: 0.85, name: 'liquid' });
  MAT.ledRed = std({ color: 0x400000, emissive: 0xff2010, emissiveIntensity: 3, roughness: 0.3, name: 'ledRed' });
  MAT.ledGreen = std({ color: 0x002000, emissive: 0x20ff40, emissiveIntensity: 2, roughness: 0.3, name: 'ledGreen' });
  MAT.tritium = std({ color: 0x103010, emissive: 0x60ff60, emissiveIntensity: 0.6, roughness: 0.4, name: 'tritium' });
  MAT.white = std({ color: 0xd8d4c8, roughness: 0.6, name: 'whiteDot' });
  MAT.fiberRed = std({ color: 0x8a0a06, emissive: 0xff2000, emissiveIntensity: 0.6, roughness: 0.3, name: 'fiberRed' });
  MAT.fiberGrn = std({ color: 0x0a6a08, emissive: 0x30ff20, emissiveIntensity: 0.6, roughness: 0.3, name: 'fiberGrn' });
  MAT.flame = new THREE.MeshBasicMaterial({ color: 0xc8501a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, name: 'flame' });
}

// ============================================================================================
// Geometry toolkit
// ============================================================================================
const QH = { lseg: 28, fseg: 3, bseg: 2, detail: true, ce: 2, ca: 4, high: true };
const QL = { lseg: 9, fseg: 1, bseg: 1, detail: false, ce: 1, ca: 2, high: false };
const D2R = Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;

class GB {
  constructor() { this.p = []; this.n = []; this.i = []; }
  v(x, y, z, nx, ny, nz) {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.p.push(x, y, z); this.n.push(nx / l, ny / l, nz / l);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) {
    const P = this.p, N = this.n;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-24) return;
    const sx = N[a * 3] + N[b * 3] + N[c * 3], sy = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], sz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    if (cx * sx + cy * sy + cz * sz >= 0) this.i.push(a, b, c); else this.i.push(a, c, b);
  }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  geo() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setIndex(this.i);
    return g;
  }
}

// --- 2D paths. pts: [[x,y,r?],...]; r>0 fillet radius, r=0 sharp, r<0 forced smooth (curve sample)
const SMOOTH_T = 0.42;
let _minFillet = 0;
function fillet(pts, closed, defR = 0, seg = 3) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const P = pts[i];
    let r = P[2] !== undefined ? P[2] : defR;
    if (r > 0 && r < _minFillet) r = 0;
    if (!closed && (i === 0 || i === n - 1)) { out.push({ x: P[0], y: P[1], h: true }); continue; }
    const A = pts[(i - 1 + n) % n], B = pts[(i + 1) % n];
    let d1x = A[0] - P[0], d1y = A[1] - P[1], d2x = B[0] - P[0], d2y = B[1] - P[1];
    const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
    if (l1 < 1e-7 || l2 < 1e-7) continue;
    d1x /= l1; d1y /= l1; d2x /= l2; d2y /= l2;
    const ang = Math.acos(clamp(d1x * d2x + d1y * d2y, -1, 1));
    const turn = Math.PI - ang;
    if (r <= 0 || turn < 0.03 || seg <= 0) { out.push({ x: P[0], y: P[1], h: r < 0 ? false : turn > SMOOTH_T }); continue; }
    let t = r / Math.tan(ang / 2);
    const tmax = 0.5 * Math.min(l1, l2);
    let rr = r;
    if (t > tmax) { t = tmax; rr = t * Math.tan(ang / 2); }
    const bx = d1x + d2x, by = d1y + d2y, bl = Math.hypot(bx, by);
    const cd = rr / Math.sin(ang / 2);
    const cx = P[0] + bx / bl * cd, cy = P[1] + by / bl * cd;
    const t1x = P[0] + d1x * t, t1y = P[1] + d1y * t, t2x = P[0] + d2x * t, t2y = P[1] + d2y * t;
    const a1 = Math.atan2(t1y - cy, t1x - cx);
    let da = Math.atan2(t2y - cy, t2x - cx) - a1;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const ns = Math.max(1, Math.ceil(Math.abs(da) / (Math.PI / 2) * seg));
    for (let k = 0; k <= ns; k++) {
      const a = a1 + da * k / ns;
      out.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a), h: false });
    }
  }
  return out;
}
function area2(path) { let a = 0; for (let i = 0; i < path.length; i++) { const p = path[i], q = path[(i + 1) % path.length]; a += p.x * q.y - q.x * p.y; } return a / 2; }
function orient(path, ccw) { if ((area2(path) > 0) !== ccw) path.reverse(); return path; }
function loopNormals(path, closed) {
  const n = path.length, out = [];
  const en = (i) => { const p = path[i], q = path[(i + 1) % n]; const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1; return [dy / l, -dx / l]; };
  for (let i = 0; i < n; i++) {
    const p = path[i];
    const hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
    const np = hasPrev ? en((i - 1 + n) % n) : null, nn = hasNext ? en(i) : null;
    const a = np || nn, b = nn || np;
    const d = a[0] * b[0] + a[1] * b[1];
    const k = 1 / Math.max(0.25, 1 + d);
    let mx = (a[0] + b[0]) * k, my = (a[1] + b[1]) * k;
    const ml = Math.hypot(mx, my); if (ml > 2.5) { mx *= 2.5 / ml; my *= 2.5 / ml; }
    if (p.h && np && nn && d < 0.999) {
      out.push({ x: p.x, y: p.y, nx: a[0], ny: a[1], mx, my, dupNext: true });
      out.push({ x: p.x, y: p.y, nx: b[0], ny: b[1], mx, my, dup: true });
    } else {
      let nx = a[0] + b[0], ny = a[1] + b[1]; const l = Math.hypot(nx, ny) || 1;
      out.push({ x: p.x, y: p.y, nx: nx / l, ny: ny / l, mx, my });
    }
  }
  return out;
}
// bezier samplers (points flagged smooth)
function bez2(a, b, c, n, skipFirst = false) {
  if (_minFillet > 0) n = Math.max(2, Math.ceil(n / 2));
  const o = [];
  for (let i = skipFirst ? 1 : 0; i <= n; i++) { const t = i / n, u = 1 - t; o.push([u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1], -1]); }
  return o;
}
function bez3(a, b, c, d, n, skipFirst = false) {
  if (_minFillet > 0) n = Math.max(2, Math.ceil(n / 2));
  const o = [];
  for (let i = skipFirst ? 1 : 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    o.push([u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1], -1]);
  }
  return o;
}
function arcPts(cx, cy, r, a0, a1, n) { const o = []; for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * D2R; o.push([cx + r * Math.cos(a), cy + r * Math.sin(a), -1]); } return o; }
function rectP(u0, v0, u1, v1, r = 0) { return [[u0, v0, r], [u1, v0, r], [u1, v1, r], [u0, v1, r]]; }
// mark endpoints of a sampled curve as sharp corners (so they get fillet/hard)
function sharpEnds(pts, r = 0) { if (pts.length) { pts[0][2] = r; pts[pts.length - 1][2] = r; } return pts; }

// --- side-profile extrusion along X. Profile (u,v): u forward (-Z), v up (+Y).
function extrudeX(outer, width, o = {}) {
  const Q = o.q || QH;
  const fr = o.r ?? 0.0007;
  const fseg = o.fseg ?? Q.fseg;
  let b = o.bevel ?? 0.0007; b = Math.min(b, width * 0.49);
  let bs = b > 0 && Q.bseg > 0 ? (o.bseg ?? Q.bseg) : 0;
  if (bs === 0) b = 0;
  const x0 = o.x ?? 0;
  const g = new GB();
  const loops = [loopNormals(orient(fillet(outer, true, fr, fseg), true), true)];
  for (const h of o.holes || []) loops.push(loopNormals(orient(fillet(h, true, o.hr ?? fr, fseg), false), true));
  const hw = width / 2;
  const rings = [];
  if (bs === 0) { rings.push({ x: hw, a: Math.PI / 2, s: 1 }, { x: -hw, a: Math.PI / 2, s: -1 }); }
  else {
    for (let k = 0; k <= bs; k++) { const a = k / bs * Math.PI / 2; rings.push({ x: hw - b + b * Math.cos(a), a, s: 1 }); }
    const mid = hw - b > 1e-5;
    for (let k = bs - (mid ? 0 : 1); k >= 0; k--) { const a = k / bs * Math.PI / 2; rings.push({ x: -(hw - b + b * Math.cos(a)), a, s: -1 }); }
  }
  const wfn = o.wfn; // optional width scale fn(u,v)
  const vtx = (X, u, v, nx, ny, nu) => {
    let sx = 1; if (wfn) sx = wfn(u, v);
    return g.v(x0 + X * sx, v, -u, nx / sx, ny, -nu);
  };
  for (const L of loops) {
    const M = L.length, ri = [];
    for (const R of rings) {
      const inset = b * (1 - Math.sin(R.a)), s = Math.sin(R.a), c = Math.cos(R.a);
      ri.push(L.map((e) => vtx(R.x, e.x - e.mx * inset, e.y - e.my * inset, R.s * c, e.ny * s, e.nx * s)));
    }
    for (let r = 0; r < ri.length - 1; r++) for (let j = 0; j < M; j++) {
      if (L[j].dupNext) continue;
      const jn = (j + 1) % M;
      g.quad(ri[r][j], ri[r][jn], ri[r + 1][jn], ri[r + 1][j]);
    }
  }
  for (const s of [1, -1]) {
    const conts = loops.map((L) => L.filter((e) => !e.dup).map((e) => new THREE.Vector2(e.x - e.mx * b, e.y - e.my * b)));
    const flat = conts.flat();
    const base = flat.map((p) => vtx(s * hw, p.x, p.y, s, 0, 0));
    const tris = THREE.ShapeUtils.triangulateShape(conts[0], conts.slice(1));
    for (const t of tris) g.tri(base[t[0]], base[t[1]], base[t[2]]);
  }
  return g.geo();
}
// extrude a front-view profile (x,y) along Z (depth centred at z=0)
function extrudeZ(profileXY, depth, o = {}) {
  const pr = profileXY.map((p) => [-p[0], p[1], p[2]]);
  const holes = (o.holes || []).map((h) => h.map((p) => [-p[0], p[1], p[2]]));
  const g = extrudeX(pr, depth, Object.assign({}, o, { holes, x: 0 }));
  g.rotateY(Math.PI / 2);
  return g;
}
// extrude a top-view profile (x, u) along Y (height centred at y=0); u forward
function extrudeY(profileXU, height, o = {}) {
  const pr = profileXU.map((p) => [p[1], p[0], p[2]]);
  const holes = (o.holes || []).map((h) => h.map((p) => [p[1], p[0], p[2]]));
  const g = extrudeX(pr, height, Object.assign({}, o, { holes, x: 0 }));
  g.rotateZ(-Math.PI / 2); // (X_ext, x, -u) -> (x, -X_ext, -u)
  return g;
}
function fixWinding(g) {
  const p = g.attributes.position, n = g.attributes.normal, idx = g.index.array;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), s = new THREE.Vector3();
  for (let i = 0; i < idx.length; i += 3) {
    a.fromBufferAttribute(p, idx[i]); b.fromBufferAttribute(p, idx[i + 1]); c.fromBufferAttribute(p, idx[i + 2]);
    b.sub(a); c.sub(a); b.cross(c);
    s.set(n.getX(idx[i]) + n.getX(idx[i + 1]) + n.getX(idx[i + 2]), n.getY(idx[i]) + n.getY(idx[i + 1]) + n.getY(idx[i + 2]), n.getZ(idx[i]) + n.getZ(idx[i + 1]) + n.getZ(idx[i + 2]));
    if (b.dot(s) < 0) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  }
  g.index.needsUpdate = true;
}

// --- lathe: profile [[r,u,fillet?],...] (u forward along -Z). open profiles authored back->front on the outside.
function lathe(profile, o = {}) {
  const Q = o.q || QH;
  const seg = Math.max(3, Math.round((o.seg ?? Q.lseg) * (o.segMul ?? 1)));
  const closed = !!o.closed;
  let path = fillet(profile, closed, o.r ?? 0.0004, o.fseg ?? Q.fseg);
  if (closed) orient(path, true);
  else { const tmp = path.concat([{ x: 0, y: path[path.length - 1].y }, { x: 0, y: path[0].y }]); if (area2(tmp) < 0) path.reverse(); }
  const L = loopNormals(path, closed);
  const t0 = o.t0 ?? 0, t1 = o.t1 ?? Math.PI * 2;
  const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-6;
  const g = new GB();
  const cols = [];
  for (let k = 0; k <= seg; k++) {
    const t = t0 + (t1 - t0) * k / seg, c = Math.cos(t), s = Math.sin(t);
    cols.push(L.map((e) => g.v(e.x * c, e.x * s, -e.y, e.nx * c, e.nx * s, -e.ny)));
  }
  const M = L.length;
  const jmax = closed ? M : M - 1;
  for (let k = 0; k < seg; k++) for (let j = 0; j < jmax; j++) {
    if (L[j].dupNext) continue;
    const jn = (j + 1) % M;
    g.quad(cols[k][j], cols[k][jn], cols[k + 1][jn], cols[k + 1][j]);
  }
  const geo = g.geo();
  if (o.axis === 'y') geo.rotateX(Math.PI / 2);
  else if (o.axis === 'x') geo.rotateY(-Math.PI / 2);
  else if (o.axis === '-y') geo.rotateX(-Math.PI / 2);
  return geo;
}
// simple cylinder (lathe) between u0..u1 with radius r and small edge fillets
function cyl(r, u0, u1, o = {}) {
  const f = o.f ?? Math.min(r * 0.3, 0.0006);
  const pts = o.hollow ? [[o.hollow, u0, f], [r, u0, f], [r, u1, f], [o.hollow, u1, f]] : [[0, u0, 0], [r, u0, f], [r, u1, f], [0, u1, 0]];
  return lathe(pts, Object.assign({ closed: !!o.hollow }, o));
}

// --- loft of rounded-rect sections along Z. secs: [{z,w,h,x,y,r,rt,rb}]
function rrPerim(s, ce, ca) {
  const pts = [];
  const hw = s.w / 2, hh = s.h / 2;
  const rt = Math.min(s.rt ?? s.r ?? 0, hw, hh), rb = Math.min(s.rb ?? s.r ?? 0, hw, hh);
  const cx = s.x || 0, cy = s.y || 0;
  const corner = (ox, oy, r, a0) => { for (let i = 0; i <= ca; i++) { const a = (a0 + 90 * i / ca) * D2R; pts.push([cx + ox + r * Math.cos(a), cy + oy + r * Math.sin(a), Math.cos(a), Math.sin(a)]); } };
  const edge = (x0, y0, x1, y1, nx, ny) => { for (let i = 1; i < ce; i++) { const t = i / ce; pts.push([cx + lerp(x0, x1, t), cy + lerp(y0, y1, t), nx, ny]); } };
  // start at right-middle going CCW
  pts.push([cx + hw, cy + lerp(-hh + rb, hh - rt, 0.5), 1, 0]);
  edge(hw, lerp(-hh + rb, hh - rt, 0.5), hw, hh - rt, 1, 0); pts.push([cx + hw, cy + hh - rt, 1, 0]);
  corner(hw - rt, hh - rt, rt, 0);
  edge(hw - rt, hh, -hw + rt, hh, 0, 1);
  corner(-hw + rt, hh - rt, rt, 90);
  edge(-hw, hh - rt, -hw, -hh + rb, -1, 0);
  corner(-hw + rb, -hh + rb, rb, 180);
  edge(-hw + rb, -hh, hw - rb, -hh, 0, -1);
  corner(hw - rb, -hh + rb, rb, 270);
  edge(hw, -hh + rb, hw, lerp(-hh + rb, hh - rt, 0.5), 1, 0);
  return pts;
}
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function loft(keys, o = {}) {
  const Q = o.q || QH;
  const steps = o.steps ?? (Q.high ? 3 : 1);
  const ce = o.ce ?? Q.ce, ca = o.ca ?? Q.ca;
  const F = ['z', 'w', 'h', 'x', 'y', 'rt', 'rb'];
  const K = keys.map((s) => ({ z: s.z, w: s.w, h: s.h, x: s.x || 0, y: s.y || 0, rt: s.rt ?? s.r ?? 0, rb: s.rb ?? s.r ?? 0 }));
  const secs = [];
  const smooth = o.smooth !== false;
  for (let i = 0; i < K.length - 1; i++) {
    const n = (K[i].hard || !smooth) ? 1 : steps;
    for (let s = 0; s < n; s++) {
      const t = s / n, sec = {};
      for (const f of F) {
        const p0 = K[Math.max(0, i - 1)][f], p1 = K[i][f], p2 = K[i + 1][f], p3 = K[Math.min(K.length - 1, i + 2)][f];
        sec[f] = smooth ? catmull(p0, p1, p2, p3, t) : lerp(p1, p2, t);
      }
      secs.push(sec);
    }
  }
  secs.push(Object.assign({}, K[K.length - 1]));
  const rings = secs.map((s) => rrPerim(s, ce, ca));
  const M = rings[0].length, NS = secs.length;
  const g = new GB();
  const ids = [];
  for (let i = 0; i < NS; i++) {
    const row = [];
    for (let j = 0; j < M; j++) {
      const p = rings[i][j];
      const ia = Math.max(0, i - 1), ib = Math.min(NS - 1, i + 1);
      const pa = rings[ia][j], pb = rings[ib][j];
      const dz = secs[ib].z - secs[ia].z || 1e-6;
      // tangent along length
      const tx = (pb[0] - pa[0]) / dz, ty = (pb[1] - pa[1]) / dz;
      // normal: 2D normal (p[2],p[3]) tilted by slope along z
      const slope = tx * p[2] + ty * p[3];
      row.push(g.v(p[0], p[1], secs[i].z, p[2], p[3], -slope));
    }
    ids.push(row);
  }
  for (let i = 0; i < NS - 1; i++) for (let j = 0; j < M; j++) {
    const jn = (j + 1) % M;
    g.quad(ids[i][j], ids[i][jn], ids[i + 1][jn], ids[i + 1][j]);
  }
  const caps = o.caps ?? [true, true];
  for (const [ci, end] of [[0, 0], [1, NS - 1]]) {
    if (!caps[ci]) continue;
    const s = secs[end], other = secs[end === 0 ? 1 : NS - 2];
    const dir = Math.sign(s.z - other.z) || 1;
    const c = g.v(s.x, s.y, s.z, 0, 0, dir);
    const rim = rings[end].map((p) => g.v(p[0], p[1], s.z, 0, 0, dir));
    for (let j = 0; j < M; j++) g.tri(c, rim[j], rim[(j + 1) % M]);
  }
  const geo = g.geo();
  if (o.axis === 'y') geo.rotateX(-Math.PI / 2); // section z -> +Y ; section h -> -Z(forward)... see notes
  return geo;
}
// rounded box centred at origin
function rbox(w, h, d, r = 0.001, o = {}) {
  r = Math.min(r, w / 2 - 1e-5, h / 2 - 1e-5, d / 2 - 1e-5);
  return extrudeX(rectP(-d / 2, -h / 2, d / 2, h / 2, r), w, Object.assign({ bevel: r, r }, o));
}
function sphere(r, o = {}) {
  const Q = o.q || QH; const n = Math.max(6, Math.round(Q.lseg * (o.segMul ?? 0.6)));
  const pts = []; for (let i = 0; i <= n; i++) { const a = -90 + 180 * i / n; pts.push([r * Math.cos(a * D2R), r * Math.sin(a * D2R), -1]); }
  pts[0][0] = 0; pts[n][0] = 0;
  return lathe(pts, Object.assign({}, o, { r: 0 }));
}
function torus(R, r, o = {}) {
  const Q = o.q || QH;
  const g = new THREE.TorusGeometry(R, r, Math.max(4, Math.round(Q.lseg * 0.35)), Math.max(8, Math.round(Q.lseg * (o.segMul ?? 1))), o.arc ?? Math.PI * 2);
  g.deleteAttribute('uv');
  return g;
}
function tube(points, r, o = {}) {
  const Q = o.q || QH;
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const g = new THREE.TubeGeometry(curve, o.seg ?? Math.max(4, points.length * (Q.high ? 6 : 2)), r, o.rseg ?? (Q.high ? 8 : 4), false);
  g.deleteAttribute('uv');
  return g;
}
// transform helper. tf: {p:[x,y,z], r:[rx,ry,rz] degrees, s:number|[sx,sy,sz], order}
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
function xf(g, tf) {
  if (!tf) return g;
  const r = tf.r || [0, 0, 0];
  _e.set(r[0] * D2R, r[1] * D2R, r[2] * D2R, tf.order || 'XYZ');
  _q.setFromEuler(_e);
  const s = tf.s ?? 1;
  if (Array.isArray(s)) _s.set(s[0], s[1], s[2]); else _s.set(s, s, s);
  _v.set(...(tf.p || [0, 0, 0]));
  _m4.compose(_v, _q, _s);
  g.applyMatrix4(_m4);
  if (_s.x * _s.y * _s.z < 0) fixWinding(g);
  return g;
}
// apply a per-vertex warp fn(x,y,z)->[x,y,z] (normals left as-is unless fixNormals)
function warp(g, fn) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const r = fn(p.getX(i), p.getY(i), p.getZ(i)); p.setXYZ(i, r[0], r[1], r[2]); }
  p.needsUpdate = true;
  return g;
}

// ---- deterministic rng
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function hashStr(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// ---- Parts collector: merges geometries per material
class Parts {
  constructor(seed = 1) { this.m = new Map(); this.r = rng(seed); }
  add(geo, mat, wear = 0.2, tf) {
    if (!geo) return null;
    if (tf) xf(geo, tf);
    if (geo.attributes.uv) geo.deleteAttribute('uv');
    if (geo.attributes.uv1) geo.deleteAttribute('uv1');
    if (!geo.index) { const n = geo.attributes.position.count; const ix = new Array(n); for (let i = 0; i < n; i++) ix[i] = i; geo.setIndex(ix); }
    const n = geo.attributes.position.count, a = new Float32Array(n * 2), sd = this.r() * 10;
    const p = geo.attributes.position;
    for (let i = 0; i < n; i++) { a[i * 2] = typeof wear === 'function' ? wear(p.getX(i), p.getY(i), p.getZ(i)) : wear; a[i * 2 + 1] = sd; }
    geo.setAttribute('aWear', new THREE.BufferAttribute(a, 2));
    if (!this.m.has(mat)) this.m.set(mat, []);
    this.m.get(mat).push(geo);
    return geo;
  }
  build(parent, name = '') {
    let tris = 0;
    for (const [mk, list] of this.m) {
      const g = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!g) { console.warn('merge failed', name, mk); continue; }
      g.computeBoundingSphere();
      const mat = MAT[mk];
      if (!mat) console.warn('missing material', mk);
      const mesh = new THREE.Mesh(g, mat || MAT.blued);
      mesh.name = name + ':' + mk;
      mesh.castShadow = true; mesh.receiveShadow = true;
      parent.add(mesh);
      tris += g.index.count / 3;
    }
    this.m.clear();
    return tris;
  }
}

// ---- markings (engraved / stamped text decals)
const _decalCache = new Map();
function markingTexture(lines, w = 512, h = 128, opts = {}) {
  const key = lines.join('|') + w + 'x' + h + (opts.font || '');
  if (_decalCache.has(key)) return _decalCache.get(key);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  c.fillStyle = '#fff'; c.textBaseline = 'middle';
  const lh = h / lines.length;
  lines.forEach((ln, i) => {
    c.font = opts.font || `bold ${Math.floor(lh * 0.62)}px "DejaVu Sans Mono", "Courier New", monospace`;
    c.textAlign = opts.align || 'left';
    c.fillText(ln, opts.align === 'center' ? w / 2 : 6, lh * (i + 0.5));
  });
  // fade / wear
  const id = c.getImageData(0, 0, w, h), d = id.data, r = rng(hashStr(key));
  for (let i = 0; i < d.length; i += 4) { const k = 0.55 + 0.45 * r(); d[i] = d[i + 1] = d[i + 2] = d[i] * k; d[i + 3] = 255; }
  c.putImageData(id, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.NoColorSpace; t.anisotropy = _maxAniso;
  _decalCache.set(key, t);
  return t;
}
function markingMesh(lines, wM, hM, o = {}) {
  const tex = markingTexture(lines, o.pw || 512, o.ph || Math.round(512 * hM / wM / 8) * 8 || 64, o);
  const mat = new THREE.MeshStandardMaterial({ color: o.color ?? 0xb8b6b0, metalness: o.metal ?? 0.7, roughness: o.rough ?? 0.45,
    alphaMap: tex, transparent: true, opacity: o.opacity ?? 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(wM, hM), mat);
  m.name = 'marking';
  return m;
}
// place a marking on a side face. side: +1 right (+X), -1 left
function addMarking(group, lines, u, v, x, side, wM, hM, o = {}) {
  const m = markingMesh(lines, wM, hM, o);
  m.position.set(x + side * 0.00005, v, -u);
  m.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
  if (o.rot) m.rotation.x = o.rot;
  group.add(m);
  return m;
}

// ---- anchors
function anchor(name, u, v, x = 0, rot) {
  const o = new THREE.Object3D(); o.name = name; o.position.set(x, v, -u);
  if (rot) o.rotation.set(rot[0] * D2R, rot[1] * D2R, rot[2] * D2R);
  return o;
}

// ============================================================================================
// Model building context
// ============================================================================================
function mk(id, lod) {
  const q = lod === 'low' ? QL : QH;
  const root = new THREE.Group(); root.name = 'weapon_' + id;
  const C = {
    id, q, hi: q.high, root, tris: 0, seed: hashStr(id),
    P: new Parts(hashStr(id)),
    side(prof, width, mat, wear = 0.2, o = {}) { return this.P.add(extrudeX(prof, width, Object.assign({ q }, o)), mat, wear, o.tf); },
    front(prof, depth, mat, wear = 0.2, o = {}) { return this.P.add(extrudeZ(prof, depth, Object.assign({ q }, o)), mat, wear, o.tf); },
    top(prof, h, mat, wear = 0.2, o = {}) { return this.P.add(extrudeY(prof, h, Object.assign({ q }, o)), mat, wear, o.tf); },
    lathe(prof, mat, wear = 0.2, o = {}) { return this.P.add(lathe(prof, Object.assign({ q }, o)), mat, wear, o.tf); },
    cyl(r, u0, u1, mat, wear = 0.2, o = {}) { return this.P.add(cyl(r, u0, u1, Object.assign({ q }, o)), mat, wear, o.tf); },
    loft(secs, mat, wear = 0.2, o = {}) { return this.P.add(loft(secs, Object.assign({ q }, o)), mat, wear, o.tf); },
    box(w, h, d, r, mat, wear, tf, o = {}) { return this.P.add(rbox(w, h, d, r, Object.assign({ q }, o)), mat, wear ?? 0.2, tf); },
    sph(r, mat, wear, tf, o = {}) { return this.P.add(sphere(r, Object.assign({ q }, o)), mat, wear ?? 0.2, tf); },
    tor(R, r, mat, wear, tf, o = {}) { return this.P.add(torus(R, r, Object.assign({ q }, o)), mat, wear ?? 0.2, tf); },
    tube(pts, r, mat, wear, o = {}) { return this.P.add(tube(pts, r, Object.assign({ q }, o)), mat, wear ?? 0.2); },
    // dome-head rivet/pin on a side face at (u,v), side +1/-1, face x
    rivet(u, v, x, s, r = 0.0022, mat = 'blued', h = 0.0009) {
      const g = lathe([[0, 0, 0], [r, 0, 0], [r * 0.85, h * 0.6, -1], [r * 0.5, h * 0.95, -1], [0, h, 0]], { q, seg: q.high ? 14 : 6 });
      return this.P.add(g, mat, 0.5, { p: [x, v, -u], r: [0, s > 0 ? -90 : 90, 0] });
    },
    // flush pin end (flat disc)
    pin(u, v, x, s, r = 0.0018, mat = 'steel', h = 0.0005) {
      return this.P.add(cyl(r, 0, h, { q, seg: q.high ? 12 : 6, f: h * 0.4 }), mat, 0.5, { p: [x, v, -u], r: [0, s > 0 ? -90 : 90, 0] });
    },
    // screw head with slot
    screw(u, v, x, s, r = 0.0025, mat = 'blued') {
      const g = lathe([[0, 0, 0], [r, 0, 0.0002], [r * 0.9, 0.0008, -1], [r * 0.6, 0.0011, -1], [0, 0.0012, 0]], { q, seg: q.high ? 14 : 6 });
      this.P.add(g, mat, 0.6, { p: [x, v, -u], r: [0, s > 0 ? -90 : 90, 0] });
      if (q.high) this.P.add(rbox(0.0006, r * 1.7, 0.0004, 0.0001, { q }), 'dark', 0, { p: [x + s * 0.0011, v, -u], r: [35, 0, 0] });
    },
    flush(name) { this.tris += this.P.build(this.root, name || id); },
    sub(name, pivot) {
      const g = new THREE.Group(); g.name = name;
      if (pivot) g.position.set(pivot[0], pivot[1], pivot[2]);
      this.root.add(g);
      const parent = this;
      const S = Object.create(this);
      S.P = new Parts(hashStr(id + name));
      S.group = g;
      S.flush = function () { const off = g.position.clone(); for (const list of this.P.m.values()) for (const geo of list) geo.translate(-off.x, -off.y, -off.z); parent.tris += this.P.build(g, id + ':' + name); };
      return S;
    },
  };
  return C;
}
function finish(C, ud) {
  C.flush();
  const r = C.root;
  r.userData = Object.assign({ id: C.id, muzzle: null, eject: null, leftHand: null, mag: null, bolt: null, scope: false, tris: C.tris }, ud);
  for (const k of ['muzzle', 'eject', 'leftHand']) if (r.userData[k] && !r.userData[k].parent) r.add(r.userData[k]);
  return r;
}

// ============================================================================================
// AK-47 (AKM pattern, laminated wood furniture, stamped receiver)
// ============================================================================================
function buildAK47(lod) {
  const C = mk('ak47', lod), q = C.q, hi = C.hi;
  const RW = 0.0372;           // receiver width
  const BV = 0.085;            // bore axis height
  // ---------------- receiver
  if (hi) {
    const wallT = 0.0016;
    const wallP = [[-0.105, 0.040, 0.002], [0.165, 0.040, 0.001], [0.165, 0.0965, 0.001], [-0.105, 0.0965, 0.0015]];
    C.side(wallP, wallT, 'blued', 0.25, { x: -RW / 2 + wallT / 2, bevel: 0.0005 });
    C.side(wallP, wallT, 'blued', 0.25, { x: RW / 2 - wallT / 2, bevel: 0.0005,
      holes: [[[0.006, 0.0745, 0.0015], [0.092, 0.0745, 0.0015], [0.092, 0.0938, 0.0006], [0.006, 0.0938, 0.0006]]] });
    // core (with mag-well notch), narrower so the bolt carrier shows through the ejection port
    C.side([[-0.104, 0.0415, 0], [0.084, 0.0415, 0.002], [0.084, 0.072, 0.003], [0.147, 0.072, 0.003], [0.147, 0.0415, 0.002], [0.164, 0.0415, 0], [0.164, 0.096, 0], [-0.104, 0.096, 0]],
      RW / 2 - wallT + 0.0118, 'parkDark', 0.0, { x: (-RW / 2 + wallT + 0.0118) / 2, bevel: 0.0002 });
    // receiver bottom flanges
    C.side([[-0.10, 0.0395, 0.001], [0.08, 0.0395, 0.001], [0.08, 0.0425, 0], [-0.10, 0.0425, 0]], RW + 0.0006, 'blued', 0.4, { bevel: 0.0006 });
    C.side([[0.150, 0.0395, 0.001], [0.165, 0.0395, 0.001], [0.165, 0.0425, 0], [0.150, 0.0425, 0]], RW + 0.0006, 'blued', 0.4, { bevel: 0.0006 });
  } else {
    C.side([[-0.105, 0.040, 0], [0.165, 0.040, 0], [0.165, 0.0965, 0], [-0.105, 0.0965, 0]], RW, 'blued', 0.25, { bevel: 0.001 });
  }
  // rivets / pins
  if (hi) {
    for (const s of [1, -1]) {
      const x = s * RW / 2;
      for (const [u, v] of [[0.138, 0.049], [0.156, 0.049], [0.147, 0.089], [0.128, 0.083], [-0.092, 0.049], [-0.092, 0.088], [-0.078, 0.049]]) C.rivet(u, v, x, s, 0.0021);
      C.pin(0.026, 0.057, x, s, 0.0023, 'steel'); C.pin(0.056, 0.057, x, s, 0.0023, 'steel'); C.pin(-0.012, 0.062, x, s, 0.002, 'steel');
    }
    // magwell dimples (raised oval)
    for (const s of [1, -1]) C.P.add(sphere(0.006, { q, segMul: 0.5 }), 'blued', 0.4, { p: [s * RW / 2, 0.0795, -0.116], s: [0.12, 0.55, 1.0] });
    // left side scope rail
    C.side([[-0.035, 0.050, 0.001], [0.085, 0.050, 0.001], [0.085, 0.084, 0.001], [-0.035, 0.084, 0.001]], 0.0028, 'blued', 0.3, { x: -RW / 2 - 0.0014, bevel: 0.0007 });
    for (let i = 0; i < 6; i++) C.box(0.001, 0.0016, 0.0035, 0.0003, 'dark', 0, { p: [-RW / 2 - 0.0029, 0.0545 + i * 0.0047, -0.078] });
    C.rivet(-0.024, 0.0565, -RW / 2 - 0.0028, -1, 0.0022); C.rivet(0.074, 0.0565, -RW / 2 - 0.0028, -1, 0.0022);
    C.rivet(-0.024, 0.0775, -RW / 2 - 0.0028, -1, 0.0022); C.rivet(0.074, 0.0775, -RW / 2 - 0.0028, -1, 0.0022);
    // trigger-pin retaining spring ("shepherd's crook") on left side
    C.tube([[-RW / 2 - 0.0006, 0.057, -0.026], [-RW / 2 - 0.0008, 0.060, -0.040], [-RW / 2 - 0.0008, 0.061, -0.05], [-RW / 2 - 0.0006, 0.057, -0.056]], 0.0006, 'steel', 0.4);
  }
  // ---------------- dust cover (ribbed arch)
  {
    const sec = (u, k = 0) => ({ z: -u, w: RW + 0.0016 + k, h: 0.027 + k, y: 0.1025 + k * 0.5, rt: 0.0175 + k * 0.5, rb: 0.0008 });
    C.loft([sec(-0.1085, -0.006), sec(-0.1065, -0.0015), sec(-0.104), sec(0.072)], 'blued', 0.35, { smooth: false, caps: [true, true] });
    if (hi) for (const u of [-0.060, -0.016, 0.030]) C.loft([sec(u - 0.0045, -0.0006), sec(u - 0.002, 0.0009), sec(u, 0.0013), sec(u + 0.002, 0.0009), sec(u + 0.0045, -0.0006)], 'blued', 0.5, { steps: 2 });
    // recoil spring guide button
    C.box(0.008, 0.007, 0.010, 0.0015, 'blued', 0.6, { p: [0, 0.1075, 0.110] });
  }
  // ---------------- rear sight block + leaf
  C.side([[0.068, 0.095, 0.002], [0.072, 0.1065, 0.004], [0.100, 0.1215, 0.003], [0.165, 0.1215, 0.0015], [0.168, 0.095, 0.001]], 0.031, 'blued', 0.35, { bevel: 0.0012 });
  if (hi) {
    C.side([[0.088, 0.1213, 0.0005], [0.156, 0.1213, 0.0005], [0.156, 0.1238, 0.0005], [0.088, 0.1252, 0.0005]], 0.017, 'blued', 0.5, { bevel: 0.0006 });
    // rear notch
    C.side([[0.086, 0.1215, 0], [0.091, 0.1215, 0], [0.091, 0.1285, 0.0004], [0.086, 0.1285, 0.0004]], 0.017, 'blued', 0.5, { bevel: 0.0005, holes: [[[0.085, 0.1262, 0], [0.092, 0.1262, 0], [0.092, 0.1290, 0], [0.085, 0.1290, 0]]] });
    C.box(0.003, 0.004, 0.010, 0.0006, 'blued', 0.4, { p: [-0.0045, 0.1275, -0.0885] });
    C.box(0.003, 0.004, 0.010, 0.0006, 'blued', 0.4, { p: [0.0045, 0.1275, -0.0885] });
    // slider
    C.box(0.020, 0.005, 0.011, 0.001, 'blued', 0.6, { p: [0, 0.1255, -0.122] });
    C.box(0.004, 0.004, 0.006, 0.0009, 'steel', 0.6, { p: [0.0115, 0.1255, -0.122] });
    C.box(0.004, 0.004, 0.006, 0.0009, 'steel', 0.6, { p: [-0.0115, 0.1255, -0.122] });
    // graduation marks on leaf
    for (let i = 0; i < 9; i++) C.box(0.010, 0.0003, 0.0004, 0.0001, 'dark', 0, { p: [0, 0.1253, -0.128 - i * 0.003] });
    // gas tube lock lever (right side)
    C.box(0.004, 0.006, 0.016, 0.001, 'blued', 0.6, { p: [0.0175, 0.112, -0.168], r: [-15, 0, 0] });
  }
  // ---------------- gas tube + upper handguard
  C.cyl(0.0088, 0.165, 0.374, 'blued', 0.3, { tf: { p: [0, 0.1125, 0] }, segMul: 0.8 });
  if (hi) for (let i = 0; i < 3; i++) for (const s of [1, -1]) C.cyl(0.0021, 0, 0.0004, 'dark', 0, { tf: { p: [s * 0.0086, 0.1125, -(0.338 + i * 0.011)], r: [0, s > 0 ? -90 : 90, 0] }, seg: 10 });
  {
    const k = (u, w, h, y) => ({ z: -u, w, h, y, rt: 0.0125, rb: 0.004 });
    C.loft([k(0.168, 0.034, 0.026, 0.1135), k(0.172, 0.036, 0.0285, 0.1135), k(0.24, 0.0365, 0.029, 0.1135), k(0.30, 0.035, 0.028, 0.1135), k(0.318, 0.030, 0.025, 0.1135), k(0.322, 0.024, 0.021, 0.1135)],
      'akWood', 0.55, { steps: hi ? 3 : 1 });
    // upper handguard front cap
    C.lathe([[0.0105, 0.318, 0.0005], [0.0128, 0.321, 0.001], [0.0128, 0.330, 0.0008], [0.0095, 0.333, 0]], 'blued', 0.4, { tf: { p: [0, 0.1125, 0] }, segMul: 0.8 });
  }
  // ---------------- barrel
  C.lathe([[0.0098, 0.150, 0], [0.0098, 0.20, -1], [0.0090, 0.36, -1], [0.0086, 0.47, -1], [0.0080, 0.515, 0.0003], [0.0045, 0.516, 0]], 'blued', 0.25, { tf: { p: [0, BV, 0] } });
  // ---------------- lower handguard (wood) with flared top edges
  {
    const k = (u, w, h, wt = 0) => ({ z: -u, w, h, y: 0.0795 - (0.044 - h) / 2, rt: 0.0045, rb: 0.0175 });
    C.loft([k(0.171, 0.044, 0.040), k(0.176, 0.048, 0.044), k(0.20, 0.0515, 0.0455), k(0.25, 0.0525, 0.046), k(0.30, 0.051, 0.0445), k(0.318, 0.048, 0.041), k(0.322, 0.046, 0.039)],
      'akWood', (x, y, z) => 0.55 + 0.4 * Math.exp(-Math.pow((-z - 0.25) / 0.05, 2)) * (y < 0.08 ? 1 : 0.4), { steps: hi ? 3 : 1, ca: hi ? 5 : 2 });
    if (hi) {
      // side paddles / finger rests
      for (const s of [1, -1]) C.loft([{ z: -0.18, w: 0.004, h: 0.008, x: s * 0.0245, y: 0.0965, r: 0.0019 }, { z: -0.20, w: 0.0055, h: 0.010, x: s * 0.0262, y: 0.096, r: 0.0026 }, { z: -0.30, w: 0.0055, h: 0.010, x: s * 0.026, y: 0.096, r: 0.0026 }, { z: -0.315, w: 0.004, h: 0.008, x: s * 0.024, y: 0.0965, r: 0.0019 }], 'akWood', 0.7, { steps: 2 });
    }
    // rear retainer ring
    C.loft([{ z: -0.164, w: 0.047, h: 0.046, y: 0.0795, rt: 0.006, rb: 0.018 }, { z: -0.1715, w: 0.047, h: 0.046, y: 0.0795, rt: 0.006, rb: 0.018 }], 'blued', 0.5, { smooth: false });
    // front retainer band + lever
    C.loft([{ z: -0.3205, w: 0.0475, h: 0.042, y: 0.0785, rt: 0.006, rb: 0.018 }, { z: -0.3335, w: 0.0475, h: 0.042, y: 0.0785, rt: 0.006, rb: 0.018 }], 'blued', 0.5, { smooth: false });
    if (hi) C.side([[0.322, 0.090, 0.001], [0.334, 0.090, 0.001], [0.336, 0.104, 0.002], [0.318, 0.104, 0.002]], 0.003, 'blued', 0.7, { x: 0.0245, bevel: 0.0008 });
  }
  // ---------------- gas block
  C.side([[0.372, 0.0745, 0.002], [0.405, 0.0745, 0.002], [0.405, 0.0955, 0.002], [0.392, 0.1045, 0.003], [0.385, 0.1235, 0.003], [0.372, 0.1235, 0.002]], 0.0215, 'blued', 0.35, { bevel: 0.0015 });
  C.cyl(0.0125, 0.392, 0.406, 'blued', 0.35, { tf: { p: [0, BV, 0] } });
  // ---------------- front sight base, ears, post
  C.cyl(0.0122, 0.478, 0.511, 'blued', 0.35, { tf: { p: [0, BV, 0] } });
  C.side([[0.481, 0.088, 0.002], [0.508, 0.088, 0.002], [0.505, 0.115, 0.002], [0.486, 0.115, 0.002]], 0.015, 'blued', 0.35, { bevel: 0.0012 });
  if (hi) {
    const ring = []; const hole = [];
    for (let i = 0; i <= 20; i++) { const a = (55 + (430 - 110) * i / 20) * D2R; ring.push([Math.cos(a) * 0.0118, 0.1205 + Math.sin(a) * 0.0118, -1]); }
    for (let i = 20; i >= 0; i--) { const a = (62 + (416 - 124) * i / 20) * D2R; ring.push([Math.cos(a) * 0.0088, 0.1205 + Math.sin(a) * 0.0088, -1]); }
    sharpEnds(ring, 0.0006); ring[20][2] = 0.0006; ring[21][2] = 0.0006;
    C.front(ring, 0.0085, 'blued', 0.6, { tf: { p: [0, 0, -0.4935] }, bevel: 0.0006 });
  } else {
    C.box(0.022, 0.012, 0.008, 0.002, 'blued', 0.4, { p: [0, 0.121, -0.4935] });
  }
  C.cyl(0.0012, 0, 0.016, 'blued', 0.5, { tf: { p: [0, 0.112, -0.4935], r: [-90, 0, 0] }, seg: 8 });
  // bayonet lug
  if (hi) C.side([[0.482, 0.0655, 0.001], [0.502, 0.0655, 0.001], [0.506, 0.076, 0.001], [0.482, 0.076, 0.001]], 0.009, 'blued', 0.4, { bevel: 0.0008 });
  // cleaning rod
  C.cyl(0.0029, 0.205, 0.500, 'blued', 0.4, { tf: { p: [0, 0.0672, 0] }, seg: 12 });
  if (hi) C.side([[0.495, 0.0645, 0.001], [0.507, 0.0645, 0.001], [0.507, 0.0705, 0.001], [0.495, 0.0705, 0.001]], 0.009, 'blued', 0.5, { bevel: 0.0008 });
  // ---------------- slant muzzle brake
  {
    const g = lathe([[0.0046, 0.508, 0], [0.0114, 0.508, 0.0006], [0.0114, 0.548, 0.0008], [0.0060, 0.548, 0.0005]], { q, closed: true, segMul: 1.0 });
    warp(g, (x, y, z) => { const u = -z; if (u > 0.535) { const f = (0.548 - 0.008 * (0.5 + 0.5 * (y / 0.0114)) - 0.535) / 0.013; return [x, y, -(0.535 + (u - 0.535) * f)]; } return [x, y, z]; });
    C.P.add(g, 'blued', 0.5, { p: [0, BV, 0] });
  }
  // ---------------- trigger guard + mag release
  C.side([[0.006, 0.0405, 0], [0.006, 0.022, 0.008], [0.019, 0.0055, 0.012], [0.078, 0.0055, 0.006], [0.087, 0.016, 0.004], [0.088, 0.0405, 0]], 0.0095, 'blued', 0.45,
    { bevel: 0.0012, holes: [[[0.0135, 0.0395, 0.002], [0.0135, 0.022, 0.006], [0.0235, 0.011, 0.008], [0.075, 0.011, 0.004], [0.081, 0.018, 0.003], [0.081, 0.0395, 0.002]]] });
  C.side([[0.083, 0.024, 0.002], [0.091, 0.024, 0.002], [0.091, 0.044, 0.001], [0.087, 0.044, 0.001]], 0.012, 'blued', 0.6, { bevel: 0.001 });
  // trigger
  C.side([[0.033, 0.0405, 0], [0.039, 0.0405, 0], [0.0365, 0.030, -1], [0.033, 0.0215, -1], [0.028, 0.0155, 0.0012], [0.0255, 0.0175, 0.001], [0.029, 0.025, -1], [0.0305, 0.034, -1]], 0.0055, 'blued', 0.6, { bevel: 0.0009 });
  // ---------------- pistol grip (bakelite)
  {
    const ga = 17;
    const s = (y, w, d, cz = 0, r = 0.011) => ({ z: y, w, h: d, x: 0, y: cz, r });
    const g = loft([s(-0.066, 0.0262, 0.0325, 0.002, 0.009), s(-0.0625, 0.0285, 0.0360, 0.0015, 0.011), s(-0.040, 0.0298, 0.0395, 0.0), s(0.0, 0.0300, 0.0405, -0.0005), s(0.030, 0.0285, 0.0400, -0.001), s(0.048, 0.0270, 0.0400, -0.001, 0.008)], { q, steps: hi ? 3 : 1, ca: hi ? 5 : 2 });
    g.rotateX(-Math.PI / 2);   // loft z -> +y ; section y -> -z
    g.rotateX(-ga * D2R);
    C.P.add(g, 'bakelite', (x, y, z) => 0.6 + (z > 0 ? 0.3 : 0), { p: [0, 0, 0] });
    if (hi) {
      // grip cap screw
      C.cyl(0.0035, 0, 0.0015, 'blued', 0.6, { tf: { p: [0.0, -0.066 * Math.cos(ga * D2R), 0.066 * Math.sin(ga * D2R)], r: [-90 - ga, 0, 0] }, seg: 12 });
      // vertical serrations on the grip sides
      for (const sd of [1, -1]) for (let i = 0; i < 7; i++) {
        const gg = rbox(0.0012, 0.070, 0.0022, 0.0005, { q });
        gg.rotateX(-ga * D2R);
        C.P.add(gg, 'bakelite', 0.7, { p: [sd * 0.0148, -0.012, -0.012 + i * 0.004 + 0.003] });
      }
    }
  }
  // ---------------- stock (laminated wood) + buttplate + tangs
  {
    const prof = [[-0.098, 0.0935, 0.002], [-0.115, 0.0925, -1], ...bez2([-0.14, 0.088], [-0.24, 0.072], [-0.334, 0.059], 6), [-0.338, 0.059, 0.004], [-0.338, -0.067, 0.004],
      ...bez3([-0.334, -0.0675], [-0.25, -0.037], [-0.17, 0.005], [-0.135, 0.022], 8), [-0.110, 0.035, -1], [-0.098, 0.0395, 0.002]];
    C.side(prof, 0.036, 'akWood', 0.3, { bevel: hi ? 0.0065 : 0.004, bseg: hi ? 4 : 1, r: 0.003,
      wfn: (u, v) => 1.0 + 0.2 * clamp((-0.12 - u) / 0.2, 0, 1) });
    // butt plate
    const bp = [[-0.3445, 0.060, 0.003], [-0.3375, 0.060, 0], [-0.3375, -0.068, 0], [-0.3445, -0.068, 0.003]];
    C.side(bp, 0.0435, 'blued', 0.55, { bevel: 0.0015, bseg: 2, r: 0.003 });
    if (hi) {
      C.box(0.024, 0.042, 0.0012, 0.0005, 'dark', 0, { p: [0, 0.006, 0.3449] });
      C.screw(-0.336, 0.054, 0, 1, 0.003, 'blued');
      // top & bottom tangs
      C.side([[-0.128, 0.0912, 0.003], [-0.100, 0.0928, 0], [-0.100, 0.0952, 0], [-0.128, 0.0936, 0.003]], 0.016, 'blued', 0.45, { bevel: 0.0007 });
      C.side([[-0.155, 0.0225, 0.003], [-0.100, 0.0388, 0], [-0.100, 0.0410, 0], [-0.155, 0.0250, 0.003]], 0.014, 'blued', 0.45, { bevel: 0.0007 });
      { const g = lathe([[0, 0, 0], [0.0026, 0, 0.0002], [0.0022, 0.0009, -1], [0, 0.0011, 0]], { q, seg: 14 }); C.P.add(g, 'blued', 0.6, { p: [0, 0.0938, 0.119], r: [90, 0, 0] }); }
      // sling swivel on the left side of the stock
      C.tor(0.007, 0.0012, 'steel', 0.5, { p: [-0.0215, -0.002, 0.255], r: [0, 90, 0] });
      C.box(0.003, 0.008, 0.014, 0.001, 'blued', 0.5, { p: [-0.0205, 0.006, 0.255] });
    }
  }
  // ---------------- selector lever (right side)
  {
    const sel = [[-0.083, 0.0805, 0.004], [-0.071, 0.0855, 0.002], [0.070, 0.0925, 0.002], [0.072, 0.0880, 0.002], [-0.040, 0.0825, -1], [-0.062, 0.0780, -1], [-0.063, 0.068, 0.003], [-0.073, 0.066, 0.003], [-0.083, 0.0735, 0.004]];
    const g = extrudeX(sel, 0.0016, { q, bevel: 0.0005, r: 0.0008 });
    g.translate(0, -0.081, 0.077); g.rotateX(-4 * D2R); g.translate(0, 0.081, -0.077);
    C.P.add(g, 'blued', 0.7, { p: [RW / 2 + 0.0012, 0, 0] });
    if (hi) C.cyl(0.0055, 0, 0.0015, 'blued', 0.5, { tf: { p: [RW / 2 + 0.0006, 0.081, 0.077], r: [0, -90, 0] }, seg: 16 });
  }
  // ---------------- markings
  if (hi) {
    addMarking(C.root, ['№ ТК 4471   1987'], -0.055, 0.050, -RW / 2 - 0.0001, -1, 0.040, 0.0045, { opacity: 0.45 });
    addMarking(C.root, ['АВ'], -0.035, 0.0745, RW / 2 + 0.0001, 1, 0.008, 0.0045, { opacity: 0.5, pw: 128, ph: 64 });
    addMarking(C.root, ['ОД'], -0.012, 0.0765, RW / 2 + 0.0001, 1, 0.008, 0.0045, { opacity: 0.5, pw: 128, ph: 64 });
  }
  // ---------------- bolt carrier + charging handle (animated)
  const B = C.sub('bolt', [0, 0.086, -0.06]);
  if (hi) {
    B.side([[-0.012, 0.0748, 0.001], [0.0975, 0.0748, 0.001], [0.0975, 0.0935, 0.001], [-0.012, 0.0935, 0.001]], 0.0045, 'steel', 0.5, { x: 0.0141, bevel: 0.0006 });
    B.side([[-0.012, 0.0822, 0.0005], [0.060, 0.0822, 0.0005], [0.060, 0.0832, 0.0005], [-0.012, 0.0832, 0.0005]], 0.001, 'dark', 0, { x: 0.0165 });
    // bolt head with extractor visible at the front of the port
    B.cyl(0.0068, 0.060, 0.090, 'chrome', 0.4, { tf: { p: [0.0105, 0.0838, 0] }, seg: 16 });
    B.box(0.0025, 0.0035, 0.018, 0.0005, 'steel', 0.5, { p: [0.0168, 0.0838, -0.078] });
  }
  {
    const hp = [[0.084, 0.0835, 0.001], [0.093, 0.0835, 0.001], [0.093, 0.0915, 0.001], [0.084, 0.0915, 0.001]];
    const g = extrudeX(hp, 0.020, { q, bevel: 0.0012 });
    B.P.add(g, 'steel', 0.7, { p: [0.0275, 0.0, 0.0] });
    B.P.add(sphere(0.0058, { q, segMul: 0.6 }), 'steel', 0.8, { p: [0.0385, 0.0880, -0.0885], s: [1.0, 0.85, 1.0] });
  }
  B.flush();
  // ---------------- magazine (animated; pivot at front locking lug)
  const M = C.sub('mag', [0, 0.056, -0.146]);
  {
    const MW = 0.0285;
    const front = bez2([0.1445, 0.062], [0.150, -0.055], [0.224, -0.146], hi ? 10 : 4);
    const back = bez2([0.0865, 0.062], [0.091, -0.045], [0.166, -0.160], hi ? 10 : 4);
    sharpEnds(front, 0.002); sharpEnds(back, 0.002);
    const prof = [...front, ...back.reverse()];
    M.side(prof, MW, 'blued', (x, y, z) => 0.35 + (y < -0.08 ? 0.4 : 0), { bevel: 0.0012, r: 0.002 });
    // floor plate
    const fp = [[0.164, -0.1565, 0.002], [0.230, -0.1395, 0.002], [0.231, -0.1465, 0.002], [0.1645, -0.1645, 0.002]];
    M.side(fp, MW + 0.003, 'blued', 0.85, { bevel: 0.0012 });
    if (hi) {
      // stamped reinforcing ribs on both sides (follow the curve)
      for (const s of [1, -1]) {
        const ribF = bez2([0.134, 0.035], [0.139, -0.055], [0.206, -0.137], 10), ribB = bez2([0.130, 0.035], [0.135, -0.055], [0.201, -0.140], 10);
        sharpEnds(ribF, 0.0015); sharpEnds(ribB, 0.0015);
        M.side([...ribF, ...ribB.reverse()], 0.0026, 'blued', 0.6, { x: s * (MW / 2), bevel: 0.0011, r: 0.0015 });
        const r2F = bez2([0.103, 0.035], [0.108, -0.050], [0.176, -0.150], 10), r2B = bez2([0.099, 0.035], [0.104, -0.050], [0.171, -0.152], 10);
        sharpEnds(r2F, 0.0015); sharpEnds(r2B, 0.0015);
        M.side([...r2F, ...r2B.reverse()], 0.0026, 'blued', 0.6, { x: s * (MW / 2), bevel: 0.0011, r: 0.0015 });
        // horizontal stamped stiffener near the top
        M.side([[0.092, 0.020, 0.0015], [0.143, 0.020, 0.0015], [0.143, 0.025, 0.0015], [0.092, 0.025, 0.0015]], 0.0012, 'blued', 0.6, { x: s * (MW / 2), bevel: 0.0005 });
      }
      // front lug + rear catch lug
      M.side([[0.144, 0.050, 0.0006], [0.150, 0.050, 0.0006], [0.150, 0.058, 0.0006], [0.144, 0.061, 0.0006]], 0.012, 'blued', 0.6, { bevel: 0.0006 });
      M.side([[0.0815, 0.040, 0.0006], [0.088, 0.040, 0.0006], [0.088, 0.047, 0.0006], [0.0815, 0.047, 0.0006]], 0.014, 'blued', 0.6, { bevel: 0.0006 });
      // top cartridge (visible when mag is out)
      M.lathe([[0, 0.093, 0], [0.0056, 0.093, 0.0004], [0.0055, 0.120, -1], [0.0045, 0.127, -1], [0.0040, 0.129, 0]], 'brass', 0.2, { tf: { p: [0.004, 0.063, 0], r: [0, 0, 0] }, seg: 14 });
      M.lathe([[0.0040, 0.1285, 0], [0.0039, 0.135, -1], [0.0028, 0.142, -1], [0.0, 0.1475, 0]], 'copper', 0.1, { tf: { p: [0.004, 0.063, 0] }, seg: 14 });
      // feed lips
      for (const s of [1, -1]) M.side([[0.0885, 0.058, 0.001], [0.128, 0.058, 0.001], [0.124, 0.066, 0.001], [0.0885, 0.066, 0.001]], 0.0022, 'blued', 0.5, { x: s * (MW / 2 - 0.0011), bevel: 0.0005 });
    }
  }
  M.flush();
  return finish(C, {
    muzzle: anchor('muzzle', 0.546, BV), eject: anchor('eject', 0.05, 0.086, RW / 2 + 0.002),
    leftHand: anchor('leftHand', 0.255, 0.079), mag: M.group, bolt: B.group, scope: false,
    hold: 'rifle', gripAngle: 17 * D2R, handguard: { w: 0.052, h: 0.046, y: 0.0795, u: 0.255 },
    extraShapes: { fore: [{ c: [0, 0.1135, -0.25], half: [0.0183, 0.0145, 0.08], r: 0.011 }] },
    boltAxis: new THREE.Vector3(0, 0, 1), boltTravel: 0.078, charge: 'ak', magDrop: 'rock', chargePt: new THREE.Vector3(0.0385, 0.088, -0.0885), chargeFrom: 'below',
    sightHeight: 0.125,
  });
}


// ============================================================================================
// Shared kits
// ============================================================================================
// Picatinny rail along -Z at radial offset `r` from an axis at height `ay`, rotated by `ang` degrees around the axis (0 = top)
function rail(C, u0, u1, ay, r, ang = 0, mat = 'anod', w = 0.0212, o = {}) {
  const q = C.q, hi = C.hi;
  const tf = { p: [0, ay, 0], r: [0, 0, ang] };
  const base = rbox(w * 0.7, 0.0032, u1 - u0, 0.0006, { q }); xf(base, { p: [0, r + 0.0016, -(u0 + u1) / 2] }); C.P.add(xf(base, tf), mat, 0.3);
  if (!hi) { const t = rbox(w, 0.0036, u1 - u0, 0.0008, { q }); xf(t, { p: [0, r + 0.0045, -(u0 + u1) / 2] }); C.P.add(xf(t, tf), mat, 0.4); return; }
  const prof = [[-w * 0.5, 0.0, 0.0003], [w * 0.5, 0.0, 0.0003], [w * 0.36, 0.0022, 0.0003], [w * 0.36, 0.0034, 0.0004], [-w * 0.36, 0.0034, 0.0004], [-w * 0.36, 0.0022, 0.0003]];
  // dovetail bar pieces between cross slots (slot pitch 10mm, slot 5mm)
  const pitch = 0.01, n = Math.max(1, Math.floor((u1 - u0) / pitch));
  const st = u0 + ((u1 - u0) - n * pitch) / 2;
  for (let i = 0; i < n; i++) {
    const a = st + i * pitch + 0.0025, b = a + 0.005;
    const g = extrudeZ(prof.map((p) => [p[0], p[1], 0]), b - a, { q, bevel: 0.0004, bseg: 1, r: 0 });
    xf(g, { p: [0, r + 0.0030, -(a + b) / 2] });
    C.P.add(xf(g, tf), mat, 0.5);
  }
  // continuous lower spine
  const sp = extrudeZ([[-w * 0.5, 0, 0.0002], [w * 0.5, 0, 0.0002], [w * 0.5, 0.0022, 0.0002], [-w * 0.5, 0.0022, 0.0002]], u1 - u0, { q, bevel: 0.0004 });
  xf(sp, { p: [0, r + 0.0008, -(u0 + u1) / 2] }); C.P.add(xf(sp, tf), mat, 0.45);
}
// suppressor / can: lathe from u0 forward, length L, radius R
function can(C, u0, L, R, ay, mat = 'park', o = {}) {
  const hi = C.hi;
  const pr = [[0.006, u0, 0], [R * 0.72, u0, 0.001], [R * 0.78, u0 + 0.012, -1], [R, u0 + 0.022, 0.002]];
  if (hi && o.bands !== false) {
    // knurled / grooved grip bands near the back and front
    for (let i = 0; i < 6; i++) { const uu = u0 + 0.03 + i * 0.006; pr.push([R, uu, 0.0006], [R - 0.0009, uu + 0.0015, 0.0003], [R - 0.0009, uu + 0.003, 0.0003], [R, uu + 0.0045, 0.0006]); }
  }
  pr.push([R, u0 + L - 0.012, 0.003], [R * 0.86, u0 + L, 0.002], [0.0055, u0 + L, 0.0006], [0.0050, u0 + L - 0.004, 0]);
  C.lathe(pr, mat, (x, y, z) => 0.35 + 0.3 * Math.max(0, Math.min(1, (-z - u0) / L)), { tf: { p: [0, ay, 0] }, segMul: 1.15 });
  if (hi) { // bore hole darkness
    C.cyl(0.0052, u0 + L - 0.0035, u0 + L - 0.0005, 'dark', 0, { tf: { p: [0, ay, 0] }, seg: 14 });
  }
}
// riflescope along the bore direction; eye at u=ue, objective end at u=uo, axis height ay
function scope(C, ue, uo, ay, o = {}) {
  const R = o.r ?? 0.0127, Re = o.re ?? 0.0195, Ro = o.ro ?? 0.025, mat = o.mat ?? 'anod';
  const L = uo - ue;
  if (!C.hi) {
    C.lathe([[0, ue, 0], [Re, ue, 0], [Re, ue + 0.05, 0], [R, ue + 0.085, 0], [R, uo - 0.095, 0], [Ro, uo - 0.045, 0], [Ro, uo, 0], [0, uo, 0]], mat, 0.35, { tf: { p: [0, ay, 0] }, seg: 8 });
    C.P.add(cyl(Ro * 0.85, uo - 0.001, uo + 0.0005, { q: C.q, seg: 8, f: 0 }), 'lens', 0, { p: [0, ay, 0] });
    C.box(0.012, R + 0.016, 0.02, 0.003, mat, 0.6, { p: [0, ay + 0.006, -(ue + L * 0.45)] });
    for (const u of o.rings || [ue + 0.1, uo - 0.11]) C.box(0.016, 0.016, 0.016, 0.002, 'blued', 0.5, { p: [0, ay - R - 0.006, -u] });
    return;
  }
  const pr = [[Re * 0.82, ue, 0.0006], [Re, ue + 0.004, 0.0015], [Re, ue + 0.045, 0.004], [R * 1.08, ue + 0.075, 0.008], [R, ue + 0.085, 0.002],
    [R, ue + L * 0.36, 0.001], [R * 1.25, ue + L * 0.38, 0.0015], [R * 1.25, ue + L * 0.52, 0.0015], [R, ue + L * 0.54, 0.001],
    [R, uo - 0.095, 0.006], [Ro, uo - 0.045, 0.01], [Ro, uo - 0.004, 0.0015], [Ro * 0.9, uo, 0.0006], [Ro * 0.84, uo, 0], [Ro * 0.84, uo - 0.006, 0]];
  // close inner rear too
  C.lathe([[Re * 0.8, ue + 0.006, 0], ...pr], mat, 0.35, { tf: { p: [0, ay, 0] }, segMul: 1.2 });
  // lenses (slightly recessed), inner darkness
  C.P.add(cyl(Ro * 0.83, uo - 0.012, uo - 0.0055, { q: C.q, seg: 32, f: 0.0003 }), 'lens', 0, { p: [0, ay, 0] });
  C.P.add(cyl(Re * 0.78, ue + 0.003, ue + 0.008, { q: C.q, seg: 28, f: 0.0003 }), 'lens', 0, { p: [0, ay, 0] });
  // turrets: elevation (top), windage (right), parallax (left)
  const ut = ue + L * 0.45;
  const turret = (axisRot, h, rr) => {
    const g = lathe([[0, 0, 0], [rr * 0.9, 0, 0], [rr * 0.9, h * 0.45, 0.0005], [rr, h * 0.5, 0.0005], [rr, h, 0.001], [0, h, 0]], { q: C.q, seg: C.hi ? 22 : 8 });
    g.rotateX(Math.PI / 2); // along +Y
    C.P.add(g, mat, 0.6, { p: [0, ay, -ut], r: axisRot });
    if (C.hi) for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; const ridge = rbox(0.0012, h * 0.45, 0.0012, 0.0003, { q: C.q }); xf(ridge, { p: [Math.cos(a) * rr, h * 0.75, Math.sin(a) * rr] }); C.P.add(ridge, mat, 0.8, { p: [0, ay, -ut], r: axisRot }); }
  };
  turret([0, 0, 0], R + 0.017, 0.0105); turret([0, 0, -90], R + 0.015, 0.0095); turret([0, 0, 90], R + 0.013, 0.010);
  // rings + mounts
  for (const u of o.rings || [ue + 0.1, uo - 0.11]) {
    C.lathe([[R + 0.0005, u - 0.008, 0], [R + 0.0035, u - 0.008, 0.0008], [R + 0.0035, u + 0.008, 0.0008], [R + 0.0005, u + 0.008, 0]], 'blued', 0.5, { tf: { p: [0, ay, 0] }, closed: true });
    C.side([[u - 0.01, ay - R - 0.012, 0.001], [u + 0.01, ay - R - 0.012, 0.001], [u + 0.008, ay - R + 0.002, 0.002], [u - 0.008, ay - R + 0.002, 0.002]], 0.016, 'blued', 0.5, { bevel: 0.0009 });
    if (C.hi) { C.screw(u, ay - R - 0.004, 0.008, 1, 0.0018, 'steel'); C.screw(u, ay - R - 0.004, -0.008, -1, 0.0018, 'steel'); }
  }
}
// iron front sight post A-frame (AR style) on barrel at u, bore ay
function arFSB(C, u, ay, mat = 'park') {
  C.cyl(0.0125, u - 0.012, u + 0.012, mat, 0.4, { tf: { p: [0, ay, 0] } });
  C.side([[u - 0.012, ay + 0.008, 0.002], [u + 0.012, ay + 0.008, 0.002], [u + 0.006, ay + 0.050, 0.002], [u - 0.006, ay + 0.050, 0.002]], 0.014, mat, 0.45, { bevel: 0.001, holes: C.hi ? [[[u - 0.004, ay + 0.018, 0.001], [u + 0.004, ay + 0.018, 0.001], [u + 0.002, ay + 0.036, 0.001], [u - 0.002, ay + 0.036, 0.001]]] : [] });
  if (C.hi) {
    for (const s of [1, -1]) C.box(0.0028, 0.016, 0.009, 0.0008, mat, 0.6, { p: [s * 0.0068, ay + 0.057, -u] });
    C.cyl(0.0011, 0, 0.012, mat, 0.5, { tf: { p: [0, ay + 0.050, -u], r: [-90, 0, 0] }, seg: 8 });
    // bayonet lug & sling swivel
    C.box(0.006, 0.012, 0.012, 0.001, mat, 0.5, { p: [0, ay - 0.018, -u] });
  }
}
// birdcage flash hider
function birdcage(C, u0, ay, mat = 'park') {
  C.lathe([[0.0045, u0, 0], [0.0095, u0, 0.0006], [0.0105, u0 + 0.006, 0.0005], [0.0105, u0 + 0.045, 0.0008], [0.0060, u0 + 0.045, 0.0004], [0.0060, u0 + 0.040, 0]], mat, 0.5, { tf: { p: [0, ay, 0] }, closed: false });
  if (C.hi) for (let i = 0; i < 5; i++) { const a = (i / 5) * 360 + 90 + 36; const g = rbox(0.0026, 0.0034, 0.028, 0.0009, { q: C.q }); xf(g, { p: [0, 0.0103, -(u0 + 0.027)] }); C.P.add(g, 'dark', 0, { p: [0, ay, 0], r: [0, 0, a] }); }
}
// generic box magazine (side profile), returns nothing (adds into sub-context M)
function boxMag(M, top, front0, front1, back0, back1, w, mat, o = {}) {
  const hi = M.hi;
  const fr = bez2(front0, o.fc || [(front0[0] + front1[0]) / 2, (front0[1] + front1[1]) / 2], front1, hi ? 8 : 3);
  const bk = bez2(back0, o.bc || [(back0[0] + back1[0]) / 2, (back0[1] + back1[1]) / 2], back1, hi ? 8 : 3);
  sharpEnds(fr, 0.0015); sharpEnds(bk, 0.0015);
  M.side([...fr, ...bk.reverse()], w, mat, (x, y, z) => 0.3 + (y < back1[1] + 0.03 ? 0.4 : 0), { bevel: o.bevel ?? 0.0012, r: 0.0015 });
  // floorplate
  const fp = o.fp ?? 0.006;
  const d = [front1[0] - back1[0], front1[1] - back1[1]], L = Math.hypot(...d), nx = -d[1] / L, ny = d[0] / L;
  const ext = 0.003;
  const p0 = [back1[0] - d[0] / L * ext, back1[1] - d[1] / L * ext], p1 = [front1[0] + d[0] / L * ext, front1[1] + d[1] / L * ext];
  M.side([[p0[0] + nx * 0.001, p0[1] + ny * 0.001, 0.0015], [p1[0] + nx * 0.001, p1[1] + ny * 0.001, 0.0015], [p1[0] - nx * fp, p1[1] - ny * fp, 0.002], [p0[0] - nx * fp, p0[1] - ny * fp, 0.002]], w + 0.003, o.fpMat || mat, 0.85, { bevel: 0.0012 });
  if (hi && o.round !== false) {
    // top round
    const tu = (front0[0] + back0[0]) / 2, tv = Math.max(front0[1], back0[1]);
    M.lathe([[0, tu - 0.03, 0], [0.0046, tu - 0.03, 0.0003], [0.0046, tu, -1], [0.0040, tu + 0.006, 0]], 'brass', 0.2, { tf: { p: [0, tv + 0.002, 0] }, seg: 12 });
    M.lathe([[0.0040, tu + 0.0058, 0], [0.0036, tu + 0.012, -1], [0.0, tu + 0.020, 0]], 'copper', 0.1, { tf: { p: [0, tv + 0.002, 0] }, seg: 12 });
  }
}

// ============================================================================================
// AR-15 family (M4A4, M4A1-S)
// ============================================================================================
function buildAR(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi;
  const S = id === 'm4a1_s';
  const BV = 0.079;    // bore
  const RW = 0.0222;   // upper receiver width (half ~ 11mm), lower slightly wider
  const LW = 0.0235;
  // ---------------- lower receiver (with magwell, trigger guard, buffer tube boss)
  const lower = [[-0.085, 0.034, 0.003], [-0.050, 0.030, 0.006], [-0.010, 0.030, 0.002], [0.006, 0.033, 0.002], [0.052, 0.030, 0.002], [0.054, -0.006, 0.002],
    [0.058, -0.010, 0.001], [0.118, -0.010, 0.001], [0.122, -0.006, 0.002], [0.122, 0.030, 0.006], [0.135, 0.044, 0.004], [0.135, 0.062, 0.001], [-0.085, 0.062, 0.001], [-0.094, 0.052, 0.004]];
  C.side(lower, LW, 'anod', 0.3, { bevel: 0.0013, holes: hi ? [] : [] });
  // magwell flare & front bump
  if (hi) {
    C.side([[0.050, -0.0135, 0.001], [0.124, -0.0135, 0.001], [0.124, -0.004, 0.001], [0.050, -0.004, 0.001]], LW + 0.0035, 'anod', 0.6, { bevel: 0.0012 });
    // fence around mag release (right) and bolt catch (left)
    C.side([[0.040, 0.034, 0.003], [0.060, 0.034, 0.003], [0.060, 0.052, 0.003], [0.040, 0.052, 0.003]], 0.002, 'anod', 0.4, { x: LW / 2 + 0.0008, bevel: 0.0006 });
    C.cyl(0.0042, 0, 0.0018, 'steel', 0.6, { tf: { p: [LW / 2 + 0.0005, 0.043, -0.050], r: [0, -90, 0] }, seg: 14 });
    // bolt catch (left)
    C.side([[0.046, 0.045, 0.001], [0.066, 0.045, 0.001], [0.066, 0.060, 0.002], [0.050, 0.060, 0.002]], 0.0022, 'park', 0.6, { x: -LW / 2 - 0.0011, bevel: 0.0006 });
    // selector (left)
    C.cyl(0.0058, 0, 0.0015, 'anod', 0.5, { tf: { p: [-LW / 2 - 0.0002, 0.050, 0.004], r: [0, 90, 0] }, seg: 16 });
    C.side([[-0.008, 0.0485, 0.002], [0.020, 0.0505, 0.001], [0.020, 0.0535, 0.001], [-0.006, 0.0525, 0.002]], 0.0026, 'park', 0.7, { x: -LW / 2 - 0.0028, bevel: 0.0007 });
    // pins
    for (const s of [1, -1]) { C.pin(0.016, 0.044, s * LW / 2, s, 0.0022); C.pin(0.040, 0.044, s * LW / 2, s, 0.0022); C.pin(0.128, 0.055, s * LW / 2, s, 0.0026, 'steel'); C.pin(-0.072, 0.055, s * LW / 2, s, 0.0026, 'steel'); }
    addMarking(C.root, ['SAFE', '', 'SEMI', '', 'AUTO'], -0.003, 0.040, -LW / 2 - 0.0001, -1, 0.014, 0.020, { opacity: 0.6, color: 0xd8d8d0, metal: 0.1, rough: 0.6, ph: 256, pw: 160 });
    addMarking(C.root, ['PROPERTY OF ---', 'CAL 5.56MM', 'SER W 118204'], 0.080, 0.042, -LW / 2 - 0.0001, -1, 0.040, 0.014, { opacity: 0.45, color: 0xd0d0c8, metal: 0.1, rough: 0.6, ph: 192 });
  }
  // trigger guard (integral)
  C.side([[0.004, 0.031, 0], [0.004, 0.004, 0.006], [0.012, -0.002, 0.005], [0.052, -0.002, 0.003], [0.054, 0.006, 0.002], [0.054, 0.031, 0]], 0.009, 'anod', 0.5,
    { bevel: 0.0012, holes: [[[0.0095, 0.029, 0.002], [0.0095, 0.0075, 0.004], [0.015, 0.0035, 0.004], [0.049, 0.0035, 0.002], [0.049, 0.029, 0.002]]] });
  C.side([[0.029, 0.031, 0], [0.034, 0.031, 0], [0.032, 0.020, -1], [0.030, 0.013, 0.001], [0.026, 0.010, 0.001], [0.025, 0.014, -1], [0.027, 0.022, -1]], 0.005, 'steel', 0.6, { bevel: 0.0008 });
  // ---------------- upper receiver
  const upper = [[-0.090, 0.062, 0.001], [0.135, 0.062, 0.001], [0.135, 0.094, 0.002], [-0.088, 0.094, 0.002], [-0.092, 0.080, 0.002]];
  C.side(upper, RW, 'anod', 0.3, { bevel: 0.0014, holes: hi ? [[[0.000, 0.0675, 0.0015], [0.062, 0.0675, 0.0015], [0.062, 0.0855, 0.0015], [0.000, 0.0855, 0.0015]]] : [] });
  if (hi) {
    // inner core visible through the port (bolt carrier sits in front)
    C.side([[0.000, 0.066, 0], [0.062, 0.066, 0], [0.062, 0.088, 0], [0.000, 0.088, 0]], RW * 0.7, 'parkDark', 0, { bevel: 0.0002, x: -RW * 0.1 });
    // ejection port dust cover hinge rod + brass deflector + forward assist
    C.cyl(0.0012, -0.002, 0.066, 'steel', 0.5, { tf: { p: [RW / 2 + 0.001, 0.0655, 0] }, seg: 8 });
    C.side([[-0.010, 0.072, 0.002], [0.002, 0.072, 0.002], [0.002, 0.093, 0.003], [-0.010, 0.088, 0.003]], 0.006, 'anod', 0.6, { x: RW / 2 + 0.002, bevel: 0.0012 });
    C.lathe([[0, -0.030, 0], [0.0058, -0.030, 0.0008], [0.0058, -0.020, 0.0008], [0.0045, -0.012, 0]], 'anod', 0.5, { tf: { p: [RW / 2 + 0.002, 0.080, 0], r: [0, 25, 0] } });
    C.cyl(0.0052, -0.035, -0.030, 'steel', 0.7, { tf: { p: [RW / 2 + 0.002, 0.080, 0], r: [0, 25, 0] }, seg: 16 });
    // upper reinforcement around barrel nut
    C.side([[0.118, 0.063, 0.001], [0.135, 0.063, 0.001], [0.135, 0.093, 0.001], [0.118, 0.093, 0.001]], RW + 0.002, 'anod', 0.4, { bevel: 0.0008 });
  }
  // flat-top rail
  rail(C, -0.085, 0.130, BV, 0.0155, 0, 'anod');
  // ---------------- charging handle (bolt group: carrier visible in port + charging handle)
  const B = C.sub('bolt', [0, 0.09, 0.09]);
  if (hi) B.side([[-0.004, 0.0685, 0.001], [0.064, 0.0685, 0.001], [0.064, 0.0845, 0.001], [-0.004, 0.0845, 0.001]], 0.004, 'steel', 0.5, { x: RW / 2 - 0.0035, bevel: 0.0006 });
  B.side([[-0.108, 0.088, 0.002], [-0.090, 0.088, 0.001], [-0.090, 0.096, 0.001], [-0.104, 0.097, 0.002]], 0.034, 'anod', 0.7, { bevel: 0.0013 });
  if (hi) B.side([[-0.108, 0.0915, 0.001], [-0.102, 0.0915, 0.001], [-0.102, 0.0965, 0.001], [-0.108, 0.0965, 0.001]], 0.042, 'anod', 0.8, { bevel: 0.001 });
  B.flush();
  // ---------------- buffer tube + stock
  C.cyl(0.0152, -0.30, -0.088, 'anod', 0.3, { tf: { p: [0, 0.078, 0] }, segMul: 0.9 });
  C.lathe([[0.0175, -0.094, 0.001], [0.0175, -0.084, 0.001], [0.015, -0.082, 0]], 'anod', 0.5, { tf: { p: [0, 0.078, 0] } });
  if (hi) C.cyl(0.0182, -0.110, -0.098, 'park', 0.6, { tf: { p: [0, 0.078, 0] } }); // castle nut
  {
    // collapsible stock body (polymer) sliding on the tube
    const sp = [[-0.205, 0.094, 0.006], [-0.300, 0.096, 0.004], [-0.308, 0.094, 0.004], [-0.308, -0.008, 0.006], [-0.296, -0.008, 0.006], [-0.262, 0.032, 0.01], [-0.215, 0.058, 0.01], [-0.205, 0.064, 0.004]];
    C.side(sp, 0.036, 'poly', 0.35, { bevel: 0.004, bseg: hi ? 3 : 1, r: 0.004 });
    // lightening recess look via raised outer rails
    if (hi) {
      for (const s of [1, -1]) C.side([[-0.270, 0.040, 0.004], [-0.226, 0.062, 0.004], [-0.226, 0.068, 0.004], [-0.272, 0.050, 0.004]], 0.003, 'poly', 0.4, { x: s * 0.0185, bevel: 0.001 });
      // adjustment lever under the tube
      C.box(0.008, 0.008, 0.035, 0.002, 'poly', 0.6, { p: [0, 0.058, 0.228] });
      // rubber butt pad
      C.side([[-0.316, 0.096, 0.004], [-0.307, 0.096, 0.002], [-0.307, -0.009, 0.002], [-0.316, -0.009, 0.004]], 0.040, 'rubber', 0.6, { bevel: 0.003 });
      // sling slot
      C.box(0.037, 0.004, 0.012, 0.0015, 'dark', 0, { p: [0, 0.005, 0.300] });
    }
  }
  // ---------------- pistol grip (A2, polymer, finger bump)
  {
    const ga = 22 * D2R;
    const g = loft([{ z: -0.070, w: 0.0255, h: 0.035, y: 0.002, r: 0.009 }, { z: -0.066, w: 0.0275, h: 0.039, y: 0.002, r: 0.011 }, { z: -0.030, w: 0.0285, h: 0.042, y: 0.0005, r: 0.012 },
      { z: -0.005, w: 0.0282, h: 0.039, y: -0.0025, r: 0.012 }, { z: 0.010, w: 0.028, h: 0.041, y: 0.0, r: 0.012 }, { z: 0.034, w: 0.0255, h: 0.040, y: 0.0, r: 0.010 }, { z: 0.042, w: 0.0245, h: 0.039, y: 0.0, r: 0.008 }], { q, steps: hi ? 3 : 1, ca: hi ? 5 : 2 });
    g.rotateX(-Math.PI / 2); g.rotateX(-ga);
    C.P.add(g, 'polyStip', 0.5);
    // beavertail
    C.side([[-0.040, 0.034, 0.004], [-0.020, 0.031, 0.003], [-0.012, 0.035, 0.002], [-0.040, 0.040, 0.004]], 0.024, 'polyStip', 0.6, { bevel: 0.003 });
  }
  // ---------------- handguard
  if (!S) {
    // quad rail (RIS) handguard
    const k = (u, s = 1) => ({ z: -u, w: 0.046 * s, h: 0.046 * s, y: BV - 0.001, r: 0.009 * s });
    C.loft([k(0.133, 0.92), k(0.137), k(0.320), k(0.324, 0.93)], 'anod', 0.35, { smooth: false });
    rail(C, 0.140, 0.318, BV, 0.0228, 0, 'anod'); rail(C, 0.140, 0.318, BV, 0.0228, 90, 'anod'); rail(C, 0.140, 0.318, BV, 0.0228, -90, 'anod'); rail(C, 0.140, 0.318, BV, 0.0228, 180, 'anod');
    if (hi) {
      // vented gaps between rails (dark)
      for (let i = 0; i < 7; i++) for (const a of [45, 135, 225, 315]) { const g = rbox(0.003, 0.0085, 0.012, 0.0012, { q }); xf(g, { p: [0, 0.0228, -(0.152 + i * 0.024)], r: [0, 0, 0] }); C.P.add(g, 'dark', 0, { p: [0, BV, 0], r: [0, 0, a] }); }
      // rail cover panel (polymer) on the bottom where the hand goes
      C.loft([{ z: -0.17, w: 0.024, h: 0.007, y: BV - 0.0262, r: 0.003 }, { z: -0.30, w: 0.024, h: 0.007, y: BV - 0.0262, r: 0.003 }], 'polyStip', 0.6, { smooth: false });
    }
  } else {
    // slim aluminium handguard with lightening slots (M4A1-S)
    const k = (u, w = 0.040, h = 0.043) => ({ z: -u, w, h, y: BV - 0.002, r: 0.015 });
    C.loft([k(0.133, 0.040, 0.044), k(0.137, 0.042, 0.046), k(0.300, 0.042, 0.045), k(0.305, 0.040, 0.043)], 'anod', 0.35, { smooth: false, ca: hi ? 6 : 2 });
    rail(C, 0.140, 0.300, BV, 0.0228, 0, 'anod');
    if (hi) for (let i = 0; i < 5; i++) for (const s of [1, -1]) { const g = rbox(0.002, 0.008, 0.020, 0.0035, { q }); C.P.add(g, 'dark', 0, { p: [s * 0.0205, BV - 0.004, -(0.165 + i * 0.027)] }); }
    if (hi) for (const s of [1, -1]) rail(C, 0.255, 0.295, BV, 0.0222, s * 90, 'anod');
  }
  // delta ring / barrel nut
  C.lathe([[0.0175, 0.128, 0.001], [0.024, 0.130, 0.001], [0.024, 0.136, 0.001], [0.0175, 0.138, 0]], 'anod', 0.5, { tf: { p: [0, BV, 0] }, closed: false });
  // ---------------- barrel, gas block / front sight, muzzle
  const muzU = S ? 0.395 : 0.495;
  C.lathe([[0.0098, 0.13, 0], [0.0098, 0.31, -1], [0.0088, 0.33, 0.001], [0.0082, 0.34, -1], [0.0080, muzU - 0.003, 0.0004], [0.004, muzU, 0]], 'park', 0.3, { tf: { p: [0, BV, 0] } });
  if (!S) { arFSB(C, 0.336, BV); birdcage(C, 0.452, BV); }
  else {
    // low profile gas block + suppressor
    C.side([[0.304, BV - 0.012, 0.002], [0.324, BV - 0.012, 0.002], [0.324, BV + 0.014, 0.002], [0.304, BV + 0.014, 0.002]], 0.024, 'park', 0.4, { bevel: 0.0014 });
    can(C, 0.375, 0.170, 0.0175, BV, 'park');
  }
  // ---------------- sights: folding rear BUIS
  {
    const u = -0.068;
    C.side([[u - 0.014, BV + 0.019, 0.001], [u + 0.014, BV + 0.019, 0.001], [u + 0.010, BV + 0.027, 0.002], [u - 0.012, BV + 0.027, 0.002]], 0.022, 'park', 0.5, { bevel: 0.001 });
    C.side([[u - 0.008, BV + 0.026, 0.001], [u - 0.002, BV + 0.026, 0.001], [u - 0.002, BV + 0.050, 0.003], [u - 0.008, BV + 0.050, 0.003]], 0.020, 'park', 0.6, { bevel: 0.001, holes: hi ? [[[u - 0.0095, BV + 0.040, 0.001], [u - 0.0005, BV + 0.040, 0.001], [u - 0.0005, BV + 0.045, 0.001], [u - 0.0095, BV + 0.045, 0.001]]] : [] });
    if (hi) C.cyl(0.0042, 0, 0.004, 'park', 0.6, { tf: { p: [0.012, BV + 0.024, -u], r: [0, -90, 0] }, seg: 14 });
  }
  // ---------------- magazine
  const magL = S ? 0.125 : 0.178;
  const M = C.sub('mag', [0, 0.05, -0.115]);
  boxMag(M, 0.062, [0.116, 0.058], [0.128 + (S ? 0.012 : 0.026), 0.058 - magL], [0.0585, 0.058], [0.068 + (S ? 0.010 : 0.022), 0.058 - magL - 0.004], 0.0215, 'park', { fc: [0.117, 0.0], bc: [0.059, 0.0], fp: 0.007, fpMat: 'poly' });
  if (hi) for (const s of [1, -1]) M.side([[0.066, 0.040, 0.0015], [0.111, 0.040, 0.0015], [0.111 + 0.004, 0.058 - magL * 0.82, 0.0015], [0.070 + 0.004, 0.058 - magL * 0.82, 0.0015]], 0.0012, 'park', 0.6, { x: s * 0.0108, bevel: 0.0005 });
  M.flush();
  return finish(C, {
    muzzle: anchor('muzzle', S ? 0.545 : 0.497, BV), eject: anchor('eject', 0.032, 0.077, RW / 2 + 0.003),
    leftHand: anchor('leftHand', 0.24, BV), mag: M.group, bolt: B.group,
    hold: 'rifle', gripAngle: 22 * D2R, handguard: { w: S ? 0.042 : 0.052, h: S ? 0.045 : 0.052, y: BV, u: 0.235 },
    gripBox: { c: [0, -0.012, 0.004], half: [0.0145, 0.056, 0.020], r: 0.0105 },
    boltAxis: new THREE.Vector3(0, 0, 1), boltTravel: 0.072, charge: 'ar', chargePt: new THREE.Vector3(-0.016, 0.050, -0.058), magDrop: 'straight', sightHeight: BV + 0.04,
  });
}

// ============================================================================================
// AWP (bolt action, thumbhole chassis, big scope)
// ============================================================================================
function buildAWP(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi;
  const BV = 0.072;
  // chassis stock (OD green polymer): side profile with thumbhole
  const st = [
    [0.400, 0.052, 0.008], [0.400, 0.074, 0.006], [0.120, 0.074, 0.003], [0.060, 0.062, 0.002], [-0.062, 0.062, 0.003], [-0.085, 0.076, 0.010], [-0.240, 0.080, 0.012], [-0.420, 0.074, 0.008],
    [-0.428, 0.060, 0.004], [-0.430, -0.072, 0.006], [-0.405, -0.075, 0.01], [-0.300, -0.040, 0.02], [-0.150, 0.000, 0.012], [-0.100, -0.010, 0.01], [-0.060, -0.088, 0.008],
    [-0.030, -0.088, 0.006], [0.012, 0.010, 0.01], [0.030, 0.026, 0.006], [0.160, 0.030, 0.01], [0.380, 0.034, 0.012],
  ];
  const hole = [[-0.050, 0.044, 0.012], [-0.088, 0.054, 0.012], [-0.200, 0.040, 0.014], [-0.140, 0.010, 0.012], [-0.090, 0.012, 0.012], [-0.055, -0.020, 0.012]];
  C.side(st, 0.046, 'polyOD', (x, y, z) => 0.3 + (-z < 0.05 && -z > -0.1 ? 0.35 : 0), { bevel: hi ? 0.006 : 0.004, bseg: hi ? 3 : 1, r: 0.004, holes: [hole], hr: 0.008,
    wfn: (u, v) => (u > 0.06 ? 0.86 : 1.0) });
  // trigger guard (part of chassis, black)
  C.side([[-0.040, 0.040, 0], [-0.040, 0.010, 0.012], [0.040, 0.010, 0.008], [0.050, 0.030, 0]], 0.012, 'park', 0.5, { bevel: 0.0012, holes: [[[-0.034, 0.038, 0.002], [-0.034, 0.016, 0.008], [0.036, 0.016, 0.004], [0.042, 0.030, 0.002], [0.040, 0.038, 0.002]]] });
  C.side([[0.008, 0.040, 0], [0.013, 0.040, 0], [0.011, 0.028, -1], [0.008, 0.021, 0.001], [0.004, 0.020, 0.001], [0.0045, 0.025, -1], [0.006, 0.033, -1]], 0.005, 'steel', 0.6, { bevel: 0.0008 });
  if (hi) {
    // cheek piece + adjustment knobs, butt spacers, rubber pad
    C.side([[-0.130, 0.079, 0.008], [-0.330, 0.077, 0.008], [-0.330, 0.093, 0.006], [-0.150, 0.095, 0.008]], 0.040, 'polyOD', 0.5, { bevel: 0.005, bseg: 3 });
    C.cyl(0.006, 0, 0.006, 'park', 0.6, { tf: { p: [0.021, 0.083, 0.24], r: [0, -90, 0] }, seg: 14 });
    C.side([[-0.438, 0.072, 0.004], [-0.429, 0.072, 0.002], [-0.429, -0.071, 0.002], [-0.438, -0.071, 0.004]], 0.044, 'rubber', 0.6, { bevel: 0.003 });
    // rear monopod spike
    // sling studs / QD cups
    C.cyl(0.006, 0, 0.004, 'steel', 0.5, { tf: { p: [-0.0235, 0.040, 0.36], r: [0, 90, 0] }, seg: 14 });
    // finger grooves on forend sides
    for (let i = 0; i < 6; i++) for (const s of [1, -1]) C.box(0.002, 0.012, 0.010, 0.0015, 'polyOD', 0.7, { p: [s * 0.0205, 0.052, -(0.16 + i * 0.03)] });
  }
  // ---------------- action (receiver), bolt
  C.lathe([[0.0, -0.075, 0], [0.0165, -0.075, 0.002], [0.0175, -0.065, 0.002], [0.0175, 0.160, 0.002], [0.016, 0.170, 0], [0, 0.170, 0]], 'blued', 0.3, { tf: { p: [0, BV, 0] }, segMul: 1 });
  if (hi) {
    // ejection port (dark slot on the right) + bolt visible
    C.side([[0.020, BV - 0.004, 0.003], [0.085, BV - 0.004, 0.003], [0.085, BV + 0.014, 0.003], [0.020, BV + 0.014, 0.003]], 0.004, 'dark', 0, { x: 0.0158 });
  }
  rail(C, -0.065, 0.165, BV, 0.0175, 0, 'blued');
  const B = C.sub('bolt', [0, BV, 0.0]);
  B.cyl(0.0102, -0.115, 0.08, 'chrome', 0.5, { tf: { p: [0, BV, 0] }, seg: 20 });
  B.lathe([[0, -0.12, 0], [0.012, -0.12, 0.002], [0.012, -0.10, 0.002], [0.010, -0.098, 0]], 'blued', 0.5, { tf: { p: [0, BV, 0] } }); // bolt shroud
  // bolt handle: arm to the right, knob
  B.cyl(0.0042, 0, 0.040, 'blued', 0.6, { tf: { p: [0.008, BV, 0.025], r: [0, -90, 10] }, seg: 12 });
  B.P.add(sphere(0.0105, { q, segMul: 0.6 }), 'polyOD', 0.7, { p: [0.050, BV - 0.003, 0.026], s: [1, 1, 1.15] });
  B.flush();
  // ---------------- barrel (heavy, fluted look) + muzzle brake
  C.lathe([[0.0145, 0.165, 0], [0.0145, 0.25, -1], [0.0115, 0.45, -1], [0.0102, 0.715, 0.001], [0.005, 0.716, 0]], 'blued', 0.25, { tf: { p: [0, BV, 0] } });
  if (hi) for (let i = 0; i < 6; i++) { const a = i * 60; const g = rbox(0.003, 0.0018, 0.20, 0.0008, { q }); xf(g, { p: [0, 0.0122, -0.36] }); C.P.add(g, 'dark', 0, { p: [0, BV, 0], r: [0, 0, a] }); }
  C.lathe([[0.0055, 0.705, 0], [0.0145, 0.705, 0.001], [0.0145, 0.760, 0.002], [0.0060, 0.760, 0.001]], 'blued', 0.5, { tf: { p: [0, BV, 0] }, closed: true });
  if (hi) for (let i = 0; i < 3; i++) for (const s of [1, -1]) C.box(0.012, 0.007, 0.0065, 0.0012, 'dark', 0, { p: [s * 0.0105, BV, -(0.718 + i * 0.013)] });
  // ---------------- folded bipod under forend
  if (hi) {
    C.box(0.026, 0.012, 0.03, 0.003, 'park', 0.5, { p: [0, 0.028, -0.37] });
    for (const s of [1, -1]) { C.cyl(0.0042, 0.16, 0.37, 'park', 0.5, { tf: { p: [s * 0.009, 0.022, 0] }, seg: 10 }); C.P.add(sphere(0.006, { q, segMul: 0.5 }), 'rubber', 0.5, { p: [s * 0.009, 0.022, -0.16] }); }
  }
  // ---------------- scope
  scope(C, -0.150, 0.275, 0.132, { r: 0.0165, re: 0.0235, ro: 0.032, rings: [-0.03, 0.135] });
  // ---------------- magazine (5 rd)
  const M = C.sub('mag', [0, 0.03, -0.09]);
  M.side([[0.060, 0.050, 0.002], [0.122, 0.050, 0.002], [0.122, 0.006, 0.003], [0.060, 0.006, 0.003]], 0.030, 'park', 0.4, { bevel: 0.0015 });
  M.side([[0.057, 0.010, 0.002], [0.125, 0.010, 0.002], [0.125, -0.001, 0.003], [0.057, -0.001, 0.003]], 0.034, 'park', 0.8, { bevel: 0.0015 });
  M.flush();
  return finish(C, {
    muzzle: anchor('muzzle', 0.76, BV), eject: anchor('eject', 0.05, BV + 0.006, 0.02), leftHand: anchor('leftHand', 0.27, 0.05),
    mag: M.group, bolt: B.group, scope: true, hold: 'rifle', gripAngle: 12 * D2R,
    handguard: { w: 0.042, h: 0.042, y: 0.053, u: 0.27 },
    gripBox: { c: [0, -0.02, 0.06], half: [0.0165, 0.06, 0.022], r: 0.012 },
    gripR: { contact: [0.0145, -0.017, -0.012] },
    boltAxis: new THREE.Vector3(0, 0, 1), boltTravel: 0.095, charge: 'bolt', boltKnob: new THREE.Vector3(0.05, BV - 0.003, 0.026), boreY: BV, boltLift: 1.05,
    magDrop: 'straight', sightHeight: 0.128,
  });
}

// ============================================================================================
// Pistols
// ============================================================================================
// generic grip loft along a tilted axis; y range [y0,y1] along the axis, returns geometry added to C
function gripLoft(C, mat, ang, y0, y1, w, d, o = {}) {
  const q = C.q, hi = C.hi;
  const secs = [];
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const t = i / n, y = lerp(y0, y1, t);
    const sw = (o.swell ?? 0.06) * Math.sin(t * Math.PI);
    let dd = d * (1 + sw) * (o.taper ? lerp(1 - o.taper, 1, t) : 1);
    let ww = w * (1 + sw * 0.5);
    let off = (o.backSwell ?? 0.0) * Math.sin(t * Math.PI);
    if (o.grooves && hi && i > 0 && i < n) { /* finger grooves via front offset */ off += 0.0015 * Math.cos(t * Math.PI * o.grooves * 2); }
    secs.push({ z: y, w: ww, h: dd, y: off, r: Math.min(ww, dd) * (o.round ?? 0.38) });
  }
  secs[0].w *= 0.92; secs[0].h *= 0.96;
  const g = loft(secs, { q, steps: hi ? 2 : 1, ca: hi ? 5 : 2 });
  g.rotateX(-Math.PI / 2); g.rotateX(-ang);
  if (o.shift) g.translate(...o.shift);
  return C.P.add(g, mat, o.wear ?? 0.55);
}
// point along grip axis (s = distance along axis from origin, positive up)
function gripPt(ang, s, fwd = 0) { return [0, s * Math.cos(ang) - fwd * Math.sin(ang), -s * Math.sin(ang) - fwd * Math.cos(ang)]; }
// pistol magazine inside the grip (sub-context), pivot at grip bottom
function pistolMag(C, ang, yBot, len, w, d, baseMat = 'poly', bodyMat = 'park', o = {}) {
  const bot = gripPt(ang, yBot);
  const M = C.sub('mag', bot);
  const g = rbox(w, len, d, 0.0025, { q: C.q });
  g.translate(0, len / 2 + 0.004, o.fwd ?? 0.003);
  g.rotateX(-ang); g.translate(...bot);
  M.P.add(g, bodyMat, 0.4);
  const b = rbox(w + 0.004, 0.008, d + 0.006, 0.0025, { q: C.q });
  b.translate(0, 0.0, (o.fwd ?? 0.003) + 0.001); b.rotateX(-ang); b.translate(...bot);
  M.P.add(b, baseMat, 0.85);
  if (C.hi) { // top round
    const tp = gripPt(ang, yBot + len + 0.004, -0.004);
    M.lathe([[0, -0.012, 0], [0.0045, -0.012, 0.0003], [0.0045, 0.002, -1], [0.0, 0.010, 0]], 'brass', 0.2, { tf: { p: tp, r: [0, 0, 0] }, seg: 10 });
  }
  return M;
}
function buildPistol(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi;
  const P = PISTOLS[id];
  const ang = P.ang * D2R;
  const B = C.sub('bolt', [0, P.sv0, 0]);
  // ---------------- slide
  {
    const [u0, u1, v0, v1] = [P.su0, P.su1, P.sv0, P.sv1];
    const ch = P.chamfer ?? 0.004;
    const prof = P.slideProfile || [[u0, v0, 0.002], [u1, v0, 0.0015], [u1, v1 - ch, 0.0015], [u1 - ch * 1.6, v1, 0.002], [u0 + 0.006, v1, 0.003], [u0, v1 - 0.006, 0.002]];
    const holes = [];
    if (P.openTop) holes.push([[u0 + 0.06, v1 - 0.009, 0.002], [u1 - 0.012, v1 - 0.009, 0.002], [u1 - 0.012, v1 + 0.01, 0], [u0 + 0.06, v1 + 0.01, 0]]);
    B.side(prof, P.sw, P.slideMat || 'park', 0.35, { bevel: P.slideBevel ?? 0.0025, bseg: hi ? 3 : 1, r: 0.0015 });
    if (hi) {
      // rear (and optional front) serrations
      const ser = (a, b) => { const n = Math.round((b - a) / 0.0028); for (let i = 0; i < n; i++) for (const sx of [1, -1]) B.box(0.0007, (v1 - v0) * 0.62, 0.0012, 0.0003, 'dark', 0, { p: [sx * (P.sw / 2 - 0.0001), (v0 + v1) / 2 + 0.001, -(a + i * 0.0028 + 0.0014)] }); };
      ser(u0 + 0.004, u0 + 0.004 + (P.serr ?? 0.026));
      if (P.frontSerr) ser(u1 - 0.032, u1 - 0.008);
      // ejection port + barrel hood
      if (!P.openTop) {
        B.side([[P.ep0, v1 - 0.013, 0.001], [P.ep1, v1 - 0.013, 0.001], [P.ep1, v1 + 0.0006, 0], [P.ep0, v1 + 0.0006, 0]], 0.012, 'dark', 0, { x: P.sw / 2 - 0.0058, bevel: 0.0002 });
        B.side([[P.ep0 + 0.002, v1 - 0.010, 0.001], [P.ep1 - 0.001, v1 - 0.010, 0.001], [P.ep1 - 0.001, v1 + 0.0004, 0.001], [P.ep0 + 0.002, v1 + 0.0004, 0.001]], 0.010, P.barrelMat || 'steel', 0.6, { x: 0.0005, bevel: 0.0007 });
      }
      // sights
      B.side([[u0 + 0.004, v1 - 0.0005, 0.0005], [u0 + 0.014, v1 - 0.0005, 0.0005], [u0 + 0.013, v1 + 0.0035, 0.0006], [u0 + 0.004, v1 + 0.0035, 0.0006]], 0.017, 'park', 0.5, { bevel: 0.0007 });
      for (const sx of [1, -1]) B.side([[u0 + 0.004, v1 + 0.003, 0.0004], [u0 + 0.0125, v1 + 0.003, 0.0004], [u0 + 0.0115, v1 + 0.0068, 0.0006], [u0 + 0.004, v1 + 0.0068, 0.0006]], 0.0055, 'park', 0.5, { x: sx * 0.0058, bevel: 0.0006 });
      B.side([[u1 - 0.016, v1, 0.0004], [u1 - 0.007, v1, 0.0004], [u1 - 0.009, v1 + 0.0062, 0.0008], [u1 - 0.014, v1 + 0.0062, 0.0008]], 0.0035, 'park', 0.5, { bevel: 0.0007 });
      const dotM = P.dots === 'tritium' ? 'tritium' : P.dots === 'fiber' ? 'fiberRed' : 'white';
      B.sph(0.0011, dotM, 0, { p: [0, v1 + 0.0045, -(u1 - 0.0115) + 0.0018] });
      if (P.dots) for (const sx of [1, -1]) B.sph(0.0009, dotM, 0, { p: [sx * 0.0058, v1 + 0.0050, -(u0 + 0.0095) - 0.0005] });
      addMarking(C.root, [P.mark || 'CAL 9x19'], (u0 + u1) / 2 + 0.01, (v0 + v1) / 2 - 0.002, -P.sw / 2 - 0.0001, -1, 0.040, 0.0055, { opacity: 0.4, color: 0xc8c8c0 });
    } else {
      B.box(0.006, 0.005, 0.008, 0.001, 'park', 0.5, { p: [0, v1 + 0.0025, -(u0 + 0.009)] });
    }
    if (P.slideExtra) P.slideExtra(B, P);
  }
  B.flush();
  // ---------------- barrel (visible at the muzzle, and on top for open-top slides)
  const bu = P.bu ?? P.su1 + 0.001;
  C.lathe([[P.br * 0.55, P.su1 - 0.05, 0], [P.br, P.su1 - 0.05, 0.0003], [P.br, bu, 0.0005], [P.br * 0.55, bu, 0.0004], [P.br * 0.5, bu - 0.004, 0]], P.barrelMat || 'steel', 0.4, { tf: { p: [0, P.bore, 0] }, seg: 20 });
  if (P.openTop) C.lathe([[0, P.su0 + 0.05, 0], [P.br * 1.05, P.su0 + 0.05, 0.001], [P.br * 1.05, P.su1 - 0.01, 0.001], [0, P.su1 - 0.01, 0]], P.barrelMat || 'steel', 0.5, { tf: { p: [0, P.bore, 0] }, seg: 20 });
  // ---------------- frame (with integral trigger guard)
  {
    const fv = P.fv; // top of frame (= slide bottom)
    const { gu0, gu1, gv } = P.guard;
    const dv = P.dustV ?? (fv - 0.016);
    const fu1 = P.fu1 ?? P.su1 - 0.012;
    const gt = gripPt(ang, P.gripTop);
    const gripFront = gt[2] * -1 + 0.020;
    const outer = [[P.fu0, fv, 0.002], [fu1, fv, 0.001], [fu1, dv + 0.002, 0.002], [fu1 - 0.004, dv, 0.002], [gu1 + 0.004, dv, 0.004],
      [gu1, gv + (P.squareGuard ? 0.012 : 0.010), P.squareGuard ? 0.002 : 0.012], [gu1 - (P.squareGuard ? 0.001 : 0.012), gv, P.squareGuard ? 0.003 : 0.008], [gu0 + 0.006, gv, 0.006], [gu0 - 0.002, gv + 0.012, 0.006], [gu0 - 0.004, P.gripTopV ?? (fv - 0.022), 0.004],
      [P.fu0 + 0.004, P.gripTopV ?? (fv - 0.022), 0.006], [P.fu0 - (P.tang ?? 0.008), fv - 0.010, 0.005]];
    const hole = [[gu0 + 0.0045, dv - 0.0035, 0.002], [gu1 - 0.004, dv - 0.0035, 0.002], [gu1 - 0.0035, gv + 0.011, P.squareGuard ? 0.002 : 0.008], [gu1 - 0.008, gv + 0.0045, P.squareGuard ? 0.002 : 0.006], [gu0 + 0.008, gv + 0.0045, 0.005], [gu0 + 0.0035, gv + 0.012, 0.004]];
    C.side(outer, P.fw, P.frameMat || 'poly', 0.35, { bevel: 0.0018, bseg: hi ? 2 : 1, holes: [hole], r: 0.0015, wfn: P.fwfn });
    if (hi && P.rail) for (let i = 0; i < P.rail; i++) C.box(P.fw + 0.0004, 0.0022, 0.0035, 0.0006, 'dark', 0, { p: [0, dv + 0.003, -(fu1 - 0.008 - i * 0.0085)] });
    // trigger
    const tu = P.trigU ?? (gu0 + 0.022);
    C.side([[tu - 0.002, dv + 0.001, 0], [tu + 0.004, dv + 0.001, 0], [tu + 0.0025, dv - 0.008, -1], [tu, dv - 0.014, 0.0012], [tu - 0.0045, dv - 0.016, 0.0012], [tu - 0.004, dv - 0.011, -1], [tu - 0.002, dv - 0.005, -1]], 0.0055, P.trigMat || 'steel', 0.6, { bevel: 0.0009 });
    if (hi) {
      // slide stop / takedown lever (left), mag release (left)
      C.side([[gu0 + 0.008, fv - 0.0045, 0.001], [gu1 - 0.004, fv - 0.0035, 0.001], [gu1 - 0.004, fv - 0.0005, 0.001], [gu0 + 0.010, fv - 0.0010, 0.002]], 0.002, 'park', 0.6, { x: -P.fw / 2 - 0.0009, bevel: 0.0006 });
      C.box(0.0025, 0.007, 0.010, 0.0012, P.frameMat || 'poly', 0.6, { p: [-P.fw / 2 - 0.0008, dv - 0.006, -(gu0 + 0.0005)] });
      C.pin(gu0 + 0.015, fv - 0.006, P.fw / 2, 1, 0.0015); C.pin(gu0 + 0.015, fv - 0.006, -P.fw / 2, -1, 0.0015);
    }
    // grip
    gripLoft(C, P.gripMat || 'polyStip', ang, P.gripBot, P.gripTop, P.gw, P.gd, { grooves: P.grooves, swell: P.swell ?? 0.05, backSwell: P.backSwell ?? 0.002, round: P.gripRound, shift: [0, 0, P.gripBack ?? 0.008] });
    if (P.panels && hi) {
      // separate grip panels (wood/rubber) on both sides
      for (const sx of [1, -1]) gripLoft(C, P.panels, ang, P.gripBot + 0.010, P.gripTop - 0.014, 0.003, P.gd * 0.72, { shift: [sx * (P.gw / 2 - 0.0002), 0, (P.gripBack ?? 0.008) + 0.002], swell: 0.04, wear: 0.6, round: 0.45 });
    }
    // hammer / beavertail
    if (P.hammer) {
      const H = C.sub('hammer', [0, fv + 0.004, -(P.su0 + 0.004)]);
      H.side([[P.su0 + 0.006, fv - 0.004, 0.001], [P.su0 + 0.0, fv - 0.004, 0.001], [P.su0 - 0.009, fv + 0.012, 0.003], [P.su0 - 0.004, fv + 0.014, 0.003], [P.su0 + 0.002, fv + 0.004, 0.001]], 0.007, 'park', 0.7, { bevel: 0.0009 });
      H.flush();
    }
  }
  // ---------------- suppressor (USP-S)
  if (P.can) { C.lathe([[P.br * 0.6, bu - 0.002, 0], [P.br * 0.95, bu - 0.002, 0.0003], [P.br * 0.95, bu + 0.012, 0.0003], [P.br * 0.6, bu + 0.012, 0]], 'steel', 0.5, { tf: { p: [0, P.bore, 0] }, seg: 16 }); can(C, bu + 0.010, P.can[0], P.can[1], P.bore, 'park'); }
  // ---------------- magazine
  const M = pistolMag(C, ang, P.gripBot - 0.002, P.magLen ?? 0.088, P.gw * 0.72, P.gd * 0.62, P.magBase || 'poly', 'park', { fwd: (P.magFwd ?? 0.004) - (P.gripBack ?? 0.008) });
  if (P.extra) P.extra(C, P);
  M.flush();
  const muz = P.can ? bu + 0.010 + P.can[0] : bu;
  const ud = {
    muzzle: anchor('muzzle', muz, P.bore), eject: anchor('eject', (P.ep0 + P.ep1) / 2, P.sv1 - 0.004, P.sw / 2 + 0.002),
    leftHand: anchor('leftHand', -0.01, -0.03), mag: M.group, bolt: B.group, hold: 'pistol', gripAngle: ang,
    gripBox: { c: gripPt(ang, (P.gripBot + P.gripTop) / 2 - 0.004, -(P.gripBack ?? 0.008)), half: [P.gw / 2, (P.gripTop - P.gripBot) / 2 + 0.004, P.gd / 2], r: Math.min(P.gw, P.gd) * 0.4 },
    boltAxis: new THREE.Vector3(0, 0, 1), boltTravel: P.travel ?? 0.042, charge: 'slide', chargePt: new THREE.Vector3(0, P.sv1, -(P.su0 + 0.016)),
    magAxis: new THREE.Vector3(0, -Math.cos(ang), Math.sin(ang)), shellType: 'pistol', sightHeight: P.sv1 + 0.006,
    parts: {},
  };
  const hm = C.root.getObjectByName('hammer'); if (hm) ud.parts.hammer = hm;
  return finish(C, Object.assign(ud, P.ud || {}));
}
const PISTOLS = {
  glock: { ang: 21, su0: -0.050, su1: 0.130, sv0: 0.038, sv1: 0.067, sw: 0.0254, bore: 0.054, br: 0.0060, ep0: 0.040, ep1: 0.075, chamfer: 0.0035, slideBevel: 0.002,
    fu0: -0.046, fu1: 0.118, fv: 0.039, fw: 0.0285, guard: { gu0: 0.004, gu1: 0.074, gv: -0.004 }, squareGuard: true, rail: 3, trigU: 0.030,
    gripBot: -0.072, gripTop: 0.026, gw: 0.0295, gd: 0.047, grooves: 3, gripTopV: 0.018, magLen: 0.092, frameMat: 'poly', gripMat: 'polyStip', dots: 'white', mark: 'G-18  AUSTRIA-ST  9x19', travel: 0.040, tang: 0.010 },
  usp_s: { ang: 18, su0: -0.058, su1: 0.122, sv0: 0.041, sv1: 0.071, sw: 0.0295, bore: 0.056, br: 0.0062, bu: 0.130, ep0: 0.035, ep1: 0.072, chamfer: 0.007, slideBevel: 0.0042,
    fu0: -0.052, fu1: 0.115, fv: 0.041, fw: 0.031, guard: { gu0: 0.004, gu1: 0.074, gv: -0.006 }, rail: 3, trigU: 0.028, hammer: true,
    gripBot: -0.074, gripTop: 0.024, gw: 0.031, gd: 0.048, gripTopV: 0.018, frameMat: 'poly', gripMat: 'polyStip', dots: 'tritium', can: [0.165, 0.0172], mark: 'USP  .45 / 9mm  SER 26C-1153', travel: 0.042 },
  p2000: { ang: 18, su0: -0.054, su1: 0.120, sv0: 0.040, sv1: 0.069, sw: 0.029, bore: 0.055, br: 0.006, ep0: 0.035, ep1: 0.072, chamfer: 0.006, slideBevel: 0.0035,
    fu0: -0.048, fu1: 0.110, fv: 0.040, fw: 0.030, guard: { gu0: 0.004, gu1: 0.072, gv: -0.005 }, rail: 2, trigU: 0.028, hammer: true,
    gripBot: -0.070, gripTop: 0.024, gw: 0.030, gd: 0.046, gripTopV: 0.017, frameMat: 'poly', gripMat: 'polyStip', dots: 'white', mark: 'P2000  9mm x 19', travel: 0.040, backSwell: 0.004 },
  p250: { ang: 19, su0: -0.054, su1: 0.124, sv0: 0.040, sv1: 0.069, sw: 0.0275, bore: 0.055, br: 0.006, ep0: 0.036, ep1: 0.074, chamfer: 0.003, slideBevel: 0.0015,
    fu0: -0.048, fu1: 0.112, fv: 0.040, fw: 0.029, guard: { gu0: 0.004, gu1: 0.074, gv: -0.004 }, rail: 3, trigU: 0.028, hammer: true, frontSerr: true,
    gripBot: -0.070, gripTop: 0.024, gw: 0.030, gd: 0.047, gripTopV: 0.018, frameMat: 'poly', gripMat: 'polyStip', dots: 'tritium', mark: 'P250  CAL .357', travel: 0.040 },
  fiveseven: { ang: 17, su0: -0.060, su1: 0.140, sv0: 0.042, sv1: 0.069, sw: 0.0255, bore: 0.056, br: 0.0055, ep0: 0.040, ep1: 0.074, chamfer: 0.010, slideBevel: 0.0022,
    fu0: -0.055, fu1: 0.132, fv: 0.042, fw: 0.029, guard: { gu0: 0.004, gu1: 0.080, gv: -0.004 }, squareGuard: true, rail: 3, trigU: 0.030,
    gripBot: -0.082, gripTop: 0.026, gw: 0.030, gd: 0.050, gripTopV: 0.020, frameMat: 'poly', gripMat: 'polyStip', slideMat: 'parkDark', dots: 'white', mark: 'FN  5.7x28  ---', travel: 0.040, magLen: 0.100 },
  cz75a: { ang: 20, su0: -0.056, su1: 0.120, sv0: 0.047, sv1: 0.070, sw: 0.024, bore: 0.057, br: 0.006, ep0: 0.036, ep1: 0.070, chamfer: 0.004, slideBevel: 0.002,
    fu0: -0.050, fu1: 0.116, fv: 0.047, dustV: 0.029, fw: 0.027, guard: { gu0: 0.004, gu1: 0.072, gv: -0.005 }, trigU: 0.028, hammer: true,
    gripBot: -0.070, gripTop: 0.028, gw: 0.030, gd: 0.046, gripTopV: 0.024, frameMat: 'blued', slideMat: 'blued', gripMat: 'polyStip', panels: 'rubber', dots: 'white', mark: 'CZ 75 AUTO  9mm', travel: 0.036,
    extra: (C, P) => { // spare magazine used as a foregrip
      const g = rbox(0.022, 0.085, 0.030, 0.003, { q: C.q }); C.P.add(g, 'park', 0.5, { p: [0, 0.029 - 0.044, -0.098], r: [8, 0, 0] });
      C.box(0.026, 0.007, 0.034, 0.0025, 'poly', 0.8, { p: [0, -0.018 - 0.002 - 0.012, -0.093], r: [8, 0, 0] });
      C.box(0.025, 0.010, 0.040, 0.002, 'blued', 0.5, { p: [0, 0.030, -0.098] });
    }, ud: { flashScale: 0.9 } },
  elite: { ang: 18, su0: -0.060, su1: 0.140, sv0: 0.042, sv1: 0.070, sw: 0.028, bore: 0.058, br: 0.0065, ep0: 0.05, ep1: 0.09, chamfer: 0.003, slideBevel: 0.0022, openTop: true,
    fu0: -0.054, fu1: 0.120, fv: 0.042, fw: 0.029, guard: { gu0: 0.004, gu1: 0.080, gv: -0.006 }, trigU: 0.028, hammer: true,
    gripBot: -0.072, gripTop: 0.024, gw: 0.032, gd: 0.048, gripTopV: 0.018, frameMat: 'alu', slideMat: 'park', gripMat: 'poly', panels: 'woodDark', dots: 'white', mark: 'MOD. 92 FS  CAL 9 PARA', travel: 0.040 },
};
// --- dual berettas: right pistol at origin, second (left) pistol exposed as userData.second
function buildElite(lod, id) {
  const a = buildPistol(lod, 'elite');
  const b = buildPistol(lod, 'elite');
  const g = new THREE.Group(); g.name = 'weapon_elite';
  g.add(a);
  b.position.set(-0.20, 0, 0.02); b.name = 'second'; g.add(b);
  g.userData = Object.assign({}, a.userData, { id: 'elite', second: b, secondData: b.userData, dual: true, tris: a.userData.tris * 2 });
  return g;
}
// --- Desert Eagle
function buildDeagle(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi;
  const ang = 17 * D2R, BV = 0.064;
  // slide (rear upper part, moves)
  const B = C.sub('bolt', [0, 0.06, 0.05]);
  B.side([[-0.078, 0.048, 0.002], [0.088, 0.048, 0.002], [0.088, 0.083, 0.004], [-0.070, 0.083, 0.006], [-0.078, 0.074, 0.004]], 0.033, 'steelSS', 0.35, { bevel: 0.004, bseg: hi ? 3 : 1 });
  if (hi) {
    for (let i = 0; i < 9; i++) for (const sx of [1, -1]) B.box(0.0008, 0.020, 0.0016, 0.0004, 'dark', 0, { p: [sx * 0.0165, 0.066, -(-0.070 + i * 0.0034)] });
    B.side([[0.020, 0.068, 0.001], [0.068, 0.068, 0.001], [0.068, 0.0835, 0], [0.020, 0.0835, 0]], 0.012, 'dark', 0, { x: 0.011 });
    B.side([[-0.074, 0.0825, 0.0006], [-0.062, 0.0825, 0.0006], [-0.062, 0.0865, 0.001], [-0.074, 0.0865, 0.001]], 0.020, 'park', 0.5, { bevel: 0.0008 });
    for (const sx of [1, -1]) B.side([[-0.074, 0.086, 0.0004], [-0.0625, 0.086, 0.0004], [-0.0635, 0.0915, 0.0007], [-0.074, 0.0915, 0.0007]], 0.0065, 'park', 0.5, { x: sx * 0.0068, bevel: 0.0006 });
    for (const sx of [1, -1]) B.sph(0.0011, 'white', 0, { p: [sx * 0.0058, 0.0885, 0.069] });
    // safety levers both sides
    for (const sx of [1, -1]) B.side([[-0.068, 0.062, 0.002], [-0.050, 0.062, 0.002], [-0.050, 0.070, 0.003], [-0.068, 0.070, 0.003]], 0.003, 'park', 0.7, { x: sx * 0.018, bevel: 0.001 });
  }
  B.flush();
  // fixed triangular barrel with top rib
  const bar = [[0.075, 0.046, 0.002], [0.190, 0.046, 0.002], [0.190, 0.078, 0.003], [0.178, 0.084, 0.002], [0.075, 0.084, 0.002]];
  C.side(bar, 0.030, 'steelSS', 0.35, { bevel: 0.006, bseg: hi ? 3 : 1, wfn: (u, v) => 1 - clamp((v - 0.05) / 0.035, 0, 1) * 0.42 });
  if (hi) {
    // barrel side flutes and the separation groove between barrel and frame
    for (const sx of [1, -1]) {
      C.box(0.0012, 0.0016, 0.10, 0.0004, 'dark', 0, { p: [sx * 0.0150, 0.0478, -0.137] });
      C.box(0.0008, 0.0035, 0.085, 0.0004, 'dark', 0, { p: [sx * 0.0147, 0.066, -0.134] });
      C.side([[0.098, 0.0565, 0.002], [0.172, 0.0565, 0.002], [0.172, 0.0605, 0.002], [0.098, 0.0605, 0.002]], 0.0012, 'steelSS', 0.6, { x: sx * 0.0148, bevel: 0.0004 });
    }
    rail(C, 0.09, 0.185, 0.0845, 0.0, 0, 'park', 0.014);
    C.cyl(0.0075, 0.185, 0.1905, 'dark', 0, { tf: { p: [0, BV, 0] }, seg: 16 });
    C.side([[0.176, 0.083, 0.0006], [0.186, 0.083, 0.0006], [0.184, 0.092, 0.001], [0.179, 0.092, 0.001]], 0.004, 'park', 0.5, { bevel: 0.0008 });
    C.sph(0.0011, 'white', 0, { p: [0, 0.0895, -0.181] });
    addMarking(C.root, ['.50 AE   MAGNUM PATTERN'], 0.135, 0.071, 0.0154, 1, 0.050, 0.0055, { opacity: 0.5, rot: 0 });
  }
  // frame
  const fr = [[-0.070, 0.048, 0.002], [0.182, 0.048, 0.003], [0.182, 0.028, 0.004], [0.088, 0.026, 0.004], [0.082, 0.004, 0.012], [0.068, -0.012, 0.008], [0.010, -0.012, 0.006], [0.004, 0.004, 0.006], [0.003, 0.022, 0.004], [-0.052, 0.022, 0.006], [-0.072, 0.040, 0.004]];
  C.side(fr, 0.032, 'steelSS', 0.3, { bevel: 0.0022, holes: [[[0.010, 0.022, 0.002], [0.076, 0.022, 0.002], [0.076, 0.004, 0.009], [0.065, -0.006, 0.006], [0.016, -0.006, 0.005], [0.010, 0.006, 0.004]]] });
  C.side([[0.032, 0.026, 0], [0.038, 0.026, 0], [0.036, 0.016, -1], [0.033, 0.009, 0.0012], [0.028, 0.007, 0.0012], [0.029, 0.012, -1], [0.031, 0.019, -1]], 0.006, 'steel', 0.6, { bevel: 0.0009 });
  // hammer
  const H = C.sub('hammer', [0, 0.06, 0.07]);
  H.side([[-0.072, 0.050, 0.001], [-0.076, 0.050, 0.001], [-0.090, 0.068, 0.003], [-0.084, 0.072, 0.003], [-0.074, 0.060, 0.001]], 0.009, 'park', 0.7, { bevel: 0.001 });
  H.flush();
  // rubber wrap-around grip
  gripLoft(C, 'rubber', ang, -0.075, 0.020, 0.0345, 0.054, { swell: 0.04, grooves: hi ? 0 : 0 });
  if (hi) for (let i = 0; i < 10; i++) { const p = gripPt(ang, -0.065 + i * 0.008, 0.0); const g = rbox(0.0355, 0.0018, 0.046, 0.0008, { q }); g.rotateX(-ang); C.P.add(g, 'rubber', 0.6, { p }); }
  const M = pistolMag(C, ang, -0.077, 0.095, 0.022, 0.034, 'steelSS', 'steelSS', { fwd: 0.003 });
  M.flush();
  return finish(C, {
    muzzle: anchor('muzzle', 0.19, BV), eject: anchor('eject', 0.044, 0.078, 0.02), leftHand: anchor('leftHand', -0.01, -0.03),
    mag: M.group, bolt: B.group, hold: 'pistol', gripAngle: ang, parts: { hammer: H.group },
    gripBox: { c: gripPt(ang, -0.03), half: [0.0172, 0.05, 0.027], r: 0.013 },
    boltAxis: new THREE.Vector3(0, 0, 1), boltTravel: 0.045, charge: 'slide', chargePt: new THREE.Vector3(0, 0.083, 0.06),
    magAxis: new THREE.Vector3(0, -Math.cos(ang), Math.sin(ang)), shellType: 'pistol', flashScale: 1.4, sightHeight: 0.091,
  });
}
// --- R8 revolver
function buildRevolver(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi;
  const ang = 22 * D2R, BV = 0.062;
  // frame
  const fr = [[-0.048, 0.030, 0.004], [-0.030, 0.082, 0.006], [0.060, 0.082, 0.004], [0.066, 0.078, 0.002], [0.066, 0.040, 0.002], [0.060, 0.024, 0.004], [0.050, 0.020, 0.004], [0.046, 0.002, 0.010], [0.036, -0.010, 0.006], [0.004, -0.010, 0.006], [0.000, 0.012, 0.004], [-0.030, 0.014, 0.006]];
  C.side(fr, 0.030, 'blued', 0.35, { bevel: 0.0025, holes: [[[0.006, 0.020, 0.002], [0.042, 0.020, 0.002], [0.042, 0.004, 0.008], [0.033, -0.004, 0.005], [0.010, -0.004, 0.004], [0.006, 0.006, 0.003]], [[-0.010, 0.040, 0.004], [0.062, 0.040, 0.004], [0.062, 0.075, 0.004], [-0.010, 0.075, 0.004]]] });
  // cylinder (part)
  const CY = C.sub('cylinder', [0, BV - 0.004, -0.026]);
  CY.lathe([[0.004, -0.008, 0], [0.0175, -0.008, 0.002], [0.0185, -0.002, 0.002], [0.0185, 0.058, 0.002], [0.0175, 0.062, 0.001], [0.004, 0.062, 0]], 'blued', 0.4, { tf: { p: [0, BV - 0.004, 0] }, segMul: 1 });
  if (hi) for (let i = 0; i < 8; i++) { const a = i / 8 * 360; const g = rbox(0.003, 0.004, 0.036, 0.0012, { q }); xf(g, { p: [0, 0.0182, -0.028] }); CY.P.add(g, 'dark', 0, { p: [0, BV - 0.004, 0], r: [0, 0, a] }); }
  CY.flush();
  // barrel with full-length rail shroud
  C.lathe([[0.006, 0.060, 0], [0.0105, 0.060, 0.001], [0.0105, 0.200, 0.001], [0.0055, 0.200, 0.0005], [0.005, 0.196, 0]], 'blued', 0.35, { tf: { p: [0, BV, 0] } });
  C.side([[0.060, BV + 0.006, 0.002], [0.200, BV + 0.006, 0.002], [0.200, BV + 0.016, 0.002], [0.060, BV + 0.020, 0.002]], 0.016, 'blued', 0.35, { bevel: 0.002 });
  C.side([[0.060, BV - 0.022, 0.003], [0.170, BV - 0.014, 0.003], [0.170, BV - 0.006, 0.002], [0.060, BV - 0.006, 0.002]], 0.020, 'blued', 0.4, { bevel: 0.0025 });
  if (hi) { rail(C, 0.07, 0.19, BV + 0.012, 0.0, 0, 'park', 0.014); C.side([[0.190, BV + 0.019, 0.0006], [0.198, BV + 0.019, 0.0006], [0.196, BV + 0.027, 0.001], [0.192, BV + 0.027, 0.001]], 0.004, 'park', 0.5, { bevel: 0.0007 }); }
  // trigger + hammer
  C.side([[0.018, 0.016, 0], [0.024, 0.016, 0], [0.022, 0.006, -1], [0.019, -0.001, 0.0012], [0.014, -0.002, 0.0012], [0.015, 0.003, -1], [0.017, 0.010, -1]], 0.006, 'steel', 0.6, { bevel: 0.0009 });
  const H = C.sub('hammer', [0, 0.07, 0.04]);
  H.side([[-0.036, 0.070, 0.001], [-0.042, 0.068, 0.001], [-0.056, 0.086, 0.003], [-0.049, 0.090, 0.003], [-0.036, 0.080, 0.001]], 0.008, 'park', 0.7, { bevel: 0.001 });
  H.flush();
  gripLoft(C, 'rubber', ang, -0.072, 0.012, 0.031, 0.046, { swell: 0.07, grooves: 3 });
  return finish(C, {
    muzzle: anchor('muzzle', 0.20, BV), eject: anchor('eject', 0.0, BV, 0.02), leftHand: anchor('leftHand', -0.01, -0.03),
    mag: null, bolt: null, hold: 'pistol', gripAngle: ang, parts: { hammer: H.group, cylinder: CY.group }, revolver: true, noShell: true,
    gripBox: { c: gripPt(ang, -0.03), half: [0.0155, 0.045, 0.023], r: 0.011 }, charge: 'none', sightHeight: BV + 0.027,
  });
}
// --- Tec-9
function buildTec9(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi;
  const ang = 14 * D2R, BV = 0.050;
  // upper receiver (stamped/ polymer) box
  C.side([[-0.075, 0.036, 0.003], [0.080, 0.036, 0.003], [0.080, 0.068, 0.004], [-0.070, 0.068, 0.006], [-0.078, 0.058, 0.004]], 0.030, 'poly', 0.35, { bevel: 0.003, bseg: hi ? 2 : 1 });
  // lower polymer with guard and mag well forward of trigger
  C.side([[-0.060, 0.036, 0.004], [0.090, 0.036, 0.004], [0.090, 0.022, 0.004], [0.084, 0.018, 0.002], [0.084, -0.008, 0.004], [0.045, -0.008, 0.004], [0.040, 0.004, 0.003], [0.030, -0.006, 0.008], [0.000, -0.006, 0.006], [-0.006, 0.010, 0.004], [-0.020, 0.020, 0.004], [-0.060, 0.022, 0.006]],
    0.028, 'polyStip', 0.4, { bevel: 0.002, holes: [[[0.004, 0.018, 0.002], [0.036, 0.018, 0.002], [0.036, 0.004, 0.004], [0.028, 0.000, 0.004], [0.006, 0.000, 0.003]]] });
  // barrel shroud with holes
  C.cyl(0.0125, 0.075, 0.150, 'park', 0.35, { tf: { p: [0, BV, 0] }, segMul: 0.9 });
  if (hi) for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) { const a = j * 90 + 45; const g = cyl(0.0032, 0, 0.0008, { q, seg: 10 }); g.rotateX(Math.PI / 2); g.translate(0, 0.0125, -(0.085 + i * 0.011)); C.P.add(g, 'dark', 0, { p: [0, BV, 0], r: [0, 0, a] }); }
  C.lathe([[0.004, 0.150, 0], [0.0065, 0.150, 0.0005], [0.0065, 0.172, 0.0005], [0.004, 0.172, 0]], 'steel', 0.5, { tf: { p: [0, BV, 0] }, seg: 16 });
  C.side([[0.140, 0.062, 0.0006], [0.148, 0.062, 0.0006], [0.146, 0.070, 0.001], [0.142, 0.070, 0.001]], 0.004, 'park', 0.5, { bevel: 0.0007 });
  C.side([[-0.068, 0.068, 0.001], [-0.056, 0.068, 0.001], [-0.056, 0.075, 0.001], [-0.068, 0.075, 0.001]], 0.016, 'park', 0.5, { bevel: 0.0008 });
  // bolt / cocking knob on the left
  const B = C.sub('bolt', [0, 0.06, 0]);
  B.cyl(0.004, 0, 0.012, 'steel', 0.7, { tf: { p: [-0.015, 0.060, -0.010], r: [0, 90, 0] }, seg: 12 });
  B.P.add(sphere(0.006, { q, segMul: 0.5 }), 'steel', 0.7, { p: [-0.027, 0.060, -0.010] });
  if (hi) B.side([[-0.040, 0.044, 0.001], [0.020, 0.044, 0.001], [0.020, 0.064, 0.001], [-0.040, 0.064, 0.001]], 0.003, 'steel', 0.5, { x: 0.0145 });
  B.flush();
  C.side([[0.014, 0.018, 0], [0.020, 0.018, 0], [0.018, 0.010, -1], [0.015, 0.003, 0.001], [0.010, 0.002, 0.001], [0.011, 0.006, -1], [0.013, 0.012, -1]], 0.005, 'steel', 0.6, { bevel: 0.0008 });
  gripLoft(C, 'polyStip', ang, -0.075, 0.016, 0.027, 0.040, { swell: 0.05 });
  // magazine forward of the trigger guard
  const M = C.sub('mag', [0, 0.0, -0.066]);
  M.side([[0.048, 0.030, 0.002], [0.082, 0.030, 0.002], [0.086, -0.120, 0.002], [0.052, -0.120, 0.002]], 0.020, 'park', 0.4, { bevel: 0.0012 });
  M.side([[0.050, -0.118, 0.002], [0.088, -0.118, 0.002], [0.088, -0.126, 0.002], [0.050, -0.126, 0.002]], 0.024, 'poly', 0.85, { bevel: 0.0012 });
  M.flush();
  return finish(C, {
    muzzle: anchor('muzzle', 0.172, BV), eject: anchor('eject', 0.02, 0.064, 0.016), leftHand: anchor('leftHand', 0.066, -0.04),
    mag: M.group, bolt: B.group, hold: 'pistol', gripAngle: ang,
    gripBox: { c: gripPt(ang, -0.03), half: [0.0135, 0.048, 0.020], r: 0.01 },
    boltAxis: new THREE.Vector3(0, 0, 1), boltTravel: 0.035, charge: 'side', chargePt: new THREE.Vector3(-0.027, 0.06, -0.01),
    magAxis: new THREE.Vector3(0, -1, 0.02), shellType: 'pistol', sightHeight: 0.075,
  });
}
// --- Zeus x27 taser
function buildTaser(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi;
  const ang = 20 * D2R;
  C.side([[-0.050, 0.030, 0.006], [0.085, 0.030, 0.006], [0.095, 0.040, 0.004], [0.095, 0.070, 0.006], [-0.040, 0.072, 0.010], [-0.055, 0.058, 0.008]], 0.034, 'paintYel', 0.35, { bevel: 0.005, bseg: hi ? 3 : 1 });
  // cartridge (black) at the front
  C.side([[0.060, 0.032, 0.003], [0.112, 0.034, 0.003], [0.112, 0.068, 0.003], [0.060, 0.068, 0.003]], 0.036, 'poly', 0.45, { bevel: 0.003 });
  if (hi) {
    for (const v of [0.042, 0.058]) C.cyl(0.0045, 0.110, 0.1135, 'paintYel', 0.4, { tf: { p: [0, v, 0] }, seg: 14 });
    C.cyl(0.004, 0.111, 0.114, 'steel', 0.5, { tf: { p: [0.010, 0.050, 0] }, seg: 10 });
    C.cyl(0.004, 0.111, 0.114, 'steel', 0.5, { tf: { p: [-0.010, 0.050, 0] }, seg: 10 });
    C.box(0.020, 0.004, 0.012, 0.0012, 'ledRed', 0, { p: [0, 0.073, 0.01] });
    for (const s of [1, -1]) C.side([[-0.03, 0.040, 0.003], [0.05, 0.040, 0.003], [0.05, 0.060, 0.003], [-0.03, 0.060, 0.003]], 0.002, 'poly', 0.4, { x: s * 0.0175, bevel: 0.0008 });
    addMarking(C.root, ['X27  HIGH VOLTAGE'], 0.03, 0.050, 0.0187, 1, 0.050, 0.007, { opacity: 0.7, color: 0x101010, metal: 0, rough: 0.6 });
  }
  // guard
  C.side([[0.002, 0.031, 0], [0.002, 0.010, 0.008], [0.012, 0.000, 0.006], [0.060, 0.000, 0.004], [0.062, 0.031, 0]], 0.012, 'poly', 0.5, { bevel: 0.0015, holes: [[[0.008, 0.029, 0.002], [0.008, 0.012, 0.006], [0.014, 0.006, 0.004], [0.056, 0.006, 0.002], [0.056, 0.029, 0.002]]] });
  C.side([[0.026, 0.031, 0], [0.032, 0.031, 0], [0.030, 0.020, -1], [0.027, 0.012, 0.001], [0.022, 0.011, 0.001], [0.023, 0.016, -1], [0.025, 0.024, -1]], 0.006, 'poly', 0.6, { bevel: 0.0009 });
  gripLoft(C, 'polyStip', ang, -0.070, 0.028, 0.031, 0.044, { swell: 0.06 });
  return finish(C, {
    muzzle: anchor('muzzle', 0.114, 0.05), eject: anchor('eject', 0.0, 0.05, 0.02), leftHand: anchor('leftHand', -0.01, -0.03),
    mag: null, bolt: null, hold: 'pistol', gripAngle: ang, gripBox: { c: gripPt(ang, -0.022), half: [0.0155, 0.05, 0.022], r: 0.011 }, charge: 'none', noShell: true, sightHeight: 0.075,
  });
}

// ============================================================================================
// Generic helpers for long guns
// ============================================================================================
function rifleUD(o) {
  return Object.assign({ hold: 'rifle', boltAxis: new THREE.Vector3(0, 0, 1), magDrop: 'straight', scope: false }, o);
}
function trigGroup(C, u0, u1, vTop, vBot, w = 0.009, mat = 'park') {
  C.side([[u0, vTop, 0], [u0, vBot + 0.01, 0.006], [u0 + 0.008, vBot, 0.005], [u1 - 0.004, vBot, 0.003], [u1, vBot + 0.006, 0.002], [u1, vTop, 0]], w, mat, 0.5,
    { bevel: 0.0011, holes: [[[u0 + 0.0055, vTop - 0.0015, 0.002], [u0 + 0.0055, vBot + 0.011, 0.004], [u0 + 0.011, vBot + 0.0055, 0.004], [u1 - 0.0055, vBot + 0.0055, 0.002], [u1 - 0.0055, vTop - 0.0015, 0.002]]] });
  const tu = u0 + (u1 - u0) * 0.45;
  C.side([[tu - 0.002, vTop, 0], [tu + 0.004, vTop, 0], [tu + 0.0025, vTop - 0.010, -1], [tu, vTop - 0.016, 0.0012], [tu - 0.0045, vTop - 0.018, 0.0012], [tu - 0.004, vTop - 0.012, -1], [tu - 0.002, vTop - 0.006, -1]], 0.005, 'steel', 0.6, { bevel: 0.0008 });
}
function sling(C, u, v, x, s) { if (!C.hi) return; C.tor(0.0075, 0.0013, 'steel', 0.5, { p: [x, v - 0.008, -u], r: [0, 90, 0] }); C.box(0.004, 0.008, 0.012, 0.0012, 'park', 0.5, { p: [x, v, -u] }); }
function frontPost(C, u, ay, h = 0.045, mat = 'park') {
  C.side([[u - 0.012, ay, 0.002], [u + 0.012, ay, 0.002], [u + 0.005, ay + h, 0.002], [u - 0.005, ay + h, 0.002]], 0.012, mat, 0.45, { bevel: 0.0012 });
  if (C.hi) { C.cyl(0.0011, 0, 0.012, mat, 0.5, { tf: { p: [0, ay + h - 0.003, -u], r: [-90, 0, 0] }, seg: 8 }); for (const s of [1, -1]) C.box(0.0025, 0.012, 0.008, 0.0008, mat, 0.6, { p: [s * 0.0065, ay + h + 0.002, -u] }); }
}
function verticalGrip(C, u, vTop, len = 0.085, mat = 'polyStip', ang = 0) {
  const g = loft([{ z: -len, w: 0.026, h: 0.026, r: 0.011 }, { z: -len + 0.006, w: 0.030, h: 0.030, r: 0.013 }, { z: -0.01, w: 0.028, h: 0.028, r: 0.012 }, { z: 0, w: 0.030, h: 0.034, r: 0.010 }], { q: C.q, steps: C.hi ? 2 : 1 });
  g.rotateX(-Math.PI / 2); g.rotateX(ang * D2R);
  C.P.add(g, mat, 0.6, { p: [0, vTop, -u] });
}
function boltKnob(B, u, v, x, s = 1, mat = 'steel') {
  B.cyl(0.0032, 0, 0.012, mat, 0.6, { tf: { p: [x, v, -u], r: [0, s > 0 ? -90 : 90, 0] }, seg: 10 });
  B.P.add(sphere(0.0055, { q: B.q, segMul: 0.5 }), mat, 0.7, { p: [x + s * 0.013, v, -u] });
}
function stdMagGrip(C, M, u0, u1, vTop, len, curve, w, mat = 'park', o = {}) {
  boxMag(M, vTop, [u1, vTop], [u1 + curve, vTop - len], [u0, vTop], [u0 + curve * 0.9, vTop - len - 0.003], w, mat, { fc: [u1 + curve * 0.08, vTop - len * 0.5], bc: [u0 + curve * 0.06, vTop - len * 0.5], fp: o.fp ?? 0.006, fpMat: o.fpMat });
}

// ============================================================================================
// SMGs
// ============================================================================================
function buildMAC10(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.066;
  // stamped box receiver
  C.side([[-0.115, 0.030, 0.003], [0.130, 0.030, 0.003], [0.130, 0.090, 0.004], [-0.110, 0.090, 0.006], [-0.118, 0.080, 0.004]], 0.046, 'paintBlk', 0.35, { bevel: 0.0022 });
  if (hi) {
    for (const s of [1, -1]) { for (const [u, v] of [[-0.10, 0.04], [-0.10, 0.08], [0.115, 0.04], [0.115, 0.08], [0.0, 0.085], [0.06, 0.085]]) C.rivet(u, v, s * 0.023, s, 0.002, 'paintBlk'); }
    C.side([[-0.035, 0.084, 0.001], [0.070, 0.084, 0.001], [0.070, 0.088, 0.0], [-0.035, 0.088, 0.0]], 0.006, 'dark', 0, { x: 0.0 }); // top slot
    sling(C, 0.125, 0.034, -0.0235, -1);
    // folded wire stock along the top/sides
    for (const s of [1, -1]) C.cyl(0.003, -0.14, 0.10, 'steel', 0.5, { tf: { p: [s * 0.026, 0.074, 0] }, seg: 8 });
    C.box(0.058, 0.010, 0.010, 0.003, 'steel', 0.6, { p: [0, 0.074, 0.145] });
    C.tor(0.010, 0.003, 'steel', 0.5, { p: [0, 0.074, -0.103], r: [90, 0, 0], s: [2.6, 1, 1] });
    // front hand strap
    C.tube([[-0.022, 0.03, -0.11], [-0.026, 0.008, -0.118], [0.0, -0.002, -0.122], [0.026, 0.008, -0.118], [0.022, 0.03, -0.11]], 0.004, 'fabricT2', 0.6);
  }
  // barrel stub (threaded)
  C.lathe([[0.004, 0.128, 0], [0.0095, 0.128, 0.0005], [0.0095, 0.165, 0.0006], [0.004, 0.165, 0]], 'park', 0.5, { tf: { p: [0, BV, 0] } });
  if (hi) for (let i = 0; i < 6; i++) C.lathe([[0.0095, 0.140 + i * 0.004, 0], [0.0102, 0.141 + i * 0.004, -1], [0.0095, 0.142 + i * 0.004, 0]], 'park', 0.6, { tf: { p: [0, BV, 0] }, seg: 16 });
  // sights
  C.side([[-0.10, 0.089, 0.001], [-0.085, 0.089, 0.001], [-0.085, 0.100, 0.002], [-0.10, 0.100, 0.002]], 0.016, 'paintBlk', 0.6, { bevel: 0.001 });
  C.side([[0.112, 0.089, 0.001], [0.124, 0.089, 0.001], [0.122, 0.099, 0.002], [0.114, 0.099, 0.002]], 0.010, 'paintBlk', 0.6, { bevel: 0.001 });
  // cocking knob on top (bolt)
  const B = C.sub('bolt', [0, 0.09, -0.06]);
  B.cyl(0.0035, 0.0, 0.006, 'steel', 0.6, { tf: { p: [0, 0.090, -0.060], r: [-90, 0, 0] }, seg: 10 });
  B.P.add(sphere(0.0065, { q, segMul: 0.5 }), 'steel', 0.7, { p: [0, 0.101, -0.060], s: [1, 0.8, 1] });
  B.flush();
  trigGroup(C, 0.008, 0.075, 0.031, -0.002, 0.012, 'paintBlk');
  // grip with mag inside (vertical)
  gripLoft(C, 'polyStip', 6 * D2R, -0.075, 0.028, 0.034, 0.042, { swell: 0.04 });
  const M = C.sub('mag', [0, -0.085, 0.006]);
  M.side([[-0.015, -0.080, 0.002], [0.017, -0.080, 0.002], [0.017, -0.090, 0.002], [-0.015, -0.090, 0.002]], 0.036, 'paintBlk', 0.85, { bevel: 0.0012 });
  M.side([[-0.012, -0.080, 0.002], [0.014, -0.080, 0.002], [0.010, 0.028, 0.002], [-0.014, 0.028, 0.002]], 0.022, 'park', 0.5, { bevel: 0.001 });
  M.flush();
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', 0.165, BV), eject: anchor('eject', 0.02, 0.075, 0.024), leftHand: anchor('leftHand', 0.10, 0.05),
    mag: M.group, bolt: B.group, gripAngle: 6 * D2R, handguard: { w: 0.046, h: 0.06, y: 0.055, u: 0.10 }, gripBox: { c: [0, -0.024, -0.002], half: [0.017, 0.052, 0.021], r: 0.011 },
    boltTravel: 0.06, charge: 'top', chargePt: new THREE.Vector3(0, 0.101, -0.06), magAxis: new THREE.Vector3(0, -1, 0.1), magDrop: 'straight', shellType: 'pistol', sightHeight: 0.1,
  }));
}
function buildMP9(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.062;
  C.side([[-0.090, 0.042, 0.004], [0.150, 0.042, 0.004], [0.152, 0.080, 0.006], [-0.085, 0.084, 0.008], [-0.094, 0.068, 0.006]], 0.034, 'poly', 0.35, { bevel: 0.0035, bseg: hi ? 2 : 1 });
  // lower polymer: grip frame + guard
  C.side([[-0.040, 0.044, 0.004], [0.120, 0.044, 0.004], [0.120, 0.030, 0.004], [0.075, 0.028, 0.004], [0.070, -0.004, 0.008], [0.012, -0.004, 0.006], [0.006, 0.010, 0.004], [-0.030, 0.026, 0.008]], 0.030, 'polyStip', 0.4,
    { bevel: 0.002, holes: [[[0.016, 0.026, 0.002], [0.064, 0.026, 0.002], [0.064, 0.003, 0.004], [0.018, 0.003, 0.004]]] });
  rail(C, -0.070, 0.12, BV, 0.022, 0, 'park');
  C.lathe([[0.004, 0.148, 0], [0.0075, 0.148, 0.0005], [0.0075, 0.180, 0.0006], [0.004, 0.180, 0]], 'park', 0.5, { tf: { p: [0, BV, 0] } });
  // folding foregrip under front
  verticalGrip(C, 0.112, 0.030, 0.07, 'polyStip', 0);
  // folded stock along the right side
  if (hi) { C.side([[-0.090, 0.050, 0.004], [0.060, 0.050, 0.004], [0.060, 0.070, 0.004], [-0.090, 0.070, 0.004]], 0.006, 'poly', 0.5, { x: 0.021, bevel: 0.002, holes: [[[-0.075, 0.055, 0.003], [0.045, 0.055, 0.003], [0.045, 0.065, 0.003], [-0.075, 0.065, 0.003]]] }); C.box(0.010, 0.050, 0.012, 0.004, 'rubber', 0.6, { p: [0.021, 0.052, -0.066] }); }
  // charging handle (rear, AR style)
  const B = C.sub('bolt', [0, 0.08, 0.09]);
  B.side([[-0.100, 0.072, 0.002], [-0.088, 0.072, 0.001], [-0.088, 0.080, 0.001], [-0.100, 0.081, 0.002]], 0.030, 'park', 0.7, { bevel: 0.0012 });
  B.flush();
  C.side([[0.036, 0.044, 0], [0.042, 0.044, 0], [0.040, 0.034, -1], [0.037, 0.026, 0.0012], [0.032, 0.025, 0.0012], [0.033, 0.030, -1], [0.035, 0.038, -1]], 0.005, 'steel', 0.6, { bevel: 0.0008 });
  gripLoft(C, 'polyStip', 12 * D2R, -0.070, 0.034, 0.030, 0.040, { swell: 0.05 });
  const M = C.sub('mag', [0, -0.08, 0.01]);
  M.side([[-0.016, -0.080, 0.002], [0.016, -0.080, 0.002], [0.016, -0.090, 0.002], [-0.016, -0.090, 0.002]], 0.032, 'poly', 0.85, { bevel: 0.0012 });
  M.side([[-0.013, -0.080, 0.002], [0.013, -0.080, 0.002], [0.020, 0.030, 0.002], [-0.006, 0.030, 0.002]], 0.020, 'park', 0.5, { bevel: 0.001 });
  M.flush();
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', 0.18, BV), eject: anchor('eject', 0.03, 0.07, 0.018), leftHand: anchor('leftHand', 0.112, 0.0),
    mag: M.group, bolt: B.group, gripAngle: 12 * D2R, handguard: { w: 0.030, h: 0.08, y: -0.01, u: 0.112 }, gripBox: { c: [0, -0.02, 0.004], half: [0.015, 0.052, 0.020], r: 0.01 },
    gripL: { gamma: 75, yaw: 0, contact: [0.012, -0.03, 0.0] }, boltTravel: 0.04, charge: 'ar', chargePt: new THREE.Vector3(0, 0.08, 0.094), magAxis: new THREE.Vector3(0, -1, -0.15), shellType: 'pistol', sightHeight: 0.09,
  }));
}
function buildMP7(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.062;
  C.side([[-0.10, 0.040, 0.004], [0.120, 0.040, 0.004], [0.128, 0.052, 0.004], [0.128, 0.080, 0.004], [-0.098, 0.082, 0.006], [-0.108, 0.064, 0.008]], 0.036, 'poly', 0.35, { bevel: 0.004, bseg: hi ? 2 : 1 });
  C.side([[-0.045, 0.042, 0.004], [0.095, 0.042, 0.004], [0.090, 0.022, 0.004], [0.072, 0.020, 0.004], [0.068, -0.004, 0.008], [0.012, -0.004, 0.006], [0.006, 0.010, 0.004], [-0.034, 0.024, 0.008]], 0.032, 'polyStip', 0.4,
    { bevel: 0.002, holes: [[[0.016, 0.024, 0.002], [0.062, 0.024, 0.002], [0.062, 0.003, 0.004], [0.018, 0.003, 0.004]]] });
  rail(C, -0.090, 0.110, BV, 0.0205, 0, 'park'); rail(C, 0.080, 0.122, BV, 0.0195, 90, 'park'); rail(C, 0.080, 0.122, BV, 0.0195, -90, 'park');
  C.lathe([[0.004, 0.126, 0], [0.008, 0.126, 0.0005], [0.008, 0.175, 0.0006], [0.004, 0.175, 0]], 'park', 0.5, { tf: { p: [0, BV, 0] } });
  if (hi) { // flip sights
    C.side([[-0.075, 0.084, 0.001], [-0.060, 0.084, 0.001], [-0.064, 0.098, 0.002], [-0.072, 0.098, 0.002]], 0.016, 'park', 0.6, { bevel: 0.001 });
    C.side([[0.090, 0.084, 0.001], [0.104, 0.084, 0.001], [0.100, 0.097, 0.002], [0.094, 0.097, 0.002]], 0.012, 'park', 0.6, { bevel: 0.001 });
    // retracted stock: two rods + butt plate
    for (const s of [1, -1]) C.cyl(0.0035, -0.15, -0.08, 'park', 0.5, { tf: { p: [s * 0.014, 0.056, 0] }, seg: 8 });
    C.box(0.040, 0.050, 0.010, 0.004, 'rubber', 0.6, { p: [0, 0.055, 0.155] });
  }
  verticalGrip(C, 0.100, 0.040, 0.075, 'polyStip', 0);
  const B = C.sub('bolt', [0, 0.08, 0.09]);
  B.side([[-0.112, 0.068, 0.002], [-0.098, 0.068, 0.001], [-0.098, 0.078, 0.001], [-0.112, 0.079, 0.002]], 0.040, 'park', 0.7, { bevel: 0.0012 });
  B.flush();
  C.side([[0.036, 0.042, 0], [0.042, 0.042, 0], [0.040, 0.032, -1], [0.037, 0.024, 0.0012], [0.032, 0.023, 0.0012], [0.033, 0.028, -1], [0.035, 0.036, -1]], 0.005, 'steel', 0.6, { bevel: 0.0008 });
  gripLoft(C, 'polyStip', 10 * D2R, -0.075, 0.032, 0.031, 0.042, { swell: 0.05 });
  const M = C.sub('mag', [0, -0.085, 0.01]);
  M.side([[-0.016, -0.085, 0.002], [0.016, -0.085, 0.002], [0.016, -0.095, 0.002], [-0.016, -0.095, 0.002]], 0.034, 'poly', 0.85, { bevel: 0.0012 });
  M.side([[-0.013, -0.085, 0.002], [0.013, -0.085, 0.002], [0.020, 0.030, 0.002], [-0.006, 0.030, 0.002]], 0.020, 'park', 0.5, { bevel: 0.001 });
  M.flush();
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', 0.175, BV), eject: anchor('eject', 0.02, 0.07, 0.019), leftHand: anchor('leftHand', 0.1, 0.0),
    mag: M.group, bolt: B.group, gripAngle: 10 * D2R, handguard: { w: 0.030, h: 0.08, y: 0.0, u: 0.100 }, gripBox: { c: [0, -0.022, 0.003], half: [0.0155, 0.054, 0.021], r: 0.01 },
    gripL: { gamma: 75, yaw: 0, contact: [0.012, -0.03, 0.0] }, boltTravel: 0.04, charge: 'ar', chargePt: new THREE.Vector3(0, 0.078, 0.105), magAxis: new THREE.Vector3(0, -1, -0.15), shellType: 'pistol', sightHeight: 0.098,
  }));
}
function buildMP5(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.070;
  // receiver tube with stamped sides
  C.side([[-0.120, 0.050, 0.004], [0.165, 0.050, 0.003], [0.165, 0.090, 0.006], [-0.115, 0.090, 0.008], [-0.124, 0.076, 0.006]], 0.034, 'blued', 0.35, { bevel: 0.006, bseg: hi ? 3 : 1 });
  if (hi) for (const s of [1, -1]) C.side([[-0.10, 0.072, 0.002], [0.13, 0.072, 0.002], [0.13, 0.076, 0.002], [-0.10, 0.076, 0.002]], 0.0016, 'blued', 0.4, { x: s * 0.0172, bevel: 0.0006 });
  // magwell + curved mag
  C.side([[0.060, 0.052, 0.002], [0.112, 0.052, 0.002], [0.112, 0.020, 0.003], [0.060, 0.020, 0.003]], 0.030, 'blued', 0.45, { bevel: 0.0015 });
  // trigger housing (polymer)
  C.side([[-0.045, 0.050, 0.004], [0.050, 0.050, 0.004], [0.050, 0.032, 0.004], [0.044, 0.004, 0.008], [0.000, 0.004, 0.006], [-0.008, 0.020, 0.006], [-0.045, 0.032, 0.008]], 0.030, 'poly', 0.4,
    { bevel: 0.002, holes: [[[0.004, 0.032, 0.002], [0.040, 0.032, 0.002], [0.038, 0.010, 0.004], [0.006, 0.010, 0.004]]] });
  C.side([[0.018, 0.048, 0], [0.024, 0.048, 0], [0.022, 0.038, -1], [0.019, 0.030, 0.0012], [0.014, 0.029, 0.0012], [0.015, 0.034, -1], [0.017, 0.042, -1]], 0.005, 'steel', 0.6, { bevel: 0.0008 });
  gripLoft(C, 'polyStip', 14 * D2R, -0.070, 0.030, 0.030, 0.042, { swell: 0.05, grooves: 3 });
  // cocking tube on top-left, handguard, integral suppressor
  C.cyl(0.0085, 0.10, 0.22, 'blued', 0.4, { tf: { p: [0, 0.096, 0] }, segMul: 0.7 });
  const k = (u, w, h) => ({ z: -u, w, h, y: BV - 0.004, r: 0.014 });
  C.loft([k(0.166, 0.040, 0.044), k(0.172, 0.046, 0.050), k(0.290, 0.046, 0.050), k(0.296, 0.040, 0.044)], 'polyStip', 0.6, { smooth: false });
  can(C, 0.296, 0.170, 0.0235, BV, 'park', { bands: false });
  C.cyl(0.024, 0.165, 0.30, 'park', 0.35, { tf: { p: [0, BV, 0] }, segMul: 1.0 });
  if (hi) for (let i = 0; i < 9; i++) for (const s of [1, -1]) C.box(0.003, 0.010, 0.006, 0.0025, 'dark', 0, { p: [s * 0.023, BV - 0.004, -(0.180 + i * 0.012)] });
  // drum rear sight, front hooded sight
  if (hi) {
    C.cyl(0.010, 0, 0.012, 'blued', 0.6, { tf: { p: [0.006, 0.098, 0.085], r: [0, -90, 0] }, seg: 18 });
    C.side([[-0.090, 0.089, 0.002], [-0.075, 0.089, 0.002], [-0.075, 0.101, 0.002], [-0.090, 0.101, 0.002]], 0.020, 'blued', 0.6, { bevel: 0.001 });
    C.tor(0.010, 0.002, 'blued', 0.6, { p: [0, 0.112, -0.155], r: [0, 0, 0] });
    C.side([[0.150, 0.088, 0.002], [0.160, 0.088, 0.002], [0.158, 0.106, 0.002], [0.152, 0.106, 0.002]], 0.010, 'blued', 0.6, { bevel: 0.001 });
  }
  // retractable stock (collapsed): two rails + butt
  for (const s of [1, -1]) C.cyl(0.0045, -0.20, -0.11, 'blued', 0.5, { tf: { p: [s * 0.017, 0.072, 0] }, seg: 10 });
  C.side([[-0.212, 0.095, 0.006], [-0.200, 0.095, 0.004], [-0.200, 0.030, 0.006], [-0.212, 0.030, 0.006]], 0.044, 'rubber', 0.5, { bevel: 0.004 });
  // cocking handle (left, forward)
  const B = C.sub('bolt', [-0.012, 0.096, -0.21]);
  B.cyl(0.0035, 0, 0.012, 'poly', 0.6, { tf: { p: [-0.008, 0.096, -0.212], r: [0, 90, 0] }, seg: 10 });
  B.P.add(sphere(0.006, { q, segMul: 0.5 }), 'poly', 0.7, { p: [-0.021, 0.096, -0.212], s: [1, 1, 1.4] });
  B.flush();
  const M = C.sub('mag', [0, 0.04, -0.11]);
  stdMagGrip(C, M, 0.063, 0.109, 0.050, 0.17, 0.05, 0.024, 'park');
  M.flush();
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', 0.466, BV), eject: anchor('eject', 0.03, 0.08, 0.018), leftHand: anchor('leftHand', 0.235, BV),
    mag: M.group, bolt: B.group, gripAngle: 14 * D2R, handguard: { w: 0.046, h: 0.05, y: BV - 0.004, u: 0.235 }, gripBox: { c: [0, -0.02, 0.005], half: [0.015, 0.05, 0.021], r: 0.01 },
    boltTravel: -0.06, charge: 'side', chargePt: new THREE.Vector3(-0.021, 0.096, -0.212), magDrop: 'rock', shellType: 'pistol', sightHeight: 0.11, flashScale: 0.6,
  }));
}
function buildUMP(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.066;
  C.side([[-0.130, 0.036, 0.006], [0.200, 0.036, 0.006], [0.205, 0.050, 0.004], [0.205, 0.088, 0.006], [-0.125, 0.090, 0.008], [-0.135, 0.070, 0.008]], 0.042, 'poly', 0.35, { bevel: 0.005, bseg: hi ? 2 : 1 });
  if (hi) {
    for (let i = 0; i < 5; i++) for (const s of [1, -1]) C.box(0.003, 0.012, 0.024, 0.004, 'dark', 0, { p: [s * 0.0206, 0.060, -(0.110 + i * 0.019)] });
    rail(C, -0.10, 0.19, BV, 0.0245, 0, 'park'); rail(C, 0.14, 0.195, BV, 0.0215, 90, 'park'); rail(C, 0.14, 0.195, BV, 0.0215, -90, 'park');
    // folded stock on the right side
    C.side([[-0.130, 0.040, 0.008], [0.070, 0.040, 0.008], [0.070, 0.082, 0.008], [-0.130, 0.082, 0.008]], 0.012, 'poly', 0.5, { x: 0.027, bevel: 0.004, holes: [[[-0.110, 0.052, 0.006], [0.050, 0.052, 0.006], [0.050, 0.070, 0.006], [-0.110, 0.070, 0.006]]] });
  }
  // lower with guard & grip (integral)
  C.side([[-0.050, 0.038, 0.004], [0.115, 0.038, 0.004], [0.115, 0.010, 0.004], [0.065, 0.010, 0.004], [0.062, -0.006, 0.008], [0.010, -0.006, 0.006], [0.004, 0.010, 0.004], [-0.040, 0.020, 0.008]], 0.034, 'poly', 0.4,
    { bevel: 0.002, holes: [[[0.014, 0.020, 0.002], [0.058, 0.020, 0.002], [0.056, 0.002, 0.004], [0.016, 0.002, 0.004]]] });
  C.side([[0.030, 0.037, 0], [0.036, 0.037, 0], [0.034, 0.027, -1], [0.031, 0.019, 0.0012], [0.026, 0.018, 0.0012], [0.027, 0.023, -1], [0.029, 0.031, -1]], 0.005, 'steel', 0.6, { bevel: 0.0008 });
  gripLoft(C, 'polyStip', 15 * D2R, -0.075, 0.025, 0.031, 0.044, { swell: 0.06, grooves: 3 });
  C.lathe([[0.004, 0.200, 0], [0.0085, 0.200, 0.0005], [0.0085, 0.255, 0.0006], [0.004, 0.255, 0]], 'park', 0.5, { tf: { p: [0, BV, 0] } });
  if (hi) { C.side([[-0.10, 0.090, 0.001], [-0.085, 0.090, 0.001], [-0.087, 0.104, 0.002], [-0.098, 0.104, 0.002]], 0.020, 'park', 0.6, { bevel: 0.001 }); frontPost(C, 0.185, 0.088, 0.016, 'poly'); }
  const B = C.sub('bolt', [-0.022, 0.078, -0.17]);
  boltKnob(B, 0.170, 0.078, -0.021, -1, 'poly');
  B.flush();
  const M = C.sub('mag', [0, 0.04, -0.12]);
  stdMagGrip(C, M, 0.072, 0.122, 0.040, 0.165, 0.004, 0.026, 'poly', { fp: 0.008 });
  M.flush();
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', 0.255, BV), eject: anchor('eject', 0.04, 0.075, 0.022), leftHand: anchor('leftHand', 0.165, 0.062),
    mag: M.group, bolt: B.group, gripAngle: 15 * D2R, handguard: { w: 0.042, h: 0.054, y: 0.062, u: 0.165 }, gripBox: { c: [0, -0.024, 0.005], half: [0.0155, 0.052, 0.022], r: 0.011 },
    boltTravel: -0.06, charge: 'side', chargePt: new THREE.Vector3(-0.034, 0.078, -0.17), shellType: 'pistol', sightHeight: 0.104,
  }));
}
function buildP90(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.060;
  // monolithic bullpup body with thumbhole grip and front trigger-guard loop
  const body = [[-0.255, 0.060, 0.012], [-0.250, -0.010, 0.02], [-0.215, -0.055, 0.015], [-0.150, -0.066, 0.012], [0.095, -0.066, 0.01], [0.125, -0.030, 0.012], [0.150, 0.025, 0.012], [0.185, 0.040, 0.008], [0.205, 0.060, 0.008], [0.185, 0.078, 0.008], [-0.200, 0.078, 0.010]];
  const h1 = [[-0.060, 0.015, 0.008], [-0.022, 0.015, 0.006], [-0.020, -0.050, 0.006], [-0.070, -0.050, 0.010], [-0.080, -0.020, 0.010]];
  const h2 = [[0.012, 0.015, 0.006], [0.058, 0.015, 0.010], [0.078, -0.010, 0.010], [0.076, -0.050, 0.008], [0.014, -0.050, 0.006]];
  C.side(body, 0.050, 'polyGry', (x, y, z) => 0.3 + (y < 0.0 ? 0.4 : 0), { bevel: 0.0045, bseg: hi ? 3 : 1, holes: [h1, h2], hr: 0.006, r: 0.004 });
  // top: mag channel rails + ring sight
  C.side([[-0.200, 0.076, 0.004], [0.150, 0.076, 0.004], [0.150, 0.082, 0.002], [-0.200, 0.082, 0.002]], 0.052, 'polyGry', 0.4, { bevel: 0.002 });
  if (hi) {
    C.side([[0.065, 0.104, 0.004], [0.120, 0.104, 0.004], [0.120, 0.126, 0.004], [0.075, 0.126, 0.006]], 0.028, 'poly', 0.5, { bevel: 0.003 });
    C.lathe([[0.012, 0.064, 0], [0.014, 0.064, 0.001], [0.014, 0.125, 0.001], [0.012, 0.125, 0]], 'poly', 0.5, { tf: { p: [0, 0.118, 0] }, closed: false });
    C.P.add(cyl(0.0115, 0.120, 0.124, { q, seg: 24 }), 'lens', 0, { p: [0, 0.118, 0] });
    C.P.add(cyl(0.0115, 0.064, 0.068, { q, seg: 24 }), 'lens', 0, { p: [0, 0.118, 0] });
  }
  C.lathe([[0.004, 0.190, 0], [0.0085, 0.190, 0.0005], [0.0085, 0.235, 0.0006], [0.004, 0.235, 0]], 'park', 0.5, { tf: { p: [0, BV, 0] } });
  // translucent-look top magazine
  const M = C.sub('mag', [0, 0.09, -0.06]);
  M.side([[-0.195, 0.081, 0.004], [0.140, 0.081, 0.004], [0.140, 0.104, 0.006], [-0.188, 0.104, 0.008]], 0.044, 'polyGry', 0.45, { bevel: 0.005, bseg: hi ? 2 : 1 });
  if (hi) for (let i = 0; i < 12; i++) M.lathe([[0, -0.012, 0], [0.0028, -0.012, 0], [0.0028, 0.006, -1], [0.0, 0.012, 0]], 'brass', 0.2, { tf: { p: [0.0225, 0.090, -(-0.15 + i * 0.025)], r: [0, 90, 0] }, seg: 8 });
  M.flush();
  const B = C.sub('bolt', [0.02, 0.05, -0.12]);
  B.box(0.008, 0.012, 0.016, 0.003, 'poly', 0.7, { p: [0.028, 0.050, -0.120] });
  B.flush();
  C.side([[0.018, 0.016, 0], [0.024, 0.016, 0], [0.023, 0.004, -1], [0.019, -0.006, 0.001], [0.015, -0.004, 0.001], [0.017, 0.006, -1]], 0.006, 'poly', 0.6, { bevel: 0.0009 });
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', 0.235, BV), eject: anchor('eject', -0.12, 0.0, 0.0, [0, 0, -90]), leftHand: anchor('leftHand', 0.09, -0.03),
    mag: M.group, bolt: B.group, gripAngle: 4 * D2R, handguard: { w: 0.05, h: 0.05, y: -0.03, u: 0.09 }, gripBox: { c: [0, -0.018, 0.004], half: [0.025, 0.033, 0.016], r: 0.01 },
    gripR: { contact: [0.025, -0.004, -0.004], tilt: 6 }, gripL: { gamma: 60, contact: [0.020, -0.028, 0.0] },
    boltTravel: -0.05, charge: 'side', chargePt: new THREE.Vector3(0.028, 0.05, -0.12), magDrop: 'top', shellType: 'pistol', sightHeight: 0.13, noShell: false,
  }));
}
function buildBizon(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.075;
  // AK-type receiver
  C.side([[-0.10, 0.040, 0.002], [0.150, 0.040, 0.002], [0.150, 0.092, 0.002], [-0.10, 0.092, 0.002]], 0.036, 'blued', 0.3, { bevel: 0.001 });
  C.loft([{ z: 0.104, w: 0.034, h: 0.018, y: 0.098, rt: 0.012, rb: 0.001 }, { z: 0.10, w: 0.038, h: 0.024, y: 0.098, rt: 0.016, rb: 0.001 }, { z: -0.06, w: 0.038, h: 0.024, y: 0.098, rt: 0.016, rb: 0.001 }], 'blued', 0.35, { smooth: false });
  C.side([[0.06, 0.092, 0.002], [0.150, 0.092, 0.002], [0.150, 0.110, 0.002], [0.090, 0.110, 0.003]], 0.030, 'blued', 0.4, { bevel: 0.001 });
  if (hi) for (const s of [1, -1]) for (const [u, v] of [[0.13, 0.05], [0.145, 0.085], [-0.09, 0.05], [-0.09, 0.085]]) C.rivet(u, v, s * 0.018, s, 0.002);
  // helical magazine under the barrel (fixed part = the mag; detachable)
  C.cyl(0.0085, 0.15, 0.40, 'blued', 0.3, { tf: { p: [0, BV, 0] } });
  frontPost(C, 0.33, BV, 0.04, 'blued');
  C.lathe([[0.004, 0.36, 0], [0.011, 0.36, 0.0006], [0.011, 0.40, 0.0008], [0.005, 0.40, 0]], 'blued', 0.5, { tf: { p: [0, BV, 0] } });
  trigGroup(C, 0.008, 0.082, 0.041, 0.006, 0.0095, 'blued');
  gripLoft(C, 'polyStip', 17 * D2R, -0.066, 0.046, 0.029, 0.040, { swell: 0.05 });
  // folded stock (left side)
  C.side([[-0.10, 0.045, 0.004], [0.10, 0.045, 0.004], [0.10, 0.085, 0.004], [-0.10, 0.085, 0.004]], 0.004, 'blued', 0.5, { x: -0.021, bevel: 0.0012, holes: [[[-0.085, 0.052, 0.003], [0.085, 0.052, 0.003], [0.085, 0.078, 0.003], [-0.085, 0.078, 0.003]]] });
  const B = C.sub('bolt', [0.03, 0.084, -0.11]);
  boltKnob(B, 0.11, 0.084, 0.019, 1);
  B.flush();
  const M = C.sub('mag', [0, 0.04, -0.1]);
  M.lathe([[0.0, 0.085, 0], [0.023, 0.085, 0.003], [0.026, 0.10, -1], [0.026, 0.33, 0.004], [0.020, 0.345, 0.003], [0.0, 0.345, 0]], 'polyGry', 0.35, { tf: { p: [0, 0.036, 0] }, segMul: 1 });
  if (hi) for (let i = 0; i < 9; i++) M.lathe([[0.0262, 0.11 + i * 0.024, 0], [0.0275, 0.112 + i * 0.024, -1], [0.0262, 0.114 + i * 0.024, 0]], 'polyGry', 0.6, { tf: { p: [0, 0.036, 0] }, segMul: 1 });
  M.flush();
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', 0.40, BV), eject: anchor('eject', 0.04, 0.08, 0.02), leftHand: anchor('leftHand', 0.22, 0.036),
    mag: M.group, bolt: B.group, gripAngle: 17 * D2R, handguard: { w: 0.052, h: 0.052, y: 0.036, u: 0.22 },
    boltTravel: 0.07, charge: 'ak', chargePt: new THREE.Vector3(0.032, 0.084, -0.11), chargeFrom: 'below', magDrop: 'straight', magGrip: { y: 0.03, z: -0.24 }, shellType: 'pistol', sightHeight: 0.115,
  }));
}

// ============================================================================================
// Shotguns
// ============================================================================================
function pumpGun(lod, id, P) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = P.bv ?? 0.068;
  const recM = P.recMat || 'park';
  // receiver
  C.side([[-0.085, 0.034, 0.004], [0.125, 0.034, 0.004], [0.125, 0.088, 0.006], [-0.075, 0.090, 0.010], [-0.090, 0.075, 0.008]], 0.038, recM, 0.3, { bevel: 0.003, bseg: hi ? 2 : 1 });
  if (hi) {
    // ejection port + loading port (bottom)
    C.side([[0.020, 0.060, 0.002], [0.095, 0.060, 0.002], [0.095, 0.082, 0.002], [0.020, 0.082, 0.002]], 0.004, 'dark', 0, { x: 0.0175 });
    C.side([[0.030, 0.0335, 0.002], [0.110, 0.0335, 0.002], [0.110, 0.0345, 0.0], [0.030, 0.0345, 0.0]], 0.022, 'dark', 0);
    if (P.rail) rail(C, -0.06, 0.12, BV, 0.022, 0, 'park');
    else C.side([[-0.06, 0.088, 0.001], [0.12, 0.088, 0.001], [0.12, 0.091, 0.001], [-0.06, 0.091, 0.001]], 0.010, recM, 0.4, { bevel: 0.001 });
    for (const s of [1, -1]) { C.pin(0.0, 0.045, s * 0.019, s, 0.0022); C.pin(0.10, 0.045, s * 0.019, s, 0.0022); }
    addMarking(C.root, [P.mark || '12 GA  2 3/4"  3"'], 0.05, 0.050, -0.0191, -1, 0.045, 0.0055, { opacity: 0.45 });
  }
  trigGroup(C, -0.005, 0.070, 0.035, 0.0, 0.010, P.guardMat || 'poly');
  // barrel + magazine tube
  C.lathe([[0.0115, 0.12, 0], [0.0115, P.bl - 0.004, 0.001], [0.0062, P.bl, 0.0005], [0.0060, P.bl - 0.006, 0]], 'blued', 0.3, { tf: { p: [0, BV, 0] } });
  C.cyl(0.0105, 0.12, P.tube, 'blued', 0.35, { tf: { p: [0, BV - 0.026, 0] } });
  if (P.tube < P.bl - 0.02) C.side([[P.tube - 0.012, BV - 0.04, 0.003], [P.tube + 0.004, BV - 0.04, 0.003], [P.tube + 0.004, BV + 0.012, 0.003], [P.tube - 0.012, BV + 0.012, 0.003]], 0.026, 'blued', 0.5, { bevel: 0.002 });
  if (hi) C.P.add(sphere(0.0022, { q }), 'white', 0, { p: [0, BV + 0.0125, -(P.bl - 0.012)] });
  // pump / forend
  let PU = null;
  if (P.pump) {
    PU = C.sub('pump', [0, BV - 0.02, -(P.pump[0] + P.pump[1]) / 2]);
    const k = (u, w, h) => ({ z: -u, w, h, y: BV - 0.022, r: 0.016 });
    PU.loft([k(P.pump[0], 0.040, 0.040), k(P.pump[0] + 0.006, 0.046, 0.046), k(P.pump[1] - 0.006, 0.046, 0.046), k(P.pump[1], 0.040, 0.040)], P.pumpMat || 'polyStip', 0.6, { smooth: false });
    if (hi) for (let i = 0; i < 8; i++) PU.lathe([[0.0235, P.pump[0] + 0.015 + i * 0.012, 0], [0.0245, P.pump[0] + 0.019 + i * 0.012, -1], [0.0235, P.pump[0] + 0.023 + i * 0.012, 0]], P.pumpMat || 'polyStip', 0.7, { tf: { p: [0, BV - 0.022, 0] }, segMul: 0.9 });
    PU.flush();
  } else if (P.fore) {
    const k = (u, w, h) => ({ z: -u, w, h, y: BV - 0.018, r: 0.015 });
    C.loft([k(P.fore[0], 0.040, 0.044), k(P.fore[0] + 0.008, 0.046, 0.050), k(P.fore[1] - 0.008, 0.046, 0.050), k(P.fore[1], 0.040, 0.044)], P.foreMat || 'poly', 0.55, { smooth: false });
  }
  // stock / grip
  P.stock(C, BV);
  // bolt (visible in port)
  const B = C.sub('bolt', [0.0, 0.07, -0.05]);
  if (hi) B.side([[0.024, 0.062, 0.001], [0.092, 0.062, 0.001], [0.092, 0.080, 0.001], [0.024, 0.080, 0.001]], 0.004, 'chrome', 0.5, { x: 0.0145 });
  if (P.knob) boltKnob(B, 0.07, 0.070, 0.019, 1);
  B.flush();
  let M = null;
  if (P.boxMag) { M = C.sub('mag', [0, -0.02, 0.0]); P.boxMag(M, C); M.flush(); }
  return finish(C, rifleUD(Object.assign({
    id, muzzle: anchor('muzzle', P.bl, BV), eject: anchor('eject', 0.055, 0.072, 0.021), leftHand: anchor('leftHand', P.pump ? (P.pump[0] + P.pump[1]) / 2 : 0.22, BV - 0.022),
    mag: M ? M.group : null, bolt: B.group, gripAngle: (P.ga ?? 18) * D2R, handguard: { w: 0.046, h: 0.046, y: BV - 0.022, u: P.pump ? (P.pump[0] + P.pump[1]) / 2 : (P.fore ? (P.fore[0] + P.fore[1]) / 2 : 0.22) },
    parts: PU ? { pump: PU.group } : {}, pumpTravel: 0.075, boltTravel: 0.07, charge: P.pump ? 'pump' : 'side', chargePt: new THREE.Vector3(0.03, 0.07, -0.07),
    loadPort: new THREE.Vector3(0, 0.034, -0.07), shellType: 'shotgun', reloadType: P.boxMag ? 'reloadMag' : null, flashScale: 1.3, sightHeight: BV + 0.014,
  }, P.ud || {})));
}
function stockPolyPG(C, BV, mat = 'poly', ga = 18) {
  gripLoft(C, 'polyStip', ga * D2R, -0.068, 0.036, 0.029, 0.042, { swell: 0.05 });
  const sp = [[-0.085, 0.086, 0.004], [-0.120, 0.082, 0.004], [-0.330, 0.072, 0.008], [-0.336, 0.068, 0.004], [-0.336, -0.050, 0.006], [-0.300, -0.052, 0.01], [-0.170, 0.012, 0.03], [-0.100, 0.034, 0.004], [-0.085, 0.040, 0.004]];
  C.side(sp, 0.038, mat, 0.35, { bevel: 0.006, bseg: C.hi ? 3 : 1, r: 0.004, holes: C.hi ? [[[-0.130, 0.060, 0.008], [-0.250, 0.054, 0.012], [-0.250, 0.030, 0.01], [-0.160, 0.028, 0.012]]] : [] });
  if (C.hi) C.side([[-0.344, 0.070, 0.004], [-0.335, 0.070, 0.002], [-0.335, -0.052, 0.002], [-0.344, -0.052, 0.004]], 0.042, 'rubber', 0.6, { bevel: 0.003 });
}
function buildNova(lod, id) {
  return pumpGun(lod, id, { bl: 0.52, tube: 0.44, pump: [0.15, 0.31], recMat: 'park', pumpMat: 'polyStip', mark: 'NOVA  12 GA', stock: (C, BV) => stockPolyPG(C, BV, 'poly') });
}
function buildXM(lod, id) {
  return pumpGun(lod, id, { bl: 0.50, tube: 0.42, fore: [0.14, 0.33], foreMat: 'poly', rail: true, knob: true, mark: 'XM1014  12 GA', stock: (C, BV) => {
    gripLoft(C, 'polyStip', 20 * D2R, -0.068, 0.036, 0.029, 0.042, { swell: 0.05 });
    C.cyl(0.0145, -0.27, -0.085, 'anod', 0.3, { tf: { p: [0, 0.074, 0] } });
    C.side([[-0.190, 0.092, 0.006], [-0.290, 0.094, 0.004], [-0.298, 0.092, 0.004], [-0.298, -0.006, 0.006], [-0.286, -0.006, 0.006], [-0.250, 0.034, 0.01], [-0.200, 0.058, 0.01], [-0.190, 0.062, 0.004]], 0.036, 'poly', 0.35, { bevel: 0.004, bseg: C.hi ? 3 : 1, r: 0.004 });
  }, ud: { charge: 'side', chargePt: new THREE.Vector3(0.032, 0.07, -0.07) } });
}
function buildSawedoff(lod, id) {
  return pumpGun(lod, id, { bl: 0.30, tube: 0.27, pump: [0.13, 0.25], recMat: 'blued', pumpMat: 'woodPale', guardMat: 'blued', mark: 'MOD 870  12 GA', stock: (C, BV) => {
    // sawed wooden pistol-grip stock
    const g = gripLoft(C, 'woodPale', 22 * D2R, -0.080, 0.030, 0.032, 0.046, { swell: 0.08, wear: 0.7 });
    C.side([[-0.085, 0.086, 0.004], [-0.130, 0.072, 0.006], [-0.150, 0.040, 0.012], [-0.120, 0.008, 0.01], [-0.090, 0.030, 0.004]], 0.036, 'woodPale', 0.7, { bevel: 0.006, bseg: C.hi ? 3 : 1 });
    if (C.hi) C.tube([[0.0, 0.03, 0.15], [0.02, 0.02, 0.15], [0.02, 0.05, 0.13]], 0.002, 'tape', 0.6);
  } });
}
function buildMag7(lod, id) {
  return pumpGun(lod, id, { bl: 0.33, tube: 0.12, pump: [0.08, 0.26], recMat: 'paintBlk', pumpMat: 'polyStip', mark: 'MAG-7  12 GA', bv: 0.075, ga: 12,
    stock: (C, BV) => {
      // grip housing the box magazine, folded stock on top
      C.side([[-0.090, 0.035, 0.006], [0.0, 0.035, 0.004], [0.010, -0.075, 0.006], [-0.040, -0.075, 0.006], [-0.050, 0.010, 0.01], [-0.090, 0.020, 0.008]], 0.040, 'polyStip', 0.5, { bevel: 0.004 });
      if (C.hi) for (const s of [1, -1]) C.cyl(0.004, -0.10, 0.08, 'steel', 0.5, { tf: { p: [s * 0.018, 0.092, 0] }, seg: 8 });
      C.box(0.044, 0.012, 0.012, 0.004, 'rubber', 0.6, { p: [0, 0.092, 0.105] });
    },
    boxMag: (M) => { M.side([[-0.034, -0.073, 0.002], [0.004, -0.073, 0.002], [0.004, -0.085, 0.002], [-0.034, -0.085, 0.002]], 0.044, 'park', 0.85, { bevel: 0.0012 }); M.side([[-0.032, -0.074, 0.002], [0.002, -0.074, 0.002], [0.002, 0.03, 0.002], [-0.032, 0.03, 0.002]], 0.030, 'park', 0.5, { bevel: 0.001 }); },
    ud: { magDrop: 'straight', magGrip: { y: -0.06 } } });
}

// ============================================================================================
// Machine guns
// ============================================================================================
function buildM249(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.080;
  // receiver with feed tray / top cover
  C.side([[-0.120, 0.034, 0.004], [0.170, 0.034, 0.004], [0.170, 0.096, 0.004], [-0.115, 0.096, 0.006], [-0.125, 0.080, 0.006]], 0.056, 'park', 0.3, { bevel: 0.0025 });
  C.side([[-0.090, 0.096, 0.004], [0.150, 0.096, 0.004], [0.150, 0.110, 0.006], [-0.075, 0.118, 0.012], [-0.095, 0.108, 0.006]], 0.052, 'park', 0.4, { bevel: 0.003 });
  if (hi) {
    rail(C, -0.06, 0.14, 0.110, 0.0, 0, 'park', 0.02);
    for (const s of [1, -1]) for (const [u, v] of [[-0.10, 0.045], [-0.10, 0.085], [0.15, 0.045], [0.15, 0.085], [0.03, 0.045]]) C.rivet(u, v, s * 0.028, s, 0.0022);
    // feed tray opening (left) + belt
    C.side([[0.04, 0.070, 0.002], [0.10, 0.070, 0.002], [0.10, 0.090, 0.002], [0.04, 0.090, 0.002]], 0.004, 'dark', 0, { x: -0.027 });
    for (let i = 0; i < 6; i++) C.lathe([[0, -0.03, 0], [0.0048, -0.03, 0], [0.0048, 0.0, -1], [0.0040, 0.005, -1], [0, 0.014, 0]], 'brass', 0.3, { tf: { p: [-0.032 - i * 0.002, 0.080 - i * 0.011, -0.07], r: [0, 0, -12 * i] }, seg: 8 });
  }
  trigGroup(C, 0.0, 0.07, 0.035, 0.0, 0.012, 'park');
  gripLoft(C, 'polyStip', 15 * D2R, -0.072, 0.030, 0.030, 0.042, { swell: 0.05, grooves: 3 });
  // handguard + heat shield + barrel + carry handle + bipod
  const k = (u, w, h) => ({ z: -u, w, h, y: BV - 0.01, r: 0.012 });
  C.loft([k(0.170, 0.056, 0.062), k(0.176, 0.060, 0.066), k(0.330, 0.060, 0.066), k(0.336, 0.054, 0.060)], 'polyStip', 0.55, { smooth: false });
  if (hi) for (let i = 0; i < 6; i++) for (const s of [1, -1]) C.box(0.003, 0.03, 0.012, 0.004, 'dark', 0, { p: [s * 0.0298, BV - 0.01, -(0.19 + i * 0.024)] });
  C.lathe([[0.0145, 0.33, 0], [0.0145, 0.36, 0.001], [0.0115, 0.37, -1], [0.0110, 0.60, 0.001], [0.006, 0.60, 0]], 'park', 0.3, { tf: { p: [0, BV, 0] } });
  birdcage(C, 0.56, BV);
  C.side([[0.33, BV - 0.035, 0.004], [0.38, BV - 0.035, 0.004], [0.38, BV - 0.010, 0.004], [0.33, BV - 0.010, 0.004]], 0.03, 'park', 0.4, { bevel: 0.002 });
  if (hi) { C.tube([[0, 0.096, -0.16], [0, 0.135, -0.19], [0, 0.135, -0.27], [0, 0.098, -0.30]], 0.005, 'park', 0.5); frontPost(C, 0.52, BV, 0.03); }
  for (const s of [1, -1]) C.cyl(0.0045, 0.38, 0.56, 'park', 0.5, { tf: { p: [s * 0.010, BV - 0.022, 0] }, seg: 10 });
  // skeletal stock
  C.side([[-0.120, 0.090, 0.006], [-0.390, 0.084, 0.006], [-0.395, -0.03, 0.006], [-0.36, -0.032, 0.01], [-0.12, 0.040, 0.006]], 0.040, 'poly', 0.35, { bevel: 0.006, bseg: hi ? 2 : 1, holes: [[[-0.150, 0.075, 0.008], [-0.350, 0.070, 0.008], [-0.350, -0.010, 0.01], [-0.170, 0.050, 0.01]]] });
  const B = C.sub('bolt', [0.03, 0.06, -0.06]);
  boltKnob(B, 0.06, 0.062, 0.028, 1);
  B.flush();
  // ammo box (mag) below-left
  const M = C.sub('mag', [0, 0.03, -0.075]);
  M.side([[0.020, 0.036, 0.004], [0.130, 0.036, 0.004], [0.130, -0.075, 0.006], [0.020, -0.075, 0.006]], 0.060, 'polyOD', 0.5, { bevel: 0.004, x: -0.012 });
  if (hi) { M.box(0.064, 0.012, 0.030, 0.003, 'polyOD', 0.7, { p: [-0.012, -0.074, -0.075] }); M.side([[0.030, 0.0, 0.002], [0.12, 0.0, 0.002], [0.12, 0.004, 0.002], [0.03, 0.004, 0.002]], 0.062, 'polyOD', 0.6, { x: -0.012 }); }
  M.flush();
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', 0.605, BV), eject: anchor('eject', 0.08, 0.04, 0.0, [0, 0, -90]), leftHand: anchor('leftHand', 0.25, BV - 0.01),
    mag: M.group, bolt: B.group, gripAngle: 15 * D2R, handguard: { w: 0.060, h: 0.066, y: BV - 0.01, u: 0.25 },
    boltTravel: 0.08, charge: 'side', chargePt: new THREE.Vector3(0.042, 0.062, -0.06), magDrop: 'straight', magGrip: { y: -0.02 }, flashScale: 1.2, sightHeight: 0.125,
  }));
}
function buildNegev(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.078;
  C.side([[-0.130, 0.032, 0.004], [0.160, 0.032, 0.004], [0.160, 0.098, 0.006], [-0.120, 0.100, 0.008], [-0.135, 0.080, 0.008]], 0.054, 'parkDark', 0.3, { bevel: 0.003 });
  if (hi) { rail(C, -0.10, 0.15, BV, 0.022, 0, 'park', 0.02); for (const s of [1, -1]) for (const [u, v] of [[-0.11, 0.04], [0.14, 0.04], [-0.11, 0.09], [0.14, 0.09]]) C.rivet(u, v, s * 0.027, s, 0.0022); }
  trigGroup(C, 0.0, 0.07, 0.033, -0.002, 0.012, 'park');
  gripLoft(C, 'polyStip', 15 * D2R, -0.072, 0.028, 0.030, 0.042, { swell: 0.05 });
  // vented barrel shroud + front grip
  C.cyl(0.020, 0.16, 0.42, 'parkDark', 0.35, { tf: { p: [0, BV, 0] } });
  if (hi) for (let i = 0; i < 10; i++) for (let j = 0; j < 4; j++) { const g = cyl(0.0042, 0, 0.0008, { q, seg: 10 }); g.rotateX(Math.PI / 2); g.translate(0, 0.0201, -(0.18 + i * 0.023)); C.P.add(g, 'dark', 0, { p: [0, BV, 0], r: [0, 0, j * 90 + 45] }); }
  C.lathe([[0.006, 0.42, 0], [0.0115, 0.42, 0.001], [0.0115, 0.60, 0.001], [0.006, 0.60, 0]], 'park', 0.3, { tf: { p: [0, BV, 0] } });
  birdcage(C, 0.56, BV);
  verticalGrip(C, 0.25, BV - 0.018, 0.09, 'polyStip', 0);
  if (hi) { frontPost(C, 0.40, BV + 0.016, 0.03); C.tube([[0, 0.10, -0.08], [0, 0.135, -0.11], [0, 0.135, -0.19], [0, 0.100, -0.22]], 0.005, 'park', 0.5); }
  C.side([[-0.130, 0.092, 0.006], [-0.380, 0.086, 0.006], [-0.386, -0.030, 0.006], [-0.355, -0.032, 0.01], [-0.130, 0.040, 0.006]], 0.040, 'poly', 0.35, { bevel: 0.006, bseg: hi ? 2 : 1, holes: [[[-0.160, 0.076, 0.008], [-0.345, 0.072, 0.008], [-0.345, -0.010, 0.01], [-0.180, 0.050, 0.01]]] });
  const B = C.sub('bolt', [0.03, 0.06, -0.06]);
  boltKnob(B, 0.07, 0.060, 0.027, 1);
  B.flush();
  const M = C.sub('mag', [0, 0.03, -0.07]);
  M.side([[0.010, 0.034, 0.004], [0.140, 0.034, 0.004], [0.140, -0.090, 0.006], [0.010, -0.090, 0.006]], 0.056, 'polyGry', 0.5, { bevel: 0.004 });
  M.flush();
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', 0.605, BV), eject: anchor('eject', 0.08, 0.035, 0.0, [0, 0, -90]), leftHand: anchor('leftHand', 0.25, BV - 0.02),
    mag: M.group, bolt: B.group, gripAngle: 15 * D2R, handguard: { w: 0.030, h: 0.09, y: BV - 0.06, u: 0.25 },
    gripL: { gamma: 75, contact: [0.012, -0.03, 0.0] }, boltTravel: 0.08, charge: 'side', chargePt: new THREE.Vector3(0.04, 0.06, -0.07), magDrop: 'straight', magGrip: { y: -0.03 }, flashScale: 1.2, sightHeight: 0.13,
  }));
}

// ============================================================================================
// Other rifles
// ============================================================================================
function buildGalil(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.082, RW = 0.036;
  C.side([[-0.105, 0.040, 0.002], [0.160, 0.040, 0.002], [0.160, 0.096, 0.002], [-0.105, 0.096, 0.002]], RW, 'park', 0.3, { bevel: 0.0012 });
  C.loft([{ z: 0.108, w: RW, h: 0.016, y: 0.102, rt: 0.012, rb: 0.001 }, { z: 0.104, w: RW + 0.002, h: 0.022, y: 0.102, rt: 0.014, rb: 0.001 }, { z: -0.07, w: RW + 0.002, h: 0.022, y: 0.102, rt: 0.014, rb: 0.001 }], 'park', 0.35, { smooth: false });
  C.side([[0.07, 0.095, 0.002], [0.165, 0.095, 0.002], [0.165, 0.112, 0.002], [0.09, 0.114, 0.003]], 0.030, 'park', 0.4, { bevel: 0.0012 });
  if (hi) {
    for (const s of [1, -1]) for (const [u, v] of [[0.14, 0.05], [0.155, 0.088], [-0.09, 0.05], [-0.09, 0.088]]) C.rivet(u, v, s * RW / 2, s, 0.002);
    // carry handle / rear sight block
    C.side([[0.10, 0.112, 0.002], [0.16, 0.112, 0.002], [0.16, 0.126, 0.002], [0.12, 0.126, 0.002]], 0.020, 'park', 0.5, { bevel: 0.0012 });
    // selector lever right
    C.side([[-0.08, 0.072, 0.003], [0.06, 0.088, 0.002], [0.062, 0.084, 0.002], [-0.04, 0.072, -1], [-0.06, 0.066, 0.003], [-0.075, 0.066, 0.003]], 0.0015, 'park', 0.7, { x: RW / 2 + 0.001, bevel: 0.0005 });
  }
  // ribbed polymer handguard
  const k = (u, w, h) => ({ z: -u, w, h, y: BV - 0.004, rt: 0.010, rb: 0.016 });
  C.loft([k(0.165, 0.046, 0.054), k(0.172, 0.050, 0.058), k(0.35, 0.050, 0.058), k(0.357, 0.044, 0.050)], 'polyStip', 0.55, { smooth: false, ca: hi ? 5 : 2 });
  if (hi) for (let i = 0; i < 8; i++) for (const s of [1, -1]) C.box(0.003, 0.034, 0.008, 0.0025, 'polyStip', 0.6, { p: [s * 0.0255, BV - 0.004, -(0.185 + i * 0.021)] });
  C.lathe([[0.0098, 0.16, 0], [0.0098, 0.36, -1], [0.0088, 0.50, 0.001], [0.005, 0.50, 0]], 'park', 0.3, { tf: { p: [0, BV, 0] } });
  C.cyl(0.008, 0.16, 0.39, 'park', 0.4, { tf: { p: [0, 0.114, 0] }, segMul: 0.7 });
  C.side([[0.37, 0.07, 0.002], [0.40, 0.07, 0.002], [0.40, 0.124, 0.002], [0.37, 0.124, 0.002]], 0.022, 'park', 0.4, { bevel: 0.0012 });
  frontPost(C, 0.445, BV + 0.01, 0.05);
  birdcage(C, 0.48, BV);
  trigGroup(C, 0.008, 0.085, 0.041, 0.006, 0.0095, 'park');
  gripLoft(C, 'polyStip', 18 * D2R, -0.068, 0.046, 0.029, 0.041, { swell: 0.05, grooves: 2 });
  // folding skeleton tube stock (extended)
  C.tube([[0, 0.090, 0.105], [0, 0.088, 0.28], [0, 0.080, 0.36], [0, -0.040, 0.37], [0, -0.035, 0.30], [0, 0.040, 0.105]], 0.0085, 'park', 0.4, { seg: 40 });
  C.side([[-0.378, 0.092, 0.004], [-0.365, 0.092, 0.004], [-0.365, -0.050, 0.004], [-0.378, -0.050, 0.004]], 0.036, 'rubber', 0.6, { bevel: 0.003 });
  const B = C.sub('bolt', [0.03, 0.09, -0.1]);
  // upturned galil charging handle
  B.cyl(0.0035, 0, 0.018, 'park', 0.6, { tf: { p: [RW / 2, 0.088, -0.095], r: [-35, -90, 0] }, seg: 10 });
  B.P.add(sphere(0.005, { q, segMul: 0.5 }), 'park', 0.7, { p: [RW / 2 + 0.0145, 0.099, -0.095] });
  B.flush();
  const M = C.sub('mag', [0, 0.056, -0.145]);
  stdMagGrip(C, M, 0.087, 0.143, 0.062, 0.20, 0.07, 0.027, 'park');
  M.flush();
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', 0.525, BV), eject: anchor('eject', 0.05, 0.086, RW / 2 + 0.002), leftHand: anchor('leftHand', 0.26, BV - 0.004),
    mag: M.group, bolt: B.group, gripAngle: 18 * D2R, handguard: { w: 0.050, h: 0.058, y: BV - 0.004, u: 0.26 },
    boltTravel: 0.075, charge: 'ak', chargePt: new THREE.Vector3(RW / 2 + 0.0145, 0.099, -0.095), chargeFrom: 'below', magDrop: 'rock', sightHeight: 0.13,
  }));
}
function buildFamas(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.070;
  // bullpup body: grip at origin, mag behind the grip, long carry handle on top
  const body = [[0.232, 0.046, 0.012], [0.236, 0.088, 0.012], [-0.400, 0.096, 0.02], [-0.428, 0.084, 0.012], [-0.432, -0.026, 0.015], [-0.415, -0.038, 0.018],
    ...bez3([-0.380, -0.034], [-0.300, -0.012], [-0.200, 0.016], [-0.120, 0.022], 6), [-0.030, 0.026, 0.008], [0.000, 0.036, 0.006], [0.100, 0.034, 0.014]];
  C.side(body, 0.046, 'polyGry', (x, y, z) => 0.3 + (y < 0.04 ? 0.3 : 0), { bevel: 0.009, bseg: hi ? 4 : 1, r: 0.005, wfn: (u, v) => 0.86 + 0.14 * clamp((-u + 0.05) / 0.25, 0, 1) });
  if (hi) for (let i = 0; i < 5; i++) for (const s of [1, -1]) C.box(0.0025, 0.020, 0.006, 0.0025, 'dark', 0, { p: [s * 0.0205, 0.040, (0.22 + i * 0.03)] });
  // trigger guard (big, full-hand)
  C.side([[0.005, 0.034, 0.002], [0.005, -0.075, 0.01], [0.090, -0.020, 0.02], [0.110, 0.030, 0.004]], 0.012, 'polyGry', 0.5, { bevel: 0.002, holes: [[[0.030, 0.026, 0.003], [0.030, -0.055, 0.008], [0.082, -0.020, 0.012], [0.092, 0.026, 0.004]]] });
  gripLoft(C, 'polyStip', 12 * D2R, -0.075, 0.035, 0.030, 0.040, { swell: 0.04 });
  C.side([[0.050, 0.032, 0], [0.056, 0.032, 0], [0.054, 0.021, -1], [0.051, 0.014, 0.0012], [0.046, 0.013, 0.0012], [0.047, 0.018, -1], [0.049, 0.026, -1]], 0.005, 'steel', 0.6, { bevel: 0.0008 });
  // carry handle with sights
  C.side([[-0.300, 0.094, 0.006], [0.200, 0.094, 0.006], [0.200, 0.134, 0.006], [0.150, 0.140, 0.006], [-0.250, 0.140, 0.006], [-0.300, 0.120, 0.006]], 0.022, 'polyGry', 0.5,
    { bevel: 0.004, bseg: hi ? 2 : 1, holes: [[[-0.270, 0.103, 0.004], [0.170, 0.103, 0.004], [0.170, 0.124, 0.004], [-0.240, 0.128, 0.004]]] });
  // barrel, flash hider, bipod legs folded along sides
  C.lathe([[0.0098, 0.22, 0], [0.0090, 0.36, 0.001], [0.005, 0.36, 0]], 'park', 0.3, { tf: { p: [0, BV, 0] } });
  C.lathe([[0.005, 0.33, 0], [0.012, 0.33, 0.0008], [0.012, 0.37, 0.001], [0.006, 0.37, 0]], 'park', 0.5, { tf: { p: [0, BV, 0] }, closed: true });
  if (hi) for (const s of [1, -1]) C.cyl(0.004, 0.0, 0.22, 'park', 0.5, { tf: { p: [s * 0.024, 0.064, 0] }, seg: 10 });
  if (hi) for (let i = 0; i < 7; i++) for (const s of [1, -1]) C.box(0.003, 0.016, 0.010, 0.003, 'dark', 0, { p: [s * 0.0215, 0.064, -(0.08 + i * 0.02)] });
  const B = C.sub('bolt', [0, 0.11, -0.1]);
  B.box(0.010, 0.010, 0.020, 0.003, 'poly', 0.7, { p: [0, 0.128, -0.12] });
  B.flush();
  const M = C.sub('mag', [0, -0.02, 0.10]);
  M.side([[-0.135, 0.030, 0.002], [-0.075, 0.030, 0.002], [-0.075, -0.075, 0.002], [-0.135, -0.075, 0.002]], 0.024, 'park', 0.5, { bevel: 0.0012 });
  M.side([[-0.138, -0.073, 0.002], [-0.072, -0.073, 0.002], [-0.072, -0.081, 0.002], [-0.138, -0.081, 0.002]], 0.028, 'poly', 0.85, { bevel: 0.0012 });
  M.flush();
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', 0.37, BV), eject: anchor('eject', -0.18, 0.07, 0.024), leftHand: anchor('leftHand', 0.16, 0.060),
    mag: M.group, bolt: B.group, gripAngle: 12 * D2R, handguard: { w: 0.044, h: 0.052, y: 0.062, u: 0.16 }, gripBox: { c: [0, -0.02, 0.004], half: [0.015, 0.055, 0.020], r: 0.01 },
    boltTravel: 0.06, charge: 'top', chargePt: new THREE.Vector3(0, 0.128, -0.12), magDrop: 'bullpup', sightHeight: 0.145,
  }));
}
function buildSG(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.080;
  C.side([[-0.110, 0.036, 0.004], [0.160, 0.036, 0.004], [0.160, 0.100, 0.004], [-0.105, 0.100, 0.006], [-0.115, 0.085, 0.006]], 0.038, 'park', 0.3, { bevel: 0.0025 });
  rail(C, -0.10, 0.15, BV, 0.0205, 0, 'park');
  const k = (u, w, h) => ({ z: -u, w, h, y: BV - 0.006, rt: 0.010, rb: 0.016 });
  C.loft([k(0.160, 0.044, 0.056), k(0.166, 0.050, 0.060), k(0.33, 0.050, 0.060), k(0.336, 0.044, 0.054)], 'polyOD', 0.55, { smooth: false });
  if (hi) for (let i = 0; i < 6; i++) for (const s of [1, -1]) C.box(0.003, 0.012, 0.016, 0.004, 'dark', 0, { p: [s * 0.0255, BV + 0.006, -(0.18 + i * 0.025)] });
  C.lathe([[0.0098, 0.16, 0], [0.0090, 0.44, 0.001], [0.005, 0.44, 0]], 'park', 0.3, { tf: { p: [0, BV, 0] } });
  birdcage(C, 0.41, BV);
  trigGroup(C, 0.006, 0.084, 0.037, 0.002, 0.012, 'polyOD');
  gripLoft(C, 'polyStip', 17 * D2R, -0.068, 0.040, 0.030, 0.042, { swell: 0.05 });
  // folding skeletal stock
  C.side([[-0.110, 0.094, 0.006], [-0.340, 0.088, 0.006], [-0.345, -0.035, 0.006], [-0.320, -0.040, 0.01], [-0.110, 0.045, 0.006]], 0.034, 'polyOD', 0.35, { bevel: 0.005, bseg: hi ? 2 : 1, holes: [[[-0.135, 0.080, 0.008], [-0.310, 0.075, 0.008], [-0.310, -0.012, 0.01], [-0.150, 0.055, 0.01]]] });
  // 4x combat scope (ACOG-like)
  {
    const ay = BV + 0.045;
    C.side([[-0.060, BV + 0.024, 0.004], [0.060, BV + 0.024, 0.004], [0.060, ay + 0.006, 0.01], [-0.060, ay + 0.006, 0.01]], 0.040, 'anod', 0.35, { bevel: 0.006, bseg: hi ? 3 : 1 });
    C.lathe([[0.016, -0.075, 0.001], [0.018, -0.070, 0.002], [0.018, -0.058, 0.002], [0.0, -0.058, 0]], 'anod', 0.4, { tf: { p: [0, ay, 0] } });
    C.lathe([[0.0, 0.058, 0], [0.020, 0.058, 0.002], [0.021, 0.075, 0.002], [0.019, 0.078, 0.001]], 'anod', 0.4, { tf: { p: [0, ay, 0] } });
    C.P.add(cyl(0.0175, 0.069, 0.074, { q, seg: 28 }), 'lens', 0, { p: [0, ay, 0] });
    C.P.add(cyl(0.0145, -0.074, -0.070, { q, seg: 24 }), 'lens', 0, { p: [0, ay, 0] });
    if (hi) { C.box(0.010, 0.010, 0.010, 0.003, 'anod', 0.6, { p: [0, ay + 0.026, 0.0] }); C.box(0.010, 0.010, 0.010, 0.003, 'anod', 0.6, { p: [0.025, ay, 0.0] }); }
  }
  const B = C.sub('bolt', [0.03, 0.085, -0.1]);
  boltKnob(B, 0.10, 0.086, 0.019, 1);
  B.flush();
  const M = C.sub('mag', [0, 0.04, -0.13]);
  stdMagGrip(C, M, 0.085, 0.140, 0.040, 0.18, 0.05, 0.025, 'polyGry');
  M.flush();
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', 0.455, BV), eject: anchor('eject', 0.05, 0.085, 0.021), leftHand: anchor('leftHand', 0.25, BV - 0.006),
    mag: M.group, bolt: B.group, scope: true, gripAngle: 17 * D2R, handguard: { w: 0.050, h: 0.060, y: BV - 0.006, u: 0.25 },
    boltTravel: 0.07, charge: 'ak', chargePt: new THREE.Vector3(0.032, 0.086, -0.10), chargeFrom: 'below', magDrop: 'rock', sightHeight: BV + 0.045,
  }));
}
function buildAUG(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.070;
  // stock/body shell (green)
  const body = [[0.100, 0.036, 0.014], [0.116, 0.088, 0.016], [-0.120, 0.093, 0.03], [-0.415, 0.090, 0.03], [-0.437, 0.064, 0.02], [-0.438, -0.040, 0.02], [-0.418, -0.060, 0.025],
    ...bez3([-0.380, -0.058], [-0.300, -0.050], [-0.180, 0.000], [-0.090, 0.006], 8), [-0.010, 0.018, 0.012], [0.040, 0.030, 0.014]];
  C.side(body, 0.054, 'polyOD', (x, y, z) => 0.3 + (y < 0.03 ? 0.3 : 0), { bevel: 0.012, bseg: hi ? 4 : 1, r: 0.006, wfn: (u, v) => 0.9 + 0.12 * clamp((-u - 0.05) / 0.3, 0, 1) - 0.08 * clamp((v - 0.05) / 0.05, 0, 1) });
  if (hi) for (const s of [1, -1]) C.side([[-0.38, 0.070, 0.01], [-0.17, 0.072, 0.01], [-0.17, 0.084, 0.006], [-0.38, 0.082, 0.006]], 0.004, 'polyOD', 0.5, { x: s * 0.0285, bevel: 0.0016 });
  // full-hand trigger guard loop
  C.side([[-0.010, 0.022, 0.003], [-0.008, -0.080, 0.012], [0.040, -0.085, 0.012], [0.090, 0.032, 0.006]], 0.014, 'polyOD', 0.5, { bevel: 0.0025, holes: [[[0.016, 0.018, 0.004], [0.018, -0.068, 0.008], [0.038, -0.070, 0.008], [0.072, 0.024, 0.006]]] });
  gripLoft(C, 'polyOD', 8 * D2R, -0.075, 0.020, 0.030, 0.040, { swell: 0.05, wear: 0.7 });
  C.side([[0.008, 0.020, 0], [0.014, 0.020, 0], [0.012, 0.008, -1], [0.009, 0.0, 0.0012], [0.004, 0.0, 0.0012], [0.005, 0.006, -1], [0.007, 0.014, -1]], 0.006, 'poly', 0.6, { bevel: 0.0008 });
  // barrel + vertical folding grip + flash hider
  C.lathe([[0.012, 0.10, 0], [0.012, 0.13, -1], [0.0095, 0.15, -1], [0.009, 0.40, 0.001], [0.005, 0.40, 0]], 'park', 0.3, { tf: { p: [0, BV, 0] } });
  C.cyl(0.0175, 0.10, 0.16, 'park', 0.4, { tf: { p: [0, BV, 0] } });
  verticalGrip(C, 0.135, BV - 0.014, 0.095, 'polyOD', 0);
  C.lathe([[0.005, 0.37, 0], [0.012, 0.37, 0.0008], [0.012, 0.415, 0.001], [0.006, 0.415, 0]], 'park', 0.5, { tf: { p: [0, BV, 0] }, closed: true });
  // integrated scope handle
  C.side([[-0.110, 0.090, 0.006], [0.080, 0.090, 0.006], [0.070, 0.104, 0.004], [-0.100, 0.104, 0.004]], 0.030, 'anod', 0.4, { bevel: 0.003 });
  for (const u of [-0.08, 0.05]) C.side([[u - 0.012, 0.100, 0.004], [u + 0.012, 0.100, 0.004], [u + 0.008, 0.122, 0.004], [u - 0.008, 0.122, 0.004]], 0.022, 'anod', 0.4, { bevel: 0.003 });
  {
    const ay = 0.132;
    C.lathe([[0.018, -0.120, 0.001], [0.019, -0.112, 0.002], [0.016, -0.090, 0.004], [0.016, 0.060, 0.004], [0.022, 0.085, 0.004], [0.022, 0.100, 0.002], [0.020, 0.104, 0.001]], 'anod', 0.35, { tf: { p: [0, ay, 0] } });
    C.P.add(cyl(0.0185, 0.095, 0.100, { q, seg: 28 }), 'lens', 0, { p: [0, ay, 0] });
    C.P.add(cyl(0.0155, -0.118, -0.113, { q, seg: 24 }), 'lens', 0, { p: [0, ay, 0] });
    if (hi) C.lathe([[0.019, -0.140, 0.0006], [0.020, -0.138, 0.001], [0.020, -0.118, 0.001], [0.018, -0.115, 0]], 'rubber', 0.5, { tf: { p: [0, ay, 0] } });
  }
  const B = C.sub('bolt', [-0.02, 0.085, -0.05]);
  boltKnob(B, 0.05, 0.085, -0.027, -1, 'park');
  B.flush();
  const M = C.sub('mag', [0, 0.0, 0.08]);
  M.side([[-0.150, 0.020, 0.002], [-0.090, 0.024, 0.002], [-0.075, -0.120, 0.002], [-0.135, -0.124, 0.002]], 0.025, 'polyGry', 0.45, { bevel: 0.0014 });
  M.side([[-0.138, -0.122, 0.002], [-0.073, -0.118, 0.002], [-0.073, -0.127, 0.002], [-0.138, -0.131, 0.002]], 0.029, 'poly', 0.85, { bevel: 0.0012 });
  M.flush();
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', 0.415, BV), eject: anchor('eject', -0.16, 0.07, 0.027), leftHand: anchor('leftHand', 0.135, BV - 0.05),
    mag: M.group, bolt: B.group, scope: true, gripAngle: 8 * D2R, handguard: { w: 0.030, h: 0.09, y: BV - 0.06, u: 0.135 }, gripBox: { c: [0, -0.028, 0.002], half: [0.015, 0.05, 0.020], r: 0.01 },
    gripL: { gamma: 75, contact: [0.012, -0.03, 0.0] }, boltTravel: -0.06, charge: 'side', chargePt: new THREE.Vector3(-0.04, 0.085, -0.05), magDrop: 'bullpup', sightHeight: 0.132,
  }));
}
function boltRifle(lod, id, P) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = P.bv;
  // stock
  C.side(P.stock, P.sw ?? 0.044, P.stockMat, (x, y, z) => 0.3 + (-z < 0.05 && -z > -0.1 ? 0.35 : 0), { bevel: 0.006, bseg: hi ? 3 : 1, r: 0.004, holes: P.holes || [], hr: 0.008, wfn: P.wfn });
  if (P.grip) P.grip(C);
  trigGroup(C, -0.030, 0.045, 0.040, 0.010, 0.012, 'park');
  // action
  C.lathe([[0.0, -0.070, 0], [0.0155, -0.070, 0.002], [0.0165, -0.060, 0.002], [0.0165, 0.150, 0.002], [0.015, 0.160, 0], [0, 0.160, 0]], P.actMat || 'blued', 0.3, { tf: { p: [0, BV, 0] } });
  if (hi) C.side([[0.020, BV - 0.004, 0.003], [0.080, BV - 0.004, 0.003], [0.080, BV + 0.012, 0.003], [0.020, BV + 0.012, 0.003]], 0.004, 'dark', 0, { x: 0.0148 });
  rail(C, -0.06, 0.15, BV, 0.0165, 0, 'blued');
  const B = C.sub('bolt', [0, BV, 0.0]);
  B.cyl(0.0098, -0.110, 0.08, 'chrome', 0.5, { tf: { p: [0, BV, 0] }, seg: 20 });
  B.lathe([[0, -0.115, 0], [0.0115, -0.115, 0.002], [0.0115, -0.095, 0.002], [0.010, -0.093, 0]], 'blued', 0.5, { tf: { p: [0, BV, 0] } });
  B.cyl(0.0040, 0, 0.040, 'blued', 0.6, { tf: { p: [0.008, BV, 0.020], r: [0, -90, 25] }, seg: 12 });
  B.P.add(sphere(0.0090, { q, segMul: 0.6 }), 'blued', 0.7, { p: [0.045, BV - 0.016, 0.021] });
  B.flush();
  C.lathe([[0.0135, 0.155, 0], [0.0135, 0.22, -1], [0.0098, 0.40, -1], [0.0090, P.bl, 0.001], [0.005, P.bl, 0]], 'blued', 0.25, { tf: { p: [0, BV, 0] } });
  if (P.brake) C.lathe([[0.005, P.bl - 0.01, 0], [0.012, P.bl - 0.01, 0.001], [0.012, P.bl + 0.035, 0.002], [0.0055, P.bl + 0.035, 0.001]], 'blued', 0.5, { tf: { p: [0, BV, 0] }, closed: true });
  scope(C, P.scope[0], P.scope[1], P.scope[2], P.scopeO || {});
  const M = C.sub('mag', [0, 0.03, -0.09]);
  M.side([[0.050, 0.050, 0.002], [0.115, 0.050, 0.002], [0.115, 0.008, 0.003], [0.050, 0.008, 0.003]], 0.030, 'poly', 0.4, { bevel: 0.0015 });
  M.side([[0.047, 0.012, 0.002], [0.118, 0.012, 0.002], [0.118, 0.001, 0.003], [0.047, 0.001, 0.003]], 0.034, 'poly', 0.8, { bevel: 0.0015 });
  M.flush();
  return finish(C, rifleUD(Object.assign({
    id, muzzle: anchor('muzzle', P.bl + (P.brake ? 0.035 : 0), BV), eject: anchor('eject', 0.05, BV + 0.006, 0.02), leftHand: anchor('leftHand', P.hg.u, P.hg.y),
    mag: M.group, bolt: B.group, scope: true, gripAngle: (P.ga ?? 14) * D2R, handguard: P.hg,
    boltTravel: 0.085, charge: 'bolt', boltKnob: new THREE.Vector3(0.045, BV - 0.016, 0.021), boreY: BV, boltLift: 1.0, sightHeight: P.scope[2],
  }, P.ud || {})));
}
function buildSSG(lod, id) {
  return boltRifle(lod, id, {
    bv: 0.070, bl: 0.62, stockMat: 'polyGry', brake: false, ga: 14,
    stock: [[0.40, 0.050, 0.008], [0.40, 0.068, 0.006], [0.08, 0.068, 0.003], [0.06, 0.056, 0.002], [-0.060, 0.056, 0.004], [-0.090, 0.072, 0.012], [-0.390, 0.066, 0.008], [-0.396, 0.054, 0.004],
      [-0.398, -0.060, 0.006], [-0.375, -0.064, 0.01], [-0.220, -0.020, 0.02], [-0.060, 0.010, 0.02], [-0.040, -0.075, 0.012], [-0.010, -0.075, 0.008], [0.020, 0.025, 0.006], [0.200, 0.030, 0.012], [0.380, 0.038, 0.012]],
    holes: [[[-0.075, 0.040, 0.006], [-0.240, 0.040, 0.012], [-0.200, 0.020, 0.012], [-0.075, 0.014, 0.01]]],
    wfn: (u, v) => (u > 0.06 ? 0.85 : 1.0),
    scope: [-0.120, 0.215, 0.115], scopeO: { r: 0.0135, re: 0.019, ro: 0.024, rings: [-0.02, 0.12] },
    hg: { w: 0.040, h: 0.040, y: 0.050, u: 0.25 }, ud: { gripBox: { c: [0, -0.025, 0.04], half: [0.0165, 0.055, 0.02], r: 0.011 }, gripR: { contact: [0.0145, -0.017, -0.012] } },
  });
}
function semiSniper(lod, id, P) {
  const C = mk(id, lod), q = C.q, hi = C.hi, BV = 0.080;
  const recM = P.recMat;
  C.side([[-0.130, 0.036, 0.004], [0.190, 0.036, 0.004], [0.190, 0.100, 0.004], [-0.125, 0.100, 0.006], [-0.135, 0.085, 0.006]], 0.040, recM, 0.3, { bevel: 0.0025 });
  rail(C, -0.12, 0.18, BV, 0.0205, 0, 'park');
  const k = (u, w, h) => ({ z: -u, w, h, y: BV - 0.006, rt: 0.012, rb: 0.018 });
  C.loft([k(0.19, 0.046, 0.058), k(0.196, 0.052, 0.062), k(0.42, 0.052, 0.062), k(0.426, 0.046, 0.056)], P.hgMat, 0.55, { smooth: false });
  if (hi) for (let i = 0; i < 8; i++) for (const s of [1, -1]) C.box(0.003, 0.012, 0.018, 0.004, 'dark', 0, { p: [s * 0.0265, BV - 0.004, -(0.21 + i * 0.026)] });
  C.lathe([[0.0105, 0.19, 0], [0.0105, 0.42, -1], [0.0095, 0.62, 0.001], [0.005, 0.62, 0]], 'park', 0.3, { tf: { p: [0, BV, 0] } });
  P.muzzleFn(C, BV);
  trigGroup(C, 0.006, 0.084, 0.037, 0.002, 0.012, recM);
  gripLoft(C, 'polyStip', 17 * D2R, -0.068, 0.040, 0.030, 0.042, { swell: 0.05, grooves: P.grooves || 0 });
  P.stockFn(C, BV);
  scope(C, -0.110, 0.230, BV + 0.050, { r: 0.0145, re: 0.020, ro: 0.026, rings: [-0.01, 0.13] });
  const B = C.sub('bolt', [0, 0.09, -0.1]);
  boltKnob(B, P.knobU ?? 0.10, 0.086, P.knobSide * 0.021, P.knobSide);
  B.flush();
  const M = C.sub('mag', [0, 0.04, -0.13]);
  stdMagGrip(C, M, 0.085, 0.142, 0.040, P.magLen ?? 0.12, 0.004, 0.028, 'park');
  M.flush();
  return finish(C, rifleUD({
    id, muzzle: anchor('muzzle', P.muzU, BV), eject: anchor('eject', 0.05, 0.085, 0.022), leftHand: anchor('leftHand', 0.29, BV - 0.006),
    mag: M.group, bolt: B.group, scope: true, gripAngle: 17 * D2R, handguard: { w: 0.052, h: 0.062, y: BV - 0.006, u: 0.29 },
    boltTravel: 0.07, charge: 'side', chargePt: new THREE.Vector3(P.knobSide * 0.034, 0.086, -(P.knobU ?? 0.10)), magDrop: 'straight', sightHeight: BV + 0.05,
  }));
}
function buildG3(lod, id) {
  return semiSniper(lod, id, { recMat: 'park', hgMat: 'polyStip', knobSide: -1, knobU: 0.30, muzU: 0.66, grooves: 3,
    muzzleFn: (C, BV) => { C.lathe([[0.005, 0.60, 0], [0.012, 0.60, 0.0008], [0.012, 0.66, 0.001], [0.006, 0.66, 0]], 'park', 0.5, { tf: { p: [0, BV, 0] }, closed: true }); },
    stockFn: (C, BV) => {
      const sp = [[-0.130, 0.096, 0.006], [-0.400, 0.092, 0.006], [-0.408, 0.080, 0.004], [-0.408, -0.055, 0.006], [-0.385, -0.058, 0.01], [-0.250, -0.005, 0.02], [-0.150, 0.030, 0.012], [-0.130, 0.040, 0.004]];
      C.side(sp, 0.042, 'poly', 0.35, { bevel: 0.006, bseg: C.hi ? 3 : 1, holes: C.hi ? [[[-0.170, 0.075, 0.008], [-0.330, 0.072, 0.01], [-0.330, 0.020, 0.01], [-0.200, 0.040, 0.01]]] : [] });
      if (C.hi) C.side([[-0.180, 0.096, 0.006], [-0.330, 0.094, 0.006], [-0.330, 0.112, 0.006], [-0.190, 0.112, 0.006]], 0.036, 'poly', 0.5, { bevel: 0.005 });
    } });
}
function buildSCAR(lod, id) {
  return semiSniper(lod, id, { recMat: 'anodTan', hgMat: 'anodTan', knobSide: -1, muzU: 0.66, knobU: 0.16,
    muzzleFn: (C, BV) => { C.lathe([[0.005, 0.61, 0], [0.0125, 0.61, 0.0008], [0.0125, 0.66, 0.001], [0.006, 0.66, 0]], 'park', 0.5, { tf: { p: [0, BV, 0] }, closed: true }); if (C.hi) for (let i = 0; i < 4; i++) for (const s of [1, -1]) C.box(0.010, 0.005, 0.007, 0.0012, 'dark', 0, { p: [s * 0.0095, BV, -(0.62 + i * 0.01)] }); },
    stockFn: (C, BV) => {
      C.side([[-0.130, 0.096, 0.006], [-0.390, 0.094, 0.006], [-0.398, 0.080, 0.004], [-0.398, -0.040, 0.006], [-0.380, -0.044, 0.01], [-0.300, 0.000, 0.02], [-0.200, 0.040, 0.012], [-0.130, 0.050, 0.004]], 0.040, 'polyTan', 0.35,
        { bevel: 0.006, bseg: C.hi ? 3 : 1, holes: C.hi ? [[[-0.170, 0.082, 0.008], [-0.320, 0.080, 0.01], [-0.320, 0.010, 0.01], [-0.220, 0.050, 0.01]]] : [] });
      if (C.hi) C.side([[-0.400, 0.096, 0.004], [-0.392, 0.096, 0.002], [-0.392, -0.042, 0.002], [-0.400, -0.042, 0.004]], 0.044, 'rubber', 0.6, { bevel: 0.003 });
    } });
}

// ============================================================================================
// Knives  (origin at the handle centre, blade toward -Z, edge down)
// ============================================================================================
// ---------------------------------------------------------------------------------------------
// True blade generator. Blade runs along u (forward = -Z), edge down (-Y), thickness along X.
// Cross-section per station: [edge apex] -microbevel- [bevel top] -primary grind (flat V)- [grind line]
// -flat- [spine shoulder] -rounded spine-. Each facet is its own strip so the grind line is a crisp crease.
// spec: { u0, u1, edge(u), spine(u), grind(u) (v of grind line), thick(u) (full spine thickness),
//         bevel (microbevel height), stations: [u...] (sorted), mats: { bevel, grind, flat, spine }, wear: {...} }
function bladeGeo(spec) {
  const us = spec.stations;
  const N = us.length;
  const secs = us.map((u, i) => {
    let ve = spec.edge(u), vs = spec.spine(u);
    if (i === N - 1) { const vt = (ve + vs) / 2; return { u, tip: true, ve: vt, vs: vt }; }
    const tot = Math.max(1e-5, vs - ve);
    const h = Math.max(0.00012, spec.thick(u) / 2 * Math.min(1, tot / 0.010));
    const vb = ve + Math.min(spec.bevel, tot * 0.14);
    const eb = Math.min(h * 0.55, 0.00028 + 0.00010 * Math.min(1, tot / 0.01));
    let vg = Math.min(spec.grind(u), ve + tot * 0.82); vg = Math.max(vg, vb + tot * 0.12);
    const rs = Math.min(h * 0.9, tot * 0.06, 0.0011);
    return { u, ve, vs, h, vb, eb, vg, rs };
  });
  const tip = secs[N - 1];
  const P = (x, v, u) => new THREE.Vector3(x, v, -u);
  // rows (cross-section samples) for a strip, as functions of a section -> list of [x, v]
  const strips = {
    bevel: (S, s) => [[0, S.ve], [s * S.eb, S.vb]],
    grind: (S, s) => [[s * S.eb, S.vb], [s * lerp(S.eb, S.h, 0.5), lerp(S.vb, S.vg, 0.5)], [s * S.h, S.vg]],
    flat: (S, s) => [[s * S.h, S.vg], [s * S.h, S.vs - S.rs]],
    spine: (S) => { const o = []; for (let k = 0; k <= 4; k++) { const a = Math.PI * k / 4; o.push([S.h * Math.cos(a), S.vs - S.rs + S.rs * Math.sin(a) * 1.0 + (k > 0 && k < 4 ? 0 : 0)]); } return o; },
  };
  const out = {};
  const build = (name, side) => {
    const rows = [];
    for (const S of secs) {
      if (S.tip) { const n = name === 'spine' ? 5 : name === 'grind' ? 3 : 2; rows.push(new Array(n).fill(0).map(() => P(0, S.ve, S.u))); continue; }
      rows.push(strips[name](S, side).map(([x, v]) => P(x, v, S.u)));
    }
    const M = rows[0].length;
    const pos = [], idx = [];
    for (const r of rows) for (const p of r) pos.push(p.x, p.y, p.z);
    for (let i = 0; i < N - 1; i++) for (let j = 0; j < M - 1; j++) {
      const a = i * M + j, b = i * M + j + 1, c = (i + 1) * M + j + 1, d = (i + 1) * M + j;
      idx.push(a, b, c, a, c, d);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    g.computeVertexNormals();
    // orient outward: side strips -> sign(x) == side ; spine -> +y
    const n = g.attributes.normal; let acc = 0;
    for (let i = 0; i < n.count; i++) acc += name === 'spine' ? n.getY(i) : n.getX(i) * side;
    if (acc < 0) { const ia = g.index.array; for (let i = 0; i < ia.length; i += 3) { const t = ia[i + 1]; ia[i + 1] = ia[i + 2]; ia[i + 2] = t; } g.computeVertexNormals(); }
    return g;
  };
  for (const name of ['bevel', 'grind', 'flat']) out[name] = mergeGeometries([build(name, 1), build(name, -1)], false);
  out.spine = build('spine', 1);
  // rear cap (hidden in guard, but keep it closed)
  {
    const S = secs[0], pts = [[0, S.ve], [S.eb, S.vb], [S.h, S.vg], [S.h, S.vs - S.rs], [0, S.vs], [-S.h, S.vs - S.rs], [-S.h, S.vg], [-S.eb, S.vb]];
    const pos = [0, (S.ve + S.vs) / 2, -S.u]; for (const [x, v] of pts) pos.push(x, v, -S.u);
    const idx = []; for (let i = 0; i < pts.length; i++) idx.push(0, 1 + (i + 1) % pts.length, 1 + i);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    out.cap = g;
  }
  return out;
}
function bladeStations(u0, u1, n, extra = []) {
  const s = new Set();
  for (let i = 0; i <= n; i++) { const t = i / n; s.add(u0 + (u1 - u0) * (1 - Math.pow(1 - t, 1.35))); }
  for (const e of extra) if (e > u0 && e < u1) s.add(e);
  return [...s].sort((a, b) => a - b);
}
// smooth step helpers for blade outlines
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function buildKnifeT(lod, id) {
  // T default: clip-point combat/bayonet knife, black-coated blade worn to bright steel at edge and tip,
  // paracord-wrapped grip, steel crossguard and pommel.
  const C = mk(id, lod), q = C.q, hi = C.hi;
  const u0 = 0.046, uT = 0.218;
  const edge = (u) => { const b = clamp((u - 0.120) / (uT - 0.120), 0, 1); return -0.0158 + 0.0175 * Math.pow(b, 2.1) - 0.0012 * Math.sin(clamp((u - u0) / (0.14 - u0), 0, 1) * Math.PI) * 0.6; };
  const spine = (u) => { const c = clamp((u - 0.150) / (uT - 0.150), 0, 1); return 0.0118 - 0.0108 * (1 - Math.pow(1 - c, 1.0) * (1 - 0.25 * c))  + 0.0006 * sstep(u0, 0.07, u) * 0; };
  const grind = (u) => -0.0158 + 0.0128;      // high flat-sabre grind line ~3.4 mm below spine at the guard
  const thick = (u) => lerp(0.0048, 0.0016, Math.pow(clamp((u - u0) / (uT - u0), 0, 1), 1.4));
  const st = bladeStations(u0, uT, hi ? 46 : 12);
  const B = bladeGeo({ u0, u1: uT, edge, spine, grind, thick, bevel: hi ? 0.0013 : 0.0016, stations: st });
  const tipWear = (x, y, z) => 0.25 + 0.9 * sstep(0.17, uT, -z) + 0.4 * sstep(-0.004, -0.012, y);
  C.P.add(B.bevel, 'edgeSteel', 0.3);
  C.P.add(B.grind, 'bladeBlk', tipWear);
  C.P.add(B.flat, 'bladeBlk', (x, y, z) => 0.15 + 0.8 * sstep(0.18, uT, -z));
  C.P.add(B.spine, 'bladeBlk', (x, y, z) => 0.5 + 0.6 * sstep(0.16, uT, -z));
  C.P.add(B.cap, 'bladeBlk', 0.2);
  if (hi) {
    // swedge (false edge) on the clip: thin bright bevel along the spine near the tip
    const sw = bladeStations(0.152, uT - 0.004, 14);
    for (const s of [1, -1]) {
      const pos = [], idx = [];
      sw.forEach((u, i) => { const v = spine(u), h = thick(u) / 2 * Math.min(1, (v - edge(u)) / 0.01); pos.push(s * h * 0.98, v - 0.0006, -u, s * h * 0.35, v + 0.0001, -u); if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); } });
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      let acc = 0; const n = g.attributes.normal; for (let i = 0; i < n.count; i++) acc += n.getX(i) * s + n.getY(i);
      if (acc < 0) { const ia = g.index.array; for (let i = 0; i < ia.length; i += 3) { const t = ia[i + 1]; ia[i + 1] = ia[i + 2]; ia[i + 2] = t; } g.computeVertexNormals(); }
      C.P.add(g, 'edgeSteel', 0.4);
    }
    // fuller groove (dark recessed line in the flat)
    for (const s of [1, -1]) C.loft([{ z: -0.060, w: 0.0008, h: 0.0001, x: s * (thick(0.06) / 2), y: 0.0046, r: 0.00004 }, { z: -0.064, w: 0.0010, h: 0.0034, x: s * (thick(0.064) / 2), y: 0.0046, r: 0.0005 }, { z: -0.142, w: 0.0010, h: 0.0034, x: s * (thick(0.142) / 2 - 0.0002), y: 0.0046, r: 0.0005 }, { z: -0.150, w: 0.0008, h: 0.0001, x: s * (thick(0.15) / 2 - 0.0002), y: 0.0046, r: 0.00004 }], 'dark', 0, { steps: 1 });
    addMarking(C.root, ['M9-T  14'], 0.085, -0.0075, thick(0.085) / 2 + 0.00006, 1, 0.022, 0.0035, { opacity: 0.4 });
  }
  // ricasso block between blade and guard
  C.side([[0.036, -0.0150, 0.0006], [0.050, -0.0150, 0.0006], [0.050, 0.0118, 0.0006], [0.036, 0.0118, 0.0006]], 0.0052, 'bladeBlk', 0.4, { bevel: 0.0006 });
  // crossguard: steel plate with lower quillon curving forward
  C.front([[-0.0105, 0.0150, 0.002], [0.0105, 0.0150, 0.002], [0.0105, -0.0175, 0.002], [0.006, -0.032, 0.003], [-0.006, -0.032, 0.003], [-0.0105, -0.0175, 0.002]], 0.0055, 'park', 0.5, { tf: { p: [0, 0, -0.0335] }, bevel: 0.0011 });
  // grip: paracord wrap over a rubber core
  const g0 = -0.075, g1 = 0.031;
  const coreSec = (z, w, h) => ({ z: -z, w, h, y: -0.0015, r: Math.min(w, h) * 0.45 });
  C.loft([coreSec(g1, 0.020, 0.026), coreSec(g1 - 0.02, 0.022, 0.029), coreSec((g0 + g1) / 2, 0.023, 0.030), coreSec(g0 + 0.02, 0.022, 0.029), coreSec(g0, 0.021, 0.027)], 'rubber', 0.6, { steps: hi ? 2 : 1 });
  if (hi) {
    const n = 26;
    for (let i = 0; i < n; i++) {
      const z = lerp(g1 - 0.003, g0 + 0.003, i / (n - 1));
      const sw = 1 + 0.06 * Math.sin(Math.PI * (i / (n - 1)));
      const tg = new THREE.TorusGeometry(1, 0.11, 6, 22); tg.deleteAttribute('uv');
      tg.scale(0.0118 * sw, 0.0151 * sw, 0.0118); // ellipse ring, tube scaled with it
      tg.rotateX((i % 2 ? 1 : -1) * 0.20);
      tg.translate(0, -0.0015, -z);
      C.P.add(tg, 'cord', 0.5 + 0.3 * Math.random());
    }
  }
  // pommel: steel cap with lanyard hole and flat striking face
  C.lathe([[0, -0.098, 0], [0.0095, -0.098, 0.0025], [0.0128, -0.090, 0.002], [0.0122, -0.078, 0.0012], [0.0105, -0.074, 0.0006], [0, -0.074, 0]], 'park', 0.65, { tf: { p: [0, -0.0015, 0] }, seg: hi ? 22 : 8 });
  if (hi) {
    C.tor(0.0042, 0.0013, 'steel', 0.6, { p: [0, -0.0015, 0.101], r: [0, 90, 0] });
    C.cyl(0.0034, 0, 0.0232, 'dark', 0, { tf: { p: [-0.0116, -0.0015, 0.088], r: [0, 90, 0] }, seg: 12 });
  }
  return finish(C, {
    muzzle: anchor('muzzle', uT, 0.0), eject: null, leftHand: null, mag: null, bolt: null, hold: 'knife', gripAngle: 90 * D2R,
    gripBox: { c: [0, -0.0015, 0.020], half: [0.0115, 0.054, 0.0152], r: 0.008 }, gripR: { contact: [0.012, -0.010, 0.006], beta: -20, tilt: 4 }, charge: 'none',
  });
}
function buildKnifeCT(lod, id) {
  // CT default: satin drop-point tactical knife, partial serrations near the guard,
  // textured polymer grip with finger grooves, lanyard hole in the exposed tang.
  const C = mk(id, lod), q = C.q, hi = C.hi;
  const u0 = 0.044, uT = 0.214;
  const s0 = 0.058, s1 = 0.098, nT = 6, pT = (s1 - s0) / nT;
  const scallop = (u) => {
    if (u <= s0 || u >= s1) return 0;
    const f = ((u - s0) / pT) % 1; const k = (f - 0.5) * 2;
    return 0.0028 * Math.sqrt(Math.max(0, 1 - k * k)) * (hi ? 1 : 0.6);
  };
  const edge = (u) => { const b = clamp((u - 0.120) / (uT - 0.120), 0, 1); return -0.0162 + 0.0165 * Math.pow(b, 2.2) + scallop(u); };
  const spine = (u) => { const c = clamp((u - 0.130) / (uT - 0.130), 0, 1); return 0.0125 - 0.0130 * Math.pow(c, 1.7); };
  const grind = (u) => -0.0162 + 0.0105;      // saber grind
  const thick = (u) => lerp(0.0045, 0.0014, Math.pow(clamp((u - u0) / (uT - u0), 0, 1), 1.5));
  const extra = []; if (hi) for (let i = 0; i <= nT * 8; i++) extra.push(s0 + (s1 - s0) * i / (nT * 8));
  const st = bladeStations(u0, uT, hi ? 46 : 12, extra);
  const B = bladeGeo({ u0, u1: uT, edge, spine, grind, thick, bevel: 0.0013, stations: st });
  C.P.add(B.bevel, 'edgeSteel', 0.3);
  C.P.add(B.grind, 'satin', (x, y, z) => 0.2 + 0.5 * sstep(0.17, uT, -z));
  C.P.add(B.flat, 'stonewash', 0.2);
  C.P.add(B.spine, 'stonewash', 0.5);
  C.P.add(B.cap, 'stonewash', 0.2);
  if (hi) {
    // jimping on the spine above the guard
    for (let i = 0; i < 7; i++) C.box(0.0040, 0.0010, 0.0012, 0.0003, 'stonewash', 0.6, { p: [0, 0.0124, -(0.050 + i * 0.0030)] });
    addMarking(C.root, ['TAC-7  S30V'], 0.120, 0.004, thick(0.12) / 2 + 0.00006, 1, 0.022, 0.0034, { opacity: 0.45, color: 0x505050, metal: 0.6 });
  }
  // integral guard (steel) and full-tang handle
  C.side([[0.034, 0.0135, 0.0008], [0.046, 0.0135, 0.0008], [0.046, -0.0168, 0.0008], [0.043, -0.0245, 0.002], [0.036, -0.0245, 0.002], [0.034, -0.0168, 0.0008]], 0.0078, 'stonewash', 0.5, { bevel: 0.0011 });
  const fg = (u, v) => [u, v, -1];
  const hp = [[0.034, 0.0128, 0.003], [-0.020, 0.0138, -1], [-0.060, 0.0128, -1], [-0.078, 0.0100, 0.006], [-0.082, -0.002, 0.004], [-0.076, -0.0150, 0.004],
    ...bez3([-0.068, -0.0150], [-0.055, -0.0165], [-0.046, -0.0225], [-0.036, -0.0195], hi ? 6 : 2),
    ...bez3([-0.034, -0.0195], [-0.024, -0.0150], [-0.016, -0.0235], [-0.006, -0.0205], hi ? 6 : 2),
    ...bez3([-0.004, -0.0200], [0.006, -0.0160], [0.014, -0.0245], [0.024, -0.0205], hi ? 6 : 2), [0.034, -0.0160, 0.003]];
  C.side(hp, 0.0225, 'polyStip', (x, y, z) => 0.45 + 0.35 * Math.max(0, Math.min(1, (z - 0.0) / 0.06)), { bevel: hi ? 0.006 : 0.004, bseg: hi ? 3 : 1, r: 0.002 });
  if (hi) {
    // steel liner line between the scales, screws
    C.side([[0.033, 0.0136, 0], [-0.060, 0.0136, 0], [-0.060, 0.0141, 0], [0.033, 0.0141, 0]], 0.0042, 'stonewash', 0.6, { bevel: 0.0002 });
    for (const z of [-0.022, 0.018, 0.058]) for (const sx of [1, -1]) C.screw(-z, -0.001, sx * 0.0113, sx, 0.0028, 'steel');
  }
  // exposed tang at the butt with lanyard hole
  C.side([[-0.078, 0.0085, 0.002], [-0.096, 0.0070, 0.006], [-0.098, -0.0100, 0.006], [-0.078, -0.0125, 0.002]], 0.0045, 'stonewash', 0.7, { bevel: 0.0008, holes: [[[-0.0905, 0.0030, 0.002], [-0.0855, 0.0030, 0.002], [-0.0855, -0.0055, 0.002], [-0.0905, -0.0055, 0.002]]] });
  if (hi) C.tube([[0, -0.001, 0.088], [0.0, -0.006, 0.098], [0.003, -0.020, 0.103], [-0.002, -0.034, 0.100]], 0.0014, 'cord', 0.6);
  return finish(C, {
    muzzle: anchor('muzzle', uT, 0.0), eject: null, leftHand: null, mag: null, bolt: null, hold: 'knife', gripAngle: 90 * D2R,
    gripBox: { c: [0, -0.003, 0.022], half: [0.0112, 0.056, 0.0150], r: 0.008 }, gripR: { contact: [0.012, -0.010, 0.000], beta: -20, tilt: 4 }, charge: 'none',
  });
}

// ============================================================================================
// Grenades (origin at body centre, +Y up)
// ============================================================================================
function fuze(C, top, r = 0.0105, opts = {}) {
  const q = C.q, hi = C.hi;
  // fuze body
  C.lathe([[0, top - 0.004, 0], [r, top - 0.004, 0.001], [r, top + 0.012, 0.0015], [r * 0.75, top + 0.020, 0.002], [0, top + 0.020, 0]], 'paintGry', 0.5, { axis: 'y', seg: 20 });
  // spoon (lever) down the side (+X)
  const sp = [[top + 0.018, 0.0, 0], [top + 0.012, r + 0.002, -1], [top - 0.010, opts.bodyR + 0.003, -1], [top - 0.060, opts.bodyR + 0.002, -1], [top - 0.075, opts.bodyR - 0.004, 0]];
  const pts = [];
  for (const p of sp) pts.push([p[1], p[0]]);
  const prof = []; pts.forEach((p) => prof.push([p[0] + 0.0012, p[1], -1])); pts.slice().reverse().forEach((p) => prof.push([p[0] - 0.0004, p[1], -1]));
  sharpEnds(prof, 0.0005); prof[pts.length - 1][2] = 0.0005; prof[pts.length][2] = 0.0005;
  // spoon profile in the XY plane extruded along Z
  const g = extrudeZ(prof, 0.012, { q, bevel: 0.0005, r: 0 });
  const S = opts.sub ? opts.sub : C;
  C.P.add(g, opts.spoonMat || 'paintGry', 0.7);
  // pin + ring (separate part)
  const PIN = C.sub('pin', [-0.0, top + 0.008, 0]);
  PIN.cyl(0.0012, -0.014, 0.014, 'steel', 0.6, { tf: { p: [0, top + 0.008, 0], r: [0, 90, 0] }, seg: 8 });
  PIN.tor(0.0105, 0.0016, 'steel', 0.6, { p: [-0.026, top + 0.010, 0], r: [0, 0, 0] }, { segMul: 0.9 });
  PIN.flush();
  return PIN;
}
function grenadeUD(C, r, h, top, extra = {}) {
  return Object.assign({ muzzle: anchor('muzzle', 0, top), eject: null, leftHand: null, mag: null, bolt: null, hold: 'grenade', gripAngle: 0,
    gripBox: { c: [0, 0, 0], half: [r, h / 2, r], r: r * 0.9 }, gripR: { contact: [r * 0.9, -r * 0.35, -0.004], beta: -22, tilt: 6 },
    parts: { pin: C.root.getObjectByName('pin') }, ringPt: new THREE.Vector3(-0.026, top + 0.010, 0), charge: 'none' }, extra);
}
function buildHE(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi;
  const R = 0.032;
  const pr = []; for (let i = 0; i <= 14; i++) { const a = -90 + 180 * i / 14; pr.push([R * Math.cos(a * D2R) * (a > 40 ? 0.92 : 1), R * Math.sin(a * D2R) * 1.08, -1]); }
  pr[0][0] = 0; pr.push([0.011, R * 1.06, 0]); pr.push([0, R * 1.06, 0]);
  C.lathe(pr, 'paintGrn', (x, y, z) => 0.3 + (y > 0 ? 0.2 : 0.4), { axis: 'y', segMul: 1.2 });
  if (hi) {
    // seam band + yellow ID band + bottom marking
    C.tor(R * 1.0, 0.0011, 'paintGrn', 0.6, { p: [0, -0.002, 0], r: [90, 0, 0] });
    C.lathe([[R * 0.985, 0.012, 0], [R * 0.995, 0.012, -1], [R * 0.985, 0.017, 0]], 'paintYel', 0.6, { axis: 'y', segMul: 1.2 });
    addMarking(C.root, ['GREN HAND FRAG', 'LOT 44-7'], 0, -0.008, R + 0.0006, 1, 0.026, 0.010, { opacity: 0.7, color: 0xd8d0a0, metal: 0, rough: 0.6, ph: 96 });
  }
  fuze(C, R * 1.02, 0.0105, { bodyR: R });
  return finish(C, grenadeUD(C, R, 0.07, R * 1.02 + 0.02));
}
function canGrenade(lod, id, o) {
  const C = mk(id, lod), q = C.q, hi = C.hi;
  const R = o.r, H = o.h;
  C.lathe([[0, -H / 2, 0], [R - 0.003, -H / 2, 0.002], [R, -H / 2 + 0.004, 0.002], [R, H / 2 - 0.006, 0.002], [R * 0.9, H / 2, 0.003], [0.012, H / 2, 0], [0, H / 2, 0]], o.mat, (x, y, z) => 0.3 + (Math.abs(y) > H * 0.4 ? 0.4 : 0), { axis: 'y', segMul: 1.15 });
  if (hi) {
    if (o.bands) for (const [y, m] of o.bands) C.lathe([[R + 0.0004, y - 0.004, 0], [R + 0.0007, y, -1], [R + 0.0004, y + 0.004, 0]], m, 0.6, { axis: 'y', segMul: 1.15 });
    if (o.holes) for (let i = 0; i < o.holes[0]; i++) for (let j = 0; j < o.holes[1]; j++) { const a = (j / o.holes[1]) * Math.PI * 2 + (i % 2) * 0.3; const g = cyl(0.0035, 0, 0.0008, { q, seg: 10 }); g.rotateY(Math.PI / 2); g.translate(R - 0.0006, -H * 0.3 + i * (H * 0.6 / (o.holes[0] - 1)), 0); g.rotateY(a); C.P.add(g, 'dark', 0); }
    if (o.ribs) for (let i = 0; i < o.ribs; i++) C.lathe([[R, -H * 0.35 + i * H * 0.7 / (o.ribs - 1) - 0.002, 0], [R + 0.0012, -H * 0.35 + i * H * 0.7 / (o.ribs - 1), -1], [R, -H * 0.35 + i * H * 0.7 / (o.ribs - 1) + 0.002, 0]], o.mat, 0.6, { axis: 'y', segMul: 1.15 });
    if (o.label) addMarking(C.root, o.label, 0, 0.0, R + 0.0006, 1, R * 1.2, 0.024, { opacity: 0.8, color: o.labelCol ?? 0xe0d8c0, metal: 0, rough: 0.6, ph: 128, rot: 0 });
  }
  fuze(C, H / 2, 0.0105, { bodyR: R });
  return finish(C, grenadeUD(C, R, H, H / 2 + 0.02, o.ud || {}));
}
function buildFlash(lod, id) { return canGrenade(lod, id, { r: 0.0205, h: 0.110, mat: 'paintGry', holes: [5, 8], bands: [[0.040, 'paintWht']], label: ['FLASH', 'BANG'] }); }
function buildSmoke(lod, id) { return canGrenade(lod, id, { r: 0.031, h: 0.120, mat: 'paintGry', bands: [[0.047, 'paintGrn'], [-0.047, 'paintGrn']], label: ['SMOKE', 'GREY  N-17'], ribs: 0 }); }
function buildInc(lod, id) { return canGrenade(lod, id, { r: 0.029, h: 0.112, mat: 'paintGry', bands: [[0.040, 'paintRed'], [-0.040, 'paintRed']], label: ['INCEND', 'TH3  AN-14'], labelCol: 0xd04030 }); }
function buildDecoy(lod, id) { return canGrenade(lod, id, { r: 0.027, h: 0.088, mat: 'paintBlk', holes: [3, 10], bands: [[0.030, 'paintYel']], label: ['DECOY'], ribs: 3 }); }
function buildMolotov(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi;
  // glass bottle (transparent) with liquid, rag stuffed in the neck, flame
  const prof = [[0.0, -0.085, 0], [0.031, -0.085, 0.004], [0.034, -0.078, 0.006], [0.034, 0.030, 0.006], [0.030, 0.052, -1], [0.016, 0.075, -1], [0.0125, 0.095, -1], [0.0125, 0.135, 0.001], [0.0145, 0.138, 0.001], [0.0145, 0.146, 0.001], [0.0, 0.146, 0]];
  C.lathe(prof, 'glassBottle', 0.3, { axis: 'y', segMul: 1.2 });
  C.lathe([[0.0, -0.082, 0], [0.0315, -0.082, 0.004], [0.0315, 0.010, 0.002], [0.0, 0.010, 0]], 'liquid', 0, { axis: 'y', segMul: 1.0 });
  // rag: crumpled cloth tube + strips
  C.tube([[0, 0.12, 0], [0.002, 0.15, 0.002], [0.010, 0.170, 0.004], [0.020, 0.172, 0.008], [0.026, 0.160, 0.006]], 0.0105, 'rag', 0.8, { rseg: 8 });
  C.tube([[0.005, 0.15, 0], [0.018, 0.158, -0.012], [0.022, 0.140, -0.020], [0.020, 0.120, -0.026]], 0.004, 'rag', 0.9, { rseg: 6 });
  if (hi) C.tube([[0.031, 0.040, 0], [0.034, 0.050, 0.01], [0.030, 0.020, 0.02]], 0.003, 'tape', 0.6, { rseg: 5 });
  C.flush();
  // flame (emissive, flickered by the viewmodel)
  const fl = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.05, 10, 1, true), MAT.flame); fl.position.set(0.012, 0.19, 0.004); fl.name = 'flame';
  const fl2 = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.035, 8, 1, true), MAT.flame); fl2.position.set(0.024, 0.18, 0.008); fl.add(fl2); fl2.position.sub(fl.position).add(new THREE.Vector3(0.012, 0.18, 0.004)).sub(new THREE.Vector3(0.012, 0.19, 0.004)); fl2.position.set(0.012, -0.01, 0.004);
  C.root.add(fl);
  const ud = grenadeUD(C, 0.034, 0.17, 0.17, { flame: fl, gripBox: { c: [0, -0.02, 0], half: [0.034, 0.07, 0.034], r: 0.03 }, gripR: { contact: [0.031, -0.012, -0.03], beta: -22, tilt: 6 }, ringPt: new THREE.Vector3(0.015, 0.16, 0) });
  ud.parts = {};
  return finish(C, ud);
}

// ============================================================================================
// C4 (origin at bundle centre; keypad on top facing +Y, operator side +Z)
// ============================================================================================
function buildC4(lod, id) {
  const C = mk(id, lod), q = C.q, hi = C.hi;
  const BX = 0.072, BY = 0.050, BZ = 0.150;
  // three explosive blocks in film wrappers
  for (let i = -1; i <= 1; i++) {
    C.box(BX - 0.002, BY, BZ, 0.006, 'c4Block', 0.4, { p: [i * BX, 0, 0] });
    if (hi) addMarking(C.root, ['CHARGE DEMOLITION', 'COMP. B-4  1.25 LB'], 0, 0, 0, 1, 0.07, 0.022, { opacity: 0.75, color: 0x303020, metal: 0, rough: 0.7, ph: 128 })
      .position.set(i * BX, -0.006, BZ / 2 + 0.0002), C.root.children[C.root.children.length - 1].rotation.set(0, 0, 0);
  }
  // tape bands around the bundle
  for (const z of [-0.045, 0.048]) C.loft([{ z: z - 0.012, w: BX * 3 + 0.003, h: BY + 0.003, r: 0.006 }, { z: z + 0.012, w: BX * 3 + 0.004, h: BY + 0.004, r: 0.006 }], 'tape', 0.6, { smooth: false });
  // control box with keypad and LCD on top
  const top = BY / 2;
  C.box(0.112, 0.024, 0.095, 0.004, 'polyGry', 0.5, { p: [0, top + 0.012, 0.004] });
  C.box(0.098, 0.004, 0.082, 0.0015, 'pcb', 0.3, { p: [0, top + 0.0255, 0.004] });
  const keys = [];
  // 3x4 keypad: digits layout 1 2 3 / 4 5 6 / 7 8 9 / * 0 #
  const kx = [-0.018, 0, 0.018], kz = [0.000, 0.016, 0.032, 0.048];
  const labels = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
  let n = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
    const p = new THREE.Vector3(kx[c] - 0.016, top + 0.0295, kz[r] - 0.004);
    C.box(0.013, 0.004, 0.011, 0.002, 'rubber', 0.5, { p: p.toArray() });
    if (hi) { const m = markingMesh([labels[n]], 0.008, 0.008, { opacity: 0.9, color: 0xd8d8d0, metal: 0, rough: 0.5, pw: 64, ph: 64, align: 'center' }); m.position.copy(p).add(new THREE.Vector3(0, 0.0021, 0)); m.rotation.x = -Math.PI / 2; C.root.add(m); }
    keys.push(p.clone().add(new THREE.Vector3(0, 0.002, 0)));
    n++;
  }
  // map digits 0..9 -> key positions
  const keyByDigit = [keys[10], keys[0], keys[1], keys[2], keys[3], keys[4], keys[5], keys[6], keys[7], keys[8]];
  // LCD (canvas) + bezel + LEDs
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64; const ctx = cv.getContext('2d');
  ctx.fillStyle = '#1b2a12'; ctx.fillRect(0, 0, 256, 64);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const lcdMat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.22, roughness: 0.15, metalness: 0 });
  const lcd = new THREE.Mesh(new THREE.PlaneGeometry(0.046, 0.0115), lcdMat); lcd.rotation.x = -Math.PI / 2; lcd.position.set(0.0, top + 0.0282, -0.030);
  C.root.add(lcd);
  C.box(0.052, 0.003, 0.017, 0.001, 'poly', 0.5, { p: [0, top + 0.0265, -0.030] });
  if (hi) {
    C.cyl(0.0025, 0, 0.002, 'ledRed', 0, { tf: { p: [0.040, top + 0.0275, 0.03], r: [-90, 0, 0] }, seg: 10 });
    C.cyl(0.0025, 0, 0.002, 'ledGreen', 0, { tf: { p: [0.040, top + 0.0275, 0.042], r: [-90, 0, 0] }, seg: 10 });
    // antenna stub + wires to the blocks
    C.cyl(0.0022, 0, 0.035, 'rubber', 0.5, { tf: { p: [0.050, top + 0.02, -0.040], r: [-90, 0, 0] }, seg: 8 });
    C.tube([[-0.05, top + 0.015, -0.045], [-0.07, top + 0.012, -0.06], [-0.085, top - 0.005, -0.07], [-0.09, 0.0, -0.075]], 0.0018, 'wireR', 0.4);
    C.tube([[-0.05, top + 0.010, -0.040], [-0.07, top + 0.020, -0.050], [-0.10, top + 0.005, -0.03], [-0.108, 0.010, 0.0]], 0.0018, 'wireB', 0.4);
    C.tube([[0.05, top + 0.012, 0.050], [0.075, top + 0.010, 0.062], [0.10, top - 0.004, 0.06], [0.109, -0.004, 0.03]], 0.0018, 'wireY', 0.4);
    C.tube([[0.05, top + 0.012, -0.040], [0.08, top + 0.006, -0.06], [0.105, top - 0.01, -0.07], [0.109, -0.01, -0.06]], 0.0018, 'wireK', 0.4);
    for (const s of [1, -1]) for (const z of [-0.040, 0.050]) C.screw(-z, top + 0.020, s * 0.056, s, 0.0022, 'steel');
  }
  return finish(C, {
    muzzle: anchor('muzzle', 0.08, 0), eject: null, leftHand: null, mag: null, bolt: null, hold: 'c4', charge: 'none', gripAngle: 0,
    handR: (() => { const X = new THREE.Vector3(0, 0, -1), Y = new THREE.Vector3(0, -1, 0.25).normalize(), Z = new THREE.Vector3().crossVectors(X, Y); Y.crossVectors(Z, X);
      const M = new THREE.Matrix4().makeBasis(X, Y, Z); const off = new THREE.Vector3(0.0, 0.05, 0.0165).applyMatrix4(new THREE.Matrix4().extractRotation(M)); return M.setPosition(new THREE.Vector3(0.114, 0.022, 0.015).sub(off)); })(),
    gripBox: { c: [0, 0, 0], half: [0.109, 0.026, 0.076], r: 0.006 }, thumbR: { opp: 0.3, cmc: 0 },
    keys: keyByDigit, lcd: { canvas: cv, ctx, tex, w: 256, h: 64 },
  });
}
// ============================================================================================
// Registry
// ============================================================================================
const BUILDERS = {
  ak47: buildAK47, m4a4: buildAR, m4a1_s: buildAR, awp: buildAWP,
  glock: buildPistol, usp_s: buildPistol, p2000: buildPistol, p250: buildPistol, fiveseven: buildPistol, cz75a: buildPistol,
  elite: buildElite, deagle: buildDeagle, revolver: buildRevolver, tec9: buildTec9, taser: buildTaser,
  mac10: buildMAC10, mp9: buildMP9, mp7: buildMP7, mp5sd: buildMP5, ump45: buildUMP, p90: buildP90, bizon: buildBizon,
  nova: buildNova, xm1014: buildXM, sawedoff: buildSawedoff, mag7: buildMag7, m249: buildM249, negev: buildNegev,
  galilar: buildGalil, famas: buildFamas, sg556: buildSG, aug: buildAUG, ssg08: buildSSG, g3sg1: buildG3, scar20: buildSCAR,
  knife_t: buildKnifeT, knife_ct: buildKnifeCT,
  hegrenade: buildHE, flashbang: buildFlash, smokegrenade: buildSmoke, molotov: buildMolotov, incgrenade: buildInc, decoy: buildDecoy,
  c4: buildC4,
};
function placeholder(lod, id) {
  const C = mk(id, lod);
  C.box(0.03, 0.06, 0.25, 0.004, 'park', 0.3, { p: [0, 0.05, -0.08] });
  C.box(0.025, 0.08, 0.03, 0.006, 'poly', 0.3, { p: [0, -0.01, 0.0] });
  return finish(C, { muzzle: anchor('muzzle', 0.21, 0.06), eject: anchor('eject', 0.0, 0.07, 0.02), leftHand: anchor('leftHand', 0.12, 0.05), hold: 'rifle', gripAngle: 15 * D2R });
}
function buildWeaponModel(id, lod) {
  if (!MAT.blued) { if (!TEX.noise) { for (const n of ['noise', 'scratch', 'wood', 'fabric']) loadTex(n); } buildMaterials(); }
  const f = BUILDERS[id] || placeholder;
  _minFillet = lod === 'low' ? 0.0035 : 0;
  let g;
  try { g = f(lod === 'low' ? 'low' : 'high', id); } finally { _minFillet = 0; }
  g.userData.id = id;
  g.userData.lod = lod;
  return g;
}
// Models are built once per (id, lod) and handed out as clones that share geometry and materials.
// (Building procedurally on every call leaked a few MB per bought / dropped weapon.)
const _templates = new Map();
// third-person (low LOD) models get their own material copies so world-lighting patches never touch the viewmodel's materials
const _worldMats = new Map();
function worldMaterial(m) {
  if (!m || !m.isMaterial) return m;
  let c = _worldMats.get(m.uuid);
  if (!c) {
    const ud = m.userData; m.userData = {};          // Material.clone deep-copies userData through JSON — avoid that
    c = m.clone(); m.userData = ud;
    c.userData = Object.assign({}, ud); delete c.userData.worldPatched; delete c.userData.__wp;
    if (m.onBeforeCompile) c.onBeforeCompile = m.onBeforeCompile;
    if (m.customProgramCacheKey) c.customProgramCacheKey = m.customProgramCacheKey;
    _worldMats.set(m.uuid, c);
  }
  return c;
}
function remapUD(v, map, depth = 0) {
  if (v == null || typeof v !== 'object' || depth > 4) return v;
  if (v.isObject3D) return map.get(v) || v;
  if (v.isVector3 || v.isQuaternion || v.isEuler || v.isMatrix4 || v.isColor) return v.clone();
  if (v.isMaterial || v.isTexture || v.isBufferGeometry) return v;
  if (Array.isArray(v)) return v.map(x => remapUD(x, map, depth + 1));
  if (Object.getPrototypeOf(v) !== Object.prototype) return v;
  const o = {}; for (const k of Object.keys(v)) o[k] = remapUD(v[k], map, depth + 1); return o;
}
function cloneModel(t) {
  // strip userData (Object3D.copy JSON-serialises it), clone the hierarchy, then remap node references
  const src = [], uds = [];
  t.traverse(o => { src.push(o); uds.push(o.userData); o.userData = {}; });
  const c = t.clone(true);
  src.forEach((o, i) => { o.userData = uds[i]; });
  const dst = []; c.traverse(o => dst.push(o));
  const map = new Map(); src.forEach((o, i) => map.set(o, dst[i]));
  dst.forEach((o, i) => { o.userData = remapUD(uds[i], map); });
  return c;
}
export function createWeaponModel(id, { lod = 'high', fresh = false } = {}) {
  lod = lod === 'low' ? 'low' : 'high';
  if (fresh) return buildWeaponModel(id, lod);
  const key = id + ':' + lod;
  let t = _templates.get(key);
  if (!t) {
    t = buildWeaponModel(id, lod);
    if (lod === 'low') t.traverse(o => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(worldMaterial) : worldMaterial(o.material); });
    _templates.set(key, t);
  }
  return cloneModel(t);
}
export function listWeaponIds() { return Object.keys(WEAPONS); }
