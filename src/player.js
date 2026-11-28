import { energyLevel } from './energy.js';
import { profStart, profEnd, profJob, profReport, profilerPanel, profIsolated } from './profiler.js';
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
  if (Object.keys(patch).every(k => Object.is(state[k],patch[k]))) return;
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
const subscribePlayer = f => { subs.add(f); return () => subs.delete(f); };
const subscribeTime = f => { tsubs.add(f); return () => tsubs.delete(f); };
export const usePlayer = (select = s => s) => useSyncExternalStore(subscribePlayer, () => select(state));

// Playback position lives in its own tiny store so the whole UI doesn't re-render 4x/second.
let timeState = { time: 0, duration: 0 };
const tsubs = new Set();
const setTime = (patch) => { if(Object.keys(patch).every(k=>Object.is(timeState[k],patch[k]))) return; timeState = { ...timeState, ...patch }; tsubs.forEach((f) => f()); };
export const useTime = (select = s => s) => useSyncExternalStore(subscribeTime, () => select(timeState));
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
let activeMse = null, cancelTry = null;
function releaseMedia() {
  cancelTry?.();
  activeMse?.dispose();
  activeMse = null;
  if (lastBlobUrl) { URL.revokeObjectURL(lastBlobUrl); lastBlobUrl = null; }
}
function pruneDownloads() {
  const keep = new Set([current()?.id, state.queue[state.index+1]?.id]);
  for (const [key,job] of inflight) if (!keep.has(job.id)) {
    inflight.delete(key); job.listeners.clear(); job.controller.abort();
  }
}

// Ready-to-play audio for upcoming tracks: { mime, durationMs, parts }.
const ready = new Map();
let readyBytes = 0;
const audioBytes = r => r?.parts?.reduce((n,c)=>n+(c.byteLength||0),0)||0;
function forgetReady(id) {
  const entry=ready.get(id);
  if(entry){readyBytes-=entry.bytes;ready.delete(id);}
}
function trimReady() {
  const level=energyLevel();
  const maxBytes=(level>=3?0:level>=2?8:level===1?16:24)*1048576;
  const maxEntries=level>=3?0:level>=2?2:level===1?3:5;
  while(ready.size>maxEntries || readyBytes>maxBytes) {
    const nextId=state.queue[state.index+1]?.id;
    const victim=[...ready.keys()].find(id=>id!==nextId)??ready.keys().next().value;
    if(victim===undefined)break;
    forgetReady(victim);
  }
}
function rememberReady(id,r) {
  if(!r?.parts?.length || !r.mime || !r.durationMs || energyLevel()>=3)return;
  const bytes=audioBytes(r);
  if(!bytes||bytes>8*1048576)return;
  forgetReady(id);
  ready.set(id,{r,bytes});
  readyBytes+=bytes;
  trimReady();
}
function reuseReady(id) {
  const entry=ready.get(id);
  if(!entry)return null;
  ready.delete(id);ready.set(id,entry);
  console.info('[audio-cache] hit',id,Math.round(entry.bytes/1024),'KB');
  return entry.r;
}
window.addEventListener('mtb-energy',trimReady);
ytmod.onAuthEvent(()=>{ready.clear();readyBytes=0;});

// Share in-flight downloads by track and client, replaying buffered chunks to a new consumer.
const inflight = new Map();
function sharedSabr(id, callbacks = {}, client = 'WEB') {
  const key = client + ':' + id;
  let job = inflight.get(key);
  if (!job) {
    job = { id, controller: new AbortController(), meta: null, chunks: [], progress: null, listeners: new Set(), promise: null };
    inflight.set(key, job);
    const finishDownload = profJob('sabr.'+client);
    let profileBytes = 0;
    const emit = (name, value) => {
      for (const listener of job.listeners) {
        try { listener[name]?.(value); } catch (e) { console.warn('[sabr] consumer', e?.message); }
      }
    };
    job.promise = Promise.resolve().then(() => sabrAudioChunks(id, {
      onMeta: m => { job.meta = m; emit('onMeta', m); },
      onChunk: c => { profileBytes += c.byteLength || c.length || 0; job.chunks.push(c); emit('onChunk', c); },
      onProgress: n => { job.progress = n; emit('onProgress', n); },
    }, client, job.controller.signal)).finally(() => {
      finishDownload(profileBytes);
      if (inflight.get(key) === job) inflight.delete(key);
    });
  } else {
    console.info('[sabr] reuse in-flight', id, client);
  }
  job.listeners.add(callbacks);
  try {
    if (job.meta) callbacks.onMeta?.(job.meta);
    for (const chunk of job.chunks) callbacks.onChunk?.(chunk);
    if (job.progress !== null) callbacks.onProgress?.(job.progress);
  } catch (e) {
    job.listeners.delete(callbacks);
    return Promise.reject(e);
  }
  return job.promise.finally(() => job.listeners.delete(callbacks));
}
const prefetching = new Set();
async function prefetchNext() {
  if (energyLevel() >= 2) return;
  const nextTrack = state.queue[state.index + 1];
  if (!nextTrack || ready.has(nextTrack.id) || prefetching.has(nextTrack.id)) return;
  prefetching.add(nextTrack.id);
  try {
    const r = await sharedSabr(nextTrack.id, {}, 'WEB');
    if (current()?.id !== nextTrack.id && state.queue[state.index+1]?.id === nextTrack.id) {
      rememberReady(nextTrack.id, r);
    }
    console.info('[prefetch] ready', nextTrack.title);
  } catch (e) {
    console.warn('[prefetch] failed', e?.message);
  } finally {
    prefetching.delete(nextTrack.id);
  }
}

const MSClass = () => window.ManagedMediaSource || window.MediaSource || null;

// Feeds SABR chunks into (Managed)MediaSource: playback starts after the first
// few seconds arrive, duration is exact and seeking works.
function makeMse(meta, startAt, token) {
  const MS = MSClass();
  if (!MS || (MS.isTypeSupported && !MS.isTypeSupported(meta.mime))) return null;
  if (token !== loadToken) return null;
  releaseMedia();
  const media = el;
  const ms = new MS();
  let disposed = false, objectUrl = null;
  const queue = [];
  let sb = null, ended = false, first = true;
  try { media.disableRemotePlayback = true; } catch { /* */ }
  media.removeAttribute('src');
  if (MS !== window.MediaSource && 'srcObject' in media) {
    try { media.srcObject = ms; } catch { media.src = (objectUrl = URL.createObjectURL(ms)); }
  } else {
    media.src = (objectUrl = URL.createObjectURL(ms));
  }
  const pump = () => {
    if (disposed || token !== loadToken || !sb || sb.updating) return;
    if (queue.length) { try { sb.appendBuffer(queue.shift()); } catch (e) { console.warn('[mse] append failed', e?.message); } return; }
    if (ended && ms.readyState === 'open') { try { ms.endOfStream(); } catch { /* */ } }
  };
  const onOpen = () => {
    if (disposed || token !== loadToken) return;
    try { sb = ms.addSourceBuffer(meta.mime); } catch (e) { console.warn('[mse] addSourceBuffer', e?.message); return; }
    if (meta.durationMs) { try { ms.duration = meta.durationMs / 1000; } catch { /* */ } }
    sb.addEventListener('updateend', onUpdate);
    pump();
  };
  const onUpdate = () => {
      if (disposed || token !== loadToken) return;
      if (first) {
        first = false;
        if (startAt) { try { media.currentTime = startAt; } catch { /* */ } }
        if (token === loadToken) media.play().catch(() => {});
      }
      pump();
  };
  ms.addEventListener('sourceopen', onOpen, { once: true });
  console.info('[mse] using', MS === window.MediaSource ? 'MediaSource' : 'ManagedMediaSource');
  activeMse = { push(c) { if (!disposed) { queue.push(c); pump(); } }, end() { ended = true; pump(); }, dispose() {
    disposed = true; queue.length = 0;
    ms.removeEventListener('sourceopen',onOpen);
    sb?.removeEventListener('updateend',onUpdate);
    try { if (sb?.updating && ms.readyState === 'open') sb.abort(); } catch {}
    try { if (media.srcObject === ms) media.srcObject = null; } catch {}
    if (objectUrl) { if (media.src === objectUrl) { media.removeAttribute('src'); media.load(); } URL.revokeObjectURL(objectUrl); }
    sb = null;
  }};
  return activeMse;
}

function blobOf(r) {
  return URL.createObjectURL(new Blob(r.parts, { type: r.mime.split(';')[0] }));
}

// Resolves true once the element actually starts, false on error/timeout.
function tryPlay(url, startAt, token) {
  if (token !== loadToken) { if (url?.startsWith('blob:')) URL.revokeObjectURL(url); return Promise.resolve(false); }
  releaseMedia();
  const media = el;
  if (url?.startsWith('blob:')) lastBlobUrl = url;
  return new Promise(resolve => {
    let done = false;
    const onMeta = () => { if (token === loadToken && startAt) { try { media.currentTime = startAt; } catch {} } };
    const finish = ok => {
      if (done) return; done = true;
      media.removeEventListener('playing',onOk); media.removeEventListener('error',onErr);
      media.removeEventListener('loadedmetadata',onMeta); clearTimeout(t);
      if (cancelTry === cancel) cancelTry = null;
      resolve(ok && token === loadToken);
    };
    const onOk = () => finish(true), onErr = () => finish(false), cancel = () => finish(false);
    const t = setTimeout(cancel,15000); cancelTry = cancel;
    media.addEventListener('playing',onOk); media.addEventListener('error',onErr);
    if (startAt) media.addEventListener('loadedmetadata',onMeta,{once:true});
    try { media.srcObject = null; } catch {}
    media.src = url; media.play().catch(() => {});
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
  if(!listened || listened.track.id!==track.id) beginListen(track);
  if(listened) listened.last=null;
  const token = ++loadToken;
  suppressErrors = true;
  releaseMedia();
  pruneDownloads();
  const mode = state.mode;
  const log = [];
  set({ loading: true, error: '', guestLimited: false, loginPrompt: false });
  setTime({ time: startAt, duration: track.duration || 0 });
  updateMediaSession();
  suppressErrors = true;
  const done = () => { if (token !== loadToken) return; suppressErrors = false; set({ error: '' }); prefetchNext(); };

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
    const pre = reuseReady(track.id);
    if (pre) {
      announce(track.id, pre);
      if (pre.durationMs) setTime({ duration: pre.durationMs / 1000 });
      const ctl = makeMse(pre, startAt, token);
      if (ctl) { pre.parts.forEach((c) => ctl.push(c)); ctl.end(); done(); return; }
      if (await tryPlay(blobOf(pre), startAt, token)) { done(); return; }
      forgetReady(track.id);
    }
    // 2) SABR streamed into MediaSource (starts after a few seconds of audio)
    for (const sc of ['WEB', 'MWEB']) {
      if (token !== loadToken) return;
      let ctl = null;
      try {
        const r = await sharedSabr(track.id, {
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
        if (ctl) { ctl.end(); rememberReady(track.id,r); done(); return; }
        if (await tryPlay(blobOf(r), startAt, token)) { if(token===loadToken)rememberReady(track.id,r); done(); return; }
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
          if (token !== loadToken) return;
          suppressErrors = false;
          set({ error: 'Bez logowania YouTube dał tylko część utworu' });
          return;
        }
        log.push(String(e?.message || e).slice(0, 120));
      }
    }
  }

  // 3) HLS (music videos, or the linked video of an album track)
  if (token !== loadToken) return;
  try {
    const hls = await hlsUrl(track.id);
    if (token !== loadToken) return;
    if (await tryPlay(hls, startAt, token)) { done(); return; }
    log.push('HLS: media ' + (el.error?.code ?? 'timeout'));
  } catch (e) {
    log.push('HLS: ' + String(e?.message || e).slice(0, 80));
  }
  if (token !== loadToken) return;
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

  if (token !== loadToken) return;
  suppressErrors = false;
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
  flushListen();
  beginListen(tracks[startIndex]);
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
  flushListen();
  beginListen(state.queue[i]);
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
  if (auto && state.repeat === 'one') { flushListen(); beginListen(current()); el.currentTime = 0; el.play().catch(() => {}); return; }
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
  flushListen(); if(listened) listened.last=null;
  const at = el.currentTime || 0;
  const old = el;
  releaseMedia();
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
// ---- sleep timer: stop after N minutes (at the end of the track that's playing then) or at track end ----
let sleepAt = 0, sleepEndOfTrack = false, sleepTimer = null;
export function setSleep(minutes) {
  clearInterval(sleepTimer); sleepTimer = null;
  sleepEndOfTrack = minutes === 'track';
  sleepAt = typeof minutes === 'number' && minutes > 0 ? Date.now() + minutes * 60000 : 0;
  set({ sleep: sleepEndOfTrack ? 'track' : sleepAt || 0 });
  if (sleepAt) sleepTimer = setInterval(() => { if (Date.now() >= sleepAt) { clearInterval(sleepTimer); sleepTimer = null; sleepAt = 0; sleepEndOfTrack = true; set({ sleep: 'track' }); } }, 5000);
}
export const sleepPending = () => sleepEndOfTrack;
function sleepHit() { sleepEndOfTrack = false; set({ sleep: 0 }); el.pause(); }

// ---- playback speed (sped up / slowed) ----
export const RATES = [0.8, 0.9, 1, 1.15, 1.25];
let rate = 1;
export const getRate = () => rate;
export function setRate(r) {
  rate = r;
  for (const m of [audioEl, videoEl]) {
    try { m.preservesPitch = false; m.webkitPreservesPitch = false; } catch { /* */ } // nightcore / slowed feel
    m.playbackRate = r; m.defaultPlaybackRate = r;
  }
  set({ rate: r });
}
on('playing', () => { if (el.playbackRate !== rate) { el.playbackRate = rate; el.defaultPlaybackRate = rate; } });

// ---- listening history for Boss Wrapped (kept on the phone) ----
// One record per actual playback session. Checkpoints update it, never count twice.
let listened = null;
let historyTail = Promise.resolve();
let listenSequence = 0;
const listenPrefix = Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
function beginListen(t) {
  listened = t ? { track:t, session:listenPrefix+'-'+(++listenSequence), sec:0, last:null, wall:0, saved:0, marked:false, at:Date.now() } : null;
}
function sampleListen() {
  const l = listened;
  if (!l || l.track.id !== current()?.id) return;
  const pos = el.currentTime, now = Date.now();
  if (!Number.isFinite(pos)) return;
  if (l.last !== null && !el.seeking) {
    const delta = pos-l.last, elapsed = Math.max(0,(now-l.wall)/1000);
    const seconds = delta/(el.playbackRate||1);
    // Media time measures actual progress even when iOS throttles background callbacks.
    // Reject discontinuities and forward seeks rather than counting skipped music.
    if(seconds>0 && seconds<=elapsed+0.75) l.sec+=Math.min(seconds,elapsed+0.25);
  }
  l.last=pos; l.wall=now;
  if(!l.marked && l.sec>=30) {
    l.marked=true; ytmod.invalidateHomeAfterListen();
    window.dispatchEvent(new Event('mtb-listened'));
    console.info('[history] qualified listen',l.track.id);
  }
  if(l.sec-l.saved>=30) flushListen(false);
}
function flushListen(sample=true) {
  if(sample) sampleListen();
  const l=listened;
  if(!l || l.sec<1 || l.sec-l.saved<0.5) return historyTail;
  const t=l.track;
  const entry={id:t.id,title:t.title,subtitle:t.subtitle,thumb:t.thumb,sec:Math.round(l.sec*10)/10,at:l.at,session:l.session,qualified:l.sec>=30};
  l.saved=l.sec;
  historyTail=historyTail.then(async()=>{
    const {Preferences}=await import('@capacitor/preferences');
    let rows=[];
    try {rows=JSON.parse((await Preferences.get({key:'history_v2'})).value||'[]');} catch {}
    if(!Array.isArray(rows)) rows=[];
    const i=rows.findIndex(x=>x.session===entry.session);
    if(i>=0) rows[i]=entry; else rows.push(entry);
    await Preferences.set({key:'history_v2',value:JSON.stringify(rows.slice(-20000))});
  }).catch(e=>{l.saved=0;console.warn('[history]',e?.message);});
  return historyTail;
}
export async function readListeningHistory() {
  flushListen();
  await historyTail;
  const {Preferences}=await import('@capacitor/preferences');
  try {const rows=JSON.parse((await Preferences.get({key:'history_v2'})).value||'[]');return Array.isArray(rows)?rows:[];}catch{return [];}
}
on('playing',()=>{if(!listened) beginListen(current());if(listened){listened.last=el.currentTime;listened.wall=Date.now();}});
on('timeupdate',()=>{if(!el.paused&&!el.seeking) sampleListen();});
on('pause',()=>{flushListen();if(listened) listened.last=null;});
on('waiting',()=>{flushListen();if(listened) listened.last=null;});
on('seeking',()=>{if(listened) listened.last=null;});
on('seeked',()=>{if(listened&&!el.paused){listened.last=el.currentTime;listened.wall=Date.now();}});
on('ended',()=>{flushListen();if(listened) listened.last=null;});
document.addEventListener('visibilitychange',()=>{if(document.hidden) flushListen();});
window.addEventListener('pagehide',()=>{flushListen();});
on('timeupdate', () => {
  setTime({ time: el.currentTime, duration: Number.isFinite(el.duration) && el.duration > 0 ? el.duration : timeState.duration });
  updatePosition();
});
on('ended', () => {
  if (sleepEndOfTrack) { sleepHit(); return; }
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
