// =====================================================================================
//  audio.js — fully procedural sound engine for DUST (CS2-style 5v5 bomb defusal)
//
//  No audio files: every sound is synthesized at init() from noise, filtered impulses,
//  modal resonators, pitch-enveloped oscillators, saturation and algorithmic reverb.
//  Rendering runs in module Web Workers (this same file is loaded as the worker) with a
//  main-thread fallback. Playback uses HRTF panners with a custom CS-like distance model,
//  near/far buffer crossfades for gunshots & explosions, a shared convolution reverb
//  (synthetic "sandy town with stone walls" IR), muffle/tinnitus and a master limiter.
//
//  API:
//    const audio = new AudioEngine();
//    await audio.init(onProgress?)                 // from a user gesture
//    audio.setListener(pos, forward, up)          // each frame (any {x,y,z})
//    audio.setVolume({ master, sfx, music })
//    const h = audio.play(name, { pos, volume, rate, weapon, surface, variant, delay })
//    const l = audio.playLoop(name, opts)          // l.stop(fadeSec), l.setPos(v), l.setVolume(v)
//    audio.muffle(0..1)
// =====================================================================================

const SR = 44100;
const TAU = Math.PI * 2;

// ------------------------------------------------------------------ RNG (seeded)
let _s = 1;
function rnd() {
  _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function seed(n) { _s = (Math.imul((n | 0) ^ 0x9E3779B9, 2654435761) ^ 0x5bd1e995) | 0; if (!_s) _s = 1; rnd(); rnd(); }
function hashStr(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
const rr = (a, b) => a + (b - a) * rnd();
const ri = (a, b) => Math.floor(rr(a, b + 1));
const N = s => Math.max(1, Math.round(s * SR));
const zeros = s => new Float32Array(N(s));
const dbToG = db => Math.pow(10, db / 20);

// ------------------------------------------------------------------ noise
function white(n) { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = rnd() * 2 - 1; return o; }
function pink(n) {
  const o = new Float32Array(n); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
    o[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
  }
  return o;
}
function brown(n) { const o = new Float32Array(n); let b = 0; for (let i = 0; i < n; i++) { b = (b + 0.02 * (rnd() * 2 - 1)) / 1.02; o[i] = b * 3.5; } return o; }

// ------------------------------------------------------------------ biquad filters (RBJ)
function coefs(type, f, Q, g) {
  f = Math.min(Math.max(f, 8), SR * 0.47);
  const w = TAU * f / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b1 = 1 - c; b0 = b2 = b1 / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'hp') { b1 = -(1 + c); b0 = b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'notch') { b0 = 1; b1 = -2 * c; b2 = 1; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'pk') { const A = Math.pow(10, g / 40); b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
  else {
    const A = Math.pow(10, g / 40), sq = 2 * Math.sqrt(A) * al;
    if (type === 'ls') { b0 = A * ((A + 1) - (A - 1) * c + sq); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sq); a0 = (A + 1) + (A - 1) * c + sq; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sq; }
    else { b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq); a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq; }
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
// in-place; f may be a function of time (s) -> Hz (updated every 32 samples)
function filt(x, type, f, Q = 0.707, g = 0) {
  const fn = typeof f === 'function';
  let k = coefs(type, fn ? f(0) : f, Q, g);
  let b0 = k[0], b1 = k[1], b2 = k[2], a1 = k[3], a2 = k[4];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const n = x.length;
  for (let i = 0; i < n; i++) {
    if (fn && (i & 31) === 0 && i) { k = coefs(type, f(i / SR), Q, g); b0 = k[0]; b1 = k[1]; b2 = k[2]; a1 = k[3]; a2 = k[4]; }
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}
const lp = (x, f, q = 0.707) => filt(x, 'lp', f, q);
const hp = (x, f, q = 0.707) => filt(x, 'hp', f, q);
const bp = (x, f, q = 1) => filt(x, 'bp', f, q);
const pk = (x, f, q, g) => filt(x, 'pk', f, q, g);
const ls = (x, f, g, q = 0.707) => filt(x, 'ls', f, q, g);
const hs = (x, f, g, q = 0.707) => filt(x, 'hs', f, q, g);
function lp1(x, f) { const a = 1 - Math.exp(-TAU * f / SR); let y = 0; for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] = y; } return x; }

// ------------------------------------------------------------------ envelopes / utils
// attack (linear) -> hold -> exponential decay (time constant tau); zero before delay
function env(x, att, tau, delay = 0, hold = 0) {
  const d = Math.round(delay * SR), a = Math.max(1, Math.round(att * SR)), h = Math.round(hold * SR), k = Math.exp(-1 / (tau * SR));
  let e = 1;
  for (let i = 0; i < x.length; i++) {
    if (i < d) { x[i] = 0; continue; }
    const j = i - d;
    if (j < a) x[i] *= j / a;
    else if (j >= a + h) { e *= k; x[i] *= e; }
  }
  return x;
}
function envPts(x, pts) {
  let k = 0; const last = pts.length - 1;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    while (k < last && t > pts[k + 1][0]) k++;
    let v;
    if (t <= pts[0][0]) v = pts[0][1];
    else if (k >= last) v = pts[last][1];
    else { const t0 = pts[k][0], v0 = pts[k][1], t1 = pts[k + 1][0], v1 = pts[k + 1][1]; v = v0 + (v1 - v0) * (t - t0) / ((t1 - t0) || 1); }
    x[i] *= v;
  }
  return x;
}
function adsr(x, a, d, s, dur, r) {
  for (let i = 0; i < x.length; i++) {
    const t = i / SR; let v;
    if (t < a) v = t / a; else if (t < a + d) v = 1 - (1 - s) * (t - a) / d; else v = s;
    if (t > dur) v *= Math.max(0, 1 - (t - dur) / r);
    x[i] *= v;
  }
  return x;
}
function add(dst, src, t = 0, g = 1) {
  const off = Math.round(t * SR);
  const i0 = Math.max(0, -off), i1 = Math.min(src.length, dst.length - off);
  for (let i = i0; i < i1; i++) dst[i + off] += src[i] * g;
  return dst;
}
function peakOf(x) { let m = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; } return m; }
function norm(x, p = 1) { const m = peakOf(x); if (m > 1e-9) { const g = p / m; for (let i = 0; i < x.length; i++) x[i] *= g; } return x; }
function scale(x, g) { for (let i = 0; i < x.length; i++) x[i] *= g; return x; }
function sat(x, drive) { const k = 1 / Math.tanh(drive); for (let i = 0; i < x.length; i++) x[i] = Math.tanh(drive * x[i]) * k; return x; }
function fadeOut(x, sec) { const n = Math.min(x.length, N(sec)); const s = x.length - n; for (let i = 0; i < n; i++) { const w = 1 - i / n; x[s + i] *= w * w; } return x; }
function fadeIn(x, sec) { const n = Math.min(x.length, N(sec)); for (let i = 0; i < n; i++) x[i] *= i / n; return x; }
function stRms(x, win = 0.05) { // max short-term RMS (running window)
  const w = Math.min(N(win), x.length); let e = 0, best = 0;
  for (let i = 0; i < x.length; i++) { e += x[i] * x[i]; if (i >= w) e -= x[i - w] * x[i - w]; if (e > best) best = e; }
  return Math.sqrt(Math.max(0, best) / w);
}
// K-weighted (BS.1770-ish) max short-term loudness over window, in LUFS-like dB
function loud(chs, win = .1) {
  const w = N(win), n = chs[0].length;
  const ks = chs.map(c => { const y = c.slice(); hs(y, 1500, 4); hp(y, 40, .5); return y; });
  let e = 0, best = 0;
  for (let i = 0; i < n; i++) {
    for (const y of ks) { e += y[i] * y[i]; if (i >= w) e -= y[i - w] * y[i - w]; }
    if (e > best) best = e;
  }
  return -0.691 + 10 * Math.log10(Math.max(1e-12, best / Math.min(w, n)));
}
function loudNorm(chs, target = -12, win = .1, cap = .98) {
  const L = loud(chs, win); let g = Math.pow(10, (target - L) / 20), p = 0;
  for (const c of chs) p = Math.max(p, peakOf(c));
  if (p * g > cap) g = cap / p;
  for (const c of chs) scale(c, g);
  return L + 20 * Math.log10(g);
}
// exponential pitch sweep f0 -> f1 (time-constant tau)
const sw = (f0, f1, tau) => t => f1 + (f0 - f1) * Math.exp(-t / tau);

// ------------------------------------------------------------------ oscillators
function blep(t, dt) { if (t < dt) { t /= dt; return t + t - t * t - 1; } if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; } return 0; }
function osc(n, f, type = 'sin', ph = 0) {
  const o = new Float32Array(n), fn = typeof f === 'function';
  const T = type === 'sin' ? 0 : type === 'saw' ? 1 : type === 'sq' ? 2 : 3;
  let p = ph, fr = fn ? f(0) : f;
  for (let i = 0; i < n; i++) {
    if (fn && (i & 15) === 0) fr = f(i / SR);
    const dt = fr / SR;
    let v;
    if (T === 0) v = Math.sin(TAU * p);
    else if (T === 1) v = 2 * p - 1 - blep(p, dt);
    else if (T === 2) { v = p < 0.5 ? 1 : -1; v += blep(p, dt); let q = p + 0.5; if (q >= 1) q -= 1; v -= blep(q, dt); }
    else v = 4 * Math.abs(p - 0.5) - 1;
    o[i] = v;
    p += dt; if (p >= 1) p -= Math.floor(p);
  }
  return o;
}

// ------------------------------------------------------------------ modal synthesis
// modes: [[freq, t60, amp], ...]; excitation filtered through 2-pole resonators
function modal(exc, modes, n) {
  n = n || exc.length;
  const o = new Float32Array(n);
  for (const m of modes) {
    const f = m[0], t60 = m[1], amp = m[2];
    if (!(f > 10 && f < SR * 0.46) || !amp) continue;
    const w = TAU * f / SR, r = Math.exp(-6.9078 / (t60 * SR));
    const c1 = 2 * r * Math.cos(w), c2 = -r * r, g = amp * Math.sin(w);
    const end = Math.min(n, exc.length + Math.ceil(t60 * 1.15 * SR));
    let y1 = 0, y2 = 0; const el = exc.length;
    for (let i = 0; i < end; i++) {
      const y = (i < el ? exc[i] * g : 0) + c1 * y1 + c2 * y2;
      y2 = y1; y1 = y; o[i] += y;
    }
  }
  return o;
}
function strike(len = 0.0008) { const n = Math.max(2, N(len)); const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = (rnd() * 2 - 1) * (1 - i / n); x[0] += 1; return x; }
function clack(modes, hard = 0.0006, len = 0.15, jit = 0.04) {
  const m = modal(strike(hard), modes.map(([f, d, a]) => [f * (1 + (rnd() * 2 - 1) * jit), d * rr(0.85, 1.15), a * rr(0.75, 1.25)]), N(len));
  return norm(m, 1);
}
// sparse random impulses (crackle / grit / debris textures); ampFn(u in 0..1)
function grains(n, dens, t0, t1, ampFn) {
  const o = new Float32Array(n); const p = dens / SR;
  const i0 = N(t0), i1 = Math.min(n, N(t1)); const span = Math.max(1, i1 - i0);
  for (let i = i0; i < i1; i++) if (rnd() < p) o[i] = (rnd() * 2 - 1) * (ampFn ? ampFn((i - i0) / span) : 1);
  return o;
}

// ------------------------------------------------------------------ reverbs / delays
function allpass(x, d, g) { const o = new Float32Array(x.length); for (let i = 0; i < x.length; i++) { const xd = i >= d ? x[i - d] : 0, yd = i >= d ? o[i - d] : 0; o[i] = -g * x[i] + xd + g * yd; } return o; }
function diffuse(x) { return allpass(allpass(allpass(x, 142, 0.6), 107, 0.6), 379, 0.55); }
const FDN_L = [1031, 1327, 1523, 1783, 2053, 2311, 2621, 2903];
// 8-line feedback delay network with Householder mixing and per-line damping
function fdn(x, o = {}) {
  const t60 = o.t60 ?? 1.2, size = o.size ?? 1;
  const outN = o.len ? N(o.len) : x.length + N(t60 * 1.1);
  const pre = N(o.pre ?? 0.01);
  const lens = FDN_L.map(l => Math.max(16, Math.round(l * size)));
  const lines = lens.map(l => new Float32Array(l)), idx = new Int32Array(8), st = new Float64Array(8), v = new Float64Array(8);
  const gn = lens.map(l => Math.pow(10, -3 * l / (t60 * SR)));
  const dc = 1 - Math.exp(-TAU * (o.damp ?? 4500) / SR);
  const L = new Float32Array(outN), R = o.stereo ? new Float32Array(outN) : null;
  const xl = x.length;
  for (let i = 0; i < outN; i++) {
    const j = i - pre; const xin = (j >= 0 && j < xl) ? x[j] : 0;
    let sum = 0;
    for (let k = 0; k < 8; k++) { const s = lines[k][idx[k]]; st[k] += dc * (s - st[k]); const y = st[k] * gn[k]; v[k] = y; sum += y; }
    sum *= 0.25;
    L[i] = v[0] - v[1] + v[2] - v[3] + v[4] - v[5] + v[6] - v[7];
    if (R) R[i] = v[0] + v[1] - v[2] - v[3] + v[4] + v[5] - v[6] - v[7];
    for (let k = 0; k < 8; k++) { lines[k][idx[k]] = xin * ((k & 1) ? -0.5 : 0.5) + v[k] - sum; if (++idx[k] >= lens[k]) idx[k] = 0; }
  }
  return R ? [L, R] : L;
}
// discrete reflections: [[delay, gain, lowpassHz], ...]
function echoes(x, taps, n) {
  const o = new Float32Array(n);
  for (const [t, g, f] of taps) { const y = x.slice(0, Math.max(0, Math.min(x.length, n - N(t)))); if (!y.length) continue; if (f) { lp(y, f, 0.6); } add(o, y, t, g); }
  return o;
}
// crossfade-loopify: x has length >= L+X; returns seamless loop of length L
function loopify(x, L) {
  const nL = N(L), X = x.length - nL; const o = x.slice(0, nL);
  for (let i = 0; i < X && i < nL; i++) { const w = i / X; o[i] = x[i] * Math.sqrt(w) + x[nL + i] * Math.sqrt(1 - w); }
  return o;
}
function smoothNoise(n, rate, comps = 5) {
  const o = new Float32Array(n); const c = []; let s = 0;
  for (let k = 0; k < comps; k++) { const a = rr(0.5, 1); c.push([rate * rr(0.3, 1.7), rr(0, TAU), a]); s += a; }
  const step = 64; let prev = 0;
  for (let i = 0; i <= n; i += step) {
    const t = i / SR; let v = 0; for (const q of c) v += q[2] * Math.sin(TAU * q[0] * t + q[1]); v /= s;
    if (i > 0) for (let j = i - step; j < i && j < n; j++) o[j] = prev + (v - prev) * (j - (i - step)) / step;
    prev = v;
  }
  for (let j = n - (n % step); j < n; j++) o[j] = prev;
  return o;
}

// ------------------------------------------------------------------ composite building blocks
function noiseBurst(len, type, f, q, att, dec, color = 'white') {
  const x = color === 'pink' ? pink(N(len)) : color === 'brown' ? brown(N(len)) : white(N(len));
  if (type) filt(x, type, f, q);
  env(x, att, dec); return norm(x, 1);
}
function thud(f0, f1, dec, len) { const x = osc(N(len || dec * 7 + 0.02), sw(f0, f1, Math.max(0.006, dec * 0.3))); env(x, 0.0012, dec); return norm(x, 1); }
function swish(dur, f0, fpk, q = 1.2) {
  const n = N(dur + 0.03); const x = pink(n);
  filt(x, 'bp', t => f0 + (fpk - f0) * Math.sin(Math.PI * Math.min(1, t / dur)), q);
  for (let i = 0; i < n; i++) { const u = Math.min(1, i / (dur * SR)); x[i] *= Math.pow(Math.sin(Math.PI * u), 1.5); }
  return norm(x, 1);
}
function scrape(dur, f0, f1, q = 2, grit = 0.6) {
  const n = N(dur + 0.02); const x = white(n);
  filt(x, 'bp', t => f0 + (f1 - f0) * Math.min(1, t / dur), q);
  envPts(x, [[0, 0], [dur * 0.15, 1], [dur * 0.8, 0.8], [dur, 0]]);
  const g = grains(n, 2500, 0, dur, u => Math.sin(Math.PI * u)); bp(g, (f0 + f1) / 2, 1.2);
  norm(x, 1); norm(g, 1); add(x, g, 0, grit); return norm(x, 1);
}
function nwave(x, t, amp, dur) { const o = N(t), n = Math.max(3, Math.round(dur * SR)); for (let i = 0; i < n && o + i < x.length; i++) x[o + i] += amp * (1 - 2 * i / n); return x; }

// metal mode sets
const M_GUN = [[1800, .035, 1], [3100, .03, .7], [4700, .025, .5], [6800, .02, .3]];
const M_SMALL = [[3200, .025, 1], [5300, .02, .6], [8100, .015, .4]];
const M_HEAVY = [[950, .05, 1], [1750, .04, .8], [2700, .035, .6], [3900, .03, .4]];
const M_CAN = () => [[rr(760, 820), .07, 1], [rr(1620, 1700), .06, .8], [rr(2650, 2800), .05, .6], [rr(3850, 4000), .04, .45], [rr(5200, 5500), .03, .3]];
const mscale = (m, s) => m.map(([f, d, a]) => [f * s, d, a]);

// =====================================================================================
//  GUNSHOTS
// =====================================================================================
function mix(base, over) {
  const o = { ...base };
  for (const k in over) {
    const v = over[k], b = base[k];
    o[k] = (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) ? { ...b, ...v } : v;
  }
  return o;
}
const SZK = 1.2, SZA = 1.5, BODYK = .75, THUMPK = .3, HI_ADD = 1, BLASTK = 1.35;
const mech = (t, amp, modes, hard = 0.0006, len = 0.2) => ({ t, amp, modes, hard, len });

const PISTOL = {
  len: 0.75, crack: { amp: .8, hp: 1800, dur: .0035, nw: .0004, sz: .015, szAmp: .35 }, blast: { amp: .9, f: 1300, q: 1.1, res: 5, dec: .026, sweep: 3 },
  thump: { amp: .5, f0: 240, f1: 90, dec: .05 }, drive: 2.5,
  mech: [mech(.012, .14, [[2600, .03, 1], [4300, .025, .7], [6600, .02, .4]]), mech(.05, .08, [[3100, .025, 1], [5200, .02, .6]])],
  tail: { amp: .32, t60: .8 }, far: { lp: 1700, t60: 1.7, len: 2.2, crack: .14 },
};
const SMG = {
  len: 0.75, crack: { amp: .8, hp: 1900, dur: .0035, nw: .0004, sz: .018, szAmp: .35 }, blast: { amp: .95, f: 1300, q: 1.1, res: 5, dec: .028, sweep: 3 },
  thump: { amp: .5, f0: 230, f1: 80, dec: .055 }, drive: 2.7,
  mech: [mech(.014, .12, [[2300, .03, 1], [3900, .025, .7], [6100, .02, .4]])],
  tail: { amp: .32, t60: .85 }, far: { lp: 1600, t60: 1.9, len: 2.4, crack: .12 },
};
const RIFLE = {
  len: 1.0, crack: { amp: 1, hp: 1600, dur: .006, nw: .0005, sz: .025, szAmp: .38 }, blast: { amp: 1, f: 950, q: 1, res: 5, dec: .04, sweep: 3.5 },
  thump: { amp: .8, f0: 200, f1: 58, dec: .09 }, drive: 3,
  mech: [mech(.022, .1, M_GUN)], tail: { amp: .4, t60: 1.0 }, far: { lp: 1400, t60: 2.3, len: 2.9, crack: .12 },
};
const SHOTGUN = {
  len: 1.4, crack: { amp: .8, hp: 900, dur: .009, nw: .0008, sz: .03, szAmp: .3 }, body: { f: 170, dec: .11, amp: 1.1 }, blast: { amp: 1.3, f: 480, q: .7, res: 4, dec: .085, sweep: 5 },
  thump: { amp: 1.3, f0: 135, f1: 38, dec: .2 }, drive: 3.8, mech: [], tail: { amp: .5, t60: 1.4 }, far: { lp: 1100, t60: 2.7, len: 3.3, crack: .08 },
};
const SUPP = {
  len: 0.6, sup: { thup: { amp: 1, f: 900, dec: .014 }, pop: { amp: .7, f0: 170, f1: 85, dec: .03 }, pfft: { amp: .25, f: 3500, dec: .012 } },
  thump: null, drive: 1.8, mech: [], tail: { amp: .14, t60: .5 }, far: { lp: 1500, t60: 1.2, len: 1.5, crack: .05 },
};
const DEAGLE = mix(PISTOL, {
  eq: { hi: 5, sub: 0, pf: 500, pg: 3 },
  len: 1.2, crack: { amp: 1, hp: 1300, dur: .006, nw: .0007, sz: .025, szAmp: .4 }, body: { f: 230, dec: .08, amp: 1.05 }, blast: { amp: 1.2, f: 780, q: .9, dec: .055, sweep: 4 },
  thump: { amp: 1.1, f0: 160, f1: 45, dec: .14 }, drive: 3.6, tail: { amp: .48, t60: 1.3 },
  mech: [mech(.02, .12, [[1900, .04, 1], [3300, .03, .7], [5100, .025, .4]])], far: { lp: 1300, t60: 2.5, len: 3.1, crack: .12 },
});

const SHOT = {
  // ---- pistols
  glock: mix(PISTOL, {eq: { hi: 7, sub: -5, pf: 1400, pg: 3 },  crack: { amp: .7, hp: 2300 }, blast: { f: 1650, dec: .02, amp: .8 }, thump: { amp: .33, f0: 270, f1: 115, dec: .038 }, drive: 2.2, tail: { amp: .28 } }),
  usp_s: mix(SUPP, { sup: { thup: { amp: 1, f: 1100, dec: .012 }, pop: { amp: .6, f0: 210, f1: 100, dec: .025 }, pfft: { amp: .28, f: 3800, dec: .01 } },
    mech: [mech(.002, .45, [[3500, .025, 1], [5600, .02, .7], [8400, .015, .5]], .0004), mech(.022, .42, [[2400, .035, 1], [3900, .03, .7], [6100, .025, .4]])] }),
  p2000: mix(PISTOL, {eq: { hi: 6, sub: -4, pf: 1100, pg: 2 },  blast: { f: 1420 }, thump: { amp: .42 } }),
  p250: mix(PISTOL, { eq: { hi: 6, sub: -3, pf: 950, pg: 3 }, blast: { f: 1120, dec: .032, amp: 1 }, thump: { amp: .62, f0: 215, f1: 78, dec: .065 }, crack: { hp: 1600 }, drive: 2.9 }),
  elite: mix(PISTOL, { eq: { hi: 8, sub: -5, pf: 1800, pg: 4 }, blast: { f: 1520, dec: .024 }, thump: { amp: .42 }, crack: { hp: 2050 } }),
  fiveseven: mix(PISTOL, {eq: { hi: 9, sub: -5, pf: 2500, pg: 3 },  crack: { amp: 1, hp: 2700, dur: .003 }, blast: { f: 1950, dec: .022, q: 1.4 }, thump: { amp: .38, f0: 290, f1: 110 },
    mech: [mech(.011, .14, [[3000, .025, 1], [5000, .02, .7], [7600, .018, .4]])] }),
  tec9: mix(PISTOL, {eq: { hi: 6, sub: -4, pf: 1250, pg: 4 },  blast: { f: 1250, q: 2.4, res: 9, dec: .032 }, ring: { amp: .12, modes: [[1450, .06, 1], [2900, .05, .5]] }, thump: { amp: .45 }, drive: 2.8 }),
  cz75a: mix(PISTOL, {eq: { hi: 6, sub: -4, pf: 1000, pg: 2 },  blast: { f: 1350, dec: .027 }, thump: { amp: .5 } }),
  deagle: DEAGLE,
  revolver: mix(DEAGLE, { blast: { f: 680, dec: .065 }, thump: { amp: 1.2, f0: 150, f1: 42, dec: .17 }, ring: { amp: .07, modes: [[980, .12, 1], [2200, .1, .5]] },
    tail: { amp: .52, t60: 1.5 }, mech: [mech(.0, .1, [[2800, .03, 1], [4600, .025, .6]])] }),
  // ---- smgs
  mac10: mix(SMG, {eq: { hi: 6, sub: -4, pf: 1450, pg: 5, pq: 2 },  blast: { f: 1450, q: 2.6, res: 8, dec: .026 }, ring: { amp: .13, modes: [[880, .045, 1], [1760, .035, .5]] }, thump: { amp: .4 }, drive: 3 }),
  mp9: mix(SMG, { eq: { hi: 7, sub: -3, pf: 1250, pg: 4 }, blast: { f: 1500, dec: .026 }, crack: { hp: 2100 }, thump: { amp: .45, f0: 250 }, ring: { amp: .06, modes: [[1650, .04, 1]] } }),
  mp7: mix(SMG, {eq: { hi: 8, sub: -4, pf: 2200, pg: 3 },  blast: { f: 1600 }, crack: { amp: .95, hp: 2500 }, thump: { amp: .45 } }),
  mp5sd: mix(SUPP, { sup: { thup: { amp: 1, f: 850, dec: .015 }, pop: { amp: .65, f0: 180, f1: 80, dec: .03 }, pfft: { amp: .22, f: 3200, dec: .012 } },
    mech: [mech(.004, .4, [[3000, .025, 1], [4900, .02, .7], [7300, .015, .4]], .0004), mech(.02, .36, [[2100, .035, 1], [3500, .03, .7], [5400, .025, .4]])] }),
  ump45: mix(SMG, { eq: { hi: 3, sub: 0, pf: 380, pg: 4, pq: 1 }, body: { f: 220, dec: .06, amp: 1 }, blast: { f: 930, dec: .036, amp: 1.05 }, thump: { amp: .75, f0: 195, f1: 62, dec: .075 }, drive: 3.1, crack: { hp: 1500 } }),
  p90: mix(SMG, {eq: { hi: 9, sub: -5, pf: 2400, pg: 4 },  blast: { f: 2050, q: 1.6, dec: .022 }, crack: { hp: 2800 }, thump: { amp: .38, f0: 300, f1: 110 },
    mech: [mech(.012, .12, [[2900, .025, 1], [4800, .02, .7], [7200, .018, .4]])] }),
  bizon: mix(SMG, { eq: { hi: 7, sub: -4, pf: 1700, pg: 4 }, blast: { f: 1500, dec: .028 }, ring: { amp: .1, modes: [[1100, .05, 1], [2350, .04, .5]] } }),
  // ---- heavy
  nova: SHOTGUN,
  xm1014: mix(SHOTGUN, {eq: { hi: 4, sub: -1, pf: 700, pg: 2 },  blast: { f: 560, dec: .07 }, thump: { amp: 1.15 }, mech: [mech(.03, .12, M_HEAVY, .0008)] }),
  sawedoff: mix(SHOTGUN, {eq: { hi: 2, sub: 0, pf: 300, pg: 3 },  blast: { f: 420, dec: .1, q: .6 }, thump: { amp: 1.4, f0: 120, f1: 34, dec: .22 }, drive: 4.5, crack: { amp: .9, hp: 800 } }),
  mag7: mix(SHOTGUN, {eq: { hi: 5, sub: -1, pf: 900, pg: 3 },  blast: { f: 600, dec: .07 }, thump: { amp: 1.25, f0: 150, dec: .17 }, crack: { amp: 1, hp: 1200 } }),
  m249: mix(RIFLE, {eq: { hi: 4, sub: -1, pf: 600, pg: 3 },  blast: { f: 760, dec: .05 }, thump: { amp: 1, f0: 180, f1: 50, dec: .11 }, crack: { hp: 1400 }, drive: 3.4,
    mech: [mech(.025, .12, M_HEAVY, .0008), mech(.05, .07, [[3600, .02, 1], [5400, .02, .7]])], tail: { amp: .45, t60: 1.2 } }),
  negev: mix(RIFLE, { eq: { hi: 7, sub: -2, pf: 1500, pg: 4 }, blast: { f: 1150, dec: .04 }, thump: { amp: .8, f0: 210, f1: 60, dec: .08 }, drive: 3.3, ring: { amp: .08, modes: [[1250, .05, 1], [2600, .04, .5]] },
    mech: [mech(.02, .12, M_GUN), mech(.042, .12, [[3900, .02, 1], [6100, .02, .7]]), mech(.06, .08, [[4600, .02, 1], [7000, .015, .6]])], tail: { amp: .45, t60: 1.15 } }),
  // ---- rifles
  galilar: mix(RIFLE, {eq: { hi: 5, sub: -1, pf: 700, pg: 3 },  blast: { f: 820, dec: .045 }, thump: { amp: .95, f0: 185, f1: 52, dec: .1 }, crack: { hp: 1400 }, drive: 3.3 }),
  famas: mix(RIFLE, {eq: { hi: 9, sub: -3, pf: 1600, pg: 3 },  blast: { f: 1450, q: 1.3, dec: .03 }, thump: { amp: .65, f0: 250, f1: 75, dec: .07 }, crack: { hp: 2300 }, mech: [mech(.016, .1, mscale(M_GUN, 1.25))] }),
  ak47: mix(RIFLE, {
    eq: { hi: 5, sub: -1, pf: 450, pg: 4, pq: 1 },
    crack: { amp: 1.05, hp: 1150, dur: .007, nw: .0006, sz: .03, szAmp: .42 }, blast: { amp: 1.1, f: 620, q: .9, res: 6, dec: .05, sweep: 7 },
    body: { f: 200, dec: .075, amp: 1.05 },
    thump: { amp: 1.1, f0: 175, f1: 46, dec: .12 }, drive: 3.6, ring: { amp: .07, modes: [[560, .07, 1], [1180, .05, .6], [2350, .04, .3]] },
    mech: [mech(.03, .12, [[1450, .045, 1], [2550, .035, .7], [3800, .03, .5], [5300, .025, .3]], .0008)], tail: { amp: .44, t60: 1.15 },
  }),
  m4a4: mix(RIFLE, {
    eq: { hi: 9, sub: -4, pf: 1100, pg: 3 },
    crack: { amp: 1, hp: 2100, dur: .0045, sz: .02, szAmp: .45 }, blast: { f: 1400, q: 1.2, dec: .032, sweep: 6 }, body: { f: 330, dec: .05, amp: .8 }, thump: { amp: .7, f0: 240, f1: 72, dec: .07 }, drive: 2.8,
    mech: [mech(.018, .1, [[2300, .035, 1], [3900, .03, .7], [5800, .025, .5], [8200, .02, .3]])], tail: { amp: .36, t60: .95 },
  }),
  m4a1_s: mix(SUPP, {
    len: .7, sup: { thup: { amp: 1, f: 1000, dec: .016 }, pop: { amp: .8, f0: 190, f1: 80, dec: .035 }, pfft: { amp: .3, f: 4200, dec: .012 } },
    mech: [mech(.003, .55, [[3200, .03, 1], [5100, .025, .8], [7600, .02, .6], [10200, .015, .4]], .0004),
      mech(.028, .5, [[1800, .05, 1], [2950, .04, .8], [4400, .035, .6], [6400, .03, .4]], .0007), mech(.031, .15, [[6400, .15, 1]], .0003, .3)],
    tail: { amp: .16, t60: .6 },
  }),
  ssg08: mix(RIFLE, {eq: { hi: 9, sub: -2, pf: 2600, pg: 3 },  len: 1.7, crack: { amp: 1.2, hp: 2600, dur: .006, nw: .0006 }, blast: { f: 1300, dec: .04 }, thump: { amp: .75, f0: 220, f1: 60, dec: .09 },
    drive: 3, mech: [], tail: { amp: .5, t60: 1.7 }, far: { lp: 1900, t60: 2.9, len: 3.3, crack: .25 } }),
  sg556: mix(RIFLE, { eq: { hi: 4, sub: 0, pf: 700, pg: 4, pq: 1 }, blast: { f: 900, dec: .042 }, thump: { amp: .9, f0: 190 }, crack: { amp: 1.1, hp: 1700 }, drive: 3.2 }),
  aug: mix(RIFLE, { eq: { hi: 7, sub: -3, pf: 1500, pg: 3 }, blast: { f: 1050, dec: .038 }, thump: { amp: .8 }, crack: { amp: .9, hp: 1800 }, ring: { amp: .04, modes: [[1500, .04, 1]] } }),
  awp: mix(RIFLE, {
    eq: { hi: 7, sub: 1, pf: 350, pg: 3, pq: .8 },
    len: 2.4, crack: { amp: 1.3, hp: 1200, dur: .009, nw: .0009, sz: .04, szAmp: .45 }, body: { f: 185, dec: .12, amp: 1.15 }, blast: { amp: 1.35, f: 560, q: .8, res: 6, dec: .085, sweep: 4.5 },
    thump: { amp: 1.5, f0: 150, f1: 36, dec: .26 }, ring: { amp: .06, modes: [[430, .25, 1], [910, .2, .6], [1650, .15, .3]] }, drive: 4.2,
    mech: [mech(.04, .05, M_HEAVY, .001)], tail: { amp: .62, t60: 2.6, size: 1.6 }, far: { lp: 1300, t60: 3.7, len: 4.4, crack: .2 },
  }),
  g3sg1: mix(RIFLE, {eq: { hi: 5, sub: 0, pf: 650, pg: 3 },  len: 1.4, blast: { f: 700, dec: .06 }, thump: { amp: 1.2, f0: 165, f1: 44, dec: .15 }, crack: { amp: 1.1, hp: 1300 }, drive: 3.8,
    tail: { amp: .5, t60: 1.5 }, mech: [mech(.03, .1, M_HEAVY, .0008)], far: { lp: 1300, t60: 2.9, len: 3.5, crack: .15 } }),
  scar20: mix(RIFLE, {eq: { hi: 6, sub: 0, pf: 800, pg: 3 },  len: 1.4, blast: { f: 780, dec: .055 }, thump: { amp: 1.15, f0: 175, f1: 46, dec: .14 }, crack: { amp: 1.15, hp: 1500 }, drive: 3.7,
    tail: { amp: .5, t60: 1.5 }, mech: [mech(.026, .1, M_GUN, .0008)], far: { lp: 1350, t60: 2.9, len: 3.5, crack: .15 } }),
};
export const SHOT_WEAPONS = [...Object.keys(SHOT), 'taser'];

function gunshot(p, withTail = true) {
  const len = p.len, n = N(len), ps = p.pitch ?? 1;
  const dry = new Float32Array(n);
  if (p.sup) {
    const s = p.sup;
    const th = pink(N(.2)); lp(th, s.thup.f * ps, .8); lp(th, s.thup.f * 1.6 * ps); hp(th, 90); env(th, .0007, s.thup.dec); norm(th, 1); add(dry, th, 0, s.thup.amp);
    const po = osc(N(.25), sw(s.pop.f0 * ps, s.pop.f1 * ps, .012)); env(po, .0009, s.pop.dec); norm(po, 1); add(dry, po, 0, s.pop.amp * .6);
    const pf = white(N(.12)); bp(pf, s.pfft.f, .9); hs(pf, 5000, 6); env(pf, .0004, s.pfft.dec); norm(pf, 1); add(dry, pf, 0, s.pfft.amp * 1.8);
  } else {
    const c = p.crack;
    const cn = white(N(.06)); hp(cn, c.hp * ps, .6); env(cn, .0001, c.dur); norm(cn, 1); add(dry, cn, 0, c.amp * .75);
    nwave(dry, 0, c.amp, c.nw);
    // sizzle: decaying HF crack energy (supersonic snap + its first reflections)
    const sz = white(N((c.sz ?? .02) * 6 + .01)); hp(sz, c.hp * 1.3 * ps, .7); lp(sz, 11000); pk(sz, c.hp * 2.2 * ps, .8, 4);
    env(sz, .0004, (c.sz ?? .02) * SZK); add(dry, norm(sz, 1), 0, c.amp * (c.szAmp ?? .35) * SZA);
    const b = p.blast, f0 = b.f * ps * rr(.97, 1.03), sweep = Math.max(b.sweep, 6);
    const bn = white(N(Math.min(len, b.dec * 9 + .04)));
    filt(bn, 'lp', t => f0 * (b.open ?? 2) * (1 + sweep * Math.exp(-t / .011)), .7);
    pk(bn, f0, b.q, b.res); hp(bn, 60);
    const fast = bn.slice(); env(fast, .0002, b.dec * .3); norm(fast, 1);
    env(bn, .0012, b.dec); norm(bn, 1);
    add(dry, fast, 0, b.amp * .9 * BLASTK); add(dry, bn, 0, b.amp * .75 * BLASTK);
  }
  // low-mid "body" (the punch that survives small speakers)
  const ta = p.thump ? p.thump.amp : .3;
  const bf = (p.body && p.body.f) || (p.sup ? 260 : 100 + .18 * p.blast.f), bd = (p.body && p.body.dec) || (p.sup ? .03 : p.blast.dec * 1.4);
  const ba = (p.body && p.body.amp) ?? (p.sup ? .45 : .5 + .45 * ta);
  const bo = pink(N(Math.min(len, bd * 8 + .03))); bp(bo, bf * ps, .8); lp(bo, bf * 3 * ps); env(bo, .0015, bd); add(dry, norm(bo, 1), 0, ba);
  if (p.thump) { const t = p.thump; const x = osc(N(Math.min(len, t.dec * 5 + .02)), sw(t.f0 * ps, Math.max(50, t.f1 * 1.15) * ps, t.sw ?? .02)); env(x, .0008, t.dec * .7); norm(x, 1); add(dry, x, 0, t.amp * THUMPK); }
  if (p.ring) { const r = modal(strike(.0015), p.ring.modes.map(([f, d, a]) => [f * ps * rr(.98, 1.02), d, a]), N(.6)); norm(r, 1); add(dry, r, 0, p.ring.amp); }
  norm(dry, 1); sat(dry, p.drive ?? 2.5); hp(dry, 28);
  // tonal shaping per weapon: sub shelf, presence/crack shelf, character peak
  const eq = { sub: p.sup ? 0 : -2, hi: p.sup ? 3 : 6, ...(p.eq || {}) };
  if (eq.sub) ls(dry, 90, eq.sub); hs(dry, 1800, eq.hi + (p.sup ? 0 : HI_ADD));
  if (eq.pf) pk(dry, eq.pf, eq.pq ?? 1.2, eq.pg ?? 3);
  norm(dry, 1);
  if (!withTail) return { dry };
  const out = new Float32Array(n);
  add(out, dry);
  for (const m of p.mech || []) {
    const r = modal(strike(m.hard ?? .0006), m.modes.map(([f, d, a]) => [f * rr(.97, 1.03), d, a * rr(.8, 1.2)]), N(m.len ?? .2));
    norm(r, 1); add(out, r, Math.max(0, m.t + rr(-.001, .001)), m.amp * (p.sup ? 1.8 : 1));
  }
  if (p.tail) add(out, closeTail(dry, p.tail, len));
  fadeOut(out, Math.min(.25, len * .3)); hp(out, 25); norm(out, .95);
  return { dry, out };
}
// short outdoor tail: slapbacks off nearby walls + sparse diffuse decay
function closeTail(dry, t, len) {
  const n = N(len);
  const s = new Float32Array(n); s.set(dry.subarray(0, Math.min(n, dry.length)));
  lp(s, t.damp ?? 4000); hp(s, 120);
  const er = echoes(s, [[.036 + rr(0, .01), .5, 3500], [.068 + rr(0, .015), .42, 2800], [.112 + rr(0, .02), .3, 2200], [.165 + rr(0, .03), .22, 1800], [.24 + rr(0, .04), .14, 1500]], n);
  const tl = fdn(diffuse(s), { t60: t.t60, damp: t.damp ?? 3500, size: t.size ?? 1.2, pre: .015, len });
  norm(tl, 1); norm(er, 1);
  const o = new Float32Array(n); add(o, er, 0, t.amp * .55); add(o, tl, 0, t.amp * .5);
  return o;
}
// distant perspective: air absorption, retained crack, stone-street slapbacks, long rolling tail
function farVersion(dry, f) {
  const n = N(f.len), m = Math.min(dry.length, N(1.2), n);
  const low = dry.slice(0, m); lp(low, f.lp * 1.4, .6); lp(low, f.lp * 1.8, .6); ls(low, 160, 3);
  const hi = dry.slice(0, m); hp(hi, 2500); lp(hi, 6000);
  const base = new Float32Array(m); add(base, norm(low, 1), 0, 1); add(base, norm(hi, 1), 0, (f.crack ?? .12) * 2);
  norm(base, 1); sat(base, 1.8);
  const sp = f.space ?? 1;
  const taps = [[.07, .55, 1700], [.13, .45, 1450], [.21, .38, 1250], [.33, .3, 1050], [.48, .22, 900], [.69, .16, 800], [.95, .1, 700], [1.3, .06, 600]]
    .map(([t, g, fc]) => [t * sp * rr(.85, 1.15), g * rr(.8, 1.1), fc]);
  const er = echoes(base, taps, n); norm(er, 1);
  const tl = fdn(diffuse(base), { t60: f.t60, damp: 1500, size: 1.8, pre: .03, len: f.len }); norm(tl, 1);
  const out = new Float32Array(n);
  add(out, base, 0, 1); add(out, er, 0, .55); add(out, tl, 0, f.tailAmt ?? .45);
  fadeOut(out, Math.min(.6, f.len * .3)); hp(out, 30);
  return out;
}
function farShot(w) {
  seed(hashStr(`shot:${w}#0`));
  const p = SHOT[w]; const g = gunshot(p);
  const Lc = loudNorm([g.out], LTARGET.shot, .1);
  const far = farVersion(g.dry, p.far);
  loudNorm([far], Lc - 1.5, .1, .95);
  return far;
}
function taserShot() {
  const n = N(.8), o = new Float32Array(n);
  const sn = white(N(.02)); hp(sn, 2000); env(sn, 0, .002); norm(sn, 1); add(o, sn, 0, 1);
  nwave(o, 0, .7, .0003);
  let t = .004;
  while (t < .45) {
    const s = white(N(.008)); bp(s, rr(2500, 7500), .7); env(s, 0, rr(.0005, .0022)); norm(s, 1);
    add(o, s, t, rr(.35, 1) * (1 - t / .5)); t += rr(.002, .014);
  }
  const bz = osc(N(.5), t => 92 + 14 * Math.sin(TAU * 7 * t), 'sq'); hp(bz, 300); lp(bz, 5000); pk(bz, 1800, 2, 8);
  envPts(bz, [[0, 0], [.01, 1], [.4, .7], [.5, 0]]); norm(bz, 1); add(o, bz, 0, .3);
  const hum = osc(N(.5), 184, 'saw'); lp(hum, 2500); envPts(hum, [[0, 0], [.02, 1], [.42, .6], [.5, 0]]); norm(hum, 1); add(o, hum, 0, .15);
  norm(o, 1); sat(o, 2); hp(o, 120); add(o, closeTail(o, { amp: .2, t60: .6 }, .8));
  return norm(o, .95);
}

// =====================================================================================
//  MOVEMENT
// =====================================================================================
const FOOT = {
  stone: { bodyF: 260, body: 0.7, th: .75, low: .55, lowF: 500, slapF: 1700, slapQ: 1.1, slap: 1, slapDec: .0045, gDen: 1100, gF: 4800, gQ: 1.4, gAmp: .55, gDur: .07, hiss: .06, modes: [[720, .03, 1], [1480, .022, .6], [2950, .016, .4]], mAmp: .3 },
  sand: { bodyF: 200, body: 0.6, th: .55, low: .8, lowF: 350, slapF: 900, slapQ: .8, slap: .35, slapDec: .006, gDen: 5500, gF: 3600, gQ: .7, gAmp: .55, gDur: .14, hiss: .3, modes: null },
  dirt: { bodyF: 220, body: 0.8, th: .9, low: 1, lowF: 420, slapF: 1150, slapQ: .9, slap: .55, slapDec: .006, gDen: 2400, gF: 2300, gQ: .9, gAmp: .45, gDur: .1, hiss: .12, modes: null },
  wood: { bodyF: 180, body: 0.6, th: .8, low: .65, lowF: 600, slapF: 1400, slapQ: 1, slap: .65, slapDec: .005, gDen: 350, gF: 4200, gQ: 1.2, gAmp: .2, gDur: .05, hiss: .04, modes: [[96, .13, 1], [158, .11, .85], [243, .09, .7], [405, .07, .5], [690, .05, .35], [1120, .04, .2]], mAmp: 1.0 },
  metal: { bodyF: 300, body: 0.45, th: .5, low: .4, lowF: 600, slapF: 2100, slapQ: 1, slap: .6, slapDec: .004, gDen: 250, gF: 5000, gQ: 1.2, gAmp: .15, gDur: .04, hiss: .03, modes: [[310, .22, .5], [742, .3, .8], [1225, .33, 1], [1984, .3, .75], [2870, .26, .55], [4110, .2, .4], [5320, .15, .25]], mAmp: .75 },
};
export const SURFACES = Object.keys(FOOT);
function footHit(o, P, t, a, part, sh) {
  add(o, thud(175 * sh, 90 * sh, .016 + .008 * part, .1), t, P.th * a * part * .55);
  const bd = pink(N(.1)); bp(bd, P.bodyF * sh, .9); env(bd, .001, .02); add(o, norm(bd, 1), t, P.body * a);
  const lw = pink(N(.12)); lp(lw, P.lowF * sh); lp(lw, P.lowF * sh); env(lw, .0008, .016); add(o, norm(lw, 1), t, P.low * a);
  const sl = white(N(.05)); bp(sl, P.slapF * sh * rr(.85, 1.15), P.slapQ); env(sl, .0002, P.slapDec); add(o, norm(sl, 1), t, P.slap * a * (part < 1 ? 1.1 : 1));
  const gd = P.gDur * rr(.8, 1.2);
  const g = grains(N(gd + .03), P.gDen, 0, gd, u => Math.pow(1 - u, 1.5)); bp(g, P.gF * rr(.85, 1.15), P.gQ); hp(g, 1200); add(o, norm(g, 1), t + .002, P.gAmp * a);
  if (P.hiss) { const h = white(N(gd + .05)); bp(h, rr(4000, 6500), .8); env(h, .004, gd * .4); add(o, norm(h, 1), t, P.hiss * a); }
  if (P.modes) { const m = modal(strike(.001), P.modes.map(([f, d, am]) => [f * rr(.93, 1.07), d * rr(.8, 1.2), am * rr(.6, 1.3)]), N(.42)); add(o, norm(m, 1), t, P.mAmp * a); }
}
function footstep(surf) {
  const P = FOOT[surf]; const o = zeros(.45);
  const sh = rr(.9, 1.1), toeT = rr(.028, .06);
  footHit(o, P, 0, 1, 1, sh);
  footHit(o, P, toeT, rr(.45, .7), .5, sh);
  if (rnd() < .5) add(o, clack([[rr(3000, 4500), .04, 1], [rr(5500, 7500), .03, .6]], .0004, .1), rr(.03, .12), .07);
  add(o, noiseBurst(.12, 'bp', rr(1200, 2400), .7, .01, .025, 'pink'), toeT * .8, .12);
  norm(o, 1); sat(o, 1.6); hp(o, 40); fadeOut(o, .1);
  return norm(o, .95);
}
function land() {
  const o = zeros(.6);
  add(o, thud(125, 46, .05), 0, 1); add(o, thud(118, 44, .045), .014, .8);
  add(o, noiseBurst(.15, 'lp', 320, .7, .002, .06, 'brown'), 0, .9);
  add(o, noiseBurst(.06, 'bp', 1100, .9, .0003, .007), 0, .6);
  add(o, noiseBurst(.06, 'bp', 1300, .9, .0003, .006), .016, .5);
  const g = grains(N(.15), 2600, 0, .11, u => Math.pow(1 - u, 1.4)); bp(g, 3200, 1); add(o, norm(g, 1), .002, .45);
  for (let k = 0, c = ri(4, 7); k < c; k++) add(o, clack(rnd() < .5 ? M_SMALL : mscale(M_GUN, rr(.9, 1.3)), .0004, .1), rr(.02, .2), rr(.08, .22));
  add(o, noiseBurst(.12, 'bp', 700, .8, .002, .045, 'pink'), .005, .4);
  norm(o, 1); sat(o, 1.8); hp(o, 35); fadeOut(o, .15);
  return norm(o, .95);
}
function jump() {
  const o = zeros(.45);
  add(o, swish(.16, 700, 1700, 1.1), 0, .6);
  for (let k = 0, c = ri(3, 6); k < c; k++) add(o, clack([[rr(2800, 4200), .035, 1], [rr(5000, 7500), .03, .6], [rr(8000, 10000), .02, .3]], .0003, .1), rr(.02, .16), rr(.12, .3));
  const g = grains(N(.08), 1500, 0, .05, u => 1 - u); bp(g, 3500, 1); add(o, norm(g, 1), 0, .25);
  add(o, noiseBurst(.08, 'lp', 400, .7, .002, .02, 'pink'), 0, .35);
  norm(o, 1); sat(o, 1.3); fadeOut(o, .1);
  return norm(o, .95);
}
function crouch() {
  const o = zeros(.45);
  for (let k = 0, c = ri(8, 14); k < c; k++) {
    const t = rr(0, .3); const b = pink(N(.08)); bp(b, rr(1500, 3500), .7); env(b, .005, rr(.012, .03));
    add(o, norm(b, 1), t, Math.sin(Math.PI * t / .32) * rr(.4, 1));
  }
  lp(o, 6500); hp(o, 300); fadeOut(o, .08);
  return norm(o, .95);
}

// =====================================================================================
//  WEAPON HANDLING FOLEY
// =====================================================================================
function foley(len, parts) { const o = zeros(len); for (const [x, t, g] of parts) add(o, x, t, g); norm(o, 1); sat(o, 1.4); hp(o, 60); fadeOut(o, Math.min(.1, len * .2)); return norm(o, .95); }
const handling = {
  deploy: () => foley(.6, [[swish(.18, 600, 1800), 0, .35], [clack(M_GUN, .0008, .15), .13, .55], [clack(M_SMALL, .0004, .1), .2, .3], [clack(M_HEAVY, .001, .15), .32, .6], [thud(200, 100, .015), .32, .25]]),
  reload_magout: () => foley(.45, [[clack(M_SMALL, .0003, .08), 0, .5], [scrape(.1, 3000, 2000, 2.5, .5), .02, .4], [clack(mscale(M_GUN, rr(.7, .9)), .001, .2), .14, .5], [thud(170, 90, .02), .14, .3]]),
  reload_magin: () => foley(.4, [[scrape(.07, 1800, 2800, 2.5, .6), 0, .35], [clack(M_HEAVY, .0012, .18), .085, 1], [thud(150, 70, .03), .085, .5], [clack(M_GUN, .0006, .12), .09, .5], [clack(M_SMALL, .0003, .08), .102, .3]]),
  reload_bolt: () => foley(.6, [[clack(M_SMALL, .0003, .08), 0, .3], [scrape(.145, 1500, 3500, 2, .6), .015, .45], [clack(M_GUN, .0006, .12), .17, .5],
    [clack(M_HEAVY, .0012, .2), .3, 1], [clack(M_GUN, .0006, .15), .302, .8], [clack([[1100, .1, 1], [2300, .08, .5]], .0005, .2), .302, .1], [thud(160, 80, .02), .3, .4]]),
  reload_slide: () => foley(.3, [[clack(mscale(M_GUN, 1.15), .0005, .15), .005, 1], [clack(M_SMALL, .0003, .1), .007, .5], [thud(220, 110, .012), .005, .35], [clack([[2600, .08, 1]], .0003, .15), .008, .08]]),
  shell_insert: () => foley(.25, [[scrape(.05, 1200, 2000, 2, .4), 0, .3], [clack([[2200, .02, 1], [3600, .018, .6]], .001, .08), .05, .8], [thud(200, 100, .02), .05, .5]]),
  pump: () => foley(.5, [[scrape(.07, 1500, 2500, 2, .5), 0, .5], [clack(M_HEAVY, .001, .15), .08, .8], [scrape(.06, 2500, 1500, 2, .5), .17, .5], [clack(M_HEAVY, .0012, .18), .245, 1], [clack(M_GUN, .0006, .12), .247, .6], [thud(150, 75, .02), .245, .4]]),
  bolt_cycle: () => foley(.75, [[clack(M_SMALL, .0003, .08), 0, .5], [scrape(.13, 1200, 2800, 2, .6), .04, .5], [clack(M_GUN, .0007, .14), .18, .7],
    [scrape(.11, 2800, 1500, 2, .6), .3, .45], [clack(M_HEAVY, .0012, .18), .42, 1], [thud(160, 80, .02), .42, .35], [clack(M_SMALL, .0003, .1), .52, .6]]),
  dryfire: () => foley(.15, [[clack([[1500, .02, 1], [2900, .015, .6], [4800, .012, .3]], .0006, .08), 0, 1], [thud(260, 140, .008), 0, .3]]),
  zoom: () => foley(.12, [[clack([[5200, .012, 1], [8400, .01, .6]], .0002, .05), 0, 1], [noiseBurst(.04, 'hp', 6000, .7, .001, .012), 0, .3]]),
  pickup: () => foley(.4, [[swish(.12, 800, 2000), 0, .4], [clack(M_GUN, .0006, .12), .06, .5], [clack(M_SMALL, .0003, .1), .14, .35], [crouch(), .05, .2]]),
  drop: () => foley(.7, [[thud(110, 55, .05), 0, 1], [clack(mscale(M_GUN, .8), .001, .2), 0, .8], [clack(M_HEAVY, .0012, .2), .002, .7],
    [thud(130, 65, .03), .11, .5], [clack(mscale(M_GUN, .85), .0008, .15), .11, .45], [clack(M_SMALL, .0003, .1), .18, .3], [clack(M_GUN, .0006, .12), .26, .22],
    [(() => { const g = grains(N(.2), 2000, 0, .12, u => 1 - u); bp(g, 3500, 1); return norm(g, 1); })(), 0, .25]]),
  inspect: () => foley(.9, [[swish(.3, 500, 1200), 0, .4], [clack(M_SMALL, .0003, .08), .25, .25], [clack(M_GUN, .0005, .1), .55, .25], [swish(.25, 600, 1400), .5, .3]]),
};

function shellDrop() {
  const o = zeros(.75); const b = rr(.9, 1.12);
  const modes = [[2950 * b, .18, 1], [5100 * b, .14, .7], [7450 * b, .12, .5], [9900 * b, .09, .35], [12400 * b, .07, .2]];
  let t = 0, a = 1, gap = rr(.07, .11);
  for (let k = 0, c = ri(3, 5); k < c; k++) {
    add(o, clack(modes, .0002, .3, .02), t, a);
    add(o, noiseBurst(.01, 'hp', 3000, .7, .0001, .0012), t, a * .3);
    t += gap; gap *= rr(.5, .7); a *= rr(.45, .7);
  }
  for (let k = 0; k < 6; k++) { add(o, clack(modes, .0001, .08, .02), t, a * .3); t += rr(.012, .03); a *= .8; }
  fadeOut(o, .05); hp(o, 1500);
  return norm(o, .95);
}

// =====================================================================================
//  KNIFE
// =====================================================================================
function knifeDeploy() {
  const o = zeros(.85);
  const sl = white(N(.3)); filt(sl, 'bp', t => 2500 + 5000 * Math.min(1, t / .2), 5); envPts(sl, [[0, 0], [.05, .6], [.18, 1], [.22, 0]]); add(o, norm(sl, 1), 0, .6);
  add(o, clack([[3100, .5, 1], [4900, .45, .7], [7300, .35, .5], [9800, .25, .3]], .0004, .7, .02), .2, .4);
  add(o, swish(.15, 700, 1500), 0, .25);
  add(o, clack(M_SMALL, .0003, .08), .3, .25);
  fadeOut(o, .1); return norm(o, .95);
}
function knifeSwing() {
  const d = rr(.19, .26); const o = zeros(.4);
  add(o, swish(d, rr(400, 600), rr(1500, 2200), 1.5), 0, 1);
  const h = white(N(d + .02)); filt(h, 'bp', t => 3000 + 2500 * Math.sin(Math.PI * Math.min(1, t / d)), 2); envPts(h, [[0, 0], [d * .5, 1], [d, 0]]); add(o, norm(h, 1), 0, .2);
  hp(o, 150); return norm(o, .95);
}
function squish(len, f0, f1, q, dec) { const x = pink(N(len)); filt(x, 'lp', sw(f0, f1, dec * .5), q); env(x, .001, dec); return norm(x, 1); }
function knifeHitBody() {
  return foley(.4, [[thud(130, 65, .05), 0, .6], [squish(.3, 2500, 350, 2, .06), 0, 1], [noiseBurst(.1, 'bp', 450, .8, .001, .03, 'pink'), 0, .6], [noiseBurst(.05, 'bp', 3000, .8, .001, .01), 0, .2], [noiseBurst(.02, 'hp', 2000, .7, .0001, .002), 0, .3]]);
}
function knifeHitWall() {
  const g = grains(N(.2), 2000, 0, .12, u => Math.pow(1 - u, 2)); bp(g, 4500, 1.2);
  return foley(.6, [[noiseBurst(.02, 'hp', 2000, .7, .0001, .0015), 0, 1], [clack([[2650, .25, 1], [4200, .2, .7], [6600, .15, .4]], .0003, .5, .03), 0, .5],
    [norm(g, 1), .002, .3], [thud(300, 150, .01), 0, .4]]);
}
function knifeStab() {
  const g = grains(N(.1), 6000, 0, .04, u => 1 - u); hp(g, 1500);
  return foley(.6, [[swish(.12, 500, 1600), 0, .3], [thud(100, 45, .09), .08, 1.2], [squish(.4, 2200, 250, 2.5, .09), .08, .9], [norm(g, 1), .08, .3], [noiseBurst(.02, 'hp', 2000, .7, .0001, .002), .08, .35]]);
}

// =====================================================================================
//  DAMAGE
// =====================================================================================
function hitBody() {
  return foley(.3, [[noiseBurst(.02, 'lp', 5000, .7, .0002, .003), 0, .6], [noiseBurst(.12, 'bp', rr(700, 950), .7, .0008, .022, 'pink'), 0, 1],
    [noiseBurst(.12, 'bp', rr(300, 380), .9, .001, .03, 'pink'), 0, .8], [thud(rr(150, 175), 85, .03), 0, .45], [noiseBurst(.05, 'bp', 2600, .8, .001, .012), 0, .3]]);
}
function hitArmor() {
  const f = pink(N(.15)); lp(f, 1600); pk(f, 520, 1.5, 6); env(f, .001, .04);
  const g = grains(N(.05), 5000, 0, .03, u => 1 - u); bp(g, 3000, 1);
  return foley(.35, [[thud(140, 70, .05), 0, .6], [norm(f, 1), 0, 1], [norm(g, 1), 0, .3], [noiseBurst(.03, 'bp', 1100, 2.5, .0005, .012), 0, .45], [noiseBurst(.1, 'bp', 260, 1, .001, .035, 'pink'), 0, .6]]);
}
function helmetDink(v) {
  const s = v ? 1.04 : 1;
  const o = zeros(.85);
  add(o, noiseBurst(.01, 'hp', 2500, .7, .0001, .0012), 0, .6);
  const ring = modal(strike(.0003), [[3050 * s, .42, 1], [3790 * s, .36, .55], [4720 * s, .32, .8], [5980 * s, .26, .45], [7350 * s, .2, .3], [9150 * s, .15, .2], [1850 * s, .2, .25]], N(.85));
  add(o, norm(ring, 1), 0, 1);
  const k = osc(N(.05), 380); env(k, .0005, .015); add(o, norm(k, 1), 0, .25);
  fadeOut(o, .1); return norm(o, .95);
}
function hitHead() {
  const o = zeros(.35);
  nwave(o, 0, 1, .0003);
  add(o, noiseBurst(.02, 'hp', 1500, .7, .0001, .002), 0, .7);
  const g = grains(N(.05), 9000, 0, .03, u => 1 - u); bp(g, 2500, .9); add(o, norm(g, 1), .001, .5);
  add(o, squish(.25, 3000, 250, 3, .08), .002, .8);
  add(o, thud(160, 70, .05), 0, .6);
  norm(o, 1); sat(o, 2.2); fadeOut(o, .05); return norm(o, .95);
}
function hurt() {
  const o = zeros(.45);
  add(o, thud(110, 55, .08), 0, .7); add(o, noiseBurst(.3, 'lp', 300, .7, .003, .09, 'brown'), 0, .6); add(o, noiseBurst(.15, 'bp', 350, .8, .002, .05, 'pink'), 0, .8);
  add(o, noiseBurst(.1, 'bp', 700, .7, .002, .03, 'pink'), 0, .45);
  lp(o, 1800); norm(o, 1); sat(o, 1.5); fadeOut(o, .1); return norm(o, .95);
}
function death() {
  const o = zeros(1.1);
  add(o, swish(.2, 400, 1100), 0, .35);
  add(o, thud(95, 48, .1), .2, .7); add(o, noiseBurst(.3, 'lp', 260, .7, .003, .1, 'brown'), .2, .6); add(o, noiseBurst(.15, 'bp', 400, .8, .002, .05, 'pink'), .2, .7);
  for (let k = 0; k < 6; k++) add(o, clack(rnd() < .5 ? M_SMALL : mscale(M_GUN, rr(.8, 1.2)), .0004, .1), rr(.21, .4), rr(.15, .3));
  add(o, thud(90, 45, .07), .33, .6);
  add(o, clack(mscale(M_GUN, .9), .0008, .18), .42, .5); add(o, clack(M_HEAVY, .001, .15), .43, .35); add(o, clack(M_SMALL, .0003, .1), .5, .3);
  const g = grains(N(.2), 2000, 0, .15, u => 1 - u); bp(g, 3000, 1); add(o, norm(g, 1), .2, .15);
  norm(o, 1); sat(o, 1.5); hp(o, 30); fadeOut(o, .15); return norm(o, .95);
}

// =====================================================================================
//  BULLET IMPACTS / WHIZ
// =====================================================================================
function impact(surf, v) {
  const o = zeros(surf === 'metal' ? 1.0 : .45);
  if (surf === 'stone') {
    add(o, noiseBurst(.02, 'hp', 2200, .7, .0001, .0018), 0, 1); nwave(o, 0, .6, .0002);
    add(o, noiseBurst(.06, 'bp', rr(1500, 2200), 1.2, .0005, .012), 0, .7);
    const g = grains(N(.3), 1800, .01, .22, u => Math.pow(1 - u, 2)); bp(g, 5500, 1.2); add(o, norm(g, 1), 0, .45);
    for (let k = 0, c = ri(4, 7); k < c; k++) { const t = rr(.02, .3); add(o, clack([[rr(1800, 3500), .012, 1], [rr(4000, 7000), .01, .6]], .0003, .05), t, rr(.1, .3) * (1 - t / .35)); }
    add(o, noiseBurst(.2, 'lp', 1200, .7, .004, .07, 'pink'), 0, .35);
  } else if (surf === 'sand') {
    add(o, noiseBurst(.08, 'lp', 900, .7, .0005, .02, 'pink'), 0, 1); add(o, thud(200, 90, .02), 0, .5);
    add(o, noiseBurst(.3, 'bp', 4200, .7, .006, .1), 0, .5);
    const g = grains(N(.25), 6000, 0, .18, u => 1 - u); bp(g, 3500, .6); add(o, norm(g, 1), 0, .4);
  } else if (surf === 'dirt') {
    add(o, thud(190, 85, .03), 0, .9); add(o, noiseBurst(.08, 'lp', 1300, .7, .0005, .025, 'pink'), 0, 1);
    const g = grains(N(.3), 2500, .01, .2, u => 1 - u); bp(g, 2200, .8); add(o, norm(g, 1), 0, .45);
    for (let k = 0; k < 3; k++) add(o, clack([[rr(600, 1200), .02, 1]], .001, .06), rr(.03, .2), .2);
  } else if (surf === 'wood') {
    add(o, noiseBurst(.02, 'hp', 1800, .7, .0001, .002), 0, .8);
    add(o, norm(modal(strike(.0012), [[rr(380, 460), .06, 1], [rr(820, 950), .05, .7], [rr(1400, 1650), .04, .5], [rr(2200, 2600), .03, .35]], N(.3)), 1), 0, 1);
    const g = grains(N(.2), 900, .005, .12, u => 1 - u); bp(g, 3200, 1.5); add(o, norm(g, 1), 0, .5);
  } else { // metal
    add(o, noiseBurst(.02, 'hp', 3000, .7, .0001, .001), 0, .7);
    add(o, norm(modal(strike(.0004), [[rr(1050, 1250), .32, 1], [rr(1750, 1950), .36, .8], [rr(2550, 2750), .32, .75], [rr(3350, 3600), .3, .55], [rr(4700, 5100), .22, .4], [rr(6000, 6400), .16, .25]], N(.9)), 1), 0, .9);
    if (v % 2 === 1) { // ricochet whine
      const f0 = rr(3600, 4600), f1 = rr(1300, 1800), vr = rr(25, 40);
      const wn = osc(N(.6), t => (f1 + (f0 - f1) * Math.exp(-t / .18)) * (1 + .012 * Math.sin(TAU * vr * t)));
      envPts(wn, [[0, 0], [.008, 1], [.15, .6], [.55, 0]]);
      const nz = white(N(.6)); filt(nz, 'bp', t => f1 + (f0 - f1) * Math.exp(-t / .18), 8); envPts(nz, [[0, 0], [.01, 1], [.5, 0]]);
      add(o, norm(wn, 1), .01, .55); add(o, norm(nz, 1), .01, .25);
    }
  }
  norm(o, 1); sat(o, 1.5); hp(o, 60); fadeOut(o, .08); return norm(o, .95);
}
function whiz() {
  const o = zeros(.32);
  nwave(o, 0, .7, .00025); add(o, noiseBurst(.02, 'hp', 2500, .7, .0001, .0015), 0, .5);
  const f = white(N(.3)); const fa = rr(3800, 5200), fb = rr(700, 1100);
  filt(f, 'bp', t => fb + (fa - fb) * Math.exp(-t / .035), 2.2); env(f, .006, .045); add(o, norm(f, 1), .002, 1);
  add(o, noiseBurst(.1, 'lp', 600, .7, .005, .04, 'pink'), 0, .3);
  fadeOut(o, .05); return norm(o, .95);
}

// =====================================================================================
//  GRENADES
// =====================================================================================
function grenadePin() {
  return foley(.45, [[scrape(.04, 5000, 6500, 3, .4), 0, .4], [clack([[3900, .22, 1], [6250, .18, .7], [8600, .12, .4]], .0003, .35, .02), .035, .6], [clack(M_SMALL, .0003, .08), .09, .4]]);
}
function grenadeThrow() {
  return foley(.5, [[swish(.28, 450, 1500, 1.2), 0, 1], [noiseBurst(.15, 'bp', 800, .8, .02, .08, 'pink'), 0, .3], [clack([[4700, .15, 1], [7300, .1, .6]], .0003, .2), .12, .3]]);
}
function grenadeBounce(surf) {
  const o = zeros(.4);
  const ca = { stone: .9, metal: 1, wood: .8, dirt: .55, sand: .35 }[surf];
  add(o, clack(M_CAN(), .0006, .3, .02), 0, ca);
  if (surf === 'stone') { add(o, noiseBurst(.02, 'hp', 2000, .7, .0001, .0015), 0, .6); const g = grains(N(.1), 1500, 0, .06, u => 1 - u); bp(g, 4500, 1); add(o, norm(g, 1), 0, .3); add(o, thud(220, 110, .012), 0, .4); }
  else if (surf === 'sand') { add(o, noiseBurst(.08, 'lp', 700, .7, .0005, .015, 'pink'), 0, .8); add(o, noiseBurst(.15, 'bp', 4000, .7, .004, .05), 0, .3); }
  else if (surf === 'dirt') { add(o, thud(170, 80, .025), 0, .8); add(o, noiseBurst(.06, 'lp', 1000, .7, .0005, .015, 'pink'), 0, .6); }
  else if (surf === 'wood') add(o, norm(modal(strike(.001), [[rr(150, 190), .1, 1], [rr(380, 440), .07, .8], [rr(820, 950), .05, .5], [rr(1500, 1650), .04, .3]], N(.3)), 1), 0, .9);
  else add(o, norm(modal(strike(.0005), [[rr(500, 700), .25, .8], [rr(1300, 1500), .3, 1], [rr(2300, 2500), .25, .7], [rr(3600, 3900), .2, .4]], N(.4)), 1), 0, .8);
  norm(o, 1); sat(o, 1.4); hp(o, 60); fadeOut(o, .06); return norm(o, .95);
}
function explosion(o) {
  const n = N(o.len), dry = new Float32Array(n);
  const c = white(N(.08)); hp(c, 700); env(c, .0001, o.crackDec ?? .007); add(dry, norm(c, 1), 0, o.crack * .8);
  nwave(dry, 0, o.crack, o.nw ?? .0015);
  const B = o.boom, bl = N(Math.min(o.len, B.dec * 7));
  const b = osc(bl, sw(B.f0, B.f1, B.sw ?? .07)); env(b, .002, B.dec); add(dry, norm(b, 1), 0, B.amp);
  const br = brown(bl); lp(br, 180); lp(br, 180); env(br, .003, B.dec * 1.2); add(dry, norm(br, 1), 0, B.amp * .6);
  const Rr = o.roar, rl = N(Math.min(o.len, Rr.dec * 7));
  const r = pink(rl); const rw = white(rl); for (let i = 0; i < rl; i++) r[i] = r[i] * 2.5 + rw[i] * .5;
  filt(r, 'lp', t => Rr.f * (1 + 8 * Math.exp(-t / .05)), .7); hp(r, 50);
  const rf = r.slice(); env(rf, .0003, Rr.dec * .25); env(r, .004, Rr.dec);
  add(dry, norm(rf, 1), 0, Rr.amp * .8); add(dry, norm(r, 1), 0, Rr.amp * .8);
  norm(dry, 1); sat(dry, o.drive); hp(dry, 30); ls(dry, 70, -3); hs(dry, 1500, 5); pk(dry, 300, .8, 3); norm(dry, 1);
  const D = o.debris, deb = new Float32Array(n);
  for (let k = 0; k < D.count; k++) {
    const t = .04 + Math.pow(rnd(), 1.7) * D.dur, big = rnd() < .25;
    const ch = big ? clack([[rr(500, 1100), .03, 1], [rr(1300, 2600), .025, .6], [rr(2800, 4500), .02, .4]], .002, .15, 0)
      : clack([[rr(1800, 4200), .015, 1], [rr(4500, 8000), .01, .5]], .0005, .06, 0);
    add(deb, ch, t, rr(.3, 1) * (big ? 1 : .5) * Math.pow(Math.max(0, 1 - t / (D.dur + .3)), 1.2));
  }
  const pat = grains(n, 1200, .03, D.dur, u => Math.pow(1 - u, 2)); bp(pat, 3500, .7); add(deb, norm(pat, 1), 0, .5);
  lp(deb, 7500); norm(deb, 1);
  const out = new Float32Array(n); add(out, dry);
  add(out, closeTail(dry, { t60: o.tail.t60, amp: o.tail.amp, damp: 2500, size: 1.6 }, o.len));
  add(out, deb, 0, D.amp);
  fadeOut(out, Math.min(.6, o.len * .25)); norm(out, .95);
  return { dry, out };
}
const HE = { len: 3.2, crack: 1, boom: { f0: 110, f1: 44, dec: .32, amp: 1.0 }, roar: { f: 900, dec: .3, amp: 1.2 }, drive: 4, debris: { count: 60, dur: 1.6, amp: .55 }, tail: { t60: 2.4, amp: .55 }, far: { lp: 650, t60: 3.2, len: 4.6, crack: .1 } };
const C4X = { len: 6, crack: 1, nw: .002, boom: { f0: 95, f1: 36, dec: .8, amp: 1.2, sw: .12 }, roar: { f: 650, dec: .7, amp: 1.3 }, drive: 4.5, debris: { count: 130, dur: 3.2, amp: .6 }, tail: { t60: 3.6, amp: .65 }, far: { lp: 500, t60: 4.2, len: 6.5, crack: .08 } };
function explosionFar(o, key) {
  seed(hashStr(key + '#0'));
  const g = explosion(o);
  const Lc = loudNorm([g.out], LTARGET.sfx, .1);
  const far = farVersion(g.dry, o.far);
  loudNorm([far], Lc - 1, .1, .95);
  return far;
}
function flashExplode(far) {
  const n = N(2.2), dry = new Float32Array(n);
  nwave(dry, 0, 1.3, .001); add(dry, noiseBurst(.05, 'hp', 1500, .7, .0001, .006), 0, 1);
  add(dry, noiseBurst(.25, 'bp', 1800, .8, .0005, .035), 0, 1);
  add(dry, thud(140, 60, .07), 0, .6);
  add(dry, clack([[2350, .05, 1], [3700, .04, .6]], .0005, .2), 0, .2);
  norm(dry, 1); sat(dry, 3.5); hp(dry, 40);
  const out = new Float32Array(n); add(out, dry); add(out, closeTail(dry, { t60: 1.6, amp: .55, damp: 5000 }, 2.2));
  fadeOut(out, .4); norm(out, .95);
  if (far) { const Lc = loudNorm([out], LTARGET.sfx, .1); const f = farVersion(dry, { lp: 1600, t60: 2.5, len: 3, crack: .2 }); loudNorm([f], Lc - 1, .1, .95); return f; }
  return out;
}
function flashRing() {
  const L = 4, nz = white(N(L + .5)); bp(nz, 4000, 25); bp(nz, 4000, 25); norm(nz, 1);
  const base = loopify(nz, L);
  const o = new Float32Array(N(L));
  for (let i = 0; i < o.length; i++) { const t = i / SR; o[i] = .55 * Math.sin(TAU * 4000 * t) + .35 * Math.sin(TAU * 4002.5 * t + 1) + .06 * Math.sin(TAU * 8000 * t); }
  add(o, base, 0, .15);
  return norm(o, .9);
}
function smokePop() {
  const o = zeros(1.6);
  add(o, thud(170, 85, .04), 0, 1); add(o, noiseBurst(.02, 'hp', 2000, .7, .0001, .002), 0, .5);
  const g = white(N(1.5)); hp(g, 1500); lp(g, 9000); pk(g, 3500, 1, 5);
  const am = smoothNoise(g.length, 9); for (let i = 0; i < g.length; i++) g[i] *= .75 + .25 * am[i];
  envPts(g, [[0, 0], [.02, 1], [.3, .7], [1.5, 0]]); add(o, norm(g, 1), .005, .8);
  norm(o, 1); sat(o, 1.3); return norm(o, .95);
}
function smokeHiss() {
  const L = 6, n = N(L + 1);
  const h = white(n); hp(h, 1800); lp(h, 10000); pk(h, 3500, 1, 5);
  const am = smoothNoise(n, 4); for (let i = 0; i < n; i++) h[i] *= .8 + .2 * am[i];
  const r = pink(n); lp(r, 400); norm(h, 1); norm(r, 1);
  const o = new Float32Array(n); add(o, h, 0, 1); add(o, r, 0, .2);
  return norm(loopify(o, L), .9);
}
function glassShards(o, t0, count, spread) {
  for (let k = 0; k < count; k++) {
    const t = t0 + Math.pow(rnd(), 2) * spread, f = rr(2500, 8000);
    add(o, clack([[f, rr(.05, .15), 1], [f * rr(1.5, 1.7), rr(.04, .1), .6], [f * rr(2.2, 2.5), rr(.03, .08), .4]], .0002, .2, 0), t, rr(.15, 1) * Math.pow(1 - (t - t0) / (spread + .1), 1.5));
  }
}
function molotovBreak() {
  const o = zeros(2.0);
  add(o, noiseBurst(.02, 'hp', 2000, .7, .0001, .003), 0, 1);
  glassShards(o, 0, 40, .5);
  add(o, noiseBurst(.15, 'hp', 4000, .7, .0005, .05), 0, .5);
  const w = pink(N(1.5)); filt(w, 'bp', t => 200 + 1000 * Math.min(1, t / .4), .9); envPts(w, [[0, 0], [.15, 1], [.5, .6], [1.4, 0]]); add(o, norm(w, 1), .08, .8);
  const r = brown(N(1.6)); lp(r, 300); envPts(r, [[0, 0], [.2, 1], [.8, .5], [1.5, 0]]); add(o, norm(r, 1), .08, .7);
  norm(o, 1); sat(o, 1.5); fadeOut(o, .2); return norm(o, .95);
}
function incendiaryPop() {
  const o = zeros(1.6);
  add(o, noiseBurst(.02, 'hp', 2000, .7, .0001, .002), 0, .8); add(o, thud(200, 100, .03), 0, .7);
  add(o, clack([[1300, .15, 1], [2400, .12, .7], [3700, .1, .5]], .0005, .3), 0, .6);
  const g = grains(N(.8), 300, .05, .6, u => 1 - u); bp(g, 4000, 1); add(o, norm(g, 1), 0, .5);
  const fz = white(N(.8)); hp(fz, 3000); envPts(fz, [[0, 0], [.05, 1], [.6, 0]]); add(o, norm(fz, 1), 0, .3);
  const w = pink(N(1.3)); filt(w, 'bp', t => 250 + 900 * Math.min(1, t / .35), .9); envPts(w, [[0, 0], [.15, 1], [.5, .6], [1.2, 0]]); add(o, norm(w, 1), .1, .8);
  norm(o, 1); sat(o, 1.5); fadeOut(o, .2); return norm(o, .95);
}
function fireLoop() {
  const L = 6, n = N(L + 1), o = new Float32Array(n);
  const roar = brown(n); lp(roar, 380); const am = smoothNoise(n, .7); for (let i = 0; i < n; i++) roar[i] *= .75 + .25 * am[i]; add(o, norm(roar, 1), 0, .55);
  const fl = pink(n); bp(fl, 850, .7); const am2 = smoothNoise(n, 6); for (let i = 0; i < n; i++) fl[i] *= Math.max(0, .5 + .5 * am2[i]); add(o, norm(fl, 1), 0, .35);
  const hs = white(n); hp(hs, 3000); lp(hs, 9000); const am3 = smoothNoise(n, 3); for (let i = 0; i < n; i++) hs[i] *= .6 + .4 * am3[i]; add(o, norm(hs, 1), 0, .1);
  let t = 0;
  while (t < L + 1) {
    t += -Math.log(1 - rnd()) / 30; const big = rnd() < .12;
    const c = white(N(.03)); bp(c, big ? rr(500, 1600) : rr(2000, 6000), big ? 1.2 : .9); env(c, .0001, big ? rr(.004, .012) : rr(.0008, .004));
    add(o, norm(c, 1), t, (big ? rr(.5, 1) : rr(.1, .6)) * Math.sqrt(rnd()));
  }
  return norm(loopify(o, L), .9);
}
function fireExtinguish() {
  const o = zeros(1.8);
  const h = white(N(1.7)); filt(h, 'hp', t => 2500 + 1500 * Math.min(1, t), .7); pk(h, 5000, 1, 6); envPts(h, [[0, 0], [.03, 1], [.4, .6], [1.6, 0]]); add(o, norm(h, 1), 0, .8);
  const g = grains(N(1.5), 400, 0, 1.2, u => Math.pow(1 - u, 2)); bp(g, 3000, 1); add(o, norm(g, 1), 0, .5);
  add(o, swish(.4, 200, 800, .8), 0, .5);
  fadeOut(o, .2); return norm(o, .95);
}

// =====================================================================================
//  C4 / DEFUSE
// =====================================================================================
function beep(f, dur, o = {}) {
  const n = N(dur + .03); const x = osc(n, f, o.wave ?? 'sq'); lp(x, o.lp ?? 6000); lp(x, (o.lp ?? 6000) * 1.4);
  if (o.res !== false) pk(x, f, 2, 6);
  envPts(x, [[0, 0], [.002, 1], [dur * .85, .85], [dur, 0]]);
  return norm(x, 1);
}
function c4Key(v) {
  const f = [1480, 1570, 1660, 1760, 1860][v % 5];
  const o = zeros(.16); add(o, clack([[3000, .015, 1], [5200, .012, .5]], .0003, .04), 0, .35); add(o, beep(f, .085, { wave: 'tri', lp: 5000 }), .004, .8);
  return norm(o, .95);
}
function c4Planted() {
  const o = zeros(.8);
  add(o, thud(160, 80, .03), 0, .6); add(o, clack(M_HEAVY, .001, .1), 0, .4);
  [[1600, .06, .08], [1800, .06, .16], [2000, .06, .24], [2000, .18, .36]].forEach(([f, d, t]) => add(o, beep(f, d), t, .8));
  return norm(o, .95);
}
function c4Beep() {
  const o = zeros(.2); const x = beep(1960, .11, { lp: 7000 });
  const s = osc(N(.14), 3920); envPts(s, [[0, 0], [.002, 1], [.09, .85], [.11, 0]]);
  add(o, x, 0, 1); add(o, s, 0, .15); add(o, noiseBurst(.005, 'hp', 3000, .7, .0001, .0008), 0, .2);
  return norm(o, .95);
}
function defuseStart() {
  return foley(.75, [[crouch(), 0, .5], [clack([[1800, .03, 1], [3200, .025, .6]], .0008, .08), .2, .5], [clack(M_SMALL, .0003, .06), .25, .4], [scrape(.2, 5500, 7000, 4, .5), .3, .45]]);
}
function defuseTick() { const o = zeros(.07); add(o, clack([[2200, .015, 1], [4100, .01, .4]], .0003, .05), 0, 1); return norm(o, .95); }
function defuseDone() {
  const o = zeros(.7);
  add(o, noiseBurst(.02, 'hp', 3500, .7, .0001, .0015), 0, .7); add(o, clack([[4300, .04, 1], [6900, .03, .6], [9600, .02, .4]], .0002, .1), 0, .6);
  add(o, beep(1500, .12, { wave: 'tri' }), .08, .7); add(o, beep(1000, .22, { wave: 'tri' }), .22, .7);
  return norm(o, .95);
}
function c4Pickup() { return foley(.45, [[crouch(), 0, .5], [clack([[700, .03, 1], [1500, .025, .6]], .002, .1), .05, .7], [beep(2400, .04, { wave: 'tri' }), .2, .25]]); }
function kitPickup() {
  const z = new Float32Array(N(.3)); for (let t = 0, f = 80; t < .25; t += 1 / f, f *= 1.012) add(z, noiseBurst(.004, 'bp', 3000, 1.5, .0001, .0008), t, rr(.5, 1));
  return foley(.5, [[norm(z, 1), 0, .6], [crouch(), 0, .3], [clack([[3200, .06, 1], [5000, .05, .6]], .0003, .15), .3, .5]]);
}

// =====================================================================================
//  UI
// =====================================================================================
function uiClick() { const o = zeros(.05); const s = osc(N(.03), 1800); env(s, .0003, .006); add(o, norm(s, 1), 0, 1); add(o, noiseBurst(.01, 'hp', 3000, .7, .0001, .0015), 0, .3); return norm(o, .95); }
function uiHover() { const o = zeros(.04); const s = osc(N(.03), 2600); env(s, .0005, .005); add(o, norm(s, 1), 0, 1); return norm(o, .95); }
function bellTone(f, dur, bright = 1) {
  const n = N(dur); const o = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; const I = 2.2 * bright * Math.exp(-t / .12); o[i] = Math.sin(TAU * f * t + I * Math.sin(TAU * 3.5 * f * t)) * Math.exp(-t / (dur * .3)) + .25 * Math.sin(TAU * f * 2.76 * t) * Math.exp(-t / (dur * .12)); }
  fadeIn(o, .002); return norm(o, 1);
}
function buy() { const o = zeros(.4); add(o, clack(M_SMALL, .0003, .06), 0, .4); add(o, bellTone(1318.5, .3), .03, .6); add(o, bellTone(1975.5, .3), .09, .6); fadeOut(o, .05); return norm(o, .95); }
function buyDeny() { const o = zeros(.26); const b = osc(N(.09), 160, 'sq'); lp(b, 1200); envPts(b, [[0, 0], [.004, 1], [.07, 1], [.085, 0]]); norm(b, 1); add(o, b, 0, 1); add(o, b, .12, 1); return norm(o, .95); }
function money() {
  const o = zeros(.65);
  for (let k = 0; k < 4; k++) add(o, clack([[rr(4000, 8000), .08, 1], [rr(9000, 11000), .05, .5]], .0002, .15), rr(0, .08), rr(.2, .4));
  add(o, norm(modal(strike(.0003), [[2637, .45, 1], [3950, .35, .6], [5274, .3, .5], [7100, .2, .3]], N(.6)), 1), .05, .8);
  fadeOut(o, .05); return norm(o, .95);
}
function radio() {
  const o = zeros(.16); add(o, clack([[2500, .01, 1]], .0003, .02), 0, .5);
  const s = white(N(.1)); bp(s, 1800, 1); envPts(s, [[0, 0], [.004, 1], [.06, .8], [.09, 0]]);
  const g = grains(N(.1), 2000, 0, .09); bp(g, 2500, 1); add(o, norm(s, 1), .005, .7); add(o, norm(g, 1), .005, .5);
  return norm(o, .95);
}
function tenSeconds() { const o = zeros(.14); add(o, beep(1046.5, .05, { wave: 'tri', res: false }), 0, 1); add(o, clack([[3500, .01, 1]], .0003, .03), 0, .3); return norm(o, .95); }

// =====================================================================================
//  MUSIC (original compositions)
// =====================================================================================
const NOTE_IDX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midi(s) { const m = /^([A-G])([#b]?)(-?\d)$/.exec(s); return NOTE_IDX[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12 * (+m[3] + 1); }
const hz = s => typeof s === 'number' ? s : 440 * Math.pow(2, (midi(s) - 69) / 12);

const _memo = [];
function memo(fn) { const c = new Map(); _memo.push(c); return (...a) => { const k = a.join(','); let v = c.get(k); if (!v) { v = fn(...a); c.set(k, v); } return v; }; }
function _iKick() { const x = osc(N(.6), sw(150, 46, .035)); env(x, .0015, .19); const c = white(N(.02)); hp(c, 3000); env(c, .0001, .003); add(x, norm(c, 1), 0, .4); norm(x, 1); return sat(x, 2); }
function _iSnare() {
  const n = N(.45), x = new Float32Array(n);
  const b = osc(N(.3), sw(280, 185, .015)); env(b, .001, .07); const nz = white(n); hp(nz, 1500); lp(nz, 10000); env(nz, .0008, .13);
  add(x, norm(b, 1), 0, .6); add(x, norm(nz, 1), 0, .8); norm(x, 1); return sat(x, 1.6);
}
function _iHat(open) { const x = white(N(open ? .5 : .12)); hp(x, 7000); pk(x, 10500, 1, 6); env(x, .0005, open ? .15 : .022); return norm(x, 1); }
function _iCrash() { const x = white(N(3)); hp(x, 3500); filt(x, 'lp', t => 4000 + 12000 * Math.exp(-t / 1.2)); env(x, .002, .9); return norm(x, 1); }
function _iTaiko(f = 58, dec = .55) {
  const x = osc(N(dec * 5), sw(f * 2, f, .04)); env(x, .002, dec); norm(x, 1);
  const sk = pink(N(.3)); lp(sk, 700); env(sk, .001, .06); const sl = white(N(.05)); bp(sl, 1500, 1); env(sl, .0005, .012);
  add(x, norm(sk, 1), 0, .6); add(x, norm(sl, 1), 0, .25); norm(x, 1); return sat(x, 1.8);
}
function _iBoom(dec = 1) { const x = osc(N(dec * 4), sw(85, 28, .2)); env(x, .003, dec); norm(x, 1); const b = brown(x.length); lp(b, 140); env(b, .01, dec); add(x, norm(b, 1), 0, .6); norm(x, 1); return sat(x, 2); }
function iRiser(dur) {
  const n = N(dur + .05), x = pink(n); filt(x, 'bp', t => 300 * Math.pow(20, Math.min(1, t / dur)), 2);
  for (let i = 0; i < n; i++) { const u = Math.min(1, i / (dur * SR)); x[i] *= u * u * (i > dur * SR ? 0 : 1); }
  const s = osc(n, t => 200 * Math.pow(6, Math.min(1, t / dur)), 'saw'); lp(s, 3000); for (let i = 0; i < n; i++) { const u = Math.min(1, i / (dur * SR)); s[i] *= u * u * u * (i > dur * SR ? 0 : 1); }
  norm(x, 1); add(x, norm(s, 1), 0, .2); return norm(x, 1);
}
function _iRevCym(dur) { const n = N(dur), x = white(n); hp(x, 4000); for (let i = 0; i < n; i++) x[i] *= Math.pow(i / n, 3); return norm(x, 1); }
function iSaw(f, dur, o) {
  const rel = o.rel ?? .2, n = N(dur + rel), x = new Float32Array(n), det = o.det ?? [-8, 0, 8];
  for (const d of det) {
    const fr = f * Math.pow(2, d / 1200);
    const v = osc(n, o.vib ? (t => fr * (1 + o.vib * Math.sin(TAU * 5.5 * t) * Math.min(1, t / .3))) : fr, o.wave ?? 'saw', rnd());
    add(x, v, 0, 1 / det.length);
  }
  if (o.sub) add(x, osc(n, f / 2), 0, o.sub);
  filt(x, 'lp', o.cut, o.q ?? .9);
  adsr(x, o.att ?? .01, o.dec ?? .2, o.sus ?? .7, dur, rel);
  return x;
}
function iBrass(f, dur) { const x = iSaw(f, dur, { det: [-6, 0, 7], att: .035, dec: .3, sus: .75, rel: .25, q: 1.1, vib: .004, cut: t => 350 + 2600 * (t < .05 ? t / .05 : .55 + .45 * Math.exp(-(t - .05) / .2)) }); norm(x, 1); return sat(x, 1.5); }
function iLead(f, dur) { const x = iSaw(f, dur, { det: [-4, 4], att: .02, dec: .2, sus: .8, rel: .2, q: 1.3, vib: .006, cut: t => 800 + 3200 * (t < .04 ? t / .04 : .5 + .5 * Math.exp(-(t - .04) / .25)) }); norm(x, 1); return sat(x, 1.3); }
function iPad(f, dur) { return norm(iSaw(f, dur, { det: [-12, -5, 0, 5, 12], att: .6, dec: .5, sus: .85, rel: 1.0, q: .7, cut: t => 900 + 300 * Math.sin(TAU * .3 * t) }), 1); }
function iStr(f, dur) { return norm(iSaw(f, dur, { det: [-7, 0, 7], att: .25, dec: .3, sus: .9, rel: .5, q: .8, vib: .005, cut: 1800 }), 1); }
function _iPluck(f) { return norm(iSaw(f, .12, { det: [-4, 4], att: .003, dec: .1, sus: 0, rel: .08, q: 1.5, cut: t => 500 + 3500 * Math.exp(-t / .05) }), 1); }
function _iBass(f, dur, drive = 2) { const x = iSaw(f, dur, { det: [0], sub: .8, att: .004, dec: .15, sus: .6, rel: .06, q: 1.4, cut: t => 180 + 1400 * Math.exp(-t / .06) }); norm(x, 1); return sat(x, drive); }
function _iBell(f, dur = 1.5) { return bellTone(f, dur, .8); }

const iKick = memo(_iKick), iSnare = memo(_iSnare), iHat = memo(_iHat), iCrash = memo(_iCrash), iTaiko = memo(_iTaiko), iBoom = memo(_iBoom), iPluck = memo(_iPluck), iBass = memo(_iBass), iBell = memo(_iBell), iRevCym = memo(_iRevCym);
function song(sec) { return { L: new Float32Array(N(sec)), R: new Float32Array(N(sec)), sec }; }
function put(S, x, t, g = 1, pan = 0) { const a = (pan + 1) * Math.PI / 4; add(S.L, x, t, g * Math.cos(a) * Math.SQRT2); add(S.R, x, t, g * Math.sin(a) * Math.SQRT2); }
function chord(S, fn, notes, t, dur, g, spread = .5) { const k = notes.length; notes.forEach((nm, j) => put(S, fn(hz(nm), dur), t, g / Math.sqrt(k), k > 1 ? (j / (k - 1) - .5) * 2 * spread : 0)); }
function finish(S, o = {}, loop = false) {
  const n = S.L.length, mono = new Float32Array(n); for (let i = 0; i < n; i++) mono[i] = (S.L[i] + S.R[i]) * .5;
  const [rl, rrv] = fdn(diffuse(mono), { t60: o.t60 ?? 1.6, stereo: true, len: S.sec, damp: o.damp ?? 5000, size: 1.4, pre: .02 });
  const k = (o.wet ?? .22) * peakOf(mono) / Math.max(1e-6, Math.max(peakOf(rl), peakOf(rrv)));
  add(S.L, rl, 0, k); add(S.R, rrv, 0, k);
  hp(S.L, 30); hp(S.R, 30);
  const p = Math.max(peakOf(S.L), peakOf(S.R)); scale(S.L, 1 / p); scale(S.R, 1 / p);
  sat(S.L, 1.2); sat(S.R, 1.2);
  if (!loop) { fadeOut(S.L, o.fade ?? .4); fadeOut(S.R, o.fade ?? .4); }
  const p2 = Math.max(peakOf(S.L), peakOf(S.R)); scale(S.L, .9 / p2); scale(S.R, .9 / p2);
  return [S.L, S.R];
}
function loopSong(cyc, sched, rv) {
  const S = song(cyc * 2); sched(S, 0); sched(S, cyc);
  const [L, R] = finish(S, rv, true); const a = N(cyc);
  return [L.slice(a, a * 2), R.slice(a, a * 2)];
}
function melody(S, inst, notes, t0, beat, g, pan = 0) { for (const [b, d, nm] of notes) put(S, inst(hz(nm), d * beat * .95), t0 + b * beat, g, pan); }

function mRoundStart() {
  const S = song(4.2), b = 60 / 140, s16 = b / 4;
  put(S, iBoom(1.0), 0, .55); put(S, iTaiko(55, .7), 0, .9); chord(S, iBrass, ['D3', 'A3'], 0, .35, .45);
  const seq = ['D3', 'D3', 'F3', 'D3', 'E3', 'D3', 'A3', 'D3', 'D3', 'D3', 'F3', 'D3', 'G3', 'D3', 'A3', 'Bb3'];
  for (let i = 0; i < 22; i++) { const t = b * .5 + i * s16, f = hz(seq[i % 16]); put(S, iPluck(f), t, .12 + .35 * i / 22, i % 2 ? .35 : -.35); put(S, iPluck(f * 2), t, .05 + .15 * i / 22, i % 2 ? -.5 : .5); }
  for (let i = 1; i < 11; i++) put(S, iHat(false), i * b / 2, .12 + .1 * (i / 11), .3);
  [b * 2, b * 3, b * 4, b * 4.5, b * 5, b * 5.25, b * 5.5, b * 5.75].forEach((t, i) => put(S, iTaiko(i < 3 ? 62 : 70, .4), t, .5 + i * .06, i % 2 ? .2 : -.2));
  for (let t = b * 4; t < b * 6 - .01; t += s16 / 2) put(S, iSnare(), t, .05 + .4 * (t - b * 4) / (b * 2), 0);
  put(S, iRiser(b * 6 - .4), .4, .35);
  const T = b * 6;
  put(S, iBoom(1.4), T, .9); put(S, iTaiko(50, .9), T, 1); put(S, iKick(), T, .7); put(S, iCrash(), T, .45, .1);
  chord(S, iBrass, ['D3', 'A3', 'D4', 'F4'], T, .9, .8); put(S, iBass(hz('D2'), 1.0, 2.5), T, .55);
  return finish(S, { t60: 1.8, wet: .25 });
}
function mWin(team) {
  const S = song(5.4), b = .5, T0 = b;
  for (let t = 0; t < b - .01; t += b / 8) put(S, iSnare(), t, .06 + .3 * t / b);
  put(S, iCrash(), T0, .4, -.2); put(S, iKick(), T0, .8);
  let chords, bass, mel;
  if (team === 'ct') {
    chords = [[0, 2, ['D3', 'F#3', 'A3', 'D4']], [2, 1, ['G3', 'B3', 'D4']], [3, 1, ['A3', 'C#4', 'E4']], [4, 3.4, ['D3', 'F#3', 'A3', 'D4', 'F#4']]];
    bass = [[0, 2, 'D2'], [2, 1, 'G2'], [3, 1, 'A2'], [4, 3, 'D2']];
    mel = [[0, .5, 'A4'], [.5, .5, 'D5'], [1, .5, 'E5'], [1.5, 1, 'F#5'], [2.5, .5, 'E5'], [3, .5, 'D5'], [3.5, .5, 'E5'], [4, 3, 'F#5']];
    for (let t = 0; t < 4; t += .25) put(S, iSnare(), T0 + t * b, (t % 1 === 0 ? .35 : .12), .1);
    [0, 2, 3, 4].forEach(k => put(S, iTaiko(k === 2 ? 49 : k === 3 ? 55 : 73, .5), T0 + k * b, .7));
  } else {
    chords = [[0, 2, ['D3', 'F3', 'A3']], [2, 1, ['Bb2', 'D3', 'F3']], [3, 1, ['C3', 'E3', 'G3']], [4, 3.4, ['D3', 'A3', 'D4']]];
    bass = []; for (let k = 0; k < 8; k++) bass.push([k * .5, .5, k < 4 ? 'D2' : k < 6 ? 'Bb1' : 'C2']); bass.push([4, 3, 'D2']);
    mel = [[0, .5, 'D4'], [.5, .5, 'F4'], [1, .5, 'G4'], [1.5, 1, 'A4'], [2.5, .5, 'Bb4'], [3, .5, 'C5'], [3.5, .5, 'C#5'], [4, 3, 'D5']];
    for (let k = 0; k < 4; k++) { put(S, iKick(), T0 + k * b, .7); if (k % 2) put(S, iSnare(), T0 + k * b, .45); }
    [0, .75, 1.5, 2, 2.5, 3, 3.25, 3.5, 3.75].forEach((t, i) => put(S, iTaiko(i % 2 ? 82 : 62, .35), T0 + t * b, .45 + i * .03, i % 2 ? .3 : -.3));
  }
  for (const [s, d, ns] of chords) chord(S, iBrass, ns, T0 + s * b, d * b * .95, .55);
  for (const [s, d, nm] of bass) put(S, iBass(hz(nm), d * b * .9, team === 't' ? 4 : 2), T0 + s * b, .4);
  melody(S, iLead, mel, T0, b, .45); melody(S, iPluck, mel.map(([s, d, n]) => [s, d, n]), T0, b, .12, .3);
  const TF = T0 + 4 * b; put(S, iCrash(), TF, .5, .2); put(S, iBoom(1.2), TF, .6); put(S, iTaiko(55, .8), TF, .8); put(S, iKick(), TF, .6);
  if (team === 'ct') put(S, iBell(hz('D6'), 2), TF, .12, .4);
  return finish(S, { t60: 2.0, wet: .26 });
}
function mRoundLose() {
  const S = song(6.2);
  chord(S, iPad, ['A2', 'E3', 'A3', 'C4'], 0, 1.7, .5); chord(S, iPad, ['F2', 'C3', 'F3', 'A3'], 1.7, 1.7, .5); chord(S, iPad, ['D2', 'A2', 'F3', 'E4'], 3.4, 2, .5);
  [[.2, 'E5'], [.9, 'D5'], [1.7, 'C5'], [2.4, 'B4'], [3.4, 'A4']].forEach(([t, n], i) => put(S, iBell(hz(n), i === 4 ? 2.5 : 1.2), t, .25, (i % 2 ? .3 : -.3)));
  put(S, iTaiko(50, .8), 0, .4); put(S, iTaiko(46, 1.0), 3.4, .45);
  put(S, iStr(hz('A1'), 5.2), 0, .25);
  return finish(S, { t60: 2.6, wet: .35, fade: 1.2 });
}
function mMvp() {
  const b = 60 / 128, S = song(7.0);
  put(S, iCrash(), 0, .4, -.2);
  for (let k = 0; k < 8; k++) { put(S, iKick(), k * b, .75); if (k % 2) put(S, iSnare(), k * b, .5); put(S, iHat(false), k * b + b / 2, .15, .3); put(S, iHat(false), k * b, .1, .3); }
  for (let t = 6.5; t < 8; t += .25) put(S, iSnare(), t * b, .1 + .25 * (t - 6.5) / 1.5, -.1);
  const ch = [[0, ['E3', 'G3', 'B3'], 'E2'], [2, ['C3', 'E3', 'G3'], 'C2'], [4, ['G2', 'B2', 'D3', 'G3'], 'G1'], [6, ['D3', 'F#3', 'A3'], 'D2']];
  for (const [s, ns, bn] of ch) { chord(S, iBrass, ns, s * b, 2 * b * .95, .45); for (let k = 0; k < 4; k++) put(S, iBass(hz(bn), b * .45, 2.5), (s + k * .5) * b, .38); }
  const mel = [[0, 1, 'E4'], [1, .5, 'G4'], [1.5, .5, 'B4'], [2, 1, 'C5'], [3, .5, 'B4'], [3.5, .5, 'A4'], [4, 1.5, 'B4'], [5.5, .5, 'G4'], [6, 1, 'A4'], [7, .5, 'F#4'], [7.5, .5, 'D4']];
  melody(S, iLead, mel, 0, b, .45); melody(S, iPluck, mel.map(([s, d, n]) => [s, d, n]), 0, b, .1, .3);
  const TF = 8 * b;
  put(S, iCrash(), TF, .5, .2); put(S, iBoom(1.3), TF, .6); put(S, iTaiko(41, .9), TF, .8); put(S, iKick(), TF, .7);
  chord(S, iBrass, ['E3', 'B3', 'E4', 'G#4'], TF, 2.2, .6); put(S, iLead(hz('E5'), 2.2), TF, .35); put(S, iBass(hz('E2'), 2.0, 2), TF, .45);
  put(S, iBell(hz('B5'), 2.2), TF, .12, .4);
  return finish(S, { t60: 2.0, wet: .26, fade: .8 });
}
function mMatchWin() {
  const b = .5, S = song(8.0), T0 = 1.0;
  put(S, iRiser(T0), 0, .35); for (let t = .3; t < T0 - .01; t += b / 8) put(S, iSnare(), t, .05 + .3 * (t - .3) / .7);
  const ch = [[0, ['D3', 'F#3', 'A3', 'D4']], [2, ['Bb2', 'D3', 'F3', 'Bb3']], [4, ['C3', 'E3', 'G3', 'C4']]];
  for (const [s, ns] of ch) { chord(S, iBrass, ns, T0 + s * b, 2 * b * .95, .5); put(S, iTaiko(ns[0] === 'D3' ? 73 : ns[0] === 'Bb2' ? 58 : 65, .5), T0 + s * b, .7); put(S, iBass(hz(ns[0]) / 2, 2 * b * .9, 2), T0 + s * b, .4); }
  for (let k = 0; k < 6; k++) { put(S, iKick(), T0 + k * b, .6); if (k % 2) put(S, iSnare(), T0 + k * b, .4); }
  put(S, iCrash(), T0, .4, -.2);
  const mel = [[0, 1, 'D5'], [1, 1, 'A4'], [2, 1, 'Bb4'], [3, 1, 'F5'], [4, 1.5, 'E5'], [5.5, .5, 'C5'], [6, 4, 'D5']];
  melody(S, iLead, mel, T0, b, .45); melody(S, iStr, mel.map(([s, d, n]) => [s, d, n]), T0, b, .15, -.3);
  const TF = T0 + 6 * b;
  put(S, iCrash(), TF, .55, .2); put(S, iBoom(1.5), TF, .7); put(S, iTaiko(55, 1), TF, .9); put(S, iKick(), TF, .7);
  chord(S, iBrass, ['D3', 'A3', 'D4', 'F#4', 'A4'], TF, 2.6, .65); chord(S, iStr, ['D4', 'F#4', 'A4', 'D5'], TF, 2.8, .3); put(S, iBass(hz('D2'), 2.6, 2), TF, .45);
  [['D6', 0], ['A5', .25], ['F#5', .5], ['D5', .75]].forEach(([n, t]) => put(S, iBell(hz(n), 1.8), TF + t, .12, .4 - t));
  return finish(S, { t60: 2.2, wet: .28, fade: 1.0 });
}
function mMatchLose() {
  const S = song(7.5), b = .75;
  const ch = [['D2', 'A2', 'F3', 'A3'], ['Bb1', 'F2', 'D3', 'F3'], ['G1', 'D2', 'Bb2', 'D3'], ['A1', 'E2', 'D3', 'E3']];
  ch.forEach((ns, k) => { chord(S, iPad, ns, k * 2 * b, 2 * b, .45); chord(S, iStr, ns.slice(0, 2), k * 2 * b, 2 * b, .3); });
  chord(S, iPad, ['D2', 'A2', 'D3', 'F3'], 8 * b, 1.6, .45);
  [['A4', 0], ['G4', 2], ['F4', 4], ['E4', 6], ['D4', 8]].forEach(([n, k], i) => put(S, iBell(hz(n), 1.8), k * b + .1, .22, i % 2 ? .3 : -.3));
  put(S, iTaiko(46, 1.0), 0, .45); put(S, iTaiko(41, 1.2), 8 * b, .5); put(S, iBoom(1.5), 8 * b, .3);
  return finish(S, { t60: 2.8, wet: .35, fade: 1.5 });
}
function mBombLoop() {
  const b = .5;
  return loopSong(8, (S, o) => {
    for (let k = 0; k < 16; k++) {
      const t = o + k * b;
      if (k % 2 === 0) put(S, iKick(), t, .6);
      for (let h = 0; h < 4; h++) put(S, iHat(false), t + h * b / 4, h === 2 ? .12 : .06, .35);
      put(S, iPluck(hz('A5')), t, .08, -.4);
      for (let e = 0; e < 2; e++) put(S, iBass(hz(k >= 12 ? 'Eb2' : 'D2'), b * .42, 2.5), t + e * b / 2, e ? .28 : .4);
    }
    chord(S, iPad, ['D3', 'A3'], o, 8, .3);
    put(S, iPad(hz('Eb4'), 4), o + 4, .12, .3);
    put(S, iTaiko(55, .5), o + 7, .5); put(S, iTaiko(62, .5), o + 7.5, .55);
    put(S, iRevCym(1.0), o + 7, .2);
  }, { t60: 1.6, wet: .22 });
}
function mBombFinal() {
  const b = .5, s16 = b / 4;
  return loopSong(4, (S, o) => {
    for (let k = 0; k < 8; k++) { const t = o + k * b; put(S, iKick(), t, .7); if (k % 2) put(S, iSnare(), t, .4); }
    for (let k = 0; k < 32; k++) {
      const t = o + k * s16;
      put(S, iHat(false), t, k % 4 === 2 ? .14 : .08, .35);
      put(S, iBass(hz(k % 8 === 6 ? 'D3' : 'D2'), s16 * .8, 3), t, .32);
      put(S, iPluck(hz(k % 2 ? 'Eb5' : 'D5')), t, .1 + .05 * (k / 32), k % 2 ? .4 : -.4);
    }
    put(S, iStr(hz('D4'), 4), o, .14, -.3); put(S, iStr(hz('Eb4'), 4), o, .1, .3);
    put(S, iRevCym(.5), o + 3.5, .2);
  }, { t60: 1.2, wet: .18 });
}
function warmupAmbience() {
  const L = 16, X = 2, n = N(L + X);
  const out = [];
  const gust = smoothNoise(n, .08);
  for (let ch = 0; ch < 2; ch++) {
    const o = new Float32Array(n);
    const w = pink(n); const fc = smoothNoise(n, .1); filt(w, 'bp', t => 520 + 320 * fc[Math.min(n - 1, Math.round(t * SR))], .8);
    for (let i = 0; i < n; i++) w[i] *= .55 + .45 * gust[i];
    add(o, norm(w, 1), 0, .6);
    const wh = white(n); const fw = smoothNoise(n, .07); filt(wh, 'bp', t => 1300 + 450 * fw[Math.min(n - 1, Math.round(t * SR))], 10);
    for (let i = 0; i < n; i++) wh[i] *= Math.max(0, gust[i]) ** 2;
    add(o, norm(wh, 1), 0, .08);
    const ru = brown(n); lp(ru, 120); add(o, norm(ru, 1), 0, .25);
    const sand = white(n); hp(sand, 5000); for (let i = 0; i < n; i++) sand[i] *= Math.max(0, gust[i] - .3); add(o, norm(sand, 1), 0, .05);
    out.push(o);
  }
  // distant events (birds, metal clanks, shutter rattles)
  const ev = new Float32Array(n);
  for (let k = 0; k < 5; k++) {
    const t = rr(1, L - 1), f = rr(3000, 4800);
    for (let c = 0, cc = ri(2, 4); c < cc; c++) { const s = osc(N(.09), tt => f * (1 + .15 * Math.sin(TAU * 18 * tt)) * (1 - tt * 1.5)); envPts(s, [[0, 0], [.01, 1], [.07, 0]]); add(ev, norm(s, 1), t + c * .13, .05); }
  }
  for (let k = 0; k < 3; k++) { const c = clack(mscale(M_HEAVY, rr(.6, .9)), .002, .4); lp(c, 1500); add(ev, c, rr(1, L - 1), .1); }
  const evR = fdn(diffuse(ev), { t60: 1.8, len: L + X, damp: 2500, size: 1.6, stereo: true });
  for (let ch = 0; ch < 2; ch++) { add(out[ch], ev, 0, ch ? .5 : .8); add(out[ch], evR[ch], 0, .6 * peakOf(ev) / Math.max(1e-6, peakOf(evR[ch]))); }
  const res = out.map(o => loopify(o, L)); const p = Math.max(peakOf(res[0]), peakOf(res[1])); res.forEach(x => scale(x, .9 / p));
  return res;
}

// =====================================================================================
//  JOB REGISTRY  (id = key#variant)
// =====================================================================================
const LTARGET = { shot: -12, sfx: -12, music: -14 };
const JOBS = {};
function J(key, nv, fn) { for (let v = 0; v < nv; v++) JOBS[`${key}#${v}`] = () => fn(v); }
for (const w of Object.keys(SHOT)) { J(`shot:${w}`, 2, () => gunshot(SHOT[w]).out); J(`shotfar:${w}`, 1, () => farShot(w)); }
J('shot:taser', 2, taserShot);
for (const s of SURFACES) { J(`footstep:${s}`, 6, () => footstep(s)); J(`impact:${s}`, s === 'metal' || s === 'stone' ? 4 : 3, v => impact(s, v)); J(`grenade_bounce:${s}`, 3, () => grenadeBounce(s)); }
J('land', 3, land); J('jump', 3, jump); J('crouch', 2, crouch);
for (const k of Object.keys(handling)) J(k, k === 'inspect' || k === 'zoom' ? 1 : 2, handling[k]);
J('shell_drop', 4, shellDrop);
J('knife_deploy', 1, knifeDeploy); J('knife_swing', 3, knifeSwing); J('knife_hit_body', 2, knifeHitBody); J('knife_hit_wall', 2, knifeHitWall); J('knife_stab', 2, knifeStab);
J('hit_body', 3, hitBody); J('hit_armor', 2, hitArmor); J('hit_head_helmet', 2, helmetDink); J('hit_head', 2, hitHead); J('hurt', 2, hurt); J('death', 2, death);
J('whiz', 3, whiz);
J('grenade_pin', 1, grenadePin); J('grenade_throw', 2, grenadeThrow);
J('he_explode', 1, () => explosion(HE).out); J('he_explode:far', 1, () => explosionFar(HE, 'he_explode'));
J('c4_explode', 1, () => explosion(C4X).out); J('c4_explode:far', 1, () => explosionFar(C4X, 'c4_explode'));
J('flash_explode', 1, () => flashExplode(false)); J('flash_explode:far', 1, () => flashExplode(true));
J('flash_ring', 1, flashRing); J('smoke_pop', 1, smokePop); J('smoke_hiss', 1, smokeHiss);
J('molotov_break', 2, molotovBreak); J('incendiary_pop', 1, incendiaryPop); J('fire_loop', 1, fireLoop); J('fire_extinguish', 1, fireExtinguish);
J('c4_key', 5, c4Key); J('c4_planted', 1, c4Planted); J('c4_beep', 1, c4Beep); J('defuse_start', 1, defuseStart); J('defuse_tick', 1, defuseTick); J('defuse_done', 1, defuseDone);
J('c4_pickup', 1, c4Pickup); J('kit_pickup', 1, kitPickup);
J('ui_click', 1, uiClick); J('ui_hover', 1, uiHover); J('buy', 1, buy); J('buy_deny', 1, buyDeny); J('money', 1, money); J('radio', 1, radio); J('ten_seconds', 1, tenSeconds);
J('round_start', 1, mRoundStart); J('round_win_ct', 1, () => mWin('ct')); J('round_win_t', 1, () => mWin('t')); J('round_lose', 1, mRoundLose);
J('bomb_planted_music', 1, mBombLoop); J('bomb_final10', 1, mBombFinal); J('mvp', 1, mMvp); J('match_win', 1, mMatchWin); J('match_lose', 1, mMatchLose);
J('warmup_ambience', 1, warmupAmbience);

function runJob(id) {
  const fn = JOBS[id]; if (!fn) throw new Error('unknown audio job ' + id);
  seed(hashStr(id)); for (const c of _memo) c.clear();
  let d = fn(); if (!Array.isArray(d)) d = [d];
  for (const c of d) for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) c[i] = 0;
  const key = id.slice(0, id.lastIndexOf('#'));
  if (!/^shotfar:|:far$/.test(key)) {
    const long = /^(round_|match_|mvp|bomb_|warmup_|fire_loop|smoke_hiss|flash_ring)/.test(key);
    loudNorm(d, long ? LTARGET.music : key.startsWith('shot:') ? LTARGET.shot : LTARGET.sfx, long ? .4 : .1);
  }
  let p = 0; for (const c of d) p = Math.max(p, peakOf(c));
  if (p > .99) for (const c of d) scale(c, .99 / p);
  return d;
}

// Worker entry: this module doubles as its own render worker
const IS_WORKER = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
if (IS_WORKER) {
  self.onmessage = e => {
    const { id } = e.data;
    try { const out = runJob(id); self.postMessage({ id, out }, out.map(c => c.buffer)); }
    catch (err) { self.postMessage({ id, err: String((err && err.stack) || err) }); }
  };
}

// Renders all jobs. Returns { critical, all } promises; deferred jobs (music, distant variants...)
// keep rendering in the workers after the critical set is done.
function renderJobs(ids, o) {
  const isDef = o.isDeferred, crit = ids.filter(id => !isDef(id));
  const done = new Set();
  let critLeft = crit.length, allLeft = ids.length, resolveCrit, resolveAll;
  const critical = new Promise(r => { resolveCrit = r; }), all = new Promise(r => { resolveAll = r; });
  if (!critLeft) resolveCrit();
  const got = (id, out) => {
    if (done.has(id)) return; done.add(id);
    o.onResult(id, out); allLeft--;
    if (!isDef(id)) { critLeft--; try { o.onProgress && o.onProgress(Math.min(.999, 1 - critLeft / crit.length)); } catch (e) { /* ignore */ } if (!critLeft) resolveCrit(); }
    if (!allLeft) resolveAll();
  };
  const order = [...crit.sort((a, b) => jobCost(b) - jobCost(a)), ...ids.filter(isDef).sort((a, b) => jobCost(b) - jobCost(a))];
  const mainThread = async () => {
    let last = performance.now();
    for (const id of order) {
      if (done.has(id)) continue;
      got(id, runJob(id));
      if (performance.now() - last > 30) { await new Promise(r => setTimeout(r, 0)); last = performance.now(); }
    }
  };
  let workers = [];
  if (o.useWorkers && typeof Worker !== 'undefined') {
    try {
      const hc = Math.max(2, Math.min(8, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4));
      for (let k = 0; k < hc; k++) workers.push(new Worker(import.meta.url, { type: 'module' }));
    } catch (e) { workers.forEach(w => w.terminate()); workers = []; }
  }
  if (!workers.length) { mainThread(); return { critical, all }; }
  let next = 0, failed = false;
  const fail = e => {
    if (failed) return; failed = true;
    console.warn('[audio] worker rendering failed, falling back to main thread:', e);
    workers.forEach(w => w.terminate()); mainThread();
  };
  const timer = setTimeout(() => fail(new Error('timeout')), 90000);
  const feed = w => { if (next < order.length) w.postMessage({ id: order[next++] }); };
  for (const w of workers) {
    w.onmessage = e => {
      if (failed) return;
      const { id, out, err } = e.data;
      if (err) { fail(new Error(err)); return; }
      got(id, out);
      if (!allLeft) { clearTimeout(timer); workers.forEach(x => x.terminate()); } else feed(w);
    };
    w.onerror = e => fail(new Error((e && e.message) || 'worker error'));
    feed(w);
  }
  return { critical, all };
}
const DEFERRED = /^(shotfar:|round_|match_|mvp|bomb_|warmup_|c4_explode|he_explode:far|flash_explode:far)/;
function jobCost(id) {
  if (/^(bomb_|match_|mvp|round_|warmup)/.test(id)) return 10;
  if (/^(shotfar|c4_explode|he_explode)/.test(id)) return 6;
  if (/^(shot:|fire_loop|smoke_hiss)/.test(id)) return 3;
  return 1;
}

// =====================================================================================
//  PLAYBACK METADATA
// =====================================================================================
const DEFM = { g: -10, max: 1500, ref: 70, roll: 1, fade: .72, rv: .15, rv2: .04, pv: .04, bus: 'sfx', air: 1400, poly: 8, farA: 400, farB: 2400, prio: 1 };
const META = {};
function meta(names, o) { for (const n of names.trim().split(/\s+/)) META[n] = { ...DEFM, ...o }; }
// g = level in dB relative to a loudness-normalized buffer (all buffers are normalized to the same short-term loudness)
meta('footstep', { g: -12, max: 1250, ref: 80, roll: .4, fade: .72, rv: .1, pv: .05, poly: 14, air: 1600 });
meta('land', { g: -10, max: 1250, ref: 80, roll: .4, fade: .72, pv: .05 });
meta('jump', { g: -17, max: 600, ref: 60, roll: .6 });
meta('crouch', { g: -24, max: 300, ref: 40 });
meta('deploy reload_magout reload_magin reload_bolt reload_slide shell_insert pump bolt_cycle pickup', { g: -16, max: 800, ref: 60, roll: .6, rv: .08, pv: .03 });
meta('dryfire', { g: -17, max: 400 }); meta('zoom', { g: -19, max: 300, pv: .02 }); meta('inspect', { g: -22, max: 300 }); meta('drop', { g: -14, max: 700, roll: .7 });
meta('shell_drop', { hrtf: false, g: -21, max: 500, ref: 40, pv: .08, poly: 16 });
meta('knife_deploy', { g: -17, max: 500 }); meta('knife_swing', { g: -15, max: 600, pv: .06 });
meta('knife_hit_body', { g: -10, max: 900, roll: .7 }); meta('knife_hit_wall', { g: -11, max: 900, roll: .7 }); meta('knife_stab', { g: -8, max: 900, roll: .7 });
meta('hit_body hit_armor', { g: -10, max: 2500, ref: 100, roll: .5, pv: .05, rv: .05 });
meta('hit_head_helmet', { g: -6, max: 3000, ref: 120, roll: .5, pv: .03, rv: .08 });
meta('hit_head', { g: -7, max: 3000, ref: 120, roll: .5, rv: .05 });
meta('hurt', { g: -9, max: 600, rv2: 0 }); meta('death', { g: -12, max: 1200, ref: 70, roll: .6 });
meta('impact', { hrtf: false, g: -14, max: 1200, ref: 60, roll: .7, pv: .08, poly: 24 });
meta('whiz', { g: -11, max: 500, ref: 60, pv: .08, poly: 12, rv: .04 });
meta('grenade_pin', { g: -17, max: 500 }); meta('grenade_throw', { g: -15, max: 600 }); meta('grenade_bounce', { g: -12, max: 800, ref: 60, roll: .6, pv: .06 });
meta('he_explode', { g: 0, max: 7000, ref: 250, roll: .5, rv: .3, rv2: .12, pv: .03, air: 4000, farA: 700, farB: 3200, prio: 3 });
meta('flash_explode', { g: -2, max: 5000, ref: 200, roll: .55, rv: .3, rv2: .12, pv: .03, air: 3500, farA: 600, farB: 3000, prio: 3 });
meta('flash_ring', { g: -12, bus: 'ring', pv: 0, rv2: 0 });
meta('smoke_pop', { g: -9, max: 2500, ref: 120, roll: .6 }); meta('smoke_hiss', { g: -18, max: 1200, ref: 100, roll: .7, pv: .02 });
meta('molotov_break', { g: -7, max: 2500, ref: 120, roll: .6 }); meta('incendiary_pop', { g: -8, max: 2500, ref: 120, roll: .6 });
meta('fire_loop', { g: -14, max: 1300, ref: 100, roll: .7, pv: .02 }); meta('fire_extinguish', { g: -11, max: 1500, ref: 100, roll: .7 });
meta('c4_key', { g: -15, max: 800, pv: 0 }); meta('c4_planted', { g: -12, max: 1500, ref: 100, roll: .6, pv: 0 });
meta('c4_beep', { g: -7, max: 1800, ref: 150, roll: .45, fade: .8, pv: 0, rv: .1, prio: 2 });
meta('c4_explode', { g: 1, max: 14000, ref: 400, roll: .35, rv: .35, rv2: .15, pv: .01, air: 6000, farA: 1200, farB: 5000, prio: 4 });
meta('defuse_start', { g: -15, max: 700 }); meta('defuse_tick', { g: -20, max: 300, pv: .02 }); meta('defuse_done', { g: -11, max: 1500, pv: 0 });
meta('c4_pickup kit_pickup', { g: -15, max: 500 });
meta('ui_click', { g: -19, bus: 'ui', pv: .02, rv2: 0 }); meta('ui_hover', { g: -26, bus: 'ui', pv: .02, rv2: 0 });
meta('buy', { g: -15, bus: 'ui', pv: 0, rv2: 0 }); meta('buy_deny', { g: -16, bus: 'ui', pv: 0, rv2: 0 }); meta('money', { g: -15, bus: 'ui', pv: .02, rv2: 0 });
meta('radio', { g: -16, bus: 'ui', pv: .03, rv2: 0 }); meta('ten_seconds', { g: -14, bus: 'ui', pv: 0, rv2: 0 });
meta('round_start round_win_ct round_win_t round_lose mvp match_win match_lose', { g: -6, bus: 'music', pv: 0, rv2: 0, poly: 2 });
meta('bomb_planted_music bomb_final10', { g: -8, bus: 'music', pv: 0, rv2: 0, poly: 2 });
meta('warmup_ambience', { g: -20, bus: 'sfx', pv: 0, rv2: 0, poly: 2 });

const SHOT_DB = {
  awp: 0, ssg08: -2.5, g3sg1: -1.5, scar20: -1.5, nova: -1, xm1014: -1.5, sawedoff: -1, mag7: -1, ak47: -1.5, deagle: -2, revolver: -1.5,
  m249: -2, negev: -2.5, galilar: -2.5, sg556: -2.5, aug: -3, famas: -3.5, m4a4: -3,
  ump45: -5, p90: -6, mp7: -5.5, mp9: -6, mac10: -5.5, bizon: -6,
  p250: -6, cz75a: -6.5, tec9: -6.5, fiveseven: -6.5, p2000: -7, elite: -7, glock: -8,
  m4a1_s: -7, usp_s: -9, mp5sd: -9.5, taser: -9,
};
const SUPPRESSED = new Set(['m4a1_s', 'usp_s', 'mp5sd']);
const SHOT_META = {};
for (const w of SHOT_WEAPONS) {
  const sup = SUPPRESSED.has(w);
  SHOT_META[w] = { ...DEFM, g: SHOT_DB[w] ?? -4, max: sup ? 2600 : w === 'taser' ? 1200 : 8000, ref: 150, roll: sup ? .8 : .55, fade: .7,
    rv: .22, rv2: .05, pv: .025, air: sup ? 2500 : 5000, poly: 32, hrtfMax: 2500, farA: sup ? 300 : 350, farB: sup ? 1500 : 2400, prio: 2 };
}
const ALIAS = { m4a1: 'm4a1_s', usp: 'usp_s', galil: 'galilar', cz: 'cz75a', cz75: 'cz75a', five7: 'fiveseven', r8: 'revolver', zeus: 'taser', sg553: 'sg556', scar: 'scar20', g3: 'g3sg1', ump: 'ump45', mp5: 'mp5sd' };

export const SOUND_NAMES = [
  'shot', 'decoy_shot', 'footstep', 'land', 'jump', 'crouch', 'deploy', 'reload_magout', 'reload_magin', 'reload_bolt', 'reload_slide', 'shell_insert', 'pump', 'bolt_cycle',
  'dryfire', 'zoom', 'pickup', 'drop', 'inspect', 'shell_drop', 'knife_deploy', 'knife_swing', 'knife_hit_body', 'knife_hit_wall', 'knife_stab',
  'hit_body', 'hit_armor', 'hit_head_helmet', 'hit_head', 'hurt', 'death', 'impact', 'whiz', 'grenade_pin', 'grenade_throw', 'grenade_bounce',
  'he_explode', 'flash_explode', 'flash_ring', 'smoke_pop', 'smoke_hiss', 'molotov_break', 'incendiary_pop', 'fire_loop', 'fire_extinguish',
  'c4_key', 'c4_planted', 'c4_beep', 'c4_explode', 'defuse_start', 'defuse_tick', 'defuse_done', 'c4_pickup', 'kit_pickup',
  'ui_click', 'ui_hover', 'buy', 'buy_deny', 'round_start', 'round_win_ct', 'round_win_t', 'round_lose', 'bomb_planted_music', 'bomb_final10',
  'mvp', 'match_win', 'match_lose', 'warmup_ambience', 'ten_seconds', 'radio', 'money',
];
export const LOOP_NAMES = ['flash_ring', 'smoke_hiss', 'fire_loop', 'bomb_planted_music', 'bomb_final10', 'warmup_ambience'];

// =====================================================================================
//  ENGINE
// =====================================================================================
const NULL_HANDLE = Object.freeze({ stop() { }, setPos() { }, setVolume() { }, playing: false });
const clamp01 = x => Math.max(0, Math.min(1, x));
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const SFX_BASE = 0.8, MUSIC_BASE = 0.9;
const MAKEUP_COMP = 1;   // calibrated against Chrome's automatic compressor makeup gain (see tools/audio_render.py)
const _irCache = {};

function makeIR(sr) {
  if (_irCache[sr]) return _irCache[sr];
  const sec = 1.8, n = Math.round(sr * sec); const ch = [new Float32Array(n), new Float32Array(n)];
  const saved = _s; seed(777);
  for (let c = 0; c < 2; c++) {
    const x = ch[c]; let y = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr; if (t < .012) continue;
      const dens = Math.min(1, .15 + t * 6);              // sparse early -> dense later (open space)
      const w = rnd() < dens ? (rnd() * 2 - 1) / Math.sqrt(dens) : 0;
      const fc = 1100 + 6500 * Math.exp(-t / .22); const a = 1 - Math.exp(-TAU * fc / sr); y += a * (w - y);
      const u = Math.min(1, Math.max(0, (t - .02) / .16)); x[i] = y * Math.exp(-6.9 * t / 1.3) * u * u * (3 - 2 * u) * .4;
    }
    const taps = [[.019, .5], [.034, .42], [.052, .5], [.077, .38], [.105, .34], [.141, .27], [.188, .2], [.247, .15], [.32, .11], [.42, .07]];
    for (const [t, g] of taps) {
      const o = Math.round(t * (c ? 1.07 : 1) * sr * (1 + (rnd() - .5) * .04)); let z = 0; const fc = 5200 * Math.exp(-t / .35) + 900, a = 1 - Math.exp(-TAU * fc / sr);
      for (let j = 0; j < 60 && o + j < n; j++) { z += a * ((rnd() * 2 - 1) * Math.exp(-j / 9) - z); x[o + j] += g * z * 4; }
    }
  }
  _s = saved;
  let e = 0; for (const x of ch) for (let i = 0; i < n; i++) e += x[i] * x[i];
  const g = 1 / Math.sqrt(e / 2); for (const x of ch) for (let i = 0; i < n; i++) x[i] *= g;
  return (_irCache[sr] = ch);
}
function softClipCurve() {
  const n = 4096, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, X = x * 2, a = Math.abs(X); c[i] = Math.sign(X) * (a < .85 ? a : .85 + .14 * Math.tanh((a - .85) / .14)); }
  return c;
}
function setXYZ(node, pre, v) {
  if (node[pre + 'X']) { node[pre + 'X'].value = v.x; node[pre + 'Y'].value = v.y; node[pre + 'Z'].value = v.z; return true; }
  return false;
}
function setPanPos(p, v) { if (!setXYZ(p, 'position', v)) p.setPosition(v.x, v.y, v.z); }

export class AudioEngine {
  constructor(opts = {}) {
    this.ctx = opts.context || null;
    this.bufs = {};
    this.ready = false;
    this.voices = new Set();
    this._lp = { x: 0, y: 0, z: 0 }; this._lf = { x: 0, y: 0, z: -1 }; this._lu = { x: 0, y: 1, z: 0 };
    this._vol = { master: 1, sfx: 1, music: .6 };
    this._muffle = 0; this._ringV = null; this._last = {}; this._warned = {}; this._byName = new Map();
    this._useWorkers = opts.workers !== false;
    this.initMs = 0;
  }

  // ---------------------------------------------------------------- init
  init(onProgress) {
    if (this._initP) return this._initP;
    let resolveAll; this.allReady = new Promise(r => { resolveAll = r; });
    this._initP = (async () => {
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!this.ctx && AC) this.ctx = new AC({ latencyHint: 'interactive' });
      try { if (this.ctx && this.ctx.state !== 'running' && this.ctx.resume) this.ctx.resume(); } catch (e) { /* ignore */ }
      const t0 = performance.now();
      const ids = Object.keys(JOBS);
      const nvar = {}; for (const id of ids) { const k = id.slice(0, id.lastIndexOf('#')); nvar[k] = (nvar[k] || 0) + 1; }
      this._pending = new Set(Object.keys(nvar)); this._waiting = {};
      const tmp = {};
      const { critical, all } = renderJobs(ids, {
        useWorkers: this._useWorkers, onProgress, isDeferred: id => DEFERRED.test(id),
        onResult: (id, chs) => {
          const h = id.lastIndexOf('#'), key = id.slice(0, h), v = +id.slice(h + 1);
          const ab = new AudioBuffer({ length: chs[0].length, numberOfChannels: chs.length, sampleRate: SR });
          chs.forEach((c, i) => ab.copyToChannel(c, i));
          (tmp[key] ||= [])[v] = ab;
          if (tmp[key].filter(Boolean).length === nvar[key]) { this.bufs[key] = tmp[key]; this._pending.delete(key); this._flushWaiting(key); }
        },
      });
      all.then(() => { this.allMs = performance.now() - t0; resolveAll(this); });
      await critical;
      if (this.ctx) {
        this.G = this._makeGraph(this.ctx, this._lp);
        this._applyVol(this.G); this._applyListener();
      }
      this.ready = true;
      this.initMs = performance.now() - t0;
      if (onProgress) try { onProgress(1); } catch (e) { /* ignore */ }
      return this;
    })();
    return this._initP;
  }
  _flushWaiting(key) {
    const list = this._waiting && this._waiting[key]; if (!list) return;
    delete this._waiting[key];
    for (const w of list) {
      if (w.cancelled || !this.G) continue;
      if (!w.loop && performance.now() - w.at > 1500) continue;   // too late for a one-shot
      w.real = this._voice(this.G, w.name, w.opts, w.loop, true);
    }
  }
  _makeGraph(ctx, listenerPos) {
    const G = { ctx, lp: listenerPos };
    G.master = ctx.createGain();
    G.comp = ctx.createDynamicsCompressor();
    G.comp.threshold.value = -4; G.comp.knee.value = 2; G.comp.ratio.value = 20; G.comp.attack.value = .001; G.comp.release.value = .15;
    G.pre = ctx.createGain(); G.pre.gain.value = .5 * MAKEUP_COMP;
    G.clip = ctx.createWaveShaper(); G.clip.curve = softClipCurve();
    G.master.connect(G.comp); G.comp.connect(G.pre); G.pre.connect(G.clip); G.clip.connect(ctx.destination);
    G.muffle = ctx.createBiquadFilter(); G.muffle.type = 'lowpass'; G.muffle.frequency.value = Math.min(22000, ctx.sampleRate / 2 - 100); G.muffle.Q.value = .5;
    G.duck = ctx.createGain();
    G.sfx = ctx.createGain(); G.sfx.connect(G.muffle); G.muffle.connect(G.duck); G.duck.connect(G.master);
    G.rv = ctx.createConvolver(); G.rv.normalize = false;
    const ir = makeIR(ctx.sampleRate); const irb = ctx.createBuffer(2, ir[0].length, ctx.sampleRate); irb.copyToChannel(ir[0], 0); irb.copyToChannel(ir[1], 1); G.rv.buffer = irb;
    G.rvRet = ctx.createGain(); G.rv.connect(G.rvRet); G.rvRet.connect(G.sfx);
    G.ui = ctx.createGain(); G.ui.connect(G.master);
    G.music = ctx.createGain(); G.music.connect(G.master);
    G.ring = ctx.createGain(); G.ring.connect(G.master);
    return G;
  }
  _applyVol(G) {
    const v = this._vol;
    G.master.gain.value = v.master; G.sfx.gain.value = v.sfx * SFX_BASE; G.ui.gain.value = v.sfx * SFX_BASE;
    G.music.gain.value = v.music * MUSIC_BASE; G.ring.gain.value = v.sfx * SFX_BASE;
  }
  _applyListener() {
    const ctx = this.ctx; if (!ctx) return; const L = ctx.listener, p = this._lp, f = this._lf, u = this._lu;
    if (L.positionX) { setXYZ(L, 'position', p); setXYZ(L, 'forward', f); setXYZ(L, 'up', u); }
    else { L.setPosition(p.x, p.y, p.z); L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z); }
  }

  // ---------------------------------------------------------------- public API
  setListener(pos, forward, up) {
    if (pos) { this._lp.x = pos.x; this._lp.y = pos.y; this._lp.z = pos.z; }
    if (forward) { this._lf.x = forward.x; this._lf.y = forward.y; this._lf.z = forward.z; }
    if (up) { this._lu.x = up.x; this._lu.y = up.y; this._lu.z = up.z; }
    if (!this.ready || !this.G) return;
    this._applyListener();
    for (const v of this.voices) if (v.pos) this._spatial(v, this.G, false);
  }
  setVolume(o = {}) {
    for (const k of ['master', 'sfx', 'music']) if (typeof o[k] === 'number') this._vol[k] = clamp01(o[k]);
    if (this.G) this._applyVol(this.G);
  }
  play(name, opts = {}) { if (!this.ready || !this.G) return NULL_HANDLE; return this._voice(this.G, name, opts, false, true); }
  playLoop(name, opts = {}) { if (!this.ready || !this.G) return NULL_HANDLE; return this._voice(this.G, name, opts, true, true); }
  muffle(amount) {
    const a = clamp01(amount || 0); this._muffle = a;
    if (!this.ready || !this.G) return;
    this._applyMuffle(this.G, a, false);
    const rg = Math.pow(a, 1.3);
    if (a > .01) { if (!this._ringV || !this._ringV.playing) this._ringV = this.playLoop('flash_ring', { volume: rg, fadeIn: .05 }); else this._ringV.setVolume(rg); }
    else if (this._ringV) { this._ringV.stop(.4); this._ringV = null; }
  }
  _applyMuffle(G, a, instant) {
    const f = Math.min(G.ctx.sampleRate / 2 - 100, 22000 * Math.pow(300 / 22000, Math.pow(a, .6)));
    const d = 1 - .6 * a;
    if (instant) { G.muffle.frequency.value = f; G.duck.gain.value = d; }
    else { const t = G.ctx.currentTime; G.muffle.frequency.setTargetAtTime(f, t, .03); G.duck.gain.setTargetAtTime(d, t, .03); }
  }
  resume() { try { if (this.ctx && this.ctx.state !== 'running') return this.ctx.resume(); } catch (e) { /* ignore */ } return Promise.resolve(); }
  stopAll(fade = .1) { for (const v of [...this.voices]) v.handle.stop(fade); }
  stopMusic(fade = .5) { for (const v of [...this.voices]) if (v.meta.bus === 'music') v.handle.stop(fade); }
  has(name, opts = {}) { const r = this._resolve(name, opts); return !!(r && this.bufs[r.key]); }

  // ---------------------------------------------------------------- internals
  _resolve(name, opts) {
    if (name === 'shot' || name === 'decoy_shot') {
      let w = opts.weapon || 'ak47'; w = ALIAS[w] || w;
      if (!SHOT_META[w]) w = /knife|grenade|flash|smoke|molotov|decoy|c4/.test(w) ? null : 'ak47';
      if (!w) return null;
      const m = name === 'decoy_shot' ? { ...SHOT_META[w], g: SHOT_META[w].g - 1.5, pv: .04 } : SHOT_META[w];
      return { key: `shot:${w}`, farKey: this.bufs[`shotfar:${w}`] ? `shotfar:${w}` : null, meta: m };
    }
    if (name === 'footstep' || name === 'impact' || name === 'grenade_bounce') {
      const s = FOOT[opts.surface] ? opts.surface : 'stone';
      return { key: `${name}:${s}`, meta: META[name] };
    }
    if (name === 'bomb_planted_music' && opts.variant === 'final') name = 'bomb_final10';
    const m = META[name]; if (!m) return null;
    return { key: name, farKey: this.bufs[name + ':far'] ? name + ':far' : null, meta: m };
  }
  _voice(G, name, opts, loop, track, exact = false) {
    const ctx = G.ctx;
    const r = this._resolve(name, opts);
    const list = r && this.bufs[r.key];
    if ((!list || !list.length) && r && track && this._pending && this._pending.has(r.key)) {
      const w = { name, opts: { ...opts }, loop, at: performance.now(), cancelled: false, real: null };
      (this._waiting[r.key] ||= []).push(w);
      return {
        stop(f) { if (w.real) w.real.stop(f); else w.cancelled = true; },
        setPos(p) { if (w.real) w.real.setPos(p); else if (p) w.opts.pos = { x: p.x, y: p.y, z: p.z }; },
        setVolume(x) { if (w.real) w.real.setVolume(x); else w.opts.volume = x; },
        get playing() { return w.real ? w.real.playing : !w.cancelled; },
      };
    }
    if (!list || !list.length) { if (!this._warned[name]) { this._warned[name] = 1; console.warn('[audio] unknown sound', name, opts); } return NULL_HANDLE; }
    const m = r.meta;
    let vi;
    if (typeof opts.variant === 'number') vi = ((opts.variant % list.length) + list.length) % list.length;
    else if (exact) vi = 0;
    else { vi = Math.floor(Math.random() * list.length); if (list.length > 1 && vi === this._last[r.key]) vi = (vi + 1) % list.length; this._last[r.key] = vi; }
    const now = ctx.currentTime + Math.max(0, opts.delay || 0);
    const rate = (opts.rate ?? 1) * (exact || !m.pv ? 1 : 1 + (Math.random() * 2 - 1) * m.pv);
    const out = ctx.createGain();
    const v = { name, meta: m, out, srcs: [], pos: null, loop, ended: false, t0: now, G, baseGain: dbToG(m.g) * (opts.volume ?? 1) };
    const mk = (buf, dest) => { const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate; s.loop = loop; s.connect(dest); v.srcs.push(s); return s; };
    const pos = opts.pos && Number.isFinite(opts.pos.x) ? opts.pos : null;
    if (pos && r.farKey) {
      v.nearG = ctx.createGain(); v.farG = ctx.createGain(); v.nearG.connect(out); v.farG.connect(out);
      mk(list[vi], v.nearG); mk(this.bufs[r.farKey][0], v.farG);
    } else mk(list[vi], out);
    const bus = G[m.bus] || G.sfx;
    if (pos) {
      v.air = ctx.createBiquadFilter(); v.air.type = 'lowpass'; v.air.Q.value = .5;
      v.dist = ctx.createGain(); v.send = ctx.createGain();
      const p = v.pan = ctx.createPanner();
      const d0 = Math.hypot(pos.x - G.lp.x, pos.y - G.lp.y, pos.z - G.lp.z);
      p.panningModel = (m.hrtf === false || d0 > (m.hrtfMax ?? 1e9)) ? 'equalpower' : 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 1; p.rolloffFactor = 0; p.maxDistance = 1e7;
      out.connect(v.air); v.air.connect(v.dist); v.dist.connect(p); p.connect(bus); v.air.connect(v.send); v.send.connect(G.rv);
      v.pos = { x: pos.x, y: pos.y, z: pos.z }; setPanPos(p, v.pos);
      this._spatial(v, G, true);
    } else {
      out.connect(bus);
      if (m.rv2 > 0 && bus === G.sfx) { v.send = ctx.createGain(); v.send.gain.value = m.rv2; out.connect(v.send); v.send.connect(G.rv); }
    }
    if (loop) {
      out.gain.setValueAtTime(0, now); out.gain.linearRampToValueAtTime(v.baseGain, now + Math.max(.01, opts.fadeIn ?? .08));
      const off = opts.offset ?? (m.bus === 'sfx' ? Math.random() * list[vi].duration : 0);
      v.srcs.forEach(s => s.start(now, off % s.buffer.duration));
    } else { out.gain.value = v.baseGain; v.srcs.forEach(s => s.start(now)); }
    let live = v.srcs.length;
    v.srcs.forEach(sn => { sn.onended = () => { if (--live <= 0) this._end(v); }; });
    const self = this;
    v.handle = {
      stop(fade = 0) {
        if (v.ended) return; const t = ctx.currentTime;
        try {
          if (fade > 0) {
            if (out.gain.cancelAndHoldAtTime) out.gain.cancelAndHoldAtTime(t); else { out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(out.gain.value, t); }
            out.gain.linearRampToValueAtTime(0, t + fade); v.srcs.forEach(s => s.stop(t + fade + .02));
          } else v.srcs.forEach(s => s.stop());
        } catch (e) { /* already stopped */ }
        v.stopping = true;
      },
      setPos(p) { if (!v.pos || !p) return; v.pos.x = p.x; v.pos.y = p.y; v.pos.z = p.z; setPanPos(v.pan, v.pos); self._spatial(v, G, false); },
      setVolume(x) { v.baseGain = dbToG(m.g) * x; out.gain.setTargetAtTime(v.baseGain, ctx.currentTime, .05); },
      get playing() { return !v.ended && !v.stopping; },
    };
    if (track) { this.voices.add(v); this._limit(v); }
    return v.handle;
  }
  _spatial(v, G, instant) {
    const m = v.meta, lp = G.lp;
    const dx = v.pos.x - lp.x, dy = v.pos.y - lp.y, dz = v.pos.z - lp.z; const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const dd = Math.max(d, m.ref);
    let dg = m.ref / (m.ref + m.roll * (dd - m.ref));
    const f0 = m.max * m.fade; if (d > f0) dg *= Math.pow(clamp01(1 - (d - f0) / (m.max - f0)), 1.5);
    const air = Math.max(900, Math.min(G.ctx.sampleRate / 2 - 100, 20000 * Math.pow(2, -d / m.air)));
    let sg = m.rv * Math.sqrt(dg);
    let nearG = 1, farG = 0;
    if (v.nearG) { const x = smoothstep(m.farA, m.farB, d); nearG = Math.cos(x * Math.PI / 2); farG = Math.sin(x * Math.PI / 2); sg *= 1 - .7 * x; }
    const t = G.ctx.currentTime;
    const set = (p, val) => { if (instant) p.value = val; else p.setTargetAtTime(val, t, .04); };
    set(v.dist.gain, dg); set(v.air.frequency, air); set(v.send.gain, sg);
    if (v.nearG) { set(v.nearG.gain, nearG); set(v.farG.gain, farG); }
    v.dg = dg;
  }
  _limit(v) {
    const arr = this._byName.get(v.name) || []; arr.push(v); this._byName.set(v.name, arr);
    let live = 0; for (const x of arr) if (!x.stopping) live++;
    for (let i = 0; i < arr.length && live > v.meta.poly; i++) if (!arr[i].stopping) { arr[i].handle.stop(.03); live--; }
    if (this.voices.size > 96) {
      const c = [...this.voices].filter(x => !x.loop && !x.stopping).sort((a, b) => (a.meta.prio - b.meta.prio) || (a.t0 - b.t0));
      c.slice(0, this.voices.size - 96).forEach(x => x.handle.stop(.03));
    }
  }
  _end(v) {
    if (v.ended) return; v.ended = true; this.voices.delete(v);
    const arr = this._byName.get(v.name); if (arr) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); }
    try { v.out.disconnect(); if (v.pan) { v.pan.disconnect(); v.air.disconnect(); v.dist.disconnect(); } if (v.send) v.send.disconnect(); } catch (e) { /* ignore */ }
    if (this._ringV === v.handle) this._ringV = null;
  }

  // ---------------------------------------------------------------- testing helpers
  // Render a sound through the full output chain (buses, reverb, limiter) into an AudioBuffer.
  // o: { dur, listener:{x,y,z}, loop, exact (no pitch jitter, variant 0 unless opts.variant), muffle }
  async renderOffline(name, opts = {}, o = {}) {
    const r = this._resolve(name, opts); const list = r && this.bufs[r.key];
    const all = list ? [...list, ...((r.farKey && opts.pos && this.bufs[r.farKey]) || [])] : [];
    const base = all.length ? Math.max(...all.map(b => b.duration)) / (opts.rate ?? 1) : 1;
    const dur = o.dur ?? Math.min(30, base * 1.06 + .3 + (opts.delay || 0));
    const PRE = .3;   // Chrome's DynamicsCompressor starts fully clamped; let it settle first
    const ctx = new OfflineAudioContext(2, Math.ceil((dur + PRE) * SR), SR);
    const lp = o.listener ?? { x: 0, y: 0, z: 0 };
    const G = this._makeGraph(ctx, lp); this._applyVol(G);
    if (o.muffle) this._applyMuffle(G, o.muffle, true);
    const L = ctx.listener;
    if (L.positionX) { setXYZ(L, 'position', lp); setXYZ(L, 'forward', { x: 0, y: 0, z: -1 }); setXYZ(L, 'up', { x: 0, y: 1, z: 0 }); }
    else { L.setPosition(lp.x, lp.y, lp.z); L.setOrientation(0, 0, -1, 0, 1, 0); }
    this._voice(G, name, { ...opts, delay: (opts.delay || 0) + PRE }, !!o.loop, false, o.exact !== false);
    const full = await ctx.startRendering();
    const off = Math.round(PRE * SR), n = full.length - off;
    const out = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: SR });
    for (let c = 0; c < 2; c++) out.copyToChannel(full.getChannelData(c).subarray(off), c);
    return out;
  }
}

export default AudioEngine;

// test hooks (used by test_audio.html / tools/audio_*.mjs)
export const __audioTest = { runJob, jobIds: () => Object.keys(JOBS), SR, META, SHOT_META };
