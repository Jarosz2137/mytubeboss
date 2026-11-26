// Playback engine: one <video> element for both audio and music videos,
// a queue, autoplay radio, and lock-screen / Dynamic Island metadata.
import { useSyncExternalStore } from 'react';
import { streamUrl, audioBlobUrl, sabrAudioBlobUrl, hlsUrl, counterpartId, CLIENTS, upNext } from './yt.js';
import * as ytmod from './yt.js';

// iOS pauses <video> when the app goes to the background, but keeps <audio> playing.
// So: <audio> for "Utwór", <video> only while the music video is on screen.
const videoEl = document.createElement('video');
videoEl.playsInline = true;
videoEl.setAttribute('playsinline', '');
videoEl.setAttribute('webkit-playsinline', '');
videoEl.preload = 'auto';
videoEl.className = 'engine';
const audioEl = document.createElement('audio');
audioEl.preload = 'auto';
let el = audioEl;

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
export const videoElement = videoEl;

let loadToken = 0;
let lastBlobUrl = null;

// Ready-to-play audio for upcoming tracks (SABR downloads take a few seconds).
const ready = new Map(); // videoId -> blob URL
let prefetching = null;
async function prefetchNext() {
  const nextTrack = state.queue[state.index + 1];
  if (!nextTrack || ready.has(nextTrack.id) || prefetching === nextTrack.id) return;
  prefetching = nextTrack.id;
  try {
    const u = await sabrAudioBlobUrl(nextTrack.id, null, 'WEB');
    ready.set(nextTrack.id, u);
    // keep memory in check
    while (ready.size > 3) { const [k, v] = ready.entries().next().value; URL.revokeObjectURL(v); ready.delete(k); }
    console.info('[prefetch] ready', nextTrack.title);
  } catch (e) {
    console.warn('[prefetch] failed', e?.message);
  } finally {
    prefetching = null;
  }
}

// Resolves true once the element actually starts, false on error/timeout.
function tryPlay(url, startAt, token) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      el.removeEventListener('playing', onOk);
      el.removeEventListener('error', onErr);
      clearTimeout(t);
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onErr = () => finish(false);
    const t = setTimeout(() => finish(false), 15000);
    el.addEventListener('playing', onOk);
    el.addEventListener('error', onErr);
    el.src = url;
    if (startAt) el.addEventListener('loadedmetadata', () => { el.currentTime = startAt; }, { once: true });
    el.play().catch(() => {});
    if (token !== loadToken) finish(false);
  });
}

async function load(startAt = 0) {
  const track = current();
  if (!track) return;
  const token = ++loadToken;
  const mode = state.mode;
  const log = [];
  set({ loading: true, error: '', time: startAt, duration: track.duration || 0 });
  updateMediaSession();
  suppressErrors = true;

  // Already downloaded in the background?
  if (ready.has(track.id)) {
    const u = ready.get(track.id);
    ready.delete(track.id);
    if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
    lastBlobUrl = u;
    if (await tryPlay(u, startAt, token)) { suppressErrors = false; set({ error: '' }); prefetchNext(); return; }
  }

  // Fastest path that works today: the iOS client's HLS stream (Safari plays it natively).
  // In "Utwór" mode the picture just isn't shown.
  try {
    const hls = await hlsUrl(track.id);
    if (token !== loadToken) return;
    if (await tryPlay(hls, startAt, token)) { suppressErrors = false; set({ error: '' }); prefetchNext(); return; }
    log.push('HLS: media ' + (el.error?.code ?? 'timeout'));
  } catch (e) {
    log.push('HLS: ' + String(e?.message || e).slice(0, 80));
  }

  // Album track without HLS -> play its linked music video's HLS (same song).
  try {
    const cid = await counterpartId(track.id);
    if (token !== loadToken) return;
    if (cid) {
      const hls = await hlsUrl(cid);
      if (await tryPlay(hls, startAt, token)) { suppressErrors = false; set({ error: '' }); prefetchNext(); return; }
      log.push('HLS teledysku: media ' + (el.error?.code ?? 'timeout'));
    } else log.push('brak teledysku');
  } catch (e) {
    log.push('HLS teledysku: ' + String(e?.message || e).slice(0, 80));
  }

  // Audio fallback: SABR (the path YouTube's own web player uses).
  if (mode === 'audio') {
    for (const sc of ['WEB', 'MWEB']) {
      try {
        set({ error: 'Ładuję utwór…' });
        const u = await sabrAudioBlobUrl(track.id, (b) => { if (token === loadToken) set({ error: 'Ładuję utwór (' + sc + ')… ' + (b / 1048576).toFixed(1) + ' MB' }); }, sc);
        if (token !== loadToken) return;
        if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
        lastBlobUrl = u;
        if (await tryPlay(u, startAt, token)) { suppressErrors = false; set({ error: '' }); prefetchNext(); return; }
        log.push('SABR ' + sc + ': media ' + (el.error?.code ?? 'timeout'));
      } catch (e) {
        log.push(String(e?.message || e).slice(0, 120));
      }
    }
    set({ error: '' });
  }

  for (const client of CLIENTS) {
    if (token !== loadToken) return;
    try {
      const url = await streamUrl(track.id, mode, client);
      if (!url) { log.push(client + ': brak'); continue; }
      if (await tryPlay(url, startAt, token)) { suppressErrors = false; return; }
      log.push(client + ': media ' + (el.error?.code ?? 'timeout'));
    } catch (e) {
      log.push(client + ': ' + String(e?.message || e).slice(0, 60));
    }
  }

  // Last resort for audio: download through native HTTP and play from memory.
  if (mode === 'audio' && token === loadToken) {
    try {
      set({ error: 'Ładuję utwór w całości…' });
      const blobUrl = await audioBlobUrl(track.id);
      if (token !== loadToken) return;
      if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
      lastBlobUrl = blobUrl;
      if (await tryPlay(blobUrl, startAt, token)) { suppressErrors = false; set({ error: '' }); return; }
      log.push('blob: media ' + (el.error?.code ?? 'timeout'));
    } catch (e) {
      log.push('blob: ' + String(e?.message || e).slice(0, 80));
    }
  }

  suppressErrors = false;
  if (token !== loadToken) return;
  console.error('playback failed', log);
  set({ loading: false, playing: false, error: 'Nie gra. PO: ' + ytmod.poStatus + ' | ' + log.join(' | ') });
}

let suppressErrors = false;

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
  const old = el;
  el = mode === 'video' ? videoEl : audioEl;
  suppressErrors = true;
  old.pause();
  old.removeAttribute('src');
  old.load();
  set({ mode });
  if (current()) load(at);
}

// Leaving the app while watching the video -> carry on as audio, like Premium.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.mode === 'video' && state.playing) setMode('audio');
});

/* -------- element events -------- */
const on = (type, fn) => [audioEl, videoEl].forEach((m) => m.addEventListener(type, (e) => { if (e.target === el) fn(e); }));
on('playing', () => set({ playing: true, loading: false }));
on('pause', () => set({ playing: false }));
on('waiting', () => set({ loading: true }));
on('canplay', () => set({ loading: false }));
on('timeupdate', () => {
  set({ time: el.currentTime, duration: Number.isFinite(el.duration) ? el.duration : state.duration });
  updatePosition();
});
on('ended', () => next());
on('error', () => {
  if (!el.src || suppressErrors) return;
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
