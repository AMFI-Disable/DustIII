// fx_decals.js — persistent, lit, instanced decals (bullet holes, blood splats, scorch marks).
// One InstancedMesh (one draw call) with a MeshStandardMaterial patched to read a per-instance atlas rect,
// so decals receive sun / shadows / env lighting exactly like the surfaces they sit on.
// Two ring-buffer pools: small (bullet holes, 256) and big (blood / scorch / burn, 96). Oldest are recycled.
// No z-fighting: polygonOffset + 0.04u lift along the normal, depthWrite off.
import * as THREE from 'three';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1), _c = new THREE.Color();

export class DecalSystem {
  constructor(tex, { small = 256, big = 96 } = {}) {
    this.smallCap = small; this.bigCap = big; const total = small + big;
    this.drects = tex.drects;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.uvAttr = new THREE.InstancedBufferAttribute(new Float32Array(total * 4), 4); this.uvAttr.setUsage(THREE.DynamicDrawUsage);
    this.aAttr = new THREE.InstancedBufferAttribute(new Float32Array(total), 1); this.aAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('dUV', this.uvAttr); geo.setAttribute('dA', this.aAttr);
    const mat = (this.material = new THREE.MeshStandardMaterial({
      map: tex.decalTex, bumpMap: tex.decalTex, bumpScale: 1.6, roughness: 0.82, metalness: 0,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6,
    }));
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 dUV; attribute float dA; varying float vDA;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          vMapUv = dUV.xy + uv * dUV.zw;
          #ifdef USE_BUMPMAP
            vBumpMapUv = vMapUv;
          #endif
          vDA = dA;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vDA;')
        .replace('#include <map_fragment>', `
          vec4 dTex = texture2D(map, vMapUv);
          vec3 dCol = dTex.rgb / max(dTex.a, 1e-4);
          dCol = mix(dCol / 12.92, pow((dCol + 0.055) / 1.055, vec3(2.4)), step(0.04045, dCol));
          diffuseColor *= vec4(dCol, dTex.a * vDA);
          if (diffuseColor.a < 0.004) discard;`);
    };
    mat.customProgramCacheKey = () => 'fx_decal_v1';
    const mesh = (this.mesh = new THREE.InstancedMesh(geo, mat, total));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false; mesh.renderOrder = 5; mesh.name = 'fx_decals';
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < total; i++) { mesh.setMatrixAt(i, _m); mesh.setColorAt(i, _c.setRGB(1, 1, 1)); }
    this.nextSmall = 0; this.nextBig = 0; this.used = 0;
    this.mesh.count = total;
  }

  // kind: DECAL id. point/normal: Vector3. size: world units (full width). rot: radians around normal.
  // color: THREE.Color (linear multiplier) or null. alpha 0..1. big: use the big pool.
  add(kind, point, normal, size, rot, color, alpha = 1, big = false, aspect = 1) {
    let i;
    if (big) { i = this.smallCap + this.nextBig; this.nextBig = (this.nextBig + 1) % this.bigCap; }
    else { i = this.nextSmall; this.nextSmall = (this.nextSmall + 1) % this.smallCap; }
    _q.setFromUnitVectors(_z, normal);
    _q2.setFromAxisAngle(_z, rot); _q.multiply(_q2);
    _p.copy(point).addScaledVector(normal, big ? 0.06 : 0.04);
    _s.set(size * aspect, size, 1);
    _m.compose(_p, _q, _s);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.setColorAt(i, color || _c.setRGB(1, 1, 1));
    const r = this.drects, o = kind * 4, u = this.uvAttr.array;
    u[i * 4] = r[o]; u[i * 4 + 1] = r[o + 1]; u[i * 4 + 2] = r[o + 2]; u[i * 4 + 3] = r[o + 3];
    this.aAttr.array[i] = alpha;
    this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true;
    this.uvAttr.needsUpdate = true; this.aAttr.needsUpdate = true;
    return i;
  }

  setAlpha(i, a) { this.aAttr.array[i] = a; this.aAttr.needsUpdate = true; }

  clear() {
    _m.makeScale(0, 0, 0);
    const total = this.smallCap + this.bigCap;
    for (let i = 0; i < total; i++) this.mesh.setMatrixAt(i, _m);
    this.aAttr.array.fill(0);
    this.mesh.instanceMatrix.needsUpdate = true; this.aAttr.needsUpdate = true;
    this.nextSmall = 0; this.nextBig = 0;
  }
}
