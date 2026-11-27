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
export const BAND_HZ = [55, 110, 220, 440, 880, 1600, 2800, 3700];
const busy = new Set();
let raf = 0, target = null, cur = 1, enabled = false;
const subs = new Set();
export const beatOn = () => enabled;
export const onBeat = (f) => { subs.add(f); return () => subs.delete(f); };
export let beatStatus = '';
const status = (s) => { beatStatus = s; subs.forEach((f) => f(enabled)); };

async function analyse(id, parts, mime) {
  if (envs.has(id) || busy.has(id) || !parts?.length) return;
  busy.add(id);
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const bytes = await new Blob(parts, { type: (mime || '').split(';')[0] }).arrayBuffer();
    const decoded = await new OAC(1, RATE, RATE).decodeAudioData(bytes);
    // one offline render: kick low-pass on channel 0, band-passes for the visualizer on 1..N
    const B = BAND_HZ.length;
    const off = new OAC(B + 1, decoded.length, RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    const merger = off.createChannelMerger(B + 1);
    const lp = off.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 150;
    src.connect(lp); lp.connect(merger, 0, 0);
    BAND_HZ.forEach((hz, i) => {
      const bp = off.createBiquadFilter();
      bp.type = hz < 100 ? 'lowpass' : hz > 3500 ? 'highpass' : 'bandpass';
      bp.frequency.value = hz; bp.Q.value = 1.1;
      src.connect(bp); bp.connect(merger, 0, i + 1);
    });
    merger.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    const data = rendered.getChannelData(0);
    const rms = (ch) => {
      const n = Math.floor(ch.length / FRAME), out = new Float32Array(n);
      for (let i = 0; i < n; i++) { let s2 = 0; for (let j = i * FRAME, e = j + FRAME; j < e; j++) s2 += ch[j] * ch[j]; out[i] = Math.sqrt(s2 / FRAME); }
      return out;
    };
    const bands = [];
    for (let b = 0; b < B; b++) {
      const e = rms(rendered.getChannelData(b + 1));
      const sorted = Array.from(e).sort((x, y) => x - y);
      const p = sorted[Math.floor(sorted.length * 0.985)] || 1e-6;
      for (let i = 0; i < e.length; i++) e[i] = Math.min(1, Math.pow(e[i] / p, 0.8));
      bands.push(e);
    }
    spectra.set(id, bands);
    while (spectra.size > 6) spectra.delete(spectra.keys().next().value);
    const n = Math.floor(data.length / FRAME);
    const energy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = i * FRAME, e = j + FRAME; j < e; j++) s += data[j] * data[j];
      energy[i] = Math.sqrt(s / FRAME);
    }
    // onset = energy above the local (0.5 s) average, normalised by a high percentile
    const env = new Float32Array(n);
    let avg = energy[0] || 0;
    for (let i = 0; i < n; i++) { avg = avg * 0.96 + energy[i] * 0.04; env[i] = Math.max(0, energy[i] - avg * 1.08); }
    const sorted = Array.from(env).sort((a, b) => a - b);
    const p = sorted[Math.floor(sorted.length * 0.97)] || 1e-6;
    for (let i = 0; i < n; i++) env[i] = Math.min(1, env[i] / p);
    envs.set(id, env);
    while (envs.size > 6) envs.delete(envs.keys().next().value);
    console.info('[beat] analysed', id, n, 'frames');
    if (current()?.id === id) status('');
  } catch (e) {
    console.warn('[beat] analyse failed', e?.message || e);
    if (current()?.id === id) status('nie da się przeanalizować tego utworu');
  } finally { busy.delete(id); }
}

// player.js announces every fully downloaded track
const pending = new Map();
window.addEventListener('mtb-audio', (e) => {
  const { id, parts, mime } = e.detail || {};
  pending.set(id, { parts, mime });
  while (pending.size > 4) pending.delete(pending.keys().next().value);
  analyse(id, parts, mime);
});

function loop() {
  raf = requestAnimationFrame(loop);
  if (!target || document.hidden) return;
  const t = current();
  const env = t && envs.get(t.id);
  let v = 0;
  if (env && !audioElement.paused) {
    const i = Math.floor(audioElement.currentTime * 50);
    v = Math.max(env[i] || 0, (env[i + 1] || 0) * 0.6);
  }
  cur = Math.max(1 + v * 0.11, cur * 0.86 + 0.14);
  kick = Math.max(v, kick * 0.82); // fast-decaying flash on every bass hit
  // Whole scene: bass / mid / high energy, fast attack and slow release so quiet parts calm down.
  const L = bandLevels();
  let bass = 0, mid = 0, high = 0;
  if (L) {
    bass = Math.max((L[0] + L[1]) / 2, v);
    mid = (L[2] + L[3] + L[4]) / 3;
    high = (L[5] + L[6] + L[7]) / 3;
  }
  const ease = (prev, t) => prev + (t - prev) * (t > prev ? 0.6 : 0.08);
  sm.bass = ease(sm.bass, bass); sm.mid = ease(sm.mid, mid); sm.high = ease(sm.high, high);
  const st = target.style;
  st.setProperty('--pulse', cur.toFixed(4));
  st.setProperty('--bass', sm.bass.toFixed(3));
  st.setProperty('--mid', sm.mid.toFixed(3));
  st.setProperty('--high', sm.high.toFixed(3));
  st.setProperty('--kick', kick.toFixed(3));
}
const sm = { bass: 0, mid: 0, high: 0 };
let kick = 0;

export function setBeatTarget(el) { target = el; }

// Levels (0..1) for every band at the current playback time, or null if not analysed yet.
export function bandLevels() {
  const t = current();
  const bands = t && spectra.get(t.id);
  if (!bands || audioElement.paused) return null;
  const i = Math.floor(audioElement.currentTime * 50);
  return bands.map((e) => e[i] || 0);
}

export async function setBeat(on) {
  enabled = on;
  Preferences.set({ key: 'beat', value: on ? '1' : '0' });
  if (on) {
    const t = current();
    const p = t && pending.get(t.id);
    if (p) analyse(t.id, p.parts, p.mime); else if (t && !envs.has(t.id)) status('złapie od następnego utworu');
    if (!raf) loop();
  } else {
    cancelAnimationFrame(raf); raf = 0;
    target?.style.setProperty('--pulse', '1');
    ['--bass', '--mid', '--high', '--kick'].forEach((k) => target?.style.setProperty(k, '0'));
  }
  subs.forEach((f) => f(enabled));
}

export async function restoreBeat() {
  const { value } = await Preferences.get({ key: 'beat' });
  if (value !== '0') setBeat(true); // on by default (it no longer touches playback)
}
