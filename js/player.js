// player.js — shared Player entity (human + bots): CS2/Source-style movement, collision, inventory & weapon state.
import * as THREE from 'three';
import { WEAPONS, SLOT } from './weapon_data.js';

// ---------------------------------------------------------------- CS2 movement constants (units: inches, seconds)
export const MOVE = {
  gravity: 800, jumpImpulse: 301.993, accelerate: 5.5, airAccelerate: 12, airWishCap: 30,
  friction: 5.2, stopSpeed: 80, walkMul: 0.52, duckMul: 0.34, stepHeight: 34,   // CS uses 18; this blockout's stairs have ~32u risers
  radius: 16, height: 72, duckHeight: 54, eye: 64, duckEye: 46, duckTime: 0.2,
  maxFall: 3500, ladder: false,
};

const _seg = new THREE.Line3(), _box = new THREE.Box3(), _triPt = new THREE.Vector3(), _capPt = new THREE.Vector3();
const _triN = new THREE.Vector3(), _dir = new THREE.Vector3(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _ray = new THREE.Ray();
const _down = new THREE.Vector3(0, -1, 0);
// hull footprint samples (≈ CS 32×32 box bottom)
const FOOT_OFFS = [[0, 0]]; for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; FOOT_OFFS.push([Math.cos(a) * 14, Math.sin(a) * 14]); }

export class Player {
  constructor({ id, name, team, isBot = false }) {
    this.id = id; this.name = name; this.team = team; this.isBot = isBot;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;               // view angles (radians): yaw 0 = -Z, + = turn left; pitch + = up
    this.punch = { p: 0, y: 0 };                // aim punch (degrees) → bullets go to view + 2*punch, camera shows 0.9*punch
    this.viewPunch = { p: 0, y: 0, vp: 0, vy: 0 }; // flinch from damage
    this.onGround = false; this.duck = 0; this.ducking = false; this.walking = false;
    this.stamina = 0; this.velMod = 1;          // tagging slowdown
    this.lastGroundY = 0; this.airTime = 0; this.landImpact = 0;
    this.input = { fwd: 0, side: 0, jump: false, duck: false, walk: false, jumpHeld: false };
    this.hp = 100; this.armor = 0; this.helmet = false; this.alive = false;
    this.money = 800; this.defuser = false;
    this.stats = { k: 0, d: 0, a: 0, dmg: 0, hs: 0, mvp: 0, score: 0, roundKills: 0, roundDmg: 0 };
    this.damageBy = new Map(); // attacker id -> damage this life (for assists)
    this.resetInventory();
    this.char = null;          // Character (third-person model)
    this.weaponModels = new Map();
    this.stepDist = 0; this.lastStepSide = 0;
    this.flash = 0; this.flashDur = 0; this.flashT = 0;
    this.spotted = 0;          // time remaining "spotted" on enemy radar
    this.lastFireTime = -9; this.lastHurtTime = -9;
  }
  resetInventory() {
    this.inv = { primary: null, secondary: null, knife: null, grenades: [], c4: false, taser: null };
    this.active = 'knife'; this.lastActive = 'secondary';
    this.planting = 0; this.defusing = 0;
  }
  // -------------------------------------------------------------- weapons
  static makeWeapon(id) {
    const d = WEAPONS[id];
    return { id, def: d, clip: d.mag || 0, reserve: d.reserve || 0, nextFire: 0, reloadEnd: 0, reloading: false,
      shellState: null, burst: false, burstLeft: 0, burstNext: 0, zoom: 0, shotsFired: 0, recoilIdx: 0, accFire: 0,
      drawEnd: 0, prime: 0, primeStart: 0, boughtThisRound: false, silencer: !!d.silenced };
  }
  give(id, opts = {}) {
    const d = WEAPONS[id]; if (!d) return null;
    if (d.cat === 'grenade') { this.inv.grenades.push(id); return id; }
    if (id === 'c4') { this.inv.c4 = true; return id; }
    const w = Player.makeWeapon(id); w.boughtThisRound = !!opts.bought;
    if (d.slot === SLOT.PRIMARY) this.inv.primary = w;
    else if (d.slot === SLOT.SECONDARY) { if (id === 'taser') this.inv.taser = w; else this.inv.secondary = w; }
    else if (d.slot === SLOT.KNIFE) this.inv.knife = w;
    return w;
  }
  weaponInSlot(slot) {
    switch (slot) {
      case 'primary': return this.inv.primary; case 'secondary': return this.inv.secondary; case 'knife': return this.inv.knife;
      case 'taser': return this.inv.taser;
      default: return null;
    }
  }
  get activeId() {
    if (this.active.startsWith('grenade:')) return this.active.slice(8);
    if (this.active === 'c4') return 'c4';
    const w = this.weaponInSlot(this.active); return w ? w.id : (this.inv.knife ? this.inv.knife.id : 'knife_ct');
  }
  get activeWeapon() { return this.weaponInSlot(this.active); }
  get activeDef() { return WEAPONS[this.activeId]; }
  get maxSpeed() {
    const d = this.activeDef; let s = d ? d.speed : 250;
    const w = this.activeWeapon;
    if (w && w.zoom > 0 && d.scopedSpeed) s = d.scopedSpeed;
    return s;
  }
  get eyeHeight() { return MOVE.eye + (MOVE.duckEye - MOVE.eye) * this.duck; }
  get height() { return this.duck > 0.5 ? MOVE.duckHeight : MOVE.height; }
  eyePos(out = new THREE.Vector3()) { return out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z); }
  forward(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }
  hasLineup() { return true; }

  // -------------------------------------------------------------- movement (Source/CS2 style)
  simulate(dt, world, frozen) {
    if (!this.alive) return;
    const inp = this.input, bvh = world.moveBvh || world.bvh;
    // ---- duck
    const wantDuck = inp.duck;
    if (wantDuck) {
      if (!this.ducking && !this.onGround) {   // crouch in air pulls the legs up (crouch-jump)
        this.pos.y += 9; if (this._collides(bvh, this.pos, MOVE.duckHeight)) this.pos.y -= 9;
      }
      this.ducking = true;
      this.duck = Math.min(1, this.duck + dt / MOVE.duckTime);
    } else if (this.ducking || this.duck > 0) {
      // unduck only if there is head room
      if (!this._collides(bvh, this.pos, MOVE.height)) {
        this.duck = Math.max(0, this.duck - dt / MOVE.duckTime);
        if (this.duck === 0) this.ducking = false;
      } else if (!this.onGround && !this._collides(bvh, _v.copy(this.pos).setY(this.pos.y - 9), MOVE.height)) {
        this.pos.y -= 9; this.duck = 0; this.ducking = false;
      }
    }
    // ---- wish velocity
    let maxSpeed = this.maxSpeed * this.velMod;
    if (this.duck > 0.5 && this.onGround) maxSpeed *= MOVE.duckMul;
    else if (inp.walk) maxSpeed *= MOVE.walkMul;
    if (frozen || this.planting > 0 || this.defusing > 0) maxSpeed = 0;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    let wx = fx * inp.fwd + rx * inp.side, wz = fz * inp.fwd + rz * inp.side;
    const wl = Math.hypot(wx, wz);
    let wishspeed = 0;
    if (wl > 1e-4) { wx /= wl; wz /= wl; wishspeed = maxSpeed * Math.min(1, wl); }
    // ---- jump
    // small grace window so a jump pressed during a one-frame ground flicker isn't lost
    if (inp.jump) { this.jumpBuf = 0.1; }
    if (this.jumpBuf > 0 && (this.onGround || this.airTime < 0.06) && !this.jumped && !frozen && this.duck < 1.01 && this.planting <= 0 && this.defusing <= 0) {
      this.jumpBuf = 0;
      this.vel.y = MOVE.jumpImpulse * (1 - this.stamina / 100 * 0.3);
      this.onGround = false; this.jumped = true; this.stamina = Math.min(80, this.stamina + 24);
      this.events?.('jump');
    }
    inp.jump = false; this.jumpBuf = Math.max(0, (this.jumpBuf || 0) - dt);
    // ---- friction + accelerate
    if (this.onGround) {
      const sp = Math.hypot(this.vel.x, this.vel.z);
      if (sp > 0.1) {
        const control = sp < MOVE.stopSpeed ? MOVE.stopSpeed : sp;
        const drop = control * MOVE.friction * dt;
        const ns = Math.max(sp - drop, 0) / sp;
        this.vel.x *= ns; this.vel.z *= ns;
      } else { this.vel.x = 0; this.vel.z = 0; }
      if (wishspeed > 0) {
        const cur = this.vel.x * wx + this.vel.z * wz;
        const add = wishspeed - cur;
        if (add > 0) {
          const acc = Math.min(MOVE.accelerate * dt * Math.max(wishspeed, 0) * (1 - this.stamina / 160), add);
          this.vel.x += acc * wx; this.vel.z += acc * wz;
        }
      }
      // stamina slows ground speed after landing / jumping
      if (this.stamina > 0) { const r = 1 - this.stamina / 100 * 0.25 * dt * 8; this.vel.x *= r; this.vel.z *= r; }
    } else if (wishspeed > 0) {
      const ws = Math.min(wishspeed, MOVE.airWishCap);
      const cur = this.vel.x * wx + this.vel.z * wz;
      const add = ws - cur;
      if (add > 0) {
        const acc = Math.min(MOVE.airAccelerate * wishspeed * dt, add);
        this.vel.x += acc * wx; this.vel.z += acc * wz;
      }
    }
    this.stamina = Math.max(0, this.stamina - 60 * dt);
    this.velMod = Math.min(1, this.velMod + dt * 1.2);
    // ---- gravity
    // Source integrates gravity in two halves (StartGravity / FinishGravity) → exact jump arc (57u, 66u crouch-jump)
    if (!this.onGround) this.vel.y = Math.max(this.vel.y - MOVE.gravity * dt * 0.5, -MOVE.maxFall);
    else this.vel.y = Math.min(this.vel.y, 0);
    const halfGrav = !this.onGround;
    // ---- move with collision (sub-stepped so nothing tunnels)
    const wasGround = this.onGround;
    const preVy = this.vel.y;
    const dist = Math.hypot(this.vel.x, this.vel.y, this.vel.z) * dt;
    const steps = Math.max(1, Math.ceil(dist / 6));
    const sdt = dt / steps;
    let ground = false;
    const y0 = this.pos.y;
    this._support = false;
    for (let i = 0; i < steps; i++) ground = this._moveStep(sdt, bvh) || ground;
    // wedged on an edge / between surfaces: don't accumulate fall speed while supported
    if (!wasGround && !ground) this.airPeak = Math.max(this.airPeak ?? this.pos.y, this.pos.y);
    if (wasGround && !ground) this.airPeak = this.pos.y;
    if (halfGrav && !ground) this.vel.y = Math.max(this.vel.y - MOVE.gravity * dt * 0.5, -MOVE.maxFall);
    // ---- flat hull bottom (CS uses a box, we use a capsule): while falling, land on anything under the hull footprint
    if (!ground && this.vel.y <= 0) {
      const hy = this._groundProbeAt(bvh, this.pos, Math.max(2, -this.vel.y * dt + 2), true);
      if (hy !== null && hy <= this.pos.y + 1) { this.pos.y = hy; ground = true; }
    }
    // ---- ground snap (walk down stairs / slopes like Source's StayOnGround)
    if (!ground && wasGround && !this.jumped && this.vel.y <= 0) {
      const h = this._groundProbe(bvh, MOVE.stepHeight + 2);
      if (h !== null) { this.pos.y = h; ground = true; }
    }
    if (ground && !wasGround) {
      // landing
      // impact speed from the real fall height (robust against getting wedged on edges)
      const fallH = Math.max(0, (this.airPeak ?? this.pos.y) - this.pos.y);
      const vImpact = Math.min(-preVy, Math.sqrt(2 * MOVE.gravity * fallH));
      const impact = Math.min(1, Math.max(0, (vImpact - 200) / 600));
      this.landImpact = Math.max(this.landImpact, 0.25 + impact);
      if (this.airTime > 0.25) { this.stamina = Math.min(80, this.stamina + 10 + impact * 30); this.events?.('land', impact); }
      if (vImpact > 580) {        // fall damage (CS: above ~580 u/s)
        const dmg = Math.round((vImpact - 580) * (100 / (1024 - 580)));
        if (dmg > 0) this.events?.('falldamage', dmg);
      }
      this.airPeak = undefined;
    }
    this.onGround = ground;
    if (ground) { this.vel.y = 0; this.jumped = false; this.airTime = 0; } else this.airTime += dt;
    // out of world safety
    if (this.pos.y < -2000) this.events?.('fellout');
  }
  _moveStep(dt, bvh) {
    const ox = this.pos.x, oy = this.pos.y, oz = this.pos.z;
    // normal move
    this.pos.x += this.vel.x * dt; this.pos.y += this.vel.y * dt; this.pos.z += this.vel.z * dt;
    let res = this._resolve(bvh, this.pos, this.height);
    // step-up attempt when blocked horizontally on the ground
    if (res.blocked && (this.onGround || res.ground)) {
      const nx = this.pos.x, ny = this.pos.y, nz = this.pos.z;
      const movedN = Math.hypot(nx - ox, nz - oz);
      const tp = _v2.set(ox, oy + MOVE.stepHeight, oz);
      if (!this._collides(bvh, tp, this.height)) {
        tp.x += this.vel.x * dt; tp.z += this.vel.z * dt;
        const r2 = this._resolve(bvh, tp, this.height);
        // step down again
        const h = this._groundProbeAt(bvh, tp, MOVE.stepHeight + 1);
        const movedS = Math.hypot(tp.x - ox, tp.z - oz);
        if (h !== null && movedS > movedN + 0.05 && h - oy <= MOVE.stepHeight + 0.5) {
          this.pos.set(tp.x, h, tp.z);
          res = { ground: true, blocked: r2.blocked, normal: r2.normal };
        } else { this.pos.set(nx, ny, nz); }
      } else this.pos.set(nx, ny, nz);
    }
    // clip velocity against contact normals
    if (res.normals) for (const n of res.normals) {
      const into = this.vel.x * n.x + this.vel.y * n.y + this.vel.z * n.z;
      if (into < 0) {
        if (n.y > 0.7) { this.vel.y = Math.max(this.vel.y, 0); }
        else { this.vel.x -= n.x * into; this.vel.y -= n.y * into; this.vel.z -= n.z * into; }
      }
    }
    return res.ground;
  }
  // capsule push-out; returns { ground, blocked, normals[] }
  _resolve(bvh, pos, height) {
    const r = MOVE.radius;
    const normals = this._normals || (this._normals = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]);
    let nCount = 0, ground = false, blocked = false;
    for (let iter = 0; iter < 3; iter++) {
      _seg.start.set(pos.x, pos.y + r, pos.z); _seg.end.set(pos.x, pos.y + height - r, pos.z);
      _box.makeEmpty(); _box.expandByPoint(_seg.start); _box.expandByPoint(_seg.end);
      _box.min.addScalar(-r); _box.max.addScalar(r);
      let any = false;
      bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(_box),
        intersectsTriangle: (tri) => {
          const d = tri.closestPointToSegment(_seg, _triPt, _capPt);
          if (d < r) {
            const depth = r - d;
            _dir.subVectors(_capPt, _triPt);
            if (_dir.lengthSq() < 1e-8) { tri.getNormal(_dir); } else _dir.normalize();
            // Edge / corner below the hull centre (crate lips, ledge edges): behave like CS's flat-bottomed box hull —
            // lift straight up onto it instead of sliding off the rounded capsule bottom.
            tri.getNormal(_triN);
            const faceContact = Math.abs(_dir.dot(_triN)) > 0.985;
            if (!faceContact && _dir.y > 0.2 && _capPt.y - _triPt.y > 0) {
              const hx = _capPt.x - _triPt.x, hz = _capPt.z - _triPt.z, hd2 = hx * hx + hz * hz;
              const lift = Math.sqrt(Math.max(0, r * r - hd2)) - (_capPt.y - _triPt.y);
              if (lift > 0) { _seg.start.y += lift; _seg.end.y += lift; }
              ground = true; this._support = true;
              if (nCount < normals.length) normals[nCount++].set(0, 1, 0);
              any = true;
              return false;
            }
            // treat walkable surfaces under the feet as pure vertical support (no sliding on slopes)
            if (_dir.y > 0.7) { _seg.start.y += depth / _dir.y * 1.0; _seg.end.y += depth / _dir.y; }
            else { _seg.start.addScaledVector(_dir, depth); _seg.end.addScaledVector(_dir, depth); }
            if (_dir.y > 0.7) ground = true; else if (Math.abs(_dir.y) < 0.7) blocked = true;
            if (_dir.y > 0.3) this._support = true;
            if (nCount < normals.length) normals[nCount++].copy(_dir);
            any = true;
          }
        },
      });
      pos.set(_seg.start.x, _seg.start.y - r, _seg.start.z);
      if (!any) break;
    }
    const out = this._resOut || (this._resOut = { ground: false, blocked: false, normals: [] });
    out.ground = ground; out.blocked = blocked; out.normals.length = 0;
    for (let i = 0; i < nCount; i++) out.normals.push(normals[i]);
    return out;
  }
  _collides(bvh, pos, height) {
    const r = MOVE.radius - 0.5;
    _seg.start.set(pos.x, pos.y + MOVE.radius, pos.z); _seg.end.set(pos.x, pos.y + height - MOVE.radius, pos.z);
    _box.makeEmpty(); _box.expandByPoint(_seg.start); _box.expandByPoint(_seg.end); _box.min.addScalar(-r); _box.max.addScalar(r);
    let hit = false;
    bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_box),
      intersectsTriangle: (tri) => { if (tri.closestPointToSegment(_seg, _triPt, _capPt) < r - 0.5) { hit = true; return true; } return false; },
    });
    return hit;
  }
  _groundProbe(bvh, maxDown) { return this._groundProbeAt(bvh, this.pos, maxDown); }
  _groundProbeAt(bvh, pos, maxDown, landing = false) {
    // sample the hull footprint (centre + ring), take the highest walkable floor within reach
    let best = null;
    const offs = FOOT_OFFS;
    for (const [ox, oz] of offs) {
      _ray.origin.set(pos.x + ox, pos.y + (landing ? 1.5 : 4), pos.z + oz); _ray.direction.copy(_down);
      const hit = bvh.raycastFirst(_ray, THREE.DoubleSide);
      if (hit && hit.distance <= maxDown + 4) {
        const n = hit.face ? hit.face.normal : null;
        const y = hit.point.y;
        // ignore samples that land on something above us (e.g. the top of a crate we're pressed against)
        if ((!n || Math.abs(n.y) > 0.7) && y <= pos.y + MOVE.stepHeight) { if (best === null || y > best) best = y; }
      }
    }
    return best;
  }
  horizontalSpeed() { return Math.hypot(this.vel.x, this.vel.z); }
}
