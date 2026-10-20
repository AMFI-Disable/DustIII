// bots.js — CS2-style bot AI: perception (vision cone, LOS, smoke, hearing), reaction time, aim with error & recoil
// control, counter-strafing, team strategies (T executes / CT site holds & rotations), planting, defusing, grenades, buying.
import * as THREE from 'three';
import { WEAPONS, RULES } from './weapon_data.js';

const D2R = Math.PI / 180;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

export const DIFFICULTY = {
  easy:   { reaction: 0.6,  turn: 4.5, err: 0.075, decay: 2.2, head: 0.12, spray: 0.25, fov: 0.62, hear: 0.6, strafe: false, crouch: 0.15, accuracyWait: 0.3 },
  normal: { reaction: 0.36, turn: 7.5, err: 0.045, decay: 3.6, head: 0.3,  spray: 0.55, fov: 0.55, hear: 0.85, strafe: false, crouch: 0.3, accuracyWait: 0.2 },
  hard:   { reaction: 0.25, turn: 11,  err: 0.028, decay: 5.5, head: 0.45, spray: 0.75, fov: 0.5,  hear: 1.0, strafe: true, crouch: 0.4, accuracyWait: 0.12 },
  expert: { reaction: 0.18, turn: 16,  err: 0.016, decay: 8,   head: 0.62, spray: 0.9,  fov: 0.45, hear: 1.1, strafe: true, crouch: 0.45, accuracyWait: 0.08 },
};

const CT_LOOK = {
  'A Site default': 'A Ramp', 'A Goose': 'A Ramp', 'A Ramp top (long hold)': 'Long A', 'A Short hold': 'Short A', 'Long A corner': 'Long Doors',
  'CT Spawn': 'Short A', 'Short top': 'Catwalk', 'Mid Doors': 'Top Mid', 'CT Mid': 'Mid Doors', 'B Doors': 'B Tunnels', 'Window': 'B Tunnels',
  'B Site default': 'B Tunnels', 'B Back Plat': 'B Tunnels', 'B Car (tunnel exit hold)': 'B Tunnels',
};
const CT_GROUPS = {
  A: ['A Site default', 'A Goose', 'A Ramp top (long hold)', 'Long A corner', 'A Short hold'],
  mid: ['Short top', 'Mid Doors', 'CT Mid'],
  B: ['B Site default', 'B Back Plat', 'Window', 'B Car (tunnel exit hold)', 'B Doors'],
};
const POSTPLANT = {
  A: [['A Site default', 'CT Spawn'], ['A Goose', 'A Short hold'], ['A Ramp top (long hold)', 'CT Spawn'], ['A Short hold', 'CT Spawn']],
  B: [['B Back Plat', 'B Doors'], ['B Site default', 'Window'], ['B Car (tunnel exit hold)', 'B Doors'], ['B Site default', 'B Doors']],
};
const T_PLANS = [
  { name: 'A long', site: 'A', groups: [{ route: 'long A', n: 5, stage: 5 }] },
  { name: 'A split', site: 'A', groups: [{ route: 'long A', n: 3, stage: 5 }, { route: 'short A', n: 2, stage: 5 }] },
  { name: 'B rush', site: 'B', groups: [{ route: 'B tunnels', n: 5, stage: 4 }] },
  { name: 'B split', site: 'B', groups: [{ route: 'B tunnels', n: 3, stage: 4 }, { route: 'mid to B doors', n: 2, stage: 2 }] },
  { name: 'mid to B', site: 'B', groups: [{ route: 'mid to B', n: 3, stage: 6 }, { route: 'B tunnels', n: 2, stage: 4 }] },
  { name: 'short A', site: 'A', groups: [{ route: 'short A', n: 3, stage: 5 }, { route: 'long A', n: 2, stage: 5 }] },
];
const SITE_SMOKES = {
  A: ['CT Spawn (A)', 'Long Corner cross', 'Xbox (cross to short)'],
  B: ['B Doors', 'B Window'],
};

// ================================================================== team director
export class Director {
  constructor(game, team) { this.game = game; this.team = team; this.plan = null; this.alert = null; this.execute = false; this.assign = new Map(); }
  get world() { return this.game.world; }
  onRoundStart() {
    const g = this.game, bots = g.players.filter(p => p.team === this.team && p.isBot);
    this.assign.clear(); this.execute = false; this.alert = null; this.lastAlertTime = -99; this.rotated = new Set();
    this.smokesThrown = new Set();
    if (this.team === 't') {
      // economy-aware: on eco rounds rush more often
      const avg = bots.reduce((s, p) => s + p.money, 0) / Math.max(1, bots.length);
      let plans = T_PLANS;
      if (avg < 1500) plans = T_PLANS.filter(p => p.name.includes('rush') || p.name === 'A long');
      this.plan = plans[Math.floor(Math.random() * plans.length)];
      this.site = this.plan.site;
      let i = 0;
      const order = bots.slice().sort(() => Math.random() - 0.5);
      // bomb carrier goes with the biggest group
      const carrier = order.find(p => p.inv.c4); if (carrier) { order.splice(order.indexOf(carrier), 1); order.unshift(carrier); }
      for (const grp of this.plan.groups) {
        for (let k = 0; k < grp.n && i < order.length; k++, i++) this.assign.set(order[i].id, { route: grp.route, stage: grp.stage });
      }
      for (; i < order.length; i++) this.assign.set(order[i].id, { route: this.plan.groups[0].route, stage: this.plan.groups[0].stage });
      this.executeAt = RULES.roundTime - (25 + Math.random() * 30);   // force execute by this time
      this.rush = this.plan.name.includes('rush') || Math.random() < 0.25;
    } else {
      // CT: 2 A, 1 mid, 2 B (AWPer prefers long/mid)
      const pick = (arr, used) => { const c = arr.filter(n => !used.has(n)); const n = c[Math.floor(Math.random() * Math.min(3, c.length))] || arr[0]; used.add(n); return n; };
      const used = new Set();
      const slots = ['A', 'B', 'A', 'B', 'mid'];
      const order = bots.slice().sort((a, b) => (b.inv.primary && b.inv.primary.id === 'awp') - (a.inv.primary && a.inv.primary.id === 'awp'));
      order.forEach((p, i) => {
        const grp = slots[i % slots.length];
        let name = pick(CT_GROUPS[grp], used);
        if (p.inv.primary && p.inv.primary.id === 'awp' && i === 0) name = Math.random() < 0.5 ? 'A Ramp top (long hold)' : 'CT Mid';
        this.assign.set(p.id, { hold: name, group: grp === 'mid' ? 'mid' : grp });
      });
    }
  }
  reportEnemy(pos, reporter) {
    const g = this.game;
    const A = this.world.bombsites.A.center, B = this.world.bombsites.B.center;
    const dA = pos.distanceTo(A), dB = pos.distanceTo(B);
    if (this.team === 'ct' && Math.min(dA, dB) < 1300 && g.time - this.lastAlertTime > 3) {
      const site = dA < dB ? 'A' : 'B';
      if (this.alert !== site) { this.alert = site; this.lastAlertTime = g.time; }
    }
  }
  holdPoint(name) { const p = this.world.botPoints.ct.find(c => c.name === name); return p ? p.pos : null; }
  lookPoint(name) { return this.world.botPoints.areas[name] || null; }
}

// ================================================================== bot brain
export class BotBrain {
  constructor(game, p, difficulty = 'normal') {
    this.game = game; this.p = p; this.setDifficulty(difficulty);
    this.visible = new Set(); this.known = new Map();   // id -> {pos, time}
    this.canSee = true;
    this.path = null; this.pathIdx = 0; this.goal = null; this.mode = 'idle';
    this.target = null; this.reactLeft = 0; this.aimErr = { y: 0, p: 0 };
    this.percT = Math.random() * 0.1; this.thinkT = 0; this.stuckT = 0; this.lastProgress = new THREE.Vector3(); this.progressT = 0;
    this.strafeDir = 1; this.strafeT = 0; this.burst = 0; this.burstPause = 0;
    this.lookAt = new THREE.Vector3(); this.hasLook = false;
    this.heard = null; this.buyDone = false; this.buyT = 0.5 + Math.random() * 2.5;
    this.stageReached = false; this.waitT = 0;
    // per-bot personality so they don't all move the same way
    const R = Math.random;
    this.pers = { jiggle: R(), crouch: R(), aggression: R(), curious: 0.4 + R() * 0.6, walker: R() };
    this.yv = 0; this.pv = 0;                    // aim spring velocities
    this.moveVec = new THREE.Vector3(); this.lookT = 0; this.lookMode = 'ahead'; this.lookPt = new THREE.Vector3();
    this.wob = R() * 100; this.holdOff = 0; this.holdOffT = 0; this.jigT = 2 + R() * 4; this.jigDur = 0; this.jigDir = 1; this.crouchT = 0;
  }
  // Shift-walk like a human: sneaking up to a stage spot before the execute, or creeping after hearing footsteps nearby.
  get walkWanted() {
    const p = this.p, g = this.game;
    if (this.target || this.saving || !this.path) return false;
    const end = this.path[this.path.length - 1];
    const goalD = end ? Math.hypot(end.x - p.pos.x, end.z - p.pos.z) : 0;
    if (p.team === 't' && this.director && !this.director.execute && !this.director.rush && goalD < 380 && this.pers.walker > 0.35) return true;
    if (this.heard && this.heard.type === 'step' && g.time - this.heard.time < 2.5 && this.heard.pos.distanceTo(p.pos) < 900 && this.pers.walker > 0.25) return true;
    return false;
  }
  setDifficulty(d) { this.diffName = d; this.D = DIFFICULTY[d] || DIFFICULTY.normal; }
  get world() { return this.game.world; }
  get director() { return this.game.directors[this.p.team]; }
  onRoundStart() {
    this.visible.clear(); this.known.clear(); this.path = null; this.goal = null; this.mode = 'freeze'; this.target = null;
    this.buyDone = false; this.buyT = 0.4 + Math.random() * 2.5; this.stageReached = false; this.waitT = 0; this.heard = null;
    this.plantSpot = null; this.postPlant = null; this.grenadeTask = null; this.lastRadio = -99; this.saving = false; this.fleePos = null; this.postT = 0; this.execPath = false;
    this.p.input.fwd = this.p.input.side = 0;
  }
  onTeamChange() { this.onRoundStart(); }
  onDeath() { this.target = null; }
  onHurt(attacker, dmg) {
    if (attacker && attacker.team !== this.p.team && attacker.alive) {
      this.known.set(attacker.id, { pos: attacker.pos.clone(), time: this.game.time });
      if (!this.target) { this.lookAt.copy(attacker.pos).setY(attacker.pos.y + 50); this.hasLook = true; this.alertT = 1.5; }
    }
  }
  onFlashed(res) { this.blindUntil = this.game.time + res.duration * (res.intensity > 0.7 ? 0.9 : 0.5); }
  onTeammateDied(victim, attacker) { if (attacker && attacker.alive) this.known.set(attacker.id, { pos: attacker.pos.clone(), time: this.game.time - 1 }); }

  // ---------------------------------------------------------------- main update
  update(dt) {
    const g = this.game, p = this.p;
    const inp = p.input; const ctl = p.ctl || (p.ctl = {});
    ctl.attack = false; ctl.attack2 = false;
    inp.walk = false; inp.duck = false;
    if (g.phase === 'freeze') { this.doBuy(dt); inp.fwd = inp.side = 0; return; }
    if (g.phase === 'over' || g.phase === 'matchover') { this.idleLook(dt); inp.fwd = inp.side = 0; return; }
    if (!this.buyDone) this.doBuy(dt);
    // perception
    this.percT -= dt;
    if (this.percT <= 0) { this.percT = 0.1 + Math.random() * 0.05; this.perceive(); }
    // fire avoidance
    for (const f of g.fires) if (f.handle.alive && f.handle.damageAt(p.pos)) { this.flee = f.pos; this.fleeT = 0.8; }
    if (this.fleeT > 0) { this.fleeT -= dt; const away = _a.subVectors(p.pos, this.flee).setY(0).normalize(); this.moveDir(away, false); this.faceDir(away, dt, 0.5); return; }
    // combat takes priority (unless planting with low time / defusing)
    if (this.target && this.target.alive && this.visible.has(this.target.id)) {
      if (p.defusing && g.bomb.state === 'planted' && g.bomb.defuseTotal - g.bomb.defuseProgress < 1.2) { this.keepDefusing(); return; }
      if (p.defusing) { p.defusing = 0; }
      this.combat(dt); return;
    }
    if (this.target && (!this.target.alive || !this.visible.has(this.target.id))) {
      // lost sight: hold the angle briefly, then hunt the last known position
      const k = this.known.get(this.target.id);
      if (!this.target.alive) { this.target = null; this.onKillOrLost(); }
      else if (k && g.time - k.time < 2.0) { this.lookAt.copy(k.pos).setY(k.pos.y + 55); this.hasLook = true; this.aimTowards(this.lookAt, dt, 0.6); this.stop(); this.maybeReload(); return; }
      else { this.target = null; this.onKillOrLost(); }
    }
    if (this.checkT > 0 && !p.defusing && !(g.bomb && g.bomb.state === 'planted' && p.team === 'ct' && g.bomb.timeLeft < 12)) {
      this.checkT -= dt; this.stop(); this.maybeReload();
      const t = 1 - this.checkT;
      this.turnTo(this.checkYaw + this.checkDir * Math.sin(t * 2.6) * 0.55, p.pitch * 0.9, dt, 0.6);
      return;
    }
    this.objective(dt);
  }
  onKillOrLost() {
    this.burst = 0; this.reactLeft = 0;
    // after a fight humans pause, check the angle around them and reload before moving on
    this.checkT = 0.5 + Math.random() * 0.9; this.checkYaw = this.p.yaw; this.checkDir = Math.random() < 0.5 ? -1 : 1;
  }

  // ---------------------------------------------------------------- perception
  perceive() {
    const g = this.game, p = this.p, D = this.D;
    this.visible.clear();
    if (this.blindUntil && g.time < this.blindUntil) return;
    const cosF = D.fov;
    let best = null, bestScore = Infinity;
    for (const e of g.players) {
      if (e.team === p.team || !e.alive) continue;
      // check fov relaxed if we already engage / were hurt by them
      const engaged = this.target === e;
      if (!g.canSee(p, e, engaged ? -0.2 : cosF)) continue;
      this.visible.add(e.id);
      this.known.set(e.id, { pos: e.pos.clone(), time: g.time });
      const dist = e.pos.distanceTo(p.pos);
      const score = dist * (engaged ? 0.5 : 1) * (e.activeId === 'c4' || e.defusing ? 0.6 : 1);
      if (score < bestScore) { bestScore = score; best = e; }
      this.director?.reportEnemy?.(e.pos, p);
      if (g.time - this.lastRadio > 8 && !engaged && Math.random() < 0.4) { this.lastRadio = g.time; g.emit('radio', p, 'Enemy spotted.'); }
    }
    if (best && best !== this.target) {
      const fresh = !this.target || !this.target.alive;
      this.target = best;
      // reaction time (longer when surprised from the side / at long range)
      const f = p.forward(_a); const to = _b.subVectors(best.pos, p.pos).normalize();
      const sideMul = 1 + Math.max(0, 0.8 - f.dot(to)) * 0.6;
      this.reactLeft = (fresh ? D.reaction : D.reaction * 0.5) * sideMul * (0.8 + Math.random() * 0.5);
      const ang = D.err * (1 + Math.min(2, best.pos.distanceTo(p.pos) / 1500));
      this.aimErr.y = (Math.random() - 0.5) * 2 * ang * 2.2; this.aimErr.p = (Math.random() - 0.5) * 2 * ang;
      this.headshotPref = Math.random() < D.head;
      this.burst = 0; this.burstPause = 0;
    }
    // hearing
    const range = D.hear;
    for (const n of g.noises) {
      if (n.time < g.time - 0.6 || !n.player || n.team === p.team) continue;
      if (n.pos.distanceTo(p.pos) < n.radius * range) {
        if (!this.heard || n.time > this.heard.time) this.heard = { pos: n.pos.clone(), time: n.time, type: n.type };
      }
    }
  }

  // ---------------------------------------------------------------- combat
  combat(dt) {
    const g = this.game, p = this.p, D = this.D, e = this.target;
    const w = p.activeWeapon;
    // weapon choice: primary > secondary > knife; switch away from grenades/c4
    if (p.active.startsWith('grenade') || p.active === 'c4' || p.active === 'knife' || (w && w.clip === 0 && w.reserve === 0)) {
      if (p.inv.primary && (p.inv.primary.clip > 0 || p.inv.primary.reserve > 0) && p.active !== 'primary') g.switchTo(p, 'primary');
      else if (p.inv.secondary && p.active !== 'secondary' && (p.inv.secondary.clip > 0 || p.inv.secondary.reserve > 0)) g.switchTo(p, 'secondary');
    }
    // if primary empty mid-fight, switch to pistol (faster than reload)
    if (w && w.clip === 0 && p.active === 'primary' && p.inv.secondary && p.inv.secondary.clip > 0 && e.pos.distanceTo(p.pos) < 1500) g.switchTo(p, 'secondary');
    const d = WEAPONS[p.activeId];
    const dist = e.pos.distanceTo(p.pos);
    // aim point
    const aim = this.aimPoint(e, _c);
    // recoil compensation: aim lower by the bullet offset (2*punch) scaled by skill
    const comp = D.spray;
    this.reactLeft -= dt;
    // aim error decays while tracking
    const k = Math.exp(-D.decay * dt);
    this.aimErr.y *= k; this.aimErr.p *= k;
    const to = _a.subVectors(aim, p.eyePos(_b));
    const dx = to.x, dz = to.z;
    let wantYaw = Math.atan2(-dx, -dz) + this.aimErr.y - p.punch.y * 2 * D2R * comp;
    let wantPitch = Math.atan2(to.y, Math.hypot(dx, dz)) + this.aimErr.p - p.punch.p * 2 * D2R * comp;
    this.turnTo(wantYaw, wantPitch, dt, 1);
    // movement: counter-strafe to shoot accurately; strafe between bursts (hard/expert); close range: keep moving with smg/shotgun
    const accurate = d && d.cat !== 'knife';
    const runGun = d && (d.shotgun || (d.cat === 'smg' && dist < 450) || d.cat === 'knife');
    const wantShoot = this.reactLeft <= 0;
    // AWP / scoped weapons: scope in
    if (d && d.scope && w && w.zoom === 0 && !w.rezoom && dist > 250 && !w.reloading && g.time >= w.nextFire - 0.1) { p.ctl.attack2Pressed = true; this.scopeT = g.time; }
    const yawErr = Math.abs(angDiff(p.yaw + p.punch.y * 2 * D2R, wantYaw + p.punch.y * 2 * D2R * comp));
    const pitchErr = Math.abs((p.pitch + p.punch.p * 2 * D2R) - (wantPitch + p.punch.p * 2 * D2R * comp));
    const tol = Math.atan2(this.headshotPref ? 5 : 11, Math.max(dist, 1)) + 0.004;
    const onTarget = yawErr < tol * 1.6 && pitchErr < tol * 1.6;
    // burst control: long range rifles tap/burst
    let maxBurst = 30;
    if (d && d.cat === 'rifle' && !d.scope) maxBurst = dist > 1600 ? 1 : dist > 1000 ? 3 : dist > 600 ? 6 : 30;
    if (d && d.cat === 'smg') maxBurst = dist > 1000 ? 3 : 30;
    if (d && d.cat === 'pistol') maxBurst = 1;
    if (this.burstPause > 0) this.burstPause -= dt;
    const sp = p.horizontalSpeed();
    const slowEnough = sp < (d ? d.speed * 0.34 : 80) || runGun || (d && d.cat === 'pistol' && dist < 500);
    let shoot = wantShoot && onTarget && this.burstPause <= 0 && w && w.clip > 0 && !w.reloading && g.time >= w.drawEnd;
    if (shoot && d && d.scope && w.zoom === 0 && dist > 250) shoot = false;
    if (shoot && d && d.scope && w.zoom > 0 && g.time - (w.zoomTime || 0) < 0.15 + D.accuracyWait) shoot = false;
    if (shoot && !slowEnough) shoot = false;
    if (shoot && d && d.cat === 'pistol' && w.accFire > d.inStand * 2.5 && dist > 400) shoot = false;
    if (shoot && this.teammateInLine(e, dist)) shoot = false;
    // movement decision
    if (wantShoot && !runGun && this.burstPause > 0.06 && dist < 1400 && (D.strafe || this.pers.aggression > 0.55)) {
      // ADAD between bursts / taps instead of standing still
      this.strafeMove(dt, e);
    } else if (wantShoot && !runGun) {
      // counter-strafe: stop dead (input opposite to velocity)
      this.counterStrafe();
      if (this.burst > 0 && Math.random() < D.crouch * dt * 3 && dist > 500 && d && d.cat !== 'pistol' && !d.scope) this.crouchSpray = 1.2;
    } else if (D.strafe && !wantShoot) {
      this.strafeMove(dt, e);
    } else if (runGun) {
      this.strafeMove(dt, e, true);
    } else this.stop();
    if (this.crouchSpray > 0) { this.crouchSpray -= dt; p.input.duck = true; }
    if (shoot) {
      p.ctl.attack = true; if (!d.auto) p.ctl.attackPressed = true;
      this.burst++;
      if (this.burst >= maxBurst) { this.burst = 0; this.burstPause = d && d.cat === 'rifle' ? (dist > 1000 ? 0.32 : 0.22) : 0.15; }
    } else if (!p.ctl.attack) {
      if (this.burstPause <= 0 && this.burst > 0 && !wantShoot) this.burst = 0;
    }
    if (d && !d.auto && d.cat !== 'knife') { if (this.lastSemi && g.time - this.lastSemi < (d.cycle || 0.15) + 0.04) { p.ctl.attack = false; p.ctl.attackPressed = false; } else if (p.ctl.attack) this.lastSemi = g.time; }
    // knife: run at them
    if (d && d.cat === 'knife') {
      this.moveDir(_a.subVectors(e.pos, p.pos).setY(0).normalize(), false);
      if (dist < 70) { p.ctl.attack = Math.random() < 0.6; p.ctl.attack2 = !p.ctl.attack && dist < 50; }
    }
    if (w && w.clip === 0 && !w.reloading && w.reserve > 0 && !(p.inv.secondary && p.active === 'primary')) p.ctl.reload = true;
  }
  aimPoint(e, out) {
    // head center or upper chest, following the target's crouch
    const head = this.headshotPref;
    const eh = e.eyeHeight;
    return out.set(e.pos.x, e.pos.y + (head ? eh + 2 : eh - 18), e.pos.z);
  }
  teammateInLine(e, dist) {
    const p = this.p, eye = p.eyePos(_a), f = p.forward(_b);
    for (const q of this.game.players) {
      if (q === p || q.team !== p.team || !q.alive) continue;
      _c.set(q.pos.x, q.pos.y + 40, q.pos.z).sub(eye);
      const along = _c.dot(f); if (along < 0 || along > dist) continue;
      const perp = Math.sqrt(Math.max(0, _c.lengthSq() - along * along));
      if (perp < 26) return true;
    }
    return false;
  }
  counterStrafe() {
    const p = this.p;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    const vf = p.vel.x * fx + p.vel.z * fz, vs = p.vel.x * rx + p.vel.z * rz;
    p.input.fwd = Math.abs(vf) > 30 ? -Math.sign(vf) : 0;
    p.input.side = Math.abs(vs) > 30 ? -Math.sign(vs) : 0;
  }
  strafeMove(dt, e, keepRunning = false) {
    const p = this.p;
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafeDir = -this.strafeDir; this.strafeT = 0.25 + Math.random() * 0.45; }
    p.input.side = this.strafeDir; p.input.fwd = keepRunning ? (Math.random() < 0.5 ? 0.6 : 0) : 0;
    // don't strafe off ledges/into walls: check the nav
    const rx = Math.cos(p.yaw) * this.strafeDir, rz = -Math.sin(p.yaw) * this.strafeDir;
    const nav = this.world.nav;
    if (nav && !nav.isWalkable(p.pos.x + rx * 48, p.pos.z + rz * 48, p.pos.y + 30)) { this.strafeDir = -this.strafeDir; p.input.side = this.strafeDir; }
  }
  stop() { this.p.input.fwd = 0; this.p.input.side = 0; }

  // ---------------------------------------------------------------- objectives (no enemy in sight)
  objective(dt) {
    const g = this.game, p = this.p;
    this.maybeReload();
    // equip a gun while moving (not knife unless rushing far, CS bots run with knife sometimes)
    if (!p.active.startsWith('grenade') && p.active !== 'c4' && !p.planting) {
      if (p.inv.primary && p.active !== 'primary' && (p.inv.primary.clip + p.inv.primary.reserve > 0)) g.switchTo(p, 'primary');
      else if (!p.inv.primary && p.inv.secondary && p.active !== 'secondary') g.switchTo(p, 'secondary');
    }
    // unscope when moving around
    const w = p.activeWeapon;
    if (w && w.zoom > 0 && this.mode !== 'hold') { p.ctl.attack2Pressed = true; }
    if (p.team === 't') this.tObjective(dt); else this.ctObjective(dt);
  }
  maybeReload() {
    const p = this.p, w = p.activeWeapon;
    if (w && w.def.mag && !w.reloading && w.reserve > 0 && w.clip < w.def.mag * 0.5 && (this.game.time - (this.lastSeenEnemyTime() || -99)) > 1.5) p.ctl.reload = true;
  }
  lastSeenEnemyTime() { let t = -99; for (const v of this.known.values()) t = Math.max(t, v.time); return t; }

  tObjective(dt) {
    const g = this.game, p = this.p, dir = this.director, bomb = g.bomb;
    const site = dir ? dir.site : 'A';
    // bomb dropped: nearest T fetches it
    if (bomb.state === 'dropped' && bomb.dropRef) {
      const ts = g.players.filter(q => q.team === 't' && q.alive && q.isBot);
      const nearest = ts.sort((a, b) => a.pos.distanceTo(bomb.dropRef.pos) - b.pos.distanceTo(bomb.dropRef.pos))[0];
      if (nearest === p) { this.goTo(bomb.dropRef.pos, dt, 'fetch'); return; }
    }
    if (bomb.state === 'planted') {
      // last seconds: get out of the blast radius (CS bots do this too)
      if (bomb.timeLeft < 6 && !bomb.defuser) {
        if (!this.fleePos) { const away = _a.subVectors(p.pos, bomb.pos).setY(0); if (away.lengthSq() < 1) away.set(0, 0, 1); away.normalize().multiplyScalar(1500).add(bomb.pos); this.fleePos = this.world.nav.nearestWalkable(away, 900) || this.world.spawns.t[0].pos; }
        this.goTo(this.fleePos, dt, 'flee'); return;
      }
      // someone is defusing → everybody pushes the bomb
      const defusing = bomb.defuser && (this.known.has(bomb.defuser.id) || (this.heard && this.heard.type === 'defuse' && g.time - this.heard.time < 3) || p.pos.distanceTo(bomb.pos) < 900);
      if (defusing) { this.goTo(bomb.pos, dt, 'stopdefuse'); return; }
      // post plant: hold a spot near the site that can see the bomb, watching the CT entries
      if (!this.postPlant) this.postPlant = this.pickPostPlant(bomb);
      if (this.goTo(this.postPlant.pos, dt, 'postplant')) {
        this.postT = (this.postT || 0) + dt;
        // alternate between watching the entry and checking the bomb
        const look = (this.postT % 7) < 5 ? this.postPlant.look : bomb.pos;
        if (this.heard && g.time - this.heard.time < 2.5 && this.heard.pos.distanceTo(bomb.pos) < 1600) this.hold(this.heard.pos, dt);
        else this.hold(look, dt);
        if (this.postPlant.crouch) p.input.duck = true;
      }
      return;
    }
    // carrying the bomb and on site: plant
    if (p.inv.c4) {
      if (!this.plantSpot) { const spots = this.world.botPoints.plant[site]; this.plantSpot = spots[Math.floor(Math.random() * spots.length)]; }
      const inSite = g.siteAt(p.pos);
      if ((dir.execute || this.atStage()) && (inSite && p.pos.distanceTo(this.plantSpot) < 140 || inSite && this.mode === 'planting')) {
        if (p.active !== 'c4') g.switchTo(p, 'c4');
        this.stop(); this.mode = 'planting';
        this.faceDir(_a.set(0, -0.6, -1), dt, 0.3);
        if (g.time >= p.drawEnd) p.ctl.attack = true;
        return;
      }
      if (dir.execute) { this.goTo(this.plantSpot, dt, 'toplant'); return; }
    }
    // follow the assigned route up to the staging point, wait for execute
    const asg = dir && dir.assign.get(p.id);
    if (!asg) { this.goTo(this.world.bombsites[site].center, dt, 'site'); return; }
    if (!this.path || this.pathKey !== asg.route) {
      const pts = this.world.botPoints.routes[asg.route];
      const stageIdx = Math.min(asg.stage, pts.length - 1);
      const startIdx = this.closestRouteIndex(pts);
      const wp = [p.pos.clone(), ...pts.slice(startIdx + 1, stageIdx + 1)];
      this.path = this.world.nav.findRoute(wp) || [pts[stageIdx].clone()];
      this.pathIdx = 0; this.pathKey = asg.route; this.stagePos = pts[stageIdx];
      this.finalPts = pts.slice(stageIdx);
    }
    // execute trigger
    if (!dir.execute) {
      const tl = g.timer;
      const myGroup = g.players.filter(q => q.team === 't' && q.alive && q.isBot);
      const ready = myGroup.filter(q => q.brain && q.brain.stageReached).length;
      if (dir.rush || tl < dir.executeAt || ready >= Math.max(1, myGroup.length - 1) || (this.stageReached && this.waitT > 12)) { dir.execute = true; g.emit('radio', p, 'Go go go!'); }
    }
    if (!dir.execute) {
      if (this.followPath(dt)) { this.stageReached = true; this.waitT += dt; this.hold(this.finalPts[1] || this.world.bombsites[site].center, dt); this.prepUtility(site); }
      return;
    }
    // execute: go onto site; throw utility at the start
    if (!this.execPath) {
      this.throwUtility(site);
      const target = this.world.botPoints.plant[site][Math.floor(Math.random() * 4)];
      this.execPath = true; this.path = this.world.nav.findRoute([p.pos.clone(), ...this.finalPts.slice(1), target]) || [target.clone()]; this.pathIdx = 0;
    }
    if (this.grenadeTask) { this.doGrenade(dt); return; }
    if (this.followPath(dt)) {
      // on site: clear angles (look toward CT entries)
      const looks = site === 'A' ? ['CT Spawn', 'A Short hold', 'A Goose'] : ['B Doors', 'Window', 'B Back Plat'];
      const lp = dir.lookPoint(looks[p.slotIndex % 2 === 0 ? 0 : 1]) || dir.holdPoint(looks[2]);
      this.hold(lp || this.world.bombsites[site].center, dt);
    }
  }
  pickPostPlant(bomb) {
    const g = this.game, p = this.p, dir = this.director, nav = this.world.nav;
    const opts = POSTPLANT[bomb.site] || POSTPLANT.A;
    const o = opts[p.slotIndex % opts.length];
    const look = dir.lookPoint(o[1]) || bomb.pos;
    // sample walkable spots 250–750 u from the bomb that have line of sight to it; prefer ones near the named hold
    const anchor = dir.holdPoint(o[0]) || bomb.pos;
    let best = null, bestScore = -Infinity;
    const eye = new THREE.Vector3(), tgt = new THREE.Vector3(bomb.pos.x, bomb.pos.y + 12, bomb.pos.z), d = new THREE.Vector3();
    for (let i = 0; i < 28; i++) {
      const c = nav.randomPointNear(i < 14 ? anchor : bomb.pos, i < 14 ? 300 : 750); if (!c) continue;
      const dist = c.distanceTo(bomb.pos); if (dist < 220 || dist > 900) continue;
      eye.set(c.x, c.y + 64, c.z); d.subVectors(tgt, eye); const L = d.length(); d.divideScalar(L);
      if (this.world.raycast(eye, d, L - 8)) continue;
      // taken by a teammate already?
      if (g.players.some(q => q !== p && q.brain && q.brain.postPlant && q.brain.postPlant.pos.distanceTo(c) < 150)) continue;
      const score = -c.distanceTo(anchor) * 0.6 - Math.abs(dist - 450) * 0.3 + Math.random() * 80;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return { pos: best || nav.randomPointNear(bomb.pos, 300) || bomb.pos.clone(), look, crouch: Math.random() < 0.35 };
  }
  closestRouteIndex(pts) {
    let bi = 0, bd = Infinity;
    pts.forEach((q, i) => { const d = q.distanceTo(this.p.pos); if (d < bd) { bd = d; bi = i; } });
    return bi;
  }
  atStage() { return this.stageReached; }

  ctObjective(dt) {
    const g = this.game, p = this.p, dir = this.director, bomb = g.bomb;
    if (bomb.state === 'planted') {
      // retake + defuse; give up if impossible
      const need = (p.defuser ? RULES.defuseTimeKit : RULES.defuseTime) + p.pos.distanceTo(bomb.pos) / 230 + 0.5;
      if (bomb.timeLeft < need && !p.defusing) { this.saving = true; }
      if (this.saving) { this.goTo(this.world.spawns.ct[p.slotIndex % 5].pos, dt, 'save'); return; }
      const others = g.players.filter(q => q.team === 'ct' && q.alive && q !== p);
      const someoneDefusing = bomb.defuser && bomb.defuser !== p;
      const dist = p.pos.distanceTo(bomb.pos);
      if (!someoneDefusing && dist < 55) { this.keepDefusing(); return; }
      if (someoneDefusing && dist < 400) { this.hold(this.heard ? this.heard.pos : this.world.bombsites[bomb.site].center, dt); return; }
      this.goTo(bomb.pos, dt, 'retake');
      return;
    }
    const asg = dir && dir.assign.get(p.id);
    let holdName = asg ? asg.hold : 'CT Spawn';
    // rotation on alert
    if (dir.alert && asg && asg.group !== dir.alert && !dir.rotated.has(p.id) && g.time - dir.lastAlertTime < 20) {
      const rotating = [...dir.rotated].length;
      if (rotating < 2 || asg.group === 'mid') {
        dir.rotated.add(p.id);
        const names = CT_GROUPS[dir.alert];
        asg.hold = names[Math.floor(Math.random() * names.length)]; asg.group = dir.alert; this.path = null;
        if (Math.random() < 0.5) g.emit('radio', p, 'Rotating to ' + dir.alert + '.');
      }
      holdName = asg.hold;
    }
    const hp = dir.holdPoint(holdName) || this.world.spawns.ct[0].pos;
    if (!this.holdPos || this.holdName !== holdName) { this.holdName = holdName; this.holdPos = this.world.nav.randomPointNear(hp, 70) || hp.clone(); this.path = null; }
    if (this.goTo(this.holdPos, dt, 'hold')) {
      // every so often shuffle to a slightly different spot on the same angle (humans don't stand on one pixel)
      this.holdRepoT = (this.holdRepoT || 0) + dt;
      if (this.holdRepoT > 14 + this.pers.walker * 20 && !(this.heard && this.game.time - this.heard.time < 4)) {
        this.holdRepoT = 0; const np = this.world.nav.randomPointNear(hp, 80); if (np) { this.holdPos = np; this.path = null; }
      }
      const look = dir.lookPoint(CT_LOOK[holdName]) || this.world.bombsites.A.center;
      // react to sounds: look at heard position
      if (this.heard && this.game.time - this.heard.time < 3) this.hold(this.heard.pos, dt);
      else this.hold(look, dt);
      this.mode = 'hold';
      // AWP: scope while holding
      const w = p.activeWeapon;
      if (w && w.def.scope && w.zoom === 0 && !w.reloading && Math.random() < dt * 0.8) p.ctl.attack2Pressed = true;
    }
  }
  keepDefusing() {
    const g = this.game, p = this.p;
    this.stop(); p.input.duck = true;
    g.beginDefuse(p);
    p._defuseHeld = g.time;
    this.aimTowards(_a.copy(g.bomb.pos), 1 / 60, 0.5);
  }

  // ---------------------------------------------------------------- utility usage
  prepUtility() { }
  throwUtility(site) {
    const p = this.p, g = this.game, dir = this.director;
    const names = SITE_SMOKES[site] || [];
    if (p.inv.grenades.includes('smokegrenade')) {
      const name = names.find(n => !dir.smokesThrown.has(n));
      const pt = name && this.world.botPoints.smokes[name];
      if (pt && pt.distanceTo(p.pos) < 1800) { dir.smokesThrown.add(name); this.grenadeTask = { id: 'smokegrenade', target: pt, t: 0 }; return; }
    }
    if (p.inv.grenades.includes('flashbang') && Math.random() < 0.7) {
      const site3 = this.world.bombsites[site].center;
      if (site3.distanceTo(p.pos) < 1600) { this.grenadeTask = { id: 'flashbang', target: _a.copy(site3).setY(site3.y + 260).clone(), t: 0 }; return; }
    }
    if ((p.inv.grenades.includes('molotov') || p.inv.grenades.includes('incgrenade')) && Math.random() < 0.5) {
      const looks = site === 'A' ? 'A Goose' : 'B Back Plat';
      const pt = dir.holdPoint(looks); if (pt && pt.distanceTo(p.pos) < 1400) { this.grenadeTask = { id: p.inv.grenades.includes('molotov') ? 'molotov' : 'incgrenade', target: pt.clone(), t: 0 }; }
    }
  }
  doGrenade(dt) {
    const g = this.game, p = this.p, task = this.grenadeTask;
    task.t += dt;
    if (task.t > 4 || !p.inv.grenades.includes(task.id)) { this.grenadeTask = null; return; }
    this.stop();
    const want = 'grenade:' + task.id;
    if (p.active !== want) { g.switchTo(p, want); return; }
    if (g.time < p.drawEnd) return;
    // solve throw angle
    const sol = solveThrow(p.eyePos(_a), task.target, 675);
    if (!sol) { this.grenadeTask = null; return; }
    this.turnTo(sol.yaw, sol.pitch, dt, 1.5);
    const ok = Math.abs(angDiff(p.yaw, sol.yaw)) < 0.03 && Math.abs(p.pitch - sol.pitch) < 0.03;
    if (!task.pulled) { p.ctl.attack = true; task.pulled = true; return; }
    if (!ok) { p.ctl.attack = true; return; }
    p.ctl.attack = false;   // release → throw
    this.grenadeTask = null;
  }

  // ---------------------------------------------------------------- buying (CS bot economy)
  doBuy(dt) {
    if (this.buyDone) return;
    this.buyT -= dt; if (this.buyT > 0) return;
    this.buyDone = true;
    const g = this.game, p = this.p, t = p.team;
    if (!g.canBuy(p)) return;
    const buy = (id) => g.buy(p, id).ok;
    const m = () => p.money;
    const pistolRound = g.round === 1 || g.round === RULES.halftimeAfter + 1;
    const teamMoney = g.players.filter(q => q.team === t).reduce((s, q) => s + q.money, 0) / 5;
    if (pistolRound) {
      const r = Math.random();
      if (r < 0.45) buy('vest');
      else if (r < 0.7) { buy('p250'); if (Math.random() < 0.6) buy('flashbang'); }
      else if (r < 0.85) { buy(t === 't' ? 'tec9' : 'fiveseven'); }
      else { buy('flashbang'); buy('smokegrenade'); }
      if (t === 'ct' && m() >= 400 && Math.random() < 0.3) buy('defuser');
      return;
    }
    const rifle = t === 't' ? 'ak47' : (Math.random() < 0.5 ? 'm4a1_s' : 'm4a4');
    const rifleP = WEAPONS[rifle].price;
    const hasPrimary = !!p.inv.primary;
    const full = rifleP + 1000 + (t === 'ct' ? 400 : 0);
    const awpBot = p.slotIndex === 2 && m() >= 4750 + 1000 + 300;
    const eco = teamMoney < 2200 && m() < full && !hasPrimary;
    if (eco) {
      // eco: maybe a pistol upgrade or nothing; save
      if (m() > 1400 && Math.random() < 0.4) buy(Math.random() < 0.5 ? 'p250' : (t === 't' ? 'tec9' : 'fiveseven'));
      if (m() > 1500 && Math.random() < 0.3) buy('deagle');
      return;
    }
    if (!hasPrimary) {
      if (awpBot) buy('awp');
      else if (m() >= full) buy(rifle);
      else if (m() >= 2900) buy(t === 't' ? (Math.random() < 0.5 ? 'galilar' : 'ak47') : (Math.random() < 0.5 ? 'famas' : 'm4a1_s'));
      else if (m() >= 2000) buy(t === 't' ? (Math.random() < 0.5 ? 'galilar' : 'mac10') : (Math.random() < 0.5 ? 'famas' : 'mp9'));
      else if (m() >= 1300) buy(t === 't' ? 'mac10' : 'mp9');
    }
    if (m() >= 1000 && (p.armor < 100 || !p.helmet)) buy('vesthelm'); else if (m() >= 650 && p.armor < 100) buy('vest');
    if (t === 'ct' && !p.defuser && m() >= 400 && Math.random() < 0.75) buy('defuser');
    const nades = t === 't' ? ['smokegrenade', 'flashbang', 'molotov', 'hegrenade', 'flashbang'] : ['smokegrenade', 'flashbang', 'hegrenade', 'incgrenade', 'flashbang'];
    for (const n of nades) { if (m() >= WEAPONS[n].price + 100 && Math.random() < 0.6) buy(n); }
    if (!p.inv.primary && m() >= 700 && Math.random() < 0.5) buy('deagle');
  }

  // ---------------------------------------------------------------- movement helpers
  goTo(target, dt, tag) {
    const p = this.p;
    if (!this.goal || this.goal.distanceTo(target) > 40 || !this.path || this.pathTag !== tag) {
      this.goal = target.clone(); this.pathTag = tag;
      this.path = this.world.nav.findPath(p.pos, target) || [target.clone()]; this.pathIdx = 0;
    }
    return this.followPath(dt);
  }
  followPath(dt) {
    const p = this.p, path = this.path;
    if (!path || !path.length) { this.stop(); return true; }
    // advance waypoints
    while (this.pathIdx < path.length) {
      const wpt = path[this.pathIdx];
      const dx = wpt.x - p.pos.x, dz = wpt.z - p.pos.z;
      const rr = this.pathIdx === path.length - 1 ? 20 : (this.rawPath ? 14 : 26);
      if (dx * dx + dz * dz < rr * rr && Math.abs(wpt.y - p.pos.y) < 60) this.pathIdx++;
      else break;
    }
    if (this.pathIdx >= path.length) { this.stop(); this.rawPath = false; return true; }
    const wpt = path[this.pathIdx];
    // pure-pursuit steering: blend toward the following waypoint as we approach, so bots round corners in curves
    const dW = Math.hypot(wpt.x - p.pos.x, wpt.z - p.pos.z);
    const nxt = path[this.pathIdx + 1];
    const tgt = _c.set(wpt.x, wpt.y, wpt.z);
    if (nxt && !this.rawPath && dW < 90) tgt.lerp(nxt, (1 - dW / 90) * 0.55);
    const want = _a.set(tgt.x - p.pos.x, 0, tgt.z - p.pos.z); if (want.lengthSq() > 1e-6) want.normalize();
    if (this.backT > 0) { this.backT -= dt; want.copy(this.backDir); }
    // turn the travel direction smoothly instead of snapping (≈ 7 rad/s)
    if (this.moveVec.lengthSq() < 0.01 || p.horizontalSpeed() < 40) this.moveVec.copy(want);
    else {
      const a0 = Math.atan2(this.moveVec.x, this.moveVec.z), a1 = Math.atan2(want.x, want.z);
      const da = angDiff(a1, a0), st = Math.sign(da) * Math.min(Math.abs(da), 7 * dt);
      this.moveVec.set(Math.sin(a0 + st), 0, Math.cos(a0 + st));
    }
    this.moveDir(this.moveVec, this.walkWanted && !this.rawPath);
    this.naturalLook(dt, path);
    // stuck detection
    this.progressT += dt;
    if (this.progressT > 0.7) {
      const moved = this.lastProgress.distanceTo(p.pos);
      if (moved < 18) {
        this.stuckT += this.progressT;
        if (this.stuckT > 0.7 && !this.jumpedStuck) { p.input.jump = true; this.jumpedStuck = true; }
        if (this.stuckT > 1.4) {
          // physically stuck: remember the spot (all bots avoid it from now on), back off and re-path along raw nav edges
          this.world.nav.penalize(p.pos, 40, 500);
          const back = _b.set(this.lastProgress.x - p.pos.x, 0, this.lastProgress.z - p.pos.z);
          if (back.lengthSq() < 4) back.set(Math.random() - 0.5, 0, Math.random() - 0.5);
          this.backDir = back.normalize().clone(); this.backT = 0.35;
          const goal = this.goal || path[path.length - 1];
          this.path = this.world.nav.findPath(p.pos, goal, { raw: true }); this.pathIdx = 0; this.rawPath = true;
          if (!this.path || !this.path.length) { this.path = null; this.goal = null; }
          this.stuckT = 0; this.jumpedStuck = false;
        }
      }
      else { this.stuckT = 0; this.jumpedStuck = false; }
      this.lastProgress.copy(p.pos); this.progressT = 0;
    }
    return false;
  }
  moveDir(dir, walk) {
    const p = this.p;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    p.input.fwd = dir.x * fx + dir.z * fz;
    p.input.side = dir.x * rx + dir.z * rz;
    p.input.walk = !!walk;
  }
  // Where to look while travelling: pre-aim upcoming corners, glance into open side lanes, react to sounds.
  naturalLook(dt, path) {
    const p = this.p, g = this.game;
    if ((this.heard && g.time - this.heard.time < 1.5 && this.heard.type !== 'step') || this.alertT > 0) {
      this.alertT = (this.alertT || 0) - dt;
      this.aimTowards(this.hasLook ? this.lookAt : _b.copy(this.heard.pos).setY(this.heard.pos.y + 55), dt, 0.8);
      return;
    }
    const eye = p.eyePos(_d);
    // upcoming corner: if the path bends sharply within ~200 u, pre-aim along the next leg
    const i = this.pathIdx, w0 = path[i], w1 = path[i + 1];
    let corner = null;
    if (w0 && w1) {
      const d0 = Math.hypot(w0.x - p.pos.x, w0.z - p.pos.z);
      const ax = w0.x - p.pos.x, az = w0.z - p.pos.z, bx = w1.x - w0.x, bz = w1.z - w0.z;
      const cosT = (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz) + 1e-6);
      if (d0 < 220 && cosT < 0.8) { const L = Math.hypot(bx, bz) + 1e-6; corner = _b.set(w0.x + bx / L * 260, w0.y + 60, w0.z + bz / L * 260); }
    }
    this.lookT -= dt;
    if (this.lookT <= 0) {
      // pick the next thing to look at
      const r = Math.random();
      if (r < 0.32 * this.pers.curious) {
        // glance into an open side lane: probe a few directions, take the most open one
        const base = Math.atan2(-this.moveVec.x, -this.moveVec.z) || p.yaw;
        let best = null, bestD = 0;
        for (let k = 0; k < 5; k++) {
          const a = base + (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 1.2);
          const dir = _c.set(-Math.sin(a), 0, -Math.cos(a));
          const hit = this.world.raycast(eye, dir, 1400); const dist = hit ? hit.distance : 1400;
          if (dist > bestD) { bestD = dist; best = a; }
        }
        if (best !== null && bestD > 300) { this.lookMode = 'side'; this.lookPt.set(eye.x - Math.sin(best) * Math.min(bestD, 900), eye.y - 4, eye.z - Math.cos(best) * Math.min(bestD, 900)); this.lookT = 0.5 + Math.random() * 0.9; }
        else { this.lookMode = 'ahead'; this.lookT = 1 + Math.random() * 1.5; }
      } else { this.lookMode = 'ahead'; this.lookT = 1.2 + Math.random() * 2.2; }
    }
    let lp;
    if (corner) lp = corner;                                  // pre-aim beats everything else
    else if (this.lookMode === 'side') lp = this.lookPt;
    else { const la = path[Math.min(path.length - 1, i + 2)]; lp = _b.set(la.x, la.y + 60, la.z); }
    this.aimTowards(lp, dt, this.lookMode === 'side' ? 0.7 : 0.5);
  }
  hold(lookPos, dt) {
    const p = this.p, g = this.game;
    this.stop();
    if (!lookPos) return;
    // sweep between a few nearby angles instead of staring at one pixel
    this.holdOffT -= dt;
    if (this.holdOffT <= 0) { const opts = [0, 0, -0.18, 0.18, -0.35, 0.3]; this.holdOffTarget = opts[Math.floor(Math.random() * opts.length)] * (0.6 + this.pers.curious * 0.6); this.holdOffT = 1.5 + Math.random() * 3; }
    this.holdOff += ((this.holdOffTarget || 0) - this.holdOff) * Math.min(1, dt * 2.5);
    // little A/D jiggles and crouch changes, like a human holding an angle
    this.jigT -= dt;
    if (this.jigDur > 0) {
      this.jigDur -= dt;
      const rx = Math.cos(p.yaw) * this.jigDir, rz = -Math.sin(p.yaw) * this.jigDir;
      const nav = this.world.nav;
      if (nav && nav.isWalkable(p.pos.x + rx * 40, p.pos.z + rz * 40, p.pos.y + 30)) p.input.side = this.jigDir; else this.jigDur = 0;
    } else if (this.jigT <= 0 && !(p.activeWeapon && p.activeWeapon.zoom > 0)) {
      this.jigT = 2.5 + Math.random() * 6 * (1.2 - this.pers.jiggle);
      if (Math.random() < 0.35 + this.pers.jiggle * 0.5) { this.jigDir = Math.random() < 0.5 ? -1 : 1; this.jigDur = 0.12 + Math.random() * 0.22; }
    }
    this.crouchT -= dt;
    if (this.crouchT <= 0) { this.crouchT = 2 + Math.random() * 5; this.crouching = Math.random() < this.pers.crouch * 0.45; }
    if (this.crouching) p.input.duck = true;
    const to = _c.subVectors(lookPos, p.eyePos(_d));
    const yaw = Math.atan2(-to.x, -to.z) + this.holdOff;
    const pitch = Math.atan2(to.y + 50, Math.hypot(to.x, to.z)) * 0.5 + Math.sin(g.time * 0.37 + this.wob) * 0.015;
    this.turnTo(yaw, pitch, dt, 0.4);
  }
  aimTowards(pos, dt, speedMul = 1) {
    const p = this.p; const to = _c.subVectors(pos, p.eyePos(_d));
    this.turnTo(Math.atan2(-to.x, -to.z), Math.atan2(to.y, Math.hypot(to.x, to.z)), dt, speedMul);
  }
  faceDir(dir, dt, speedMul) { this.turnTo(Math.atan2(-dir.x, -dir.z), Math.atan2(dir.y, Math.hypot(dir.x, dir.z)), dt, speedMul); }
  // Human-like aim: a slightly under-damped spring (accelerates, decelerates, tiny settle) with a speed cap and hand wobble.
  turnTo(yaw, pitch, dt, speedMul = 1) {
    const p = this.p, D = this.D, g = this.game;
    dt = Math.min(dt, 1 / 30);
    const w = Math.max(5, D.turn * 1.55 * Math.max(0.35, speedMul));     // natural frequency
    const k = w * w, c = 2 * w * 0.82;
    const wob = 0.0035 * (1 + p.horizontalSpeed() / 250);
    const ey = angDiff(yaw + Math.sin(g.time * 1.7 + this.wob) * wob, p.yaw);
    const ep = (pitch + Math.sin(g.time * 2.3 + this.wob * 1.3) * wob * 0.6) - p.pitch;
    this.yv += (k * ey - c * this.yv) * dt;
    this.pv += (k * ep - c * this.pv) * dt;
    const vmax = D.turn * 2.4 * Math.max(0.3, speedMul);
    this.yv = Math.max(-vmax, Math.min(vmax, this.yv)); this.pv = Math.max(-vmax * 0.6, Math.min(vmax * 0.6, this.pv));
    p.yaw += this.yv * dt; p.pitch = Math.max(-1.5, Math.min(1.5, p.pitch + this.pv * dt));
  }
  idleLook(dt) { }
}

// ---------------------------------------------------------------- helpers
export function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }
// grenade throw solver: returns view yaw/pitch so that a full-strength throw lands near target
export function solveThrow(from, to, v) {
  const G = 320;
  const dx = to.x - from.x, dz = to.z - from.z, dy = to.y - from.y;
  const dist = Math.hypot(dx, dz);
  const v2 = v * v, disc = v2 * v2 - G * (G * dist * dist + 2 * dy * v2);
  if (disc < 0) return null;
  const ang = Math.atan((v2 - Math.sqrt(disc)) / (G * dist));   // low arc
  // invert CS's 10° upward bias: final = p + 10*(90-|p|)/90
  const finalDeg = ang / D2R;
  let pDeg = (finalDeg - 10) / (1 - 10 / 90);
  if (pDeg < 0) pDeg = (finalDeg - 10) / (1 + 10 / 90);
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.max(-1.4, Math.min(1.4, pDeg * D2R)) };
}
