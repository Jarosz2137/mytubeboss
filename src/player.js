// Playback engine: one <video> element for both audio and music videos,
// a queue, autoplay radio, and lock-screen / Dynamic Island metadata.
import { useSyncExternalStore } from 'react';
import { audioUrl, videoUrl, upNext } from './yt.js';

const el = document.createElement('video');
el.playsInline = true;
el.setAttribute('playsinline', '');
el.setAttribute('webkit-playsinline', '');
el.preload = 'auto';
el.className = 'engine';

let state = {
  queue: [],
  index: -1,
  playing: false,
  loading: false,
  mode: 'audio', // 'audio' | 'video'
  time: 0,
  duration: 0,
  error: '',
};
const subs = new Set();
const set = (patch) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
export const usePlayer = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);
export const current = () => state.queue[state.index];
export const videoElement = el;

let loadToken = 0;

async function load(startAt = 0) {
  const track = current();
  if (!track) return;
  const token = ++loadToken;
  set({ loading: true, error: '', time: startAt, duration: track.duration || 0 });
  updateMediaSession();
  try {
    const url = state.mode === 'video' ? await videoUrl(track.id) : await audioUrl(track.id);
    if (token !== loadToken) return;
    el.src = url;
    if (startAt) {
      el.addEventListener('loadedmetadata', () => { el.currentTime = startAt; }, { once: true });
    }
    await el.play();
  } catch (e) {
    if (token !== loadToken) return;
    console.error(e);
    set({ loading: false, playing: false, error: 'Nie udało się odpalić utworu: ' + (e?.message || e) });
  }
}

export function playList(tracks, startIndex = 0) {
  set({ queue: tracks.slice(), index: startIndex });
  load();
}

export function playNow(track) {
  playList([track], 0);
}

export function addNext(track) {
  const q = state.queue.slice();
  q.splice(state.index + 1, 0, track);
  set({ queue: q });
  if (state.index < 0) { set({ index: 0 }); load(); }
}

export function jump(i) {
  if (i < 0 || i >= state.queue.length) return;
  set({ index: i });
  load();
}

export function toggle() {
  if (!current()) return;
  if (el.paused) el.play().catch(() => {});
  else el.pause();
}

export async function next() {
  if (state.index < state.queue.length - 1) return jump(state.index + 1);
  // End of queue -> radio from the current track.
  const t = current();
  if (!t) return;
  try {
    const more = await upNext(t.id);
    if (more.length) {
      set({ queue: [...state.queue, ...more] });
      jump(state.index + 1);
    }
  } catch (e) {
    console.warn('radio failed', e);
  }
}

export function prev() {
  if (el.currentTime > 4 || state.index === 0) { el.currentTime = 0; return; }
  jump(state.index - 1);
}

export function seek(sec) {
  if (Number.isFinite(sec)) el.currentTime = sec;
}

export function setMode(mode) {
  if (mode === state.mode) return;
  const at = el.currentTime || 0;
  set({ mode });
  if (current()) load(at);
}

/* -------- element events -------- */
el.addEventListener('playing', () => set({ playing: true, loading: false }));
el.addEventListener('pause', () => set({ playing: false }));
el.addEventListener('waiting', () => set({ loading: true }));
el.addEventListener('canplay', () => set({ loading: false }));
el.addEventListener('timeupdate', () => {
  set({ time: el.currentTime, duration: Number.isFinite(el.duration) ? el.duration : state.duration });
  updatePosition();
});
el.addEventListener('ended', () => next());
el.addEventListener('error', () => {
  if (!el.src) return;
  set({ loading: false, playing: false, error: 'Stream się wysypał. Spróbuj ponownie albo pomiń.' });
});

/* -------- lock screen / Dynamic Island -------- */
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = current();
  if (!t) return;
  const art = t.thumb ? [{ src: t.thumb, sizes: '1200x1200', type: 'image/jpeg' }] : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.subtitle,
    album: t.album?.name || '',
    artwork: art,
  });
}

function updatePosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = el.duration;
  if (!Number.isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({ duration: d, position: Math.min(el.currentTime, d), playbackRate: el.playbackRate || 1 });
  } catch { /* ignore */ }
}

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const h = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* unsupported */ } };
  h('play', () => el.play());
  h('pause', () => el.pause());
  h('nexttrack', () => next());
  h('previoustrack', () => prev());
  h('seekto', (d) => seek(d.seekTime));
  h('seekbackward', (d) => seek(el.currentTime - (d.seekOffset || 10)));
  h('seekforward', (d) => seek(el.currentTime + (d.seekOffset || 10)));
}
