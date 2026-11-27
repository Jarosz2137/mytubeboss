// Lifecycle probe: logs what is actually alive in each app state, so "Kopiuj logi" shows
// whether anything keeps working in the background (instead of guessing).
import { audioElement, videoElement } from './player.js';

let frames = 0, probe = null;
// Frame stats (iOS gives web code no CPU% / RAM numbers - those need the native side in the next IPA;
// here we measure what the user feels: frame times and main-thread lag).
let lastF = 0, slowF = 0, worstF = 0;
const count = (now) => {
  frames++;
  if (lastF && !document.hidden) { const dt = now - lastF; if (dt > 50) slowF++; if (dt > worstF) worstF = dt; }
  lastF = now; requestAnimationFrame(count);
};
requestAnimationFrame(count);

// What happened recently: every tagged log line ([beat], [prefetch], [SABR], [ota], ...) is remembered
// for a few seconds, so a spike can say what it happened during.
const recent = [];
// Black box: the last log lines survive a web-view kill (localStorage), so after a crash the next
// session prints what was happening right before it.
const BOX = 'mtb-blackbox';
let box = [], boxDirty = false;
try {
  const prev = JSON.parse(localStorage.getItem(BOX) || 'null');
  if (prev && !prev.clean && prev.lines?.length) {
    setTimeout(() => {
      console.warn(`[crash] poprzednia sesja urwała się nagle (${new Date(prev.at).toLocaleTimeString()}), ostatnie zdarzenia:`);
      prev.lines.forEach((l) => console.warn('[crash] ' + l));
    }, 500);
  }
} catch { /* */ }
const saveBox = (clean = false) => { try { localStorage.setItem(BOX, JSON.stringify({ at: Date.now(), clean, lines: box })); } catch { /* */ } boxDirty = false; };
setInterval(() => { if (boxDirty) saveBox(); }, 1000);
window.addEventListener('pagehide', () => saveBox(true));
for (const k of ['log', 'info', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    const line = typeof a[0] === 'string' ? a[0] : '';
    if (line && !line.startsWith('[DEBUG]') && !line.startsWith('[crash]')) {
      box.push(new Date().toLocaleTimeString() + ' ' + line.slice(0, 220)); if (box.length > 40) box.shift(); boxDirty = true;
    }
    const m = typeof a[0] === 'string' && a[0].match(/^\[([a-zA-Z]+)\]/);
    if (m && m[1] !== 'life' && m[1] !== 'DEBUG') { recent.push([performance.now(), m[1]]); if (recent.length > 40) recent.shift(); }
    orig(...a);
  };
}
const during = () => {
  const t = performance.now();
  const tags = [...new Set(recent.filter(([at]) => t - at < 4000).map(([, tag]) => tag))];
  return tags.length ? tags.join('+') : 'nic szczególnego';
};

// Main-thread lag: a 250 ms timer that fires late = the CPU was busy with our JS / layout.
let lagSum = 0, lagN = 0, lagMax = 0, expect = performance.now() + 250;
setInterval(() => {
  const now = performance.now(), lag = Math.max(0, now - expect);
  expect = now + 250;
  if (document.hidden) return;
  lagSum += lag; lagN++; if (lag > lagMax) lagMax = lag;
  if (lag > 120) console.log(`[life] SKOK: wątek zablokowany ${Math.round(lag)} ms, w trakcie: ${during()}`);
}, 250);

function snapshot(tag) {
  const anims = document.getAnimations?.() || [];
  const running = anims.filter((a) => a.playState === 'running').length;
  const media = (el) => (el.paused ? 'pauza' : 'gra') + (el.src || el.srcObject ? '' : ' (pusty)');
  const avgLag = lagN ? Math.round(lagSum / lagN) : 0;
  const nodes = document.getElementsByTagName('*').length;
  console.log(`[life] ${tag}: ukryta=${document.hidden} audio=${media(audioElement)} video=${media(videoElement)} animacje=${running}/${anims.length} fps=${Math.round(frames / 30)} wolne_klatki=${slowF} najgorsza=${Math.round(worstF)}ms lag_śr=${avgLag}ms lag_max=${Math.round(lagMax)}ms elementy=${nodes} lite=${document.documentElement.classList.contains('lite')} ostatnio=${during()}`);
  frames = 0; slowF = 0; worstF = 0; lagSum = 0; lagN = 0; lagMax = 0;
}

document.addEventListener('visibilitychange', () => {
  snapshot(document.hidden ? 'w tle' : 'na wierzchu');
  clearInterval(probe);
  probe = setInterval(() => snapshot(document.hidden ? 'w tle (co 30 s)' : 'na wierzchu (co 30 s)'), 30000);
});
['play', 'pause'].forEach((ev) => audioElement.addEventListener(ev, () => snapshot(`audio ${ev}`)));
probe = setInterval(() => snapshot('na wierzchu (co 30 s)'), 30000);
