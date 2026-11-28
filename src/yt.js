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
// YouTube's current auth header: one hash per SAPISID variant, computed for the
// ORIGIN THE REQUEST GOES TO (music.youtube.com vs www.youtube.com).
// youtubei.js always hashes for www.youtube.com, so YT Music saw us as logged out.
let currentCookie = null;
const ck = (c, name) => (c.match(new RegExp('(?:^|;\\s*)' + name.replace(/[$]/g, '\\$&') + '=([^;]+)')) || [])[1];
async function sha1hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function authHeaders(url) {
  if (!currentCookie) return null;
  const u = new URL(url);
  if (!/(^|\.)youtube\.com$/.test(u.hostname) || !u.pathname.startsWith('/youtubei/')) return null;
  const origin = 'https://' + u.hostname;
  const ts = Math.floor(Date.now() / 1000);
  const parts = [];
  for (const [scheme, name] of [['SAPISIDHASH', 'SAPISID'], ['SAPISID1PHASH', '__Secure-1PAPISID'], ['SAPISID3PHASH', '__Secure-3PAPISID']]) {
    const v = ck(currentCookie, name) || (name === 'SAPISID' ? ck(currentCookie, '__Secure-3PAPISID') : null);
    if (v) parts.push(`${scheme} ${ts}_${await sha1hex(`${ts} ${v} ${origin}`)}`);
  }
  if (!parts.length) return null;
  return { authorization: parts.join(' '), 'x-origin': origin, origin, 'x-goog-authuser': '0', cookie: currentCookie };
}
function applyAuth(headers, extra) {
  if (!extra) return;
  for (const k of Object.keys(headers)) {
    if (['authorization', 'x-origin', 'origin', 'x-goog-authuser', 'cookie'].includes(k.toLowerCase())) delete headers[k];
  }
  Object.assign(headers, extra);
}

function u8ToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function nativeFetch(input, init) {
  const { url, method, headers, body, binary } = await readRequest(input, init);
  applyAuth(headers, await authHeaders(url));
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
  const binResp = /googlevideo\.com|ytimg\.com|googleusercontent\.com|ggpht\.com/.test(url);
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
  applyAuth(headers, await authHeaders(url));
  if (binary) return fetch('/__proxy?u=' + encodeURIComponent(url), { method, headers, body: binary });
  if (headers.cookie) { headers['x-yt-cookie'] = headers.cookie; delete headers.cookie; }
  return fetch('/__proxy?u=' + encodeURIComponent(url), { method, headers, body });
}

/* ---------------- player id ---------------- */

// youtubei.js scrapes the player id from /iframe_api and fails on some responses
// (e.g. logged-in). Do it ourselves with looser patterns and a second source.
let playerIdPromise = null;
function getPlayerId() {
  if (!playerIdPromise) {
    playerIdPromise = (async () => {
      const f = isNative ? nativeFetch : devFetch;
      const tries = [
        ['https://www.youtube.com/iframe_api', /player\\?\/([A-Za-z0-9_-]{6,})\\?\//],
        ['https://www.youtube.com/embed/', /\/s\/player\/([A-Za-z0-9_-]{6,})\//],
        ['https://music.youtube.com/', /\/s\/player\/([A-Za-z0-9_-]{6,})\//],
      ];
      for (const [url, re] of tries) {
        try {
          const t = await (await f(url)).text();
          const m = t.match(re);
          if (m) { console.info('[player] id', m[1], 'from', url); return m[1]; }
          console.warn('[player] no id in', url, t.slice(0, 120));
        } catch (e) { console.warn('[player] fetch failed', url, e?.message); }
      }
      return undefined;
    })();
    playerIdPromise.then((id) => { if (!id) playerIdPromise = null; });
  }
  return playerIdPromise;
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
      currentCookie = cookie || null;
      if (cookie) await syncNativeCookies(cookie);
      const player_id = await getPlayerId();
      return Innertube.create({
        player_id,
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
  playPromise = null;
  await getYT();
  emit({ type: 'signed-in' });
}

export async function signOut() {
  currentCookie = null;
  await Preferences.remove({ key: COOKIE_KEY });
  playPromise = null;
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
export const isPlayable = (x) => !!(x && PLAYABLE.has(x.type) && /^[\w-]{11}$/.test(x.id || ''));

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

function tagSection(raw, sec) {
  const t = (sec.title || '').toLowerCase();
  const perCol = raw?.num_items_per_column || 0;
  if (/szybki wyb|quick pick/.test(t) || (perCol > 1 && sec.items.every(isPlayable))) return 'quick';
  if (/jeszcze raz|listen again|ponownie/.test(t)) return 'again';
  return 'normal';
}

let homeFeed = null;
export async function home(filter) {
  const yt = await getYT();
  let feed = await yt.music.getHomeFeed();
  const chips = (() => { try { return feed.filters || []; } catch { return []; } })();
  if (filter) feed = await feed.applyFilter(filter);
  homeFeed = feed;
  const raws = [...(feed.sections || [])];
  // pull a couple more pages so there's plenty to scroll
  for (let i = 0; i < 2 && feed.has_continuation; i++) {
    try { feed = await feed.getContinuation(); raws.push(...(feed.sections || [])); } catch { break; }
  }
  const sections = [];
  for (const raw of raws) {
    const [sec] = toSections([raw]);
    if (!sec) continue;
    sec.kind = tagSection(raw, sec);
    sec.strapline = txt(raw.header?.strapline);
    sections.push(sec);
  }
  // Quick picks + Listen again on top, like the YT Music app
  const order = { quick: 0, again: 1, normal: 2 };
  sections.sort((a, b) => order[a.kind] - order[b.kind]);
  return { chips, sections };
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

// Best single song match for "title artist" (used by playlist import).
export async function searchSong(q) {
  const yt = await getYT();
  try {
    const res = await yt.music.search(q, { type: 'song' });
    const items = toSections(res.contents || []).flatMap((s) => s.items).filter(isPlayable);
    if (items[0]) return { ...items[0], type: 'song' };
  } catch { /* fall back to the general search */ }
  const secs = await search(q);
  return secs.flatMap((s) => s.items).find(isPlayable) || null;
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

// Logged-in sessions must bind the streaming PO token to the account's DataSync ID,
// anonymous ones to visitorData (per yt-dlp's PO token guide).
async function fetchDataSyncId(fetchFn, cookie) {
  try {
    const r = await fetchFn('https://www.youtube.com/', { headers: { cookie } });
    const html = await r.text();
    const m = html.match(/"DATASYNC_ID":"([^"]+)"/);
    return m ? m[1].split('||')[0] : null;
  } catch { return null; }
}

// visitorData = base64url(protobuf { 1: id (string), 5: timestamp (int32) })
function encodeVisitorData(id, ts) {
  const idb = new TextEncoder().encode(id);
  const out = [0x0a, idb.length, ...idb, 0x28];
  let v = ts >>> 0;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  let bin = ''; for (const b of out) bin += String.fromCharCode(b);
  return encodeURIComponent(btoa(bin).replace(/\+/g, '-').replace(/\//g, '_'));
}
function decodeVisitorId(vd) {
  try {
    const bin = atob(decodeURIComponent(vd).replace(/-/g, '+').replace(/_/g, '/'));
    if (bin.charCodeAt(0) !== 0x0a) return '';
    return bin.slice(2, 2 + bin.charCodeAt(1));
  } catch { return ''; }
}
async function jarVisitorId() {
  try {
    const c = await CapacitorCookies.getCookies({ url: 'https://www.youtube.com' });
    return c?.VISITOR_INFO1_LIVE || '';
  } catch { return ''; }
}

function getPlayYT() {
  if (!playPromise) {
    playPromise = (async () => {
      const fetchFn = isNative ? nativeFetch : devFetch;
      const cookie = (await Preferences.get({ key: COOKIE_KEY })).value || undefined;
      const player_id = await getPlayerId();
      const base = { player_id, fetch: fetchFn, cache: new UniversalCache(false), retrieve_player: true, lang: 'pl', location: 'PL', cookie, user_agent: navigator.userAgent };
      // Real visitorData from YouTube (not generated locally): iOS keeps YouTube's visitor
      // cookie in its jar, so the token must be bound to the identity those cookies carry.
      const first = await Innertube.create({ ...base, generate_session_locally: false });
      let visitorData = first.session.context.client.visitorData;
      if (!cookie && isNative) {
        // Anonymous: iOS sends its own VISITOR_INFO1_LIVE cookie with every request, so YouTube
        // sees that visitor. Bind the session and the PO token to the same visitor, or the
        // stream gets cut after ~1 minute ("attestation pending").
        const jarId = await jarVisitorId();
        const ctxId = decodeVisitorId(visitorData);
        console.info('[PO] visitor ids: cookie', jarId, 'context', ctxId);
        if (jarId && jarId !== ctxId) visitorData = encodeVisitorData(jarId, Math.floor(Date.now() / 1000));
      }
      let binding = visitorData;
      if (cookie) {
        const ds = await fetchDataSyncId(fetchFn, cookie);
        if (ds) binding = ds;
        console.info('[PO] logged in, binding to', ds ? 'DataSync ID' : 'visitorData (no DataSync ID found)');
      } else {
        console.info('[PO] anonymous, binding to visitorData', String(visitorData).slice(0, 16));
      }
      try {
        const minter = await createPoMinter(first, fetchFn);
        const po_token = await minter.mintAsWebsafeString(binding);
        const yt = await Innertube.create({ ...base, visitor_data: visitorData, po_token });
        poStatus = 'ok' + (cookie ? ' (konto)' : '');
        // A brand-new anonymous visitor (used to continue a song past the per-visitor limit).
        const freshYT = () => Innertube.create({ ...base, cookie: undefined, generate_session_locally: true });
        return { yt, minter, po_token, fetchFn, visitorData, binding, freshYT };
      } catch (e) {
        poStatus = 'błąd: ' + String(e?.message || e).slice(0, 220);
        console.warn('PO token failed', e);
        return { yt: first, minter: null, po_token: undefined, fetchFn, visitorData, binding };
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

export async function hlsUrl(id) {
  const { yt, minter } = await getPlayYT();
  const info = await yt.getBasicInfo(id, await opts(minter, id, { client: 'IOS' }));
  const u = info.streaming_data?.hls_manifest_url;
  if (!u) throw new Error('brak HLS (' + (info.playability_status?.status || '?') + ')');
  return u;
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
const SABR_CLIENTS = { MWEB: { id: 2, version: '2.20260205.04.01' }, WEB: { id: 1, version: null } };

export async function sabrAudioBlobUrl(id, onProgress, client = 'WEB') {
  const r = await sabrAudioChunks(id, { onProgress }, client);
  const blob = new Blob(r.parts, { type: r.mime.split(';')[0] });
  if (blob.size < 10000) throw new Error('SABR: za mały plik (' + blob.size + ' B)');
  return URL.createObjectURL(blob);
}

// Streams the audio track; calls onMeta once (full mime + duration) and onChunk per piece.
export async function sabrAudioChunks(id, { onMeta, onChunk, onProgress } = {}, client = 'WEB', signal) {
  const check = () => { if (signal?.aborted) throw new DOMException('Cancelled','AbortError'); };
  check();
  const { yt: mainYT, minter, po_token, fetchFn, binding, visitorData, freshYT } = await getPlayYT();
  let yt = mainYT;
  const anonymous = !(binding && binding !== visitorData);
  // GVS (googlevideo) PO tokens for web are bound to the video ID (yt-dlp PO Token Guide).
  // Logged in we keep the account binding that already works; anonymous uses the video ID.
  const gvsBinding = binding && binding !== visitorData ? binding : id;
  const loadInfo = async () => {
    const info = await yt.getBasicInfo(id, await opts(minter, id, { client }));
    const url = info.streaming_data?.server_abr_streaming_url;
    return {
      info,
      serverAbrStreamingUrl: url ? await yt.session.player.decipher(url) : undefined,
      videoPlaybackUstreamerConfig: info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config,
    };
  };
  const first = await loadInfo();
  check();
  const info = first.info;
  const sd = info.streaming_data;
  const ps = info.playability_status;
  if (ps && ps.status && ps.status !== 'OK') throw new Error('SABR: ' + ps.status + ' ' + (ps.reason || ''));
  if (!sd?.server_abr_streaming_url) throw new Error('SABR ' + client + ': brak URL');
  const serverAbrStreamingUrl = first.serverAbrStreamingUrl;
  const ustreamer = first.videoPlaybackUstreamerConfig;
  if (!ustreamer) throw new Error('SABR: brak ustreamer config');
  const formats = (sd.adaptive_formats || []).map((f) => buildSabrFormat(f));
  const c = yt.session.context.client;

  // One SABR session. Anonymous sessions only get ~70 s before YouTube asks for an attestation
  // it won't accept; when that happens we open a fresh session (new player response) from where
  // the previous one stopped and keep appending. Logged-in sessions normally run in one go.
  let cfg = { serverAbrStreamingUrl, videoPlaybackUstreamerConfig: ustreamer };
  let meta = null;
  const parts = [];
  let bytes = 0;
  let sps = '';
  const durationMsTotal = Number(sd.adaptive_formats?.find((f) => f.mime_type?.startsWith('audio/mp4'))?.approx_duration_ms) || 0;

  const runSession = (startTimeMs, snapshot) => new Promise((resolve, reject) => {
    const sabr = new SabrStream({
      videoId: id,
      fetchFunction: fetchFn,
      serverAbrStreamingUrl: cfg.serverAbrStreamingUrl,
      videoPlaybackUstreamerConfig: cfg.videoPlaybackUstreamerConfig,
      poToken: po_token,
      formats,
      clientInfo: { clientName: SABR_CLIENTS[client].id, clientVersion: SABR_CLIENTS[client].version || c.clientVersion, osName: c.osName, osVersion: c.osVersion },
      callbacks: {
        onMintPoToken: minter ? async () => { console.info('[SABR] minting PO bound to', gvsBinding === id ? 'video ' + id : 'account'); return minter.mint(gvsBinding); } : undefined,
        onReloadPlayerResponse: async () => {
          const r = await loadInfo();
          return { serverAbrStreamingUrl: r.serverAbrStreamingUrl, videoPlaybackUstreamerConfig: r.videoPlaybackUstreamerConfig };
        },
      },
    });
    let bufferedMs = startTimeMs;
    let pending = false;
    try { sabr.on('streamProtectionStatusUpdate', (x) => { sps = String(x?.status ?? ''); pending = x?.status === 2 || x?.status === 3; }); } catch { /* */ }
    try { sabr.on('trackStateUpdate', (tc) => { const b = tc?.buffered; if (Number.isFinite(b) && b > bufferedMs) bufferedMs = b; }); } catch { /* */ }
    let sabrErr = null;
    try { sabr.on('error', (e) => { sabrErr = e; }); } catch { /* */ }
    const { audioStream, videoStream, selectedFormats } = sabr.start({
      enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
      audioPreferences: { container: 'mp4', preferredAudioCodec: 'aac', quality: 'AUDIO_QUALITY_MEDIUM' },
      isPostLiveDvr: false,
      ...(snapshot ? { snapshot } : { startTimeMs }),
    });
    if (!meta) {
      const fmt = selectedFormats?.audioFormat;
      meta = { mime: fmt?.mimeType || 'audio/mp4; codecs="mp4a.40.2"', durationMs: Number(fmt?.approxDurationMs) || durationMsTotal };
      onMeta?.(meta);
    }
    if (videoStream) {
      (async () => { const r = videoStream.getReader(); for (;;) { const { done } = await r.read(); if (done) break; } })().catch(() => {});
    }
    const reader = audioStream.getReader();
    const abort = () => { Promise.resolve(sabr.abort()).catch(()=>{}); reader.cancel().catch(()=>{}); };
    signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) abort();
    let lastChunk = Date.now();
    let cut = false;
    let snap = null;
    const startBytes = bytes;
    const watchdog = setInterval(async () => {
      const idle = Date.now() - lastChunk;
      // attestation wall: stop early and let the caller open a new session that resumes
      // from a snapshot of what we already have (so it continues instead of restarting at 0)
      if ((pending && idle > 5000) || idle > 25000) {
        cut = true;
        clearInterval(watchdog);
        // Take the snapshot synchronously: sabr.snapshot() waits for idle, which never comes
        // while it keeps retrying the walled request.
        try {
          const tracks = sabr.trackCollection?.snapshot?.() || [];
          if (tracks.length) snap = { playerTimeMs: bufferedMs, tracks };
        } catch (e) { console.warn('[SABR] snapshot failed', e?.message); }
        sabr.abort().catch(() => {});
        reader.cancel(new Error('stall')).catch(() => {});
      }
    }, 1000);
    (async () => {
      try {
        for (;;) {
          let res;
          try { res = await reader.read(); } catch (e) { if (cut) break; throw e; }
          check();
          if (res.done) break;
          parts.push(res.value);
          onChunk?.(res.value);
          bytes += res.value.byteLength;
          lastChunk = Date.now();
          onProgress?.(bytes);
        }
        clearInterval(watchdog);
        if (sabrErr && !cut) throw sabrErr;
        resolve({ cut, endMs: bufferedMs, snapshot: snap, gained: bytes - startBytes });
      } catch (e) { clearInterval(watchdog); reject(e); }
      finally { signal?.removeEventListener('abort',abort); try { reader.releaseLock(); } catch {} }
    })();
  });

  let startMs = 0;
  let snapshot = null;
  for (let session = 0; session < 40; session++) {
    check();
    let r;
    try { r = await runSession(startMs, snapshot); }
    catch (e) { check(); if (e?.guestLimit) throw e; throw new Error('SABR: ' + (e?.message || e) + ' po ' + Math.round(bytes / 1024) + ' KB (sps ' + sps + ')'); }
    const total = meta?.durationMs || durationMsTotal;
    if (!r.cut || (total && r.endMs >= total - 1500)) break;
    if (anonymous) { const e = new Error('GUEST_LIMIT'); e.guestLimit = true; e.partial = { ...meta, parts, bytes }; throw e; }
    if (session > 0 && (r.gained < 20000 || r.endMs <= startMs)) throw new Error('SABR: stanął po ' + Math.round(bytes / 1024) + ' KB (sps ' + sps + ')');
    console.info('[SABR] session', session + 1, 'cut at', r.endMs, 'ms, continuing in a new session', r.snapshot ? '(snapshot ' + r.snapshot.playerTimeMs + ' ms)' : '(no snapshot)');
    startMs = r.endMs;
    snapshot = r.snapshot;
    // The limit is per anonymous visitor + video, so continue as a new visitor.
    if (anonymous && freshYT) {
      try { yt = await freshYT(); console.info('[SABR] new visitor', String(yt.session.context.client.visitorData).slice(0, 16)); }
      catch (e) { console.warn('[SABR] fresh visitor failed', e?.message); }
    }
    const next = await loadInfo();
    cfg = { serverAbrStreamingUrl: next.serverAbrStreamingUrl, videoPlaybackUstreamerConfig: next.videoPlaybackUstreamerConfig };
  }
  return { ...meta, parts, bytes };
}

// Image bytes as a same-origin blob URL (so a canvas can read the pixels).
export async function imageObjectUrl(url) {
  const r = await (isNative ? nativeFetch(url) : devFetch(url));
  if (!r.ok) throw new Error('img ' + r.status);
  return URL.createObjectURL(await r.blob());
}

// Album tracks often have a linked music video ("counterpart"); its HLS stream works.
export async function counterpartId(id) {
  const yt = await getYT();
  const panel = await yt.music.getUpNext(id, false);
  for (const it of panel.contents || []) {
    const primary = it.primary || it;
    const vid = primary.video_id || primary.id;
    if (vid !== id) continue;
    const cp = it.counterpart?.[0];
    if (cp?.video_id) return cp.video_id;
  }
  return null;
}

export async function rate(id, like) {
  const yt = await getYT();
  return like ? yt.interact.like(id) : yt.interact.removeRating(id);
}
