// CS2-faithful weapon data (values follow CS2 item definitions as closely as known).
// Units: damage in HP, range in units, cycle = seconds between shots, speed = max move speed (u/s).
// spread / inaccuracy values are in milliradians-ish "CS inaccuracy units" (engine converts: rad = v/1000).

export const SLOT = { PRIMARY: 0, SECONDARY: 1, KNIFE: 2, GRENADE: 3, C4: 4 };

const W = {};
function def(id, o) { W[id] = Object.assign({ id, headMult: 4, pellets: 1, penetration: 1, auto: false, silenced: false,
  scope: 0, kill: 300, ammoType: id, burst: false, pump: false, team: 'both' }, o); }

// ---------------- Pistols ----------------
def('glock',   { name: 'Glock-18', cat: 'pistol', slot: SLOT.SECONDARY, hold: 'pistol', team: 't', price: 200, dmg: 30, ap: 0.47, cycle: 0.15, mag: 20, reserve: 120, range: 4096, rangeMod: 0.85, speed: 240, reload: 2.27, draw: 1.0, kill: 300, burstMode: true,
  spread: 2, inStand: 5.6, inCrouch: 4.2, inMove: 13, inJump: 260, inFire: 56, recover: 0.36, recoil: 18 });
def('usp_s',   { name: 'USP-S', cat: 'pistol', slot: SLOT.SECONDARY, hold: 'pistol', team: 'ct', price: 200, dmg: 35, ap: 0.505, cycle: 0.17, mag: 12, reserve: 24, range: 4096, rangeMod: 0.91, speed: 240, reload: 2.17, draw: 1.0, silenced: true,
  spread: 1.5, inStand: 3.9, inCrouch: 3.0, inMove: 14, inJump: 260, inFire: 52, recover: 0.33, recoil: 23 });
def('p2000',   { name: 'P2000', cat: 'pistol', slot: SLOT.SECONDARY, hold: 'pistol', team: 'ct', price: 200, dmg: 35, ap: 0.505, cycle: 0.17, mag: 13, reserve: 52, range: 4096, rangeMod: 0.91, speed: 240, reload: 2.2, draw: 1.0,
  spread: 2, inStand: 4.5, inCrouch: 3.5, inMove: 14, inJump: 260, inFire: 50, recover: 0.33, recoil: 22 });
def('p250',    { name: 'P250', cat: 'pistol', slot: SLOT.SECONDARY, hold: 'pistol', price: 300, dmg: 38, ap: 0.64, cycle: 0.15, mag: 13, reserve: 26, range: 4096, rangeMod: 0.85, speed: 240, reload: 2.2, draw: 1.0,
  spread: 2, inStand: 6.8, inCrouch: 5.2, inMove: 14, inJump: 260, inFire: 64, recover: 0.35, recoil: 26 });
def('elite',   { name: 'Dual Berettas', cat: 'pistol', slot: SLOT.SECONDARY, hold: 'pistol', price: 300, dmg: 38, ap: 0.575, cycle: 0.12, mag: 30, reserve: 120, range: 4096, rangeMod: 0.79, speed: 240, reload: 3.77, draw: 1.0,
  spread: 2, inStand: 7.5, inCrouch: 6, inMove: 16, inJump: 260, inFire: 50, recover: 0.36, recoil: 20 });
def('fiveseven',{ name: 'Five-SeveN', cat: 'pistol', slot: SLOT.SECONDARY, hold: 'pistol', team: 'ct', price: 500, dmg: 32, ap: 0.9115, cycle: 0.15, mag: 20, reserve: 100, range: 4096, rangeMod: 0.81, speed: 240, reload: 2.2, draw: 1.0,
  spread: 2, inStand: 6.8, inCrouch: 5.2, inMove: 14, inJump: 260, inFire: 52, recover: 0.33, recoil: 20 });
def('tec9',    { name: 'Tec-9', cat: 'pistol', slot: SLOT.SECONDARY, hold: 'pistol', team: 't', price: 500, dmg: 33, ap: 0.906, cycle: 0.12, mag: 18, reserve: 90, range: 4096, rangeMod: 0.831, speed: 240, reload: 2.5, draw: 1.0,
  spread: 2, inStand: 7.5, inCrouch: 6, inMove: 9, inJump: 260, inFire: 60, recover: 0.38, recoil: 22 });
def('cz75a',   { name: 'CZ75-Auto', cat: 'pistol', slot: SLOT.SECONDARY, hold: 'pistol', price: 500, dmg: 31, ap: 0.7765, cycle: 0.1, mag: 12, reserve: 12, range: 4096, rangeMod: 0.85, speed: 240, reload: 2.7, draw: 1.85, auto: true,
  spread: 2, inStand: 7.5, inCrouch: 6, inMove: 16, inJump: 260, inFire: 32, recover: 0.4, recoil: 18 });
def('deagle',  { name: 'Desert Eagle', cat: 'pistol', slot: SLOT.SECONDARY, hold: 'pistol', price: 700, dmg: 53, ap: 0.932, cycle: 0.225, mag: 7, reserve: 35, range: 4096, rangeMod: 0.81, speed: 230, reload: 2.2, draw: 1.0, penetration: 2,
  spread: 2, inStand: 4.6, inCrouch: 3.5, inMove: 30, inJump: 340, inFire: 110, recover: 0.55, recoil: 52 });
def('revolver',{ name: 'R8 Revolver', cat: 'pistol', slot: SLOT.SECONDARY, hold: 'pistol', price: 600, dmg: 86, ap: 0.932, cycle: 0.5, prime: 0.4, mag: 8, reserve: 8, range: 4096, rangeMod: 0.94, speed: 220, reload: 2.3, draw: 1.0, penetration: 2,
  spread: 1, inStand: 3, inCrouch: 2.5, inMove: 30, inJump: 340, inFire: 160, recover: 0.6, recoil: 60 });

// ---------------- SMGs ----------------
const smg = { cat: 'smg', slot: SLOT.PRIMARY, hold: 'rifle', auto: true, kill: 600, draw: 1.0 };
def('mac10', { ...smg, name: 'MAC-10', team: 't', price: 1050, dmg: 29, ap: 0.575, cycle: 0.075, mag: 30, reserve: 100, range: 4096, rangeMod: 0.8, speed: 240, reload: 2.6, spread: 3, inStand: 13, inCrouch: 10, inMove: 22, inJump: 140, inFire: 9, recover: 0.36, recoil: 16 });
def('mp9',   { ...smg, name: 'MP9', team: 'ct', price: 1250, dmg: 26, ap: 0.6, cycle: 0.07, mag: 30, reserve: 120, range: 4096, rangeMod: 0.87, speed: 240, reload: 2.13, spread: 3, inStand: 12, inCrouch: 9, inMove: 20, inJump: 140, inFire: 9, recover: 0.33, recoil: 15 });
def('mp7',   { ...smg, name: 'MP7', price: 1500, dmg: 29, ap: 0.625, cycle: 0.08, mag: 30, reserve: 120, range: 4096, rangeMod: 0.85, speed: 220, reload: 3.13, spread: 3, inStand: 10, inCrouch: 7.5, inMove: 18, inJump: 140, inFire: 8, recover: 0.33, recoil: 15 });
def('mp5sd', { ...smg, name: 'MP5-SD', price: 1500, dmg: 27, ap: 0.625, cycle: 0.075, mag: 30, reserve: 120, range: 4096, rangeMod: 0.85, speed: 235, reload: 2.63, silenced: true, spread: 3, inStand: 10, inCrouch: 7.5, inMove: 16, inJump: 140, inFire: 7, recover: 0.33, recoil: 13 });
def('ump45', { ...smg, name: 'UMP-45', price: 1200, dmg: 35, ap: 0.65, cycle: 0.09, mag: 25, reserve: 100, range: 4096, rangeMod: 0.75, speed: 230, reload: 3.5, spread: 3, inStand: 12, inCrouch: 9, inMove: 20, inJump: 140, inFire: 10, recover: 0.36, recoil: 18 });
def('p90',   { ...smg, name: 'P90', price: 2350, dmg: 26, ap: 0.69, cycle: 0.07, mag: 50, reserve: 100, range: 4096, rangeMod: 0.86, speed: 230, reload: 3.37, kill: 300, spread: 3, inStand: 13, inCrouch: 10, inMove: 22, inJump: 140, inFire: 7, recover: 0.36, recoil: 13 });
def('bizon', { ...smg, name: 'PP-Bizon', price: 1400, dmg: 27, ap: 0.575, cycle: 0.08, mag: 64, reserve: 120, range: 4096, rangeMod: 0.8, speed: 240, reload: 2.43, spread: 3, inStand: 13, inCrouch: 10, inMove: 22, inJump: 140, inFire: 8, recover: 0.33, recoil: 13 });

// ---------------- Heavy ----------------
const sg = { cat: 'heavy', slot: SLOT.PRIMARY, hold: 'rifle', kill: 900, draw: 1.0, headMult: 4, shotgun: true };
def('nova',     { ...sg, name: 'Nova', price: 1050, dmg: 26, pellets: 9, ap: 0.5, cycle: 0.88, mag: 8, reserve: 32, range: 3000, rangeMod: 0.7, speed: 220, reload: 0.5, shellReload: true, reloadStart: 0.45, reloadEnd: 0.6, spread: 40, inStand: 8, inCrouch: 6, inMove: 15, inJump: 140, inFire: 60, recover: 0.35, recoil: 90 });
def('xm1014',   { ...sg, name: 'XM1014', price: 2000, dmg: 20, pellets: 6, ap: 0.8, cycle: 0.35, mag: 7, reserve: 32, range: 3000, rangeMod: 0.7, speed: 215, reload: 0.45, shellReload: true, reloadStart: 0.5, reloadEnd: 0.6, auto: true, spread: 38, inStand: 8, inCrouch: 6, inMove: 15, inJump: 140, inFire: 50, recover: 0.4, recoil: 60 });
def('sawedoff', { ...sg, name: 'Sawed-Off', team: 't', price: 1100, dmg: 32, pellets: 8, ap: 0.75, cycle: 0.85, mag: 7, reserve: 32, range: 1400, rangeMod: 0.45, speed: 210, reload: 0.5, shellReload: true, reloadStart: 0.45, reloadEnd: 0.6, spread: 70, inStand: 8, inCrouch: 6, inMove: 15, inJump: 140, inFire: 60, recover: 0.35, recoil: 90 });
def('mag7',     { ...sg, name: 'MAG-7', team: 'ct', price: 1300, dmg: 30, pellets: 8, ap: 0.75, cycle: 0.85, mag: 5, reserve: 32, range: 1400, rangeMod: 0.45, speed: 225, reload: 2.5, spread: 40, inStand: 8, inCrouch: 6, inMove: 15, inJump: 140, inFire: 60, recover: 0.35, recoil: 90 });
def('m249',     { cat: 'heavy', slot: SLOT.PRIMARY, hold: 'rifle', name: 'M249', price: 5200, dmg: 32, ap: 0.8, cycle: 0.08, mag: 100, reserve: 200, range: 8192, rangeMod: 0.97, speed: 195, reload: 5.7, auto: true, penetration: 2, kill: 300, draw: 1.0, spread: 2, inStand: 9, inCrouch: 6, inMove: 120, inJump: 300, inFire: 8, recover: 0.6, recoil: 22 });
def('negev',    { cat: 'heavy', slot: SLOT.PRIMARY, hold: 'rifle', name: 'Negev', price: 1700, dmg: 35, ap: 0.71, cycle: 0.075, mag: 150, reserve: 300, range: 8192, rangeMod: 0.97, speed: 150, reload: 5.7, auto: true, penetration: 2, kill: 300, draw: 1.0, spread: 2, inStand: 9, inCrouch: 6, inMove: 120, inJump: 300, inFire: 6, recover: 0.6, recoil: 18 });

// ---------------- Rifles ----------------
const rf = { cat: 'rifle', slot: SLOT.PRIMARY, hold: 'rifle', auto: true, kill: 300, penetration: 2, draw: 1.0 };
def('galilar', { ...rf, name: 'Galil AR', team: 't', price: 1800, dmg: 30, ap: 0.775, cycle: 0.09, mag: 35, reserve: 90, range: 8192, rangeMod: 0.98, speed: 215, reload: 3.0, spread: 0.6, inStand: 7, inCrouch: 5, inMove: 120, inJump: 300, inFire: 9.5, recover: 0.42, recoil: 26 });
def('famas',   { ...rf, name: 'FAMAS', team: 'ct', price: 2050, dmg: 30, ap: 0.7, cycle: 0.09, mag: 25, reserve: 90, range: 8192, rangeMod: 0.96, speed: 220, reload: 3.3, burstMode: true, spread: 0.6, inStand: 6, inCrouch: 4.5, inMove: 110, inJump: 300, inFire: 9, recover: 0.4, recoil: 22 });
def('ak47',    { ...rf, name: 'AK-47', team: 't', price: 2700, dmg: 36, ap: 0.775, cycle: 0.1, mag: 30, reserve: 90, range: 8192, rangeMod: 0.98, speed: 215, reload: 2.43, spread: 0.6, inStand: 4.8, inCrouch: 3.6, inMove: 140, inJump: 360, inFire: 7.8, recover: 0.38, recoil: 30 });
def('m4a4',    { ...rf, name: 'M4A4', team: 'ct', price: 3100, dmg: 33, ap: 0.7, cycle: 0.09, mag: 30, reserve: 90, range: 8192, rangeMod: 0.97, speed: 225, reload: 3.07, spread: 0.6, inStand: 4.5, inCrouch: 3.4, inMove: 120, inJump: 340, inFire: 7, recover: 0.35, recoil: 23 });
def('m4a1_s',  { ...rf, name: 'M4A1-S', team: 'ct', price: 2900, dmg: 38, ap: 0.7, cycle: 0.1, mag: 20, reserve: 80, range: 8192, rangeMod: 0.99, speed: 225, reload: 3.07, silenced: true, spread: 0.5, inStand: 3.9, inCrouch: 3.0, inMove: 120, inJump: 340, inFire: 6.5, recover: 0.35, recoil: 21 });
def('ssg08',   { ...rf, name: 'SSG 08', auto: false, price: 1700, dmg: 88, ap: 0.85, cycle: 1.25, mag: 10, reserve: 90, range: 8192, rangeMod: 0.98, speed: 230, scopedSpeed: 230, reload: 3.7, scope: 2, zoom: [40, 15], spread: 0.3, inStand: 23, inCrouch: 17, inMove: 70, inJump: 25, inFire: 35, recover: 0.2, recoil: 30, scopedInacc: 1.5, kill: 300 });
def('sg556',   { ...rf, name: 'SG 553', team: 't', price: 3000, dmg: 30, ap: 1.0, cycle: 0.09, mag: 30, reserve: 90, range: 8192, rangeMod: 0.98, speed: 210, scopedSpeed: 150, reload: 2.8, scope: 1, zoom: [45], spread: 0.6, inStand: 5.5, inCrouch: 4, inMove: 130, inJump: 360, inFire: 7.5, recover: 0.38, recoil: 26, scopedInacc: 2.5 });
def('aug',     { ...rf, name: 'AUG', team: 'ct', price: 3300, dmg: 28, ap: 0.9, cycle: 0.09, mag: 30, reserve: 90, range: 8192, rangeMod: 0.98, speed: 220, scopedSpeed: 150, reload: 3.8, scope: 1, zoom: [45], spread: 0.6, inStand: 5.5, inCrouch: 4, inMove: 130, inJump: 360, inFire: 7, recover: 0.38, recoil: 24, scopedInacc: 2.5 });
def('awp',     { ...rf, name: 'AWP', auto: false, price: 4750, dmg: 115, ap: 0.975, cycle: 1.455, mag: 5, reserve: 30, range: 8192, rangeMod: 0.99, speed: 200, scopedSpeed: 100, reload: 3.67, scope: 2, zoom: [40, 10], kill: 100, penetration: 2.5, spread: 0.2, inStand: 80, inCrouch: 60, inMove: 170, inJump: 400, inFire: 110, recover: 0.25, recoil: 80, scopedInacc: 1.0 });
def('g3sg1',   { ...rf, name: 'G3SG1', team: 't', price: 5000, dmg: 80, ap: 0.825, cycle: 0.25, mag: 20, reserve: 90, range: 8192, rangeMod: 0.98, speed: 215, scopedSpeed: 120, reload: 4.7, scope: 2, zoom: [40, 15], spread: 0.3, inStand: 22, inCrouch: 16, inMove: 150, inJump: 360, inFire: 30, recover: 0.3, recoil: 30, scopedInacc: 1.5 });
def('scar20',  { ...rf, name: 'SCAR-20', team: 'ct', price: 5000, dmg: 80, ap: 0.825, cycle: 0.25, mag: 20, reserve: 90, range: 8192, rangeMod: 0.98, speed: 215, scopedSpeed: 120, reload: 3.1, scope: 2, zoom: [40, 15], spread: 0.3, inStand: 22, inCrouch: 16, inMove: 150, inJump: 360, inFire: 30, recover: 0.3, recoil: 30, scopedInacc: 1.5 });

// ---------------- Melee / utility ----------------
def('knife_t',  { name: 'Knife', cat: 'knife', slot: SLOT.KNIFE, hold: 'knife', team: 't', price: 0, speed: 250, draw: 1.0, kill: 1500, light: 40, lightBack: 90, heavy: 65, heavyBack: 180, lightCycle: 0.4, heavyCycle: 1.0, range: 48 });
def('knife_ct', { name: 'Knife', cat: 'knife', slot: SLOT.KNIFE, hold: 'knife', team: 'ct', price: 0, speed: 250, draw: 1.0, kill: 1500, light: 40, lightBack: 90, heavy: 65, heavyBack: 180, lightCycle: 0.4, heavyCycle: 1.0, range: 48 });
def('taser',    { name: 'Zeus x27', cat: 'equipment', slot: SLOT.SECONDARY, hold: 'pistol', price: 200, dmg: 500, ap: 1, cycle: 0.2, mag: 1, reserve: 0, range: 183, rangeMod: 0.0001, speed: 220, reload: 0, draw: 1.0, kill: 0, spread: 2, inStand: 2, inCrouch: 2, inMove: 2, inJump: 2, inFire: 0, recover: 0.2, recoil: 0, taserSlot: true });
def('c4',       { name: 'C4 Explosive', cat: 'c4', slot: SLOT.C4, hold: 'c4', team: 't', price: 0, speed: 250, draw: 1.0 });

const gr = { cat: 'grenade', slot: SLOT.GRENADE, hold: 'grenade', speed: 245, draw: 0.6, kill: 300 };
def('hegrenade',    { ...gr, name: 'High Explosive Grenade', price: 300, max: 1, dmg: 98, radius: 350 });
def('flashbang',    { ...gr, name: 'Flashbang', price: 200, max: 2 });
def('smokegrenade', { ...gr, name: 'Smoke Grenade', price: 300, max: 1 });
def('molotov',      { ...gr, name: 'Molotov', team: 't', price: 400, max: 1 });
def('incgrenade',   { ...gr, name: 'Incendiary Grenade', team: 'ct', price: 500, max: 1 });
def('decoy',        { ...gr, name: 'Decoy Grenade', price: 50, max: 1 });

export const WEAPONS = W;
export const GRENADE_ORDER = ['hegrenade', 'flashbang', 'smokegrenade', 'decoy', 'molotov', 'incgrenade'];

export const EQUIPMENT = {
  vest:       { id: 'vest', name: 'Kevlar Vest', price: 650 },
  vesthelm:   { id: 'vesthelm', name: 'Kevlar + Helmet', price: 1000 },
  defuser:    { id: 'defuser', name: 'Defuse Kit', price: 400, team: 'ct' },
};

// CS2 default buy-menu loadouts. Each column = [itemId,...] in key order 1..5.
// Alternatives in ALT can replace a slot (CS2 loadout system).
export const BUY_MENU = {
  ct: {
    equipment: ['vest', 'vesthelm', 'taser', 'defuser'],
    pistols:   ['usp_s', 'elite', 'p250', 'fiveseven', 'deagle'],
    midtier:   ['mp9', 'mp7', 'ump45', 'p90', 'nova', 'xm1014', 'mag7', 'm249', 'negev', 'bizon'],
    rifles:    ['famas', 'm4a4', 'ssg08', 'aug', 'awp'],
    grenades:  ['incgrenade', 'decoy', 'flashbang', 'hegrenade', 'smokegrenade'],
  },
  t: {
    equipment: ['vest', 'vesthelm', 'taser'],
    pistols:   ['glock', 'elite', 'p250', 'tec9', 'deagle'],
    midtier:   ['mac10', 'mp7', 'ump45', 'p90', 'nova', 'xm1014', 'sawedoff', 'm249', 'negev', 'bizon'],
    rifles:    ['galilar', 'ak47', 'ssg08', 'sg556', 'awp'],
    grenades:  ['molotov', 'decoy', 'flashbang', 'hegrenade', 'smokegrenade'],
  },
};
export const LOADOUT_ALT = { usp_s: ['p2000'], fiveseven: ['cz75a'], tec9: ['cz75a'], deagle: ['revolver'], m4a4: ['m4a1_s'], mp7: ['mp5sd'], awp: [], ssg08: [], aug: ['scar20'], sg556: ['g3sg1'] };

// CS2 competitive rules
export const RULES = {
  startMoney: 800, maxMoney: 16000, freezeTime: 15, buyTime: 20, roundTime: 115, c4Timer: 40,
  plantTime: 3.2, defuseTime: 10, defuseTimeKit: 5, maxRounds: 24, winRounds: 13, halftimeAfter: 12,
  winElim: 3250, winBombT: 3500, winDefuse: 3500, winTime: 3250,
  lossBonus: [1400, 1900, 2400, 2900, 3400], plantLoserBonus: 800, plantReward: 300, defuseReward: 300,
  roundEndDelay: 7,
};

// hitgroup damage multipliers (CS2)
export const HITGROUP_MULT = { head: 4, chest: 1, arm: 1, stomach: 1.25, leg: 0.75 };
