// Lifecycle probe: logs what is actually alive in each app state, so "Kopiuj logi" shows
// whether anything keeps working in the background (instead of guessing).
import { audioElement, videoElement } from './player.js';

let frames = 0, probe = null;
const count = () => { frames++; requestAnimationFrame(count); };
requestAnimationFrame(count);

function snapshot(tag) {
  const anims = document.getAnimations?.() || [];
  const running = anims.filter((a) => a.playState === 'running').length;
  const media = (el) => (el.paused ? 'pauza' : 'gra') + (el.src || el.srcObject ? '' : ' (pusty)');
  console.log(`[life] ${tag}: ukryta=${document.hidden} audio=${media(audioElement)} video=${media(videoElement)} animacje=${running}/${anims.length} klatki/30s=${frames} lite=${document.documentElement.classList.contains('lite')}`);
  frames = 0;
}

document.addEventListener('visibilitychange', () => {
  snapshot(document.hidden ? 'w tle' : 'na wierzchu');
  clearInterval(probe);
  probe = setInterval(() => snapshot(document.hidden ? 'w tle (co 30 s)' : 'na wierzchu (co 30 s)'), 30000);
});
['play', 'pause'].forEach((ev) => audioElement.addEventListener(ev, () => snapshot(`audio ${ev}`)));
probe = setInterval(() => snapshot('na wierzchu (co 30 s)'), 30000);
