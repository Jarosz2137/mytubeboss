// Lyrics: synced (LRC) from LRCLIB (free, no key), fallback to YouTube Music's plain lyrics.
import { CapacitorHttp } from '@capacitor/core';
import * as yt from './yt.js';

const cache = new Map();

function parseLrc(lrc) {
  const out = [];
  for (const line of (lrc || '').split('\n')) {
    const m = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const t of m) out.push({ t: Number(t[1]) * 60 + Number(t[2]), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

const clean = (s) => (s || '').replace(/\s*[([].*?(feat|ft\.|official|video|audio|remaster|lyric|prod)[^)\]]*[)\]]/gi, '').trim();

export async function getLyrics(track) {
  if (!track) return null;
  if (cache.has(track.id)) return cache.get(track.id);
  const artist = clean((track.subtitle || '').split(',')[0]);
  const title = clean(track.title);
  let res = null;
  try {
    const q = new URLSearchParams({ artist_name: artist, track_name: title });
    if (track.duration) q.set('duration', String(Math.round(track.duration)));
    let r = await CapacitorHttp.get({ url: `https://lrclib.net/api/get?${q}`, headers: { 'User-Agent': 'MyTubeBoss/1.0' }, responseType: 'json' });
    let d = typeof r.data === 'string' ? JSON.parse(r.data || 'null') : r.data;
    if (!d || r.status >= 400) {
      r = await CapacitorHttp.get({ url: `https://lrclib.net/api/search?${new URLSearchParams({ q: `${artist} ${title}` })}`, headers: { 'User-Agent': 'MyTubeBoss/1.0' }, responseType: 'json' });
      const list = typeof r.data === 'string' ? JSON.parse(r.data || '[]') : r.data;
      d = Array.isArray(list) ? (list.find((x) => x.syncedLyrics) || list[0]) : null;
    }
    if (d?.syncedLyrics) res = { synced: true, lines: parseLrc(d.syncedLyrics), source: 'LRCLIB' };
    else if (d?.plainLyrics) res = { synced: false, lines: d.plainLyrics.split('\n').map((text) => ({ text })), source: 'LRCLIB' };
  } catch (e) { console.warn('[lyrics] lrclib', e?.message); }
  if (!res) {
    try {
      const ytm = await yt.getYT();
      const l = await ytm.music.getLyrics(track.id);
      const text = yt.txt(l?.description);
      if (text) res = { synced: false, lines: text.split('\n').map((t) => ({ text: t })), source: 'YouTube Music' };
    } catch (e) { console.warn('[lyrics] yt', e?.message); }
  }
  cache.set(track.id, res);
  return res;
}
