// Experimental: pulse the cover to the bass of the playing song (Web Audio analyser on the <audio> element).
// Routing audio through Web Audio may affect background play on iOS, so it is opt-in.
import { Preferences } from '@capacitor/preferences';
import { audioElement } from './player.js';

let ctx, an, data, raf = 0, target = null, avg = 0, cur = 1, enabled = false;
const subs = new Set();
export const beatOn = () => enabled;
export const onBeat = (f) => { subs.add(f); return () => subs.delete(f); };

function setup() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  const src = ctx.createMediaElementSource(audioElement);
  an = ctx.createAnalyser();
  an.fftSize = 512;
  an.smoothingTimeConstant = 0.5;
  src.connect(an);
  an.connect(ctx.destination);
  data = new Uint8Array(an.frequencyBinCount);
  audioElement.addEventListener('play', () => ctx.resume().catch(() => {}));
  document.addEventListener('visibilitychange', () => ctx.resume().catch(() => {}));
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (!target || document.hidden) return;
  an.getByteFrequencyData(data);
  let e = 0;
  for (let i = 1; i < 8; i++) e += data[i]; // ~40-250 Hz
  e /= 7;
  avg = avg * 0.94 + e * 0.06;
  const kick = Math.max(0, e - avg * 1.12) / 255;
  cur = Math.max(1 + Math.min(0.09, kick * 0.9), cur * 0.9 + 0.1);
  target.style.setProperty('--pulse', cur.toFixed(4));
}

export function setBeatTarget(el) { target = el; }

export async function setBeat(on) {
  enabled = on;
  Preferences.set({ key: 'beat', value: on ? '1' : '0' });
  if (on) {
    try { setup(); ctx.resume(); } catch (e) { console.warn('[beat]', e); enabled = false; }
    if (enabled && !raf) loop();
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
