// =====================================================================================
//  hud.js — CS2-style HUD / UI layer for the DUST II browser game.
//  Pure DOM + 2D canvas, no dependencies besides weapon_data.js and the generated
//  asset manifest. All game-facing calls are cheap: DOM is only touched when a value
//  actually changes. See the API summary at the bottom of this header.
//
//  Assets: assets/ui/weapons/<id>.svg (white silhouettes, muzzle right),
//          assets/ui/icons/<name>.svg, assets/ui/radar.png (+ radar.json),
//          assets/ui/fonts/*.woff2 (Saira Condensed, Rajdhani, Noto Sans SC subset).
//  Generators: /home/claude/tools/hud_radar.py, hud_icons.py, hud_fonts.py
// =====================================================================================
import { WEAPONS, BUY_MENU, LOADOUT_ALT, RULES, EQUIPMENT, GRENADE_ORDER } from './weapon_data.js';
import { WEAPON_ICON_SIZE, RADAR } from '../assets/ui/ui_manifest.js';

export { RADAR };

const BASE = new URL('../', import.meta.url).href;            // game root
const A = (p) => BASE + p;                                       // asset url
const WICON = (id) => A(`assets/ui/weapons/${WEAPON_ICON_SIZE[id] ? id : 'knife'}.svg`);
const ICON = (n) => A(`assets/ui/icons/${n}.svg`);

// CS2 radar / scoreboard player colours (index 0..4)
export const PLAYER_COLORS = ['#f2d43c', '#a05ee6', '#3fc06e', '#46a6f0', '#f08a2c'];
const TEAM_NAME = { ct: 'Counter-Terrorists', t: 'Terrorists' };
const CT_COL = '#8fc6f2', T_COL = '#e7c063';

// ----------------------------------------------------------------------------- utils
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
function fmtTime(s) {
  s = Math.max(0, s || 0);
  if (s < 10 && s > 0) { const t = Math.ceil(s * 10) / 10; return `0:0${Math.floor(t)}`; }
  s = Math.ceil(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function el(tag, cls, html, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}
// weapon silhouette element (CSS mask => colourable via background-color)
function wIconHTML(id, h, cls = '') {
  const sz = WEAPON_ICON_SIZE[id] || WEAPON_ICON_SIZE.knife;
  const w = (h * sz[0] / sz[1]).toFixed(1);
  return `<i class="wi ${cls}" style="--w:${w};--h:${h};--img:url('${WICON(id)}')"></i>`;
}
function iconHTML(name, cls = '') { return `<i class="ic ${cls}" style="--img:url('${ICON(name)}')"></i>`; }
const wname = (id) => (WEAPONS[id] && WEAPONS[id].name) || (EQUIPMENT[id] && EQUIPMENT[id].name) || id;

// ----------------------------------------------------------------------------- settings
const SETTINGS_KEY = 'dust2.hud.settings.v1';
export const DEFAULT_SETTINGS = {
  sensitivity: 1.0, invertY: false, zoomSensitivity: 1.0, rawInput: true,
  fovMode: 'default',                                    // 'default' (CS2 90° hor 4:3) | 'wide'
  crosshair: { style: 'classic', size: 3, gap: -1, thickness: 1, outline: true, outlineThickness: 1,
               dot: false, color: 'green', r: 50, g: 250, b: 50, alpha: 220, tStyle: false, followRecoil: false },
  volume: { master: 0.8, sfx: 1.0, music: 0.5 },
  graphics: 'high', showFps: false, viewmodel: 'desktop',
  radar: { rotate: true, scale: 0.7, centered: true },
  hudScale: 1.0, language: 'en',
  loadout: {},                                           // slot item id -> chosen alternative (buy-menu ⇄)
};
export const CROSSHAIR_COLORS = {
  red: [250, 50, 50], green: [50, 250, 50], yellow: [250, 250, 50], blue: [50, 50, 250], cyan: [50, 250, 250],
};
function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!over || typeof over !== 'object') return out;
  for (const k of Object.keys(over)) {
    if (base && typeof base[k] === 'object' && base[k] && !Array.isArray(base[k])) out[k] = deepMerge(base[k], over[k]);
    else if (over[k] !== undefined) out[k] = over[k];
  }
  return out;
}
function loadSettings() {
  try { const s = localStorage.getItem(SETTINGS_KEY); if (s) return deepMerge(DEFAULT_SETTINGS, JSON.parse(s)); } catch (e) { /* storage blocked */ }
  return deepMerge(DEFAULT_SETTINGS, {});
}
function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } }

// ----------------------------------------------------------------------------- callouts
// Approximate callout zones (world units) for calloutAt(): [name, x0, z0, x1, z1] — first match wins.
export const CALLOUTS = [
  ['Xbox', -90, -432, 95, -221],
  ['Mid Doors', -274, -696, 306, -432],
  ['B Doors', -1012, -1382, -591, -907],
  ['B Tunnels', -1751, -696, -1276, -432],
  ['Pit', 1598, 780, 1941, 1123],
  ['A Site', 886, -1672, 1598, -907],
  ['A Ramp', 1598, -1962, 2125, -907],
  ['Long A', 1598, -907, 2125, 780],
  ['Long Doors', 1308, 306, 1598, 991],
  ['Long Corner', 833, -116, 1598, 306],
  ['Outside Long', 411, 306, 1308, 1519],
  ['CT Spawn', 385, -1672, 886, -1382],
  ['Short A', 385, -1382, 886, -907],
  ['Catwalk', 306, -907, 886, -221],
  ['CT Mid', -1012, -1962, 385, -696],
  ['Mid', -274, -432, 306, 517],
  ['Top Mid', -512, 464, 622, 886],
  ['Suicide', -512, 886, -63, 1730],
  ['T Ramp', -63, 886, 622, 1730],
  ['T Spawn', -591, 1730, 1308, 2257],
  ['Lower Tunnels', -1012, -432, -221, -63],
  ['Upper Tunnels', -2014, -432, -960, 411],
  ['Outside Tunnels', -1962, 411, -591, 2362],
  ['B Site', -1856, -2067, -1012, -696],
  ['Back Plat', -2173, -2647, -1487, -2067],
  ['B Closet', -2331, -2647, -1856, -327],
];
export function calloutAt(x, z) {
  for (const c of CALLOUTS) if (x >= c[1] && x <= c[3] && z >= c[2] && z <= c[4]) return c[0];
  return '';
}

// ----------------------------------------------------------------------------- CSS
// Lengths written as `12_u` scale with the HUD (1_u = 1px at 1920x1080, min 0.75px).
const FONT_LAT = `'HUD Saira','Saira Condensed','Rajdhani','Barlow Condensed'`;
const FONT_CJK = `'HUD Noto SC','Noto Sans SC','PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif`;
const CSS_SRC = String.raw`
@font-face{font-family:'HUD Saira';src:url('${A('assets/ui/fonts/saira-condensed-latin-400-normal.woff2')}') format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:'HUD Saira';src:url('${A('assets/ui/fonts/saira-condensed-latin-500-normal.woff2')}') format('woff2');font-weight:500;font-display:swap}
@font-face{font-family:'HUD Saira';src:url('${A('assets/ui/fonts/saira-condensed-latin-600-normal.woff2')}') format('woff2');font-weight:600;font-display:swap}
@font-face{font-family:'HUD Saira';src:url('${A('assets/ui/fonts/saira-condensed-latin-700-normal.woff2')}') format('woff2');font-weight:700;font-display:swap}
@font-face{font-family:'HUD Saira';src:url('${A('assets/ui/fonts/saira-condensed-latin-800-normal.woff2')}') format('woff2');font-weight:800;font-display:swap}
@font-face{font-family:'HUD Rajdhani';src:url('${A('assets/ui/fonts/rajdhani-latin-600-normal.woff2')}') format('woff2');font-weight:600;font-display:swap}
@font-face{font-family:'HUD Rajdhani';src:url('${A('assets/ui/fonts/rajdhani-latin-700-normal.woff2')}') format('woff2');font-weight:700;font-display:swap}
@font-face{font-family:'HUD Noto SC';src:url('${A('assets/ui/fonts/noto-sans-sc-hud-400.woff2')}') format('woff2');font-weight:300 500;font-display:swap}
@font-face{font-family:'HUD Noto SC';src:url('${A('assets/ui/fonts/noto-sans-sc-hud-700.woff2')}') format('woff2');font-weight:600 900;font-display:swap}

.h2{position:absolute;inset:0;pointer-events:none;overflow:hidden;color:#fff;font-family:${FONT_LAT},${FONT_CJK};
  --u:1px;--ct:${CT_COL};--t:${T_COL};--red:#e8413a;--green:#7ed36b;--money:#9fe07e;--panel:rgba(12,14,18,.62);--line:rgba(255,255,255,.10);
  -webkit-font-smoothing:antialiased;user-select:none;-webkit-user-select:none;font-size:16_u;line-height:1.2;letter-spacing:.01em}
.h2 *{box-sizing:border-box}
.h2 .wi{display:inline-block;width:calc(var(--w)*1_u);height:calc(var(--h)*1_u);background:currentColor;
  -webkit-mask:var(--img) center/contain no-repeat;mask:var(--img) center/contain no-repeat;flex:none;vertical-align:middle}
.h2 .ic{display:inline-block;width:1em;height:1em;background:currentColor;-webkit-mask:var(--img) center/contain no-repeat;mask:var(--img) center/contain no-repeat;flex:none;vertical-align:middle}
.h2 .ts{text-shadow:0 1px 2px rgba(0,0,0,.65),0 0 8px rgba(0,0,0,.25)}
.h2 .hide{display:none!important}
.h2 .fade{transition:opacity .25s}
.h2 .num{font-variant-numeric:tabular-nums}
.h2 .zh{font-family:${FONT_CJK};letter-spacing:.04em}

/* ------------------------------------------------ crosshair / overlays */
.h2 .xhair{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);image-rendering:pixelated}
.h2 .dmgc{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:520_u;height:520_u}
.h2 .flash{position:absolute;inset:0;opacity:0;background:#fff;will-change:opacity}
.h2 .flashimg{position:absolute;inset:0;width:100%;height:100%;opacity:0;will-change:opacity}
.h2 .hitvig{position:absolute;inset:0;opacity:0;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 55%,rgba(170,0,0,.38) 100%);transition:opacity .5s}
.h2 .scope{position:absolute;inset:0;display:none}
.h2 .scope.on{display:block}
.h2 .scope .sc-mask{position:absolute;inset:0;background:radial-gradient(circle at 50% 50%,rgba(0,0,0,0) 0,rgba(0,0,0,0) calc(var(--r) - 3px),rgba(0,0,0,.9) calc(var(--r) + 1px),#000 calc(var(--r) + 4px))}
.h2 .scope .sc-lens{position:absolute;inset:0;background:radial-gradient(circle at 50% 50%,rgba(0,0,0,0) calc(var(--r)*.55),rgba(16,12,8,.22) calc(var(--r)*.86),rgba(0,0,0,.62) calc(var(--r) - 2px)),
   radial-gradient(circle at 38% 34%,rgba(255,255,255,.05),rgba(255,255,255,0) 22%)}
.h2 .scope .sc-dust{position:absolute;inset:0;opacity:.35;mix-blend-mode:screen}
.h2 .scope .sc-h,.h2 .scope .sc-v{position:absolute;background:#000}
.h2 .scope .sc-h{left:0;right:0;top:50%;height:1px;transform:translateY(-.5px)}
.h2 .scope .sc-v{top:0;bottom:0;left:50%;width:1px;transform:translateX(-.5px)}
.h2 .scope.l1 .sc-h,.h2 .scope.l1 .sc-v{display:none}
.h2 .scope .sc-ret{position:absolute;left:50%;top:50%;width:calc(var(--r)*.16);height:calc(var(--r)*.16);transform:translate(-50%,-50%);border:1.5px solid rgba(20,20,20,.85);border-radius:50%;display:none}
.h2 .scope .sc-dot{position:absolute;left:50%;top:50%;width:4px;height:4px;transform:translate(-50%,-50%);border-radius:50%;background:#ff3a2a;box-shadow:0 0 4px rgba(255,60,40,.9);display:none}
.h2 .scope.l1 .sc-ret,.h2 .scope.l1 .sc-dot{display:block}

/* ------------------------------------------------ radar */
.h2 .radar{position:absolute;left:16_u;top:16_u;width:272_u;height:272_u}
.h2 .radar canvas{width:100%;height:100%;display:block}
.h2 .loc{position:absolute;left:16_u;top:294_u;width:272_u;text-align:center;font-size:17_u;font-weight:600;color:rgba(235,240,245,.86);letter-spacing:.04em;text-transform:none}
.h2 .money{position:absolute;left:24_u;top:326_u;display:flex;align-items:center;gap:8_u;font-size:30_u;font-weight:700;color:#fff;transition:color .4s}
.h2 .money .ic{font-size:24_u;color:#dfe8d6}
.h2 .money.gain{color:var(--money)}
.h2 .money.spend{color:#ffb3a8}
.h2 .money .cart{color:var(--money);opacity:0;transition:opacity .2s}
.h2 .money .cart.on{opacity:1}
.h2 .money .carry{display:flex;gap:6_u;font-size:24_u;margin-left:4_u}
.h2 .money .carry .c4{color:#f2a33a}
.h2 .money .carry .kit{color:var(--ct)}
.h2 .mpop{position:absolute;left:30_u;top:364_u;font-size:22_u;font-weight:700;pointer-events:none}
.h2 .mpop span{position:absolute;left:0;top:0;white-space:nowrap;animation:h2mpop 1.8s ease-out forwards}
.h2 .mpop span.p{color:var(--money)} .h2 .mpop span.n{color:#ff7d70}
@keyframes h2mpop{0%{opacity:0;transform:translateY(8_u)}12%{opacity:1;transform:translateY(0)}75%{opacity:1}100%{opacity:0;transform:translateY(-14_u)}}

/* ------------------------------------------------ top bar */
.h2 .top{position:absolute;left:50%;top:10_u;transform:translateX(-50%);display:flex;align-items:flex-start;gap:6_u}
.h2 .avs{display:flex;gap:4_u}
.h2 .avs.ct{flex-direction:row-reverse}
.h2 .av{position:relative;width:40_u;height:46_u;border-radius:3_u;overflow:hidden;background:linear-gradient(180deg,rgba(40,48,58,.9),rgba(18,22,28,.9));
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);transition:opacity .3s,filter .3s}
.h2 .av .face{position:absolute;inset:3_u 3_u 9_u 3_u;border-radius:2_u;display:flex;align-items:flex-end;justify-content:center;overflow:hidden}
.h2 .av.ct .face{background:linear-gradient(180deg,#4f7aa6 0%,#2a4566 100%)}
.h2 .av.t .face{background:linear-gradient(180deg,#a8844a 0%,#5e4523 100%)}
.h2 .av .face .ic{font-size:30_u;color:rgba(0,0,0,.35);margin-bottom:-3_u}
.h2 .av .nm{position:absolute;left:0;right:0;top:4_u;text-align:center;font-size:12_u;font-weight:700;color:rgba(255,255,255,.92);text-shadow:0 1px 2px #000}
.h2 .av .hp{position:absolute;left:3_u;right:3_u;bottom:3_u;height:4_u;background:rgba(0,0,0,.6);border-radius:1px;overflow:hidden}
.h2 .av .hp i{display:block;height:100%;background:#e9eef2;transition:width .25s}
.h2 .av .hp.low i{background:var(--red)}
.h2 .av .tag{position:absolute;right:3_u;bottom:9_u;font-size:11_u;line-height:0;filter:drop-shadow(0 0 1px #000)}
.h2 .av .tag.c4{color:#f2a33a} .h2 .av .tag.kit{color:#cfe8ff}
.h2 .av.dead{filter:grayscale(1) brightness(.45)}
.h2 .av.dead .face .ic{opacity:.2}
.h2 .av .x{position:absolute;inset:0;display:none;align-items:center;justify-content:center;font-size:22_u;color:rgba(255,255,255,.45)}
.h2 .av.dead .x{display:flex}
.h2 .av.me{box-shadow:inset 0 0 0 1px rgba(255,255,255,.55)}
.h2 .sc{display:flex;flex-direction:column;align-items:center}
.h2 .sc .box{min-width:52_u;height:46_u;display:flex;align-items:center;justify-content:center;font-size:34_u;font-weight:700;padding:0 8_u;border-radius:3_u}
.h2 .sc.ct .box{background:linear-gradient(180deg,rgba(60,105,150,.92),rgba(34,62,94,.92));color:#eaf5ff}
.h2 .sc.t .box{background:linear-gradient(180deg,rgba(158,124,56,.92),rgba(96,72,28,.92));color:#fff6e0}
.h2 .sc .alive{margin-top:3_u;font-size:12_u;font-weight:600;letter-spacing:.06em;color:rgba(255,255,255,.7)}
.h2 .tmr{width:96_u;height:46_u;display:flex;align-items:center;justify-content:center;background:rgba(10,12,16,.72);border-radius:3_u;font-size:30_u;font-weight:600;position:relative}
.h2 .tmr.low{color:#ff5a4c}
.h2 .tmr.freeze{color:#cfd8e0}
.h2 .tmr .bomb{display:none;font-size:32_u;color:#ff5040;filter:drop-shadow(0 0 6px rgba(255,60,40,.7));animation:h2pulse 1s infinite}
.h2 .tmr.planted{background:linear-gradient(180deg,rgba(90,14,10,.85),rgba(40,8,6,.85))}
.h2 .tmr.planted .bomb{display:block}
.h2 .tmr.planted .t{display:none}
.h2 .tmr.warm{color:#cfd8e0}
.h2 .rnd.w{color:#ffd27a;font-size:13_u;letter-spacing:.2em}
.h2 .rnd{position:absolute;left:0;right:0;top:50_u;text-align:center;font-size:12_u;color:rgba(255,255,255,.62);letter-spacing:.08em;font-weight:600;white-space:nowrap}
@keyframes h2pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.92)}}

/* ------------------------------------------------ kill feed */
.h2 .kf{position:absolute;right:14_u;top:14_u;display:flex;flex-direction:column;align-items:flex-end;gap:4_u}
.h2 .kf .e{display:flex;align-items:center;gap:7_u;height:32_u;padding:0 11_u;background:rgba(10,12,16,.62);border-radius:3_u;font-size:18_u;font-weight:600;
  white-space:nowrap;transition:opacity .45s,transform .3s;animation:h2kfin .25s ease-out;box-shadow:inset 0 0 0 1px rgba(255,255,255,.04)}
.h2 .kf .e.me{box-shadow:inset 0 0 0 2px #e0302c}
.h2 .kf .e.died{background:rgba(110,16,14,.72)}
.h2 .kf .e.out{opacity:0}
.h2 .kf .ct{color:var(--ct)} .h2 .kf .t{color:var(--t)}
.h2 .kf .plus{color:rgba(255,255,255,.75)}
.h2 .kf .wi{color:#f4f6f8}
.h2 .kf .ic{font-size:20_u;color:#f4f6f8}
.h2 .kf .ic.hs{font-size:21_u}
@keyframes h2kfin{from{opacity:0;transform:translateX(16_u)}to{opacity:1;transform:none}}
.h2 .fps{position:absolute;right:14_u;bottom:6_u;font-size:13_u;font-weight:600;color:rgba(200,255,190,.85);font-family:'HUD Rajdhani',monospace}

/* ------------------------------------------------ bottom left: hp/armor + radio */
.h2 .vitals{position:absolute;left:0;bottom:0;height:78_u;width:560_u;display:flex;align-items:center;gap:30_u;padding:0 0 0 26_u;
  background:linear-gradient(90deg,rgba(0,0,0,.62) 0%,rgba(0,0,0,.42) 55%,rgba(0,0,0,0) 100%)}
.h2 .vit{display:flex;align-items:center;gap:10_u;position:relative}
.h2 .vit .ic{font-size:28_u;color:#eef2f5}
.h2 .vit .v{font-size:42_u;font-weight:700;min-width:64_u}
.h2 .vit .bar{position:absolute;left:38_u;right:0;bottom:-5_u;height:4_u;background:rgba(255,255,255,.12);border-radius:1px;overflow:hidden}
.h2 .vit .bar i{display:block;height:100%;background:rgba(238,242,245,.9);transition:width .2s}
.h2 .vit.hp.low .v,.h2 .vit.hp.low .ic{color:#ff4b3a}
.h2 .vit.hp.low .bar i{background:#ff4b3a}
.h2 .vit.hp.hit .v{animation:h2hit .35s}
@keyframes h2hit{0%{color:#ff5a4c;transform:scale(1.08)}100%{transform:none}}
.h2 .vit.ar .v{color:#e2e7ec}
.h2 .vit.ar.none{opacity:.4}
.h2 .chat{position:absolute;left:22_u;bottom:96_u;display:flex;flex-direction:column;gap:2_u;width:620_u}
.h2 .chat .l{font-size:17_u;font-weight:600;text-shadow:0 1px 2px #000,0 0 6px rgba(0,0,0,.6);transition:opacity .6s;animation:h2kfin .2s ease-out}
.h2 .chat .l .who.ct{color:var(--ct)} .h2 .chat .l .who.t{color:var(--t)}
.h2 .chat .l .rad{color:rgba(255,255,255,.7)}
.h2 .chat .l.out{opacity:0}

/* ------------------------------------------------ bottom right: ammo + inventory */
.h2 .ammo{position:absolute;right:0;bottom:0;height:78_u;min-width:330_u;display:flex;align-items:center;justify-content:flex-end;gap:10_u;padding:0 30_u 0 60_u;
  background:linear-gradient(270deg,rgba(0,0,0,.62) 0%,rgba(0,0,0,.42) 55%,rgba(0,0,0,0) 100%)}
.h2 .ammo .bul{font-size:30_u;color:#e9edf0;margin-right:-4_u;opacity:.9}
.h2 .ammo .clip{font-size:44_u;font-weight:700;min-width:50_u;text-align:right}
.h2 .ammo .sl{font-size:26_u;opacity:.55;font-weight:500}
.h2 .ammo .res{font-size:26_u;font-weight:600;opacity:.82;min-width:42_u}
.h2 .ammo.low .clip{color:#ff4b3a}
.h2 .ammo.empty .clip{color:#ff4b3a;animation:h2pulse .9s infinite}
.h2 .ammo .mode{position:absolute;right:30_u;top:-8_u;font-size:13_u;font-weight:700;letter-spacing:.12em;color:rgba(255,255,255,.7);background:rgba(0,0,0,.45);padding:1_u 6_u;border-radius:2_u}
.h2 .ammo.melee .clip,.h2 .ammo.melee .sl,.h2 .ammo.melee .res,.h2 .ammo.melee .bul{display:none}
.h2 .inv{position:absolute;right:26_u;bottom:96_u;display:flex;flex-direction:column;align-items:flex-end;gap:6_u}
.h2 .inv .row{display:flex;align-items:center;justify-content:flex-end;gap:10_u;height:36_u;color:rgba(255,255,255,.5);transition:color .15s}
.h2 .inv .row.act{color:#fff}
.h2 .inv .row .nm{font-size:16_u;font-weight:600;letter-spacing:.03em;opacity:0;transform:translateX(6_u);transition:opacity .2s,transform .2s;text-shadow:0 1px 2px #000}
.h2 .inv .row.act .nm{opacity:1;transform:none}
.h2 .inv .row .k{font-size:13_u;font-weight:700;min-width:12_u;text-align:center;opacity:.85;text-shadow:0 0 3px #000}
.h2 .inv .row .ics{display:flex;gap:9_u;align-items:center;filter:drop-shadow(0 0 1.5px rgba(0,0,0,.75)) drop-shadow(0 1px 3px rgba(0,0,0,.35))}
.h2 .inv .row .ics .wi.on{color:#fff}
.h2 .inv .row .ics .wi.off{color:rgba(255,255,255,.42)}
.h2 .inv .row.c4 .wi{color:#f2a33a}
.h2 .inv .row.c4:not(.act) .wi{color:rgba(242,163,58,.6)}

/* ------------------------------------------------ center messages / progress / banners */
.h2 .cmsg{position:absolute;left:50%;top:27%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6_u}
.h2 .cmsg .m{padding:7_u 18_u;background:rgba(10,12,16,.62);border-radius:3_u;font-size:21_u;font-weight:600;letter-spacing:.02em;white-space:nowrap;
  transition:opacity .35s,transform .35s;animation:h2pop .22s ease-out}
.h2 .cmsg .m.out{opacity:0;transform:translateY(-6_u)}
.h2 .cmsg .m.warn{color:#ffd8a0}
@keyframes h2pop{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}
.h2 .notice{position:absolute;left:50%;top:76_u;transform:translateX(-50%);padding:6_u 22_u;font-size:17_u;font-weight:700;letter-spacing:.14em;
  background:linear-gradient(90deg,rgba(0,0,0,0),rgba(0,0,0,.6) 18%,rgba(0,0,0,.6) 82%,rgba(0,0,0,0));white-space:nowrap;opacity:0;transition:opacity .4s}
.h2 .notice.on{opacity:1}
.h2 .prog{position:absolute;left:50%;top:calc(50% + 70_u);transform:translateX(-50%);width:300_u;display:none;flex-direction:column;align-items:center;gap:6_u}
.h2 .prog.on{display:flex}
.h2 .prog .lb{font-size:17_u;font-weight:600;letter-spacing:.06em;text-shadow:0 1px 2px #000}
.h2 .prog .tr{width:100%;height:8_u;background:rgba(0,0,0,.55);border-radius:1px;box-shadow:0 0 0 1px rgba(255,255,255,.15);overflow:hidden}
.h2 .prog .tr i{display:block;height:100%;width:0;background:linear-gradient(90deg,#dfe7ee,#fff)}
.h2 .prog .tm{font-size:14_u;opacity:.8}
.h2 .ann{position:absolute;left:50%;top:132_u;transform:translateX(-50%);width:880_u;display:flex;flex-direction:column;align-items:center;opacity:0;
  transition:opacity .35s,transform .35s;pointer-events:none}
.h2 .ann.on{opacity:1}
.h2 .ann .band{position:relative;width:100%;height:96_u;display:flex;align-items:center;justify-content:center;gap:18_u;overflow:hidden}
.h2 .ann .band:before{content:'';position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,0) 0%,var(--bc) 22%,var(--bc) 78%,rgba(0,0,0,0) 100%);opacity:.92}
.h2 .ann .band:after{content:'';position:absolute;left:12%;right:12%;top:0;height:2px;background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.55),rgba(255,255,255,0))}
.h2 .ann.ct{--bc:rgba(44,86,132,.92);--tc:#e6f3ff}
.h2 .ann.t{--bc:rgba(138,102,36,.92);--tc:#fff3d6}
.h2 .ann.neutral{--bc:rgba(30,34,40,.92);--tc:#fff}
.h2 .ann .band .ic{position:relative;font-size:52_u;color:var(--tc);opacity:.95}
.h2 .ann .ttl{position:relative;font-size:46_u;font-weight:800;letter-spacing:.06em;color:var(--tc);text-shadow:0 2px 6px rgba(0,0,0,.4)}
.h2 .ann .sub{position:relative;margin-top:2_u;font-size:18_u;font-weight:600;letter-spacing:.08em;color:rgba(255,255,255,.88);min-height:4_u}
.h2 .ann .mvp{margin-top:6_u;display:none;align-items:center;gap:10_u;padding:6_u 18_u;background:rgba(10,12,16,.7);border-radius:3_u;font-size:19_u;font-weight:600}
.h2 .ann .mvp.on{display:flex}
.h2 .ann .mvp .ic{color:#ffd34a;font-size:22_u}
.h2 .ann .mvp b{font-weight:700}
.h2 .ann .mvp .r{color:rgba(255,255,255,.7);font-weight:500}
.h2 .spec{position:absolute;left:50%;bottom:92_u;transform:translateX(-50%);display:none;align-items:stretch;min-width:520_u;background:rgba(10,12,16,.72);border-radius:3_u;overflow:hidden}
.h2 .spec.on{display:flex}
.h2 .spec .bar{width:6_u;background:var(--tc)}
.h2 .spec.ct{--tc:var(--ct)} .h2 .spec.t{--tc:var(--t)}
.h2 .spec .in{flex:1;padding:8_u 16_u;display:flex;align-items:center;gap:22_u}
.h2 .spec .lab{font-size:12_u;letter-spacing:.16em;color:rgba(255,255,255,.6);font-weight:700}
.h2 .spec .nm{font-size:24_u;font-weight:700;color:var(--tc)}
.h2 .spec .st{display:flex;align-items:center;gap:6_u;font-size:20_u;font-weight:700}
.h2 .spec .st .ic{font-size:18_u}
.h2 .spec .wp{margin-left:auto;display:flex;align-items:center;gap:10_u;font-size:16_u;color:rgba(255,255,255,.8)}
.h2 .spec .keys{font-size:12_u;color:rgba(255,255,255,.5);letter-spacing:.06em;padding:0 14_u;display:flex;align-items:center;border-left:1px solid var(--line)}
.h2 .warm{position:absolute;left:50%;top:76_u;transform:translateX(-50%);font-size:16_u;letter-spacing:.2em;font-weight:700;color:rgba(255,255,255,.75)}
`;
const CSS_SRC2 = String.raw`
/* ------------------------------------------------ shared panel widgets */
.h2 .ui{pointer-events:auto}
.h2 .btn{display:inline-flex;align-items:center;justify-content:center;gap:8_u;height:44_u;padding:0 22_u;border:0;border-radius:3_u;cursor:pointer;
  font:inherit;font-size:18_u;font-weight:700;letter-spacing:.08em;color:#e9eef2;background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);
  transition:background .15s,box-shadow .15s,color .15s,transform .1s}
.h2 .btn:hover{background:rgba(255,255,255,.16);box-shadow:inset 0 0 0 1px rgba(255,255,255,.3)}
.h2 .btn:active{transform:translateY(1px)}
.h2 .btn.pri{background:linear-gradient(180deg,#e3a43a,#c47f1d);color:#1b1205;box-shadow:inset 0 0 0 1px rgba(255,220,150,.5),0 6_u 18_u rgba(196,127,29,.25)}
.h2 .btn.pri:hover{background:linear-gradient(180deg,#f0b54c,#d18b25)}
.h2 .btn .zh{font-weight:500;opacity:.8;font-size:.86em;letter-spacing:.06em}
.h2 .seg{display:inline-flex;background:rgba(0,0,0,.35);border-radius:3_u;padding:3_u;gap:3_u;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
.h2 .seg button{white-space:nowrap;height:34_u;padding:0 14_u;border:0;border-radius:2_u;background:transparent;color:rgba(255,255,255,.7);font:inherit;font-size:15_u;font-weight:600;cursor:pointer;letter-spacing:.04em;transition:background .15s,color .15s}
.h2 .seg button:hover{color:#fff;background:rgba(255,255,255,.06)}
.h2 .seg button.on{background:rgba(255,255,255,.9);color:#111}
.h2 .seg button .zh{font-size:.9em;opacity:.75;margin-left:4_u}
.h2 input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:24_u;background:transparent;cursor:pointer;margin:0}
.h2 input[type=range]::-webkit-slider-runnable-track{height:4_u;background:linear-gradient(90deg,#e3a43a var(--p,50%),rgba(255,255,255,.16) var(--p,50%));border-radius:2_u}
.h2 input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16_u;height:16_u;border-radius:50%;background:#fff;margin-top:-6_u;box-shadow:0 1px 4px rgba(0,0,0,.5)}
.h2 input[type=range]::-moz-range-track{height:4_u;background:rgba(255,255,255,.16);border-radius:2_u}
.h2 input[type=range]::-moz-range-progress{height:4_u;background:#e3a43a}
.h2 input[type=range]::-moz-range-thumb{width:16_u;height:16_u;border-radius:50%;background:#fff;border:0}
.h2 .tog{position:relative;width:46_u;height:24_u;border-radius:12_u;background:rgba(255,255,255,.16);cursor:pointer;transition:background .2s;flex:none}
.h2 .tog:after{content:'';position:absolute;left:3_u;top:3_u;width:18_u;height:18_u;border-radius:50%;background:#fff;transition:transform .2s}
.h2 .tog.on{background:#e3a43a}
.h2 .tog.on:after{transform:translateX(22_u)}
.h2 .kbd{display:inline-flex;align-items:center;justify-content:center;min-width:28_u;height:26_u;padding:0 7_u;border-radius:3_u;background:linear-gradient(180deg,#3a4049,#272c33);
  box-shadow:inset 0 -2px 0 rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.12);font-size:13_u;font-weight:700;letter-spacing:.04em;color:#f1f4f6;white-space:nowrap;font-family:${FONT_LAT},sans-serif}
.h2 .scroll{overflow:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) transparent}
.h2 .scroll::-webkit-scrollbar{width:6px}.h2 .scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.22);border-radius:3px}

/* ------------------------------------------------ buy menu */
.h2 .buy{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 40%,rgba(14,17,22,.9),rgba(6,7,9,.95));
  opacity:0;visibility:hidden;transition:opacity .16s,visibility 0s .16s}
.h2 .buy.on{opacity:1;visibility:visible;transition:opacity .16s}
.h2 .buy .wrap{display:flex;flex-direction:column;gap:14_u;transform:translateY(8_u);transition:transform .2s}
.h2 .buy.on .wrap{transform:none}
.h2 .buy .hd{display:flex;align-items:flex-end;gap:26_u;padding:0 2_u 10_u;border-bottom:1px solid var(--line)}
.h2 .buy .hd .ttl{font-size:34_u;font-weight:800;letter-spacing:.08em;line-height:1}
.h2 .buy .hd .team{font-size:14_u;font-weight:700;letter-spacing:.14em;padding:4_u 10_u;border-radius:2_u}
.h2 .buy .hd .team.ct{color:#cfe8ff;background:rgba(70,120,170,.35)} .h2 .buy .hd .team.t{color:#ffeac0;background:rgba(160,120,50,.35)}
.h2 .buy .hd .bt{font-size:16_u;letter-spacing:.06em;color:rgba(255,255,255,.75);font-weight:600}
.h2 .buy .hd .bt b{color:#fff;font-weight:700}
.h2 .buy .hd .bt.no{color:#ff8a7c}
.h2 .buy .hd .mon{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;line-height:1}
.h2 .buy .hd .mon small{font-size:12_u;letter-spacing:.18em;color:rgba(255,255,255,.55);font-weight:700;margin-bottom:4_u}
.h2 .buy .hd .mon span{font-size:40_u;font-weight:700;color:var(--money);transition:color .3s}
.h2 .buy .hd .mon span.bump{animation:h2bump .35s}
@keyframes h2bump{0%{transform:scale(1.08)}100%{transform:none}}
.h2 .buy .bd{display:flex;gap:14_u;align-items:stretch}
.h2 .buy .col{width:178_u;display:flex;flex-direction:column;gap:8_u;padding:8_u;border-radius:4_u;background:rgba(255,255,255,.025);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05);transition:background .15s,box-shadow .15s}
.h2 .buy .col.sel{background:rgba(255,255,255,.06);box-shadow:inset 0 0 0 1px rgba(227,164,58,.55)}
.h2 .buy .col .ch{display:flex;align-items:center;gap:8_u;height:30_u;padding:0 2_u 4_u;font-size:15_u;font-weight:700;letter-spacing:.12em;color:rgba(255,255,255,.82);cursor:pointer}
.h2 .buy .col.sel .ch{color:#ffc86a}
.h2 .buy .col .ch .kbd{min-width:22_u;height:22_u;font-size:12_u}
.h2 .buy .col.sel .ch .kbd{background:linear-gradient(180deg,#e3a43a,#b9771b);color:#1b1205}
.h2 .buy .col .pg{margin-left:auto;font-size:12_u;letter-spacing:.06em;color:rgba(255,255,255,.5)}
.h2 .buy .card{position:relative;height:96_u;border-radius:3_u;background:linear-gradient(180deg,rgba(255,255,255,.075),rgba(255,255,255,.035));box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);
  cursor:pointer;overflow:hidden;transition:background .12s,box-shadow .12s,transform .08s}
.h2 .buy .card:hover,.h2 .buy .card.hov{background:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,.07));box-shadow:inset 0 0 0 1px rgba(255,255,255,.35)}
.h2 .buy .card:active{transform:scale(.985)}
.h2 .buy .card .k{position:absolute;left:6_u;top:6_u;font-size:12_u;font-weight:700;color:rgba(255,255,255,.55);min-width:16_u;height:16_u;display:flex;align-items:center;justify-content:center;border-radius:2_u;background:rgba(0,0,0,.35)}
.h2 .buy .col.sel .card .k{color:#1b1205;background:#e3a43a}
.h2 .buy .card .im{position:absolute;left:10_u;right:10_u;top:12_u;height:46_u;display:flex;align-items:center;justify-content:center;color:#e8ecef}
.h2 .buy .card .im .wi{max-width:100%;filter:drop-shadow(0 2px 2px rgba(0,0,0,.5))}
.h2 .buy .card .nm{position:absolute;left:8_u;bottom:6_u;font-size:14_u;font-weight:600;letter-spacing:.02em;color:rgba(255,255,255,.9);max-width:62%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h2 .buy .card .pr{position:absolute;right:8_u;bottom:6_u;font-size:15_u;font-weight:700;color:#d7f0c8}
.h2 .buy .card.poor .pr{color:#ff6b5d}
.h2 .buy .card.poor .im{opacity:.45}
.h2 .buy .card.own{box-shadow:inset 0 0 0 1px rgba(126,211,107,.55)}
.h2 .buy .card.own .pr{color:rgba(255,255,255,.5)}
.h2 .buy .card .ok{position:absolute;right:6_u;top:6_u;font-size:12_u;font-weight:700;color:#0d1a08;background:var(--green);border-radius:2_u;padding:1_u 5_u;display:none}
.h2 .buy .card.own .ok{display:block}
.h2 .buy .card .cnt{position:absolute;right:6_u;top:6_u;font-size:12_u;font-weight:700;color:rgba(255,255,255,.8);background:rgba(0,0,0,.45);border-radius:2_u;padding:1_u 5_u}
.h2 .buy .card .alt{position:absolute;right:6_u;top:26_u;width:22_u;height:20_u;display:flex;align-items:center;justify-content:center;border-radius:2_u;font-size:13_u;
  color:rgba(255,255,255,.75);background:rgba(0,0,0,.4);box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
.h2 .buy .card .alt:hover{color:#1b1205;background:#e3a43a}
.h2 .buy .card.nob{cursor:default}
.h2 .buy .card.flash-ok{animation:h2ok .45s}
.h2 .buy .card.flash-no{animation:h2no .35s}
@keyframes h2ok{0%{background:rgba(126,211,107,.55)}100%{}}
@keyframes h2no{0%,100%{transform:none}20%{transform:translateX(-4_u)}40%{transform:translateX(4_u)}60%{transform:translateX(-3_u)}80%{transform:translateX(2_u)}}
.h2 .buy .card.empty{background:rgba(255,255,255,.015);box-shadow:inset 0 0 0 1px rgba(255,255,255,.04);cursor:default}
.h2 .buy .more{height:28_u;border:0;border-radius:3_u;background:rgba(255,255,255,.06);color:rgba(255,255,255,.75);font:inherit;font-size:13_u;font-weight:700;letter-spacing:.1em;cursor:pointer}
.h2 .buy .more:hover{background:rgba(255,255,255,.14);color:#fff}
.h2 .buy .det{width:356_u;border-radius:4_u;background:rgba(0,0,0,.35);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);padding:18_u 20_u;display:flex;flex-direction:column;gap:10_u}
.h2 .buy .det .dim{height:110_u;display:flex;align-items:center;justify-content:center;color:#f2f5f7;border-bottom:1px solid var(--line);margin-bottom:4_u}
.h2 .buy .det .dn{font-size:26_u;font-weight:700;letter-spacing:.03em;line-height:1}
.h2 .buy .det .dc{font-size:13_u;letter-spacing:.14em;color:rgba(255,255,255,.55);font-weight:700;text-transform:uppercase}
.h2 .buy .det .dp{display:flex;gap:18_u;font-size:15_u;color:rgba(255,255,255,.75)}
.h2 .buy .det .dp b{color:#fff;font-weight:700}
.h2 .buy .det .st{display:grid;grid-template-columns:118_u 1fr 52_u;align-items:center;gap:8_u 10_u;font-size:14_u;color:rgba(255,255,255,.72);margin-top:4_u}
.h2 .buy .det .st .b{height:6_u;background:rgba(255,255,255,.1);border-radius:1px;overflow:hidden}
.h2 .buy .det .st .b i{display:block;height:100%;background:linear-gradient(90deg,#c9d3db,#fff);transition:width .25s}
.h2 .buy .det .st .v{text-align:right;color:#fff;font-weight:700}
.h2 .buy .det .desc{font-size:14_u;color:rgba(255,255,255,.72);line-height:1.45}
.h2 .buy .ft{display:flex;align-items:center;gap:22_u;padding-top:10_u;border-top:1px solid var(--line);font-size:14_u;color:rgba(255,255,255,.6);letter-spacing:.03em}
.h2 .buy .ft span{display:flex;align-items:center;gap:7_u}
.h2 .buy .ft .msg{margin-left:auto;color:#ff8a7c;font-weight:700;opacity:0;transition:opacity .2s}
.h2 .buy .ft .msg.on{opacity:1}
.h2 .buy .ft .msg.good{color:var(--green)}
.h2 .buy.locked .bd{opacity:.55}

/* ------------------------------------------------ scoreboard */
.h2 .sb{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.985);width:1120_u;opacity:0;visibility:hidden;transition:opacity .12s,transform .12s,visibility 0s .12s;
  background:rgba(11,13,17,.96);border-radius:4_u;box-shadow:0 20_u 60_u rgba(0,0,0,.5),inset 0 0 0 1px rgba(255,255,255,.07);overflow:hidden}
.h2 .sb.on{opacity:1;visibility:visible;transform:translate(-50%,-50%);transition:opacity .12s,transform .12s}
.h2 .sb .hd{display:flex;align-items:center;gap:16_u;padding:14_u 22_u;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,0));border-bottom:1px solid var(--line)}
.h2 .sb .hd .map{font-size:26_u;font-weight:800;letter-spacing:.08em}
.h2 .sb .hd .mode{font-size:14_u;letter-spacing:.16em;color:rgba(255,255,255,.55);font-weight:700}
.h2 .sb .hd .score{margin-left:auto;display:flex;align-items:center;gap:14_u;font-size:34_u;font-weight:800}
.h2 .sb .hd .score .ct{color:var(--ct)} .h2 .sb .hd .score .t{color:var(--t)}
.h2 .sb .hd .score .c{font-size:18_u;color:rgba(255,255,255,.4)}
.h2 .sb .hd .rd{font-size:14_u;color:rgba(255,255,255,.6);letter-spacing:.1em;font-weight:600;margin-left:18_u}
.h2 .sb table{width:100%;border-collapse:collapse;font-size:16_u;table-layout:fixed}
.h2 .sb th{height:28_u;font-size:12_u;font-weight:700;letter-spacing:.14em;color:rgba(255,255,255,.5);text-align:center;padding:0 6_u}
.h2 .sb th.n{text-align:left;padding-left:16_u}
.h2 .sb td{height:34_u;text-align:center;font-weight:600;padding:0 6_u;border-top:1px solid rgba(255,255,255,.04)}
.h2 .sb td.n{text-align:left;padding-left:10_u;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h2 .sb .tm{position:relative}
.h2 .sb .tm .lab{display:flex;align-items:center;gap:10_u;padding:10_u 16_u 4_u;font-size:15_u;font-weight:800;letter-spacing:.14em}
.h2 .sb .tm.ct .lab{color:var(--ct)} .h2 .sb .tm.t .lab{color:var(--t)}
.h2 .sb .tm .lab .ic{font-size:20_u}
.h2 .sb .tm .lab .s{margin-left:auto;font-size:13_u;letter-spacing:.1em;color:rgba(255,255,255,.5);font-weight:600}
.h2 .sb .tm.ct tbody td{background:rgba(80,130,180,.07)}
.h2 .sb .tm.t tbody td{background:rgba(180,140,60,.07)}
.h2 .sb .tm.ct tbody td.n{background:linear-gradient(90deg,rgba(80,130,180,.28),rgba(80,130,180,.07))}
.h2 .sb .tm.t tbody td.n{background:linear-gradient(90deg,rgba(180,140,60,.28),rgba(180,140,60,.07))}
.h2 .sb tr.dead td{color:rgba(255,255,255,.35)}
.h2 .sb tr.dead td.n .pn{text-decoration:none}
.h2 .sb .tm tbody tr.me td{background-color:rgba(255,255,255,.1)}
.h2 .sb .tm tbody tr.me td.n{background:linear-gradient(90deg,rgba(255,255,255,.22),rgba(255,255,255,.1))}
.h2 .sb tr.me td.n .pn{color:#fff}
.h2 .sb .pc{display:inline-block;width:10_u;height:10_u;border-radius:50%;margin-right:10_u;vertical-align:middle;box-shadow:0 0 0 1px rgba(0,0,0,.5)}
.h2 .sb .pn{vertical-align:middle}
.h2 .sb .bot{font-size:11_u;font-weight:700;letter-spacing:.1em;color:rgba(255,255,255,.4);margin-left:8_u;vertical-align:middle}
.h2 .sb .eq{margin-left:8_u;font-size:15_u;vertical-align:middle}
.h2 .sb .eq.c4{color:#f2a33a} .h2 .sb .eq.kit{color:#cfe8ff}
.h2 .sb td.mny{color:var(--money)}
.h2 .sb td.mvp{color:#ffd34a;white-space:nowrap}
.h2 .sb td.mvp .ic{font-size:13_u;margin-right:2_u}
.h2 .sb .hist{display:flex;align-items:center;gap:3_u;padding:12_u 16_u 14_u;border-top:1px solid var(--line);background:rgba(0,0,0,.2)}
.h2 .sb .hist .lb{font-size:12_u;font-weight:700;letter-spacing:.14em;color:rgba(255,255,255,.45);margin-right:10_u;white-space:nowrap}
.h2 .sb .hist .r{width:30_u;height:44_u;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3_u;border-radius:2_u;background:rgba(255,255,255,.04);font-size:10_u;color:rgba(255,255,255,.4)}
.h2 .sb .hist .r .ic{font-size:16_u}
.h2 .sb .hist .r.ct{background:rgba(80,130,180,.22);color:var(--ct)}
.h2 .sb .hist .r.t{background:rgba(180,140,60,.22);color:var(--t)}
.h2 .sb .hist .half{width:2px;height:40_u;background:rgba(255,255,255,.25);margin:0 5_u}

/* ------------------------------------------------ full screen menus */
.h2 .menu{position:absolute;inset:0;pointer-events:auto;display:none;color:#eef1f4;overflow:hidden;
  background:radial-gradient(ellipse at 78% 110%,rgba(214,140,52,.30),rgba(0,0,0,0) 55%),radial-gradient(ellipse at 10% -10%,rgba(70,110,160,.22),rgba(0,0,0,0) 50%),linear-gradient(180deg,#0d1015,#07080a)}
.h2 .menu.on{display:block;animation:h2fade .3s}
@keyframes h2fade{from{opacity:0}to{opacity:1}}
.h2 .menu .deco{position:absolute;right:-6%;top:50%;width:min(92vh,980px);height:min(92vh,980px);transform:translateY(-50%) rotate(-8deg);opacity:.22;
  background:var(--radar) center/contain no-repeat;-webkit-mask:radial-gradient(circle,#000 45%,transparent 72%);mask:radial-gradient(circle,#000 45%,transparent 72%)}
.h2 .menu .grain{position:absolute;inset:0;opacity:.05;background-image:repeating-linear-gradient(0deg,rgba(255,255,255,.6) 0 1px,transparent 1px 3px)}
.h2 .menu .side{position:absolute;left:7%;top:0;bottom:0;width:440_u;display:flex;flex-direction:column;justify-content:center;gap:6_u}
.h2 .menu .brand{margin-bottom:44_u}
.h2 .menu .brand .t1{font-size:96_u;font-weight:800;letter-spacing:.06em;line-height:.9;background:linear-gradient(180deg,#fff 30%,#f1c27a);-webkit-background-clip:text;background-clip:text;color:transparent}
.h2 .menu .brand .t2{margin-top:12_u;display:flex;align-items:center;gap:12_u;font-size:24_u;font-weight:700;letter-spacing:.14em;color:#f0b354}
.h2 .menu .brand .t2 .zh{font-size:24_u;color:#fff;letter-spacing:.2em}
.h2 .menu .brand .t3{margin-top:8_u;font-size:14_u;letter-spacing:.2em;color:rgba(255,255,255,.45);font-weight:600}
.h2 .menu .nav{display:flex;flex-direction:column;gap:4_u}
.h2 .menu .nav button{position:relative;display:flex;align-items:baseline;gap:14_u;height:58_u;padding:0 18_u;border:0;background:transparent;color:rgba(255,255,255,.62);cursor:pointer;font:inherit;text-align:left;
  border-radius:3_u;transition:color .15s,background .15s,padding .15s}
.h2 .menu .nav button .en{font-size:30_u;font-weight:800;letter-spacing:.08em}
.h2 .menu .nav button .zh{font-size:18_u;font-weight:500;opacity:.8}
.h2 .menu .nav button:before{content:'';position:absolute;left:0;top:14_u;bottom:14_u;width:3_u;background:#e3a43a;transform:scaleY(0);transition:transform .15s}
.h2 .menu .nav button:hover{color:#fff;background:linear-gradient(90deg,rgba(255,255,255,.07),rgba(255,255,255,0));padding-left:24_u}
.h2 .menu .nav button.on{color:#fff}
.h2 .menu .nav button.on:before{transform:none}
.h2 .menu .foot{position:absolute;left:7%;bottom:28_u;font-size:13_u;letter-spacing:.06em;color:rgba(255,255,255,.4);display:flex;gap:18_u;align-items:center}
.h2 .menu .pane{position:absolute;left:calc(7% + 480_u);right:6%;top:50%;transform:translateY(-50%);max-width:900_u;max-height:86%;display:none;flex-direction:column;
  background:rgba(12,14,18,.9);border-radius:4_u;box-shadow:0 24_u 80_u rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.08);}
.h2 .menu .pane.on{display:flex;animation:h2slide .22s ease-out}
@keyframes h2slide{from{opacity:0;transform:translateY(calc(-50% + 10_u))}to{opacity:1;transform:translateY(-50%)}}
.h2 .menu .pane .ph{display:flex;align-items:baseline;gap:14_u;padding:20_u 28_u 14_u;border-bottom:1px solid var(--line)}
.h2 .menu .pane .ph .en{font-size:28_u;font-weight:800;letter-spacing:.08em}
.h2 .menu .pane .ph .zh{font-size:18_u;color:rgba(255,255,255,.6)}
.h2 .menu .pane .pb{padding:22_u 28_u;overflow:auto}
.h2 .menu .pane .pf{display:flex;justify-content:flex-end;gap:12_u;padding:14_u 28_u 20_u;border-top:1px solid var(--line)}
.h2 .menu .lbl{display:flex;align-items:baseline;gap:10_u;font-size:14_u;font-weight:700;letter-spacing:.16em;color:rgba(255,255,255,.55);margin:4_u 0 10_u}
.h2 .menu .lbl .zh{letter-spacing:.1em;font-weight:500}
.h2 .menu .sides{display:grid;grid-template-columns:repeat(3,1fr);gap:12_u;margin-bottom:24_u}
.h2 .menu .side-c{position:relative;height:150_u;border-radius:4_u;cursor:pointer;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6_u;
  background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);transition:background .15s,box-shadow .15s,transform .12s}
.h2 .menu .side-c:hover{background:rgba(255,255,255,.08);transform:translateY(-2_u)}
.h2 .menu .side-c .ic{font-size:50_u;color:rgba(255,255,255,.85)}
.h2 .menu .side-c .en{font-size:18_u;font-weight:800;letter-spacing:.08em}
.h2 .menu .side-c .zh{font-size:14_u;color:rgba(255,255,255,.6)}
.h2 .menu .side-c.ct .ic{color:var(--ct)} .h2 .menu .side-c.t .ic{color:var(--t)}
.h2 .menu .side-c.on.ct{background:linear-gradient(180deg,rgba(70,120,170,.45),rgba(40,70,110,.25));box-shadow:inset 0 0 0 2px var(--ct)}
.h2 .menu .side-c.on.t{background:linear-gradient(180deg,rgba(170,130,50,.45),rgba(110,80,30,.25));box-shadow:inset 0 0 0 2px var(--t)}
.h2 .menu .side-c.on.auto{background:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,.05));box-shadow:inset 0 0 0 2px #ddd}
.h2 .menu .row2{display:flex;gap:28_u;flex-wrap:wrap;margin-bottom:22_u}
.h2 .menu .start{height:62_u;padding:0 46_u;font-size:24_u}
.h2 .menu .hint{display:flex;align-items:center;gap:10_u;font-size:14_u;color:rgba(255,255,255,.55);margin-right:auto}
.h2 .menu .hint .ic{font-size:18_u}
.h2 .keys{display:grid;grid-template-columns:1fr 1fr;gap:4_u 34_u}
.h2 .keys .kr{display:flex;align-items:center;gap:12_u;min-height:36_u;border-bottom:1px solid rgba(255,255,255,.05);font-size:16_u}
.h2 .keys .kr .kk{display:flex;gap:4_u;min-width:96_u;flex-wrap:wrap}
.h2 .keys .kr .ds{display:flex;flex-direction:column;line-height:1.15}
.h2 .keys .kr .ds .zh{font-size:15_u;color:#fff}
.h2 .keys .kr .ds .en{font-size:13_u;color:rgba(255,255,255,.5);letter-spacing:.04em}
.h2 .keys .sec{grid-column:1/-1;margin:14_u 0 4_u;font-size:13_u;font-weight:800;letter-spacing:.18em;color:#f0b354;display:flex;gap:10_u;align-items:baseline}
.h2 .keys .sec:first-child{margin-top:0}

/* settings */
.h2 .set{display:flex;gap:22_u;min-height:430_u}
.h2 .set .tabs{display:flex;flex-direction:column;gap:3_u;width:168_u;flex:none}
.h2 .set .tabs button{height:46_u;border:0;border-radius:3_u;background:transparent;color:rgba(255,255,255,.6);cursor:pointer;font:inherit;text-align:left;padding:0 14_u;display:flex;flex-direction:column;justify-content:center;line-height:1.1}
.h2 .set .tabs button .en{font-size:16_u;font-weight:700;letter-spacing:.08em}
.h2 .set .tabs button .zh{font-size:12_u;opacity:.75}
.h2 .set .tabs button:hover{background:rgba(255,255,255,.05);color:#fff}
.h2 .set .tabs button.on{background:rgba(255,255,255,.1);color:#fff;box-shadow:inset 3_u 0 0 #e3a43a}
.h2 .set .body{flex:1;display:flex;flex-direction:column;gap:2_u;min-width:0}
.h2 .set .it{display:grid;grid-template-columns:230_u 1fr 64_u;align-items:center;gap:16_u;min-height:46_u;border-bottom:1px solid rgba(255,255,255,.05)}
.h2 .set .it .nm{display:flex;flex-direction:column;line-height:1.15}
.h2 .set .it .nm .en{font-size:16_u;font-weight:600}
.h2 .set .it .nm .zh{font-size:13_u;color:rgba(255,255,255,.55)}
.h2 .set .it .val{font-size:15_u;font-weight:700;text-align:right;color:#fff;font-variant-numeric:tabular-nums}
.h2 .set .it .ctl{display:flex;align-items:center;gap:8_u;min-width:0}
.h2 .set .xprev{position:relative;height:150_u;border-radius:4_u;overflow:hidden;margin-bottom:10_u;flex:none;
  background:linear-gradient(180deg,#9fb6c9 0%,#d9c7a5 48%,#b48e5c 52%,#8a6a42 100%)}
.h2 .set .xprev .wall{position:absolute;left:8%;top:22%;width:38%;height:56%;background:linear-gradient(180deg,#dcc59c,#c2a477);box-shadow:inset -10px 0 20px rgba(0,0,0,.15)}
.h2 .set .xprev .wall2{position:absolute;right:10%;top:30%;width:22%;height:48%;background:linear-gradient(180deg,#a87d4e,#7c5a35)}
.h2 .set .xprev canvas{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)}
.h2 .set .xprev .bgsw{position:absolute;right:8_u;bottom:8_u;display:flex;gap:4_u}
.h2 .set .xprev .bgsw i{width:18_u;height:18_u;border-radius:2_u;cursor:pointer;box-shadow:0 0 0 1px rgba(0,0,0,.4)}
.h2 .set .sw{display:flex;gap:6_u}
.h2 .set .sw i{width:26_u;height:26_u;border-radius:3_u;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(0,0,0,.4);transition:transform .1s}
.h2 .set .sw i.on{box-shadow:0 0 0 2px #fff,inset 0 0 0 1px rgba(0,0,0,.4);transform:scale(1.06)}
.h2 .set .sw i.cu{background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red)}

/* pause */
.h2 .pause{position:absolute;inset:0;pointer-events:auto;display:none;background:linear-gradient(90deg,rgba(6,8,10,.9),rgba(6,8,10,.72));}
.h2 .pause.on{display:block;animation:h2fade .18s}
.h2 .pause .box{position:absolute;left:7%;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:6_u;width:420_u}
.h2 .pause .box .t{font-size:52_u;font-weight:800;letter-spacing:.1em;margin-bottom:20_u;display:flex;align-items:baseline;gap:16_u}
.h2 .pause .box .t .zh{font-size:24_u;font-weight:500;color:rgba(255,255,255,.6)}
.h2 .pause .nav button{position:relative;display:flex;align-items:baseline;gap:14_u;height:54_u;padding:0 18_u;border:0;background:transparent;color:rgba(255,255,255,.7);cursor:pointer;font:inherit;text-align:left;border-radius:3_u;transition:color .15s,background .15s,padding .15s;width:100%}
.h2 .pause .nav button .en{font-size:26_u;font-weight:800;letter-spacing:.08em}
.h2 .pause .nav button .zh{font-size:16_u;opacity:.8}
.h2 .pause .nav button:hover{color:#fff;background:linear-gradient(90deg,rgba(255,255,255,.08),rgba(255,255,255,0));padding-left:24_u}
.h2 .pause .pane{left:calc(7% + 460_u)}

/* halftime / match end */
.h2 .big{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;background:radial-gradient(ellipse at center,rgba(10,12,16,.55),rgba(0,0,0,.85));pointer-events:none}
.h2 .big.on{display:flex;animation:h2fade .4s}
.h2 .big .bk{font-size:16_u;letter-spacing:.3em;font-weight:700;color:rgba(255,255,255,.6)}
.h2 .big .bh{font-size:84_u;font-weight:800;letter-spacing:.08em;line-height:1;margin:8_u 0 4_u}
.h2 .big .bh .zh{font-size:34_u;font-weight:500;letter-spacing:.2em;margin-left:16_u;color:rgba(255,255,255,.7)}
.h2 .big .bs{display:flex;align-items:center;gap:28_u;margin:18_u 0;font-size:72_u;font-weight:800}
.h2 .big .bs .ct{color:var(--ct)} .h2 .big .bs .t{color:var(--t)}
.h2 .big .bs .ic{font-size:56_u}
.h2 .big .bs .c{font-size:30_u;color:rgba(255,255,255,.35)}
.h2 .big .bn{font-size:18_u;letter-spacing:.14em;color:rgba(255,255,255,.75);font-weight:600}
.h2 .big.end{pointer-events:auto;background:radial-gradient(ellipse at center,rgba(10,12,16,.82),rgba(0,0,0,.94))}
.h2 .big.end .bh{font-size:64_u}
.h2 .big.end .bs{font-size:52_u;margin:10_u 0 6_u;gap:20_u}
.h2 .big.end .bs .ic{font-size:40_u}
.h2 .big.end.win .bh{color:#9fe07e}
.h2 .big.end.lose .bh{color:#ff6b5d}
.h2 .big .tbl{margin-top:16_u;width:1000_u;max-height:58vh;border-radius:4_u}
.h2 .big .tbl .sb{position:static;transform:none;opacity:1;visibility:visible;width:100%}
.h2 .big .acts{display:flex;gap:12_u;margin-top:22_u}
`;

// ----------------------------------------------------------------------------- CSS injection
function preprocessCSS(s) { return s.replace(/(-?\d*\.?\d+)_u\b/g, 'calc($1*var(--u))'); }
function injectCSS() {
  if (document.getElementById('h2-hud-css')) return;
  const st = document.createElement('style');
  st.id = 'h2-hud-css';
  st.textContent = preprocessCSS(CSS_SRC + CSS_SRC2);
  document.head.appendChild(st);
  // The fonts are bundled locally (assets/ui/fonts). Google Fonts (same families) is only pulled in as a
  // fallback when the local files can't be loaded, or when HUD.googleFonts = true — this keeps the game
  // working offline / where fonts.googleapis.com is unreachable, without console errors.
  const google = () => {
    if (document.getElementById('h2-gfonts')) return;
    const gf = document.createElement('link'); gf.rel = 'stylesheet'; gf.id = 'h2-gfonts';
    gf.href = 'https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@400;500;600;700;800&family=Rajdhani:wght@600;700&family=Noto+Sans+SC:wght@400;500;700&display=swap';
    document.head.appendChild(gf);
  };
  if (HUD.googleFonts) google();
  else if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load("700 16px 'HUD Saira'"), document.fonts.load("400 16px 'HUD Noto SC'", '设置')])
      .then((r) => { if (!r[0].length || !r[1].length) google(); }, google);
  }
}

// ----------------------------------------------------------------------------- crosshair renderer
export function drawCrosshair(cv, cfg, spread = 0, scale = 1, dpr = window.devicePixelRatio || 1) {
  const s = scale * dpr;
  const dyn = cfg.style === 'classic' || cfg.style === 'default';
  const len = Math.max(1, Math.round(cfg.size * 2 * s));
  const thick = Math.max(1, Math.round(cfg.thickness * 2 * s));
  let gap = Math.round((cfg.gap + 4) * s);
  if (cfg.style === 'default') gap += Math.round(2 * s);
  if (dyn) gap += Math.round(spread * dpr);
  gap = Math.max(0, gap);
  const ol = cfg.outline ? Math.max(1, Math.round((cfg.outlineThickness || 1) * dpr)) : 0;
  const ext = gap + len + ol + 2;
  const size = (ext * 2 + thick + 2) | 0;
  if (cv.width !== size || cv.height !== size) {
    cv.width = size; cv.height = size;
    cv.style.width = size / dpr + 'px'; cv.style.height = size / dpr + 'px';
  }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const c0 = Math.floor((size - thick) / 2);             // top-left of centre square
  const col = cfg.color === 'custom' ? [cfg.r, cfg.g, cfg.b] : (CROSSHAIR_COLORS[cfg.color] || CROSSHAIR_COLORS.green);
  const a = clamp(cfg.alpha / 255, 0, 1);
  const rects = [];
  rects.push([c0 + thick + gap, c0, len, thick]);                     // right
  rects.push([c0 - gap - len, c0, len, thick]);                       // left
  rects.push([c0, c0 + thick + gap, thick, len]);                     // bottom
  if (!cfg.tStyle) rects.push([c0, c0 - gap - len, thick, len]);     // top
  if (cfg.dot) rects.push([c0, c0, thick, thick]);
  if (ol) {
    ctx.fillStyle = `rgba(0,0,0,${a * 0.85})`;
    for (const r of rects) ctx.fillRect(r[0] - ol, r[1] - ol, r[2] + ol * 2, r[3] + ol * 2);
  }
  ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${a})`;
  for (const r of rects) ctx.fillRect(r[0], r[1], r[2], r[3]);
}

function tintImage(img, color, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0, w, h);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color; x.fillRect(0, 0, w, h);
  return c;
}

// ----------------------------------------------------------------------------- static text tables
const KEYBINDS = [
  ['移动', 'MOVEMENT'],
  [['W'], '前进', 'Move forward'], [['S'], '后退', 'Move back'], [['A'], '左移', 'Strafe left'], [['D'], '右移', 'Strafe right'],
  [['Space'], '跳跃', 'Jump'], [['Ctrl'], '蹲下', 'Crouch'], [['Shift'], '静步 (慢走)', 'Walk (silent)'],
  ['战斗', 'COMBAT'],
  [['Mouse1'], '开火', 'Fire'], [['Mouse2'], '次要攻击 · 开镜 · 装/卸消音器', 'Alt-fire · Scope · Silencer'],
  [['R'], '换弹', 'Reload'], [['E'], '使用 / 拆除炸弹', 'Use / Defuse bomb'], [['G'], '丢弃武器', 'Drop weapon'], [['F'], '检视武器', 'Inspect weapon'],
  ['武器', 'WEAPONS'],
  [['1'], '主武器', 'Primary weapon'], [['2'], '副武器 (手枪)', 'Secondary (pistol)'], [['3'], '刀', 'Knife'],
  [['4'], '投掷物 (重复按切换)', 'Grenades (press again to cycle)'], [['5'], 'C4 炸弹', 'C4 explosive'],
  [['Q'], '上一把武器', 'Last used weapon'], [['Wheel'], '滚轮切换武器', 'Mouse wheel: switch weapon'],
  ['界面', 'INTERFACE'],
  [['B'], '购买菜单', 'Buy menu'], [['Tab'], '计分板 (按住)', 'Scoreboard (hold)'], [['Z', 'X', 'C'], '无线电指令', 'Radio commands'],
  [['Y'], '全体聊天', 'Chat (all)'], [['U'], '队伍聊天', 'Chat (team)'], [['Esc'], '暂停菜单 / 释放鼠标', 'Pause menu / release mouse'], [['`'], '控制台', 'Console'],
  ['购买菜单', 'BUY MENU'],
  [['1–5'], '先选择分类,再选择物品', 'Pick a column, then an item'], [['RMB'], '右键退还本回合购买的物品', 'Right-click: sell back (this round)'],
  [['6'], '中级武器:下一页', 'Mid-tier: next page'], [['⇄'], '切换装备方案 (如 M4A4 / M4A1-S)', 'Swap loadout variant (e.g. M4A4 / M4A1-S)'],
];
const HELP = [
  ['目标', 'OBJECTIVE', '恐怖分子 (T) 需要在 A 点或 B 点安放 C4 并保护其爆炸 (40 秒);反恐精英 (CT) 需要阻止安放或拆除炸弹。消灭全部敌人同样获胜。',
    'Terrorists plant the C4 at bombsite A or B and defend it for 40 s. Counter-Terrorists prevent the plant or defuse the bomb. Eliminating the enemy team also wins the round.'],
  ['赛制', 'FORMAT', '竞技模式 MR12:共 24 回合,先赢 13 回合者获胜;第 12 回合后交换阵营。每回合 1:55,冻结时间 15 秒,购买时间 20 秒。',
    'Competitive MR12: first to 13 of 24 rounds. Teams swap sides after round 12. Rounds last 1:55 with a 15 s freeze time and 20 s buy time.'],
  ['经济', 'ECONOMY', '起始资金 $800,上限 $16,000。获胜 $3,250 (爆炸/拆除 $3,500);连败补偿 $1,400 → $3,400。不同武器击杀奖励不同 (冲锋枪 $600,霰弹枪 $900,AWP $100)。',
    'Start with $800 (max $16,000). Round win $3,250 ($3,500 by bomb/defuse); loss bonus rises $1,400 → $3,400. Kill rewards vary by weapon (SMG $600, shotgun $900, AWP $100).'],
  ['拆弹', 'DEFUSING', '按住 E 拆除炸弹:无拆弹器 10 秒,有拆弹器 5 秒。CT 可在购买菜单装备栏购买拆弹器 ($400)。',
    'Hold E to defuse: 10 s without a kit, 5 s with one. CTs can buy a Defuse Kit ($400) in the Equipment column.'],
];
const DIFFS = [['easy', 'Easy', '简单'], ['normal', 'Normal', '普通'], ['hard', 'Hard', '困难'], ['expert', 'Expert', '专家']];
const CAT_LABEL = { pistol: 'Pistol', smg: 'SMG', heavy: 'Heavy', rifle: 'Rifle', grenade: 'Grenade', equipment: 'Equipment', knife: 'Knife', c4: 'Explosive' };
const EQ_DESC = {
  vest: 'Body armour that reduces damage from bullets and explosions. Head is unprotected.',
  vesthelm: 'Body armour plus a helmet. Protects against most headshot damage multipliers.',
  defuser: 'Halves the time it takes to defuse the C4 (10 s → 5 s).',
  taser: 'Single-shot short-range electric weapon. One hit kills at close range.',
  hegrenade: 'Fragmentation grenade. Deals heavy damage in a radius; damage is reduced by armour.',
  flashbang: 'Blinds and deafens everyone looking towards it when it detonates. Carry up to two.',
  smokegrenade: 'Deploys a thick smoke screen for about 18 seconds. Extinguishes fire.',
  molotov: 'Bursts into flames on impact, blocking an area and damaging anyone inside.',
  incgrenade: 'CT incendiary. Bursts into flames on impact, denying an area.',
  decoy: 'Emits the sound of gunfire to fake your position, then detonates harmlessly.',
};
const BUY_COLS = [['equipment', 'EQUIPMENT'], ['pistols', 'PISTOLS'], ['midtier', 'MID-TIER'], ['rifles', 'RIFLES'], ['grenades', 'GRENADES']];

// =====================================================================================
export class HUD {
  static googleFonts = false;           // set true before construction to always load Google Fonts too
  constructor(container) {
    injectCSS();
    this.container = container || document.body;
    this.settings = loadSettings();
    this._settingsCbs = [];
    this._v = Object.create(null);                 // value cache for diffed DOM writes
    this._arcs = [];
    this._flash = null;
    this._buy = null;
    this._lastState = null;
    this._dpr = window.devicePixelRatio || 1;

    const R = this.root = el('div', 'h2');
    this.container.appendChild(R);

    // -------- world-space overlays (bottom of the stack)
    this.flashImg = el('canvas', 'flashimg', null, R);
    this.flashEl = el('div', 'flash', null, R);
    this.hitVig = el('div', 'hitvig', null, R);
    this.scopeEl = el('div', 'scope', `<canvas class="sc-dust"></canvas><div class="sc-lens"></div><div class="sc-mask"></div><div class="sc-h"></div><div class="sc-v"></div><div class="sc-ret"></div><div class="sc-dot"></div>`, R);
    this.dmgCv = el('canvas', 'dmgc', null, R);
    this.xhair = el('canvas', 'xhair', null, R);

    // -------- HUD layer
    const H = this.hud = el('div', 'hudl', null, R);
    H.style.cssText = 'position:absolute;inset:0;transition:opacity .25s';
    this.radarWrap = el('div', 'radar', '<canvas></canvas>', H);
    this.radarCv = this.radarWrap.firstChild;
    this.locEl = el('div', 'loc ts', '', H);
    this.moneyEl = el('div', 'money ts num', `${iconHTML('cart', 'cart')}<span class="v">$0</span><span class="carry"></span>`, H);
    this.moneyV = this.moneyEl.querySelector('.v');
    this.cartEl = this.moneyEl.querySelector('.cart');
    this.carryEl = this.moneyEl.querySelector('.carry');
    this.mpop = el('div', 'mpop ts num', '', H);

    this.top = el('div', 'top', `
      <div class="avs ct"></div>
      <div class="sc ct"><div class="box num">0</div></div>
      <div class="tmr num ts"><span class="t">1:55</span>${iconHTML('bomb_planted', 'bomb')}<div class="rnd"></div></div>
      <div class="sc t"><div class="box num">0</div></div>
      <div class="avs t"></div>`, H);
    this.avCT = this.top.querySelector('.avs.ct');
    this.avT = this.top.querySelector('.avs.t');
    this.scCT = this.top.querySelector('.sc.ct .box');
    this.scT = this.top.querySelector('.sc.t .box');
    this.tmrEl = this.top.querySelector('.tmr');
    this.tmrT = this.tmrEl.querySelector('.t');
    this.rndEl = this.tmrEl.querySelector('.rnd');

    this.kfEl = el('div', 'kf', '', H);
    this.fpsEl = el('div', 'fps hide', '', R);
    this.noticeEl = el('div', 'notice ts', '', H);

    this.vitals = el('div', 'vitals', `
      <div class="vit hp">${iconHTML('health')}<span class="v num ts">100</span><div class="bar"><i style="width:100%"></i></div></div>
      <div class="vit ar">${iconHTML('armor')}<span class="v num ts">0</span><div class="bar"><i style="width:0%"></i></div></div>`, H);
    this.hpBox = this.vitals.querySelector('.vit.hp');
    this.hpV = this.hpBox.querySelector('.v');
    this.hpBar = this.hpBox.querySelector('.bar i');
    this.arBox = this.vitals.querySelector('.vit.ar');
    this.arV = this.arBox.querySelector('.v');
    this.arBar = this.arBox.querySelector('.bar i');
    this.arIc = this.arBox.querySelector('.ic');
    this.chatEl = el('div', 'chat', '', H);

    this.ammoEl = el('div', 'ammo ts num', `<span class="bul">${iconHTML('bullet')}</span><span class="clip">30</span><span class="sl">/</span><span class="res">90</span><span class="mode hide"></span>`, H);
    this.clipEl = this.ammoEl.querySelector('.clip');
    this.resEl = this.ammoEl.querySelector('.res');
    this.modeEl = this.ammoEl.querySelector('.mode');
    this.invEl = el('div', 'inv', '', H);

    this.cmsgEl = el('div', 'cmsg', '', H);
    this.progEl = el('div', 'prog', `<div class="lb"></div><div class="tr"><i></i></div><div class="tm num"></div>`, H);
    this.annEl = el('div', 'ann', `<div class="band"><span class="ico"></span><div style="position:relative;display:flex;flex-direction:column;align-items:center"><div class="ttl"></div><div class="sub"></div></div></div>
      <div class="mvp">${iconHTML('star')}<span class="tx"></span></div>`, H);
    this.specEl = el('div', 'spec', '', H);

    // -------- modal layers
    this.sbEl = el('div', 'sb', '', R);
    this.buyEl = el('div', 'buy ui', '', R);
    this.halfEl = el('div', 'big', '', R);
    this.endEl = el('div', 'big end', '', R);
    this.pauseEl = el('div', 'pause', '', R);
    this.menuEl = el('div', 'menu', '', R);

    // radar assets
    this.radarImg = new Image();
    this.radarImg.src = A(RADAR.image || 'assets/ui/radar.png');
    this._c4img = new Image();
    this._c4img.onload = () => {
      const s = 64;
      this._c4 = { carried: tintImage(this._c4img, '#f2a33a', s, s * 0.6), dropped: tintImage(this._c4img, '#f2a33a', s, s * 0.6),
        planted: tintImage(this._c4img, '#ff3b2f', s, s * 0.6), defused: tintImage(this._c4img, '#7ed36b', s, s * 0.6) };
    };
    this._c4img.src = WICON('c4');

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
    this._onKey = this._onKey.bind(this);
    window.addEventListener('keydown', this._onKey, true);
    this._tick = this._tick.bind(this);
    this._raf = requestAnimationFrame(this._tick);
    this._drawCross();
    this._makeDust();
  }

  // ------------------------------------------------------------------ layout
  _resize() {
    const w = this.container.clientWidth || window.innerWidth, h = this.container.clientHeight || window.innerHeight;
    this._W = w; this._H = h;
    this._dpr = window.devicePixelRatio || 1;
    const u = Math.max(0.75, Math.min(h / 1080, w / 1920)) * (this.settings.hudScale || 1);
    this._u = u;
    this.root.style.setProperty('--u', u.toFixed(4) + 'px');
    const rs = Math.round(272 * u * this._dpr);
    this.radarCv.width = rs; this.radarCv.height = rs;
    const ds = Math.round(520 * u * this._dpr);
    this.dmgCv.width = ds; this.dmgCv.height = ds;
    this.scopeEl.style.setProperty('--r', Math.round(Math.min(w, h) * 0.5) + 'px');
    this._v.xh = null; this._drawCross();
    if (this._lastRadar) this.radar(this._lastRadar);
  }
  _set(k, v, fn) { if (this._v[k] !== v) { this._v[k] = v; fn(v); } }

  // ------------------------------------------------------------------ per-frame state
  update(s) {
    if (!s) return;
    this._lastState = s;
    const alive = s.alive !== false;
    this._set('alive', alive, (a) => {
      for (const e of [this.vitals, this.ammoEl, this.invEl]) e.style.opacity = a ? '1' : '0';
      this.moneyEl.style.opacity = a || this._buyOpen ? '1' : '.6';
    });
    // health / armour
    const hp = Math.max(0, Math.round(s.hp ?? 100));
    if (this._v.hp !== hp) {
      const prev = this._v.hp;
      this._v.hp = hp;
      this.hpV.textContent = hp;
      this.hpBar.style.width = clamp(hp, 0, 100) + '%';
      this.hpBox.classList.toggle('low', hp <= 20);
      if (prev != null && hp < prev) { this.hpBox.classList.remove('hit'); void this.hpBox.offsetWidth; this.hpBox.classList.add('hit'); }
    }
    const ar = Math.max(0, Math.round(s.armor ?? 0));
    this._set('ar', ar, (v) => { this.arV.textContent = v; this.arBar.style.width = clamp(v, 0, 100) + '%'; this.arBox.classList.toggle('none', v <= 0); });
    this._set('helm', !!s.helmet, (v) => this.arIc.style.setProperty('--img', `url('${ICON(v ? 'armor_helmet' : 'armor')}')`));
    // money
    const m = Math.round(s.money ?? 0);
    if (this._v.money !== m) {
      const prev = this._v.money;
      this._v.money = m;
      this.moneyV.textContent = fmtMoney(m);
      if (prev != null && m !== prev) {
        const cls = m > prev ? 'gain' : 'spend';
        this.moneyEl.classList.remove('gain', 'spend'); void this.moneyEl.offsetWidth; this.moneyEl.classList.add(cls);
        clearTimeout(this._moneyT); this._moneyT = setTimeout(() => this.moneyEl.classList.remove('gain', 'spend'), 1100);
      }
      if (this._buyOpen) this._buyMoney(m);
    }
    this._set('cart', !!s.inBuyZone && s.canBuy !== false, (v) => this.cartEl.classList.toggle('on', v));
    this._set('carry', `${!!s.hasBomb}|${!!s.hasKit && s.team === 'ct'}`, () => {
      this.carryEl.innerHTML = (s.hasBomb ? `<span class="c4" title="C4">${wIconHTML('c4', 20)}</span>` : '') +
        (s.hasKit && s.team === 'ct' ? `<span class="kit" title="Defuse kit">${wIconHTML('defuser', 20)}</span>` : '');
    });
    // weapon / ammo
    const w = s.weapon;
    const melee = !w || w.clip == null || w.clip < 0;
    this._set('melee', melee, (v) => this.ammoEl.classList.toggle('melee', v));
    if (!melee) {
      this._set('clip', w.clip, (v) => { this.clipEl.textContent = v; });
      this._set('res', w.reserve ?? 0, (v) => { this.resEl.textContent = v; });
      const def = WEAPONS[w.id] || {};
      const mag = def.mag || 30;
      this._set('alow', w.clip === 0 ? 2 : (w.clip <= Math.max(1, Math.floor(mag * 0.2)) ? 1 : 0), (v) => {
        this.ammoEl.classList.toggle('low', v === 1); this.ammoEl.classList.toggle('empty', v === 2);
      });
    }
    const showMode = w && w.mode && WEAPONS[w.id] && WEAPONS[w.id].burstMode ? w.mode.toUpperCase() : '';
    this._set('mode', showMode, (v) => { this.modeEl.textContent = v; this.modeEl.classList.toggle('hide', !v); });
    // inventory
    if (s.inventory) {
      const key = s.inventory.map((i) => `${i.slot}:${i.id}:${i.active ? 1 : 0}`).join(',');
      this._set('inv', key, () => this._renderInv(s.inventory));
    }
    // timer / phase
    const ph = s.phase || 'live';
    let tt;
    if (ph === 'planted') tt = 'BOMB';
    else if (ph === 'warmup') tt = s.roundTime != null ? fmtTime(s.roundTime) : '—';
    else tt = fmtTime(s.roundTime);
    this._set('tt', tt, (v) => { this.tmrT.textContent = v; });
    this._set('ph', ph + '|' + ((s.roundTime ?? 99) <= 10 && ph === 'live'), () => {
      const c = this.tmrEl.classList;
      c.toggle('planted', ph === 'planted'); c.toggle('warm', ph === 'warmup'); c.toggle('freeze', ph === 'freeze');
      c.toggle('low', ph === 'live' && (s.roundTime ?? 99) <= 10);
    });
    this._set('sct', s.scoreCT ?? 0, (v) => { this.scCT.textContent = v; });
    this._set('st', s.scoreT ?? 0, (v) => { this.scT.textContent = v; });
    this._set('rnd', `${s.round ?? ''}/${s.maxRounds ?? ''}/${ph === 'warmup'}`, () => {
      this.rndEl.textContent = ph === 'warmup' ? 'WARMUP' : s.round ? `ROUND ${s.round}${s.maxRounds ? ' / ' + s.maxRounds : ''}` : '';
      this.rndEl.classList.toggle('w', ph === 'warmup');
    });
    this._set('team', s.team, () => { this._v.avct = null; this._v.avt = null; });
    if (s.ctPlayers) this._set('avct', JSON.stringify(s.ctPlayers), () => this._renderAvatars(this.avCT, s.ctPlayers, 'ct', s.team === 'ct'));
    if (s.tPlayers) this._set('avt', JSON.stringify(s.tPlayers), () => this._renderAvatars(this.avT, s.tPlayers, 't', s.team === 't'));
    if (s.location != null) this.setLocation(s.location);
    // crosshair & scope
    const scoped = s.scoped || 0;
    this._set('scoped', scoped, (v) => this.scope(v));
    const ch = s.crosshair || {};
    const vis = alive && (ch.visible !== false) && !scoped && !this._buyOpen && !this._menuOpen;
    this._set('xvis', vis, (v) => { this.xhair.style.display = v ? '' : 'none'; });
    const sp = Math.round((ch.spread || 0) * 2) / 2;
    if (vis) this._set('xsp', sp, () => this._drawCross());
    // spectating
    const spk = s.spectating ? JSON.stringify(s.spectating) : '';
    this._set('spec', spk, () => this.spectate(s.spectating));
    // buy menu live data
    if (this._buyOpen) {
      this._set('bt', `${s.canBuy}|${Math.ceil(s.buyTimeLeft ?? 0)}|${s.inBuyZone}`, () => this._buyHeader(s));
    }
  }

  _renderInv(list) {
    const bySlot = {};
    for (const it of list) (bySlot[it.slot] = bySlot[it.slot] || []).push(it);
    const rows = [];
    for (const slot of [1, 2, 3, 4, 5]) {
      const items = bySlot[slot]; if (!items || !items.length) continue;
      const act = items.find((i) => i.active);
      const ics = items.map((i) => {
        const def = WEAPONS[i.id] || {};
        let h = slot === 1 ? 30 : slot === 2 ? 26 : slot === 3 ? 20 : slot === 4 ? 28 : 22;
        const sz = WEAPON_ICON_SIZE[i.id];
        if (sz && (h * sz[0] / sz[1]) > 150) h = 150 * sz[1] / sz[0];
        void def;
        return wIconHTML(i.id, +h.toFixed(1), slot === 4 && act ? (i.active ? 'on' : 'off') : '');
      }).join('');
      rows.push(`<div class="row s${slot}${act ? ' act' : ''}${slot === 5 ? ' c4' : ''}"><span class="nm">${esc(act ? (act.name || wname(act.id)) : '')}</span><span class="ics">${ics}</span><span class="k">${slot}</span></div>`);
    }
    this.invEl.innerHTML = rows.join('');
  }

  _renderAvatars(box, players, team, mine) {
    box.innerHTML = players.slice(0, 5).map((p, i) => {
      const hp = clamp(p.hp ?? (p.alive ? 100 : 0), 0, 100);
      const tag = mine && p.alive ? (p.hasBomb ? `<span class="tag c4">${wIconHTML('c4', 11)}</span>` : p.hasKit ? `<span class="tag kit">${wIconHTML('defuser', 11)}</span>` : '') : '';
      const ini = esc(String(p.name || '?').replace(/^(BOT|Bot)\s+/, '').slice(0, 3).toUpperCase());
      return `<div class="av ${team}${p.alive ? '' : ' dead'}${p.isMe ? ' me' : ''}" title="${esc(p.name)}">
        <div class="face">${iconHTML(team === 'ct' ? 'ct' : 't')}</div><div class="nm">${ini}</div>${tag}
        ${mine && p.alive ? `<div class="hp${hp <= 20 ? ' low' : ''}"><i style="width:${hp}%"></i></div>` : ''}<div class="x">✕</div></div>`;
    }).join('');
    void PLAYER_COLORS;
  }

  setLocation(text) { this._set('loc', text || '', (v) => { this.locEl.textContent = v; }); }

  showMoney(delta) {
    if (!delta) return;
    const sp = el('span', delta > 0 ? 'p' : 'n', (delta > 0 ? '+' : '-') + fmtMoney(Math.abs(delta)), this.mpop);
    const n = this.mpop.children.length;
    sp.style.top = `calc(${(n - 1) * 24}*var(--u))`;
    setTimeout(() => { sp.remove(); [...this.mpop.children].forEach((c, i) => { c.style.top = `calc(${i * 24}*var(--u))`; }); }, 1850);
  }

  fps(n) {
    if (!this.settings.showFps) return;
    this._set('fps', Math.round(n), (v) => { this.fpsEl.textContent = `${v} FPS`; });
  }

  // ------------------------------------------------------------------ crosshair
  _drawCross() {
    const sp = this._v.xsp || 0;
    drawCrosshair(this.xhair, this.settings.crosshair, sp, this._u || 1, this._dpr);
  }

  // ------------------------------------------------------------------ radar
  radar(d) {
    if (!d || !d.me) return;
    this._lastRadar = d;
    const cv = this.radarCv, ctx = cv.getContext('2d');
    const S = cv.width, Rr = S / 2, dpr = this._dpr, u = this._u * dpr;
    const rot = (d.rotate ?? this.settings.radar.rotate) ? (d.me.yaw || 0) : 0;
    const view = 1150 / clamp(this.settings.radar.scale || 0.7, 0.25, 2);
    const k = (Rr - 2) / view;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const mx = d.me.x, mz = d.me.z;
    const toS = (x, z) => { const dx = (x - mx) * k, dz = (z - mz) * k; return [Rr + dx * cos - dz * sin, Rr + dx * sin + dz * cos]; };
    const dirS = (yaw) => { const fx = -Math.sin(yaw), fz = -Math.cos(yaw); return [fx * cos - fz * sin, fx * sin + fz * cos]; };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath(); ctx.arc(Rr, Rr, Rr - 1 * dpr, 0, Math.PI * 2); ctx.closePath();
    ctx.fillStyle = 'rgba(8,10,13,.82)'; ctx.fill();
    ctx.clip();
    // map image
    if (this.radarImg.complete && this.radarImg.naturalWidth) {
      ctx.save();
      ctx.translate(Rr, Rr); ctx.rotate(rot); ctx.scale(k, k); ctx.translate(-mx, -mz);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.radarImg, RADAR.minX, RADAR.minZ, RADAR.maxX - RADAR.minX, RADAR.maxZ - RADAR.minZ);
      ctx.restore();
    }
    // subtle inner shadow
    const g = ctx.createRadialGradient(Rr, Rr, Rr * 0.72, Rr, Rr, Rr);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.45)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);

    const edge = (p, pad) => {          // clamp a point to the radar disc (teammates/bomb stay visible)
      const dx = p[0] - Rr, dy = p[1] - Rr, L = Math.hypot(dx, dy), max = Rr - pad;
      if (L > max) return [Rr + dx / L * max, Rr + dy / L * max, true];
      return [p[0], p[1], false];
    };
    const myTeam = d.team;
    const players = d.players || [];
    const dotR = 6.2 * u;
    // view cones first (under dots)
    for (const p of players) {
      if (!p.alive || p.isMe || (myTeam && p.team !== myTeam)) continue;
      const [x, y, out] = edge(toS(p.x, p.z), dotR + 2 * u);
      if (out) continue;
      const [fx, fy] = dirS(p.yaw || 0);
      const a = Math.atan2(fy, fx);
      const gr = ctx.createRadialGradient(x, y, 0, x, y, 30 * u);
      gr.addColorStop(0, 'rgba(255,255,255,.30)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, 30 * u, a - 0.5, a + 0.5); ctx.closePath(); ctx.fill();
    }
    // bomb
    const b = d.bomb;
    if (b && this._c4 && (b.state !== 'carried' || myTeam !== 'ct')) {
      if (!(b.state === 'planted' && ((performance.now() / 400) | 0) % 2 === 1 && myTeam)) {
        const [x, y] = edge(toS(b.x, b.z), 10 * u);
        const im = this._c4[b.state] || this._c4.dropped;
        const w = 22 * u, h = w * 0.6;
        if (b.state !== 'carried') {
          ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 3 * u;
          ctx.drawImage(im, x - w / 2, y - h / 2, w, h);
          ctx.shadowBlur = 0;
        }
      }
    }
    // spotted enemies
    for (const e of d.spottedEnemies || []) {
      const [x, y, out] = edge(toS(e.x, e.z), 5 * u);
      if (out) continue;
      ctx.beginPath(); ctx.arc(x, y, 5.4 * u, 0, Math.PI * 2);
      ctx.fillStyle = '#ec3b2f'; ctx.fill();
      ctx.lineWidth = 1.4 * u; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.stroke();
    }
    // enemies in players[] (spectator / own-team filtered by caller)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(9 * u)}px 'HUD Saira','Saira Condensed',sans-serif`;
    const now = performance.now();
    for (const p of players) {
      if (p.isMe) continue;
      const friendly = !myTeam || p.team === myTeam;
      if (!friendly) continue;
      const col = PLAYER_COLORS[(p.index ?? 0) % 5];
      const [x, y, out] = edge(toS(p.x, p.z), dotR + 1.5 * u);
      if (!p.alive) {
        const s2 = 4.6 * u;
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 4 * u;
        ctx.beginPath(); ctx.moveTo(x - s2, y - s2); ctx.lineTo(x + s2, y + s2); ctx.moveTo(x + s2, y - s2); ctx.lineTo(x - s2, y + s2); ctx.stroke();
        ctx.strokeStyle = col; ctx.lineWidth = 2.2 * u; ctx.stroke();
        continue;
      }
      if (p.firing) {
        ctx.beginPath(); ctx.arc(x, y, dotR + 3.5 * u, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${0.5 + 0.4 * Math.sin(now / 40)})`; ctx.lineWidth = 1.6 * u; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = 1.5 * u; ctx.strokeStyle = out ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.85)'; ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,.82)';
      ctx.fillText(String((p.index ?? 0) + 1), x, y + 0.5 * u);
      if (p.hasBomb && this._c4 && myTeam !== 'ct') {
        const w = 14 * u; ctx.drawImage(this._c4.carried, x + dotR * 0.4, y - dotR - w * 0.5, w, w * 0.6);
      }
    }
    // me
    {
      const meP = players.find((p) => p.isMe);
      const col = meP ? PLAYER_COLORS[(meP.index ?? 0) % 5] : '#ffffff';
      const [fx, fy] = dirS(d.me.yaw || 0);
      const a = Math.atan2(fy, fx);
      const gr = ctx.createRadialGradient(Rr, Rr, 0, Rr, Rr, 40 * u);
      gr.addColorStop(0, 'rgba(255,255,255,.34)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.moveTo(Rr, Rr); ctx.arc(Rr, Rr, 40 * u, a - 0.55, a + 0.55); ctx.closePath(); ctx.fill();
      ctx.save(); ctx.translate(Rr, Rr); ctx.rotate(a + Math.PI / 2);
      const s3 = 7.5 * u;
      ctx.beginPath(); ctx.moveTo(0, -s3 * 1.25); ctx.lineTo(s3 * 0.85, s3 * 0.85); ctx.lineTo(0, s3 * 0.4); ctx.lineTo(-s3 * 0.85, s3 * 0.85); ctx.closePath();
      ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.6 * u; ctx.strokeStyle = 'rgba(0,0,0,.9)'; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.restore();
      if (meP && meP.hasBomb && this._c4) { const w = 14 * u; ctx.drawImage(this._c4.carried, Rr + 6 * u, Rr - 16 * u, w, w * 0.6); }
    }
    ctx.restore();
    // rim
    ctx.beginPath(); ctx.arc(Rr, Rr, Rr - 1 * dpr, 0, Math.PI * 2);
    ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(Rr, Rr, Rr - 2.6 * dpr, 0, Math.PI * 2);
    ctx.lineWidth = 1 * dpr; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.stroke();
  }

  // ------------------------------------------------------------------ kill feed
  killfeed(e) {
    if (!e) return;
    const mods = [];
    if (e.noscope) mods.push(iconHTML('noscope'));
    if (e.smoke) mods.push(iconHTML('smoke'));
    if (e.wallbang) mods.push(iconHTML('wallbang'));
    if (e.headshot) mods.push(iconHTML('headshot', 'hs'));
    let wid = e.weapon;
    let wHTML;
    if (wid === 'inferno') wid = 'molotov';
    if (wid && WEAPON_ICON_SIZE[wid]) wHTML = wIconHTML(wid, wid === 'c4' ? 20 : 24);
    else wHTML = iconHTML(wid === 'bomb' || wid === 'explosion' ? 'explosion' : 'skull');
    const nm = (n, t) => n ? `<span class="${t || ''}">${esc(n)}</span>` : '';
    const html = (e.blind ? iconHTML('blind') : '') + (e.killer && e.killer !== e.victim ? nm(e.killer, e.killerTeam) : '') +
      (e.assister ? `<span class="plus">+</span>${nm(e.assister, e.assisterTeam || e.killerTeam)}${e.flashAssist ? iconHTML('blind') : ''}` : '') +
      wHTML + mods.join('') + nm(e.victim, e.victimTeam);
    const im = e.involvesMe;
    const cls = 'e' + (im ? ' me' : '') + (im === 'victim' || e.meVictim ? ' died' : '');
    const row = el('div', cls, html, this.kfEl);
    while (this.kfEl.children.length > 5) this.kfEl.firstChild.remove();
    const life = (im ? 9 : 6.5) * 1000;
    setTimeout(() => { row.classList.add('out'); setTimeout(() => row.remove(), 500); }, life);
  }

  // ------------------------------------------------------------------ banners & messages
  announce(title, subtitle = '', team = null, seconds = 6) {
    const a = this.annEl;
    a.className = 'ann on ' + (team === 'ct' || team === 't' ? team : 'neutral');
    a.querySelector('.ico').innerHTML = team === 'ct' || team === 't' ? iconHTML(team) : '';
    a.querySelector('.ttl').textContent = String(title || '').toUpperCase();
    a.querySelector('.sub').textContent = subtitle || '';
    a.querySelector('.mvp').classList.remove('on');
    clearTimeout(this._annT);
    if (seconds > 0) this._annT = setTimeout(() => a.classList.remove('on'), seconds * 1000);
  }
  announceMVP(name, reason = '') {
    const m = this.annEl.querySelector('.mvp');
    if (!name) { m.classList.remove('on'); return; }
    m.querySelector('.tx').innerHTML = `MVP: <b>${esc(name)}</b>${reason ? ` <span class="r">— ${esc(reason)}</span>` : ''}`;
    m.classList.add('on');
  }
  hideAnnounce() { clearTimeout(this._annT); this.annEl.classList.remove('on'); }

  center(text, seconds = 3, opts = {}) {
    if (!text) { this.cmsgEl.innerHTML = ''; return; }
    for (const c of [...this.cmsgEl.children]) if (c.dataset.t === text) c.remove();
    const m = el('div', 'm ts' + (opts.warn ? ' warn' : ''), esc(text), this.cmsgEl);
    m.dataset.t = text;
    while (this.cmsgEl.children.length > 3) this.cmsgEl.firstChild.remove();
    setTimeout(() => { m.classList.add('out'); setTimeout(() => m.remove(), 400); }, seconds * 1000);
    return m;
  }
  roundNotice(text, seconds = 4) {
    this.noticeEl.textContent = text || '';
    this.noticeEl.classList.toggle('on', !!text);
    clearTimeout(this._noticeT);
    if (text && seconds > 0) this._noticeT = setTimeout(() => this.noticeEl.classList.remove('on'), seconds * 1000);
  }
  progress(label, frac, secondsLeft) {
    if (frac == null || frac === false) { this._set('prog', null, () => this.progEl.classList.remove('on')); return; }
    this._v.prog = 1;
    this.progEl.classList.add('on');
    const lb = this.progEl.querySelector('.lb');
    if (lb.textContent !== label) lb.textContent = label || '';
    this.progEl.querySelector('.tr i').style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
    this.progEl.querySelector('.tm').textContent = secondsLeft != null ? secondsLeft.toFixed(1) + 's' : '';
  }

  radio(name, team, text) { this._chatLine(`<span class="who ${team || ''}">${esc(name)}</span> <span class="rad">(RADIO):</span> ${esc(text)}`); }
  chat(name, team, text, opts = {}) {
    const pre = opts.teamOnly ? `<span class="rad">(${team === 'ct' ? 'Counter-Terrorist' : 'Terrorist'})</span> ` : '';
    const dead = opts.dead ? '<span class="rad">*DEAD*</span> ' : '';
    this._chatLine(`${dead}${pre}<span class="who ${team || ''}">${esc(name)}</span> : ${esc(text)}`);
  }
  _chatLine(html) {
    const l = el('div', 'l', html, this.chatEl);
    while (this.chatEl.children.length > 6) this.chatEl.firstChild.remove();
    setTimeout(() => { l.classList.add('out'); setTimeout(() => l.remove(), 700); }, 9000);
  }

  spectate(info) {
    const e = this.specEl;
    if (!info) { e.className = 'spec'; return; }
    e.className = 'spec on ' + (info.team || '');
    e.innerHTML = `<div class="bar"></div><div class="in"><div><div class="lab">SPECTATING</div><div class="nm">${esc(info.name)}</div></div>
      <div class="st">${iconHTML('health')}<span class="num">${Math.max(0, Math.round(info.hp ?? 0))}</span></div>
      <div class="st">${iconHTML(info.helmet ? 'armor_helmet' : 'armor')}<span class="num">${Math.round(info.armor ?? 0)}</span></div>
      <div class="wp">${info.weaponId ? wIconHTML(info.weaponId, 22) : ''}<span>${esc(info.weaponName || '')}</span></div></div>
      <div class="keys">Mouse1 / Mouse2 · Next / Prev player</div>`;
  }

  // ------------------------------------------------------------------ effects
  damage(angleRad, amount = 20) {
    this._arcs.push({ a: angleRad || 0, s: clamp(0.35 + amount / 60, 0.4, 1), t0: performance.now() });
    if (this._arcs.length > 8) this._arcs.shift();
    this.hitVig.style.transition = 'none'; this.hitVig.style.opacity = String(clamp(amount / 50, 0.25, 0.9));
    requestAnimationFrame(() => { this.hitVig.style.transition = 'opacity .7s'; this.hitVig.style.opacity = '0'; });
  }
  flash(intensity = 1, duration = 3, snapshotCanvas = null) {
    intensity = clamp(intensity, 0, 1);
    if (intensity <= 0.01) return;
    const c = this.flashImg;
    if (snapshotCanvas) {
      try {
        c.width = Math.round(this._W * 0.5); c.height = Math.round(this._H * 0.5);
        const x = c.getContext('2d');
        x.filter = 'blur(2px) saturate(.6)';
        x.drawImage(snapshotCanvas, 0, 0, c.width, c.height);
        x.filter = 'none';
      } catch (e) { c.width = 1; }
    } else { c.width = 1; }
    const now = performance.now();
    // stack with an existing flash like CS (take the stronger remaining)
    this._flash = { t0: now, int: intensity, dur: Math.max(0.3, duration) * 1000, hold: Math.max(0.05, duration * 0.28 * intensity) * 1000, img: !!snapshotCanvas };
  }
  scope(level) {
    level = level | 0;
    this.scopeEl.className = 'scope' + (level ? ' on l' + level : '');
    this._v.scoped = level;
  }
  _makeDust() {
    const c = this.scopeEl.querySelector('.sc-dust'); c.width = 512; c.height = 512;
    const x = c.getContext('2d');
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 260; i++) {
      const r = rnd() * 1.4 + 0.2;
      x.fillStyle = `rgba(255,240,220,${0.04 + rnd() * 0.12})`;
      x.beginPath(); x.arc(rnd() * 512, rnd() * 512, r, 0, 7); x.fill();
    }
    for (let i = 0; i < 8; i++) {
      x.strokeStyle = `rgba(255,240,220,${0.04 + rnd() * 0.05})`; x.lineWidth = 0.6;
      x.beginPath(); const sx = rnd() * 512, sy = rnd() * 512; x.moveTo(sx, sy); x.quadraticCurveTo(sx + rnd() * 40, sy + rnd() * 40, sx + rnd() * 80 - 40, sy + rnd() * 80 - 40); x.stroke();
    }
    c.style.width = '100%'; c.style.height = '100%';
  }

  _tick(t) {
    this._raf = requestAnimationFrame(this._tick);
    // damage arcs
    const cv = this.dmgCv;
    if (this._arcs.length || this._arcsDrawn) {
      const ctx = cv.getContext('2d'), S = cv.width, r = S * 0.30;
      ctx.clearRect(0, 0, S, S);
      const LIFE = 1700;
      this._arcs = this._arcs.filter((a) => t - a.t0 < LIFE);
      for (const a of this._arcs) {
        const age = (t - a.t0) / LIFE, al = (age < 0.35 ? 1 : 1 - (age - 0.35) / 0.65) * a.s;
        const ang = -Math.PI / 2 + a.a, span = 0.5;
        const g = ctx.createRadialGradient(S / 2, S / 2, r - S * 0.03, S / 2, S / 2, r + S * 0.03);
        g.addColorStop(0, `rgba(255,40,30,0)`); g.addColorStop(0.5, `rgba(240,32,22,${al})`); g.addColorStop(1, `rgba(255,40,30,0)`);
        ctx.strokeStyle = g; ctx.lineWidth = S * 0.06; ctx.lineCap = 'butt';
        ctx.beginPath(); ctx.arc(S / 2, S / 2, r, ang - span / 2, ang + span / 2); ctx.stroke();
      }
      this._arcsDrawn = this._arcs.length > 0;
    }
    // flash
    const f = this._flash;
    if (f) {
      const e = t - f.t0;
      let white, img;
      if (e < f.hold) { white = Math.min(0.985, f.int * 1.05); img = f.img ? 0.9 * f.int : 0; }
      else {
        const p = (e - f.hold) / Math.max(1, f.dur - f.hold);
        white = Math.max(0, f.int * 1.05 * (1 - p / 0.75)); white = Math.min(0.985, white);
        img = f.img ? Math.max(0, 0.9 * f.int * (1 - p)) : 0;
      }
      this.flashEl.style.opacity = white.toFixed(3);
      this.flashImg.style.opacity = img.toFixed(3);
      if (e > f.dur) { this._flash = null; this.flashEl.style.opacity = '0'; this.flashImg.style.opacity = '0'; }
    }
    // crosshair preview animation in settings
    if (this._xprev && this._xprev.isConnected) {
      const cfg = this.settings.crosshair;
      const sp = (cfg.style === 'classic' || cfg.style === 'default') ? Math.max(0, Math.sin(t / 420) * 7 + 2) : 0;
      drawCrosshair(this._xprev, cfg, sp * (this._u || 1), (this._u || 1) * 1.6, this._dpr);
    }
  }

  // ------------------------------------------------------------------ settings API
  getSettings() { return JSON.parse(JSON.stringify(this.settings)); }
  onSettingsChange(cb) { if (typeof cb === 'function') this._settingsCbs.push(cb); return () => { this._settingsCbs = this._settingsCbs.filter((c) => c !== cb); }; }
  setSettings(patch) { this.settings = deepMerge(this.settings, patch); this._applySettings(); }
  _applySettings() {
    saveSettings(this.settings);
    this._v.xh = null; this._drawCross();
    this.fpsEl.classList.toggle('hide', !this.settings.showFps);
    this._resize();
    const copy = this.getSettings();
    for (const cb of this._settingsCbs) { try { cb(copy); } catch (e) { console.error(e); } }
  }
  setVisible(v) { this.hud.style.opacity = v ? '1' : '0'; this.xhair.style.visibility = v ? '' : 'hidden'; }
  destroy() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._resize);
    window.removeEventListener('keydown', this._onKey, true);
    this.root.remove();
  }

  // ------------------------------------------------------------------ keyboard (buy menu consumes its keys)
  _onKey(e) {
    if (!this._buyOpen) return;
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const code = e.code || '';
    let n = 0;
    const m = /^(Digit|Numpad)([0-9])$/.exec(code);
    if (m) n = +m[2];
    if (code === 'Escape' || code === 'KeyB') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) this.closeBuyMenu();
      return;
    }
    if (code === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); this._buySelCol(-1); return; }
    if (n >= 1 && n <= 6) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return;
      if (this._buyCol < 0) { if (n <= 5) this._buySelCol(n - 1); return; }
      const colKey = BUY_COLS[this._buyCol][0];
      if (n === 6) { if (colKey === 'midtier') this._buyPage(); return; }
      const items = this._buyColItems(colKey);
      const id = items[n - 1];
      if (id) this._buyDo(id, this._buyEl(id));
      this._buySelCol(-1);                // CS2: after a keyboard purchase the menu returns to the category level
    }
  }

  // ------------------------------------------------------------------ buy menu
  isBuyMenuOpen() { return !!this._buyOpen; }
  isMenuOpen() { return !!(this._menuOpen || this._pauseOpen); }
  isAnyMenuOpen() { return !!(this._buyOpen || this._menuOpen || this._pauseOpen); }

  openBuyMenu(opts = {}) {
    this._buy = { team: 't', money: 0, owned: new Set(), grenadeCounts: {}, armor: 0, helmet: false, canBuy: true, ...opts };
    this._buyOpen = true; this._buyCol = -1; this._buyMidPage = 0;
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) { /* ignore */ }
    this._buyRender();
    this.buyEl.classList.add('on');
    this.xhair.style.display = 'none'; this._v.xvis = null;
    this.moneyEl.style.opacity = '1';
    if (this._lastState) { this._v.bt = null; this._buyHeader(this._lastState); }
  }
  updateBuyMenu(opts = {}) {
    if (!this._buy) return;
    Object.assign(this._buy, opts);
    if (this._buyOpen) { this._buyMoney(this._buy.money); this._buyRenderCols(); this._buyHeader(this._lastState || {}); }
  }
  closeBuyMenu() {
    if (!this._buyOpen) return;
    this._buyOpen = false;
    this.buyEl.classList.remove('on');
    this._v.xvis = null;
    if (this._lastState) this.update(this._lastState);
    const cb = this._buy && this._buy.onClose;
    if (cb) try { cb(); } catch (e) { console.error(e); }
  }
  _buyColItems(colKey) {
    const b = this._buy;
    const team = b.team === 'ct' ? 'ct' : 't';
    let list = (BUY_MENU[team][colKey] || []).slice();
    if (colKey === 'midtier') list = list.slice(this._buyMidPage * 5, this._buyMidPage * 5 + 5);
    else list = list.slice(0, 5);
    return list.map((id) => this._resolveAlt(id, team));
  }
  _altsFor(baseId, team) {
    const alts = (LOADOUT_ALT[baseId] || []).filter((a) => WEAPONS[a] && (WEAPONS[a].team === 'both' || WEAPONS[a].team === team));
    return alts.length ? [baseId, ...alts] : null;
  }
  _resolveAlt(id, team) {
    const opts = this._altsFor(id, team);
    if (!opts) return id;
    const ch = this.settings.loadout && this.settings.loadout[id];
    return opts.includes(ch) ? ch : id;
  }
  _baseOf(id) {
    for (const [k, v] of Object.entries(LOADOUT_ALT)) if (v.includes(id)) return k;
    return id;
  }
  _price(id) {
    const b = this._buy;
    if (id === 'vesthelm' && (b.armor || 0) >= 100 && !b.helmet) return 350;
    return (WEAPONS[id] && WEAPONS[id].price) || (EQUIPMENT[id] && EQUIPMENT[id].price) || 0;
  }
  _owned(id) {
    const b = this._buy;
    const own = b.owned instanceof Set ? b.owned : new Set(b.owned || []);
    if (id === 'vest') return own.has('vest') || (b.armor || 0) >= 100;
    if (id === 'vesthelm') return own.has('vesthelm') || ((b.armor || 0) >= 100 && !!b.helmet);
    const def = WEAPONS[id];
    if (def && def.cat === 'grenade') return ((b.grenadeCounts || {})[id] || 0) >= (def.max || 1);
    return own.has(id);
  }
  _buyRender() {
    const b = this._buy;
    const team = b.team === 'ct' ? 'ct' : 't';
    this.buyEl.innerHTML = `<div class="wrap">
      <div class="hd"><div class="ttl ts">BUY MENU</div><div class="team ${team}">${team === 'ct' ? 'COUNTER-TERRORISTS' : 'TERRORISTS'}</div><div class="bt"></div>
        <div class="mon"><small>MONEY</small><span class="num">${fmtMoney(b.money)}</span></div></div>
      <div class="bd"><div class="cols" style="display:flex;gap:inherit"></div>
        <div class="det"></div></div>
      <div class="ft"><span><span class="kbd">1</span>–<span class="kbd">5</span> Select category, then item</span>
        <span><span class="kbd">RMB</span> Sell back (this round)</span><span><span class="kbd">⇄</span> Loadout variant</span>
        <span><span class="kbd">B</span>/<span class="kbd">ESC</span> Close</span><span class="msg"></span></div></div>`;
    this._buyCols = this.buyEl.querySelector('.cols');
    this._buyCols.style.gap = 'calc(14*var(--u))';
    this._buyDet = this.buyEl.querySelector('.det');
    this._buyMsgEl = this.buyEl.querySelector('.ft .msg');
    this._buyMonEl = this.buyEl.querySelector('.hd .mon span');
    this._buyBtEl = this.buyEl.querySelector('.hd .bt');
    this._buyRenderCols();
    this._buyDetail(null);
    const root = this.buyEl;
    root.onclick = (ev) => {
      const alt = ev.target.closest('.alt');
      if (alt) { ev.stopPropagation(); this._buySwap(alt.dataset.base); return; }
      const more = ev.target.closest('.more');
      if (more) { this._buyPage(); return; }
      const ch = ev.target.closest('.ch');
      if (ch) { const i = +ch.dataset.col; this._buySelCol(this._buyCol === i ? -1 : i); return; }
      const card = ev.target.closest('.card[data-id]');
      if (card) this._buyDo(card.dataset.id, card);
      else if (ev.target === root) this.closeBuyMenu();
    };
    root.oncontextmenu = (ev) => {
      ev.preventDefault();
      const card = ev.target.closest('.card[data-id]');
      if (card) this._sellDo(card.dataset.id, card);
    };
    root.onmouseover = (ev) => {
      const card = ev.target.closest('.card[data-id]');
      if (card && card.dataset.id !== this._buyHover) { this._buyHover = card.dataset.id; this._buyDetail(card.dataset.id); }
    };
  }
  _buyRenderCols() {
    const b = this._buy;
    const team = b.team === 'ct' ? 'ct' : 't';
    const money = b.money || 0;
    this._buyCols.innerHTML = BUY_COLS.map(([key, label], ci) => {
      const items = this._buyColItems(key);
      const cards = [];
      for (let i = 0; i < 5; i++) {
        const id = items[i];
        if (!id) { cards.push('<div class="card empty"></div>'); continue; }
        const price = this._price(id), own = this._owned(id);
        const def = WEAPONS[id];
        const poor = !own && price > money;
        const sz = WEAPON_ICON_SIZE[id] || [10, 10];
        let h = def && def.cat === 'grenade' ? 44 : (def && def.cat === 'pistol') ? 40 : id === 'vest' || id === 'vesthelm' ? 46 : id === 'defuser' ? 34 : 42;
        if (h * sz[0] / sz[1] > 150) h = 150 * sz[1] / sz[0];
        const base = this._baseOf(id);
        const alts = this._altsFor(base, team);
        const cnt = def && def.cat === 'grenade' && (def.max || 1) > 1 ? `<span class="cnt">${(b.grenadeCounts || {})[id] || 0}/${def.max}</span>` : '';
        cards.push(`<div class="card${own ? ' own' : ''}${poor ? ' poor' : ''}" data-id="${id}"><span class="k">${i + 1}</span>
          <div class="im">${wIconHTML(id, +h.toFixed(1))}</div>${own ? '<span class="ok">✓</span>' : cnt}
          ${alts ? `<span class="alt" data-base="${base}" title="Swap: ${alts.map(wname).join(' / ')}">⇄</span>` : ''}
          <span class="nm">${esc(wname(id))}</span><span class="pr num">${fmtMoney(price)}</span></div>`);
      }
      const more = key === 'midtier' ? `<button class="more">${this._buyMidPage ? '◂ PAGE 1' : 'MORE ▸'} <span class="kbd" style="height:calc(18*var(--u));min-width:calc(18*var(--u));margin-left:calc(6*var(--u))">6</span></button>` : '';
      const pg = key === 'midtier' ? `<span class="pg">${this._buyMidPage + 1}/2</span>` : '';
      return `<div class="col${this._buyCol === ci ? ' sel' : ''}" data-col="${ci}"><div class="ch" data-col="${ci}"><span class="kbd">${ci + 1}</span>${label}${pg}</div>${cards.join('')}${more}</div>`;
    }).join('');
  }
  _buyEl(id) { return this._buyCols && this._buyCols.querySelector(`.card[data-id="${id}"]`); }
  _buySelCol(i) {
    this._buyCol = i;
    if (!this._buyCols) return;
    [...this._buyCols.children].forEach((c, k) => c.classList.toggle('sel', k === i));
  }
  _buyPage() { this._buyMidPage = this._buyMidPage ? 0 : 1; this._buyRenderCols(); }
  _buySwap(base) {
    const team = this._buy.team === 'ct' ? 'ct' : 't';
    const opts = this._altsFor(base, team); if (!opts) return;
    const cur = this._resolveAlt(base, team);
    const next = opts[(opts.indexOf(cur) + 1) % opts.length];
    this.settings.loadout = { ...(this.settings.loadout || {}), [base]: next };
    saveSettings(this.settings);
    this._buyRenderCols();
    this._buyDetail(next);
  }
  _buyMsg(text, good) {
    const m = this._buyMsgEl; if (!m) return;
    m.textContent = text || ''; m.classList.toggle('good', !!good); m.classList.add('on');
    clearTimeout(this._buyMsgT); this._buyMsgT = setTimeout(() => m.classList.remove('on'), 2200);
  }
  _buyDo(id, card) {
    const b = this._buy;
    let res = { ok: false, reason: '' };
    if (b.canBuy === false) res = { ok: false, reason: b.reason || "You can't buy right now" };
    else if (typeof b.onBuy === 'function') { try { res = b.onBuy(id) || { ok: false }; } catch (e) { console.error(e); res = { ok: false, reason: 'Error' }; } }
    else res = { ok: true };
    if (card) { card.classList.remove('flash-ok', 'flash-no'); void card.offsetWidth; card.classList.add(res.ok ? 'flash-ok' : 'flash-no'); }
    if (res.ok) this._buyMsg(`Purchased ${wname(id)}`, true);
    else this._buyMsg(res.reason || (this._price(id) > (b.money || 0) ? 'Insufficient funds' : "You can't buy that"));
    if (res.money != null) this.updateBuyMenu({ money: res.money });
    return res;
  }
  _sellDo(id, card) {
    const b = this._buy;
    if (typeof b.onSell !== 'function') return;
    let res;
    try { res = b.onSell(id) || { ok: false }; } catch (e) { console.error(e); res = { ok: false }; }
    if (card) { card.classList.remove('flash-ok', 'flash-no'); void card.offsetWidth; card.classList.add(res.ok ? 'flash-ok' : 'flash-no'); }
    this._buyMsg(res.ok ? `Sold ${wname(id)}` : (res.reason || 'Can only sell items bought this round'), res.ok);
    if (res.money != null) this.updateBuyMenu({ money: res.money });
  }
  _buyMoney(m) {
    if (!this._buyMonEl) return;
    if (this._buy) this._buy.money = m;
    const t = fmtMoney(m);
    if (this._buyMonEl.textContent !== t) {
      this._buyMonEl.textContent = t;
      this._buyMonEl.classList.remove('bump'); void this._buyMonEl.offsetWidth; this._buyMonEl.classList.add('bump');
      this._buyRenderCols();
    }
  }
  _buyHeader(s) {
    if (!this._buyBtEl) return;
    const b = this._buy;
    if (s.canBuy != null) b.canBuy = s.canBuy;
    const can = b.canBuy !== false && s.inBuyZone !== false;
    const left = s.buyTimeLeft;
    let html;
    if (!can) html = s.inBuyZone === false ? 'NOT IN BUY ZONE' : 'BUY TIME EXPIRED';
    else html = left != null ? `BUY TIME LEFT <b class="num">${fmtTime(left)}</b>` : 'BUY ZONE';
    this._buyBtEl.innerHTML = html;
    this._buyBtEl.classList.toggle('no', !can);
    this.buyEl.classList.toggle('locked', !can);
  }
  _buyDetail(id) {
    const d = this._buyDet; if (!d) return;
    if (!id) {
      d.innerHTML = `<div class="dim" style="flex-direction:column;gap:calc(8*var(--u));color:rgba(255,255,255,.35)">${iconHTML('cart')}<span style="font-size:calc(14*var(--u));letter-spacing:.12em">HOVER AN ITEM</span></div>
        <div class="desc">Press <span class="kbd">1</span>–<span class="kbd">5</span> to choose a category, then <span class="kbd">1</span>–<span class="kbd">5</span> to buy. Right-click an item to sell it back while buy time lasts.</div>`;
      d.querySelector('.dim .ic').style.fontSize = 'calc(48*var(--u))';
      return;
    }
    const w = WEAPONS[id], eq = EQUIPMENT[id];
    const name = wname(id), price = this._price(id);
    const sz = WEAPON_ICON_SIZE[id] || [10, 10];
    let h = 80; if (h * sz[0] / sz[1] > 300) h = 300 * sz[1] / sz[0];
    let body = '';
    const kill = w && w.kill != null && w.cat !== 'grenade' ? w.kill : null;
    if (w && w.dmg && w.cat !== 'grenade' && w.cat !== 'equipment') {
      const rpm = Math.round(60 / w.cycle);
      const rows = [
        ['Damage', (w.pellets > 1 ? `${w.dmg}×${w.pellets}` : w.dmg), clamp((w.dmg * (w.pellets || 1)) / 240, 0.05, 1)],
        ['Fire rate', `${rpm}`, clamp(rpm / 1000, 0.05, 1)],
        ['Armor pen.', `${Math.round(w.ap * 100)}%`, clamp(w.ap, 0, 1)],
        ['Magazine', `${w.mag} / ${w.reserve}`, clamp(w.mag / 100, 0.05, 1)],
        ['Move speed', `${w.speed}`, clamp((w.speed - 100) / 150, 0.05, 1)],
        ['Range', `${Math.round((w.rangeMod || 0.9) * 100)}%`, clamp(((w.rangeMod || 0.9) - 0.4) / 0.6, 0.05, 1)],
      ];
      body = `<div class="st">${rows.map((r) => `<span>${r[0]}</span><span class="b"><i style="width:${(r[2] * 100).toFixed(0)}%"></i></span><span class="v num">${r[1]}</span>`).join('')}</div>`;
      const tags = [w.auto ? 'Full-auto' : w.burstMode ? 'Semi / Burst' : 'Semi-auto', w.silenced ? 'Silenced' : null, w.scope ? 'Scoped' : null, w.team !== 'both' ? (w.team === 'ct' ? 'CT only' : 'T only') : null].filter(Boolean);
      body += `<div class="desc">${tags.join(' · ')}</div>`;
    } else {
      body = `<div class="desc">${esc(EQ_DESC[id] || '')}</div>`;
      if (w && w.cat === 'grenade') body += `<div class="dp"><span>Max carry <b>${w.max || 1}</b></span>${w.dmg ? `<span>Damage <b>${w.dmg}</b></span>` : ''}</div>`;
    }
    const cat = w ? (CAT_LABEL[w.cat] || w.cat) : 'Equipment';
    d.innerHTML = `<div class="dim">${wIconHTML(id, +h.toFixed(1))}</div><div class="dc">${esc(cat)}</div><div class="dn">${esc(name)}</div>
      <div class="dp"><span>Price <b class="num">${fmtMoney(price)}</b></span>${kill != null ? `<span>Kill reward <b class="num">${fmtMoney(kill)}</b></span>` : ''}</div>${body}`;
    void eq;
  }

  // ------------------------------------------------------------------ scoreboard
  scoreboard(show, data) {
    if (data) {
      const key = JSON.stringify(data);
      if (key !== this._sbKey) { this._sbKey = key; this.sbEl.innerHTML = this._sbHTML(data); }
    }
    this.sbEl.classList.toggle('on', !!show);
  }
  _sbHTML(d) {
    const my = d.myTeam || (this._lastState && this._lastState.team);
    const teams = d.teams || { ct: d.ctPlayers || [], t: d.tPlayers || [] };
    const half = d.halftimeAfter || RULES.halftimeAfter || 12;
    const maxR = d.maxRounds || RULES.maxRounds || 24;
    const table = (team) => {
      const list = (teams[team] || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0));
      const alive = list.filter((p) => p.alive !== false).length;
      const showMoney = team === my;
      const rows = list.map((p) => {
        const hs = p.k ? Math.round(((p.hsk ?? (p.hs != null && p.hs <= 1 ? p.hs * p.k : 0)) / p.k) * 100) : 0;
        const hsTxt = p.hsp != null ? Math.round(p.hsp) + '%' : (p.hs != null && p.hs > 1 ? Math.round(p.hs) + '%' : hs + '%');
        const col = PLAYER_COLORS[(p.index ?? 0) % 5];
        const eq = showMoney && p.alive !== false ? (p.hasBomb ? `<span class="eq c4">${wIconHTML('c4', 14)}</span>` : p.hasKit ? `<span class="eq kit">${wIconHTML('defuser', 14)}</span>` : '') : '';
        return `<tr class="${p.alive === false ? 'dead' : ''}${p.isMe ? ' me' : ''}">
          <td class="n">${team === my ? `<span class="pc" style="background:${col}"></span>` : '<span class="pc" style="background:rgba(255,255,255,.15)"></span>'}<span class="pn">${esc(p.name)}</span>${p.bot ? '<span class="bot">BOT</span>' : ''}${eq}</td>
          <td class="mny num">${showMoney ? fmtMoney(p.money) : ''}</td>
          <td class="num">${p.k ?? 0}</td><td class="num">${p.a ?? 0}</td><td class="num">${p.d ?? 0}</td>
          <td class="mvp num">${p.mvp ? `${iconHTML('star')}${p.mvp > 1 ? p.mvp : ''}` : ''}</td>
          <td class="num">${hsTxt}</td><td class="num">${Math.round(p.adr ?? 0)}</td><td class="num">${p.score ?? 0}</td></tr>`;
      }).join('');
      return `<div class="tm ${team}"><div class="lab">${iconHTML(team)}${team === 'ct' ? 'COUNTER-TERRORISTS' : 'TERRORISTS'}<span class="s">${alive} ALIVE</span></div>
        <table><colgroup><col style="width:31%"><col style="width:11%"><col span="3" style="width:6.5%"><col style="width:8%"><col span="3" style="width:10%"></colgroup><thead><tr><th class="n">PLAYER</th><th>${showMoney ? 'MONEY' : ''}</th><th>K</th><th>A</th><th>D</th><th>MVP</th><th>HS%</th><th>ADR</th><th>SCORE</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    };
    const hist = d.history || [];
    const ico = { elim: 'skull', elimination: 'skull', bomb: 'explosion', defuse: 'defused', time: 'time' };
    let cells = '';
    for (let i = 0; i < maxR; i++) {
      if (i === half) cells += '<div class="half"></div>';
      const h = hist[i];
      cells += h ? `<div class="r ${h.winner}" title="Round ${i + 1}">${iconHTML(ico[h.reason] || 'skull')}<span>${i + 1}</span></div>` : `<div class="r"><span>${i + 1}</span></div>`;
    }
    return `<div class="hd"><div class="map">${esc(d.map || 'DUST II')}</div><div class="mode">${esc(d.mode || 'COMPETITIVE')}</div>
      <div class="score"><span class="ct num">${d.scoreCT ?? 0}</span><span class="c">:</span><span class="t num">${d.scoreT ?? 0}</span></div>
      <div class="rd">ROUND ${d.round ?? hist.length + 1} / ${maxR}</div></div>
      ${table('ct')}${table('t')}
      <div class="hist"><span class="lb">ROUND HISTORY</span>${cells}</div>`;
  }

  // ------------------------------------------------------------------ halftime / match end
  halftime(scoreCT, scoreT, seconds = 7) {
    if (scoreCT == null) { this.halfEl.classList.remove('on'); return; }
    this.halfEl.innerHTML = `<div class="bk">END OF FIRST HALF</div><div class="bh">HALFTIME<span class="zh">半场休息</span></div>
      <div class="bs"><span class="ct">${iconHTML('ct')}</span><span class="ct num">${scoreCT}</span><span class="c">:</span><span class="t num">${scoreT}</span><span class="t">${iconHTML('t')}</span></div>
      <div class="bn">SWITCHING SIDES · <span class="zh">交换阵营</span></div>`;
    this.halfEl.classList.add('on');
    clearTimeout(this._halfT);
    if (seconds > 0) this._halfT = setTimeout(() => this.halfEl.classList.remove('on'), seconds * 1000);
  }
  matchEnd(info) {
    if (!info) { this.endEl.className = 'big end'; return; }
    const my = info.myTeam || (this._lastState && this._lastState.team);
    const draw = info.winner == null || info.winner === 'draw';
    let title, zh, cls = '';
    if (draw) { title = 'DRAW'; zh = '平局'; }
    else if (my) { const win = info.winner === my; title = win ? 'VICTORY' : 'DEFEAT'; zh = win ? '胜利' : '失败'; cls = win ? ' win' : ' lose'; }
    else { title = info.winner === 'ct' ? 'COUNTER-TERRORISTS WIN' : 'TERRORISTS WIN'; zh = ''; }
    const stats = info.stats ? `<div class="tbl scroll">${'<div class="sb">' + this._sbHTML({ ...info.stats, scoreCT: info.scoreCT, scoreT: info.scoreT, myTeam: my }) + '</div>'}</div>` : '';
    this.endEl.className = 'big end on' + cls;
    this.endEl.innerHTML = `<div class="bk">MATCH OVER · DUST II</div><div class="bh">${title}${zh ? `<span class="zh">${zh}</span>` : ''}</div>
      <div class="bs"><span class="ct">${iconHTML('ct')}</span><span class="ct num">${info.scoreCT ?? 0}</span><span class="c">:</span><span class="t num">${info.scoreT ?? 0}</span><span class="t">${iconHTML('t')}</span></div>
      ${!draw && my ? `<div class="bn">${info.winner === 'ct' ? 'COUNTER-TERRORISTS' : 'TERRORISTS'} WIN THE MATCH</div>` : ''}${stats}
      <div class="acts">${info.onRestart ? '<button class="btn pri" data-a="re">PLAY AGAIN <span class="zh">再来一局</span></button>' : ''}<button class="btn" data-a="menu">MAIN MENU <span class="zh">返回主菜单</span></button></div>`;
    this.endEl.querySelectorAll('.sb').forEach((s) => s.classList.add('on'));
    this.endEl.onclick = (e) => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      if (a.dataset.a === 're' && info.onRestart) info.onRestart();
      if (a.dataset.a === 'menu') { if (info.onMenu) info.onMenu(); }
    };
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ main menu
  showMainMenu(handlers = {}) {
    this._menuH = handlers;
    this._menuOpen = true;
    this.closeBuyMenu();
    this.hidePause();
    this.setVisible(false);
    const s = this.settings;
    const side = s.lastSide || 'auto', diff = s.lastDifficulty || 'normal';
    const M = this.menuEl;
    M.style.setProperty('--radar', `url('${A(RADAR.image || 'assets/ui/radar.png')}')`);
    M.innerHTML = `<div class="deco"></div><div class="grain"></div>
      <div class="side">
        <div class="brand"><div class="t1">DUST II</div><div class="t2">BOMB DEFUSAL <span class="zh">· 爆破模式</span></div><div class="t3">5V5 COMPETITIVE · 竞技模式 MR12</div></div>
        <div class="nav">
          <button data-p="play" class="on"><span class="en">PLAY</span><span class="zh">开始游戏</span></button>
          <button data-p="settings"><span class="en">SETTINGS</span><span class="zh">设置</span></button>
          <button data-p="controls"><span class="en">CONTROLS</span><span class="zh">按键说明</span></button>
          <button data-p="help"><span class="en">HOW TO PLAY</span><span class="zh">玩法介绍</span></button>
        </div>
      </div>
      <div class="pane on" data-pane="play">
        <div class="ph"><span class="en">PLAY</span><span class="zh">开始游戏</span></div>
        <div class="pb">
          <div class="lbl">CHOOSE SIDE <span class="zh">选择阵营</span></div>
          <div class="sides">
            <div class="side-c ct${side === 'ct' ? ' on' : ''}" data-side="ct">${iconHTML('ct')}<div class="en">COUNTER-TERRORISTS</div><div class="zh">反恐精英</div></div>
            <div class="side-c t${side === 't' ? ' on' : ''}" data-side="t">${iconHTML('t')}<div class="en">TERRORISTS</div><div class="zh">恐怖分子</div></div>
            <div class="side-c auto${side === 'auto' ? ' on' : ''}" data-side="auto">${iconHTML('eye')}<div class="en">AUTO-SELECT</div><div class="zh">自动分配</div></div>
          </div>
          <div class="row2"><div><div class="lbl">BOT DIFFICULTY <span class="zh">机器人难度</span></div>
            <div class="seg diff">${DIFFS.map(([k, en, zh]) => `<button data-d="${k}" class="${k === diff ? 'on' : ''}">${en}<span class="zh">${zh}</span></button>`).join('')}</div></div>
            <div><div class="lbl">MAP <span class="zh">地图</span></div><div class="seg"><button class="on">Dust II<span class="zh">炙热沙城 II</span></button></div></div></div>
        </div>
        <div class="pf"><div class="hint">${iconHTML('mouse')}<span>Click START to lock the mouse · <span class="zh">点击开始后锁定鼠标,按 ESC 释放</span></span></div>
          <button class="btn pri start" data-a="start">${iconHTML('play')} START <span class="zh">开始</span></button></div>
      </div>
      <div class="pane" data-pane="settings"><div class="ph"><span class="en">SETTINGS</span><span class="zh">设置</span></div><div class="pb"></div></div>
      <div class="pane" data-pane="controls"><div class="ph"><span class="en">CONTROLS</span><span class="zh">按键说明 · CS2 默认键位</span></div><div class="pb scroll">${this._keysHTML()}</div></div>
      <div class="pane" data-pane="help"><div class="ph"><span class="en">HOW TO PLAY</span><span class="zh">玩法介绍</span></div><div class="pb scroll">${this._helpHTML()}</div></div>
      <div class="foot"><span>Unofficial fan-made tribute · <span class="zh">非官方同人作品</span></span><span>v1.0</span></div>`;
    M.classList.add('on');
    this._buildSettings(M.querySelector('[data-pane="settings"] .pb'));
    const st = { side, diff };
    M.onclick = (e) => {
      const nav = e.target.closest('.nav button');
      if (nav) { this._menuPane(M, nav.dataset.p); return; }
      const sc = e.target.closest('.side-c');
      if (sc) { st.side = sc.dataset.side; M.querySelectorAll('.side-c').forEach((x) => x.classList.toggle('on', x === sc)); return; }
      const db = e.target.closest('.diff button');
      if (db) { st.diff = db.dataset.d; M.querySelectorAll('.diff button').forEach((x) => x.classList.toggle('on', x === db)); return; }
      const a = e.target.closest('[data-a="start"]');
      if (a) {
        this.settings.lastSide = st.side; this.settings.lastDifficulty = st.diff; saveSettings(this.settings);
        const h = this._menuH || {};
        if (h.onStart) h.onStart({ side: st.side, difficulty: st.diff });
      }
    };
  }
  _menuPane(M, p) {
    M.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
    M.querySelectorAll('.pane').forEach((x) => x.classList.toggle('on', x.dataset.pane === p));
  }
  hideMainMenu() {
    this._menuOpen = false;
    this.menuEl.classList.remove('on');
    this.menuEl.innerHTML = '';
    this._xprev = null;
    this.setVisible(true);
    this._v.xvis = null;
  }
  _keysHTML() {
    return `<div class="keys">${KEYBINDS.map((r) => typeof r[0] === 'string'
      ? `<div class="sec">${r[1]} <span class="zh" style="color:rgba(255,255,255,.55);letter-spacing:.1em">${r[0]}</span></div>`
      : `<div class="kr"><span class="kk">${r[0].map((k) => `<span class="kbd">${esc(k)}</span>`).join('')}</span><span class="ds"><span class="zh">${r[1]}</span><span class="en">${r[2]}</span></span></div>`).join('')}</div>`;
  }
  _helpHTML() {
    return HELP.map(([zh, en, tzh, ten]) => `<div style="margin-bottom:calc(20*var(--u))"><div class="lbl">${en} <span class="zh">${zh}</span></div>
      <div class="zh" style="font-size:calc(16*var(--u));line-height:1.65;color:#fff">${tzh}</div>
      <div style="font-size:calc(15*var(--u));line-height:1.5;color:rgba(255,255,255,.6);margin-top:calc(4*var(--u))">${ten}</div></div>`).join('');
  }

  // ------------------------------------------------------------------ pause menu
  showPause(handlers = {}) {
    this._pauseH = handlers;
    this._pauseOpen = true;
    this.closeBuyMenu();
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) { /* ignore */ }
    const P = this.pauseEl;
    P.innerHTML = `<div class="box"><div class="t">PAUSED <span class="zh">已暂停</span></div><div class="nav">
        <button data-a="resume"><span class="en">RESUME</span><span class="zh">继续游戏</span></button>
        <button data-a="settings"><span class="en">SETTINGS</span><span class="zh">设置</span></button>
        <button data-a="controls"><span class="en">CONTROLS</span><span class="zh">按键说明</span></button>
        <button data-a="quit"><span class="en">QUIT TO MENU</span><span class="zh">退出到主菜单</span></button></div></div>
      <div class="menu" style="display:contents"><div class="pane" data-pane="settings"><div class="ph"><span class="en">SETTINGS</span><span class="zh">设置</span></div><div class="pb"></div></div>
      <div class="pane" data-pane="controls"><div class="ph"><span class="en">CONTROLS</span><span class="zh">按键说明 · CS2 默认键位</span></div><div class="pb scroll">${this._keysHTML()}</div></div></div>`;
    P.classList.add('on');
    this._buildSettings(P.querySelector('[data-pane="settings"] .pb'));
    P.onclick = (e) => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      const a = b.dataset.a, h = this._pauseH || {};
      if (a === 'resume') { if (h.onResume) h.onResume(); else this.hidePause(); }
      else if (a === 'quit') { if (h.onQuit) h.onQuit(); }
      else { P.querySelectorAll('.pane').forEach((x) => x.classList.toggle('on', x.dataset.pane === a)); }
    };
  }
  hidePause() {
    if (!this._pauseOpen) return;
    this._pauseOpen = false;
    this.pauseEl.classList.remove('on');
    this.pauseEl.innerHTML = '';
    this._xprev = null;
  }
  isPaused() { return !!this._pauseOpen; }

  // ------------------------------------------------------------------ settings panel
  _buildSettings(host) {
    const tabs = [['game', 'GAME', '游戏 · 鼠标'], ['crosshair', 'CROSSHAIR', '准星'], ['audio', 'AUDIO', '音频'], ['video', 'VIDEO', '画面'], ['hud', 'HUD', '界面 · 雷达']];
    host.innerHTML = `<div class="set"><div class="tabs">${tabs.map(([k, en, zh]) => `<button data-t="${k}"><span class="en">${en}</span><span class="zh">${zh}</span></button>`).join('')}
      <div style="flex:1"></div><button data-reset="1" style="color:rgba(255,160,140,.85)"><span class="en">RESET</span><span class="zh">恢复默认</span></button></div><div class="body"></div></div>`;
    const body = host.querySelector('.body');
    const show = (t) => {
      this._setTab = t;
      host.querySelectorAll('.tabs button[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
      this._renderSettingsTab(body, t);
    };
    host.querySelector('.tabs').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.reset) {
        const keep = { loadout: this.settings.loadout, lastSide: this.settings.lastSide, lastDifficulty: this.settings.lastDifficulty };
        this.settings = deepMerge(DEFAULT_SETTINGS, keep); this._applySettings(); show(this._setTab || 'game'); return;
      }
      show(b.dataset.t);
    };
    show(this._setTab || 'game');
  }
  _renderSettingsTab(body, tab) {
    const S = this.settings;
    const get = (p) => p.split('.').reduce((o, k) => (o ? o[k] : undefined), S);
    const set = (p, v) => { const ks = p.split('.'); let o = S; for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = v; this._applySettings(); };
    const items = [];
    const range = (en, zh, p, min, max, step, fmt = (v) => v) => items.push({ t: 'range', en, zh, p, min, max, step, fmt });
    const tog = (en, zh, p) => items.push({ t: 'tog', en, zh, p });
    const seg = (en, zh, p, opts) => items.push({ t: 'seg', en, zh, p, opts });
    let pre = '';
    if (tab === 'game') {
      range('Mouse Sensitivity', '鼠标灵敏度', 'sensitivity', 0.1, 8, 0.01, (v) => (+v).toFixed(2));
      range('Zoom Sensitivity Ratio', '开镜灵敏度倍率', 'zoomSensitivity', 0.1, 3, 0.01, (v) => (+v).toFixed(2));
      tog('Invert Mouse Y', '反转鼠标 Y 轴', 'invertY');
      tog('Raw Input', '原始输入', 'rawInput');
      seg('Field of View', '视野 (FOV)', 'fovMode', [['default', 'Default 90°', '默认'], ['wide', 'Wide 100°', '宽视野']]);
      seg('Viewmodel Preset', '持枪视角', 'viewmodel', [['desktop', 'Desktop', '桌面'], ['couch', 'Couch', '沙发'], ['classic', 'Classic', '经典']]);
    } else if (tab === 'crosshair') {
      pre = `<div class="xprev"><div class="wall"></div><div class="wall2"></div><canvas></canvas><div class="bgsw">
        <i data-bg="dust" style="background:linear-gradient(180deg,#9fb6c9,#d9c7a5 48%,#b48e5c 52%,#8a6a42)"></i><i data-bg="dark" style="background:#2a2e33"></i><i data-bg="light" style="background:#e9e4d8"></i></div></div>`;
      seg('Style', '准星样式', 'crosshair.style', [['classic', 'Classic', '经典'], ['classic_static', 'Classic Static', '静态'], ['default', 'Default', '默认']]);
      range('Length', '长度', 'crosshair.size', 0.5, 10, 0.5, (v) => (+v).toFixed(1));
      range('Gap', '间隙', 'crosshair.gap', -5, 5, 0.5, (v) => (+v).toFixed(1));
      range('Thickness', '粗细', 'crosshair.thickness', 0.5, 4, 0.5, (v) => (+v).toFixed(1));
      tog('Outline', '描边', 'crosshair.outline');
      tog('Center Dot', '中心点', 'crosshair.dot');
      tog('T Style', 'T 形准星', 'crosshair.tStyle');
      items.push({ t: 'color' });
      if (S.crosshair.color === 'custom') {
        range('Red', '红 R', 'crosshair.r', 0, 255, 1); range('Green', '绿 G', 'crosshair.g', 0, 255, 1); range('Blue', '蓝 B', 'crosshair.b', 0, 255, 1);
      }
      range('Alpha', '不透明度', 'crosshair.alpha', 25, 255, 1);
    } else if (tab === 'audio') {
      const pct = (v) => Math.round(v * 100) + '%';
      range('Master Volume', '主音量', 'volume.master', 0, 1, 0.01, pct);
      range('Effects', '音效', 'volume.sfx', 0, 1, 0.01, pct);
      range('Music', '音乐', 'volume.music', 0, 1, 0.01, pct);
    } else if (tab === 'video') {
      seg('Graphics Quality', '画面质量', 'graphics', [['low', 'Low', '低'], ['medium', 'Medium', '中'], ['high', 'High', '高'], ['ultra', 'Ultra', '极高']]);
      tog('Show FPS', '显示帧数', 'showFps');
    } else if (tab === 'hud') {
      range('HUD Scale', '界面缩放', 'hudScale', 0.8, 1.25, 0.05, (v) => (+v).toFixed(2));
      tog('Rotate Radar', '雷达随视角旋转', 'radar.rotate');
      range('Radar Map Zoom', '雷达缩放', 'radar.scale', 0.4, 1.3, 0.05, (v) => (+v).toFixed(2));
    }
    const html = items.map((it, i) => {
      const nm = it.en ? `<div class="nm"><span class="en">${it.en}</span><span class="zh">${it.zh}</span></div>` : '';
      if (it.t === 'range') {
        const v = get(it.p);
        return `<div class="it">${nm}<div class="ctl"><input type="range" data-i="${i}" min="${it.min}" max="${it.max}" step="${it.step}" value="${v}"></div><div class="val num" data-v="${i}">${it.fmt(v)}</div></div>`;
      }
      if (it.t === 'tog') return `<div class="it">${nm}<div class="ctl"><div class="tog${get(it.p) ? ' on' : ''}" data-i="${i}"></div></div><div class="val"></div></div>`;
      if (it.t === 'seg') return `<div class="it">${nm}<div class="ctl"><div class="seg">${it.opts.map(([k, en, zh]) => `<button data-i="${i}" data-k="${k}" class="${get(it.p) === k ? 'on' : ''}">${en}<span class="zh">${zh}</span></button>`).join('')}</div></div><div class="val"></div></div>`;
      if (it.t === 'color') {
        const c = S.crosshair.color;
        const sw = Object.entries(CROSSHAIR_COLORS).map(([k, v]) => `<i data-col="${k}" class="${c === k ? 'on' : ''}" style="background:rgb(${v.join(',')})" title="${k}"></i>`).join('') + `<i data-col="custom" class="cu${c === 'custom' ? ' on' : ''}" title="custom"></i>`;
        return `<div class="it"><div class="nm"><span class="en">Color</span><span class="zh">颜色</span></div><div class="ctl"><div class="sw">${sw}</div></div><div class="val" style="text-transform:capitalize">${c}</div></div>`;
      }
      return '';
    }).join('');
    body.innerHTML = pre + `<div class="scroll" style="display:flex;flex-direction:column;gap:2px">${html}</div>`;
    const pct = (inp) => inp.style.setProperty('--p', (((inp.value - inp.min) / (inp.max - inp.min)) * 100).toFixed(1) + '%');
    body.querySelectorAll('input[type=range]').forEach((inp) => {
      pct(inp);
      inp.oninput = () => {
        const it = items[+inp.dataset.i];
        pct(inp);
        set(it.p, +inp.value);
        body.querySelector(`[data-v="${inp.dataset.i}"]`).textContent = it.fmt(+inp.value);
      };
    });
    body.onclick = (e) => {
      const t = e.target.closest('.tog');
      if (t) { const it = items[+t.dataset.i]; const v = !get(it.p); set(it.p, v); t.classList.toggle('on', v); return; }
      const sb = e.target.closest('.seg button[data-k]');
      if (sb) { const it = items[+sb.dataset.i]; set(it.p, sb.dataset.k); sb.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === sb)); return; }
      const sw = e.target.closest('.sw i');
      if (sw) {
        const k = sw.dataset.col;
        if (k !== 'custom') { const v = CROSSHAIR_COLORS[k]; S.crosshair.r = v[0]; S.crosshair.g = v[1]; S.crosshair.b = v[2]; }
        set('crosshair.color', k); this._renderSettingsTab(body, tab); return;
      }
      const bg = e.target.closest('.bgsw i');
      if (bg) {
        const xp = body.querySelector('.xprev');
        xp.style.background = bg.style.background;
        xp.querySelectorAll('.wall,.wall2').forEach((w) => { w.style.display = bg.dataset.bg === 'dust' ? '' : 'none'; });
      }
    };
    this._xprev = body.querySelector('.xprev canvas');
  }
}
