// Playlists kept on the phone (no Google account needed). Stored in Capacitor Preferences.
import { Preferences } from '@capacitor/preferences';

const KEY = 'local_playlists';
let lists = [];
let loaded = false;
const subs = new Set();
const emit = () => subs.forEach((f) => f(lists));
export const onLocal = (f) => { subs.add(f); return () => subs.delete(f); };

export async function loadLocal() {
  if (loaded) return lists;
  try { lists = JSON.parse((await Preferences.get({ key: KEY })).value || '[]'); } catch { lists = []; }
  loaded = true; emit();
  return lists;
}
const save = async () => { emit(); await Preferences.set({ key: KEY, value: JSON.stringify(lists) }); };

const slim = (t) => ({ type: t.type || 'song', id: t.id, title: t.title, subtitle: t.subtitle || '', artistId: t.artistId, duration: t.duration || 0, thumb: t.thumb || '' });

export const localLists = () => lists;
export const getLocal = (id) => lists.find((l) => l.id === id);
export const isLocalId = (id) => typeof id === 'string' && id.startsWith('local:');

export async function createLocal(title, tracks = [], source = '') {
  await loadLocal();
  const l = { id: 'local:' + Date.now().toString(36), title: title || 'Nowa playlista', tracks: tracks.map(slim), source, createdAt: Date.now() };
  lists = [l, ...lists];
  await save();
  return l;
}
export async function addToLocal(id, track) {
  const l = getLocal(id); if (!l) return;
  if (!l.tracks.some((t) => t.id === track.id)) l.tracks = [...l.tracks, slim(track)];
  lists = [...lists]; await save();
}
export async function removeFromLocal(id, index) {
  const l = getLocal(id); if (!l) return;
  l.tracks = l.tracks.filter((_, i) => i !== index);
  lists = [...lists]; await save();
}
export async function renameLocal(id, title) {
  const l = getLocal(id); if (!l) return;
  l.title = title; lists = [...lists]; await save();
}
export async function deleteLocal(id) {
  lists = lists.filter((l) => l.id !== id); await save();
}
// Card-shaped item for shelves
export const localCard = (l) => ({ id: l.id, type: 'local', title: l.title, subtitle: `${l.tracks.length} utw. · w telefonie`, thumb: l.tracks[0]?.thumb || '' });

// "Add to playlist" sheet: any component can open it for a track.
const sheetSubs = new Set();
export const onAddSheet = (f) => { sheetSubs.add(f); return () => sheetSubs.delete(f); };
export const openAddSheet = (track) => sheetSubs.forEach((f) => f(track));
