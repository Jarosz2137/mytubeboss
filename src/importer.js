// Import a public Spotify / Apple Music playlist (or album) from its link, then find each track on YouTube.
// No API keys: we read the public web page the same way a browser does, on the phone.
import { CapacitorHttp } from '@capacitor/core';
import { searchSong } from './yt.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

async function getText(url) {
  const r = await CapacitorHttp.get({ url, headers: { 'User-Agent': UA, 'Accept-Language': 'pl,en;q=0.8' }, responseType: 'text' });
  if (r.status >= 400) throw new Error(`Strona zwróciła błąd ${r.status}`);
  return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
}

const decode = (s) => (s || '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function jsonBlobs(html) {
  const out = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1], body = m[2].trim();
    if (!body) continue;
    if (/application\/(ld\+)?json/i.test(attrs) || /__NEXT_DATA__|serialized-server-data/i.test(attrs)) {
      try { out.push(JSON.parse(body)); } catch { /* */ }
    } else if (/initial-state|text\/plain/i.test(attrs)) {
      try { out.push(JSON.parse(atob(body))); } catch { /* */ }
    }
  }
  return out;
}

// Walk any JSON and collect things that look like tracks.
function collect(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return;
  if (Array.isArray(node)) { for (const n of node) collect(n, out, depth + 1); return; }
  const title = typeof node.title === 'string' ? node.title : typeof node.name === 'string' ? node.name : null;
  let artist = null;
  if (typeof node.artistName === 'string') artist = node.artistName;
  else if (typeof node.subtitle === 'string' && typeof node.uri === 'string' && node.uri.startsWith('spotify:track:')) artist = node.subtitle;
  else if (Array.isArray(node.artists)) artist = node.artists.map((a) => (typeof a === 'string' ? a : a?.name || a?.profile?.name)).filter(Boolean).join(', ');
  else if (node.byArtist) artist = [].concat(node.byArtist).map((a) => a?.name).filter(Boolean).join(', ');
  const looksTrack = (typeof node.uri === 'string' && node.uri.startsWith('spotify:track:'))
    || node.contentDescriptor?.kind === 'song' || node['@type'] === 'MusicRecording'
    || node.type === 'track' || node.type === 'songs';
  if (title && artist && looksTrack) out.push({ title: title.trim(), artist: artist.trim() });
  for (const k in node) if (node[k] && typeof node[k] === 'object') collect(node[k], out, depth + 1);
}

export function detectSource(link) {
  const u = (link || '').trim();
  let m = u.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album)\/([A-Za-z0-9]+)/);
  if (m) return { kind: 'spotify', type: m[1], id: m[2], label: 'Spotify' };
  if (/music\.apple\.com\//.test(u)) return { kind: 'apple', url: u.split('?')[0], label: 'Apple Music' };
  return null;
}

export async function readPlaylist(link) {
  const src = detectSource(link);
  if (!src) throw new Error('Wklej link do playlisty albo albumu ze Spotify lub Apple Music.');
  const pages = src.kind === 'spotify'
    ? [`https://open.spotify.com/embed/${src.type}/${src.id}`, `https://open.spotify.com/${src.type}/${src.id}`]
    : [src.url];
  let title = '', tracks = [];
  for (const url of pages) {
    const html = await getText(url).catch(() => '');
    if (!html) continue;
    const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i) || html.match(/<title>([^<]*)<\/title>/i);
    if (!title && og) title = decode(og[1]).replace(/\s*[|–-]\s*(Spotify|Apple Music).*$/i, '').trim();
    const found = [];
    for (const j of jsonBlobs(html)) collect(j, found);
    const seen = new Set();
    const uniq = found.filter((t) => { const k = (t.title + '|' + t.artist).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    if (uniq.length > tracks.length) tracks = uniq;
    if (tracks.length) break;
  }
  if (!tracks.length) throw new Error(`Nie udało się odczytać utworów z ${src.label}. Sprawdź, czy playlista jest publiczna.`);
  return { title: title || `Import z ${src.label}`, tracks, source: src.label };
}

// Finds each track on YouTube, a few at a time. onProgress(done, total, matched)
export async function matchTracks(tracks, onProgress) {
  const out = new Array(tracks.length).fill(null);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < tracks.length) {
      const i = next++;
      const t = tracks[i];
      try { out[i] = await searchSong(`${t.title} ${t.artist}`); } catch { out[i] = null; }
      done++;
      onProgress?.(done, tracks.length, out.filter(Boolean).length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}
