// Offline: downloaded songs live in IndexedDB on the phone (audio chunks + track info).
import { sabrAudioChunks } from './yt.js';

const DB = 'mtb-offline', STORE = 'tracks';
let dbp = null;
const db = () => dbp || (dbp = new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
const tx = async (mode, fn) => {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
};

let index = new Map(); // id -> track (metadata only)
let ready = null;
const subs = new Set();
export const offlineState = { queue: [], current: null, progress: 0, error: '' };
const emit = () => subs.forEach((f) => f({ ...offlineState, count: index.size }));
export const onOffline = (f) => { subs.add(f); return () => subs.delete(f); };

export function loadIndex() {
  if (!ready) ready = (async () => {
    try {
      const all = await tx('readonly', (s) => s.getAll());
      index = new Map(all.map((x) => [x.id, x.track]));
    } catch (e) { console.warn('[offline] index', e); }
    emit();
  })();
  return ready;
}
export const isDownloaded = (id) => index.has(id);
export const downloadedTracks = () => Array.from(index.values()).reverse();
export const isQueued = (id) => offlineState.current?.id === id || offlineState.queue.some((t) => t.id === id);

export async function getDownload(id) {
  await loadIndex();
  if (!index.has(id)) return null;
  try { return await tx('readonly', (s) => s.get(id)); } catch { return null; }
}

export async function removeDownload(id) {
  await tx('readwrite', (s) => s.delete(id));
  index.delete(id); emit();
}

const slim = (t) => ({ type: t.type || 'song', id: t.id, title: t.title, subtitle: t.subtitle || '', artistId: t.artistId, duration: t.duration || 0, thumb: t.thumb || '' });

async function save(track, r) {
  await tx('readwrite', (s) => s.put({ id: track.id, track: slim(track), mime: r.mime, durationMs: r.durationMs, parts: r.parts, savedAt: Date.now() }));
  index.set(track.id, slim(track));
}

let running = false;
async function run() {
  if (running) return;
  running = true;
  while (offlineState.queue.length) {
    const t = offlineState.queue.shift();
    offlineState.current = t; offlineState.progress = 0; offlineState.error = ''; emit();
    try {
      const r = await sabrAudioChunks(t.id, { onProgress: (b) => { offlineState.progress = b; emit(); } }, 'WEB');
      // reject obviously cut downloads (anonymous sessions stop after ~1 min)
      const expect = (r.durationMs || t.duration * 1000) / 1000 * 15000; // ~120 kbps
      if (expect && r.bytes < expect * 0.8) throw new Error('pobrało się tylko kawałek utworu (zaloguj się)');
      await save(t, r);
    } catch (e) {
      offlineState.error = `${t.title}: ${e?.message || e}`;
      console.warn('[offline]', offlineState.error);
    }
    offlineState.current = null; emit();
  }
  running = false; emit();
}

export async function downloadTracks(tracks) {
  await loadIndex();
  for (const t of tracks) if (t?.id && !index.has(t.id) && !isQueued(t.id)) offlineState.queue.push(t);
  emit(); run();
}

// Reuse a song that was just streamed in full, if the user asked to download it.
window.addEventListener('mtb-audio', (e) => {
  const { id, parts, mime, durationMs } = e.detail || {};
  const i = offlineState.queue.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = offlineState.queue.splice(i, 1);
  save(t, { parts, mime, durationMs }).then(emit).catch(() => {});
});
