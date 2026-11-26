// Everything that talks to YouTube lives here.
import { Innertube, UniversalCache } from 'youtubei.js';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const isNative = Capacitor.isNativePlatform();
const CREDS_KEY = 'yt_oauth_creds';

/* ---------------- fetch adapters ---------------- */

function headersToObject(h) {
  const out = {};
  new Headers(h || {}).forEach((v, k) => { out[k] = v; });
  return out;
}

async function readRequest(input, init = {}) {
  const req = input instanceof Request ? input : null;
  const url = req ? req.url : input instanceof URL ? input.href : String(input);
  const method = (init.method || req?.method || 'GET').toUpperCase();
  const headers = headersToObject(init.headers || req?.headers);
  let body = init.body;
  if (body == null && req && method !== 'GET' && method !== 'HEAD') body = await req.clone().text();
  if (body instanceof URLSearchParams) body = body.toString();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) body = new TextDecoder().decode(body);
  return { url, method, headers, body };
}

function makeResponse(status, data, headers) {
  const noBody = status === 204 || status === 304 || status < 200;
  const text = data == null ? '' : typeof data === 'string' ? data : JSON.stringify(data);
  return new Response(noBody ? null : text, { status, headers: headers || {} });
}

// Native iOS: requests leave the phone directly, no CORS, residential IP.
async function nativeFetch(input, init) {
  const { url, method, headers, body } = await readRequest(input, init);
  let data = body;
  const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
  if (typeof body === 'string' && ct.includes('json')) {
    try { data = JSON.parse(body); } catch { /* keep string */ }
  }
  const r = await CapacitorHttp.request({ url, method, headers, data, responseType: 'text' });
  return makeResponse(r.status, r.data, r.headers);
}

// Desktop browser (npm run dev): go through the Vite dev proxy.
async function devFetch(input, init) {
  const { url, method, headers, body } = await readRequest(input, init);
  if (headers.cookie) { headers['x-yt-cookie'] = headers.cookie; delete headers.cookie; }
  return fetch('/__proxy?u=' + encodeURIComponent(url), { method, headers, body });
}

/* ---------------- session ---------------- */

// Login = YouTube Music cookies pasted once (OAuth "TV" tokens get HTTP 400 from YT Music).
const COOKIE_KEY = 'yt_cookie';

let ytPromise = null;
const listeners = new Set();
export const onAuthEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (e) => listeners.forEach((fn) => fn(e));

export function getYT() {
  if (!ytPromise) {
    ytPromise = (async () => {
      // Old OAuth tokens break every request -> drop them.
      await Preferences.remove({ key: CREDS_KEY });
      const cookie = (await Preferences.get({ key: COOKIE_KEY })).value || undefined;
      return Innertube.create({
        fetch: isNative ? nativeFetch : devFetch,
        cache: new UniversalCache(false),
        generate_session_locally: !cookie,
        retrieve_player: true,
        lang: 'pl',
        location: 'PL',
        cookie,
      });
    })();
    ytPromise.catch(() => { ytPromise = null; });
  }
  return ytPromise;
}

export async function isSignedIn() {
  return !!(await Preferences.get({ key: COOKIE_KEY })).value;
}

export async function signInWithCookie(raw) {
  let cookie = String(raw || '').trim().replace(/^cookie:\s*/i, '');
  if (!/SAPISID=|__Secure-3PAPISID=/.test(cookie)) {
    throw new Error('To nie wygląda na cookies z zalogowanego YouTube Music (brakuje SAPISID).');
  }
  await Preferences.set({ key: COOKIE_KEY, value: cookie });
  ytPromise = null;
  await getYT();
  emit({ type: 'signed-in' });
}

export async function signOut() {
  await Preferences.remove({ key: COOKIE_KEY });
  ytPromise = null;
  emit({ type: 'signed-out' });
}

/* ---------------- normalizers ---------------- */

export function txt(t) {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (typeof t.text === 'string') return t.text;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text).join('');
  if (typeof t.toString === 'function' && t.toString !== Object.prototype.toString) return t.toString();
  return '';
}

function findThumbs(n, depth = 0) {
  if (!n || depth > 4) return [];
  if (Array.isArray(n)) {
    if (n.length && typeof n[0]?.url === 'string') return n;
    for (const x of n) {
      const r = findThumbs(x, depth + 1);
      if (r.length) return r;
    }
    return [];
  }
  if (typeof n === 'object') {
    const keys = ['thumbnails', 'thumbnail', 'foreground_thumbnail', 'background', 'strapline_thumbnail'];
    if (String(n.type || '').includes('Thumbnail')) keys.push('contents');
    for (const k of keys) {
      let v;
      try { v = n[k]; } catch { v = undefined; }
      if (v) {
        const r = findThumbs(v, depth + 1);
        if (r.length) return r;
      }
    }
  }
  return [];
}

// Ask Google's image CDN for a big version of the cover.
export function hq(url, size = 1200) {
  if (!url) return '';
  if (url.startsWith('//')) url = 'https:' + url;
  if (/googleusercontent\.com|ggpht\.com/.test(url)) {
    return url.replace(/=w\d+-h\d+[^&?#]*$/, `=w${size}-h${size}-l90-rj`).replace(/=s\d+[^&?#]*$/, `=s${size}`);
  }
  return url;
}

export function bestThumb(n, size) {
  const list = findThumbs(n);
  if (!list.length) return '';
  const best = [...list].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return hq(best.url, size);
}

export function norm(it, fallback = {}) {
  if (!it) return null;
  const type = it.item_type || fallback.type || 'song';
  let title = '';
  try { title = it.title != null ? txt(it.title) : it.name || txt(it.flex_columns?.[0]?.title); } catch { /* */ }
  if (!title && it.name) title = it.name;
  const author = typeof it.author === 'string' ? { name: it.author } : it.author;
  const artists = (it.artists?.length ? it.artists : it.authors?.length ? it.authors : author ? [author] : fallback.artists) || [];
  let subtitle = artists.map((a) => a?.name).filter(Boolean).join(', ');
  if (!subtitle) subtitle = txt(it.subtitle);
  if (!subtitle) subtitle = fallback.subtitle || '';
  let thumb = '';
  try { thumb = bestThumb(it); } catch { /* */ }
  return {
    type,
    id: it.id,
    title: title || 'Bez tytułu',
    subtitle,
    artists,
    artistId: artists.find((a) => a?.channel_id)?.channel_id,
    album: it.album?.name ? it.album : fallback.album,
    duration: it.duration?.seconds || 0,
    thumb: thumb || fallback.thumb || '',
  };
}

const PLAYABLE = new Set(['song', 'video', 'non_music_track']);
export const isPlayable = (x) => x && PLAYABLE.has(x.type) && x.id;

function sectionItems(s) {
  let raw = [];
  try { raw = s.contents ?? s.items ?? []; } catch { raw = []; }
  return Array.from(raw || []).map((i) => norm(i)).filter((x) => x && x.id);
}

export function toSections(list) {
  return Array.from(list || [])
    .map((s) => {
      let title = '';
      try { title = txt(s.header?.title ?? s.title ?? s.header?.text); } catch { /* */ }
      return { title, items: sectionItems(s) };
    })
    .filter((s) => s.items.length);
}

/* ---------------- API ---------------- */

export async function home() {
  const yt = await getYT();
  const feed = await yt.music.getHomeFeed();
  return toSections(feed.sections);
}

export async function search(q) {
  const yt = await getYT();
  const res = await yt.music.search(q);
  const sections = [];
  for (const s of res.contents || []) {
    if (s.type === 'MusicCardShelf') {
      const top = norm(s);
      if (top) {
        // The card itself is the "top result"; its id is hidden in the endpoint.
        const ep = s.on_tap?.payload || {};
        top.id = top.id || ep.videoId || ep.browseId;
        top.type = ep.videoId ? 'song' : ep.browseId?.startsWith('UC') ? 'artist' : ep.browseId?.startsWith('MPRE') ? 'album' : top.type;
      }
      const items = [top, ...sectionItems(s)].filter((x) => x && x.id);
      if (items.length) sections.push({ title: 'Najlepszy wynik', items });
    } else {
      sections.push(...toSections([s]));
    }
  }
  return sections;
}

export async function suggestions(q) {
  const yt = await getYT();
  const res = await yt.music.getSearchSuggestions(q);
  const out = [];
  for (const sec of res || []) {
    for (const c of sec.contents || []) {
      const s = txt(c.suggestion);
      if (s) out.push(s);
    }
  }
  return [...new Set(out)].slice(0, 8);
}

export async function artist(id) {
  const yt = await getYT();
  const a = await yt.music.getArtist(id);
  const h = a.header || {};
  return {
    title: txt(h.title),
    description: txt(h.description),
    thumb: bestThumb(h, 1600),
    sections: toSections(a.sections),
  };
}

export async function album(id) {
  const yt = await getYT();
  const a = await yt.music.getAlbum(id);
  const h = a.header || {};
  const thumb = bestThumb(h) || bestThumb(a.background);
  const artistName = txt(h.strapline_text_one) || txt(h.author?.name);
  const fallback = { thumb, subtitle: artistName, artists: artistName ? [{ name: artistName }] : [], type: 'song' };
  return {
    title: txt(h.title),
    subtitle: [artistName, txt(h.subtitle)].filter(Boolean).join(' · '),
    meta: txt(h.second_subtitle),
    thumb,
    tracks: (a.contents || []).map((t) => norm(t, fallback)).filter(isPlayable),
    more: toSections(a.sections),
  };
}

export async function playlist(id, maxPages = 4) {
  const yt = await getYT();
  let p = await yt.music.getPlaylist(id);
  const h = p.header || {};
  const thumb = bestThumb(h) || bestThumb(p.background);
  const tracks = [];
  const take = (pl) => (pl.items || []).forEach((t) => { const n = norm(t, { type: 'song' }); if (isPlayable(n)) tracks.push(n); });
  take(p);
  for (let i = 1; i < maxPages && p.has_continuation; i++) {
    try { p = await p.getContinuation(); take(p); } catch { break; }
  }
  return {
    title: txt(h.title),
    subtitle: [txt(h.strapline_text_one), txt(h.subtitle)].filter(Boolean).join(' · '),
    meta: txt(h.second_subtitle),
    thumb: thumb || tracks[0]?.thumb || '',
    tracks,
    more: [],
  };
}

export async function library() {
  const yt = await getYT();
  const sections = [];
  try {
    const lib = await yt.music.getLibrary();
    sections.push(...toSections(lib.contents).map((s) => ({ ...s, title: s.title || 'Twoje playlisty' })));
  } catch (e) {
    console.warn('library failed', e);
  }
  return sections;
}

export async function upNext(videoId) {
  const yt = await getYT();
  const panel = await yt.music.getUpNext(videoId, true);
  return (panel.contents || [])
    .map((i) => {
      const n = norm(i, { type: 'song' });
      if (n && !n.id) n.id = i.video_id;
      if (n && !n.duration && i.duration?.seconds) n.duration = i.duration.seconds;
      return n;
    })
    .filter((n) => n && n.id && n.id !== videoId);
}

/* ---------------- streams ---------------- */

const canHls = () => {
  const v = document.createElement('video');
  return !!v.canPlayType('application/vnd.apple.mpegurl');
};

async function tryClients(clients, fn) {
  let lastErr;
  for (const client of clients) {
    try {
      const r = await fn(client);
      if (r) return r;
    } catch (e) {
      lastErr = e;
      console.warn(`stream via ${client} failed`, e);
    }
  }
  throw lastErr || new Error('Brak streamu');
}

// Audio-only: m4a/AAC, because iOS doesn't like webm/opus everywhere.
export async function audioUrl(id) {
  const yt = await getYT();
  return tryClients(['IOS', 'ANDROID_VR', 'TV', 'WEB'], async (client) => {
    const f = await yt.getStreamingData(id, { type: 'audio', quality: 'best', format: 'mp4', client });
    return f?.url ? (isNative ? f.url : devMediaUrl(f.url)) : null;
  });
}

// Music video: HLS (up to 1080p, Safari plays it natively) or muxed mp4 as fallback.
export async function videoUrl(id) {
  const yt = await getYT();
  if (canHls()) {
    try {
      const info = await yt.getBasicInfo(id, { client: 'IOS' });
      const hls = info.streaming_data?.hls_manifest_url;
      if (hls) return hls;
    } catch (e) {
      console.warn('HLS failed', e);
    }
  }
  return tryClients(['IOS', 'ANDROID_VR', 'TV', 'WEB'], async (client) => {
    const f = await yt.getStreamingData(id, { type: 'video+audio', quality: 'best', format: 'mp4', client });
    return f?.url ? (isNative ? f.url : devMediaUrl(f.url)) : null;
  });
}

// In the desktop browser, media URLs are played directly (media tags don't need CORS).
function devMediaUrl(u) {
  return u;
}
