// world.js — Dust2 world: rendering (PBR materials, sun + 2-tier shadows, env, fog, post), collision (BVH),
// navigation (nav grid + A*), callouts, spawns, bomb sites and bot points.
//   const world = await createWorld(renderer, { quality: 'high', onProgress });
//
// world = {
//   scene                      world THREE.Scene (add characters here; call world.addShadowCaster(obj) for shadows)
//   sun, farSun, hemi, envMap  lights (sun = near cascade, follows the camera; farSun = static full-map shadow, 0 intensity)
//   collider                   THREE.Mesh, geometry.boundsTree = MeshBVH (world units, DoubleSide), invisible
//   raycast(o, dir, max)       -> { point, normal (faces the ray), distance, faceIndex, surface, group } | null
//   raycastAll(o, dir, max)    -> sorted hits (for wall penetration)
//   surfaceAt(pos)             -> 'stone'|'sand'|'dirt'|'wood'|'metal' of the floor below pos
//   isInShadow(pos)            -> 0..1 (3 rays toward the sun)
//   nav                        NavGrid: findPath(a,b) findRoute(pts) nearestWalkable(p) heightAt(x,z[,y]) isWalkable(x,z[,y]) randomPointNear(p,r)
//   calloutAt(pos)             -> 'Long A', 'B Site', ... ('' if none)
//   spawns.{ct,t,ctAlt,tAlt}   [{ pos: Vector3 (feet), yaw }]   yaw: 0 = facing -Z (north), +PI/2 = facing -X (west)
//   bombsites.{A,B}            { center, poly, y0, y1, contains(pos) }
//   botPoints                  { areas, ct[], t[], routes{}, plant{A,B}, smokes{}, flashes{} } (Vector3s)
//   lighting                   { sunDir, sunColor, sunIntensity, ambientColor, groundColor, ambientIntensity, envIntensity, envMap }
//   setQuality('low'|'medium'|'high'|'ultra'), setSize(w, h, pixelRatio), render(camera, overlays=[{scene, camera}])
//   addShadowCaster(obj), patchMaterial(mat)
//   props                      CS2 set dressing (world_props.js; visual only, never in collider/BVH/nav): { group, lights, stats }
// }
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { TextureBank, createWorldMaterial, createSharedUniforms, makeNoiseTexture, MATDEF, patchExternalMaterial } from './world_materials.js';
import { NavGrid } from './world_nav.js';
import { createProps } from './world_props.js';
import { CALLOUTS, SPAWNS, BOMBSITES, BOT_POINTS } from './world_data.js';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

export const WORLD_LAYER = 5;          // static world geometry (far shadow map renders only this layer)
const SUN_DIR = new THREE.Vector3(0.42, 0.74, 0.52).normalize();
// CS2-style grade: clean, near-white sun, bright neutral bounce, light blue-grey haze
const SUN_COLOR = new THREE.Color(1.0, 0.955, 0.875);
const SKY_COLOR = new THREE.Color(0.76, 0.83, 0.98);
const GROUND_COLOR = new THREE.Color(1.0, 0.86, 0.68);
const FOG_COLOR = new THREE.Color(0.80, 0.85, 0.90);

export const QUALITY = {
  low:    { pr: 0.75, nearSize: 2048, nearRadius: 900,  farSize: 2048, gtao: false, bloom: false, aa: 'fxaa', msaa: 0, aniso: 2, dust: 0,    exposure: 0.95 },
  medium: { pr: 1.0,  nearSize: 2048, nearRadius: 1100, farSize: 4096, gtao: false, bloom: true,  aa: 'smaa', msaa: 0, aniso: 4, dust: 600,  exposure: 0.95 },
  high:   { pr: 1.5,  nearSize: 4096, nearRadius: 1300, farSize: 4096, gtao: true,  bloom: true,  aa: 'none', msaa: 4, aniso: 8, dust: 1200, exposure: 0.95 },
  ultra:  { pr: 2.0,  nearSize: 4096, nearRadius: 1100, farSize: 8192, gtao: true,  bloom: true,  aa: 'smaa', msaa: 4, aniso: 16, dust: 1600, exposure: 0.95 },
};

// linear-HDR colour grade applied before tone mapping: a touch more saturation/contrast (CS2's crisp, clean look)
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uSat: { value: 1.1 }, uContrast: { value: 1.09 }, uPivot: { value: 0.18 }, uLift: { value: new THREE.Vector3(0.004, 0.005, 0.007) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uSat, uContrast, uPivot; uniform vec3 uLift; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv); vec3 col = max(c.rgb, 0.0);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = max(mix(vec3(l), col, uSat), 0.0);
      col = uPivot * pow(col / uPivot, vec3(uContrast));   // contrast around mid-grey in linear
      col += uLift * (1.0 - smoothstep(0.0, 0.2, l));        // faint cool lift in the deepest shadows
      gl_FragColor = vec4(col, c.a); }`,
};

async function fetchBin(url) {
  const r = await fetch(url); if (!r.ok) throw new Error('world: failed to load ' + url);
  let buf;
  if (url.endsWith('.b64.txt')) {          // binary shipped as base64 text (artifact hosting serves only web types)
    const s = (await r.text()).trim();
    const bin = atob(s); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    buf = u8.buffer;
  } else buf = await r.arrayBuffer();
  // only gunzip when the bytes really are gzip (some hosts transparently decompress .gz responses)
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    buf = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
  }
  return buf;
}

export async function createWorld(renderer, { quality = 'high', onProgress, base = '' } = {}) {
  const t0 = performance.now();
  const progress = (f, msg) => { try { onProgress && onProgress(Math.min(1, f), msg); } catch (e) { } };
  progress(0, 'world: loading geometry');
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const meta = await fetch(base + 'assets/world/map.json').then(r => r.json());
  const bin = await fetchBin(base + 'assets/world/' + (meta.file || 'map.bin'));
  let bake = null, bakeBin = null;
  try {
    bake = await fetch(base + 'assets/world/bake.json').then(r => r.ok ? r.json() : null);
    if (bake) bakeBin = await fetchBin(base + 'assets/world/' + bake.file);
  } catch (e) { console.warn('world: no bake data', e); bake = null; }
  progress(0.1, 'world: textures');

  const scene = new THREE.Scene();
  scene.name = 'world';
  const bank = new TextureBank(renderer, base + 'assets/tex/', f => progress(0.1 + f * 0.6, 'world: textures'));
  const shared = createSharedUniforms();
  shared.tNoise.value = makeNoiseTexture(256);

  // ------------------------------------------------------------ baked AO volume + floor height raster
  if (bake) {
    const a = bake.ao;
    const vol = new Uint8Array(bakeBin, a.offset, a.nx * a.ny * a.nz * 2);
    const tex = new THREE.Data3DTexture(vol, a.nx, a.ny, a.nz);
    tex.format = THREE.RGFormat; tex.type = THREE.UnsignedByteType;
    tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.unpackAlignment = 1;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping; tex.needsUpdate = true;
    shared.tAO.value = tex;
    shared.uAOMin.value.set(a.min[0] - a.step * 0.5, a.min[1] - a.step * 0.5, a.min[2] - a.step * 0.5);
    shared.uAOInv.value.set(1 / (a.nx * a.step), 1 / (a.ny * a.step), 1 / (a.nz * a.step));
    shared.uAOK.value.set(a.aoScale || 1.0, a.aoBias || 0.0, 1.0, 0.25);
    const f = bake.floor;
    const fr = new Uint16Array(bakeBin, f.offset, f.nx * f.nz * 2);
    const fh = new Float32Array(fr.length); for (let i = 0; i < fr.length; i++) fh[i] = fr[i] * f.scale + f.bias;
    const ft = new THREE.DataTexture(fh, f.nx, f.nz, THREE.RGFormat, THREE.FloatType);
    ft.minFilter = ft.magFilter = THREE.NearestFilter; ft.needsUpdate = true;
    shared.tFloorH.value = ft;
    shared.uFloorRect.value.set(f.x0 - f.step * 0.5, f.z0 - f.step * 0.5, 1 / (f.nx * f.step), 1 / (f.nz * f.step));
  } else {
    const tex = new THREE.Data3DTexture(new Uint8Array([255, 255]), 1, 1, 1); tex.format = THREE.RGFormat; tex.needsUpdate = true;
    shared.tAO.value = tex;
    const ft = new THREE.DataTexture(new Float32Array([-1000, -1000]), 1, 1, THREE.RGFormat, THREE.FloatType); ft.needsUpdate = true;
    shared.tFloorH.value = ft;
  }

  // ------------------------------------------------------------ render meshes
  const mats = {};
  const worldMeshes = [];
  const meshesGroup = new THREE.Group(); meshesGroup.name = 'world_meshes'; scene.add(meshesGroup);
  for (const m of meta.meshes) {
    if (!mats[m.mat]) mats[m.mat] = createWorldMaterial(m.mat, bank, shared);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin, m.pos.offset, m.pos.count), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(bin, m.nrm.offset, m.nrm.count), 3));
    g.setAttribute('aUv', new THREE.BufferAttribute(new Float32Array(bin, m.uv.offset, m.uv.count), 2));
    g.setAttribute('aTan', new THREE.BufferAttribute(new Float32Array(bin, m.tan.offset, m.tan.count), 4));
    g.setAttribute('aAux', new THREE.BufferAttribute(new Float32Array(bin, m.aux.offset, m.aux.count), 2));
    g.computeBoundingBox(); g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mats[m.mat]);
    mesh.name = 'world_' + m.mat + '_' + m.chunk;
    mesh.castShadow = m.chunk !== 999 || m.mat !== 'terrain';
    mesh.receiveShadow = true;
    mesh.layers.enable(WORLD_LAYER);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    meshesGroup.add(mesh); worldMeshes.push(mesh);
  }

  // ------------------------------------------------------------ site decals
  const texLoader = new THREE.TextureLoader();
  const decals = new THREE.Group(); decals.name = 'world_decals'; scene.add(decals);
  const addMark = (url, mk, rotY, scale) => {
    const t = texLoader.load(base + url); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    const w = (mk.max[0] - mk.min[0]), d = (mk.max[2] - mk.min[2]);
    const s = Math.min(w, d) * scale;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshStandardMaterial({
      map: t, transparent: true, depthWrite: false, roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    m.rotation.set(-Math.PI / 2, 0, rotY, 'YXZ');
    m.rotation.order = 'YXZ'; m.rotation.y = rotY; m.rotation.x = -Math.PI / 2;
    m.position.set((mk.min[0] + mk.max[0]) / 2, mk.max[1] + 0.3, (mk.min[2] + mk.max[2]) / 2);
    m.receiveShadow = true; m.renderOrder = 1; decals.add(m);
  };
  addMark('assets/fx/mark_a.png', meta.markA, Math.PI * 0.5, 1.35);
  addMark('assets/fx/mark_b.png', meta.markB, 0, 1.1);

  // ------------------------------------------------------------ collision mesh + BVH
  const col = meta.collision;
  const cpos = new Float32Array(bin, col.pos.offset, col.pos.count).slice();
  const csurf = new Uint8Array(bin, col.surface.offset, col.surface.count).slice();
  const cgroup = new Uint8Array(bin, col.group.offset, col.group.count).slice();
  const colGeo = new THREE.BufferGeometry();
  colGeo.setAttribute('position', new THREE.BufferAttribute(cpos, 3));
  const idx = new Uint32Array(col.tris * 3); for (let i = 0; i < idx.length; i++) idx[i] = i;
  colGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  colGeo.boundsTree = new MeshBVH(colGeo, { maxLeafTris: 4 });
  colGeo.computeBoundingBox();
  const collider = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, wireframe: true }));
  collider.name = 'world_collider'; collider.visible = false;
  collider.matrixAutoUpdate = false; collider.updateMatrixWorld(true);
  const bvh = colGeo.boundsTree;
  // invisible CS-style clip ramps over staircases: movement-only collision (bullets, grenades and nav ignore them)
  let rampBvh = null;
  try {
    const rr = await fetch(base + 'assets/world/ramps.json');
    if (rr.ok) {
      const R = (await rr.json()).ramps || [];
      if (R.length) {
        const rp = new Float32Array(R.length * 18);
        R.forEach((r, i) => { const [a, b, c, d] = r.quad; rp.set([...a, ...b, ...c, ...a, ...c, ...d], i * 18); });
        const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
        const ri = new Uint32Array(R.length * 6); for (let i = 0; i < ri.length; i++) ri[i] = i; rg.setIndex(new THREE.BufferAttribute(ri, 1));
        rampBvh = new MeshBVH(rg, { maxLeafTris: 4 });
      }
    }
  } catch (e) { console.warn('world: ramps unavailable', e); }
  // composite BVH used for player movement: world geometry + clip ramps
  const moveBvh = !rampBvh ? bvh : {
    shapecast(cb) { if (bvh.shapecast(cb)) return true; return rampBvh.shapecast(cb); },
    raycastFirst(ray, side, near, far) {
      const a = bvh.raycastFirst(ray, side, near, far), b = rampBvh.raycastFirst(ray, side, near, far);
      if (!a) return b; if (!b) return a; return a.distance <= b.distance ? a : b;
    },
  };
  const SURF = meta.surfaces;
  const triOf = (faceIndex) => (colGeo.index.array[faceIndex * 3] / 3) | 0;

  const _ray = new THREE.Ray(), _n = new THREE.Vector3();
  function hitInfo(h, dir) {
    const tri = triOf(h.faceIndex);
    _n.copy(h.face.normal);
    if (_n.dot(dir) > 0) _n.negate();
    return { point: h.point.clone(), normal: _n.clone(), distance: h.distance, faceIndex: tri, surface: SURF[csurf[tri]], group: cgroup[tri] };
  }
  function raycast(origin, dir, maxDist = 1e5) {
    _ray.origin.copy(origin); _ray.direction.copy(dir).normalize();
    const h = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, maxDist);
    return h ? hitInfo(h, _ray.direction) : null;
  }
  function raycastAll(origin, dir, maxDist = 1e5) {
    _ray.origin.copy(origin); _ray.direction.copy(dir).normalize();
    const hs = bvh.raycast(_ray, THREE.DoubleSide, 0, maxDist);
    hs.sort((a, b) => a.distance - b.distance);
    const d = _ray.direction.clone();
    return hs.map(h => hitInfo(h, d));
  }
  const _down = new THREE.Vector3(0, -1, 0);
  function surfaceAt(pos, maxDown = 200) {
    const o = new THREE.Vector3(pos.x, pos.y + 8, pos.z);
    const h = raycast(o, _down, maxDown + 8);
    return h ? h.surface : 'stone';
  }
  const _sunRay = new THREE.Ray();
  const _jit = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(6, 0, -4), new THREE.Vector3(-5, 3, 5)];
  function isInShadow(pos) {
    let s = 0;
    for (const j of _jit) {
      _sunRay.origin.set(pos.x + j.x, pos.y + j.y, pos.z + j.z); _sunRay.direction.copy(SUN_DIR);
      if (bvh.raycastFirst(_sunRay, THREE.DoubleSide, 0.5, 6000)) s++;
    }
    return s / _jit.length;
  }

  // painted site letters on a nearby wall (CS2 style)
  const wallMark = (url, mk) => {
    const c = new THREE.Vector3((mk.min[0] + mk.max[0]) / 2, mk.max[1] + 100, (mk.min[2] + mk.max[2]) / 2);
    let best = null;
    for (let k = 0; k < 16; k++) {
      const a = k / 16 * Math.PI * 2; const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const h = raycast(c, d, 900);
      if (h && h.distance > 150 && (h.group === 27 || h.group === 22) && Math.abs(h.normal.y) < 0.2 && (!best || h.distance < best.distance)) best = h;
    }
    if (!best) return;
    // check the wall is wide/tall enough around the hit (both sides + above)
    const t = texLoader.load(base + url); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), new THREE.MeshStandardMaterial({
      map: t, transparent: true, depthWrite: false, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    m.position.copy(best.point).addScaledVector(best.normal, 0.6);
    m.lookAt(m.position.clone().add(best.normal));
    m.receiveShadow = true; m.renderOrder = 1; decals.add(m);
  };
  wallMark('assets/fx/mark_a.png', meta.markA);
  wallMark('assets/fx/mark_b.png', meta.markB);

  // ------------------------------------------------------------ lighting
  const sunIntensity = 3.3;
  const sun = new THREE.DirectionalLight(SUN_COLOR, sunIntensity);
  sun.name = 'sun';
  sun.castShadow = true;
  sun.shadow.bias = -0.0002; sun.shadow.normalBias = 1.2; sun.shadow.radius = 1;
  scene.add(sun, sun.target);
  // far (static) shadow: zero-intensity light whose shadow map covers the whole map; world shader blends it in
  const farSun = new THREE.DirectionalLight(0x000000, 0.0);
  farSun.name = 'sun_far_shadow';
  farSun.castShadow = true; farSun.shadow.autoUpdate = false; farSun.shadow.bias = -0.0004; farSun.shadow.normalBias = 2.5;
  farSun.shadow.camera.layers.set(WORLD_LAYER);
  scene.add(farSun, farSun.target);
  {
    // fit far shadow camera to the map bounds in light space
    const b = meta.bounds; const pad = 200;
    const cx = (b.minx + b.maxx) / 2, cz = (b.minz + b.maxz) / 2;
    farSun.target.position.set(cx, 250, cz); farSun.position.copy(farSun.target.position).addScaledVector(SUN_DIR, 4000);
    farSun.updateMatrixWorld(); farSun.target.updateMatrixWorld();
    const cam = farSun.shadow.camera; cam.position.copy(farSun.position); cam.lookAt(farSun.target.position); cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse; const p = new THREE.Vector3();
    let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9, mnz = 1e9, mxz = -1e9;
    for (const x of [b.minx - pad, b.maxx + pad]) for (const y of [-50, 700]) for (const z of [b.minz - pad, b.maxz + pad]) {
      p.set(x, y, z).applyMatrix4(inv); mnx = Math.min(mnx, p.x); mxx = Math.max(mxx, p.x); mny = Math.min(mny, p.y); mxy = Math.max(mxy, p.y); mnz = Math.min(mnz, p.z); mxz = Math.max(mxz, p.z);
    }
    Object.assign(cam, { left: mnx, right: mxx, bottom: mny, top: mxy, near: -mxz - 100, far: -mnz + 100 });
    cam.updateProjectionMatrix();
  }
  const hemi = new THREE.HemisphereLight(SKY_COLOR, GROUND_COLOR, 0.95);
  hemi.name = 'hemi'; scene.add(hemi);

  // sky + env
  const skyTex = await new Promise((res, rej) => texLoader.load(base + 'assets/tex/sky.jpg', res, undefined, rej));
  skyTex.mapping = THREE.EquirectangularReflectionMapping; skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTex; scene.backgroundIntensity = 1.0;
  const pm = new THREE.PMREMGenerator(renderer);
  const envMap = pm.fromEquirectangular(skyTex).texture; pm.dispose();
  scene.environment = envMap; scene.environmentIntensity = 0.5;
  scene.fog = new THREE.Fog(FOG_COLOR, 3500, 32000);

  // ------------------------------------------------------------ CS2-style set dressing (visual only: not in collider / BVH / nav)
  let props = null;
  try {
    props = await createProps({ base, layer: WORLD_LAYER, patchMaterial: (m) => patchExternalMaterial(m, shared) });
    if (props) scene.add(props.group);
  } catch (e) { console.warn('world: props failed', e); props = null; }

  // ------------------------------------------------------------ dust motes
  let dust = null;
  function buildDust(n) {
    if (dust) { scene.remove(dust); dust.geometry.dispose(); dust.material.dispose(); dust = null; }
    if (!n) return;
    const g = new THREE.BufferGeometry(); const p = new Float32Array(n * 3), r = new Float32Array(n);
    for (let i = 0; i < n; i++) { p[i * 3] = Math.random(); p[i * 3 + 1] = Math.random(); p[i * 3 + 2] = Math.random(); r[i] = Math.random(); }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('aR', new THREE.BufferAttribute(r, 1));
    const dtex = texLoader.load(base + 'assets/fx/glow.png');
    const m = new THREE.ShaderMaterial({
      uniforms: { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uBox: { value: 900 }, tTex: { value: dtex }, uColor: { value: new THREE.Color(1.0, 0.96, 0.88) }, uScale: { value: 1 } },
      vertexShader: `attribute float aR; uniform vec3 uCam; uniform float uTime, uBox, uScale; varying float vA;
        void main(){ vec3 drift = vec3(uTime*6.0 + sin(uTime*0.3+aR*40.0)*12.0, sin(uTime*0.5+aR*20.0)*8.0, uTime*3.0);
          vec3 p = mod(position*uBox + drift - uCam + uBox*0.5, uBox) - uBox*0.5 + uCam;
          vec4 mv = modelViewMatrix*vec4(p,1.0); gl_Position = projectionMatrix*mv;
          float d = -mv.z; vA = smoothstep(20.0, 80.0, d) * (1.0 - smoothstep(uBox*0.3, uBox*0.5, d)) * (0.45 + 0.55*sin(uTime*0.7 + aR*30.0)*sin(uTime*0.7 + aR*30.0));
          gl_PointSize = uScale * (0.9 + aR*1.6) * 260.0 / max(d, 1.0); }`,
      fragmentShader: `uniform sampler2D tTex; uniform vec3 uColor; varying float vA;
        void main(){ float a = texture2D(tTex, gl_PointCoord).a * vA * 0.22; if (a < 0.003) discard; gl_FragColor = vec4(uColor * 1.4, a); }`,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending, fog: false });
    dust = new THREE.Points(g, m); dust.frustumCulled = false; dust.name = 'world_dust'; dust.renderOrder = 5;
    scene.add(dust);
  }

  // ------------------------------------------------------------ post-processing
  let composer = null, renderPass, gtaoPass = null, overlayPass, bloomPass, gradePass, outputPass, aaPass = null;
  const size = new THREE.Vector2(); renderer.getSize(size);
  let curPR = renderer.getPixelRatio(), basePR = curPR;
  class OverlayPass extends Pass {
    constructor() { super(); this.needsSwap = false; this.items = []; }
    render(r, writeBuffer, readBuffer) {
      if (!this.items.length) return;
      const ac = r.autoClear; r.autoClear = false;
      r.setRenderTarget(this.renderToScreen ? null : readBuffer);
      r.clearDepth();
      const bg = null;
      for (const o of this.items) { const sb = o.scene.background; o.scene.background = bg; r.render(o.scene, o.camera); o.scene.background = sb; }
      r.autoClear = ac;
    }
  }
  const dummyCam = new THREE.PerspectiveCamera(75, 1, 1, 30000);
  function buildComposer() {
    if (composer) { composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); composer.passes.forEach(p => p.dispose && p.dispose()); }
    const Q = QUALITY[state.quality];
    const pr = renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(size.x * pr)), h = Math.max(1, Math.floor(size.y * pr));
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: Q.msaa });
    composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(1); composer.setSize(w, h);
    renderPass = new RenderPass(scene, dummyCam);
    composer.addPass(renderPass);
    gtaoPass = null;
    if (Q.gtao) {
      gtaoPass = new GTAOPass(scene, dummyCam, w, h);
      gtaoPass.output = GTAOPass.OUTPUT.Default;
      gtaoPass.blendIntensity = 0.7;
      gtaoPass.updateGtaoMaterial({ radius: 26, distanceExponent: 1.4, thickness: 6, scale: 1.0, samples: 12, distanceFallOff: 1.0 });
      gtaoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      composer.addPass(gtaoPass);
    }
    overlayPass = new OverlayPass(); composer.addPass(overlayPass);
    bloomPass = null;
    if (Q.bloom) { bloomPass = new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.12, 0.5, 2.0); composer.addPass(bloomPass); }
    gradePass = new ShaderPass(GradeShader); composer.addPass(gradePass);
    outputPass = new OutputPass(); composer.addPass(outputPass);
    aaPass = null;
    if (Q.aa === 'smaa') { aaPass = new SMAAPass(w, h); composer.addPass(aaPass); }
    else if (Q.aa === 'fxaa') { aaPass = new ShaderPass(FXAAShader); aaPass.material.uniforms.resolution.value.set(1 / w, 1 / h); composer.addPass(aaPass); }
  }

  // ------------------------------------------------------------ quality
  const state = { quality: null };
  function setQuality(q) {
    if (!QUALITY[q]) q = 'high';
    const Q = QUALITY[q]; state.quality = q;
    renderer.setPixelRatio(Math.min(basePR, Q.pr));
    sun.shadow.mapSize.set(Q.nearSize, Q.nearSize);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    const r = Q.nearRadius; Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 7000 });
    sun.shadow.camera.updateProjectionMatrix();
    farSun.shadow.mapSize.set(Q.farSize, Q.farSize);
    if (farSun.shadow.map) { farSun.shadow.map.dispose(); farSun.shadow.map = null; }
    farSun.shadow.needsUpdate = true;
    bank.setAnisotropy(Math.min(Q.aniso, renderer.capabilities.getMaxAnisotropy()));
    renderer.toneMappingExposure = Q.exposure;
    buildDust(Q.dust);
    if (props) {   // low: no prop point lights / foliage shadows
      props.lights.forEach(l => { l.visible = q !== 'low'; });
      props.group.children.forEach(m => { if (m.name === 'props_foliage') m.castShadow = q !== 'low'; });
    }
    buildComposer();
  }
  function setSize(w, h, pixelRatio) {
    size.set(w, h);
    if (pixelRatio !== undefined) basePR = pixelRatio;
    renderer.setPixelRatio(Math.min(basePR, QUALITY[state.quality].pr));
    renderer.setSize(w, h, false);
    buildComposer();
  }

  // ------------------------------------------------------------ per-frame
  const _fwd = new THREE.Vector3(), _c = new THREE.Vector3(), _ls = new THREE.Vector3();
  const _lightMat = new THREE.Matrix4(), _lightInv = new THREE.Matrix4();
  _lightMat.lookAt(SUN_DIR, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)); _lightInv.copy(_lightMat).invert();
  const clock = new THREE.Clock();
  function updateShadow(camera) {
    const Q = QUALITY[state.quality];
    camera.getWorldDirection(_fwd); _fwd.y = 0; if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1); _fwd.normalize();
    _c.copy(camera.getWorldPosition(new THREE.Vector3())).addScaledVector(_fwd, Q.nearRadius * 0.45);
    // snap the center to shadow texels in light space (prevents shimmering)
    const texel = (2 * Q.nearRadius) / Q.nearSize;
    _ls.copy(_c).applyMatrix4(_lightInv);
    _ls.x = Math.round(_ls.x / texel) * texel; _ls.y = Math.round(_ls.y / texel) * texel;
    _c.copy(_ls).applyMatrix4(_lightMat);
    sun.target.position.copy(_c); sun.position.copy(_c).addScaledVector(SUN_DIR, 3500);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
  }
  function render(camera, overlays = []) {
    const dt = clock.getDelta();
    updateShadow(camera);
    if (dust) { dust.material.uniforms.uTime.value += dt; dust.material.uniforms.uCam.value.copy(camera.position); dust.material.uniforms.uScale.value = renderer.getPixelRatio() * size.y / 900; }
    renderPass.camera = camera;
    if (gtaoPass) { gtaoPass.camera = camera; if (gtaoPass.normalPass) gtaoPass.normalPass.camera = camera; }
    overlayPass.items = overlays;
    composer.render(dt);
  }

  // ------------------------------------------------------------ navigation + gameplay data
  let nav = null;
  if (bake && bake.nav) nav = new NavGrid(bake.nav, bakeBin, raycast);
  else console.warn('world: nav data missing');
  function calloutAt(pos) {
    for (const c of CALLOUTS) {
      if (pos.y < c.y0 || pos.y > c.y1) continue;
      if (pointInPoly(pos.x, pos.z, c.poly)) return c.name;
    }
    return '';
  }
  const snap = (v) => { if (!nav) return v; const n = nav.nearestNode(v, 300); if (n >= 0) nav.nodePos(n, v); return v; };
  const mkSpawn = s => { const p = snap(new THREE.Vector3(...s.pos)); p.x = s.pos[0]; p.z = s.pos[2]; p.y = nav ? nav.heightAt(p.x, p.z, p.y + 20) : p.y; return { pos: p, yaw: s.yaw }; };
  const spawns = { ct: SPAWNS.ct.map(mkSpawn), t: SPAWNS.t.map(mkSpawn), ctAlt: SPAWNS.ctAlt.map(mkSpawn), tAlt: SPAWNS.tAlt.map(mkSpawn) };
  const bombsites = {};
  for (const k of Object.keys(BOMBSITES)) {
    const b = BOMBSITES[k];
    bombsites[k] = { name: k, center: new THREE.Vector3(...b.center), poly: b.poly, y0: b.y0, y1: b.y1,
      contains: (p) => p.y >= b.y0 && p.y <= b.y1 && pointInPoly(p.x, p.z, b.poly) };
  }
  const botPoints = convertPoints(BOT_POINTS);
  for (const key of ['areas', 'routes', 'plant']) snapAll(botPoints[key], snap);
  for (const side of ['ct', 't']) botPoints[side].forEach(p => snap(p.pos));
  if (nav) { for (const [k, v] of Object.entries(botPoints.areas)) nav.named[k] = v; try { nav.findPath(botPoints.areas['T Spawn'], botPoints.areas['A Site']); nav.findPath(botPoints.areas['CT Spawn'], botPoints.areas['B Site']); } catch (e) { } }

  setQuality(quality);
  // compile + warm up
  await bank.ready();
  progress(0.85, 'world: compiling shaders');
  try { renderer.compile(scene, dummyCam); } catch (e) { }
  progress(1, 'world: ready');
  console.log('world: ready in ' + ((performance.now() - t0) / 1000).toFixed(1) + 's, tris ' + worldMeshes.reduce((a, m) => a + m.geometry.attributes.position.count / 3, 0) + ', collider ' + col.tris);

  const world = {
    scene, sun, farSun, hemi, envMap, collider, bvh, moveBvh, rampBvh, meshes: worldMeshes, materials: mats,
    raycast, raycastAll, surfaceAt, isInShadow, nav, calloutAt, spawns, bombsites, botPoints,
    lighting: { sunDir: SUN_DIR.clone(), sunColor: SUN_COLOR.clone(), sunIntensity, ambientColor: SKY_COLOR.clone(), groundColor: GROUND_COLOR.clone(), ambientIntensity: hemi.intensity, envIntensity: scene.environmentIntensity, envMap },
    setQuality, setSize, render,
    get quality() { return state.quality; },
    get composer() { return composer; },
    /** make an object cast/receive sun shadows and use the far shadow + indoor ambient (adds it to the scene if it has no parent) */
    addShadowCaster(obj, { receive = true } = {}) {
      obj.traverse(o => { if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = receive; (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => patchExternalMaterial(m, shared)); } });
      if (!obj.parent) scene.add(obj);
      return obj;
    },
    /** patch a lit material for far shadows + indoor ambient darkening (idempotent) */
    patchMaterial(m) { patchExternalMaterial(m, shared); return m; },
    meta, bake, shared, props,
  };
  return world;
}

function snapAll(o, f) {
  if (!o) return;
  if (o.isVector3) { f(o); return; }
  if (Array.isArray(o)) { o.forEach(v => snapAll(v, f)); return; }
  if (typeof o === 'object') for (const k of Object.keys(o)) snapAll(o[k], f);
}
export function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function convertPoints(o) {
  if (Array.isArray(o)) {
    if (o.length === 3 && typeof o[0] === 'number') return new THREE.Vector3(o[0], o[1], o[2]);
    return o.map(convertPoints);
  }
  if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o)) r[k] = convertPoints(o[k]); return r; }
  return o;
}
