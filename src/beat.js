// BEAT: pulse the cover to the bass of the playing song.
// iOS gives Web Audio silence for MediaSource playback, so instead of analysing the live output
// we decode the already-downloaded audio file offline (8 kHz mono, low-passed), turn it into a
// bass "kick" envelope (one value per 20 ms) and drive the pulse from the element's currentTime.
// Playback itself never goes through Web Audio, so background play is unaffected.
import { Preferences } from '@capacitor/preferences';
import { audioElement, current } from './player.js';

const RATE = 8000, FRAME = 160; // 20 ms frames
const envs = new Map(); // track id -> Float32Array (0..1)
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
    // low-pass the whole song to keep the kick/bass only
    const off = new OAC(1, decoded.length, RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    const lp = off.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 150;
    src.connect(lp); lp.connect(off.destination); src.start();
    const data = (await off.startRendering()).getChannelData(0);
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
  if (enabled) analyse(id, parts, mime);
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
  cur = Math.max(1 + v * 0.085, cur * 0.88 + 0.12);
  target.style.setProperty('--pulse', cur.toFixed(4));
}

export function setBeatTarget(el) { target = el; }

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
  }
  subs.forEach((f) => f(enabled));
}

export async function restoreBeat() {
  const { value } = await Preferences.get({ key: 'beat' });
  if (value === '1') setBeat(true);
}
