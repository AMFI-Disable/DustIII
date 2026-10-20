// main.js — boot, input (CS2 default binds), camera, viewmodel/HUD/audio glue, spectating, render loop.
import * as THREE from 'three';
import { createWorld } from './world.js';
import { preloadWeaponAssets, createWeaponModel } from './weapon_models.js';
import { ViewModel } from './viewmodel.js';
import { preloadCharacterAssets, createCharacter } from './characters.js';
import { FX } from './fx.js';
import { AudioEngine } from './audio.js';
import { HUD, PLAYER_COLORS } from './hud.js';
import { Game, raySphere, rayCapsule } from './game.js';
import { BotBrain, Director } from './bots.js';
import { WEAPONS, RULES } from './weapon_data.js';

const D2R = Math.PI / 180;
const $ = (id) => document.getElementById(id);
const loadEl = $('loading'), loadBar = $('loadbar'), loadTxt = $('loadtxt');
function setLoad(f, txt) { loadBar.style.width = (f * 100).toFixed(1) + '%'; if (txt) loadTxt.textContent = txt; }
const Q = new URLSearchParams(location.search);
const NORENDER = Q.has('norender');

// ---------------------------------------------------------------- renderer & camera
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const CS_VFOV = 2 * Math.atan(Math.tan(45 * D2R) * 0.75) / D2R;   // CS2: 90° horizontal at 4:3 → 73.74° vertical
const camera = new THREE.PerspectiveCamera(CS_VFOV, innerWidth / innerHeight, 2, 14000);
camera.rotation.order = 'YXZ';

let world, fx, vm, game, hud;
const audio = new AudioEngine();
let audioReady = false;
let settings = null;
const state = { running: false, paused: false, wantLock: false, specIdx: 0, deathTime: 0, shake: 0, fps: 0, scoreboard: false, lastShadowT: 0, shadowAmt: 0 };

async function boot() {
  try {
    hud = new HUD($('hud'));
    hud.setVisible(false);
    settings = hud.getSettings();
    hud.onSettingsChange((s) => applySettings(s));
    setLoad(0.02, 'Loading map · 加载地图');
    world = await createWorld(renderer, { quality: Q.get('q') || settings.graphics || 'high', onProgress: (f, t) => setLoad(0.02 + f * 0.55, 'Loading map · 加载地图 ' + Math.round(f * 100) + '%') });
    setLoad(0.6, 'Loading weapons · 加载武器');
    await preloadWeaponAssets(renderer);
    setLoad(0.7, 'Loading characters · 加载角色');
    await preloadCharacterAssets(renderer);
    setLoad(0.78, 'Loading effects · 加载特效');
    fx = new FX({ scene: world.scene, renderer, camera, world });
    await fx.load();
    setLoad(0.84, 'Preparing viewmodels · 准备第一人称模型');
    vm = new ViewModel(renderer, { envMap: world.envMap });
    vm.setAspect(innerWidth / innerHeight);
    try { await vm.warmup(['ak47', 'm4a4', 'm4a1_s', 'awp', 'usp_s', 'glock', 'knife_ct', 'knife_t', 'deagle', 'c4', 'hegrenade', 'flashbang', 'smokegrenade']); } catch (e) { console.warn(e); }
    game = new Game({ world, fx, audio, hud, createCharacter, createWeaponModel, getMuzzleWorld: () => vm.getMuzzleWorld(camera, new THREE.Vector3()) });
    game.directors = { ct: new Director(game, 'ct'), t: new Director(game, 't') };
    wireGameEvents();
    onResize();
    setLoad(1, 'Ready · 就绪');
    // pre-render once to compile everything
    camera.position.set(820, 400, -1300); camera.lookAt(1470, 300, -1300);
    world.render(camera, [{ scene: vm.scene, camera: vm.camera }]);
    loadEl.classList.add('done');
    setTimeout(() => loadEl.remove(), 700);
    showMenu();
    requestAnimationFrame(loop);
    window.__ready = true;
  } catch (e) {
    console.error(e);
    loadTxt.textContent = 'Failed to load: ' + (e && e.message || e);
    loadEl.classList.add('err');
  }
}

function applySettings(s) {
  const prevQ = settings && settings.graphics;
  settings = s;
  if (world && s.graphics && s.graphics !== prevQ) { world.setQuality(s.graphics); onResize(); }
  if (audioReady) audio.setVolume({ master: s.volume.master, sfx: s.volume.sfx, music: s.volume.music });
  if (game) game.loadoutPref = s.loadout || {};
}

function showMenu() {
  state.running = false;
  hud.showMainMenu({
    onStart: async ({ side, difficulty }) => {
      hud.hideMainMenu();
      if (!audioReady) {
        try { await audio.init(); audioReady = true; audio.setVolume({ master: settings.volume.master, sfx: settings.volume.sfx, music: settings.volume.music }); } catch (e) { console.warn('audio init failed', e); }
      }
      startMatch(side, difficulty);
    },
  });
  // menu background camera: slow flyover of A site
  state.menuCam = true;
}

function startMatch(side, difficulty) {
  state.menuCam = false;
  if (hud.isMenuOpen() && !hud.isPaused()) hud.hideMainMenu();
  game.loadoutPref = settings.loadout || {};
  game.startMatch({ side, difficulty });
  for (const p of game.players) if (p.isBot) p.brain = new BotBrain(game, p, difficulty);
  for (const p of game.players) p.brain?.onRoundStart();
  game.directors.ct.onRoundStart(); game.directors.t.onRoundStart();
  vm.setTeam(game.human.team); vm.resetFirstDraw();
  vm.equip(game.human.activeId, 1.0);
  state.running = true; state.paused = false;
  hud.setVisible(true);
  requestLock();
  audio.stopMusic?.(0.5);
  ambience?.stop?.(1); ambience = audio.playLoop('warmup_ambience', { volume: 0.35, fadeIn: 2 });
}
let ambience = null;

// ---------------------------------------------------------------- game events → HUD / viewmodel / audio
function isView(p) { return game && p === game.viewTarget; }
function wireGameEvents() {
  game.on('round_start', ({ round, lastOfHalf, matchPoint, first }) => {
    game.directors.ct.onRoundStart(); game.directors.t.onRoundStart();
    hud.hideAnnounce();
    const h = game.human;
    vm.setTeam(h.team); vm.resetFirstDraw(); vm.setScoped(false); vm.setHidden(false);
    vm.equip(h.activeId, 0.6);
    hud.scope(0);
    state.deathTime = 0; endDeathCam();
    audio.play('round_start', { volume: 0.8 });
    if (lastOfHalf) hud.roundNotice('LAST ROUND OF FIRST HALF', 4);
    else if (matchPoint) hud.roundNotice('MATCH POINT', 4);
    else if (round === RULES.halftimeAfter + 1) hud.roundNotice('SECOND HALF', 4);
    if (h.inv.c4) setTimeout(() => hud.center('You have the bomb! Plant it at bombsite A or B.', 4), 300);
  });
  game.on('live', () => { if (game.human.alive && game.human.team === 'ct') hud.center('', 0); });
  game.on('round_end', ({ winner, reason, mvp, why }) => {
    const title = reason === 'defuse' ? 'BOMB HAS BEEN DEFUSED' : reason === 'bomb' ? 'TARGET HAS BEEN BOMBED' : winner === 'ct' ? 'COUNTER-TERRORISTS WIN' : 'TERRORISTS WIN';
    const sub = reason === 'defuse' || reason === 'bomb' ? (winner === 'ct' ? 'COUNTER-TERRORISTS WIN' : 'TERRORISTS WIN') : reason === 'time' ? 'Target has been saved' : '';
    hud.announce(title, sub, winner, RULES.roundEndDelay - 0.5);
    if (mvp) setTimeout(() => hud.announceMVP(mvp.name, why), 900);
    const mine = game.human.team === winner;
    audio.play(mvp === game.human ? 'mvp' : winner === 'ct' ? 'round_win_ct' : 'round_win_t', { volume: mine ? 0.9 : 0.6 });
    hud.progress(null, null);
  });
  game.on('halftime', () => { hud.halftime(game.score.ct, game.score.t, 6); });
  game.on('match_end', (winner) => {
    audio.play(winner === game.human.team ? 'match_win' : 'match_lose', { volume: 0.9 });
    hud.matchEnd({ winner, scoreCT: game.score.ct, scoreT: game.score.t, myTeam: game.human.team, stats: scoreboardData(),
      onRestart: () => { hud.matchEnd(null); startMatch(game.human.team, game.difficulty); },
      onMenu: () => { hud.matchEnd(null); state.running = false; showMenu(); } });
  });
  game.on('kill', (e) => {
    const me = game.human;
    hud.killfeed({ killer: e.attacker ? e.attacker.name : null, killerTeam: e.attacker ? e.attacker.team : null, victim: e.victim.name, victimTeam: e.victim.team,
      weapon: e.weapon === 'world' ? 'skull' : e.weapon === 'c4' ? 'bomb' : (e.weapon === 'molotov' || e.weapon === 'incgrenade') && !e.attacker ? 'inferno' : e.weapon,
      headshot: e.headshot, wallbang: e.wallbang, noscope: e.noscope, smoke: e.smoke, blind: e.blind, assister: e.assister ? e.assister.name : null,
      involvesMe: e.victim === me ? 'victim' : (e.attacker === me || e.assister === me) });
    if (e.victim === me) { state.deathTime = performance.now(); hud.flash(0, 0); vm.setHidden(true); hud.scope(0); audio.muffle(0); startDeathCam(e); }
    if (e.victim === game.viewTarget && e.victim !== me) setTimeout(() => nextSpectate(1), 1200);
  });
  game.on('equip', (p, id, draw) => { if (isView(p)) { vm.equip(id, draw); vm.setScoped(false); hud.scope(0); } });
  game.on('fire', (p, w, o) => { if (isView(p)) vm.fire({ shotIndex: o.shotIndex, lastShot: o.lastShot }); });
  game.on('dryfire', (p) => { if (isView(p)) vm.dryFire(); });
  game.on('reload', (p, t, empty) => { if (isView(p)) vm.reload(t, { empty }); });
  game.on('reload_start', (p, t) => { if (isView(p)) vm.reloadStart(t); });
  game.on('reload_shell', (p, t) => { if (isView(p)) vm.reloadShell(t); });
  game.on('reload_end', (p, t) => { if (isView(p)) vm.reloadEnd(t); });
  game.on('knife', (p, heavy) => { if (isView(p)) vm.knifeAttack(heavy); });
  game.on('grenade_pull', (p) => { if (isView(p)) vm.grenadePull(); });
  game.on('grenade_throw', (p, id, s) => { if (isView(p)) vm.grenadeThrow(s); });
  game.on('plant_start', (p) => { if (isView(p)) vm.c4Plant(true); });
  game.on('plant_stop', (p) => { if (isView(p)) vm.c4Plant(false); });
  game.on('inspect', (p) => { if (isView(p)) vm.inspect(); });
  game.on('zoom', (p, level) => { if (isView(p)) { vm.setScoped(level > 0 && WEAPONS[p.activeId].scope === 2); } });
  game.on('bomb_planted', (p, site) => {
    if (isView(p)) vm.c4Plant(false);
    hud.center('The bomb has been planted.', 3);
    audio.play('radio', { volume: 0.6 });
    game.bombMusic = audio.playLoop('bomb_planted_music', { volume: 0.5, fadeIn: 0.5 });
    state.final10 = false;
  });
  game.on('bomb_defused', () => { hud.center('The bomb has been defused.', 3); });
  game.on('bomb_dropped', (p) => { if (game.human.team === 't') hud.radio(p.name, 't', 'The bomb has been dropped!'); });
  game.on('radio', (p, text) => { if (p.team === game.human.team && p !== game.human) { hud.radio(p.name, p.team, text); audio.play('radio', { volume: 0.25 }); } });
  game.on('notice', (text) => hud.center(text, 2.5));
  game.on('money', (delta, popup) => { if (popup && delta) hud.showMoney(delta); });
  game.on('hurt', (p, dmg, ang) => { if (p === game.human) hud.damage(ang, dmg); });
  game.on('flashed', (p, res) => {
    if (p === game.viewTarget) { hud.flash(res.intensity, res.duration, canvas); state.flashEnd = performance.now() + res.duration * 1000; state.flashI = res.intensity; }
  });
  game.on('shake', (s) => { state.shake = Math.max(state.shake, s * 1.0); });
  game.on('land', (a) => { state.landed = a; });
}

// ---------------------------------------------------------------- input (CS2 default binds)
const keys = new Set();
const mouse = { dx: 0, dy: 0, b0: false, b2: false };
function locked() { return document.pointerLockElement === canvas || (state.noLock && state.running && !hud.isAnyMenuOpen()); }
document.addEventListener('pointerlockerror', () => {
  // embedded frames may forbid pointer lock: fall back to free mouse-look over the canvas
  if (!state.noLock) { state.noLock = true; hud.center('Pointer lock unavailable here — open the game in its own tab for full mouse control.', 6); }
});
function requestLock() {
  state.wantLock = true;
  try {
    const r = canvas.requestPointerLock({ unadjustedMovement: !!(settings && settings.rawInput) });
    if (r && r.catch) r.catch(() => { try { canvas.requestPointerLock(); } catch (e) { } });
  } catch (e) { try { canvas.requestPointerLock(); } catch (e2) { } }
}
document.addEventListener('pointerlockchange', () => {
  const lk = locked();
  $('clickhint').classList.toggle('on', !lk && state.running && !hud.isAnyMenuOpen() && !state.matchEnd);
  if (!lk && !state.noLock && state.running && !hud.isBuyMenuOpen() && !hud.isAnyMenuOpen() && game.phase !== 'matchover') {
    // Esc → pause menu (CS2 opens the menu)
    openPause();
  }
});
function openPause() {
  if (hud.isPaused()) return;
  state.paused = true; keys.clear(); mouse.b0 = mouse.b2 = false;
  hud.showPause({
    onResume: () => { hud.hidePause(); state.paused = false; requestLock(); },
    onQuit: () => { hud.hidePause(); state.paused = false; state.running = false; for (const p of game.players) game.removePlayer(p); game.players = []; vm.setHidden(true); hud.setVisible(false); bombMusicStop(); showMenu(); },
  });
}
function bombMusicStop() { game.bombMusic?.stop(0.3); game.bombMusic = null; }
canvas.addEventListener('mousedown', (e) => {
  if (!state.running) return;
  if (!locked()) { if (!hud.isAnyMenuOpen()) requestLock(); if (!state.noLock) return; }
  if (e.button === 0) { mouse.b0 = true; ctl().attack = true; ctl().attackPressed = true; if (!game.human.alive) nextSpectate(1); }
  if (e.button === 2) { mouse.b2 = true; ctl().attack2 = true; ctl().attack2Pressed = true; if (!game.human.alive) nextSpectate(-1); }
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) { mouse.b0 = false; if (game) ctl().attack = false; }
  if (e.button === 2) { mouse.b2 = false; if (game) ctl().attack2 = false; }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
$('clickhint').addEventListener('click', () => requestLock());
window.addEventListener('mousemove', (e) => { if (locked()) { mouse.dx += e.movementX; mouse.dy += e.movementY; } });
window.addEventListener('keydown', (e) => { if (state.noLock && e.code === 'Escape' && state.running && !hud.isAnyMenuOpen()) openPause(); });
window.addEventListener('wheel', (e) => {
  if (!state.running || !locked() || !game.human.alive) return;
  game.cycleWeapon(game.human, e.deltaY > 0 ? 1 : -1);
}, { passive: true });
function ctl() { const h = game.human; return h.ctl || (h.ctl = {}); }
window.addEventListener('keydown', (e) => {
  if (!state.running || !game) return;
  if (e.code === 'Tab') { e.preventDefault(); state.scoreboard = true; return; }
  if (hud.isAnyMenuOpen() && e.code !== 'KeyB') return;
  if (e.code === 'Escape') return;   // pointer lock exit handles pause
  if (!locked() && e.code !== 'KeyB') return;
  if (['Space', 'ControlLeft', 'ControlRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  const h = game.human;
  // spectator controls
  if (!h.alive) { if (e.code === 'Space') nextSpectate(1); return; }
  switch (e.code) {
    case 'Space': h.input.jump = true; break;
    case 'KeyR': ctl().reload = true; break;
    case 'KeyF': ctl().inspect = true; break;
    case 'KeyG': game.dropActive(h); break;
    case 'KeyQ': game.lastWeapon(h); break;
    case 'Digit1': game.switchTo(h, 'primary'); break;
    case 'Digit2': if (!game.switchTo(h, 'secondary')) game.switchTo(h, 'taser'); break;
    case 'Digit3': game.switchTo(h, 'knife'); break;
    case 'Digit4': game.switchTo(h, 'grenade'); break;
    case 'Digit5': game.switchTo(h, 'c4'); break;
    case 'KeyE': game.useAction(h); break;
    case 'KeyB': toggleBuy(); break;
    case 'KeyZ': radioMenu(['Go go go!', 'Fall back!', 'Stick together, team.', 'Hold this position.', 'Follow me.']); break;
    case 'KeyX': radioMenu(['Affirmative.', 'Enemy spotted.', 'Need backup!', 'Sector clear.', 'I\'m in position.']); break;
    case 'KeyC': radioMenu(['Negative.', 'Enemy down.', 'Taking fire, need assistance!', 'Reporting in.', 'Get out of there, it\'s gonna blow!']); break;
    case 'F1': case 'F2': break;
  }
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Tab') state.scoreboard = false;
});
window.addEventListener('blur', () => { keys.clear(); mouse.b0 = mouse.b2 = false; if (game && game.human) { const c = ctl(); c.attack = c.attack2 = false; } });
let radioOpen = null;
function radioMenu(list) {
  // simplified CS radio: sends the first-relevant message immediately (cycles on repeated presses)
  radioOpen = radioOpen && radioOpen.list === list ? { list, i: (radioOpen.i + 1) % list.length } : { list, i: 0 };
  const msg = list[radioOpen.i];
  hud.radio(game.human.name, game.human.team, msg); audio.play('radio', { volume: 0.4 });
}
function toggleBuy() {
  const h = game.human;
  if (hud.isBuyMenuOpen()) { hud.closeBuyMenu(); return; }
  if (!h.alive) return;
  if (!game.canBuy(h)) { hud.center(game.inBuyZone(h) ? 'Buy time has expired.' : 'You are not in a buy zone.', 2); if (game.phase !== 'freeze' && game.buyTimeLeft <= 0) return; }
  keys.clear(); mouse.b0 = mouse.b2 = false; const c = ctl(); c.attack = c.attack2 = false;
  hud.openBuyMenu(buyOpts());
}
function buyOpts() {
  const h = game.human;
  const owned = new Set();
  for (const k of ['primary', 'secondary', 'taser']) if (h.inv[k]) owned.add(h.inv[k].id);
  if (h.armor > 0) owned.add('vest'); if (h.helmet && h.armor > 0) owned.add('vesthelm'); if (h.defuser) owned.add('defuser');
  const grenadeCounts = {}; for (const g of h.inv.grenades) grenadeCounts[g] = (grenadeCounts[g] || 0) + 1;
  return {
    team: h.team, money: h.money, owned, grenadeCounts, armor: h.armor, helmet: h.helmet, canBuy: game.canBuy(h),
    reason: game.inBuyZone(h) ? 'Buy time has expired' : 'You are not in a buy zone',
    onBuy: (id) => { const r = game.buy(h, id); if (r.ok) setTimeout(() => hud.updateBuyMenu(buyOpts()), 0); else audio.play('buy_deny', { volume: 0.6 }); return r; },
    onSell: (id) => { const r = game.sell(h, id); if (r.ok) setTimeout(() => hud.updateBuyMenu(buyOpts()), 0); return r; },
    onClose: () => { if (state.running && !hud.isPaused()) requestLock(); },
  };
}

// ---------------------------------------------------------------- spectating
function nextSpectate(dir) {
  const h = game.human;
  if (h.alive) return;
  const mates = game.players.filter(p => p.alive && p.team === h.team);
  const pool = mates.length ? mates : game.players.filter(p => p.alive);
  if (!pool.length) return;
  let i = pool.indexOf(game.viewTarget);
  i = (i + dir + pool.length) % pool.length;
  setViewTarget(pool[i]);
}
function setViewTarget(p) {
  endDeathCam();
  game.viewTarget = p;
  vm.setTeam(p.team); vm.setHidden(false); vm.setScoped(false);
  vm.equip(p.activeId, 0.3);
}

// ---------------------------------------------------------------- per-frame
const clock = new THREE.Clock();
let fpsAcc = 0, fpsN = 0, radarT = 0, hudT = 0;
const _v = new THREE.Vector3(), _fw = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
let prevYaw = 0, prevPitch = 0, menuT = 0;
function loop() {
  requestAnimationFrame(loop);
  if (NORENDER && window.__manual) return;
  frame(clock.getDelta());
}
window.__renderOnce = (dt = 1 / 60, sim = false, draw = true) => { const p = state.paused; if (!sim) state.paused = true; frame(dt, !draw); state.paused = p; };
function frame(dt, noDraw = false) {
  fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { state.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; if (settings && settings.showFps) hud.fps(Math.round(state.fps)); }
  dt = Math.min(dt, 0.05);
  if (!game || !state.running) {
    // menu flyover
    menuT += dt;
    if (world) {
      const a = menuT * 0.05;
      camera.position.set(600 + Math.cos(a) * 900, 900, -900 + Math.sin(a) * 700); camera.lookAt(0, 150, -300);
      if (fx) fx.update(dt, camera);
      world.render(camera, []);
    }
    return;
  }
  const h = game.human;
  if (!state.paused) {
    // ---- human input → player
    if (h.alive && !hud.isAnyMenuOpen() && locked()) {
      const sens = (settings.sensitivity || 1) * 0.022 * D2R;
      const w = h.activeWeapon;
      let zm = 1;
      if (w && w.zoom > 0 && WEAPONS[w.id].zoom) zm = (WEAPONS[w.id].zoom[w.zoom - 1] / 90) * (settings.zoomSensitivity || 1);
      h.yaw -= mouse.dx * sens * zm;
      h.pitch -= mouse.dy * sens * zm * (settings.invertY ? -1 : 1);
      h.pitch = Math.max(-89 * D2R, Math.min(89 * D2R, h.pitch));
      h.input.fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
      h.input.side = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
      h.input.duck = keys.has('ControlLeft') || keys.has('ControlRight');
      h.input.walk = keys.has('ShiftLeft') || keys.has('ShiftRight');
      const c = ctl(); c.attack = mouse.b0; c.attack2 = mouse.b2;
      // E held → keep defusing
      if (keys.has('KeyE') && game.bomb.state === 'planted' && h.team === 'ct') game.useAction(h);
    } else if (h.alive) { h.input.fwd = h.input.side = 0; h.input.duck = false; const c = ctl(); c.attack = c.attack2 = false; }
    mouse.dx = mouse.dy = 0;
    game.update(dt);
    // spectate after death
    if (!h.alive && game.viewTarget === h && state.deathTime && performance.now() - state.deathTime > DEATHCAM_LEN * 1000) nextSpectate(1);
  } else { mouse.dx = mouse.dy = 0; }

  // ---- camera from view target
  const vt = game.viewTarget || h;
  const inDeathCam = !vt.alive && vt === h && state.death;
  const eyeY = vt.alive ? vt.eyeHeight : 20;
  camera.position.set(vt.pos.x, vt.pos.y + eyeY, vt.pos.z);
  // smooth instant step-ups (Source does this too) so ledges feel like slopes
  if (vt.alive && !inDeathCam) {
    if (state.camLastVt === vt && vt.onGround) { const dy = vt.pos.y - state.camLastY; if (dy > 3 && dy < 40) state.camYOff = (state.camYOff || 0) - dy; }
    state.camYOff = (state.camYOff || 0) * Math.exp(-dt * 12); if (Math.abs(state.camYOff) < 0.05) state.camYOff = 0;
    camera.position.y += state.camYOff;
    state.camLastY = vt.pos.y; state.camLastVt = vt;
  } else { state.camYOff = 0; state.camLastVt = null; }
  let yaw = vt.yaw, pitch = vt.pitch;
  // aim punch display (CS: camera shows 45% of the bullet offset) + damage flinch
  yaw += (vt.punch.y * 0.9 + vt.viewPunch.y) * D2R;
  pitch += (vt.punch.p * 0.9 + vt.viewPunch.p) * D2R;
  if (state.shake > 0.001) { yaw += (Math.random() - 0.5) * state.shake * 0.02; pitch += (Math.random() - 0.5) * state.shake * 0.02; state.shake *= Math.exp(-dt * 5); }
  if (inDeathCam) updateDeathCam(dt);
  else camera.rotation.set(pitch, yaw, 0, 'YXZ');
  // FOV (scoped)
  const aw = vt.activeWeapon;
  let vfov = CS_VFOV;
  if (aw && aw.zoom > 0 && WEAPONS[aw.id].zoom && vt.alive) { const hf = WEAPONS[aw.id].zoom[aw.zoom - 1]; vfov = 2 * Math.atan(Math.tan(hf / 2 * D2R) * 0.75) / D2R; }
  if (inDeathCam && state.death.fov) vfov = state.death.fov;
  if (Math.abs(camera.fov - vfov) > 0.01) { camera.fov += (vfov - camera.fov) * Math.min(1, dt * 18); if (Math.abs(camera.fov - vfov) < 0.05) camera.fov = vfov; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();
  // characters: hide the one we're looking through
  for (const p of game.players) if (p.char) p.char.setVisible(!(p === vt && p.alive));

  // ---- viewmodel
  const yawD = angWrap(vt.yaw - prevYaw), pitchD = vt.pitch - prevPitch; prevYaw = vt.yaw; prevPitch = vt.pitch;
  const scopeLvl = aw && aw.zoom > 0 ? (WEAPONS[aw.id].scope === 2 ? 2 : 1) : 0;
  vm.setHidden(!vt.alive);
  vm.update(dt, { speed: vt.horizontalSpeed(), maxSpeed: vt.maxSpeed, onGround: vt.onGround, crouching: vt.duck > 0.5, landed: state.landed || 0, yawDelta: yawD, pitchDelta: pitchD, walking: vt.input.walk, time: game.time, camera });
  state.landed = 0;
  if (performance.now() - state.lastShadowT > 120) {
    state.lastShadowT = performance.now();
    state.shadowAmt = world.isInShadow(camera.position);
    vm.setLighting({ shadow: state.shadowAmt });
  }

  // ---- fx, audio
  fx.update(dt, camera);
  camera.getWorldDirection(_fw);
  if (audioReady) {
    audio.setListener(camera.position, _fw, _up);
    let muff = 0;
    if (state.flashEnd && performance.now() < state.flashEnd) muff = Math.min(1, (state.flashEnd - performance.now()) / 2500) * state.flashI;
    audio.muffle(muff);
    // last 10 seconds of the bomb: intensify music
    if (game.bomb.state === 'planted' && game.bomb.timeLeft < 10 && !state.final10) { state.final10 = true; game.bombMusic?.stop(0.3); game.bombMusic = audio.playLoop('bomb_final10', { volume: 0.55 }); }
    if (game.phase !== 'planted' && game.phase !== 'over' && game.bombMusic) bombMusicStop();
    if (game.phase === 'live' && game.timer < 10 && game.timer + dt >= 10 && game.bomb.state !== 'planted') audio.play('ten_seconds', { volume: 0.5 });
  }

  // ---- HUD (throttled pieces)
  hudT -= dt; radarT -= dt;
  if (hudT <= 0) { hudT = 1 / 30; updateHUD(vt, scopeLvl); }
  if (radarT <= 0) { radarT = 1 / 30; updateRadar(vt); }
  hud.scoreboard(state.scoreboard, state.scoreboard ? scoreboardData() : null);

  updateNameTags(vt, dt);
  // ---- render
  if (!noDraw) world.render(camera, vt.alive ? [{ scene: vm.scene, camera: vm.camera }] : []);
}
function angWrap(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }

function updateHUD(vt, scopeLvl) {
  const h = game.human;
  const me = vt;
  const w = me.activeWeapon, id = me.activeId, d = WEAPONS[id];
  const inv = [];
  if (me.inv.primary) inv.push({ slot: 1, id: me.inv.primary.id, name: WEAPONS[me.inv.primary.id].name, active: me.active === 'primary' });
  if (me.inv.secondary) inv.push({ slot: 2, id: me.inv.secondary.id, name: WEAPONS[me.inv.secondary.id].name, active: me.active === 'secondary' });
  if (me.inv.taser) inv.push({ slot: 2, id: 'taser', name: 'Zeus x27', active: me.active === 'taser' });
  if (me.inv.knife) inv.push({ slot: 3, id: me.inv.knife.id, name: 'Knife', active: me.active === 'knife' });
  for (const g of me.inv.grenades) inv.push({ slot: 4, id: g, name: WEAPONS[g].name, active: me.active === 'grenade:' + g });
  if (me.inv.c4) inv.push({ slot: 5, id: 'c4', name: 'C4 Explosive', active: me.active === 'c4' });
  const pl = (team) => game.players.filter(p => p.team === team).map(p => ({ name: p.name, alive: p.alive, hp: p.hp, money: p.money, hasKit: p.defuser, hasBomb: p.inv.c4 && h.team === 't' }));
  const spread = d && d.inStand ? game.spreadPixels(me, camera.fov, innerHeight) : 0;
  const phase = game.phase === 'over' || game.phase === 'matchover' ? 'over' : game.phase;
  const s = {
    hp: me.hp, armor: me.armor, helmet: me.helmet, money: me === h ? h.money : me.money, team: me.team, alive: me.alive,
    weapon: d ? { id, name: d.name, clip: w ? w.clip : (d.cat === 'grenade' ? -1 : -1), reserve: w ? w.reserve : 0, mode: w && d.burstMode ? (w.burst ? 'burst' : (d.auto ? 'auto' : 'semi')) : null } : null,
    inventory: inv,
    roundTime: game.phase === 'freeze' ? game.timer : game.phase === 'over' ? 0 : game.timer,
    phase, scoreCT: game.score.ct, scoreT: game.score.t, round: game.round, maxRounds: RULES.maxRounds,
    ctPlayers: pl('ct'), tPlayers: pl('t'),
    inBuyZone: h.alive && game.inBuyZone(h), canBuy: game.canBuy(h), buyTimeLeft: Math.max(0, game.buyTimeLeft),
    hasKit: me.defuser, hasBomb: me.inv.c4,
    location: me.alive ? world.calloutAt(me.pos) : '',
    crosshair: { spread: Math.max(0, spread - 4), visible: me.alive && !(d && d.cat === 'knife' && false) },
    scoped: scopeLvl,
    spectating: !h.alive && vt !== h ? { name: vt.name, hp: vt.hp, armor: vt.armor, weaponName: d ? d.name : '', weaponId: id, team: vt.team } : null,
  };
  if (!h.alive && vt !== h) s.alive = true;   // CS2: show spectated player's vitals
  if (!h.alive && vt === h) s.alive = false;
  hud.update(s);
  // plant / defuse progress + hints
  if (h.alive && h.planting > 0) hud.progress('PLANTING BOMB', h.planting / RULES.plantTime, RULES.plantTime - h.planting);
  else if (game.bomb.defuser && (game.bomb.defuser === vt)) hud.progress('DEFUSING BOMB', game.bomb.defuseProgress / game.bomb.defuseTotal, game.bomb.defuseTotal - game.bomb.defuseProgress);
  else hud.progress(null, null);
  if (h.alive && h.team === 'ct' && game.bomb.state === 'planted' && !game.bomb.defuser && h.pos.distanceTo(game.bomb.pos) < 110) { if (!state.defHint) { state.defHint = true; hud.center(h.defuser ? 'Hold E to defuse (with kit: 5 s)' : 'Hold E to defuse the bomb (10 s)', 2); } }
  else state.defHint = false;
}
function updateRadar(vt) {
  const h = game.human;
  const team = h.team;
  const players = game.players.map(p => ({ x: p.pos.x, z: p.pos.z, yaw: p.yaw, team: p.team, alive: p.alive, isMe: p === vt, name: p.name, hasBomb: p.inv.c4, firing: game.time - p.lastShotTime < 0.25, index: p.slotIndex }))
    .filter(p => p.team === team || p.isMe);
  const spotted = game.players.filter(p => p.team !== team && p.alive && game.spotted[team].has(p.id)).map(p => ({ x: p.pos.x, z: p.pos.z, yaw: p.yaw }));
  let bomb = null;
  const b = game.bomb;
  if (b.state === 'planted') bomb = { x: b.pos.x, z: b.pos.z, state: 'planted' };
  else if (b.state === 'dropped' && b.dropRef && (team === 't' || game.spotted.ct.size >= 0)) bomb = { x: b.dropRef.pos.x, z: b.dropRef.pos.z, state: 'dropped' };
  else if (b.state === 'carried' && b.carrier && team === 't') bomb = { x: b.carrier.pos.x, z: b.carrier.pos.z, state: 'carried' };
  else if (b.state === 'defused') bomb = { x: b.pos.x, z: b.pos.z, state: 'defused' };
  if (bomb && bomb.state === 'dropped' && team === 'ct' && !game.spotted.ct.size) bomb = null;
  hud.radar({ me: { x: vt.pos.x, z: vt.pos.z, yaw: vt.yaw }, team, players, spottedEnemies: spotted, bomb, rotate: settings.radar ? settings.radar.rotate !== false : true });
}
function scoreboardData() {
  const h = game.human;
  const row = (p) => ({ name: p.name, alive: p.alive, money: p.money, k: p.stats.k, a: p.stats.a, d: p.stats.d, mvp: p.stats.mvp, hsp: p.stats.k > 0 ? Math.round(100 * p.stats.hs / p.stats.k) : 0,
    adr: Math.round(p.stats.dmg / Math.max(1, game.round - (game.phase === 'over' ? 0 : 1) || 1)), score: p.stats.score, index: p.slotIndex, isMe: p === h, bot: p.isBot, hasKit: p.defuser, hasBomb: p.inv.c4 && h.team === 't' });
  return { map: 'Dust II', mode: 'Competitive', scoreCT: game.score.ct, scoreT: game.score.t, round: game.round, maxRounds: RULES.maxRounds, myTeam: h.team,
    teams: { ct: game.players.filter(p => p.team === 'ct').map(row).sort((a, b) => b.score - a.score), t: game.players.filter(p => p.team === 't').map(row).sort((a, b) => b.score - a.score) },
    history: game.history.map(x => ({ winner: x.winner, reason: x.reason })) };
}

// ---------------------------------------------------------------- death cam + "killed by" panel (CS2 style)
const DEATHCAM_LEN = 5.2;
const _dc1 = new THREE.Vector3(), _dc2 = new THREE.Vector3(), _dc3 = new THREE.Vector3(), _dcQ = new THREE.Quaternion();
const deathUI = (() => {
  const css = document.createElement('style');
  css.textContent = `
  #killedby { position: fixed; left: 50%; bottom: 13vh; transform: translate(-50%, 12px); opacity: 0; transition: opacity .35s ease, transform .35s ease;
    z-index: 30; pointer-events: none; min-width: min(460px, 92vw); font-family: "Saira Condensed", "Rajdhani", "Noto Sans SC", sans-serif; color: #ece6da;
    background: linear-gradient(180deg, rgba(14,16,19,.88), rgba(10,11,13,.92)); border-top: 2px solid #c8463c; box-shadow: 0 10px 40px rgba(0,0,0,.45); }
  #killedby.on { opacity: 1; transform: translate(-50%, 0); }
  #killedby .hd { display: flex; align-items: center; gap: 10px; padding: 10px 16px 8px; font-size: 13px; letter-spacing: .22em; color: #e6877e; text-transform: uppercase; }
  #killedby .hd .zh { letter-spacing: .1em; color: #b9867f; }
  #killedby .main { display: flex; align-items: center; gap: 14px; padding: 2px 16px 12px; }
  #killedby .av { width: 44px; height: 44px; flex: none; display: grid; place-items: center; font-size: 22px; font-weight: 700; color: #11141a; }
  #killedby .nm { font-size: 30px; font-weight: 700; line-height: 1; letter-spacing: .02em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #killedby .wp { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }
  #killedby .wp img { height: 26px; filter: drop-shadow(0 1px 1px rgba(0,0,0,.6)); }
  #killedby .wp .hs { height: 22px; }
  #killedby .hp { flex: none; display: flex; flex-direction: column; align-items: flex-end; font-variant-numeric: tabular-nums; }
  #killedby .hp b { font-size: 26px; line-height: 1; }
  #killedby .hp span { font-size: 11px; letter-spacing: .2em; color: #9a958b; }
  #killedby .dmg { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: rgba(255,255,255,.06); font-size: 15px; font-variant-numeric: tabular-nums; }
  #killedby .dmg div { background: rgba(10,11,13,.92); padding: 8px 16px; }
  #killedby .dmg em { font-style: normal; color: #9a958b; font-size: 12px; letter-spacing: .14em; display: block; }
  #killedby .tip { padding: 6px 16px 9px; font-size: 12px; color: #8d877c; letter-spacing: .08em; }
  #killmark { position: fixed; z-index: 29; pointer-events: none; transform: translate(-50%, -100%); display: none; text-align: center;
    font-family: "Saira Condensed", "Rajdhani", sans-serif; color: #ff9f94; text-shadow: 0 1px 3px #000; }
  #killmark b { display: block; font-size: 16px; letter-spacing: .06em; }
  #killmark i { display: block; width: 0; height: 0; margin: 2px auto 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-top: 10px solid #ff6a5c; }
  #deathvig { position: fixed; inset: 0; z-index: 2; pointer-events: none; opacity: 0; transition: opacity .6s ease;
    background: radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(70,0,0,.55) 100%); }
  #deathvig.on { opacity: 1; }`;
  document.head.appendChild(css);
  const panel = document.createElement('div'); panel.id = 'killedby'; document.body.appendChild(panel);
  const mark = document.createElement('div'); mark.id = 'killmark'; document.body.appendChild(mark);
  const vig = document.createElement('div'); vig.id = 'deathvig'; document.body.appendChild(vig);
  return { panel, mark, vig };
})();
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function startDeathCam(e) {
  const me = game.human, k = e.attacker && e.attacker !== me ? e.attacker : null;
  const eye = new THREE.Vector3(me.pos.x, me.pos.y + me.eyeHeight, me.pos.z);
  // where the killing blow came from
  const from = k ? k.pos.clone() : (e.weapon === 'c4' ? game.bomb.pos.clone() : null);
  state.death = { t0: performance.now(), killer: k, weapon: e.weapon, eye, startYaw: me.yaw, startPitch: me.pitch, from,
    roll: (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.25), fov: null, orbit: null };
  // panel
  const ctCol = '#8fc6f2', tCol = '#e7c063';
  let title, nameHtml = '', av = '', wpn = '', hp = '';
  if (k) {
    const col = k.team === 'ct' ? ctCol : tCol;
    title = 'Killed by <span class="zh">击杀者</span>';
    av = `<div class="av" style="background:${col}">${esc(k.name[0] || '?')}</div>`;
    nameHtml = `<div class="nm" style="color:${col}">${esc(k.name)}</div>`;
    const wid = WEAPONS[e.weapon] ? e.weapon : null;
    wpn = `<div class="wp">${wid ? `<img src="assets/ui/weapons/${wid}.svg" alt="${esc(WEAPONS[wid].name)}">` : ''}${e.headshot ? '<img class="hs" src="assets/ui/icons/headshot.svg" alt="headshot">' : ''}${e.wallbang ? '<img class="hs" src="assets/ui/icons/wallbang.svg" alt="wallbang">' : ''}</div>`;
    hp = `<div class="hp"><b style="color:${k.hp <= 20 ? '#ff6a5c' : '#ece6da'}">${k.alive ? k.hp : 0}</b><span>HP</span></div>`;
  } else {
    title = 'You died <span class="zh">你阵亡了</span>';
    const why = e.weapon === 'c4' ? 'Killed by the bomb · 被炸弹炸死' : e.weapon === 'world' ? 'Fell to your death · 摔死' : (e.attacker === me ? 'Killed yourself · 自杀' : 'Killed · 阵亡');
    nameHtml = `<div class="nm">${esc(why)}</div>`;
  }
  let dmg = '';
  if (k) {
    const given = game.dmgLog.get(me.id + '>' + k.id) || { dmg: 0, hits: 0 };
    const taken = game.dmgLog.get(k.id + '>' + me.id) || { dmg: 0, hits: 0 };
    dmg = `<div class="dmg"><div><em>DAMAGE GIVEN · 造成伤害</em>${given.dmg} in ${given.hits} hit${given.hits === 1 ? '' : 's'}</div>
      <div><em>DAMAGE TAKEN · 承受伤害</em>${taken.dmg} in ${taken.hits} hit${taken.hits === 1 ? '' : 's'}</div></div>`;
  }
  deathUI.panel.innerHTML = `<div class="hd">${title}</div><div class="main">${av}${nameHtml}${wpn}${hp}</div>${dmg}
    <div class="tip">Click to spectate teammates · 点击观战队友</div>`;
  setTimeout(() => { if (state.death) deathUI.panel.classList.add('on'); }, 450);
  deathUI.vig.classList.add('on');
  canvas.style.transition = 'filter .8s ease'; canvas.style.filter = 'saturate(0.45) contrast(1.06) brightness(0.92)';
}
function endDeathCam() {
  if (!state.death && !deathUI.panel.classList.contains('on')) return;
  state.death = null;
  deathUI.panel.classList.remove('on'); deathUI.mark.style.display = 'none'; deathUI.vig.classList.remove('on');
  canvas.style.filter = '';
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * t * (t * (t * 6 - 15) + 10); };
function updateDeathCam(dt) {
  const D = state.death, me = game.human, k = D.killer;
  const t = (performance.now() - D.t0) / 1000;
  // body position: follow the ragdoll's head if available (hitboxes follow the ragdoll), else the feet
  let head = _dc1.set(me.pos.x, me.pos.y + 14, me.pos.z);
  if (me.char) { const hb = me.char.getHitboxes(me._dcHb || (me._dcHb = [])); const hh = hb.find(b => b.group === 'head'); if (hh) head = _dc1.copy(hh.a); }
  // phase A (0–0.6 s): first-person collapse — drop, roll, tip forward
  const a = smooth(0, 0.6, t);
  const fallPos = _dc2.copy(D.eye).lerp(_dc3.set(head.x, Math.max(head.y, me.pos.y + 10) + 6, head.z), a * a);
  // phase B (0.6–1.7 s): pull back into a third-person view over the body, turning toward the killer
  if (!D.orbit) {
    const dir = new THREE.Vector3();
    if (D.from) dir.subVectors(D.eye, D.from).setY(0); else dir.set(Math.sin(D.startYaw), 0, Math.cos(D.startYaw));
    if (dir.lengthSq() < 1) dir.set(0, 0, 1);
    dir.normalize();
    const want = D.eye.clone().addScaledVector(dir, 110).add(new THREE.Vector3(0, 70, 0));
    // keep the camera out of walls
    const base = new THREE.Vector3(me.pos.x, me.pos.y + 50, me.pos.z), to = want.clone().sub(base); const L = to.length(); to.divideScalar(L);
    const hit = world.raycast(base, to, L + 12);
    D.orbit = hit ? base.clone().addScaledVector(to, Math.max(20, hit.distance - 14)) : want;
  }
  const b = smooth(0.6, 1.7, t);
  camera.position.copy(fallPos).lerp(D.orbit, b);
  // look target: own body → killer (freeze cam)
  const c = smooth(1.5, 2.6, t);
  const killerHead = k ? _dc3.set(k.pos.x, k.pos.y + k.eyeHeight * (k.alive ? 1 : 0.3), k.pos.z) : null;
  // first person look direction during the fall
  const fpYaw = D.startYaw, fpPitch = D.startPitch - a * 0.55;
  _dcQ.setFromEuler(new THREE.Euler(fpPitch, fpYaw, D.roll * a, 'YXZ'));
  const look = new THREE.Vector3(me.pos.x, me.pos.y + 22, me.pos.z);
  if (killerHead) look.lerp(killerHead, c);
  const m = new THREE.Matrix4().lookAt(camera.position, look, new THREE.Vector3(0, 1, 0));
  const q3 = new THREE.Quaternion().setFromRotationMatrix(m);
  camera.quaternion.copy(_dcQ).slerp(q3, smooth(0.45, 1.3, t));
  // freeze cam zoom on the killer
  if (killerHead && c > 0) {
    const d = camera.position.distanceTo(killerHead);
    const targetFov = Math.max(14, Math.min(CS_VFOV, 2 * Math.atan(48 / Math.max(60, d)) / D2R));
    D.fov = CS_VFOV + (targetFov - CS_VFOV) * c;
  } else D.fov = null;
  // marker over the killer's head
  if (killerHead && t > 1.6) {
    const p = killerHead.clone().add(new THREE.Vector3(0, 14, 0)).project(camera);
    if (p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1) {
      deathUI.mark.style.display = 'block';
      deathUI.mark.style.left = ((p.x + 1) / 2 * innerWidth) + 'px'; deathUI.mark.style.top = ((1 - p.y) / 2 * innerHeight) + 'px';
      const html = `<b>${esc(k.name)} · ${k.alive ? k.hp : 0} HP</b><i></i>`;
      if (deathUI.mark._h !== html) { deathUI.mark.innerHTML = html; deathUI.mark._h = html; }
    } else deathUI.mark.style.display = 'none';
  }
}

// ---------------------------------------------------------------- teammate name tags + target ID (CS2 style)
const tagUI = (() => {
  const css = document.createElement('style');
  css.textContent = `
  #nametags { position: fixed; inset: 0; pointer-events: none; z-index: 3; overflow: hidden; }
  #nametags .tag { position: absolute; left: 0; top: 0; transform-origin: 50% 100%; white-space: nowrap; display: flex; align-items: center; gap: 5px;
    font-family: "Saira Condensed", "Rajdhani", "Noto Sans SC", sans-serif; font-weight: 600; font-size: 15px; letter-spacing: .03em; color: #f2efe8;
    text-shadow: 0 1px 2px #000, 0 0 3px rgba(0,0,0,.8); will-change: transform, opacity; }
  #nametags .tag i { width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 0 1.5px rgba(0,0,0,.55); flex: none; }
  #nametags .tag b { font-weight: 600; }
  #nametags .tag .c4 { font-size: 11px; padding: 0 4px; border-radius: 2px; background: rgba(231,80,60,.85); color: #fff; text-shadow: none; }
  #targetid { position: fixed; left: 50%; top: calc(50% + 34px); transform: translateX(-50%); z-index: 3; pointer-events: none; display: none;
    font-family: "Saira Condensed", "Rajdhani", "Noto Sans SC", sans-serif; font-size: 17px; font-weight: 600; letter-spacing: .04em; text-shadow: 0 1px 2px #000; }`;
  document.head.appendChild(css);
  const root = document.createElement('div'); root.id = 'nametags'; document.body.appendChild(root);
  const tid = document.createElement('div'); tid.id = 'targetid'; document.body.appendChild(tid);
  return { root, tid, tags: new Map(), vis: new Map(), visT: 0, tidT: 0 };
})();
const _nt = new THREE.Vector3(), _nt2 = new THREE.Vector3(), _nt3 = new THREE.Vector3();
function updateNameTags(vt, dt) {
  const show = state.running && !state.death && vt && vt.alive && !hud.isAnyMenuOpen();
  const used = new Set();
  if (show) {
    // line of sight per teammate (refreshed ~8×/s): visible tags are solid, ones behind walls are dimmed (CS2 still shows them)
    tagUI.visT -= dt;
    const doVis = tagUI.visT <= 0; if (doVis) tagUI.visT = 0.12;
    for (const p of game.players) {
      if (p === vt || !p.alive || p.team !== vt.team) continue;
      const head = _nt.set(p.pos.x, p.pos.y + p.eyeHeight + 16, p.pos.z);
      const dist = head.distanceTo(camera.position);
      _nt2.copy(head).project(camera);
      if (_nt2.z > 1 || _nt2.z < -1 || Math.abs(_nt2.x) > 1.2 || Math.abs(_nt2.y) > 1.2) continue;
      if (doVis) {
        _nt3.subVectors(head, camera.position); const L = _nt3.length(); _nt3.divideScalar(L);
        tagUI.vis.set(p.id, !world.raycast(camera.position, _nt3, L - 20) && !(fx.smokeLineBlocked && fx.smokeLineBlocked(camera.position, head)));
      }
      let el = tagUI.tags.get(p.id);
      if (!el) { el = document.createElement('div'); el.className = 'tag'; tagUI.root.appendChild(el); tagUI.tags.set(p.id, el); }
      const col = PLAYER_COLORS[(p.slotIndex ?? 0) % 5];
      const html = `<i style="background:${col}"></i><b>${esc(p.name)}</b>${p.inv.c4 && vt.team === 't' ? '<span class="c4">C4</span>' : ''}`;
      if (el._h !== html) { el.innerHTML = html; el._h = html; }
      const x = (_nt2.x + 1) / 2 * innerWidth, y = (1 - _nt2.y) / 2 * innerHeight;
      const sc = Math.max(0.62, Math.min(1.05, 900 / Math.max(300, dist)));
      const visible = tagUI.vis.get(p.id) !== false;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) scale(${sc.toFixed(3)})`;
      el.style.opacity = visible ? '0.95' : '0.45';
      el.style.display = '';
      used.add(p.id);
    }
  }
  for (const [id, el] of tagUI.tags) if (!used.has(id)) el.style.display = 'none';
  // target ID: enemy (or teammate) under the crosshair
  tagUI.tidT -= dt;
  if (tagUI.tidT <= 0) {
    tagUI.tidT = 0.08;
    let target = null;
    if (show) {
      const o = camera.position, d = camera.getWorldDirection(_nt3).clone();
      const wall = world.raycast(o, d, 6000); const maxT = wall ? wall.distance : 6000;
      let best = maxT;
      for (const p of game.players) {
        if (p === vt || !p.alive || !p.char) continue;
        const hb = p.char.getHitboxes(p._tidHb || (p._tidHb = []));
        for (const b of hb) { const t = b.type === 'sphere' ? raySphere(o, d, b.a, b.r) : rayCapsule(o, d, b.a, b.b, b.r); if (t >= 0 && t < best) { best = t; target = p; } }
      }
      if (target && fx.smokeLineBlocked && fx.smokeLineBlocked(o, target.eyePos(_nt))) target = null;
    }
    if (target) {
      const enemy = target.team !== vt.team;
      tagUI.tid.style.color = enemy ? '#ff5a4e' : PLAYER_COLORS[(target.slotIndex ?? 0) % 5];
      const txt = enemy ? target.name : `${target.name}  ·  ${target.hp} HP`;
      if (tagUI.tid._t !== txt) { tagUI.tid.textContent = txt; tagUI.tid._t = txt; }
      tagUI.tid.style.display = 'block';
    } else tagUI.tid.style.display = 'none';
  }
}

function onResize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  if (vm) vm.setAspect(w / h);
  if (world) world.setSize(w, h, Math.min(window.devicePixelRatio || 1, 2));
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
}
window.addEventListener('resize', onResize);

// debug hooks for automated tests
window.__dbg = { get game() { return game; }, get world() { return world; }, get vm() { return vm; }, get hud() { return hud; }, camera, startMatch: (s, d) => startMatch(s, d), state };
boot();
