import { energyLevel } from './energy.js';
import { profStart, profEnd, profJob, profReport, profilerPanel, profIsolated } from './profiler.js';
// BEAT: pulse the cover to the bass of the playing song.
// iOS gives Web Audio silence for MediaSource playback, so instead of analysing the live output
// we decode the already-downloaded audio file offline (8 kHz mono, low-passed), turn it into a
// bass "kick" envelope (one value per 20 ms) and drive the pulse from the element's currentTime.
// Playback itself never goes through Web Audio, so background play is unaffected.
import { Preferences } from '@capacitor/preferences';
import { audioElement, current } from './player.js';

const RATE = 8000, FRAME = 160; // 20 ms frames
const envs = new Map(); // track id -> Float32Array (0..1) bass kick envelope (BEAT)
const spectra = new Map(); // track id -> Float32Array[] one level envelope per band (visualizer)
const drops = new Map(); // track id -> seconds of the drop/chorus
const dropSubs = new Set();
export const dropTime = (id) => drops.get(id);
export const onDrop = (f) => { dropSubs.add(f); return () => dropSubs.delete(f); };
export const BAND_HZ = [55, 110, 220, 440, 880, 1600, 2800, 3700];
const busy = new Set();
let raf = 0, target = null, cur = 1, enabled = false;
const subs = new Set();
export const beatOn = () => enabled;
export const onBeat = (f) => { subs.add(f); return () => subs.delete(f); };
export let beatStatus = '';
const status = (s) => { beatStatus = s; subs.forEach((f) => f(enabled)); };

let analysing = false, queued = null;
function analyse(id, parts, mime) {
  if (energyLevel() >= 3 || !id || envs.has(id) || !parts?.length || document.hidden || current()?.id !== id) return;
  queued = { id, parts, mime };
  if (!analysing) void drainAnalysis();
}
async function drainAnalysis() {
  analysing = true;
  try {
    while (queued) {
      const job = queued; queued = null;
      if (!document.hidden && current()?.id === job.id) await analyseNow(job.id, job.parts, job.mime);
    }
  } finally { analysing = false; }
}
async function analyseNow(id, parts, mime) {
  if (envs.has(id) || busy.has(id) || !parts?.length) return;
  busy.add(id);
  const finishProfile = profJob('beat.analysis');
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const bytes = await new Blob(parts, { type: (mime || '').split(';')[0] }).arrayBuffer();
    const finishDecode = profJob('beat.decode');
    const decoded = await new OAC(1, RATE, RATE).decodeAudioData(bytes).finally(()=>finishDecode(bytes.byteLength));
    // Render one filter at a time (mono) so memory stays small even for long songs.
    const obsolete = () => energyLevel() >= 3 || document.hidden || current()?.id !== id;
    if (obsolete()) return;
    const B = BAND_HZ.length;
    const renderFilter = async (type, hz, q) => {
      const off = new OAC(1, decoded.length, RATE);
      const src = off.createBufferSource();
      src.buffer = decoded;
      const f = off.createBiquadFilter();
      f.type = type; f.frequency.value = hz; if (q) f.Q.value = q;
      src.connect(f); f.connect(off.destination); src.start();
      const finishFilter = profJob('beat.filter.'+hz);
      return (await off.startRendering().finally(()=>finishFilter())).getChannelData(0);
    };
    const rms = (ch) => {
      const n = Math.floor(ch.length / FRAME), out = new Float32Array(n);
      for (let i = 0; i < n; i++) { let s2 = 0; for (let j = i * FRAME, e = j + FRAME; j < e; j++) s2 += ch[j] * ch[j]; out[i] = Math.sqrt(s2 / FRAME); }
      return out;
    };
    const bassEnergy = rms(await renderFilter('lowpass', 150));
    if (obsolete()) return;
    const bands = [];
    for (let b = 0; b < B; b++) {
      const hz = BAND_HZ[b];
      const e = rms(await renderFilter(hz < 100 ? 'lowpass' : hz > 3500 ? 'highpass' : 'bandpass', hz, 1.1));
      if (obsolete()) return;
      const sorted = e.slice().sort();
      const p = sorted[Math.floor(sorted.length * 0.985)] || 1e-6;
      for (let i = 0; i < e.length; i++) e[i] = Math.min(1, Math.pow(e[i] / p, 0.8));
      bands.push(e);
    }
    spectra.set(id, bands);
    // Drop / chorus: the biggest sustained jump in overall energy (4 s windows), after the intro.
    try {
      const n = bands[0].length, W = 200; // 200 frames = 4 s
      const energy = new Float32Array(n);
      for (let i = 0; i < n; i++) { let e = 0; for (const b of bands) e += b[i]; energy[i] = e; }
      const pre = new Float32Array(n + 1);
      for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + energy[i];
      const avg = (a, b) => (pre[Math.min(n, b)] - pre[Math.max(0, a)]) / Math.max(1, Math.min(n, b) - Math.max(0, a));
      let best = -1, bestI = -1;
      for (let i = Math.floor(n * 0.12); i < n * 0.85; i += 10) {
        const jump = avg(i, i + W) - avg(i - W, i);
        const score = jump + avg(i, i + W) * 0.25;
        if (score > best) { best = score; bestI = i; }
      }
      if (bestI > 0) drops.set(id, bestI / 50);
      while (drops.size > 20) drops.delete(drops.keys().next().value);
    } catch { /* no drop */ }
    dropSubs.forEach((f) => f());
    while (spectra.size > 3) spectra.delete(spectra.keys().next().value);
    const n = bassEnergy.length;
    const energy = bassEnergy;
    // onset = energy above the local (0.5 s) average, normalised by a high percentile
    const env = new Float32Array(n);
    let avg = energy[0] || 0;
    for (let i = 0; i < n; i++) { avg = avg * 0.96 + energy[i] * 0.04; env[i] = Math.max(0, energy[i] - avg * 1.08); }
    const sorted = env.slice().sort();
    const p = sorted[Math.floor(sorted.length * 0.97)] || 1e-6;
    for (let i = 0; i < n; i++) env[i] = Math.min(1, env[i] / p);
    envs.set(id, env);
    while (envs.size > 3) envs.delete(envs.keys().next().value);
    console.info('[beat] analysed', id, n, 'frames');
    if (current()?.id === id) status('');
  } catch (e) {
    console.warn('[beat] analyse failed', e?.message || e);
    if (current()?.id === id) status('nie da się przeanalizować tego utworu');
  } finally { busy.delete(id); finishProfile(); }
}

// player.js announces every fully downloaded track
const pending = new Map();
window.addEventListener('mtb-audio', (e) => {
  const { id, parts, mime } = e.detail || {};
  pending.set(id, { parts, mime });
  while (pending.size > 3) pending.delete(pending.keys().next().value);
  // In the background nobody sees the animations: don't burn CPU, analyse when the app comes back.
  if (current()?.id === id && !document.hidden) analyse(id, parts, mime);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const t = current(), p = t && pending.get(t.id);
  if (p && !envs.has(t.id)) analyse(t.id, p.parts, p.mime);
});

window.addEventListener('mtb-energy', () => {
  if (energyLevel() >= 3 || document.hidden) return;
  const t = current(), p = t && pending.get(t.id);
  if (p && !envs.has(t.id)) analyse(t.id, p.parts, p.mime);
});
let lastT = 0, lastEnergyWrite = 0;
const lastV = {};
function put(st, k, v) { if (Math.abs((lastV[k] ?? -9) - v) < 0.004) return; lastV[k] = v; const s2 = v.toFixed(3); for (const el of targets) el.style.setProperty(k, s2); }
// ONE clock for every animation: the music is read once per frame here, everything else
// (visualizer, scene, cover) just gets the result. Full display rate (120 Hz on ProMotion).
const frameSubs = new Set();
const SAMPLE_MS = 1000 / 30;
let prevL = null, nextL = null, readAt = 0, blend = [], lastKey = '', slow = 0, good = 0, prevNow = 0;
export function onFrame(f) { frameSubs.add(f); if (!raf) raf = requestAnimationFrame(loop); return () => frameSubs.delete(f); }
function loop(now = 0) {
  if (!enabled && !frameSubs.size) { raf = 0; return; }
  raf = requestAnimationFrame(loop);
  if (document.hidden || !document.documentElement.classList.contains('np-open')) { lastT = 0; prevNow = 0; return; }
  const fk = Math.min(4, Math.max(0.25, (now - (lastT || now - 16.7)) / 16.7)); // frame-rate independent
  lastT = now;
  // Music is sampled at 30 Hz (one step ahead, so interpolation adds no lag);
  // every 120 Hz frame in between just blends the two samples.
  const key = (current()?.id || '') + (audioElement.paused ? 'p' : '');
  if (now - readAt >= SAMPLE_MS || key !== lastKey) {
    lastKey = key;
    prevL = nextL; nextL = bandLevels(SAMPLE_MS / 1000); readAt = now;
    if (!prevL || !nextL || prevL.length !== nextL.length) prevL = nextL;
  }
  let L = null;
  if (nextL) {
    const a = Math.min(1, (now - readAt) / SAMPLE_MS);
    L = blend.length === nextL.length ? blend : (blend = new Array(nextL.length));
    for (let k = 0; k < nextL.length; k++) L[k] = prevL[k] + (nextL[k] - prevL[k]) * a;
  }
  const subscriberStart = profStart();
  frameSubs.forEach((f) => f(L, now));
  profEnd('beat.subscribers', subscriberStart);
  // Adaptive quality: if frames keep coming late, drop the heavy effects (weaker / hot phones).
  // <~22 fps counts as slow; a steady 30 fps cap from iOS (heat / low power) is fine
  if (fk > 2.7 && !document.hidden) slow++; else if (slow > 0) slow -= 0.25;
  const lite = document.documentElement.classList.contains('lite');
  if (slow > 90 && !lite) { document.documentElement.classList.add('lite'); console.log('[perf] lite mode on'); good = 0; }
  // ...and back to full effects after ~20 s of smooth frames
  if (lite) { good = fk < 2.2 ? good + now - (prevNow || now) : 0; if (good > 20000) { document.documentElement.classList.remove('lite'); slow = 0; good = 0; console.log('[perf] lite mode off'); } }
  prevNow = now;
  if (!target || !enabled || !document.documentElement.classList.contains('np-open')) return;
  const t = current();
  const env = t && envs.get(t.id);
  let v = 0;
  if (env && !audioElement.paused) {
    const x = audioElement.currentTime * 50, i = Math.floor(x), f = x - i;
    v = (env[i] || 0) * (1 - f) + (env[i + 1] || 0) * f;
  }
  cur = Math.max(1 + v * 0.11, 1 + (cur - 1) * Math.pow(0.86, fk));
  kick = Math.max(v, kick * Math.pow(0.82, fk)); // fast-decaying flash on every bass hit
  // Whole scene: bass / mid / high energy, fast attack and slow release so quiet parts calm down.
  let bass = 0, mid = 0, high = 0;
  if (L) {
    bass = Math.max((L[0] + L[1]) / 2, v);
    mid = (L[2] + L[3] + L[4]) / 3;
    high = (L[5] + L[6] + L[7]) / 3;
  }
  const ease = (prev, t) => prev + (t - prev) * (1 - Math.pow(1 - (t > prev ? 0.6 : 0.08), fk));
  sm.bass = ease(sm.bass, bass); sm.mid = ease(sm.mid, mid); sm.high = ease(sm.high, high);
  if (energyLevel() >= 2 && now - lastEnergyWrite < 32) return;
  lastEnergyWrite = now;
  const st = target.style;
  put(st, '--pulse', cur); put(st, '--bass', sm.bass); put(st, '--mid', sm.mid); put(st, '--high', sm.high); put(st, '--kick', kick);
}
const sm = { bass: 0, mid: 0, high: 0 };
let kick = 0;

// Vars go only to the layers that actually react (not the whole player), so one bass hit
// doesn't make iOS restyle every element in the sheet.
let targets = [];
export function setBeatTarget(el) {
  target = el;
  targets = el ? Array.from(el.querySelectorAll('.np-art, .np-scene, .np-bg, .np-blobs')) : [];
  for (const k in lastV) delete lastV[k];
}

// Levels (0..1) for every band at the current playback time, or null if not analysed yet.
export function bandLevels(ahead = 0) {
  const t = current();
  const bands = t && spectra.get(t.id);
  if (!bands || audioElement.paused) return null;
  const i = Math.floor((audioElement.currentTime + ahead) * 50);
  return bands.map((e) => e[i] || 0);
}

export async function setBeat(on) {
  enabled = on;
  Preferences.set({ key: 'beat', value: on ? '1' : '0' });
  if (on) {
    const t = current();
    const p = t && pending.get(t.id);
    if (p) analyse(t.id, p.parts, p.mime); else if (t && !envs.has(t.id)) status('złapie od następnego utworu');
    if (!raf) raf = requestAnimationFrame(loop);
  } else {
    for (const el of targets) { el.style.setProperty('--pulse', '1'); ['--bass', '--mid', '--high', '--kick'].forEach((k) => el.style.setProperty(k, '0')); }
    for (const k in lastV) delete lastV[k];
  }
  subs.forEach((f) => f(enabled));
}

export async function restoreBeat() {
  const { value } = await Preferences.get({ key: 'beat' });
  if (value !== '0') setBeat(true); // on by default (it no longer touches playback)
}
