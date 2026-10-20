// fx_particles.js — the single, globally depth-sorted particle renderer used by every FX effect.
//
// One InstancedBufferGeometry quad + one ShaderMaterial = ONE draw call for all smoke puffs, flames, sparks,
// muzzle flashes, tracers, dust, blood mist … Everything is sorted back-to-front together (radix sort, O(n)),
// so a muzzle flash behind a smoke cloud is correctly hidden by it and one in front of it is not.
//
// Blending is premultiplied (ONE, ONE_MINUS_SRC_ALPHA) with a per-particle "additive" factor, so lit alpha-blended
// smoke and emissive additive fire coexist in the same batch.
//
// Per-particle shading: lit particles get sun (wrap-lit pseudo-sphere normal + forward-scattering silver lining),
// hemisphere ambient, and up to 4 FX point lights (fire/explosions light up nearby smoke). Emissive colour is
// added on top. Soft particles: "spherical billboard" thickness test against the captured scene depth.
import * as THREE from 'three';

export const M_BILL = 0, M_AXIAL = 1, M_FLAT = 2, M_PIVOT = 3;
const STRIDE = 32;

const FIELDS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 's0', 's1', 'sPow', 'grav', 'drag', 'rot', 'rotV',
  'r', 'g', 'b', 'a', 'fadeIn', 'fadeOut', 'er', 'eg', 'eb', 'eDecay', 'add', 'cell', 'frames', 'fps', 'frame0',
  'mode', 'stretch', 'minLen', 'ax', 'ay', 'az', 'sunVis', 'ao', 'phase', 'hole', 'floorY', 'soft', 'buoy', 'turb',
  'bounceY', 'bounce', 'size', 'alpha', 'ctrl', 'grow', 'nearK', 'flip', 'aspect', 'dens'];

// Spawn description. Reuse one instance (fx._sp) — reset() then fill — to avoid per-spawn allocations.
export class PSpec {
  constructor() { this.reset(); }
  reset() {
    this.x = this.y = this.z = 0; this.vx = this.vy = this.vz = 0;
    this.age = 0; this.life = 1; this.s0 = 1; this.s1 = 1; this.sPow = 1; this.grav = 0; this.drag = 0;
    this.rot = 0; this.rotV = 0; this.r = this.g = this.b = 1; this.a = 1; this.fadeIn = 0.05; this.fadeOut = 0.5;
    this.er = this.eg = this.eb = 0; this.eDecay = 0; this.add = 0; this.cell = 0; this.frames = 1; this.fps = 0; this.frame0 = 0;
    this.mode = 0; this.stretch = 0; this.minLen = 0; this.ax = this.ay = this.az = 0;
    this.sunVis = 1; this.ao = 1; this.phase = 0; this.hole = 0; this.floorY = -1e9; this.soft = 0.6;
    this.buoy = 0; this.turb = 0; this.bounceY = -1e9; this.bounce = 0.3; this.size = 0; this.alpha = 0; this.ctrl = 0;
    this.grow = 0; this.nearK = 1; this.flip = 1; this.aspect = 1; this.dens = 0;
    return this;
  }
}

const VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
attribute vec4 iA; attribute vec4 iB; attribute vec4 iC; attribute vec4 iD;
attribute vec4 iE; attribute vec4 iF; attribute vec4 iG; attribute vec4 iH;
uniform vec3 uSunDir; uniform vec4 uPLPos[4]; uniform vec3 uPLCol[4];
varying vec2 vUv; varying vec2 vLocal; varying vec4 vColor; varying vec4 vEmis;
varying vec3 vSunN; varying vec3 vUpN; varying vec3 vLit; varying vec3 vPoint; varying vec3 vWorld;
varying vec4 vMisc; varying float vViewDist; varying float vNear; varying vec3 vMac; varying float vDens;
void main(){
  vec3 c = iA.xyz; float size = iA.w; float mode = iB.w;
  vec2 q = position.xy;
  vec3 fwd = c - cameraPosition; float dist = length(fwd); fwd /= max(dist, 1e-3);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 right, up, toCam, wp;
  float cr = cos(iF.x), sr = sin(iF.x);
  if (mode > 0.5 && mode < 1.5) {            // axial: long axis = iB.xyz (tail→head), width faces camera
    vec3 ax = iB.xyz; float len = length(ax); vec3 axn = ax / max(len, 1e-4);
    vec3 side = cross(axn, fwd); float sl = length(side);
    side = sl > 1e-4 ? side / sl : camRight;
    wp = c + axn * (q.x * 0.5 * len) + side * (q.y * size);
    right = axn; up = side; toCam = -fwd;
  } else if (mode > 1.5 && mode < 2.5) {     // flat: quad lies in the plane with normal iB.xyz
    vec3 n = normalize(iB.xyz);
    vec3 t = abs(n.y) < 0.99 ? normalize(cross(vec3(0.0, 1.0, 0.0), n)) : vec3(1.0, 0.0, 0.0);
    vec3 b = cross(n, t);
    vec2 rq = vec2(cr * q.x - sr * q.y, sr * q.x + cr * q.y);
    wp = c + (t * rq.x + b * rq.y) * size;
    right = t; up = b; toCam = n;
  } else {                                   // camera-position-facing billboard (mode 3: pivot at bottom edge)
    vec3 r = cross(fwd, vec3(0.0, 1.0, 0.0)); float rl = length(r);
    right = rl > 1e-3 ? r / rl : camRight;
    up = cross(right, fwd);
    toCam = -fwd;
    vec2 qq = vec2(q.x * iH.z, q.y); if (mode > 2.5) qq.y += 1.0;
    vec2 rq = vec2(cr * qq.x - sr * qq.y, sr * qq.x + cr * qq.y);
    wp = c + (right * rq.x + up * rq.y) * size;
    vec3 rr = right * cr + up * sr; vec3 uu = -right * sr + up * cr; right = rr; up = uu;
  }
  vLocal = q;
  vUv = iE.xy + (vec2(q.x * iH.w, q.y) * 0.5 + 0.5) * iE.zw;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vViewDist = -mvPosition.z;
  vWorld = wp;
  vColor = iC; vEmis = iD;
  vSunN = vec3(dot(right, uSunDir), dot(up, uSunDir), dot(toCam, uSunDir));
  // optional per-particle "macro" normal (billboards: iB.xyz = outward normal of the whole cloud at this puff)
  vMac = vec3(0.0);
  if ((mode < 0.5 || mode > 2.5) && dot(iB.xyz, iB.xyz) > 0.25) { vec3 mN = normalize(iB.xyz); vMac = vec3(dot(mN, uSunDir), mN.y, 0.7); }
  vUpN = vec3(right.y, up.y, toCam.y);
  // Henyey-Greenstein forward scattering (silver lining when looking toward the sun through thin smoke)
  float cosT = dot(fwd, uSunDir); float g = 0.6;
  float hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-3), 1.5);
  vLit = vec3(iF.y, iF.z, iF.w * hg * 0.25);
  vec3 pl = vec3(0.0);
  if (dot(iC.rgb, vec3(1.0)) > 0.0) {
    for (int i = 0; i < 4; i++) {
      vec3 d = uPLPos[i].xyz - wp; float d2 = dot(d, d); float rng = uPLPos[i].w;
      float win = clamp(1.0 - d2 / max(rng * rng, 1.0), 0.0, 1.0); win *= win;
      pl += uPLCol[i] * win / (d2 + size * size * 2.0 + 2500.0);   // soft: lights inside a cloud don't blow it out
    }
    pl = pl / (1.0 + max(pl.r, max(pl.g, pl.b)) * 0.12);           // compress very strong flashes
  }
  vPoint = pl * RECIPROCAL_PI;
  float softK = iG.z;
  vMisc = vec4(iG.x, iG.y, softK > 0.0 ? softK * size : softK, iG.w);
  vNear = iH.x * size;
  vDens = iH.y;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uAtlas; uniform sampler2D uSmoke; uniform sampler2D uDepth;
uniform vec4 uDepthParams;   // x: has depth, y: near, z: far, w: unused
uniform vec2 uInvRes;
uniform vec3 uSunColor; uniform vec3 uSkyColor; uniform vec3 uGroundColor;
uniform vec4 uHoleA[12]; uniform vec4 uHoleB[12];
varying vec2 vUv; varying vec2 vLocal; varying vec4 vColor; varying vec4 vEmis;
varying vec3 vSunN; varying vec3 vUpN; varying vec3 vLit; varying vec3 vPoint; varying vec3 vWorld;
varying vec4 vMisc; varying float vViewDist; varying float vNear; varying vec3 vMac; varying float vDens;
vec3 srgbDecode(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
float sceneDist(){
  float d = texture2D(uDepth, gl_FragCoord.xy * uInvRes).r;
  float n = uDepthParams.y, f = uDepthParams.z;
  return (n * f) / ((f - n) * d - f) * -1.0;
}
void main(){
  vec4 t;
  if (vMisc.w > 1.5) {          // analytic glow (no 8-bit banding under large HDR multipliers)
    float r2 = min(dot(vLocal, vLocal), 1.0); float w = 1.0 - r2;
    float ga = (exp(-r2 * 9.0) * 0.85 + exp(-r2 * 2.5) * 0.25) * w * w;
    t = vec4(ga, ga, ga, ga);
  } else if (vMisc.w > 0.5) { vec2 s = texture2D(uSmoke, vUv).rg; t = vec4(s.rrr, s.g); }
  else t = texture2D(uAtlas, vUv);
  float a = t.a * vColor.a;
  float eMax = max(1.0, max(vEmis.r, max(vEmis.g, vEmis.b)));   // HDR emitters: scale the discard threshold
  if (a * eMax < 0.002) discard;
  // ---- soft particles: spherical-billboard thickness vs scene depth & near plane ----
  float th; float hR = vMisc.z;
  if (hR > 0.0) th = hR * sqrt(max(0.0, 1.0 - dot(vLocal, vLocal))) + 0.5; else th = -hR;
  float sd = uDepthParams.x > 0.5 ? sceneDist() : 1e9;
  float front = vViewDist - th, back = vViewDist + th;
  float visT = clamp((min(sd, back) - max(front, uDepthParams.y)) / (2.0 * th), 0.0, 1.0);
  // dense media: opacity follows Beer-Lambert of the visible thickness, so a puff half-buried in a crate is still opaque
  if (vDens > 0.0) visT = (1.0 - exp(-vDens * visT)) / (1.0 - exp(-vDens));
  a *= visT;
  if (vNear > 0.0) a *= smoothstep(vNear * 0.12, vNear, vViewDist);
  if (uDepthParams.x < 0.5) a *= clamp((vWorld.y - vMisc.y) / 10.0, 0.0, 1.0);   // fallback: fade into floor
  // ---- carved holes (bullets / HE through smoke) ----
  if (vMisc.x > 0.5) {
    for (int i = 0; i < 12; i++) {
      vec4 A = uHoleA[i], B = uHoleB[i];
      if (B.w > 0.0) {
        vec3 ab = B.xyz - A.xyz; float l2 = dot(ab, ab);
        float h = l2 > 1e-4 ? clamp(dot(vWorld - A.xyz, ab) / l2, 0.0, 1.0) : 0.0;
        float d = length(vWorld - (A.xyz + ab * h));
        a *= 1.0 - B.w * (1.0 - smoothstep(A.w * 0.55, A.w * 1.35, d));
      }
    }
  }
  if (a * eMax < 0.0015) discard;
  vec3 texS = t.rgb / max(t.a, 1e-3);          // straight (un-premultiplied) sRGB texel
  vec3 col = vEmis.rgb * srgbDecode(texS);
  if (dot(vColor.rgb, vec3(1.0)) > 0.0) {
    float shade = mix(0.38, 1.0, dot(texS, vec3(0.3333)));   // baked puff shading → soft detail
    vec2 p = vLocal; float r2 = min(dot(p, p), 1.0);
    vec3 n = normalize(vec3(p * 0.9, sqrt(1.0 - r2) + 0.2));
    float ndl = mix(dot(n, vSunN), vMac.x, vMac.z);
    float wrapL = clamp((ndl + 0.5) / 1.5, 0.0, 1.0);
    float upn = clamp(mix(dot(n, vUpN), vMac.y, vMac.z) * 0.5 + 0.5, 0.0, 1.0);
    vec3 amb = mix(uGroundColor, uSkyColor, upn) * vLit.y;
    amb = mix(amb, vec3(dot(amb, vec3(0.3333))), 0.35);     // multiple scattering desaturates the sky tint
    vec3 sun = uSunColor * vLit.x * (wrapL * wrapL + vLit.z * (1.0 - t.a * 0.7));
    col += vColor.rgb * shade * ((amb + sun) * RECIPROCAL_PI + vPoint);
  }
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    col = mix(col, fogColor * (1.0 - vEmis.a), fogFactor);
  #endif
  // tone map / encode the straight colour, then premultiply (correct for both screen and HDR render-target output)
  gl_FragColor = vec4(col, a * (1.0 - vEmis.a));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= a;
}`;

export class ParticleSystem {
  constructor(capacity, tex, uniforms) {
    this.cap = capacity;
    for (const f of FIELDS) this[f] = new Float32Array(capacity);
    this.act = new Int32Array(capacity); this.n = 0;      // dense list of active particle ids
    this.slot = new Int32Array(capacity).fill(-1);         // id → position in act
    this.free = new Int32Array(capacity); this.nFree = capacity;
    for (let i = 0; i < capacity; i++) this.free[i] = capacity - 1 - i;
    this.rects = tex.rects;
    // sort buffers
    this.keys = new Uint32Array(capacity); this.keys2 = new Uint32Array(capacity);
    this.ord = new Int32Array(capacity); this.ord2 = new Int32Array(capacity);
    this.cnt = new Uint32Array(2048);
    this.cx = new Float32Array(capacity); this.cy = new Float32Array(capacity); this.cz = new Float32Array(capacity);

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.data = new Float32Array(capacity * STRIDE);
    const ib = (this.ib = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1));
    ib.setUsage(THREE.DynamicDrawUsage);
    ['iA', 'iB', 'iC', 'iD', 'iE', 'iF', 'iG', 'iH'].forEach((nm, k) => g.setAttribute(nm, new THREE.InterleavedBufferAttribute(ib, 4, k * 4)));
    g.instanceCount = 0;
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: true, fog: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    // shared uniform objects (owned by FX) — assign by reference so updates propagate
    Object.assign(this.material.uniforms, uniforms);
    this.material.uniforms.uAtlas = { value: tex.atlasTex };
    this.material.uniforms.uSmoke = { value: tex.smokeTex };
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 20; this.mesh.name = 'fx_particles';
    this.mesh.matrixAutoUpdate = false;
  }

  get count() { return this.n; }

  emit(s) {
    if (this.nFree === 0) return -1;
    const i = this.free[--this.nFree];
    for (let k = 0; k < FIELDS.length; k++) { const f = FIELDS[k]; this[f][i] = s[f]; }
    this.age[i] = 0;
    if (s.ctrl) { this.size[i] = s.size || s.s0; this.alpha[i] = s.alpha; }
    else { this.size[i] = s.s0; this.alpha[i] = 0; }
    this.slot[i] = this.n; this.act[this.n++] = i;
    return i;
  }

  kill(i) {
    const k = this.slot[i]; if (k < 0) return;
    const last = this.act[--this.n]; this.act[k] = last; this.slot[last] = k; this.slot[i] = -1;
    this.free[this.nFree++] = i;
  }

  clear() { while (this.n) this.kill(this.act[this.n - 1]); }

  simulate(dt, time) {
    const { x, y, z, vx, vy, vz, age, life, s0, s1, sPow, grav, drag, rot, rotV, a, fadeIn, fadeOut, buoy, turb, bounceY, bounce, size, alpha, ctrl, grow } = this;
    for (let k = this.n - 1; k >= 0; k--) {
      const i = this.act[k];
      if (ctrl[i]) continue;
      const ag = (age[i] += dt);
      const L = life[i];
      if (ag >= L) { this.kill(i); continue; }
      let ux = vx[i], uy = vy[i], uz = vz[i];
      uy += (buoy[i] - grav[i]) * dt;
      if (drag[i] > 0) { const f = Math.exp(-drag[i] * dt); ux *= f; uy *= f; uz *= f; }
      if (turb[i] > 0) {
        const tb = turb[i] * dt, ph = i * 1.731;
        ux += tb * Math.sin(time * 2.3 + ph); uy += tb * 0.6 * Math.sin(time * 1.7 + ph * 2.1); uz += tb * Math.cos(time * 2.9 + ph * 0.7);
      }
      let px = x[i] + ux * dt, py = y[i] + uy * dt, pz = z[i] + uz * dt;
      if (py < bounceY[i]) { py = bounceY[i]; uy = -uy * bounce[i]; ux *= 0.55; uz *= 0.55; rotV[i] *= 0.5; if (uy < 30) { uy = 0; } }
      x[i] = px; y[i] = py; z[i] = pz; vx[i] = ux; vy[i] = uy; vz[i] = uz;
      rot[i] += rotV[i] * dt;
      const t = ag / L;
      const sp = sPow[i];
      const e = sp === 1 ? t : 1 - Math.pow(1 - t, sp);
      size[i] = s0[i] + (s1[i] - s0[i]) * e + grow[i] * ag;
      const fi = fadeIn[i] > 0 ? Math.min(1, t / fadeIn[i]) : 1;
      const fo = t <= fadeOut[i] ? 1 : 1 - (t - fadeOut[i]) / (1 - fadeOut[i]);
      alpha[i] = a[i] * fi * fo * fo * (3 - 2 * fo);
    }
  }

  // Build instance data sorted back-to-front for `camera` and upload it.
  write(camPos) {
    const n = this.n; const { act, keys, ord, cx, cy, cz } = this;
    const { x, y, z, vx, vy, vz, mode, stretch, minLen, ax, ay, az } = this;
    const px = camPos.x, py = camPos.y, pz = camPos.z;
    // centers + axis (stored temporarily in cx/cy/cz; axis recomputed in the write loop)
    for (let k = 0; k < n; k++) {
      const i = act[k]; let X = x[i], Y = y[i], Z = z[i];
      const m = mode[i];
      if (m === 1) {
        if (stretch[i] > 0) {
          const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]); const len = sp * stretch[i] + minLen[i];
          if (sp > 1e-3) { const f = 0.5 * len / sp; X -= vx[i] * f; Y -= vy[i] * f; Z -= vz[i] * f; }
        } else { X += ax[i] * 0.5; Y += ay[i] * 0.5; Z += az[i] * 0.5; }
      }
      cx[i] = X; cy[i] = Y; cz[i] = Z;
      const dx = X - px, dy = Y - py, dz = Z - pz;
      let q = (Math.sqrt(dx * dx + dy * dy + dz * dz) * 8) | 0; if (q > 4194303) q = 4194303;
      keys[k] = 4194303 - q; ord[k] = i;
    }
    this._radix(n);
    const D = this.data, R = this.rects;
    const { r, g, b, alpha, er, eg, eb, eDecay, add, cell, frames, fps, frame0, rot, sunVis, ao, phase, hole, floorY, soft, size, age, nearK, flip, aspect, dens } = this;
    for (let k = 0; k < n; k++) {
      const i = ord[k]; const o = k * STRIDE;
      const m = mode[i];
      D[o] = cx[i]; D[o + 1] = cy[i]; D[o + 2] = cz[i]; D[o + 3] = size[i];
      if (m === 1 && stretch[i] > 0) {
        const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]); const len = sp * stretch[i] + minLen[i];
        if (sp > 1e-3) { const f = len / sp; D[o + 4] = vx[i] * f; D[o + 5] = vy[i] * f; D[o + 6] = vz[i] * f; }
        else { D[o + 4] = 0; D[o + 5] = len; D[o + 6] = 0; }
      } else { D[o + 4] = ax[i]; D[o + 5] = ay[i]; D[o + 6] = az[i]; }
      D[o + 7] = m;
      D[o + 8] = r[i]; D[o + 9] = g[i]; D[o + 10] = b[i]; D[o + 11] = alpha[i];
      const e = eDecay[i] > 0 ? Math.exp(-eDecay[i] * age[i]) : 1;
      D[o + 12] = er[i] * e; D[o + 13] = eg[i] * e; D[o + 14] = eb[i] * e; D[o + 15] = add[i];
      let c = cell[i];
      if (frames[i] > 1) c += ((frame0[i] + Math.floor(age[i] * fps[i])) % frames[i]);
      const ro = c * 5;
      D[o + 16] = R[ro]; D[o + 17] = R[ro + 1]; D[o + 18] = R[ro + 2]; D[o + 19] = R[ro + 3];
      D[o + 20] = rot[i]; D[o + 21] = sunVis[i]; D[o + 22] = ao[i]; D[o + 23] = phase[i];
      D[o + 24] = hole[i]; D[o + 25] = floorY[i]; D[o + 26] = soft[i]; D[o + 27] = R[ro + 4];
      D[o + 28] = nearK[i]; D[o + 29] = dens[i]; D[o + 30] = aspect[i]; D[o + 31] = flip[i];
    }
    this.geometry.instanceCount = n;
    const ib = this.ib; ib.clearUpdateRanges(); if (n) { ib.addUpdateRange(0, n * STRIDE); ib.needsUpdate = true; }
  }

  // LSD radix sort of keys[0..n) (22-bit) carrying ord[]; ascending key == back-to-front
  _radix(n) {
    let ka = this.keys, kb = this.keys2, oa = this.ord, ob = this.ord2; const cnt = this.cnt;
    for (let pass = 0; pass < 2; pass++) {
      const sh = pass * 11; cnt.fill(0);
      for (let k = 0; k < n; k++) cnt[(ka[k] >>> sh) & 2047]++;
      let sum = 0; for (let j = 0; j < 2048; j++) { const c = cnt[j]; cnt[j] = sum; sum += c; }
      for (let k = 0; k < n; k++) { const d = cnt[(ka[k] >>> sh) & 2047]++; kb[d] = ka[k]; ob[d] = oa[k]; }
      let t = ka; ka = kb; kb = t; const to = oa; oa = ob; ob = to;
    }
    // after an even number of passes the result is back in this.keys / this.ord
  }
}
