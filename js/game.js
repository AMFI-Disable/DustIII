// game.js — CS2 competitive rules: rounds, economy, buying, shooting (spread, spray patterns, wallbangs),
// damage & armor, grenades, the bomb, dropped weapons, kill feed & stats.
import * as THREE from 'three';
import { WEAPONS, EQUIPMENT, RULES, HITGROUP_MULT, SLOT } from './weapon_data.js';
import { Player, MOVE } from './player.js';
import { computeFlash } from './fx.js';

const BOT_NAMES = ['Albert', 'Allen', 'Bert', 'Bob', 'Cecil', 'Clarence', 'Elliot', 'Elmer', 'Ernie', 'Eugene', 'Fergus', 'Ferris',
  'Frank', 'Frasier', 'Fred', 'George', 'Graham', 'Harvey', 'Irwin', 'Larry', 'Lester', 'Marvin', 'Neil', 'Niles', 'Oliver',
  'Opie', 'Ryan', 'Toby', 'Ulric', 'Ulysses', 'Uri', 'Waldo', 'Wally', 'Walt', 'Wesley', 'Yanni', 'Yogi', 'Yuri'];

const D2R = Math.PI / 180;
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');

// ---------------------------------------------------------------- spray patterns (bullet offset deltas per shot, degrees: [yaw(+left), pitch(+up)])
const AK_PATTERN = [[0, 0], [0.0, 0.55], [0.05, 0.75], [-0.05, 0.9], [0.05, 1.0], [0.1, 0.95], [0.15, 0.8], [0.25, 0.55], [-0.15, 0.45], [-0.6, 0.3],
  [-0.75, 0.18], [-0.5, 0.1], [-0.3, 0.06], [0.3, 0.1], [0.65, 0.06], [0.8, -0.04], [0.6, 0.06], [0.35, 0], [0.55, 0.05], [0.3, 0.05],
  [-0.2, 0], [-0.5, 0.05], [-0.65, 0], [-0.55, 0.05], [-0.35, 0], [-0.1, 0.05], [0.2, 0], [0.4, 0.05], [0.5, 0], [0.25, 0]];
const M4_PATTERN = [[0, 0], [0.0, 0.4], [-0.05, 0.55], [0.05, 0.65], [0.0, 0.7], [-0.1, 0.65], [-0.15, 0.55], [0.3, 0.4], [0.45, 0.25], [0.5, 0.15],
  [0.35, 0.1], [0.1, 0.06], [-0.3, 0.06], [-0.5, 0.04], [-0.55, 0.02], [-0.4, 0.04], [-0.2, 0], [0.2, 0.03], [0.4, 0.02], [0.45, 0],
  [0.3, 0.02], [0.05, 0], [-0.25, 0.02], [-0.4, 0], [-0.35, 0.02], [-0.1, 0], [0.15, 0.02], [0.3, 0], [0.3, 0.02], [0.1, 0]];
function genericPattern(seed, n, climb, sway) {
  const p = [[0, 0]]; let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let dir = rnd() < 0.5 ? -1 : 1;
  for (let i = 1; i < n; i++) {
    const up = climb * (i < 8 ? 1 - i * 0.07 : 0.15) * (0.8 + rnd() * 0.4);
    if (i > 6 && rnd() < 0.18) dir = -dir;
    const side = (i < 5 ? (rnd() - 0.5) * 0.15 : dir * sway * (0.5 + rnd())) ;
    p.push([side, up]);
  }
  return p;
}
const PATTERNS = {};
function patternFor(id) {
  if (PATTERNS[id]) return PATTERNS[id];
  const d = WEAPONS[id];
  let pat;
  if (id === 'ak47') pat = AK_PATTERN;
  else if (id === 'm4a4') pat = M4_PATTERN;
  else if (id === 'm4a1_s') pat = M4_PATTERN.map(([a, b]) => [a * 0.85, b * 0.85]);
  else {
    let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const k = (d.recoil || 20) / 30;
    pat = genericPattern(h % 100000 + 7, Math.max(30, d.mag || 30), 0.75 * k, 0.4 * k);
  }
  PATTERNS[id] = pat; return pat;
}

// ---------------------------------------------------------------- ray / shape helpers
function raySphere(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z, cc = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - cc; if (h < 0) return -1;
  const t = -b - Math.sqrt(h); return t >= 0 ? t : (cc < 0 ? 0 : -1);
}
function rayCapsule(o, d, a, b, r) {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const oax = o.x - a.x, oay = o.y - a.y, oaz = o.z - a.z;
  const baba = bax * bax + bay * bay + baz * baz;
  if (baba < 1e-6) return raySphere(o, d, a, r);
  const bard = bax * d.x + bay * d.y + baz * d.z, baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = d.x * oax + d.y * oay + d.z * oaz, oaoa = oax * oax + oay * oay + oaz * oaz;
  const A = baba - bard * bard, B = baba * rdoa - baoa * bard, C = baba * oaoa - baoa * baoa - r * r * baba;
  const h = B * B - A * C;
  if (h >= 0 && A > 1e-8) {
    const t = (-B - Math.sqrt(h)) / A, y = baoa + t * bard;
    if (y > 0 && y < baba && t >= 0) return t;
  }
  const t1 = raySphere(o, d, a, r), t2 = raySphere(o, d, b, r);
  if (t1 < 0) return t2; if (t2 < 0) return t1; return Math.min(t1, t2);
}

const DOOR_GROUPS = new Set([25, 13, 16, 19, 18, 21, 26, 7, 4, 5, 17, 14, 20, 9, 10]);

// ================================================================== Game
export class Game {
  constructor(ctx) {
    this.ctx = ctx;                 // { world, fx, audio, hud, createCharacter, createWeaponModel, emit }
    this.world = ctx.world; this.fx = ctx.fx; this.audio = ctx.audio; this.hud = ctx.hud;
    this.players = []; this.human = null;
    this.time = 0;
    this.phase = 'idle'; this.timer = 0; this.round = 0; this.score = { ct: 0, t: 0 };
    this.history = []; this.lossCounter = { ct: 1, t: 1 };
    this.bomb = { state: 'none', carrier: null, pos: new THREE.Vector3(), model: null, light: null, timeLeft: 0, site: null, defuser: null, defuseProgress: 0, nextBeep: 0, planter: null };
    this.drops = []; this.grenades = []; this.fires = []; this.smokes = []; this.decoys = [];
    this.noises = [];               // recent sounds for bot hearing
    this.difficulty = 'normal';
    this.buyTimeLeft = 0; this.roundStartTime = 0; this.roundOverReason = null;
    this.listeners = {};
    this.spotted = { ct: new Set(), t: new Set() };
    this.matchOver = false;
    this.mvpThisRound = null;
    this.warmup = false;
    this.dmgLog = new Map();         // 'attackerId>victimId' -> { dmg, hits } this round (CS damage report)
  }
  on(ev, fn) { (this.listeners[ev] || (this.listeners[ev] = [])).push(fn); }
  emit(ev, ...a) { const l = this.listeners[ev]; if (l) for (const f of l) f(...a); }
  sound(name, opts = {}, src = null) {
    // local player's own sounds are 2D; everyone else positional
    if (src && src === this.viewTarget) { const o = { ...opts }; delete o.pos; return this.audio.play(name, o); }
    return this.audio.play(name, opts);
  }
  noise(pos, radius, type, player) { this.noises.push({ pos: pos.clone(), radius, type, player, team: player ? player.team : null, time: this.time }); }

  // ---------------------------------------------------------------- setup
  startMatch({ side = 'ct', difficulty = 'normal' }) {
    this.difficulty = difficulty;
    for (const p of this.players) this.removePlayer(p);
    this.players = [];
    const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    let ni = 0;
    if (side === 'auto') side = Math.random() < 0.5 ? 'ct' : 't';
    for (const team of ['ct', 't']) {
      for (let i = 0; i < 5; i++) {
        const isHuman = team === side && i === 0;
        const p = new Player({ id: this.players.length, name: isHuman ? 'You' : names[ni++], team, isBot: !isHuman });
        p.slotIndex = i; p.variant = i;
        p.events = (ev, a) => this.onPlayerEvent(p, ev, a);
        this.players.push(p);
        if (isHuman) this.human = p;
      }
    }
    this.viewTarget = this.human;
    this.score = { ct: 0, t: 0 }; this.round = 0; this.history = []; this.lossCounter = { ct: 1, t: 1 };
    this.matchOver = false; this.half = 1;
    for (const p of this.players) { p.money = RULES.startMoney; p.stats = { k: 0, d: 0, a: 0, dmg: 0, hs: 0, mvp: 0, score: 0, roundKills: 0, roundDmg: 0 }; this.makeCharacter(p); p.alive = false; }
    this.emit('match_start');
    this.startRound(true);
  }
  makeCharacter(p) {
    if (p.char) { this.world.scene.remove(p.char.root); p.char.dispose(); }
    p.char = this.ctx.createCharacter(p.team, p.variant % 5);
    p.char.root.scale.setScalar(39.37);
    p.char.dropWeaponOnDeath = false;
    this.world.addShadowCaster(p.char.root);
    p.weaponModels.clear();
  }
  removePlayer(p) { if (p.char) { this.world.scene.remove(p.char.root); p.char.dispose(); p.char = null; } }
  charWeapon(p) {
    if (!p.char) return;
    const id = p.activeId;
    if (!id) { p.char.setWeapon(null, 'rifle'); return; }
    let m = p.weaponModels.get(id);
    if (!m) {
      m = this.ctx.createWeaponModel(id, { lod: 'low' });
      m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; if (o.material && !o.material.userData.__wp) { this.world.patchMaterial(o.material); o.material.userData.__wp = 1; } } });
      p.weaponModels.set(id, m);
    }
    const d = WEAPONS[id];
    p.char.setWeapon(m, d ? d.hold : 'rifle');
  }

  // ---------------------------------------------------------------- rounds
  startRound(first = false) {
    this.round++;
    this.fx.clear();
    for (const g of this.grenades) this.removeGrenade(g, true); this.grenades = [];
    for (const f of this.fires) { f.handle.extinguish?.(); f.loop?.stop(0.2); } this.fires = [];
    for (const s of this.smokes) { s.loop?.stop(0.3); } this.smokes = [];
    for (const d of this.drops) this.world.scene.remove(d.model); this.drops = [];
    this.decoys = [];
    if (this.bomb.model) { this.world.scene.remove(this.bomb.model); this.bomb.model = null; }
    if (this.bomb.light) { this.bomb.light.dispose(); this.bomb.light = null; }
    this.bombMusic?.stop(0.5); this.bombMusic = null;
    this.bomb.state = 'carried'; this.bomb.carrier = null; this.bomb.defuser = null; this.bomb.defuseProgress = 0; this.bomb.planter = null;
    this.noises = []; this.dmgLog.clear();
    this.spotted.ct.clear(); this.spotted.t.clear();
    this.roundOverReason = null; this.mvpThisRound = null;
    const spawnsUsed = { ct: 0, t: 0 };
    const tlist = this.players.filter(p => p.team === 't');
    for (const p of this.players) {
      const sp = this.world.spawns[p.team][spawnsUsed[p.team]++ % 5];
      const survived = p.alive && !first;
      if (!survived) {
        p.resetInventory();
        p.give(p.team === 't' ? 'knife_t' : 'knife_ct');
        p.give(p.team === 't' ? 'glock' : (this.loadoutPref?.usp_s === 'p2000' ? 'p2000' : 'usp_s'));
        if (first) { p.armor = 0; p.helmet = false; } else { p.armor = 0; p.helmet = false; }
        p.defuser = false;
        p.active = 'secondary';
      } else {
        // survivors keep everything; refill not done (CS keeps current ammo)
        p.inv.c4 = false;
        if (!p.inv.knife) p.give(p.team === 't' ? 'knife_t' : 'knife_ct');
        for (const k of ['primary', 'secondary', 'taser']) { const w = p.inv[k]; if (w) { w.reloading = false; w.shellState = null; w.zoom = 0; w.rezoom = 0; w.boughtThisRound = false; w.burstLeft = 0; w.clip = w.def.mag || 0; w.reserve = w.def.reserve || 0; w.recoilIdx = 0; w.accFire = 0; } }   // new round: full ammo
        p.active = p.inv.primary ? 'primary' : (p.inv.secondary ? 'secondary' : 'knife');
      }
      p.hp = 100; p.alive = true; p.pos.copy(sp.pos); p.vel.set(0, 0, 0); p.yaw = sp.yaw; p.pitch = 0;
      p.duck = 0; p.ducking = false; p.onGround = true; p.stamina = 0; p.velMod = 1; p.punch.p = p.punch.y = 0;
      p.flash = 0; p.flashDur = 0; p.planting = 0; p.defusing = 0; p.damageBy.clear(); p.spotted = 0;
      p.stats.roundKills = 0; p.stats.roundDmg = 0; p.boughtItems = [];
      p.lastShotTime = -9; p.lastHurtTime = -9;
      p.spawnPos = sp.pos.clone();
      if (p.char) { p.char.revive(); p.char.root.position.copy(p.pos); p.char.setVisible(p !== this.viewTarget || !this.firstPerson); }
      this.charWeapon(p);
      p.brain?.onRoundStart?.();
    }
    // C4 to a random T (bots prefer not to give it to the human unless he's alone… CS gives it randomly)
    const carrier = tlist[Math.floor(Math.random() * tlist.length)];
    carrier.inv.c4 = true; this.bomb.carrier = carrier;
    this.phase = 'freeze'; this.timer = RULES.freezeTime; this.buyTimeLeft = RULES.freezeTime + RULES.buyTime;
    this.roundStartTime = this.time;
    this.viewTarget = this.human; this.firstPerson = true;
    const lastOfHalf = this.round === RULES.halftimeAfter, matchPoint = this.score.ct === RULES.winRounds - 1 || this.score.t === RULES.winRounds - 1;
    this.emit('round_start', { round: this.round, lastOfHalf, matchPoint, first });
  }
  endRound(winner, reason) {
    if (this.phase === 'over') return;
    this.phase = 'over'; this.timer = RULES.roundEndDelay; this.roundOverReason = reason;
    this.score[winner]++;
    this.history.push({ winner, reason });
    const loser = winner === 'ct' ? 't' : 'ct';
    // ---- economy
    const winAmount = reason === 'bomb' ? RULES.winBombT : reason === 'defuse' ? RULES.winDefuse : reason === 'time' ? RULES.winTime : RULES.winElim;
    const lc = this.lossCounter[loser];
    const lossAmount = RULES.lossBonus[Math.min(lc, RULES.lossBonus.length - 1)];
    for (const p of this.players) {
      if (p.team === winner) this.addMoney(p, winAmount, false);
      else {
        // CS rule: T players alive when time runs out get no loss bonus
        if (reason === 'time' && p.team === 't' && p.alive) continue;
        let amt = lossAmount;
        if (p.team === 't' && this.bomb.state === 'exploded') amt = lossAmount; // n/a (T won)
        if (p.team === 't' && (this.bomb.state === 'planted' || this.bomb.state === 'defused')) amt += RULES.plantLoserBonus;
        this.addMoney(p, amt, false);
      }
    }
    this.lossCounter[loser] = Math.min(lc + 1, RULES.lossBonus.length - 1);
    this.lossCounter[winner] = Math.max(0, this.lossCounter[winner] - 1);
    // ---- MVP
    let mvp = null, why = '';
    if (reason === 'bomb' && this.bomb.planter && this.bomb.planter.team === winner) { mvp = this.bomb.planter; why = 'For planting the bomb'; }
    else if (reason === 'defuse' && this.bomb.defuser) { mvp = this.bomb.defuser; why = 'For defusing the bomb'; }
    else {
      const ws = this.players.filter(p => p.team === winner).sort((a, b) => b.stats.roundKills - a.stats.roundKills || b.stats.roundDmg - a.stats.roundDmg);
      if (ws[0] && ws[0].stats.roundKills > 0) { mvp = ws[0]; why = 'For most eliminations'; }
    }
    if (mvp) { mvp.stats.mvp++; mvp.stats.score += 2; }
    this.mvpThisRound = mvp;
    this.bombMusic?.stop(1); this.bombMusic = null;
    this.emit('round_end', { winner, reason, mvp, why });
    // match end?
    if (this.score[winner] >= RULES.winRounds || this.round >= RULES.maxRounds) {
      this.matchOver = true;
    }
  }
  halftime() {
    this.half = 2;
    for (const p of this.players) {
      p.team = p.team === 'ct' ? 't' : 'ct';
      p.money = RULES.startMoney; p.alive = false; p.armor = 0; p.helmet = false; p.defuser = false;
      p.resetInventory();
      this.makeCharacter(p);
      p.brain?.onTeamChange?.();
    }
    const s = this.score.ct; this.score.ct = this.score.t; this.score.t = s;
    this.history = this.history.map(h => ({ ...h, winner: h.winner === 'ct' ? 't' : 'ct', swapped: true }));
    this.lossCounter = { ct: 1, t: 1 };
    this.emit('halftime');
  }
  addMoney(p, amount, popup = true) {
    const before = p.money;
    p.money = Math.max(0, Math.min(RULES.maxMoney, p.money + amount));
    if (p === this.human && p.money !== before) this.emit('money', p.money - before, popup);
  }

  // ---------------------------------------------------------------- per-frame
  update(dt) {
    this.time += dt; this.lastDt = dt;
    // ----- phase timers
    if (this.phase === 'freeze') {
      this.timer -= dt; this.buyTimeLeft -= dt;
      if (this.timer <= 0) { this.phase = 'live'; this.timer = RULES.roundTime; this.emit('live'); }
    } else if (this.phase === 'live') {
      this.timer -= dt; this.buyTimeLeft -= dt;
      if (this.timer <= 0) { this.timer = 0; this.endRound('ct', 'time'); }
    } else if (this.phase === 'planted') {
      this.buyTimeLeft -= dt;
      this.updateBomb(dt);
    } else if (this.phase === 'over') {
      this.timer -= dt;
      if (this.bomb.state === 'planted') this.updateBomb(dt);
      if (this.timer <= 0) {
        if (this.matchOver) { this.phase = 'matchover'; this.emit('match_end', this.score.ct > this.score.t ? 'ct' : this.score.t > this.score.ct ? 't' : 'draw'); return; }
        if (this.round === RULES.halftimeAfter) this.halftime();
        this.startRound();
      }
    }
    const frozen = this.phase === 'freeze';
    // ----- players
    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.brain) p.brain.update(dt);
      p.simulate(dt, this.world, frozen);
      this.updateWeaponState(p, dt);
      this.updateFootsteps(p, dt);
      this.updatePickups(p);
      // recoil recovery
      const w = p.activeWeapon;
      const firing = w && (this.time - p.lastShotTime) < (w.def.cycle || 0.1) * 1.4 + 0.02;
      if (!firing) {
        const k = 1 - Math.exp(-dt * 8);
        p.punch.p -= p.punch.p * k; p.punch.y -= p.punch.y * k;
        const lin = 9 * dt;
        p.punch.p = Math.abs(p.punch.p) < lin ? 0 : p.punch.p - Math.sign(p.punch.p) * lin;
        p.punch.y = Math.abs(p.punch.y) < lin ? 0 : p.punch.y - Math.sign(p.punch.y) * lin;
        if (w) { w.recoilIdx = Math.max(0, w.recoilIdx - dt / Math.max(0.05, (w.def.cycle || 0.1) * 1.6)); if (w.recoilIdx < 1) w.shotsFired = 0; }
      }
      if (w && w.accFire > 0) w.accFire *= Math.exp(-dt * 2.3 / Math.max(0.05, w.def.recover || 0.35));
      // view punch (damage flinch) spring
      const vp = p.viewPunch;
      vp.vp += (-vp.p * 120 - vp.vp * 14) * dt; vp.p += vp.vp * dt;
      vp.vy += (-vp.y * 120 - vp.vy * 14) * dt; vp.y += vp.vy * dt;
      if (p.flash > 0) { p.flashT += dt; if (p.flashT > p.flashDur) p.flash = 0; }
      if (p.spotted > 0) p.spotted -= dt;
      // fire damage
      for (const f of this.fires) {
        if (f.handle.alive && f.handle.damageAt(p.pos)) {
          p._fireAcc = (p._fireAcc || 0) + dt;
          if (p._fireAcc >= 0.25) { p._fireAcc -= 0.25; this.applyDamage(p, f.owner, 10, 'generic', f.weapon, { fire: true, dir: _v1.set(0, 1, 0) }); }
        }
      }
      // character
      if (p.char) {
        p.char.root.position.copy(p.pos);
        p.char.update(dt, { vel: p.vel, yaw: p.yaw, pitch: p.pitch, crouch: p.duck, onGround: p.onGround, walking: p.input.walk });
      }
    }
    for (const p of this.players) if (!p.alive && p.char) p.char.update(dt, { vel: _v1.set(0, 0, 0), yaw: p.yaw, pitch: 0, crouch: 0, onGround: true, walking: false });
    // ----- world objects
    this.updateGrenades(dt);
    this.updateDrops(dt);
    this.updateFires(dt);
    this.updateSpotting(dt);
    if (this.noises.length > 64) this.noises.splice(0, this.noises.length - 64);
    // ----- round end checks
    if (this.phase === 'live' || this.phase === 'planted') this.checkRoundEnd();
  }
  checkRoundEnd() {
    const ctAlive = this.players.some(p => p.team === 'ct' && p.alive);
    const tAlive = this.players.some(p => p.team === 't' && p.alive);
    if (!ctAlive) this.endRound('t', 'elim');
    else if (!tAlive && this.bomb.state !== 'planted') this.endRound('ct', 'elim');
  }
  canBuy(p) {
    if (!p.alive) return false;
    if (!(this.phase === 'freeze' || ((this.phase === 'live' || this.phase === 'planted') && this.buyTimeLeft > 0))) return false;
    return this.inBuyZone(p);
  }
  inBuyZone(p) { return p.spawnPos && p.pos.distanceTo(p.spawnPos) < 900; }

  // ---------------------------------------------------------------- buying
  buy(p, item) {
    if (!this.canBuy(p)) return { ok: false, reason: this.inBuyZone(p) ? 'Buy time has expired' : 'You are not in a buy zone' };
    let price = 0;
    if (item === 'vest') {
      if (p.armor >= 100) return { ok: false, reason: 'You already have kevlar' };
      price = 650; if (p.money < price) return { ok: false, reason: 'Insufficient funds' };
      p.money -= price; p.armor = 100; p.boughtItems.push({ item, price });
    } else if (item === 'vesthelm') {
      if (p.armor >= 100 && p.helmet) return { ok: false, reason: 'You already have kevlar and a helmet' };
      price = p.armor >= 100 ? 350 : 1000; if (p.money < price) return { ok: false, reason: 'Insufficient funds' };
      p.money -= price; p.armor = 100; p.helmet = true; p.boughtItems.push({ item, price });
    } else if (item === 'defuser') {
      if (p.team !== 'ct') return { ok: false, reason: 'Not available' };
      if (p.defuser) return { ok: false, reason: 'You already have a defuse kit' };
      price = 400; if (p.money < price) return { ok: false, reason: 'Insufficient funds' };
      p.money -= price; p.defuser = true; p.boughtItems.push({ item, price });
    } else {
      const d = WEAPONS[item]; if (!d) return { ok: false, reason: 'Unknown item' };
      if (d.team !== 'both' && d.team !== p.team) return { ok: false, reason: 'Not available for your team' };
      price = d.price; if (p.money < price) return { ok: false, reason: 'Insufficient funds' };
      if (d.cat === 'grenade') {
        const n = p.inv.grenades.length, same = p.inv.grenades.filter(g => g === item).length;
        if (n >= 4) return { ok: false, reason: 'You cannot carry any more grenades' };
        if (same >= (d.max || 1)) return { ok: false, reason: 'You cannot carry any more of these' };
        if ((item === 'molotov' || item === 'incgrenade') && (p.inv.grenades.includes('molotov') || p.inv.grenades.includes('incgrenade'))) return { ok: false, reason: 'You cannot carry any more of these' };
        p.money -= price; p.inv.grenades.push(item); p.boughtItems.push({ item, price });
      } else {
        // already holding the same weapon → just top up? CS refuses
        const slotKey = d.slot === SLOT.PRIMARY ? 'primary' : (item === 'taser' ? 'taser' : 'secondary');
        const cur = p.inv[slotKey];
        if (cur && cur.id === item) return { ok: false, reason: 'You already own this weapon' };
        p.money -= price;
        if (cur) {
          // refund if it was bought this round, otherwise drop it (CS2)
          const bi = p.boughtItems.findIndex(b => b.item === cur.id);
          if (bi >= 0 && cur.boughtThisRound) { p.money += p.boughtItems[bi].price; p.boughtItems.splice(bi, 1); }
          else this.dropWeapon(p, slotKey, true);
        }
        const w = p.give(item, { bought: true });
        p.boughtItems.push({ item, price });
        if (p.alive) this.switchTo(p, slotKey, true);
      }
    }
    if (p === this.human) this.sound('buy', {});
    return { ok: true, money: p.money };
  }
  sell(p, item) {
    if (!this.canBuy(p)) return { ok: false };
    const bi = p.boughtItems.findIndex(b => b.item === item);
    if (bi < 0) return { ok: false, reason: 'Can only sell items bought this round' };
    const { price } = p.boughtItems[bi];
    if (item === 'vest' || item === 'vesthelm') { p.armor = 0; if (item === 'vesthelm') p.helmet = false; }
    else if (item === 'defuser') p.defuser = false;
    else {
      const d = WEAPONS[item];
      if (d.cat === 'grenade') { const i = p.inv.grenades.indexOf(item); if (i < 0) return { ok: false }; p.inv.grenades.splice(i, 1); }
      else {
        const slotKey = d.slot === SLOT.PRIMARY ? 'primary' : (item === 'taser' ? 'taser' : 'secondary');
        if (!p.inv[slotKey] || p.inv[slotKey].id !== item) return { ok: false };
        p.inv[slotKey] = null;
        if (p.active === slotKey) this.switchTo(p, p.inv.primary ? 'primary' : p.inv.secondary ? 'secondary' : 'knife', true);
      }
    }
    p.boughtItems.splice(bi, 1); p.money += price;
    return { ok: true, money: p.money };
  }

  // ---------------------------------------------------------------- weapon switching
  switchTo(p, slot, force = false) {
    if (!p.alive) return false;
    let target = slot;
    if (slot === 'grenade') {
      if (!p.inv.grenades.length) return false;
      // cycle through grenade types
      const types = [...new Set(p.inv.grenades)];
      const cur = p.active.startsWith('grenade:') ? p.active.slice(8) : null;
      const i = cur ? types.indexOf(cur) : -1;
      target = 'grenade:' + types[(i + 1) % types.length];
    } else if (slot.startsWith('grenade:')) {
      if (!p.inv.grenades.includes(slot.slice(8))) return false;
    } else if (slot === 'c4') { if (!p.inv.c4) return false; }
    else if (slot === 'secondary' && !p.inv.secondary && p.inv.taser) target = 'taser';
    else if (!p.weaponInSlot(slot)) return false;
    if (target === p.active && !force) return false;
    // cancel actions
    const cur = p.activeWeapon;
    if (cur) { cur.reloading = false; cur.shellState = null; cur.zoom = 0; cur.prime = 0; }
    if (p.planting > 0) { p.planting = 0; p.char?.plant(false); }
    p.grenadePulled = false;
    if (p.active !== target) p.lastActive = p.active;
    p.active = target;
    const id = p.activeId, d = WEAPONS[id];
    const w = p.activeWeapon;
    const draw = d ? (d.draw || 1) : 1;
    if (w) { w.drawEnd = this.time + draw; w.shotsFired = 0; }
    p.drawEnd = this.time + (d && d.cat === 'grenade' ? 0.6 : draw);
    this.charWeapon(p);
    this.emit('equip', p, id, draw);
    if (p === this.viewTarget) this.sound(d && d.cat === 'knife' ? 'knife_deploy' : 'deploy', {}, p);
    return true;
  }
  lastWeapon(p) { if (!this.switchTo(p, p.lastActive)) { for (const s of ['primary', 'secondary', 'knife']) if (s !== p.active && this.switchTo(p, s)) break; } }
  cycleWeapon(p, dir) {
    const order = ['primary', 'secondary', 'taser', 'knife'];
    const types = [...new Set(p.inv.grenades)].map(g => 'grenade:' + g);
    const all = order.filter(s => p.weaponInSlot(s)).concat(types).concat(p.inv.c4 ? ['c4'] : []);
    if (!all.length) return;
    let i = all.indexOf(p.active); i = (i + dir + all.length) % all.length;
    this.switchTo(p, all[i]);
  }

  // ---------------------------------------------------------------- weapon state machine (per tick)
  // p.ctl = { attack, attack2, attack2Pressed, attackPressed, reload, use, inspect }
  updateWeaponState(p, dt) {
    const c = p.ctl || (p.ctl = {});
    const id = p.activeId, d = WEAPONS[id], w = p.activeWeapon;
    const t = this.time;
    if (this.phase === 'freeze' && !this.warmup) { c.attackPressed = c.attack2Pressed = false; return; }
    // ---- reload completion
    if (w && w.reloading) {
      if (d.shellReload) {
        if (t >= w.reloadEnd) {
          if (w.shellState === 'start') { w.shellState = 'shell'; w.reloadEnd = t + d.reload; this.emit('reload_shell', p, d.reload); }
          else if (w.shellState === 'shell') {
            if (w.reserve > 0 && w.clip < d.mag) { w.clip++; w.reserve--; this.sound('shell_insert', { pos: p.pos }, p); }
            if (w.clip < d.mag && w.reserve > 0 && !c.attack) { w.reloadEnd = t + d.reload; this.emit('reload_shell', p, d.reload); }
            else { w.shellState = 'end'; w.reloadEnd = t + (d.reloadEnd || 0.5); this.emit('reload_end', p, d.reloadEnd || 0.5); }
          } else { w.reloading = false; w.shellState = null; }
        }
        if (c.attackPressed && w.clip > 0 && w.shellState === 'shell') { w.shellState = 'end'; w.reloadEnd = t + 0.3; this.emit('reload_end', p, 0.3); }
      } else if (t >= w.reloadEnd) {
        const need = d.mag - w.clip, take = Math.min(need, w.reserve);
        w.clip += take; w.reserve -= take; w.reloading = false;
      }
    }
    // ---- reload request
    if (c.reload) {
      c.reload = false;
      if (w && !w.reloading && d.mag && w.clip < d.mag && w.reserve > 0 && t >= w.drawEnd && !d.taserSlot) this.startReload(p);
    }
    // ---- inspect
    if (c.inspect) { c.inspect = false; this.emit('inspect', p); }
    // ---- grenades: pull on press, throw on release
    if (d && d.cat === 'grenade') {
      if (t < p.drawEnd) { c.attackPressed = c.attack2Pressed = false; return; }
      if ((c.attack || c.attack2) && !p.grenadePulled) { p.grenadePulled = true; this.emit('grenade_pull', p); this.sound('grenade_pin', { pos: p.pos }, p); }
      if (p.grenadePulled) {
        // CS: LMB = full throw, RMB = underhand lob, both = medium
        if (c.attack || c.attack2) p.grenadeStrength = c.attack && c.attack2 ? 0.5 : c.attack ? 1 : 0.3;
        else { p.grenadePulled = false; this.throwGrenade(p, id, p.grenadeStrength || 1); }
      }
      c.attackPressed = c.attack2Pressed = false;
      return;
    }
    // ---- C4: hold attack to plant
    if (id === 'c4') {
      const site = this.siteAt(p.pos);
      if (c.attack && site && p.onGround && (this.phase === 'live')) {
        if (p.planting === 0) { p.char?.plant(true); this.emit('plant_start', p); }
        const prev = p.planting;
        p.planting += dt;
        if (Math.floor(prev / 0.45) !== Math.floor(p.planting / 0.45)) this.sound('c4_key', { pos: p.pos, variant: Math.floor(Math.random() * 5) }, p);
        if (p.planting >= RULES.plantTime) { p.planting = 0; p.char?.plant(false); this.plantBomb(p, site); }
      } else if (p.planting > 0) { p.planting = 0; p.char?.plant(false); this.emit('plant_stop', p); }
      else if (c.attackPressed && !site && p === this.human) this.emit('notice', 'C4 can only be planted at a bomb site.');
      c.attackPressed = c.attack2Pressed = false;
      return;
    }
    if (!w || !d) return;
    if (t < w.drawEnd) { if (!d.cat === 'knife') c.attackPressed = false; return; }
    // ---- knife
    if (d.cat === 'knife') {
      if (c.attack && t >= w.nextFire) { this.knifeAttack(p, false); }
      else if (c.attack2 && t >= w.nextFire) { this.knifeAttack(p, true); }
      c.attackPressed = c.attack2Pressed = false;
      return;
    }
    // ---- secondary attack: scope / burst toggle
    if (c.attack2Pressed) {
      c.attack2Pressed = false;
      if (d.scope && !w.reloading) {
        const levels = d.zoom.length;
        w.zoom = (w.zoom + 1) % (levels + 1);
        w.zoomTime = t; w.rezoom = 0;
        this.sound('zoom', { pos: p.pos, volume: 0.6 }, p);
        this.emit('zoom', p, w.zoom);
      } else if (d.burstMode) {
        w.burst = !w.burst;
        if (p === this.human) this.emit('notice', w.burst ? 'Switched to burst-fire mode' : (d.id === 'glock' ? 'Switched to semi-automatic' : 'Switched to automatic'));
      } else if (id === 'revolver' && t >= w.nextFire) {
        // fan the hammer: fast inaccurate shot
        if (w.clip > 0) { this.fireWeapon(p, { fan: true }); w.nextFire = t + 0.4; }
      }
    }
    // auto re-zoom after a sniper shot (CS: resume zoom)
    if (w.rezoom && t >= w.nextFire - 0.05 && !w.reloading) { w.zoom = w.rezoom; w.rezoom = 0; w.zoomTime = t; this.emit('zoom', p, w.zoom); }
    // ---- burst in progress
    if (w.burstLeft > 0) {
      if (t >= w.burstNext) {
        if (w.clip > 0) { this.fireWeapon(p, { burstShot: true }); w.burstLeft--; w.burstNext = t + (id === 'glock' ? 0.055 : 0.075); }
        else w.burstLeft = 0;
      }
      c.attackPressed = false;
      return;
    }
    // ---- revolver priming
    if (id === 'revolver') {
      if (c.attack && t >= w.nextFire && w.clip > 0 && !w.reloading) {
        if (!w.primeStart) w.primeStart = t;
        if (t - w.primeStart >= d.prime) { this.fireWeapon(p); w.primeStart = 0; }
      } else w.primeStart = 0;
      c.attackPressed = false;
      return;
    }
    // ---- primary attack
    const wantFire = d.auto ? c.attack : c.attackPressed;
    if (wantFire && t >= w.nextFire) {
      if (w.reloading) {
        if (d.shellReload && w.clip > 0) { w.reloading = false; w.shellState = null; this.emit('reload_end', p, 0.25); }
        else { c.attackPressed = false; return; }
      }
      if (w.clip <= 0) {
        this.sound('dryfire', { pos: p.pos }, p); this.emit('dryfire', p);
        w.nextFire = t + 0.25;
        if (w.reserve > 0) this.startReload(p);
      } else if (w.burst) {
        w.burstLeft = 2; w.burstNext = t + (id === 'glock' ? 0.055 : 0.075);
        this.fireWeapon(p, { burstShot: true });
        w.nextFire = t + (id === 'glock' ? 0.5 : 0.55);
      } else this.fireWeapon(p);
    }
    c.attackPressed = false;
  }
  startReload(p) {
    const w = p.activeWeapon, d = w.def;
    if (d.taserSlot || !d.mag) return;
    w.reloading = true; w.zoom = 0; w.rezoom = 0; w.burstLeft = 0;
    if (d.shellReload) { w.shellState = 'start'; w.reloadEnd = this.time + (d.reloadStart || 0.45); this.emit('reload_start', p, d.reloadStart || 0.45); }
    else {
      w.reloadEnd = this.time + d.reload;
      this.emit('reload', p, d.reload, w.clip === 0);
      // reload sounds (approximate CS timing)
      const pos = p.pos;
      setTimeout(() => p.alive && w.reloading && this.sound('reload_magout', { pos, weapon: d.id }, p), d.reload * 0.18 * 1000);
      setTimeout(() => p.alive && w.reloading && this.sound('reload_magin', { pos, weapon: d.id }, p), d.reload * 0.55 * 1000);
      if (w.clip === 0 || d.hold === 'pistol') setTimeout(() => p.alive && w.reloading && this.sound(d.hold === 'pistol' ? 'reload_slide' : 'reload_bolt', { pos, weapon: d.id }, p), d.reload * 0.82 * 1000);
    }
    p.char?.reload(d.shellReload ? 1.5 : d.reload);
    this.noise(p.pos, 500, 'reload', p);
  }

  // ---------------------------------------------------------------- inaccuracy (CS2 model, milliradians)
  inaccuracy(p, w) {
    const d = w.def;
    const scoped = d.scope && w.zoom > 0;
    let base = scoped ? (d.scopedInacc || 2) : (p.duck > 0.5 ? d.inCrouch : d.inStand);
    // just-scoped: accuracy ramps in over ~0.25 s
    if (scoped && w.zoomTime !== undefined) { const k = Math.min(1, (this.time - w.zoomTime) / 0.25); base = base * k + d.inStand * (1 - k) * 0.6; }
    const ref = d.speed || 250;
    const sp = p.horizontalSpeed();
    const move = d.inMove * Math.max(0, Math.min(1, (sp - ref * 0.34) / (ref * 0.66)));
    const air = p.onGround ? 0 : d.inJump * (0.6 + 0.4 * Math.min(1, Math.abs(p.vel.y) / 300));
    return base + move + air + w.accFire;
  }
  spreadPixels(p, fovY, screenH) {
    const w = p.activeWeapon; if (!w || !w.def.inStand) return 0;
    const inacc = this.inaccuracy(p, w) + (w.def.spread || 0);
    const f = (screenH / 2) / Math.tan(fovY * D2R / 2);
    return Math.tan(inacc * 0.001) * f;
  }

  // ---------------------------------------------------------------- firing
  fireWeapon(p, opts = {}) {
    const w = p.activeWeapon, d = w.def, t = this.time;
    w.clip--; w.nextFire = t + d.cycle; p.lastShotTime = t;
    const eye = p.eyePos(_v1).clone();
    const inacc = this.inaccuracy(p, w) * (opts.fan ? 3 : 1);
    // recoil pattern
    const pat = patternFor(d.id);
    const idx = Math.min(Math.floor(w.recoilIdx), pat.length - 1);
    const kick = pat[idx] || [0, 0];
    const rmul = (p.duck > 0.5 ? 0.85 : 1) * (opts.fan ? 1.8 : 1);
    // bullets go to view + 2*punch (current punch BEFORE this shot's kick, CS behaviour)
    const bp = p.punch.p * 2, by = p.punch.y * 2;
    const pellets = d.pellets || 1;
    const hits = [];
    for (let i = 0; i < pellets; i++) {
      // random spread (CS: r1 * inaccuracy at angle r2, plus spread)
      const r1 = Math.random(), r2 = Math.random() * Math.PI * 2;
      const r3 = Math.random(), r4 = Math.random() * Math.PI * 2;
      let ox = Math.cos(r2) * r1 * inacc + Math.cos(r4) * r3 * (d.spread || 0);
      let oy = Math.sin(r2) * r1 * inacc + Math.sin(r4) * r3 * (d.spread || 0);
      if (d.shotgun) { const sr = Math.sqrt(Math.random()), sa = Math.random() * Math.PI * 2; ox = Math.cos(sa) * sr * d.spread + Math.cos(r2) * r1 * inacc * 0.3; oy = Math.sin(sa) * sr * d.spread + Math.sin(r2) * r1 * inacc * 0.3; }
      const yaw = p.yaw + by * D2R + ox * 0.001, pitch = p.pitch + bp * D2R + oy * 0.001;
      const cp = Math.cos(pitch);
      const dir = new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).normalize();
      this.traceBullet(p, eye, dir, d, d.dmg, i === 0, hits);
    }
    // apply recoil kick for next shot
    p.punch.y += kick[0] * 0.5 * rmul * (d.id === 'ak47' || d.id.startsWith('m4') ? 1 : 1);
    p.punch.p += kick[1] * 0.5 * rmul;
    if (d.recoil && !pat.length) p.punch.p += d.recoil * 0.01;
    w.recoilIdx += 1; w.shotsFired++;
    w.accFire += d.inFire * (opts.burstShot ? 0.7 : 1);
    // sniper: unscope after the shot, rezoom after bolt
    if (d.scope === 2 && w.zoom > 0) { w.rezoom = w.zoom; w.zoom = 0; this.emit('zoom', p, 0); }
    p.velMod = Math.min(p.velMod, 1);
    // sound + fx
    this.sound('shot', { pos: eye, weapon: d.id }, p);
    const loud = d.silenced ? 600 : 3000;
    this.noise(p.pos, loud, 'shot', p);
    p.spotted = Math.max(p.spotted, d.silenced ? 0 : 1.0);   // firing reveals you on the enemy radar (CS2)
    this.emit('fire', p, w, { lastShot: w.clip === 0, shotIndex: w.shotsFired });
    p.char?.fire();
    // third-person muzzle flash + tracers
    const m = p.weaponModels.get(d.id);
    let muzzle = null;
    if (m && m.userData.muzzle && p !== this.viewTarget) { m.userData.muzzle.getWorldPosition(_v2); muzzle = _v2.clone(); }
    else if (p === this.viewTarget && this.ctx.getMuzzleWorld) muzzle = this.ctx.getMuzzleWorld();
    if (!muzzle) muzzle = eye.clone().add(p.forward(_v3).multiplyScalar(30));
    if (p !== this.viewTarget) this.fx.muzzleFlash(muzzle, p.forward(_v3), { silenced: d.silenced, size: d.cat === 'pistol' ? 0.7 : 1 });
    for (const h of hits) {
      if (h.tracer && (w.shotsFired % 3 === 1 || d.pellets > 1 || p !== this.viewTarget) && !d.silenced) this.fx.tracer(muzzle, h.end, { silenced: d.silenced });
      this.fx.smokeBullet?.(eye, h.end);
      // bullet whiz near the local player
      if (this.viewTarget && p !== this.viewTarget && this.viewTarget.alive) this.checkWhiz(eye, h.end);
    }
  }
  checkWhiz(a, b) {
    const me = this.viewTarget.eyePos(_v4);
    const ab = _v2.subVectors(b, a), len = ab.length(); if (len < 1) return;
    ab.divideScalar(len);
    const tt = Math.max(0, Math.min(len, _v3.subVectors(me, a).dot(ab)));
    const closest = _v3.copy(a).addScaledVector(ab, tt);
    if (closest.distanceTo(me) < 70 && tt > 100) this.audio.play('whiz', { pos: closest });
  }
  traceBullet(shooter, origin, dir, d, damage, first, hitsOut) {
    const maxRange = d.range || 8192;
    // world surfaces along the ray
    const wallHits = this.world.raycastAll(origin, dir, maxRange) || [];
    // player hitboxes along the ray
    const ph = [];
    for (const p of this.players) {
      if (p === shooter || !p.alive || !p.char) continue;
      // quick reject: distance from ray to player center
      _v2.set(p.pos.x, p.pos.y + 36, p.pos.z).sub(origin);
      const along = _v2.dot(dir); if (along < 0 || along > maxRange) continue;
      const perp2 = _v2.lengthSq() - along * along; if (perp2 > 70 * 70) continue;
      const boxes = p.char.getHitboxes(p._hb || (p._hb = []));
      let best = -1, bestG = null;
      for (const hb of boxes) {
        const tt = hb.type === 'sphere' ? raySphere(origin, dir, hb.a, hb.r) : rayCapsule(origin, dir, hb.a, hb.b, hb.r);
        if (tt >= 0 && (best < 0 || tt < best)) { best = tt; bestG = hb.group; }
      }
      if (best >= 0) ph.push({ t: best, p, group: bestG });
    }
    ph.sort((a, b) => a.t - b.t);
    let dmg = damage, pen = d.penetration || 1, walls = 0, pi = 0, end = null;
    let throughSmoke = this.fx.smokeLineBlocked ? false : false;
    let wi = 0;
    const events = [];
    while (true) {
      const nextWall = wallHits[wi], nextP = ph[pi];
      const wt = nextWall ? nextWall.distance : Infinity, pt = nextP ? nextP.t : Infinity;
      if (wt === Infinity && pt === Infinity) { end = origin.clone().addScaledVector(dir, Math.min(maxRange, 4000)); break; }
      if (pt < wt) {
        // hit a player
        const hp = nextP; pi++;
        const hitPoint = origin.clone().addScaledVector(dir, hp.t);
        const dist = hp.t;
        const rangeDmg = dmg * Math.pow(d.rangeMod || 1, dist / 500);
        const smoke = this.fx.smokeLineBlocked ? this.fx.smokeLineBlocked(origin, hitPoint) : false;
        this.applyDamage(hp.p, shooter, rangeDmg, hp.group, d.id, { dir, point: hitPoint, wallbang: walls > 0, smoke, dist });
        dmg *= 0.75;     // bullets keep going through players with less damage (collateral)
        if (d.pellets > 1) { end = hitPoint; break; }
        continue;
      }
      // hit a wall
      wi++;
      const h = nextWall;
      if (h.distance < 0.5 && wi === 1 && wallHits.length > 1) { /* starts inside */ }
      this.fx.impact(h.point, h.normal, h.surface);
      if (Math.random() < 0.35) this.audio.play('impact', { pos: h.point, surface: h.surface, volume: 0.7 });
      if (walls === 0) this.noise(h.point, 400, 'impact', shooter);
      if (d.pellets > 1 || pen <= 0 || d.cat === 'pistol' && d.penetration < 2 && dmg < 20) { end = h.point.clone(); break; }
      // thickness: thin doors/panels, otherwise gap to the next surface
      let thick;
      const nh = wallHits[wi];
      if (DOOR_GROUPS.has(h.group)) thick = nh ? Math.min(nh.distance - h.distance, 6) : 4;
      else thick = nh ? nh.distance - h.distance : 999;
      const surfMul = h.surface === 'wood' ? 2.5 : h.surface === 'metal' ? 0.6 : h.surface === 'sand' || h.surface === 'dirt' ? 0.8 : 1;
      const maxThick = pen * 11 * surfMul;
      if (thick > maxThick || walls >= 3) { end = h.point.clone(); break; }
      dmg *= Math.max(0.15, 1 - thick / maxThick * 0.85) * 0.85;
      walls++;
      // exit impact
      if (nh && !DOOR_GROUPS.has(h.group)) { wi++; this.fx.impact(nh.point, _v3.copy(nh.normal), nh.surface); }
      if (dmg < 5) { end = (nh ? nh.point : h.point).clone(); break; }
    }
    hitsOut.push({ end, tracer: first });
  }

  knifeAttack(p, heavy) {
    const w = p.activeWeapon, d = w.def, t = this.time;
    const combo = !heavy && t - (w.lastSlash || -9) < 0.8;
    w.lastSlash = t;
    w.nextFire = t + (heavy ? d.heavyCycle : (combo ? 0.5 : d.lightCycle));
    this.emit('knife', p, heavy);
    this.sound('knife_swing', { pos: p.pos }, p);
    p.char?.fire();
    const eye = p.eyePos(_v1).clone(), dir = p.forward(_v2).clone();
    const range = heavy ? 32 + 16 : 48 + 16;
    // nearest enemy hitbox within the swing cone
    let best = null, bestT = Infinity;
    for (const q of this.players) {
      if (q === p || !q.alive || !q.char) continue;
      const boxes = q.char.getHitboxes(q._hb || (q._hb = []));
      for (const hb of boxes) {
        const tt = hb.type === 'sphere' ? raySphere(eye, dir, hb.a, hb.r + 6) : rayCapsule(eye, dir, hb.a, hb.b, hb.r + 6);
        if (tt >= 0 && tt < range && tt < bestT) { bestT = tt; best = { q, group: hb.group }; }
      }
    }
    const wall = this.world.raycast(eye, dir, range);
    if (best && (!wall || wall.distance > bestT)) {
      // backstab: attacker roughly behind the victim
      const vf = _v3.set(-Math.sin(best.q.yaw), 0, -Math.cos(best.q.yaw));
      const toV = _v4.subVectors(best.q.pos, p.pos).setY(0).normalize();
      const back = vf.dot(toV) > 0.4;
      const dmg = heavy ? (back ? d.heavyBack : d.heavy) : (back ? d.lightBack : (combo ? 25 : d.light));
      this.applyDamage(best.q, p, dmg, 'chest', d.id, { dir, knife: true, raw: true, point: eye.clone().addScaledVector(dir, bestT) });
      this.sound(heavy ? 'knife_stab' : 'knife_hit_body', { pos: best.q.pos }, null);
    } else if (wall) {
      this.fx.impact(wall.point, wall.normal, wall.surface);
      this.sound('knife_hit_wall', { pos: wall.point }, null);
    }
  }

  // ---------------------------------------------------------------- damage
  applyDamage(victim, attacker, dmg, group, weapon, o = {}) {
    if (!victim.alive || this.phase === 'matchover') return;
    const d = WEAPONS[weapon];
    // friendly fire (CS2 competitive: on, reduced). Bots never shoot teammates intentionally.
    if (attacker && attacker !== victim && attacker.team === victim.team) {
      if (o.fire || o.grenade) dmg *= 0.5; else dmg *= 0.33;
    }
    let mult = o.raw ? 1 : (HITGROUP_MULT[group] || 1);
    if (d && d.shotgun && group === 'head') mult = 4;
    let hpDmg = dmg * mult;
    let armorHit = false, helmetHit = false;
    const ap = o.grenade ? 0.5 : o.fire ? 1 : d ? (d.ap || 1) : 1;
    const armored = victim.armor > 0 && group !== 'leg' && !o.fire && (group !== 'head' || victim.helmet);
    if (armored && ap < 1) {
      let newDmg = hpDmg * ap, armorDmg = (hpDmg - newDmg) * 0.5;
      if (armorDmg > victim.armor) { armorDmg = victim.armor; newDmg = hpDmg - armorDmg * 2; }
      victim.armor = Math.max(0, Math.round(victim.armor - armorDmg));
      hpDmg = newDmg; armorHit = true; helmetHit = group === 'head';
    }
    hpDmg = Math.max(1, Math.round(hpDmg));
    const before = victim.hp;
    victim.hp = Math.max(0, victim.hp - hpDmg);
    const dealt = before - victim.hp;
    victim.lastHurtTime = this.time;
    if (attacker && attacker !== victim) {
      const lk = attacker.id + '>' + victim.id, le = this.dmgLog.get(lk) || { dmg: 0, hits: 0 };
      le.dmg += dealt; le.hits++; this.dmgLog.set(lk, le);
      victim.damageBy.set(attacker.id, (victim.damageBy.get(attacker.id) || 0) + dealt);
      if (attacker.team !== victim.team) { attacker.stats.dmg += dealt; attacker.stats.roundDmg += dealt; }
    }
    // tagging (slowdown) + aim punch
    if (!o.fire) {
      victim.velMod = Math.min(victim.velMod, group === 'leg' ? 0.6 : 0.42);
      const kickAmt = (group === 'head' ? 3.5 : 1.6) * (armorHit ? 0.5 : 1);
      victim.viewPunch.vp += kickAmt * 20; victim.viewPunch.vy += (Math.random() - 0.5) * kickAmt * 12;
    }
    // sounds + fx
    if (!o.fire && !o.grenade && !o.bomb) {
      const sname = group === 'head' ? (helmetHit ? 'hit_head_helmet' : 'hit_head') : (armorHit ? 'hit_armor' : 'hit_body');
      this.audio.play(sname, { pos: o.point || victim.eyePos(_v3) });
      if (o.point && o.dir) this.fx.blood(o.point, o.dir, { headshot: group === 'head' });
    }
    if (victim === this.human) {
      this.audio.play('hurt', { volume: Math.min(1, dealt / 40 + 0.3) });
      let ang = 0;
      if (attacker && attacker !== victim) {
        const dx = attacker.pos.x - victim.pos.x, dz = attacker.pos.z - victim.pos.z;
        const a = Math.atan2(-dx, -dz); ang = a - victim.yaw;
      } else if (o.from) { const dx = o.from.x - victim.pos.x, dz = o.from.z - victim.pos.z; ang = Math.atan2(-dx, -dz) - victim.yaw; }
      this.emit('hurt', victim, dealt, ang);
    }
    victim.brain?.onHurt?.(attacker, dealt);
    if (victim.hp <= 0) this.kill(victim, attacker, weapon, { headshot: group === 'head' && !o.grenade && !o.fire, wallbang: o.wallbang, smoke: o.smoke, dir: o.dir, noscope: d && d.scope && attacker && attacker.activeWeapon && attacker.activeWeapon.zoom === 0 && !attacker.activeWeapon.rezoom, knife: o.knife });
  }
  kill(victim, attacker, weapon, f = {}) {
    victim.alive = false; victim.hp = 0;
    victim.stats.d++;
    victim.planting = 0; victim.defusing = 0;
    if (this.bomb.defuser === victim) { this.bomb.defuser = null; this.bomb.defuseProgress = 0; }
    // drop weapons: primary (or secondary), bomb, defuse kit
    if (victim.inv.primary) this.dropWeapon(victim, 'primary', false);
    else if (victim.inv.secondary) this.dropWeapon(victim, 'secondary', false);
    if (victim.inv.c4) this.dropBomb(victim);
    if (victim.defuser) { this.spawnDrop('defuser', null, victim.pos, _v1.set(0, 0, 0)); victim.defuser = false; }
    if (victim.char) { victim.char.setWeapon(null, 'rifle'); victim.char.die(f.dir || _v1.set(0, 0, -1), !!f.headshot); }
    const enemy = attacker && attacker !== victim && attacker.team !== victim.team;
    if (attacker && attacker !== victim) {
      if (enemy) {
        attacker.stats.k++; attacker.stats.roundKills++; attacker.stats.score += 2;
        if (f.headshot) attacker.stats.hs++;
        const d = WEAPONS[weapon];
        let reward = d ? d.kill : 300;
        if (weapon === 'hegrenade' || weapon === 'molotov' || weapon === 'incgrenade') reward = 300;
        if (weapon === 'taser') reward = 0;
        this.addMoney(attacker, reward);
        if (attacker === this.human && reward > 0) this.audio.play('money', { volume: 0.5 });
      } else { attacker.stats.k--; attacker.stats.score -= 2; this.addMoney(attacker, -300); }
    } else if (!attacker || attacker === victim) { victim.stats.k = victim.stats.k; }
    // assist: someone else on the attacker's team dealt ≥ 41 damage
    let assister = null;
    for (const [aid, dmg] of victim.damageBy) {
      const a = this.players[aid];
      if (a && a !== attacker && dmg >= 41 && a.team !== victim.team) { a.stats.a++; a.stats.score += 1; assister = a; break; }
    }
    const blind = attacker && attacker.flash > 0.5 && attacker.flashT < attacker.flashDur * 0.8;
    this.emit('kill', { victim, attacker, weapon, headshot: !!f.headshot, wallbang: !!f.wallbang, smoke: !!f.smoke, noscope: !!f.noscope, blind, assister });
    this.sound('death', { pos: victim.pos }, victim);
    victim.brain?.onDeath?.();
    for (const p of this.players) if (p.brain && p.team === victim.team && p !== victim) p.brain.onTeammateDied?.(victim, attacker);
  }

  // ---------------------------------------------------------------- drops & pickups
  spawnDrop(id, weaponInst, pos, vel) {
    let model;
    if (id === 'defuser') {
      model = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 6), new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.6 }));
      const strip = new THREE.Mesh(new THREE.BoxGeometry(10.2, 1, 6.2), new THREE.MeshStandardMaterial({ color: 0xd8a020, roughness: 0.5 }));
      strip.position.y = 0.8; model.add(box, strip); box.castShadow = true;
      this.world.patchMaterial(box.material);
    } else {
      model = this.ctx.createWeaponModel(id, { lod: 'low' });
      model.scale.setScalar(39.37);
      model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    }
    model.position.copy(pos).add(_v1.set(0, 40, 0));
    this.world.addShadowCaster(model);
    const drop = { id, w: weaponInst, model, pos: model.position, vel: vel.clone(), rest: false, spin: (Math.random() - 0.5) * 8, age: 0, noPickup: {} };
    model.rotation.set(0, Math.random() * Math.PI * 2, Math.PI / 2 * (id === 'c4' ? 0 : 1));
    this.drops.push(drop);
    return drop;
  }
  dropWeapon(p, slotKey, silent) {
    const w = p.inv[slotKey]; if (!w) return;
    p.inv[slotKey] = null;
    const f = p.forward(_v1);
    const vel = new THREE.Vector3(f.x * 220, 120, f.z * 220).add(p.vel);
    const drop = this.spawnDrop(w.id, w, p.pos, vel);
    drop.noPickup[p.id] = this.time + 1.0;
    w.reloading = false; w.zoom = 0;
    if (p.alive && p.active === slotKey) this.switchTo(p, p.inv.primary ? 'primary' : p.inv.secondary ? 'secondary' : 'knife', true);
    if (!silent && p.alive) this.sound('drop', { pos: p.pos }, p);
  }
  dropBomb(p) {
    if (!p.inv.c4) return;
    p.inv.c4 = false;
    const f = p.forward(_v1);
    const drop = this.spawnDrop('c4', null, p.pos, p.alive ? new THREE.Vector3(f.x * 200, 100, f.z * 200) : new THREE.Vector3(0, 0, 0));
    drop.noPickup[p.id] = this.time + 1.5;
    this.bomb.state = 'dropped'; this.bomb.carrier = null; this.bomb.dropRef = drop;
    if (p.alive && p.active === 'c4') this.switchTo(p, p.inv.primary ? 'primary' : p.inv.secondary ? 'secondary' : 'knife', true);
    this.emit('bomb_dropped', p);
  }
  dropActive(p) {
    if (!p.alive) return;
    if (p.active === 'c4') return this.dropBomb(p);
    if (p.active === 'primary' || p.active === 'secondary' || p.active === 'taser') return this.dropWeapon(p, p.active, false);
    if (p.active.startsWith('grenade:')) {
      const id = p.active.slice(8); const i = p.inv.grenades.indexOf(id); if (i < 0) return;
      p.inv.grenades.splice(i, 1);
      const f = p.forward(_v1);
      const drop = this.spawnDrop(id, null, p.pos, new THREE.Vector3(f.x * 200, 100, f.z * 200));
      drop.noPickup[p.id] = this.time + 1;
      this.switchTo(p, p.inv.primary ? 'primary' : p.inv.secondary ? 'secondary' : 'knife', true);
    }
  }
  updateDrops(dt) {
    for (const d of this.drops) {
      d.age += dt;
      if (d.rest) continue;
      d.vel.y -= 800 * dt;
      const step = _v1.copy(d.vel).multiplyScalar(dt);
      const len = step.length();
      if (len > 0) {
        const hit = this.world.raycast(_v2.copy(d.pos).add(_v3.set(0, 2, 0)), step.clone().normalize(), len + 2);
        if (hit) {
          if (hit.normal.y > 0.6) { d.pos.copy(hit.point).add(_v3.set(0, 1.5, 0)); d.rest = true; d.model.rotation.x = 0; d.model.rotation.z = Math.PI / 2 * (d.id === 'c4' || d.id === 'defuser' ? 0 : 1); if (d.id === 'defuser' || d.id === 'c4') d.model.rotation.z = 0; this.audio.play('drop', { pos: d.pos, volume: 0.5 }); }
          else { d.pos.copy(hit.point).addScaledVector(hit.normal, 3); const vn = d.vel.dot(hit.normal); d.vel.addScaledVector(hit.normal, -1.6 * vn); d.vel.multiplyScalar(0.5); }
        } else d.pos.add(step);
      }
      d.model.rotation.y += d.spin * dt;
      if (d.age > 5 && !d.rest) d.rest = true;
    }
  }
  updatePickups(p) {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      if ((d.noPickup[p.id] || 0) > this.time) continue;
      const dx = d.pos.x - p.pos.x, dz = d.pos.z - p.pos.z, dy = d.pos.y - p.pos.y;
      if (dx * dx + dz * dz > 40 * 40 || dy < -20 || dy > 80) continue;
      if (this.tryPickup(p, d, false)) { this.drops.splice(i, 1); }
    }
  }
  tryPickup(p, d, swap) {
    const id = d.id;
    if (id === 'c4') {
      if (p.team !== 't') return false;
      p.inv.c4 = true; this.bomb.state = 'carried'; this.bomb.carrier = p; this.bomb.dropRef = null;
      this.world.scene.remove(d.model); this.sound('c4_pickup', { pos: p.pos }, p);
      if (p === this.human) this.emit('notice', 'You picked up the bomb.');
      this.emit('bomb_pickup', p);
      return true;
    }
    if (id === 'defuser') {
      if (p.team !== 'ct' || p.defuser) return false;
      p.defuser = true; this.world.scene.remove(d.model); this.sound('kit_pickup', { pos: p.pos }, p); return true;
    }
    const def = WEAPONS[id]; if (!def) return false;
    if (def.cat === 'grenade') {
      if (p.inv.grenades.length >= 4 || p.inv.grenades.filter(g => g === id).length >= (def.max || 1)) return false;
      p.inv.grenades.push(id); this.world.scene.remove(d.model); this.sound('pickup', { pos: p.pos }, p); return true;
    }
    const slotKey = def.slot === SLOT.PRIMARY ? 'primary' : (id === 'taser' ? 'taser' : 'secondary');
    if (p.inv[slotKey] && !swap) return false;
    if (p.inv[slotKey] && swap) this.dropWeapon(p, slotKey, true);
    p.inv[slotKey] = d.w || Player.makeWeapon(id);
    d.w && (d.w.boughtThisRound = false);
    this.world.scene.remove(d.model);
    this.sound('pickup', { pos: p.pos }, p);
    if (swap || (slotKey === 'primary' && p.active !== 'primary' && !p.isBot) || p.isBot) { if (slotKey === 'primary' || !p.inv.primary) this.switchTo(p, slotKey, true); }
    return true;
  }
  useAction(p) {
    // E: defuse bomb, or pick up the weapon you are looking at
    if (!p.alive) return;
    if (this.bomb.state === 'planted' && p.team === 'ct') {
      const e = p.eyePos(_v1); const toB = _v2.subVectors(this.bomb.pos, e); const dist = toB.length();
      if (dist < 90 && p.onGround) { toB.normalize(); if (toB.dot(p.forward(_v3)) > 0.5 || dist < 60) { this.beginDefuse(p); return; } }
    }
    const e = p.eyePos(_v1), f = p.forward(_v2);
    let best = null, bd = 120;
    for (const d of this.drops) {
      const to = _v3.subVectors(d.pos, e); const dist = to.length(); if (dist > bd) continue;
      to.normalize(); if (to.dot(f) < 0.8) continue;
      best = d; bd = dist;
    }
    if (best) { if (this.tryPickup(p, best, true)) this.drops.splice(this.drops.indexOf(best), 1); }
  }

  // ---------------------------------------------------------------- bomb
  siteAt(pos) { for (const k of ['A', 'B']) if (this.world.bombsites[k].contains(pos)) return k; return null; }
  plantBomb(p, site) {
    p.inv.c4 = false;
    const b = this.bomb;
    b.state = 'planted'; b.carrier = null; b.site = site; b.planter = p;
    b.pos.copy(p.pos).add(_v1.set(-Math.sin(p.yaw) * 14, 0, -Math.cos(p.yaw) * 14));
    const h = this.world.raycast(_v2.copy(b.pos).add(_v3.set(0, 30, 0)), _v4.set(0, -1, 0), 80);
    if (h) b.pos.copy(h.point);
    b.timeLeft = RULES.c4Timer; b.nextBeep = 0.5; b.defuseProgress = 0; b.defuser = null;
    const m = this.ctx.createWeaponModel('c4', { lod: 'low' });
    m.scale.setScalar(39.37); m.position.copy(b.pos).add(_v1.set(0, 1.2, 0)); m.rotation.set(0, p.yaw + Math.PI, 0);
    m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.world.addShadowCaster(m); b.model = m;
    b.light = this.fx.c4Light(_v2.copy(b.pos).add(_v3.set(0, 4, 0)));
    this.phase = 'planted';
    this.addMoney(p, RULES.plantReward);
    p.stats.score += 2;
    this.sound('c4_planted', { pos: b.pos });
    this.noise(b.pos, 3000, 'plant', p);
    this.switchTo(p, p.inv.primary ? 'primary' : p.inv.secondary ? 'secondary' : 'knife', true);
    this.emit('bomb_planted', p, site);
  }
  beginDefuse(p) {
    const b = this.bomb;
    if (b.defuser && b.defuser !== p) return;
    if (!b.defuser) { b.defuser = p; b.defuseProgress = 0; b.defuseTotal = p.defuser ? RULES.defuseTimeKit : RULES.defuseTime; p.char?.defuse(true); this.sound('defuse_start', { pos: b.pos }); this.noise(b.pos, 900, 'defuse', p); this.emit('defuse_start', p); }
    p.defusing = 1; p._defuseHeld = this.time;
  }
  updateBomb(dt) {
    const b = this.bomb;
    if (b.state !== 'planted') return;
    b.timeLeft -= dt;
    b.nextBeep -= dt;
    if (b.nextBeep <= 0) {
      const frac = Math.max(0, b.timeLeft / RULES.c4Timer);
      b.nextBeep = Math.max(0.1, 0.12 + frac * 0.9 * (frac > 0.25 ? 1 : 0.6));
      this.audio.play('c4_beep', { pos: b.pos });
      b.light?.blink();
    }
    // defusing
    const d = b.defuser;
    if (d) {
      const still = d.alive && this.time - d._defuseHeld < 0.15 && d.pos.distanceTo(b.pos) < 100;
      if (!still) { d.defusing = 0; d.char?.defuse(false); b.defuser = null; b.defuseProgress = 0; this.emit('defuse_stop', d); }
      else {
        b.defuseProgress += dt;
        if (b.defuseProgress >= b.defuseTotal && b.timeLeft > 0) {
          b.state = 'defused'; d.defusing = 0; d.char?.defuse(false);
          b.light?.dispose(); b.light = null;
          this.addMoney(d, RULES.defuseReward); d.stats.score += 2;
          this.sound('defuse_done', { pos: b.pos });
          this.emit('bomb_defused', d);
          if (this.phase !== 'over') this.endRound('ct', 'defuse');
          return;
        }
      }
    }
    if (b.timeLeft <= 0) this.explodeBomb();
  }
  explodeBomb() {
    const b = this.bomb;
    b.state = 'exploded';
    b.light?.dispose(); b.light = null;
    if (b.model) { this.world.scene.remove(b.model); b.model = null; }
    const r = this.fx.c4Explosion(b.pos.clone().add(_v1.set(0, 10, 0)));
    this.audio.play('c4_explode', { pos: b.pos });
    this.emit('shake', r ? r.shake : 2);
    const R = 1750, sigma = R / 3;
    for (const p of this.players) {
      if (!p.alive) continue;
      const dist = p.pos.distanceTo(b.pos);
      let dmg = 500 * Math.exp(-(dist * dist) / (2 * sigma * sigma));
      if (dmg < 1) continue;
      if (p.armor > 0) { const absorbed = Math.min(p.armor, dmg * 0.5 * 0.5); p.armor = Math.max(0, p.armor - absorbed); dmg -= absorbed * 2; }
      this.applyDamage(p, b.planter, dmg, 'generic', 'c4', { bomb: true, raw: true, grenade: false, from: b.pos });
    }
    if (this.phase !== 'over') this.endRound('t', 'bomb');
  }

  // ---------------------------------------------------------------- grenades
  throwGrenade(p, id, strength) {
    const i = p.inv.grenades.indexOf(id); if (i < 0) return;
    p.inv.grenades.splice(i, 1);
    // CS throw: pitch biased upward by 10°, speed 750*0.9 scaled by strength, + player velocity * 1.25
    let pitchDeg = p.pitch / D2R;
    pitchDeg = pitchDeg + 10 * (90 - Math.abs(pitchDeg)) / 90;
    const pr = pitchDeg * D2R, cp = Math.cos(pr);
    const dir = new THREE.Vector3(-Math.sin(p.yaw) * cp, Math.sin(pr), -Math.cos(p.yaw) * cp);
    const speed = Math.max(15, 675 * (0.3 + 0.7 * strength));
    const vel = dir.clone().multiplyScalar(speed).addScaledVector(p.vel, 1.25);
    const start = p.eyePos(new THREE.Vector3()).addScaledVector(dir, 16);
    if (strength < 0.4) start.y -= 12;
    // keep start out of walls
    const h = this.world.raycast(p.eyePos(_v1), dir, 18);
    if (h) start.copy(h.point).addScaledVector(h.normal, 4);
    const model = this.ctx.createWeaponModel(id, { lod: 'low' });
    model.scale.setScalar(39.37); model.position.copy(start);
    model.traverse(o => { if (o.isMesh) o.castShadow = true; });
    this.world.addShadowCaster(model);
    const g = { id, owner: p, team: p.team, pos: model.position, vel, model, age: 0, still: 0, bounces: 0, spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10), done: false };
    this.grenades.push(g);
    this.emit('grenade_throw', p, id, strength);
    p.char?.throwGrenade();
    this.sound('grenade_throw', { pos: p.pos }, p);
    this.noise(p.pos, 500, 'throw', p);
    // after throwing, switch to the next weapon (CS: last weapon)
    setTimeout(() => {
      if (!p.alive) return;
      if (p.inv.grenades.includes(id)) this.switchTo(p, 'grenade:' + id, true);
      else if (p.inv.grenades.length) this.switchTo(p, 'grenade:' + p.inv.grenades[0], true);
      else { const back = ['primary', 'secondary', 'knife'].find(s => p.weaponInSlot(s)); this.switchTo(p, back || 'knife', true); }
    }, 450);
    // radio callout
    const call = { hegrenade: 'Fire in the hole!', flashbang: 'Flashbang out!', smokegrenade: 'Smoke out!', molotov: 'Molotov out!', incgrenade: 'Incendiary out!', decoy: 'Decoy out!' }[id];
    if (call) this.emit('radio', p, call);
  }
  removeGrenade(g, silent) { this.world.scene.remove(g.model); g.done = true; }
  updateGrenades(dt) {
    const GRAV = 800 * 0.4;
    for (const g of this.grenades) {
      if (g.done) continue;
      g.age += dt;
      const sub = 3, sdt = dt / sub;
      for (let s = 0; s < sub && !g.done; s++) {
        if (g.resting) break;
        g.vel.y -= GRAV * sdt;
        const step = _v1.copy(g.vel).multiplyScalar(sdt); const len = step.length();
        if (len < 1e-4) continue;
        const dir = _v2.copy(step).divideScalar(len);
        const hit = this.world.raycast(g.pos, dir, len + 2);
        // players block grenades too (simple sphere test)
        if (hit) {
          g.pos.copy(hit.point).addScaledVector(hit.normal, 2.2);
          const vn = g.vel.dot(hit.normal);
          const vt = _v3.copy(g.vel).addScaledVector(hit.normal, -vn);
          // CS: elasticity 0.45, tangential friction
          g.vel.copy(vt.multiplyScalar(hit.normal.y > 0.7 ? 0.6 : 0.8)).addScaledVector(hit.normal, -vn * 0.45);
          g.bounces++;
          if (Math.abs(vn) > 60) this.audio.play('grenade_bounce', { pos: g.pos, surface: hit.surface, volume: Math.min(1, Math.abs(vn) / 400) });
          if (Math.abs(vn) > 40) this.noise(g.pos, 500, 'bounce', g.owner);
          // molotov breaks on floor contact
          if ((g.id === 'molotov' || g.id === 'incgrenade') && hit.normal.y > 0.7) { this.detonate(g, hit.point); break; }
          if (hit.normal.y > 0.7 && g.vel.length() < 20) { g.resting = true; g.vel.set(0, 0, 0); }
        } else g.pos.add(step);
      }
      if (g.done) continue;
      // spin
      if (!g.resting) { g.model.rotation.x += g.spin.x * dt; g.model.rotation.z += g.spin.z * dt; }
      const speed = g.vel.length();
      if (speed < 10 || g.resting) g.still += dt; else g.still = 0;
      // fuses
      if ((g.id === 'hegrenade' || g.id === 'flashbang') && g.age >= 1.6) this.detonate(g, g.pos);
      else if (g.id === 'smokegrenade' && (g.still > 0.25 && g.age > 1.5 || g.age > 7)) this.detonate(g, g.pos);
      else if ((g.id === 'molotov' || g.id === 'incgrenade') && g.age >= 2.0) this.detonate(g, g.pos, true);
      else if (g.id === 'decoy' && (g.still > 0.3 && g.age > 1.5 || g.age > 7)) this.detonate(g, g.pos);
    }
    this.grenades = this.grenades.filter(g => !g.done || g.keep);
    // decoys (fake gunfire)
    for (const dc of this.decoys) {
      dc.t -= this.lastDt || 0.016;
      dc.next -= this.lastDt || 0.016;
      if (dc.next <= 0 && dc.t > 0) {
        const burst = 1 + Math.floor(Math.random() * 4);
        for (let i = 0; i < burst; i++) setTimeout(() => this.audio.play('decoy_shot', { pos: dc.pos, weapon: dc.weapon }), i * 100);
        this.noise(dc.pos, 3000, 'shot', null);
        dc.next = 0.8 + Math.random() * 1.6;
      }
      if (dc.t <= 0 && !dc.exploded) { dc.exploded = true; this.fx.explosion(dc.pos, { scale: 0.35 }); this.audio.play('he_explode', { pos: dc.pos, volume: 0.4 }); this.world.scene.remove(dc.model); }
    }
    this.decoys = this.decoys.filter(d => !d.exploded);
  }
  detonate(g, at, airburst = false) {
    if (g.done) return;
    const pos = at.clone();
    g.done = true;
    this.world.scene.remove(g.model);
    const owner = g.owner;
    switch (g.id) {
      case 'hegrenade': {
        const r = this.fx.explosion(pos, { scale: 1 });
        this.audio.play('he_explode', { pos });
        this.noise(pos, 3000, 'explosion', owner);
        if (r) this.emit('shake', r.shake || 0);
        for (const p of this.players) {
          if (!p.alive) continue;
          const c = _v1.set(p.pos.x, p.pos.y + 36, p.pos.z);
          const dist = c.distanceTo(pos); if (dist > 350) continue;
          const dir = _v2.subVectors(c, pos).normalize();
          const blocked = this.world.raycast(pos, dir, dist - 10);
          if (blocked) continue;
          const dmg = 98 * Math.max(0, 1 - dist / 350) ** 1.1;
          if (dmg < 1) continue;
          this.applyDamage(p, owner, dmg, 'generic', 'hegrenade', { grenade: true, raw: true, dir, from: pos });
        }
        break;
      }
      case 'flashbang': {
        this.fx.flashPop(pos);
        this.audio.play('flash_explode', { pos });
        this.noise(pos, 2000, 'explosion', owner);
        const smokeBlocked = this.fx.smokeLineBlocked ? this.fx.smokeLineBlocked.bind(this.fx) : null;
        for (const p of this.players) {
          if (!p.alive) continue;
          const res = computeFlash(p.eyePos(_v1), p.forward(_v2), pos, this.world, smokeBlocked);
          if (res.intensity > 0) {
            if (p.flash > 0 && p.flashDur - p.flashT > res.duration) continue;
            p.flash = res.intensity; p.flashDur = res.duration; p.flashT = 0;
            p.brain?.onFlashed?.(res);
            if (p === this.human || p === this.viewTarget) this.emit('flashed', p, res);
            if (owner && owner.team !== p.team && res.intensity > 0.6) owner.stats.score += 0; // enemies flashed stat could go here
          }
        }
        break;
      }
      case 'smokegrenade': {
        const h = this.fx.smoke(pos.clone().add(_v1.set(0, 2, 0)));
        const loop = this.audio.playLoop('smoke_hiss', { pos, fadeIn: 0.1 });
        this.audio.play('smoke_pop', { pos });
        const s = { handle: h, pos, loop, t: 0 };
        this.smokes.push(s);
        setTimeout(() => loop?.stop(1.5), 15000);
        // extinguish fires
        for (const f of this.fires) if (f.handle.alive && f.pos.distanceTo(pos) < 180) { f.handle.extinguish(); f.loop?.stop(0.5); this.audio.play('fire_extinguish', { pos: f.pos }); }
        this.noise(pos, 900, 'smoke', owner);
        break;
      }
      case 'molotov': case 'incgrenade': {
        this.audio.play(g.id === 'molotov' ? 'molotov_break' : 'incendiary_pop', { pos });
        if (airburst) { this.fx.explosion(pos, { scale: 0.25 }); break; }
        // fizzles in smoke
        if (this.fx.smokeDensity && this.fx.smokeDensity(pos.clone().add(_v1.set(0, 20, 0))) > 0.3) { this.audio.play('fire_extinguish', { pos }); break; }
        const h = this.fx.fire(pos, { team: g.team });
        const loop = this.audio.playLoop('fire_loop', { pos, fadeIn: 0.2 });
        this.fires.push({ handle: h, pos, loop, owner, weapon: g.id, t: 0 });
        this.noise(pos, 1000, 'fire', owner);
        break;
      }
      case 'decoy': {
        const wid = owner && owner.inv.primary ? owner.inv.primary.id : (owner && owner.inv.secondary ? owner.inv.secondary.id : 'ak47');
        const model = this.ctx.createWeaponModel('decoy', { lod: 'low' }); model.scale.setScalar(39.37); model.position.copy(pos); this.world.scene.add(model);
        this.decoys.push({ pos, weapon: wid, t: 15, next: 0.3, model, team: g.team });
        break;
      }
    }
  }
  updateFires(dt) {
    for (const f of this.fires) {
      f.t += dt;
      if (!f.handle.alive) { f.loop?.stop(0.8); f.dead = true; }
    }
    this.fires = this.fires.filter(f => !f.dead);
    for (const s of this.smokes) { s.t += dt; if (s.handle && !s.handle.alive) s.dead = true; }
    this.smokes = this.smokes.filter(s => !s.dead);
  }

  // ---------------------------------------------------------------- footsteps & spotting
  updateFootsteps(p, dt) {
    if (!p.onGround) return;
    const sp = p.horizontalSpeed();
    // CS: no footsteps when walking (shift) or crouching, or below ~ 135 u/s
    const loud = sp > 135 && !p.input.walk && p.duck < 0.5;
    p.stepDist += sp * dt;
    const stride = 70;
    if (p.stepDist >= stride) {
      p.stepDist = 0;
      if (loud) {
        const surface = this.world.surfaceAt ? this.world.surfaceAt(p.pos) : 'stone';
        this.sound('footstep', { pos: p.pos, surface, volume: p === this.viewTarget ? 0.55 : 1 }, p);
        this.noise(p.pos, 1100, 'step', p);
      }
    }
  }
  onPlayerEvent(p, ev, a) {
    if (ev === 'jump') { this.sound('jump', { pos: p.pos }, p); this.noise(p.pos, 700, 'jump', p); }
    else if (ev === 'land') { this.sound('land', { pos: p.pos, volume: 0.5 + a * 0.5 }, p); this.noise(p.pos, 900, 'land', p); if (p === this.viewTarget) this.emit('land', a); if (a > 0.2) this.fx.dustPuff?.(p.pos.clone(), 0.6 + a); }
    else if (ev === 'falldamage') { this.applyDamage(p, null, a, 'generic', 'world', { raw: true, fire: false, grenade: true }); }
    else if (ev === 'fellout') { if (p.alive) this.kill(p, null, 'world'); }
  }
  updateSpotting(dt) {
    // radar: enemies visible to any member of a team are "spotted" for that team
    this._spotT = (this._spotT || 0) - dt;
    if (this._spotT > 0) return;
    this._spotT = 0.15;
    for (const team of ['ct', 't']) {
      const set = this.spotted[team]; set.clear();
      const mine = this.players.filter(p => p.team === team && p.alive);
      for (const e of this.players) {
        if (e.team === team || !e.alive) continue;
        if (e.spotted > 0) { set.add(e.id); continue; }
        for (const m of mine) {
          if (m.brain && m.brain.canSee) { if (m.brain.visible && m.brain.visible.has(e.id)) { set.add(e.id); break; } continue; }
          if (this.canSee(m, e, 0.5)) { set.add(e.id); break; }
        }
      }
    }
  }
  // line of sight from p's eye to target (head or chest), honoring smokes and a view cone (cos)
  canSee(p, e, cosFov = -1, ignoreFov = false) {
    const eye = p.eyePos(_v1);
    const f = p.forward(_v2);
    for (const hgt of [e.eyeHeight, e.eyeHeight * 0.6]) {
      const target = _v3.set(e.pos.x, e.pos.y + hgt, e.pos.z);
      const to = _v4.subVectors(target, eye); const dist = to.length(); to.divideScalar(dist);
      if (!ignoreFov && to.dot(f) < cosFov) return false;
      if (dist > 6000) return false;
      const hit = this.world.raycast(eye, to, dist - 4);
      if (hit) continue;
      if (this.fx.smokeLineBlocked && this.fx.smokeLineBlocked(eye, target)) continue;
      return true;
    }
    return false;
  }
  alive(team) { return this.players.filter(p => p.alive && (!team || p.team === team)); }
}
export { raySphere, rayCapsule };
