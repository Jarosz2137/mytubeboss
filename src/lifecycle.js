import { profStart, profEnd, profJob, profReport, profilerPanel, profIsolated } from './profiler.js';
// Lifecycle probe: logs what is actually alive in each app state, so "Kopiuj logi" shows
// whether anything keeps working in the background (instead of guessing).
import { audioElement, videoElement } from './player.js';

let frames = 0, probe = null, raf = 0;
let lastF = null, slowF = 0, worstF = 0, frameMs = 0, samples = [];
let visible = !document.hidden, windowStart = performance.now();
const count = (now) => {
  raf = 0;
  if (!visible || document.hidden) { lastF = null; return; }
  if (lastF !== null) {
    const dt = now - lastF;
    frames++; frameMs += dt;
    if (dt > 50) slowF++;
    worstF = Math.max(worstF, dt);
    samples.push(dt);
  }
  lastF = now;
  raf = requestAnimationFrame(count);
};
function startFrames() { if (visible && !raf) raf = requestAnimationFrame(count); }
startFrames();

// What happened recently: every tagged log line ([beat], [prefetch], [SABR], [ota], ...) is remembered
// for a few seconds, so a spike can say what it happened during.
const recent = [];
for (const k of ['log', 'info', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
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
  if (document.hidden || !visible) return;
  lagSum += lag; lagN++; if (lag > lagMax) lagMax = lag;
  if (lag > 120) console.log(`[life] SKOK: wątek zablokowany ${Math.round(lag)} ms, w trakcie: ${during()}`);
}, 250);

function snapshot(tag) {
  const start = performance.now();
  const anims = document.getAnimations?.() || [];
  const active = anims.filter((a) => a.playState === 'running');
  const running = active.length;
  const groups = {};
  for (const a of active) {
    const name = a.animationName || a.transitionProperty || 'other';
    groups[name] = (groups[name] || 0) + 1;
  }
  const top = Object.entries(groups).sort((a,b) => b[1]-a[1]).slice(0,8).map(([k,v]) => k+':'+v).join(',') || '-';
  const sceneEl = document.querySelector('.np.open .np-scene');
  const scene = sceneEl?.querySelector('canvas')?.className.match(/geometry-(\w+)/)?.[1] ||
    Array.from(sceneEl?.classList || []).find(c => c.startsWith('sc-'))?.slice(3) || '-';
  const sorted = samples.slice().sort((a,b)=>a-b);
  const p95 = sorted.length ? Math.round(sorted[Math.ceil(sorted.length*.95)-1]) : 0;
  const fps = frameMs > 0 ? (frames*1000/frameMs).toFixed(1) : '-';
  const period = Math.round(performance.now()-windowStart);
  const media = (el) => (el.paused ? 'pauza' : 'gra') + (el.src || el.srcObject ? '' : ' (pusty)');
  const avgLag = lagN ? Math.round(lagSum / lagN) : 0;
  const nodes = document.getElementsByTagName('*').length;
  console.log(`[life] ${tag}: ukryta=${document.hidden} audio=${media(audioElement)} video=${media(videoElement)} animacje=${running}/${anims.length} scena=${scene} fps=${fps} okno=${period}ms pomiar_klatek=${Math.round(frameMs)}ms probki=${frames} p95=${p95}ms aktywne=${top} wolne_klatki=${slowF} najgorsza=${Math.round(worstF)}ms lag_śr=${avgLag}ms lag_max=${Math.round(lagMax)}ms elementy=${nodes} lite=${document.documentElement.classList.contains('lite')} ostatnio=${during()}`);
  profReport(anims);
  const overhead = performance.now()-start;
  if (overhead > 8) console.info('[life] snapshot overhead '+overhead.toFixed(2)+' ms');
  frames = 0; slowF = 0; worstF = 0; frameMs = 0; samples = []; lastF = null; windowStart = performance.now(); lagSum = 0; lagN = 0; lagMax = 0;
}

document.addEventListener('visibilitychange', () => {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  lastF = null;
  snapshot(document.hidden ? 'w tle' : 'na wierzchu');
  visible = !document.hidden;
  expect = performance.now() + 250;
  startFrames();
  clearInterval(probe);
  probe = setInterval(() => snapshot(document.hidden ? 'w tle (co 30 s)' : 'na wierzchu (co 30 s)'), 30000);
});
['play', 'pause'].forEach((ev) => audioElement.addEventListener(ev, () => snapshot(`audio ${ev}`)));
probe = setInterval(() => snapshot(document.hidden ? 'w tle (co 30 s)' : 'na wierzchu (co 30 s)'), 30000);
