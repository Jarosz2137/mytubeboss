// Everything that talks to YouTube lives here.
import { Innertube, UniversalCache, Platform } from 'youtubei.js';

// youtubei.js needs a JS evaluator to run YouTube's player code (n/sig decipher).
// The WebView is a real JS engine, so plain Function works.
Platform.shim.eval = (data, env) => {
  const a = (v) => JSON.stringify(v ?? '');
  return new Function(`${data.output}\nreturn process(${a(env.n)}, ${a(env.sp)}, ${a(env.sig)});`)();
};
import { Capacitor, CapacitorHttp, CapacitorCookies } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { createPoMinter } from './po.js';
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat, EnabledTrackTypes } from 'googlevideo/utils';

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
  let binary = null;
  if (body instanceof Blob) body = new Uint8Array(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) body = new Uint8Array(body);
  if (ArrayBuffer.isView(body)) binary = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return { url, method, headers, body, binary };
}

function makeResponse(status, data, headers) {
  const noBody = status === 204 || status === 304 || status < 200;
  const text = data == null ? '' : typeof data === 'string' ? data : JSON.stringify(data);
  return new Response(noBody ? null : text, { status, headers: headers || {} });
}

// Native iOS: requests leave the phone directly, no CORS, residential IP.
function u8ToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function nativeFetch(input, init) {
  const { url, method, headers, body, binary } = await readRequest(input, init);
  let data = body;
  let dataType;
  if (binary) {
    data = u8ToB64(binary);
    dataType = 'file';
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/x-protobuf';
  }
  const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
  if (!binary && typeof body === 'string' && ct.includes('json')) {
    try { data = JSON.parse(body); } catch { /* keep string */ }
  }
  const binResp = /googlevideo\.com|ytimg\.com/.test(url);
  const r = await CapacitorHttp.request({ url, method, headers, data, dataType, responseType: binResp ? 'arraybuffer' : 'text' });
  if (binResp) {
    const b64 = typeof r.data === 'string' ? r.data : '';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(r.status === 204 ? null : bytes, { status: r.status, headers: r.headers || {} });
  }
  return makeResponse(r.status, r.data, r.headers);
}

// Desktop browser (npm run dev): go through the Vite dev proxy.
async function devFetch(input, init) {
  const { url, method, headers, body, binary } = await readRequest(input, init);
  if (binary) return fetch('/__proxy?u=' + encodeURIComponent(url), { method, headers, body: binary });
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
      if (cookie) await syncNativeCookies(cookie);
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

async function syncNativeCookies(cookie) {
  if (!isNative) return;
  const pairs = cookie.split(';').map((c) => c.trim()).filter((c) => c.includes('='));
  for (const url of ['https://music.youtube.com', 'https://www.youtube.com']) {
    for (const pair of pairs) {
      const i = pair.indexOf('=');
      try { await CapacitorCookies.setCookie({ url, key: pair.slice(0, i), value: pair.slice(i + 1) }); } catch { /* ignore */ }
    }
  }
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
  if (isNative) { try { await CapacitorCookies.clearAllCookies(); } catch { /* ignore */ } }
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
  const h = p.header?.header || p.header || {};
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

// Separate anonymous session for playback, attested with a PO token from BotGuard.
let playPromise = null;
export let poStatus = 'brak';

function getPlayYT() {
  if (!playPromise) {
    playPromise = (async () => {
      const fetchFn = isNative ? nativeFetch : devFetch;
      const base = { fetch: fetchFn, cache: new UniversalCache(false), retrieve_player: true, lang: 'pl', location: 'PL' };
      const anon = await Innertube.create({ ...base, generate_session_locally: true });
      const visitorData = anon.session.context.client.visitorData;
      try {
        const minter = await createPoMinter(anon, fetchFn);
        const po_token = await minter.mintAsWebsafeString(visitorData);
        const yt = await Innertube.create({ ...base, visitor_data: visitorData, po_token });
        poStatus = 'ok';
        return { yt, minter, po_token, fetchFn };
      } catch (e) {
        poStatus = 'błąd: ' + String(e?.message || e).slice(0, 220);
        console.warn('PO token failed', e);
        return { yt: anon, minter: null, po_token: undefined, fetchFn };
      }
    })();
    playPromise.catch(() => { playPromise = null; });
  }
  return playPromise;
}

// MWEB + PO token is what yt-dlp recommends; the rest are fallbacks.
export const CLIENTS = ['MWEB', 'IOS', 'WEB', 'TV', 'ANDROID_VR'];

async function opts(minter, id, base) {
  if (!minter) return base;
  try { return { ...base, po_token: await minter.mintAsWebsafeString(id) }; } catch { return base; }
}

export async function streamUrl(id, mode, client) {
  const { yt, minter } = await getPlayYT();
  if (mode === 'video' && client === 'IOS' && canHls()) {
    const info = await yt.getBasicInfo(id, { client: 'IOS' });
    if (info.streaming_data?.hls_manifest_url) return info.streaming_data.hls_manifest_url;
  }
  const base = mode === 'video'
    ? { type: 'video+audio', quality: 'best', format: 'mp4', client }
    : { type: 'audio', quality: 'best', format: 'mp4', client };
  const f = await yt.getStreamingData(id, await opts(minter, id, base));
  return f?.url || null;
}

// Fallback: download the whole file through native HTTP and play from memory.
export async function audioBlobUrl(id) {
  const { yt, minter } = await getPlayYT();
  let lastErr;
  for (const client of CLIENTS) {
    try {
      const stream = await yt.download(id, await opts(minter, id, { type: 'audio', quality: 'best', format: 'mp4', client }));
      const reader = stream.getReader();
      const parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }
      const blob = new Blob(parts, { type: 'audio/mp4' });
      if (blob.size < 10000) throw new Error('za mały plik (' + blob.size + ' B)');
      return URL.createObjectURL(blob);
    } catch (e) {
      lastErr = new Error(client + ': ' + (e?.message || e));
      console.warn('blob via ' + client + ' failed', e);
    }
  }
  throw lastErr || new Error('download failed');
}

// SABR: YouTube's own streaming protocol (what the web player uses now).
// Downloads the audio track (AAC/mp4) and plays it from memory.
export async function sabrAudioBlobUrl(id, onProgress) {
  const { yt, minter, po_token, fetchFn } = await getPlayYT();
  const info = await yt.getBasicInfo(id, await opts(minter, id, { client: 'WEB' }));
  const sd = info.streaming_data;
  const ps = info.playability_status;
  if (ps && ps.status && ps.status !== 'OK') throw new Error('SABR: ' + ps.status + ' ' + (ps.reason || ''));
  if (!sd?.server_abr_streaming_url) throw new Error('SABR: brak URL');
  const serverAbrStreamingUrl = await yt.session.player.decipher(sd.server_abr_streaming_url);
  const ustreamer = info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
  if (!ustreamer) throw new Error('SABR: brak ustreamer config');
  const formats = (sd.adaptive_formats || []).map((f) => buildSabrFormat(f));
  const c = yt.session.context.client;

  const sabr = new SabrStream({
    videoId: id,
    fetchFunction: fetchFn,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: ustreamer,
    poToken: po_token,
    formats,
    clientInfo: { clientName: 1, clientVersion: c.clientVersion, osName: c.osName, osVersion: c.osVersion },
  });
  let sabrErr = null;
  try { sabr.on('error', (e) => { sabrErr = e; }); } catch { /* */ }
  const { audioStream, videoStream, selectedFormats } = sabr.start({
    enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
    audioPreferences: { container: 'mp4', preferredAudioCodec: 'aac', quality: 'AUDIO_QUALITY_MEDIUM' },
    isPostLiveDvr: false,
  });
  // Drain the (empty) video track so backpressure never stalls the session.
  if (videoStream) {
    (async () => { const r = videoStream.getReader(); for (;;) { const { done } = await r.read(); if (done) break; } })().catch(() => {});
  }
  const reader = audioStream.getReader();
  const parts = [];
  let bytes = 0;
  let lastChunk = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastChunk > 25000) {
      clearInterval(watchdog);
      sabr.abort().catch(() => {});
      reader.cancel(new Error('stall')).catch(() => {});
    }
  }, 2000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      bytes += value.byteLength;
      lastChunk = Date.now();
      onProgress?.(bytes);
    }
  } finally {
    clearInterval(watchdog);
  }
  if (sabrErr) throw new Error('SABR: ' + (sabrErr.message || sabrErr) + ' po ' + Math.round(bytes / 1024) + ' KB');
  if (Date.now() - lastChunk > 25000) throw new Error('SABR: stanął po ' + Math.round(bytes / 1024) + ' KB');
  const mime = (selectedFormats?.audioFormat?.mimeType || 'audio/mp4').split(';')[0];
  const blob = new Blob(parts, { type: mime });
  if (blob.size < 10000) throw new Error('SABR: za mały plik (' + blob.size + ' B)');
  return URL.createObjectURL(blob);
}
