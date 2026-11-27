// Playback engine: one <video> element for both audio and music videos,
// a queue, autoplay radio, and lock-screen / Dynamic Island metadata.
import { getDownload } from './offline.js';
import { useSyncExternalStore } from 'react';
import { streamUrl, audioBlobUrl, sabrAudioChunks, hlsUrl, counterpartId, CLIENTS, upNext } from './yt.js';
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
  repeat: 'off', // 'off' | 'all' | 'one'
  shuffle: false,
  liked: {},
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

// Playback position lives in its own tiny store so the whole UI doesn't re-render 4x/second.
let timeState = { time: 0, duration: 0 };
const tsubs = new Set();
const setTime = (patch) => { timeState = { ...timeState, ...patch }; tsubs.forEach((f) => f()); };
export const useTime = () => useSyncExternalStore((f) => { tsubs.add(f); return () => tsubs.delete(f); }, () => timeState);
export const current = () => state.queue[state.index];
export const videoElement = videoEl;
export const audioElement = audioEl;

// Output picker (iPhone speaker / headphones / Bluetooth / AirPlay). The playing elements use
// MSE with remote playback disabled, so we open the iOS route picker from a silent helper element;
// the route it picks applies to the whole app's audio.
const routeEl = document.createElement('video');
routeEl.setAttribute('x-webkit-airplay', 'allow');
routeEl.setAttribute('playsinline', '');
routeEl.muted = true;
routeEl.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px';
document.addEventListener('DOMContentLoaded', () => document.body.appendChild(routeEl));
if (document.body) document.body.appendChild(routeEl);
export const canPickOutput = () => typeof routeEl.webkitShowPlaybackTargetPicker === 'function';
export function pickOutput() {
  try { routeEl.webkitShowPlaybackTargetPicker(); return true; }
  catch (e) { console.warn('[route]', e); return false; }
}

let loadToken = 0;
let lastBlobUrl = null;

// Ready-to-play audio for upcoming tracks: { mime, durationMs, parts }.
const ready = new Map();
let prefetching = null;
async function prefetchNext() {
  const nextTrack = state.queue[state.index + 1];
  if (!nextTrack || ready.has(nextTrack.id) || prefetching === nextTrack.id) return;
  prefetching = nextTrack.id;
  try {
    const r = await sabrAudioChunks(nextTrack.id, {}, 'WEB');
    ready.set(nextTrack.id, r);
    while (ready.size > 3) ready.delete(ready.keys().next().value);
    console.info('[prefetch] ready', nextTrack.title);
  } catch (e) {
    console.warn('[prefetch] failed', e?.message);
  } finally {
    prefetching = null;
  }
}

const MSClass = () => window.ManagedMediaSource || window.MediaSource || null;

// Feeds SABR chunks into (Managed)MediaSource: playback starts after the first
// few seconds arrive, duration is exact and seeking works.
function makeMse(meta, startAt, token) {
  const MS = MSClass();
  if (!MS || (MS.isTypeSupported && !MS.isTypeSupported(meta.mime))) return null;
  const ms = new MS();
  const queue = [];
  let sb = null, ended = false, first = true;
  try { el.disableRemotePlayback = true; } catch { /* */ }
  el.removeAttribute('src');
  if (MS !== window.MediaSource && 'srcObject' in el) {
    try { el.srcObject = ms; } catch { el.src = URL.createObjectURL(ms); }
  } else {
    el.src = URL.createObjectURL(ms);
  }
  const pump = () => {
    if (!sb || sb.updating) return;
    if (queue.length) { try { sb.appendBuffer(queue.shift()); } catch (e) { console.warn('[mse] append failed', e?.message); } return; }
    if (ended && ms.readyState === 'open') { try { ms.endOfStream(); } catch { /* */ } }
  };
  ms.addEventListener('sourceopen', () => {
    try { sb = ms.addSourceBuffer(meta.mime); } catch (e) { console.warn('[mse] addSourceBuffer', e?.message); return; }
    if (meta.durationMs) { try { ms.duration = meta.durationMs / 1000; } catch { /* */ } }
    sb.addEventListener('updateend', () => {
      if (first) {
        first = false;
        if (startAt) { try { el.currentTime = startAt; } catch { /* */ } }
        if (token === loadToken) el.play().catch(() => {});
      }
      pump();
    });
    pump();
  }, { once: true });
  console.info('[mse] using', MS === window.MediaSource ? 'MediaSource' : 'ManagedMediaSource');
  return { push(c) { queue.push(c); pump(); }, end() { ended = true; pump(); } };
}

function blobOf(r) {
  return URL.createObjectURL(new Blob(r.parts, { type: r.mime.split(';')[0] }));
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
    try { el.srcObject = null; } catch { /* */ }
    el.src = url;
    if (startAt) el.addEventListener('loadedmetadata', () => { el.currentTime = startAt; }, { once: true });
    el.play().catch(() => {});
    if (token !== loadToken) finish(false);
  });
}

// Lets other modules (BEAT analysis, offline downloads) reuse a track's fully downloaded audio.
function announce(id, r) {
  if (!r?.parts?.length) return;
  window.dispatchEvent(new CustomEvent('mtb-audio', { detail: { id, parts: r.parts, mime: r.mime, durationMs: r.durationMs } }));
}

async function load(startAt = 0) {
  const track = current();
  if (!track) return;
  const token = ++loadToken;
  const mode = state.mode;
  const log = [];
  set({ loading: true, error: '', guestLimited: false, loginPrompt: false });
  setTime({ time: startAt, duration: track.duration || 0 });
  updateMediaSession();
  suppressErrors = true;
  const done = () => { suppressErrors = false; set({ error: '' }); prefetchNext(); };

  if (mode === 'audio') {
    // 0) saved for offline on the phone
    const off = await getDownload(track.id).catch(() => null);
    if (token !== loadToken) return;
    if (off?.parts?.length) {
      if (off.durationMs) setTime({ duration: off.durationMs / 1000 });
      const ctl = makeMse(off, startAt, token);
      if (ctl) { off.parts.forEach((c) => ctl.push(c)); ctl.end(); announce(track.id, off); done(); return; }
    }
    // 1) already downloaded in the background
    const pre = ready.get(track.id);
    if (pre) {
      ready.delete(track.id);
      announce(track.id, pre);
      if (pre.durationMs) setTime({ duration: pre.durationMs / 1000 });
      const ctl = makeMse(pre, startAt, token);
      if (ctl) { pre.parts.forEach((c) => ctl.push(c)); ctl.end(); done(); return; }
      if (await tryPlay(blobOf(pre), startAt, token)) { done(); return; }
    }
    // 2) SABR streamed into MediaSource (starts after a few seconds of audio)
    for (const sc of ['WEB', 'MWEB']) {
      let ctl = null;
      try {
        const r = await sabrAudioChunks(track.id, {
          onMeta: (m) => {
            if (token !== loadToken) return;
            if (m.durationMs) setTime({ duration: m.durationMs / 1000 });
            ctl = makeMse(m, startAt, token);
          },
          onChunk: (c) => { if (token === loadToken) ctl?.push(c); },
          onProgress: (b) => { if (token === loadToken && !state.playing) set({ error: 'Ładuję utwór… ' + (b / 1048576).toFixed(1) + ' MB' }); },
        }, sc);
        if (token !== loadToken) return;
        announce(track.id, r);
        if (ctl) { ctl.end(); done(); return; }
        if (await tryPlay(blobOf(r), startAt, token)) { done(); return; }
        log.push('SABR ' + sc + ': media ' + (el.error?.code ?? 'timeout'));
      } catch (e) {
        if (token !== loadToken) return;
        if (e?.guestLimit) {
          // Not signed in: YouTube only gives guests the first ~70 s. Let that play, then explain.
          ctl?.end();
          suppressErrors = false;
          set({ guestLimited: true });
          return;
        }
        if (state.playing) {
          // Stream stopped mid-song (anonymous sessions get cut after ~1 min):
          // continue from the same spot via HLS instead of going silent.
          // Keep what's already buffered playing; only switch if an HLS stream exists.
          ctl?.end();
          const pos = el.currentTime || startAt;
          console.warn('[load] SABR cut at', pos.toFixed(1), 's, trying HLS without stopping');
          try {
            let hls = await hlsUrl(track.id).catch(() => null);
            if (!hls) { const cid = await counterpartId(track.id).catch(() => null); if (cid) hls = await hlsUrl(cid).catch(() => null); }
            if (token !== loadToken) return;
            if (hls && await tryPlay(hls, el.currentTime || pos, token)) { done(); return; }
          } catch { /* keep buffered audio */ }
          suppressErrors = false;
          set({ error: 'Bez logowania YouTube dał tylko część utworu' });
          return;
        }
        log.push(String(e?.message || e).slice(0, 120));
      }
    }
  }

  // 3) HLS (music videos, or the linked video of an album track)
  try {
    const hls = await hlsUrl(track.id);
    if (token !== loadToken) return;
    if (await tryPlay(hls, startAt, token)) { done(); return; }
    log.push('HLS: media ' + (el.error?.code ?? 'timeout'));
  } catch (e) {
    log.push('HLS: ' + String(e?.message || e).slice(0, 80));
  }
  try {
    const cid = await counterpartId(track.id);
    if (token !== loadToken) return;
    if (cid) {
      const hls = await hlsUrl(cid);
      if (await tryPlay(hls, startAt, token)) { done(); return; }
      log.push('HLS teledysku: media ' + (el.error?.code ?? 'timeout'));
    } else log.push('brak teledysku');
  } catch (e) {
    log.push('HLS teledysku: ' + String(e?.message || e).slice(0, 80));
  }

  // 4) direct URLs (rarely work nowadays)
  for (const client of CLIENTS) {
    if (token !== loadToken) return;
    try {
      const url = await streamUrl(track.id, mode, client);
      if (!url) { log.push(client + ': brak'); continue; }
      if (await tryPlay(url, startAt, token)) { done(); return; }
      log.push(client + ': media ' + (el.error?.code ?? 'timeout'));
    } catch (e) {
      log.push(client + ': ' + String(e?.message || e).slice(0, 60));
    }
  }

  suppressErrors = false;
  if (token !== loadToken) return;
  console.error('playback failed', log);
  // Track simply not available (removed, region-locked, invalid id) -> skip it, don't stall the queue.
  const unavailable = log.some((l) => /unavailable|niedost|invalid|login required|Music queue was empty/i.test(l));
  if (unavailable && state.index < state.queue.length - 1) {
    set({ error: 'Niedostępny na YouTube, pomijam…' });
    setTimeout(() => { if (token === loadToken) next(); }, 1200);
    return;
  }
  set({ loading: false, playing: false, error: (unavailable ? 'Ten utwór jest niedostępny na YouTube. ' : 'Nie gra. ') + 'PO: ' + ytmod.poStatus + ' | ' + log.join(' | ') });
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

let userPaused = false;
export function dismissLoginPrompt() { set({ loginPrompt: false }); }
export function toggle() {
  userPaused = !el.paused;
  if (!current()) return;
  if (el.paused) el.play().catch(() => {});
  else el.pause();
}

export async function next(auto = false) {
  if (auto && state.repeat === 'one') { el.currentTime = 0; el.play().catch(() => {}); return; }
  if (state.index < state.queue.length - 1) return jump(state.index + 1);
  if (state.repeat === 'all' && state.queue.length) return jump(0);
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
  if (!Number.isFinite(sec)) return;
  el.currentTime = sec;
  setTime({ time: sec }); // no flicker back to the old position
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
// Leaving the app with a music video: keep it going as Picture-in-Picture if iOS allows,
// otherwise fall back to audio so the music doesn't stop.
videoEl.setAttribute('autopictureinpicture', '');
try { videoEl.autoPictureInPicture = true; } catch {}
let pipPendingAt = 0; // PiP is starting (iOS pauses the video for a moment while it animates)
const pipPending = () => Date.now() - pipPendingAt < 3000;
export const inPip = () => videoEl.webkitPresentationMode === 'picture-in-picture' || document.pictureInPictureElement === videoEl;
const pipOrStarting = () => inPip() || pipPending();
const keepVideoGoing = () => { if (state.mode === 'video' && !userPaused && videoEl.paused) videoEl.play().catch(() => {}); };
videoEl.addEventListener('webkitpresentationmodechanged', () => {
  console.info('[pip] mode', videoEl.webkitPresentationMode);
  if (inPip()) { pipPendingAt = 0; keepVideoGoing(); }
  set({ pip: inPip() });
});
videoEl.addEventListener('enterpictureinpicture', () => { pipPendingAt = 0; keepVideoGoing(); set({ pip: true }); });
videoEl.addEventListener('leavepictureinpicture', () => set({ pip: false }));
export function pipIfVideo() {
  if (state.mode === 'video' && !videoEl.paused && !inPip()) { pipPendingAt = Date.now(); togglePip(); return true; }
  return false;
}
export function togglePip() {
  try {
    if (videoEl.webkitSupportsPresentationMode?.('picture-in-picture')) {
      videoEl.webkitSetPresentationMode(inPip() ? 'inline' : 'picture-in-picture');
    } else if (document.pictureInPictureEnabled) {
      inPip() ? document.exitPictureInPicture() : videoEl.requestPictureInPicture();
    }
  } catch (e) { console.warn('[pip]', e); }
}
// Called by the native side right before the app is minimised.
window.__mtbAutoPip = () => {
  if (state.mode === 'video' && state.playing && !inPip()) { pipPendingAt = Date.now(); togglePip(); }
};
document.addEventListener('visibilitychange', () => {
  if (!document.hidden || state.mode !== 'video' || !state.playing) return;
  userPaused = false;
  setTimeout(() => {
    if (!document.hidden || pipOrStarting()) return; // PiP took over (or is starting): keep the video
    if (state.mode === 'video') setMode('audio');
  }, 2500);
});
// iOS sometimes pauses the inline video when backgrounding; resume it via audio instead.
videoEl.addEventListener('pause', () => {
  if (pipOrStarting()) { setTimeout(keepVideoGoing, 300); return; } // iOS pauses briefly while PiP opens
  if (document.hidden && el === videoEl && state.mode === 'video' && !userPaused) setTimeout(() => { if (!pipOrStarting() && document.hidden && videoEl.paused) setMode('audio'); }, 2500);
});

/* -------- element events -------- */
const on = (type, fn) => [audioEl, videoEl].forEach((m) => m.addEventListener(type, (e) => { if (e.target === el) fn(e); }));
on('playing', () => set({ playing: true, loading: false }));
on('pause', () => set({ playing: false }));
on('waiting', () => set({ loading: true }));
on('canplay', () => set({ loading: false }));
on('timeupdate', () => {
  setTime({ time: el.currentTime, duration: Number.isFinite(el.duration) && el.duration > 0 ? el.duration : timeState.duration });
  updatePosition();
});
on('ended', () => {
  if (state.guestLimited && el.currentTime < (current()?.duration || 0) - 5) {
    set({ playing: false, error: '', loginPrompt: true });
    return;
  }
  next(true);
});
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
  h('play', () => { userPaused = false; el.play(); });
  h('pause', () => { userPaused = true; el.pause(); });
  h('nexttrack', () => next());
  h('previoustrack', () => prev());
  h('seekto', (d) => seek(d.seekTime));
  // No seek ±10 s handlers: with them iOS shows skip-10 buttons instead of previous/next track.
  h('seekbackward', null);
  h('seekforward', null);
}

export function cycleRepeat() {
  set({ repeat: state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off' });
}

export function toggleShuffle() {
  const on = !state.shuffle;
  if (on) {
    const head = state.queue.slice(0, state.index + 1);
    const rest = state.queue.slice(state.index + 1);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    set({ shuffle: true, queue: [...head, ...rest] });
  } else set({ shuffle: false });
}

export async function toggleLike(track) {
  if (!track) return;
  const now = !state.liked[track.id];
  set({ liked: { ...state.liked, [track.id]: now } });
  try { await ytmod.rate(track.id, now); } catch (e) {
    console.warn('like failed', e?.message);
    set({ liked: { ...state.liked, [track.id]: !now } });
  }
}
