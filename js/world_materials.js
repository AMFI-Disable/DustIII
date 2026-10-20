// world_materials.js — PBR materials for the Dust2 world (MeshStandardMaterial + onBeforeCompile)
// Planar / box-uv / triplanar mapping with two height-blended layers, sand dust layer,
// large-scale color variation, baked AO volume + sky visibility, and the 2-tier sun shadow.
import * as THREE from 'three';

export const TEX_TILE = { plaster: 256, stone_blocks: 256, flagstone: 256, sand: 256, dirt: 256, cobble: 256, rock: 512, planks: 128, metal: 128, roof: 256 };

// blend modes
const BL_NONE = 0, BL_WALL = 1, BL_FLOOR = 2, BL_PATCH = 3, BL_SLOPE = 4;
// mode: 0 planar(world units), 1 uv (0..1), 2 triplanar
export const MATDEF = {
  wall:       { mode: 0, A: 'plaster', B: 'stone_blocks', blend: BL_WALL, p1: [0.60, 0.10, 0, 1], tint: [1.0, 0.985, 0.96], dust: [0, 0.55, 70], nrm: 1.0, side: 2 },
  wall2:      { mode: 0, A: 'plaster', B: 'stone_blocks', blend: BL_WALL, p1: [0.40, 0.12, 0, 1], tint: [1.03, 0.99, 0.93], dust: [0, 0.45, 60], nrm: 1.0, side: 2 },
  capwall:    { mode: 0, A: 'plaster', B: 'stone_blocks', blend: BL_WALL, p1: [0.62, 0.10, 0, 1], tint: [0.98, 0.96, 0.93], dust: [0, 0.0, 1], nrm: 1.0, side: 2 },
  ceiling:    { mode: 0, A: 'plaster', blend: BL_NONE, tint: [0.92, 0.88, 0.84], dust: [0, 0, 1], nrm: 1.0, side: 2 },
  ceil_wood:  { mode: 0, A: 'planks', blend: BL_NONE, tint: [0.66, 0.6, 0.55], dust: [0, 0, 1], nrm: 1.2, side: 2, Ascale: 1.25 },
  trim:       { mode: 0, A: 'stone_blocks', blend: BL_NONE, tint: [1.04, 1.0, 0.95], dust: [0.35, 0.3, 40], nrm: 1.1, side: 2 },
  floor_flag: { mode: 0, A: 'flagstone', B: 'sand', blend: BL_FLOOR, p1: [0.66, 0.16, 0.9, 1], tint: [1.0, 0.99, 0.97], dust: [0.25, 0, 1], nrm: 1.0 },
  floor_cob:  { mode: 0, A: 'cobble', B: 'sand', blend: BL_FLOOR, p1: [0.64, 0.16, 0.9, 1], tint: [1.0, 0.98, 0.95], dust: [0.25, 0, 1], nrm: 1.0 },
  floor_road: { mode: 0, A: 'sand', B: 'cobble', blend: BL_PATCH, p1: [0.50, 0.22, -0.9, 1], tint: [0.98, 0.96, 0.93], dust: [0.10, 0, 1], nrm: 1.0, Bdirt: 1 },
  floor_sand: { mode: 0, A: 'sand', B: 'dirt', blend: BL_PATCH, p1: [0.60, 0.25, -0.6, 1], tint: [1.0, 0.98, 0.95], dust: [0.0, 0, 1], nrm: 1.0 },
  terrain:    { mode: 0, A: 'sand', B: 'dirt', blend: BL_PATCH, p1: [0.70, 0.25, 0, 0.35], tint: [1.0, 0.97, 0.93], dust: [0, 0, 1], nrm: 0.8, Ascale: 2 },
  rock:       { mode: 2, A: 'rock', B: 'sand', blend: BL_SLOPE, p1: [0.62, 0.20, 0, 1], tint: [1.0, 0.97, 0.93], dust: [0.0, 0, 1], nrm: 1.0, side: 2 },
  planks:     { mode: 0, A: 'planks', blend: BL_NONE, tint: [1.0, 1.0, 1.0], dust: [0.4, 0.2, 30], nrm: 1.0, side: 2 },
  metal:      { mode: 0, A: 'metal', blend: BL_NONE, tint: [1.0, 1.0, 1.0], dust: [0.3, 0.0, 1], nrm: 1.0, side: 2 },
  roof:       { mode: 0, A: 'roof', B: 'sand', blend: BL_PATCH, p1: [0.52, 0.2, 0, 1], tint: [1.08, 0.99, 0.86], dust: [0.2, 0, 1], nrm: 1.0, side: 0 },
  crate:      { mode: 1, A: 'crate', blend: BL_NONE, tint: [1, 1, 1], dust: [0.45, 0.18, 22], nrm: 1.0 },
  crate2:     { mode: 1, A: 'crate2', blend: BL_NONE, tint: [1, 1, 1], dust: [0.45, 0.18, 22], nrm: 1.0 },
  door:       { mode: 1, A: 'door', blend: BL_NONE, tint: [1, 1, 1], dust: [0.0, 0.25, 28], nrm: 1.0, side: 2 },
};

// ---------------------------------------------------------------- procedural tileable noise (RGBA, 4 frequencies)
export function makeNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  let s = 1337;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const octave = (cells) => {
    const g = new Float32Array(cells * cells); for (let i = 0; i < g.length; i++) g[i] = rnd();
    return (x, y) => { // x,y in 0..1, tileable bicubic-ish (smoothstep) value noise
      const fx = x * cells, fy = y * cells; const ix = Math.floor(fx), iy = Math.floor(fy);
      const tx = fx - ix, ty = fy - iy; const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const G = (a, b) => g[((b % cells + cells) % cells) * cells + ((a % cells + cells) % cells)];
      const a = G(ix, iy) + (G(ix + 1, iy) - G(ix, iy)) * sx, b = G(ix, iy + 1) + (G(ix + 1, iy + 1) - G(ix, iy + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const chans = [[4, 8, 16, 32], [3, 6, 12, 24], [5, 10, 20, 40], [8, 16, 32, 64]].map(fr => fr.map(octave));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    for (let c = 0; c < 4; c++) {
      const o = chans[c]; let val = 0, amp = 0.5, tot = 0;
      for (let k = 0; k < 4; k++) { val += o[k](u, v) * amp; tot += amp; amp *= 0.5; }
      val /= tot; val = (val - 0.5) * 1.9 + 0.5; // expand contrast
      data[(y * size + x) * 4 + c] = Math.max(0, Math.min(255, val * 255));
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- texture sets
export class TextureBank {
  constructor(renderer, base = 'assets/tex/', onProgress) {
    this.loader = new THREE.TextureLoader(); this.base = base; this.sets = {}; this.pending = [];
    this.aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy()); this.onProgress = onProgress; this.done = 0; this.total = 0;
  }
  get(name) {
    if (this.sets[name]) return this.sets[name];
    const mk = (suffix, srgb) => {
      this.total++;
      const t = this.loader.load(this.base + name + '_' + suffix + '.jpg', () => { this.done++; this.onProgress && this.onProgress(this.done / this.total); });
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = this.aniso;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      this.pending.push(new Promise(res => { const chk = () => (t.image && t.image.complete !== false && t.image.width) ? res() : setTimeout(chk, 50); chk(); }));
      return t;
    };
    return (this.sets[name] = { alb: mk('albedo', true), nrm: mk('normal', false), orm: mk('orm', false) });
  }
  setAnisotropy(a) { for (const s of Object.values(this.sets)) for (const t of Object.values(s)) { t.anisotropy = a; t.needsUpdate = true; } }
  ready() { return Promise.all(this.pending); }
}

// ---------------------------------------------------------------- shader code
const VERT_PARS = /* glsl */`
attribute vec2 aUv; attribute vec4 aTan; attribute vec2 aAux;
varying vec3 vWP; varying vec3 vWN; varying vec4 vWT; varying vec2 vUv0; varying vec2 vAux;
`;
const VERT_MAIN = /* glsl */`
vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWN = normalize(mat3(modelMatrix) * objectNormal);
vWT = vec4(normalize(mat3(modelMatrix) * aTan.xyz), aTan.w);
vUv0 = aUv; vAux = aAux;
`;

const FRAG_PARS = /* glsl */`
varying vec3 vWP; varying vec3 vWN; varying vec4 vWT; varying vec2 vUv0; varying vec2 vAux;
uniform sampler2D tAalb; uniform sampler2D tAnrm; uniform sampler2D tAorm;
#ifdef LAYER_B
uniform sampler2D tBalb; uniform sampler2D tBnrm; uniform sampler2D tBorm;
#endif
uniform sampler2D tDust; uniform sampler2D tDustN;
uniform sampler2D tNoise;
uniform highp sampler3D tAO; uniform vec3 uAOMin; uniform vec3 uAOInv; uniform vec4 uAOK; // k: scale, bias, pow, directAO
uniform sampler2D tFloorH; uniform vec4 uFloorRect;  // x0, z0, 1/w, 1/h
uniform vec4 uP0;  // 1/tileA, 1/tileB, normalScale, roughMul
uniform vec4 uP1;  // blend: threshold, softness, aoInfluence, scale
uniform vec3 uP2;  // dust: floor amount, wall-base amount, wall-base height
uniform vec3 uTint;
uniform float uIndoor; uniform float uDebug; float hAboveDbg;
uniform vec3 uDustTint;
float mAO; float mSky; float mDirAO;

float nz(vec2 p, int c){ vec4 n = texture2D(tNoise, p); return c==0?n.r:(c==1?n.g:(c==2?n.b:n.a)); }
float heightBlend(float hA, float hB, float m, float depth){
  float a = hA + (1.0 - m) * 1.2; float b = hB + m * 1.2;
  float ma = max(a, b) - depth;
  float ba = max(a - ma, 0.0), bb = max(b - ma, 0.0);
  return bb / max(ba + bb, 1e-4);
}
float floorHeightAt(vec2 xz, float y){
  vec2 fuv = (xz - uFloorRect.xy) * uFloorRect.zw;
  vec2 h = texture2D(tFloorH, fuv).rg;   // lowest / highest floor
  return (h.g <= y + 6.0) ? h.g : h.r;
}
`;

// Main surface block: computes mAlb, mNw (world normal), mRgh, mAO, mSky
const FRAG_SURFACE = /* glsl */`
float fdir = gl_FrontFacing ? 1.0 : -1.0;
vec3 Ng = normalize(vWN) * fdir;
vec3 Tg = vWT.xyz - Ng * dot(Ng, vWT.xyz); Tg = length(Tg) > 1e-4 ? normalize(Tg) : vec3(1.0, 0.0, 0.0);
vec3 Bg = cross(Ng, Tg) * vWT.w * fdir;

vec3 mAlb; vec3 mNw; vec3 mOrm;
// --- AO volume
{
  vec3 ap = (vWP + Ng * (9.0 + 7.0 * max(0.0, -Ng.y)) - uAOMin) * uAOInv;
  vec2 av = texture(tAO, ap).rg;
  float a = clamp(av.r * uAOK.x + uAOK.y, 0.0, 1.0);
  mAO = pow(a, uAOK.z); mSky = av.g;
}
float hAbove = 1000.0;
hAboveDbg = vWP.y - floorHeightAt(vWP.xz + Ng.xz * 14.0, vWP.y);
#if BLEND_MODE == 1 || DUSTWALL
  hAbove = vWP.y - floorHeightAt(vWP.xz + Ng.xz * 14.0, vWP.y);
#endif

#if MODE == 2
  // ---------------- triplanar (world space, UDN normals) with height-weighted plane blend
  vec3 bw = pow(abs(Ng), vec3(6.0)); bw /= (bw.x + bw.y + bw.z);
  vec3 p = vWP * uP0.x;
  vec2 uvX = p.zy, uvY = p.xz + 0.31, uvZ = p.xy + 0.73;
  vec4 aX = texture2D(tAalb, uvX), aY = texture2D(tAalb, uvY), aZ = texture2D(tAalb, uvZ);
  vec3 oX = texture2D(tAorm, uvX).rgb, oY = texture2D(tAorm, uvY).rgb, oZ = texture2D(tAorm, uvZ).rgb;
  vec3 hw = bw * (vec3(oX.b, oY.b, oZ.b) + 0.25); hw = pow(hw, vec3(2.0)); hw /= (hw.x + hw.y + hw.z);
  vec3 tX = texture2D(tAnrm, uvX).xyz * 2.0 - 1.0, tY = texture2D(tAnrm, uvY).xyz * 2.0 - 1.0, tZ = texture2D(tAnrm, uvZ).xyz * 2.0 - 1.0;
  tX.xy *= uP0.z; tY.xy *= uP0.z; tZ.xy *= uP0.z;
  vec3 nX = vec3(0.0, tX.y, tX.x * sign(Ng.x));
  vec3 nY = vec3(tY.x, 0.0, tY.y * sign(Ng.y));
  vec3 nZ = vec3(tZ.x * sign(Ng.z), tZ.y, 0.0);
  mAlb = (aX * hw.x + aY * hw.y + aZ * hw.z).rgb;
  mOrm = oX * hw.x + oY * hw.y + oZ * hw.z;
  mNw = normalize(Ng + nX * hw.x + nY * hw.y + nZ * hw.z);
  #ifdef LAYER_B
  {
    vec2 uvB = vWP.xz * uP0.y;
    vec3 bA = texture2D(tBalb, uvB).rgb; vec3 bO = texture2D(tBorm, uvB).rgb; vec3 bN = texture2D(tBnrm, uvB).xyz * 2.0 - 1.0;
    float m = smoothstep(uP1.x - uP1.y, uP1.x + uP1.y, Ng.y + (nz(vWP.xz / 700.0, 0) - 0.5) * 0.5);
    float w = heightBlend(mOrm.b, bO.b, m, 0.25);
    mAlb = mix(mAlb, bA, w); mOrm = mix(mOrm, bO, w);
    vec3 nB = normalize(Ng + vec3(bN.x, 0.0, bN.y) * uP0.z * 0.8);
    mNw = normalize(mix(mNw, nB, w));
  }
  #endif
#else
  vec2 uvA = vUv0 * uP0.x;
  vec3 aA = texture2D(tAalb, uvA).rgb;
  vec3 oA = texture2D(tAorm, uvA).rgb;
  vec3 nA = texture2D(tAnrm, uvA).xyz * 2.0 - 1.0;
  mAlb = aA; mOrm = oA; vec3 nT = nA;
  #ifdef LAYER_B
  {
    vec2 uvB = vUv0 * uP0.y + vec2(0.37, 0.61);
    vec3 aB = texture2D(tBalb, uvB).rgb; vec3 oB = texture2D(tBorm, uvB).rgb; vec3 nB = texture2D(tBnrm, uvB).xyz * 2.0 - 1.0;
    float m = 0.0;
    vec2 q = vUv0 * uP1.w;
    #if BLEND_MODE == 1
      // walls: large patches where the plaster has fallen off + more exposure near the base
      float n1 = nz(q / 1500.0, 0), n2 = nz(q / 430.0 + 0.5, 1), n3 = nz(q / 140.0, 2);
      float base = (1.0 - smoothstep(0.0, 110.0, hAbove)) * 0.22;
      m = smoothstep(uP1.x - uP1.y, uP1.x + uP1.y, n1 * 0.62 + n2 * 0.28 + n3 * 0.10 + base);
    #elif BLEND_MODE == 2
      // floors: sand drifts into corners (low AO) and random patches
      float n1 = nz(vWP.xz / 1100.0, 1), n2 = nz(vWP.xz / 300.0, 2);
      float drift = (1.0 - mAO) * uP1.z;
      m = smoothstep(uP1.x - uP1.y, uP1.x + uP1.y, n1 * 0.65 + n2 * 0.35 + drift - 0.05);
    #elif BLEND_MODE == 3
      float n1 = nz(vWP.xz / 1300.0 + 0.2, 3), n2 = nz(vWP.xz / 260.0, 0);
      float drift = (1.0 - mAO) * uP1.z;
      m = smoothstep(uP1.x - uP1.y, uP1.x + uP1.y, n1 * 0.7 + n2 * 0.3 + drift);
    #endif
    float w = heightBlend(oA.b, oB.b, m, 0.22);
    mAlb = mix(aA, aB, w); mOrm = mix(oA, oB, w); nT = normalize(mix(nA, nB, w));
  }
  #endif
  nT.xy *= uP0.z;
  mNw = normalize(Tg * nT.x + Bg * nT.y + Ng * max(nT.z, 0.05));
#endif

// --- dust / sand accumulation layer
{
  float dust = 0.0;
  float up = smoothstep(0.55, 0.9, Ng.y);
  vec2 dq = (abs(Ng.y) > 0.6) ? vWP.xz : vUv0 * (MODE == 1 ? 0.0 : 1.0) + vWP.xz * (MODE == 1 ? 1.0 : 0.0);
  float dn = nz(vWP.xz / 520.0 + vWP.y / 900.0, 2);
  dust += up * uP2.x * clamp((1.0 - mAO) * 1.6 + (dn - 0.45) * 1.2 + (vAux.y > 0.5 ? 0.45 : 0.0), 0.0, 1.0);
  #if DUSTWALL
    float wb = 1.0 - smoothstep(0.0, uP2.z, hAbove + (dn - 0.5) * uP2.z * 0.9);
    dust += (1.0 - up) * uP2.y * wb;
  #endif
  dust = clamp(dust, 0.0, 0.92);
  if (dust > 0.001) {
    vec2 duv = (abs(Ng.y) > 0.6 ? vWP.xz : vec2(dot(vWP, Tg), vWP.y)) / 256.0;
    vec3 dA = texture2D(tDust, duv).rgb * uDustTint;
    float hb = heightBlend(1.0 - mOrm.b, 0.5, dust, 0.3);
    mAlb = mix(mAlb, dA, hb);
    mOrm.g = mix(mOrm.g, 0.95, hb);
    mNw = normalize(mix(mNw, Ng, hb * 0.75));
  }
}

// --- large-scale variation (breaks repetition)
{
  float v1 = nz(vWP.xz / 3400.0 + vWP.y / 5000.0, 1);
  float v2 = nz(vWP.xz / 900.0 + vec2(0.5, 0.2) + vWP.y / 1300.0, 3);
  vec3 warm = vec3(1.035, 0.995, 0.945), cool = vec3(0.965, 0.99, 1.03);
  mAlb *= uTint * mix(cool, warm, v1) * (0.9 + 0.2 * v2) * (0.95 + 0.1 * vAux.x);
}
diffuseColor.rgb *= mAlb;
mAO *= mix(1.0, mOrm.r, 0.9);
mDirAO = mix(1.0, mAO, uAOK.w);
`;

const LIGHTS_SUN_FUNCS = /* glsl */`
#ifdef USE_SHADOWMAP
#if NUM_DIR_LIGHT_SHADOWS > 1
float sunShadow0( sampler2D sm, vec2 size, float inten, float bias, float radius, vec4 coord ) {
  vec3 c = coord.xyz / coord.w;
  float edge = max(abs(c.x - 0.5), abs(c.y - 0.5)) * 2.0;
  float far = getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, inten, directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] );
  if ( edge > 0.97 || c.z > 1.0 ) return far;
  float near = getShadow( sm, size, inten, bias, radius, coord );
  return mix( near, min(near, far), smoothstep( 0.8, 0.97, edge ) );
}
#else
float sunShadow0( sampler2D sm, vec2 size, float inten, float bias, float radius, vec4 coord ) { return getShadow( sm, size, inten, bias, radius, coord ); }
#endif
float sunShadow1( sampler2D sm, vec2 size, float inten, float bias, float radius, vec4 coord ) { return 1.0; }
float sunShadow2( sampler2D sm, vec2 size, float inten, float bias, float radius, vec4 coord ) { return getShadow( sm, size, inten, bias, radius, coord ); }
float sunShadow3( sampler2D sm, vec2 size, float inten, float bias, float radius, vec4 coord ) { return getShadow( sm, size, inten, bias, radius, coord ); }
#endif
`;

let LIGHTS_BEGIN_PATCHED = null;
function patchedLightsBegin() {
  if (LIGHTS_BEGIN_PATCHED) return LIGHTS_BEGIN_PATCHED;
  let s = THREE.ShaderChunk.lights_fragment_begin;
  const needle = 'getShadow( directionalShadowMap[ i ]';
  if (!s.includes(needle)) console.warn('world: lights chunk layout changed');
  s = s.replace(needle, 'sunShadowUNROLLED_LOOP_INDEX( directionalShadowMap[ i ]');
  // contact darkening of direct light by the baked AO (subtle)
  s = s.replace(/RE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);/g,
    'directLight.color *= mDirAO; RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );');
  return (LIGHTS_BEGIN_PATCHED = s);
}

const AO_FRAG = /* glsl */`
{
  float skyF = mix(uIndoor, 1.0, smoothstep(0.0, 0.7, mSky));
  reflectedLight.indirectDiffuse *= mAO * skyF;
  float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
  reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, mAO, material.roughness ) * skyF;
  if (uDebug > 3.5) { if (uDebug < 4.5) { reflectedLight.indirectDiffuse = vec3(0.0); reflectedLight.indirectSpecular = vec3(0.0); } else { reflectedLight.directDiffuse = vec3(0.0); reflectedLight.directSpecular = vec3(0.0); } }
  else if (uDebug > 0.5) { reflectedLight.directDiffuse = vec3(0.0); reflectedLight.directSpecular = vec3(0.0); reflectedLight.indirectSpecular = vec3(0.0);
    reflectedLight.indirectDiffuse = (uDebug < 1.5 ? vec3(mAO) : (uDebug < 2.5 ? vec3(mSky) : vec3(fract(hAboveDbg / 64.0)))) / max(diffuseColor.rgb, vec3(0.01)); }
}
`;

// ---------------------------------------------------------------- material factory
export function createWorldMaterial(name, bank, shared) {
  const d = MATDEF[name];
  const A = bank.get(d.A), B = d.B ? bank.get(d.B) : null;
  const dust = bank.get('sand');
  const tileA = d.mode === 1 ? 1 : (TEX_TILE[d.A] || 256) * (d.Ascale || 1);
  const tileB = d.B ? (TEX_TILE[d.B] || 256) : 256;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0, metalness: 0.0, side: d.side === 2 ? THREE.DoubleSide : THREE.FrontSide });
  mat.shadowSide = THREE.DoubleSide;
  mat.name = 'world_' + name;
  const u = {
    tAalb: { value: A.alb }, tAnrm: { value: A.nrm }, tAorm: { value: A.orm },
    tBalb: { value: B ? B.alb : null }, tBnrm: { value: B ? B.nrm : null }, tBorm: { value: B ? B.orm : null },
    tDust: { value: dust.alb }, tDustN: { value: dust.nrm },
    uP0: { value: new THREE.Vector4(1 / tileA, 1 / tileB, d.nrm || 1, 1) },
    uP1: { value: new THREE.Vector4(...(d.p1 || [0.5, 0.2, 0, 1])) },
    uP2: { value: new THREE.Vector3(...(d.dust || [0, 0, 1])) },
    uTint: { value: new THREE.Vector3(...d.tint) },
  };
  mat.userData.uniforms = u;
  mat.customProgramCacheKey = () => 'world_' + name;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, shared);
    sh.defines = sh.defines || {};
    sh.defines.MODE = d.mode; sh.defines.BLEND_MODE = d.blend || 0;
    sh.defines.DUSTWALL = (d.dust && d.dust[1] > 0) ? 1 : 0;
    if (B) sh.defines.LAYER_B = '';
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + VERT_MAIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('void main() {', LIGHTS_SUN_FUNCS + '\nvoid main() {')
      .replace('#include <map_fragment>', FRAG_SURFACE)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(roughness * mOrm.g * uP0.w, 0.04, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize( ( viewMatrix * vec4( mNw, 0.0 ) ).xyz );')
      .replace('#include <lights_fragment_begin>', patchedLightsBegin())
      .replace('#include <aomap_fragment>', AO_FRAG);
  };
  return mat;
}

// Shared uniforms (AO volume, floor raster, noise) — values filled by world.js
export function createSharedUniforms() {
  return {
    tNoise: { value: null },
    tAO: { value: null }, uAOMin: { value: new THREE.Vector3() }, uAOInv: { value: new THREE.Vector3(1, 1, 1) },
    uAOK: { value: new THREE.Vector4(1.0, 0.0, 1.0, 0.0) },
    tFloorH: { value: null }, uFloorRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uIndoor: { value: 0.46 }, uDebug: { value: 0 },
    uDustTint: { value: new THREE.Vector3(1.0, 0.97, 0.92) },
  };
}

// Patch an external lit material (characters, props added by the engine) so that it
//  - uses the static far sun shadow beyond the near shadow cascade
//  - gets darker ambient indoors (tunnels) from the baked sky-visibility volume
export function patchExternalMaterial(mat, shared) {
  if (!mat || mat.userData.worldPatched || !(mat.isMeshStandardMaterial || mat.isMeshLambertMaterial || mat.isMeshPhongMaterial)) return;
  mat.userData.worldPatched = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (sh, r) {
    if (prev) prev.call(this, sh, r);
    sh.uniforms.tAO = shared.tAO; sh.uniforms.uAOMin = shared.uAOMin; sh.uniforms.uAOInv = shared.uAOInv; sh.uniforms.uIndoor = shared.uIndoor;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPx;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPx = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPx; uniform highp sampler3D tAO; uniform vec3 uAOMin; uniform vec3 uAOInv; uniform float uIndoor; float mDirAO = 1.0;')
      .replace('void main() {', LIGHTS_SUN_FUNCS + '\nvoid main() {')
      .replace('#include <lights_fragment_begin>', patchedLightsBegin())
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        { vec2 av = texture(tAO, (vWPx + vec3(0.0, 20.0, 0.0) - uAOMin) * uAOInv).rg;
          float k = mix(uIndoor, 1.0, smoothstep(0.0, 0.7, av.g)) * mix(1.0, av.r, 0.5);
          reflectedLight.indirectDiffuse *= k; reflectedLight.indirectSpecular *= k; }`);
  };
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : null;
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|worldpatch';
  mat.needsUpdate = true;
}
