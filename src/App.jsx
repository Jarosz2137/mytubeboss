import { energyLevel } from './energy.js';
import { profStart, profEnd, profJob, profReport, profilerPanel, profIsolated } from './profiler.js';
import { useEffect, useLayoutEffect, useRef, useState, useCallback, memo } from 'react';
import * as yt from './yt.js';
import { Preferences } from '@capacitor/preferences';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { useCoverColors, coverColors } from './colors.js';
import { getLogs, clearLogs } from './debuglog.js';
import {
  usePlayer, current, playList, addNext, jump, toggle, next, prev, seek, setMode, videoElement, audioElement,
  cycleRepeat, toggleShuffle, toggleLike, useTime, togglePip, pickOutput, dismissLoginPrompt, pipIfVideo, RATES, setRate, setSleep,
} from './player.js';
import { setBeat, beatOn, onBeat, setBeatTarget, restoreBeat, beatStatus, bandLevels, onFrame, dropTime, onDrop } from './beat.js';
import { onOta, otaState, applyNow, BUILD, recheck } from './ota.js';
import { canGoogleLogin, googleSignIn } from './googleLogin.js';
import { loadLocal, onLocal, localLists, getLocal, createLocal, addToLocal, removeFromLocal, renameLocal, deleteLocal, localCard, isLocalId, onAddSheet, openAddSheet } from './local.js';
import { readPlaylist, matchTracks, detectSource } from './importer.js';
import { getLyrics } from './lyrics.js';
import { loadIndex, onOffline, offlineState, isDownloaded, isQueued, downloadTracks, downloadedTracks, removeDownload } from './offline.js';

/* ---------------- helpers ---------------- */

const tap = (style = ImpactStyle.Light) => { Haptics.impact({ style }).catch(() => {}); };

// Share visibility tracking: offscreen marquees need neither animation nor a GPU layer.
const marqueeVisibility = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
  for (const e of entries) e.target.classList.toggle('mq-visible', e.isIntersecting);
}) : null;
const marqueeChecks = new WeakMap();
const marqueeResize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(entries => {
  for (const e of entries) marqueeChecks.get(e.target)?.();
}) : null;
// Long text scrolls like a car-radio display instead of being cut off.
const Marquee = memo(function Marquee({ text }) {
  const box = useRef(null);
  const inner = useRef(null);
  const [run, setRun] = useState(0);
  useLayoutEffect(() => {
    const check = () => {
      const b = box.current, i = inner.current;
      if (!b || !i) return;
      const w = i.scrollWidth - (parseFloat(getComputedStyle(i).paddingRight) || 0);
      setRun(w - b.clientWidth > 2 ? Math.ceil(w) : 0);
    };
    const node = box.current;
    check();
    marqueeChecks.set(node, check);
    marqueeResize?.observe(node);
    if (marqueeVisibility) marqueeVisibility.observe(node);
    else node.classList.add('mq-visible');
    return () => { marqueeResize?.unobserve(node); marqueeChecks.delete(node); marqueeVisibility?.unobserve(node); };

  }, [text]);
  const dur = run ? Math.max(8, (run + 48) / 32) : 0; // ~32 px/s
  return (
    <span ref={box} className={`mq ${run ? 'run' : ''}`} style={run ? { '--mq-d': `${dur}s`, '--mq-w': `${run + 48}px` } : undefined}>
      <span className="mq-track">
        <span ref={inner} className="mq-item">{text}</span>
        {run ? <span className="mq-item" aria-hidden="true">{text}</span> : null}
      </span>
    </span>
  );
});

function Wordmark({ size = 'md', showEgzey = true }) {
  return (
    <div className={`wm wm-${size}`} aria-label={showEgzey ? "Egzey MyTube Boss" : "MyTube Boss"}>
      {showEgzey && <span className="wm-egzey">EGZEY</span>}
      <span className="wm-mytube">MyTube</span>
      <span className="wm-boss">BOSS</span>
    </div>
  );
}

function Splash() {
  const [gone, setGone] = useState(false);
  const [hide, setHide] = useState(false);
  useEffect(() => {
    const a = setTimeout(() => setHide(true), 1300);
    const b = setTimeout(() => setGone(true), 1900);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);
  if (gone) return null;
  return (
    <div className={`splash ${hide ? 'hide' : ''}`}>
      <div className="sun" />
      <Wordmark size="xl" />
    </div>
  );
}

const greeting = () => {
  const h = new Date().getHours();
  if (h < 5) return 'Nocna zmiana';
  if (h < 12) return 'Dzień dobry';
  if (h < 18) return 'Siema';
  return 'Dobry wieczór';
};

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

function kindOf(item) {
  const id = item.id || '';
  if (isLocalId(id)) return 'local';
  if (item.type === 'downloads') return 'downloads';
  if (item.type === 'wrapped') return 'wrapped';
  if (yt.isPlayable(item)) return 'track';
  if (item.type === 'artist' || item.type === 'library_artist' || id.startsWith('UC')) return 'artist';
  if (item.type === 'album' || id.startsWith('MPR')) return 'album';
  return 'playlist';
}

function useAsync(fn, deps) {
  const [s, setS] = useState({ loading: true, data: null, error: '' });
  useEffect(() => {
    let alive = true;
    setS((prev) => ({ loading: true, data: prev.data, error: '' })); // stale-while-revalidate
    fn().then(
      (data) => alive && setS({ loading: false, data, error: '' }),
      (e) => alive && setS({ loading: false, data: null, error: e?.message || String(e) }),
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return s;
}

const Icon = {
  play: <svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" /></svg>,
  pause: <svg viewBox="0 0 24 24"><rect x="6" y="5" width="4.2" height="14" rx="1.2" /><rect x="13.8" y="5" width="4.2" height="14" rx="1.2" /></svg>,
  next: <svg viewBox="0 0 24 24"><path d="M4 6.2v11.6a1 1 0 0 0 1.55.83L13 13.6V17.8a1 1 0 0 0 1.55.83l8.2-5.8a1 1 0 0 0 0-1.66l-8.2-5.8A1 1 0 0 0 13 6.2v4.2L5.55 5.37A1 1 0 0 0 4 6.2Z" /></svg>,
  prev: <svg viewBox="0 0 24 24" style={{ transform: 'scaleX(-1)' }}><path d="M4 6.2v11.6a1 1 0 0 0 1.55.83L13 13.6V17.8a1 1 0 0 0 1.55.83l8.2-5.8a1 1 0 0 0 0-1.66l-8.2-5.8A1 1 0 0 0 13 6.2v4.2L5.55 5.37A1 1 0 0 0 4 6.2Z" /></svg>,
  back: <svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  down: <svg viewBox="0 0 24 24"><path d="m5 9 7 7 7-7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  home: <svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1v-9.5Z" /></svg>,
  search: <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.4" /><path d="m15.5 15.5 5 5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>,
  lib: <svg viewBox="0 0 24 24"><rect x="3" y="4" width="3.5" height="16" rx="1" /><rect x="8.5" y="4" width="3.5" height="16" rx="1" /><path d="m14.5 5.2 3.4-.9 3.6 15.4-3.4.8z" /></svg>,
  queue: <svg viewBox="0 0 24 24"><path d="M4 6h12M4 11h12M4 16h8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" /><path d="M17 14v7l5-3.5z" /></svg>,
  heart: <svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 7.8 3.6 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.4 0 5.6 3.3 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2Z" /></svg>,
  heartO: <svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 7.8 3.6 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.4 0 5.6 3.3 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2Z" fill="none" stroke="currentColor" strokeWidth="2" /></svg>,
  shuffle: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7h3.5c2 0 3.2 1 4.3 2.7l2.4 4.6C14.3 16 15.5 17 17.5 17H21M17.5 4 21 7l-3.5 3M3 17h3.5c1.4 0 2.4-.5 3.2-1.3M13.3 8.3C14.1 7.5 15.1 7 16.5 7H21M17.5 14l3.5 3-3.5 3" /></svg>,
  repeat: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 2.5 20.5 6 17 9.5" /><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13M7 21.5 3.5 18 7 14.5" /><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13" /></svg>,
  plus: <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>,
  minus: <svg viewBox="0 0 24 24"><path d="M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>,
  addList: <svg viewBox="0 0 24 24"><path d="M4 6h11M4 11h11M4 16h7M18 13v8M14 17h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>,
  download: <svg viewBox="0 0 24 24"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  check: <svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
};

function Cover({ src, round, className = '' }) {
  const [ok, setOk] = useState(true);
  return (
    <div className={`cover ${round ? 'round' : ''} ${className}`}>
      {src && ok ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setOk(false)} /> : <div className="cover-ph">♪</div>}
    </div>
  );
}

function Loader() {
  return <div className="loader"><span /><span /><span /></div>;
}

function Err({ text }) {
  return <div className="err">{text}</div>;
}

/* ---------------- building blocks ---------------- */

// Hold a track (or right-click) to add it to a playlist.
function useHold(onHold) {
  const tm = useRef(null);
  const fired = useRef(false);
  const clear = () => { clearTimeout(tm.current); tm.current = null; };
  return {
    onTouchStart: () => { fired.current = false; clear(); tm.current = setTimeout(() => { fired.current = true; tap(ImpactStyle.Medium); onHold(); }, 480); },
    onTouchMove: clear, onTouchEnd: clear, onTouchCancel: clear,
    onContextMenu: (e) => { e.preventDefault(); fired.current = true; onHold(); },
    held: () => { const f = fired.current; fired.current = false; return f; },
  };
}

function TrackRow({ t, list, i, onOpen, showCover = true, index, onRemove }) {
  const rowState = usePlayer(s => s.queue[s.index]?.id === t.id ? (s.playing ? 2 : 1) : 0);
  const active = rowState !== 0;
  const hold = useHold(() => openAddSheet(t));
  const { held, ...holdProps } = hold;
  return (
    <div {...holdProps} className={`row stagger ${active ? 'active' : ''}`} style={{ '--i': Math.min(i, 14) }} onClick={() => { if (held()) return; tap(); playList(list, i); }}>
      {showCover ? <Cover src={t.thumb} className="row-cover" /> : <div className="row-index">{index ?? i + 1}</div>}
      <div className="row-text">
        <div className="row-title"><Marquee text={t.title} /></div>
        <div className="row-sub">
          {t.type === 'video' && <span className="pill">Teledysk</span>}
          <span
            className={t.artistId ? 'link' : ''}
            onClick={(e) => { if (t.artistId) { e.stopPropagation(); onOpen({ type: 'artist', id: t.artistId }); } }}
          ><Marquee text={t.subtitle} /></span>
        </div>
      </div>
      {isDownloaded(t.id) && <span className="row-dl" aria-label="Pobrane">{Icon.download}</span>}
      {rowState === 2 ? <div className="eq"><span /><span /><span /></div> : <div className="row-dur">{t.duration ? fmt(t.duration) : ''}</div>}
      {onRemove
        ? <button className="icon-btn small" onClick={(e) => { e.stopPropagation(); tap(); onRemove(); }} aria-label="Usuń z playlisty">{Icon.minus}</button>
        : <button className="icon-btn small" onClick={(e) => { e.stopPropagation(); addNext(t); }} aria-label="Zagraj następne">{Icon.plus}</button>}
    </div>
  );
}

function Card({ item, onOpen, i = 0 }) {
  const kind = kindOf(item);
  return (
    <div className="card stagger" style={{ '--i': Math.min(i, 10) }} onClick={() => { tap(); onOpen(item); }}>
      <Cover src={item.thumb} round={kind === 'artist'} />
      <div className="card-title"><Marquee text={item.title} /></div>
      <div className="card-sub"><Marquee text={kind === 'artist' ? 'Wykonawca' : item.subtitle} /></div>
    </div>
  );
}

// Horizontal shelf that loops forever, with a cover-flow style depth effect.
function LoopShelf({ items, onOpen }) {
  const ref = useRef();
  const loop = items.length >= 4;
  const list = loop ? [...items, ...items, ...items] : items;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const setW = () => el.scrollWidth / 3;
    if (loop) el.scrollLeft = setW();
    let raf = 0;
    const paint = () => {
      raf = 0;
      if (loop) {
        const w = setW();
        if (el.scrollLeft < w * 0.5) el.scrollLeft += w;
        else if (el.scrollLeft > w * 1.5) el.scrollLeft -= w;
      }
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const mid = box.left + box.width / 2;
      // Batch layout reads before writes, avoiding forced layout per card.
      const cards = Array.from(el.children, c => ({cov:c.firstChild,r:c.getBoundingClientRect()}))
        .filter(({r}) => r.right >= box.left-box.width && r.left <= box.right+box.width);
      for (const {cov,r} of cards) {
        const d = Math.max(-1.6, Math.min(1.6, (r.left + r.width / 2 - mid) / box.width));
        if (cov) {
          cov.style.transform = `perspective(600px) rotateY(${d * -14}deg) scale(${1 - Math.abs(d) * 0.1})`;
          cov.style.opacity = String(1 - Math.abs(d) * 0.3);
        }
      }
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(paint); };
    paint();
    const resizeObserver = new ResizeObserver(onScroll);
    resizeObserver.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { resizeObserver.disconnect(); el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [items, loop]);
  return (
    <div className="shelf loop" ref={ref}>
      {list.map((it, i) => <Card key={(it.id || '') + i} i={i % items.length} item={it} onOpen={(x) => (yt.isPlayable(x) ? playList([x], 0) : onOpen(x))} />)}
    </div>
  );
}

function Section({ s, onOpen }) {
  const tracks = s.items.filter(yt.isPlayable);
  const mostlyTracks = tracks.length >= s.items.length * 0.7;
  return (
    <section className="section">
      {s.title && <h2>{s.title}</h2>}
      {mostlyTracks ? (
        <div className="track-grid">
          {tracks.slice(0, 12).map((t, i) => <TrackRow key={t.id + i} t={t} list={tracks} i={i} onOpen={onOpen} />)}
        </div>
      ) : (
        <LoopShelf items={s.items} onOpen={onOpen} />
      )}
    </section>
  );
}

/* ---------------- views ---------------- */

function QuickPicks({ s }) {
  const tracks = s.items.filter(yt.isPlayable);
  const pages = [];
  for (let i = 0; i < tracks.length; i += 4) pages.push(tracks.slice(i, i + 4));
  return (
    <section className="section">
      <div className="sec-head"><h2>{s.title || 'Szybki wybór'}</h2><button className="sec-play" onClick={() => { tap(); playList(tracks, 0); }}>{Icon.play} Odtwórz</button></div>
      <div className="qp-pages">
        {pages.map((pg, pi) => (
          <div className="qp-page" key={pi}>
            {pg.map((t, j) => {
              const i = pi * 4 + j;
              return (
                <div className="qp-row stagger" style={{ '--i': i }} key={t.id + i} onContextMenu={(e) => { e.preventDefault(); openAddSheet(t); }} onClick={() => { tap(); playList(tracks, i); }}>
                  <Cover src={t.thumb} className="qp-cover" />
                  <div className="row-text"><div className="row-title"><Marquee text={t.title} /></div><div className="row-sub"><Marquee text={t.subtitle} /></div></div>
                  <button className="icon-btn small" onClick={(e) => { e.stopPropagation(); tap(); addNext(t); }}>{Icon.plus}</button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

function ListenAgain({ s, onOpen }) {
  return (
    <section className="section">
      {s.strapline && <div className="strap">{s.strapline}</div>}
      <h2>{s.title || 'Posłuchaj jeszcze raz'}</h2>
      <div className="la-grid">
        {s.items.map((it, i) => {
          const kind = kindOf(it);
          return (
            <div className="la-tile stagger" style={{ '--i': i }} key={(it.id || '') + i} onClick={() => { tap(); yt.isPlayable(it) ? playList(s.items.filter(yt.isPlayable), s.items.filter(yt.isPlayable).indexOf(it)) : onOpen(it); }}>
              <Cover src={it.thumb} round={kind === 'artist'} />
              <div className="la-title"><Marquee text={it.title} /></div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// "Now playing" pill on the home hero (taps open the player via the mini player)
function NowChip() {
  const p = usePlayer();
  const t = current();
  if (!t) return <div className="hh-tag">Bez reklam · w tle · z ekranem blokady</div>;
  return (
    <div className={`hh-now ${p.playing ? 'on' : ''}`}>
      <span className="eq"><span /><span /><span /></span>
      <span className="hh-now-t"><Marquee text={`${t.title} · ${t.subtitle}`} /></span>
    </div>
  );
}

// Keep measured space for distant feed sections without retaining their card DOM.
const feedVisibilityCallbacks = new WeakMap();
const feedVisibility = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
  for (const e of entries) feedVisibilityCallbacks.get(e.target)?.(e.isIntersecting);
}, {rootMargin:'700px 0px'}) : null;
const FeedSection = memo(function FeedSection({ sec, onOpen, eager }) {
  const ref = useRef(null);
  const height = useRef(0);
  const [visible,setVisible] = useState(eager || !feedVisibility);
  useLayoutEffect(() => {
    const node=ref.current;
    if (!node || !feedVisibility) return;
    const update = near => {
      // A hidden tab has no usable geometry; retain its last measured height.
      if (near) setVisible(true);
      else {
        const h=node.getBoundingClientRect().height;
        if(h>0) height.current=h;
        setVisible(false);
      }
    };
    feedVisibilityCallbacks.set(node,update);
    feedVisibility.observe(node);
    return () => {feedVisibility.unobserve(node);feedVisibilityCallbacks.delete(node);};
  }, []);
  return <div ref={ref} style={visible ? undefined : {minHeight:height.current || 280, display:'flow-root'}}>
    {visible && (sec.kind === 'quick' ? <QuickPicks s={sec} /> : sec.kind === 'again' ? <ListenAgain s={sec} onOpen={onOpen} /> : <Section s={sec} onOpen={onOpen} />)}
  </div>;
});

function HomeView({ onOpen, fresh }) {
  const [chip, setChip] = useState(null);
  const s = useAsync(() => yt.home(chip), [chip, fresh]);
  useEffect(() => {
    if (!s.loading && s.data) console.info('[home] rendered', s.data.sections.length, 'sections');
  }, [s.loading, s.data]);
  const [chips, setChips] = useState([]);
  useEffect(() => { if (s.data?.chips?.length && !chips.length) setChips(s.data.chips); }, [s.data]);
  return (
    <div className="view">
      <div className="home-hero">
        <div className="hh-sun" aria-hidden="true" />
        <div className="hh-grid" aria-hidden="true" />
        <div className="hh-content">
          <div className="greet">{greeting()}</div>
          <Wordmark showEgzey={false} />
          <NowChip />
        </div>
      </div>
      {chips.length > 0 && (
        <div className="chips">
          <button className={!chip ? 'on' : ''} onClick={() => { tap(); setChip(null); }}>Wszystko</button>
          {chips.map((c) => <button key={c} className={chip === c ? 'on' : ''} onClick={() => { tap(); setChip(chip === c ? null : c); }}>{c}</button>)}
        </div>
      )}
      {s.loading && (s.data ? <div className="refreshing" /> : <Loader />)}
      {s.error && <Err text={s.error} />}
      {s.data?.sections.map((sec, i) => <FeedSection key={i + ':' + sec.kind + ':' + (sec.title || '')} sec={sec} onOpen={onOpen} eager={i<2} />)}
    </div>
  );
}

function SearchView({ onOpen }) {
  const [q, setQ] = useState('');
  const [sug, setSug] = useState([]);
  const [res, setRes] = useState({ loading: false, data: null, error: '' });
  const timer = useRef();

  useEffect(() => {
    clearTimeout(timer.current);
    if (!q.trim()) { setSug([]); return; }
    timer.current = setTimeout(() => yt.suggestions(q).then(setSug).catch(() => {}), 220);
  }, [q]);

  const run = async (query) => {
    const term = (query ?? q).trim();
    if (!term) return;
    setQ(term);
    setSug([]);
    document.activeElement?.blur?.();
    setRes({ loading: true, data: null, error: '' });
    try { setRes({ loading: false, data: await yt.search(term), error: '' }); } catch (e) { setRes({ loading: false, data: null, error: e?.message || String(e) }); }
  };

  return (
    <div className="view">
      <h1 className="big">Szukaj</h1>
      <form className="searchbar" onSubmit={(e) => { e.preventDefault(); run(); }}>
        {Icon.search}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Wykonawcy, utwory, albumy" enterKeyHint="search" autoCorrect="off" autoCapitalize="off" />
        {q && <button type="button" className="clear" onClick={() => { setQ(''); setRes({ loading: false, data: null, error: '' }); }}>✕</button>}
      </form>
      {sug.length > 0 && (
        <div className="suggest">{sug.map((s) => <div key={s} onClick={() => run(s)}>{Icon.search}<span>{s}</span></div>)}</div>
      )}
      {res.loading && <Loader />}
      {res.error && <Err text={res.error} />}
      {res.data?.map((sec, i) => <Section key={i} s={sec} onOpen={onOpen} />)}
    </div>
  );
}

// Playlists stored on the phone + import from Spotify / Apple Music.
// ---- Boss Wrapped: your stats any day of the year (from history kept on the phone) ----
function WrappedView({ onOpen }) {
  const [h, setH] = useState(null);
  const [range, setRange] = useState(30);
  useEffect(() => { Preferences.get({ key: 'history' }).then(({ value }) => { try { setH(JSON.parse(value || '[]')); } catch { setH([]); } }); }, []);
  if (!h) return <div className="view"><Loader /></div>;
  const since = range ? Date.now() - range * 864e5 : 0;
  const list = h.filter((x) => x.at >= since);
  const totalMin = Math.round(list.reduce((a, x) => a + x.sec, 0) / 60);
  const by = (key) => {
    const m = new Map();
    for (const x of list) { const k = key(x); if (!k) continue; const e = m.get(k) || { n: 0, sec: 0, x }; e.n++; e.sec += x.sec; m.set(k, e); }
    return [...m.values()].sort((a, b) => b.n - a.n);
  };
  const topTracks = by((x) => x.id).slice(0, 5);
  const topArtists = by((x) => (x.subtitle || '').split(',')[0].trim()).slice(0, 5);
  const hours = new Array(24).fill(0); list.forEach((x) => { hours[new Date(x.at).getHours()]++; });
  const peak = hours.indexOf(Math.max(...hours));
  const days = new Set(h.map((x) => new Date(x.at).toDateString()));
  let streak = 0; for (let d = new Date(); days.has(d.toDateString()); d.setDate(d.getDate() - 1)) streak++;
  const vibe = peak < 5 ? 'Nocny boss' : peak < 11 ? 'Poranny rozruch' : peak < 17 ? 'Dzienna zmiana' : peak < 22 ? 'Wieczorny cruise' : 'Nocny boss';
  return (
    <div className="view wrapped">
      <div className="wr-hero">
        <div className="wr-kicker">BOSS WRAPPED</div>
        <h1 className="big">Twoje słuchanie</h1>
        <div className="chips">
          {[[7, '7 dni'], [30, '30 dni'], [365, 'Rok'], [0, 'Zawsze']].map(([v, l]) => (
            <button key={l} className={range === v ? 'on' : ''} onClick={() => { tap(); setRange(v); }}>{l}</button>
          ))}
        </div>
      </div>
      {!list.length ? <p className="empty-note">Jeszcze nic tu nie ma. Posłuchaj trochę muzyki, a statystyki zbudują się same.</p> : (
        <>
          <div className="wr-stats">
            <div className="wr-stat big"><b>{totalMin.toLocaleString('pl-PL')}</b><span>minut muzyki</span></div>
            <div className="wr-stat"><b>{list.length}</b><span>odtworzeń</span></div>
            <div className="wr-stat"><b>{streak}</b><span>{streak === 1 ? 'dzień' : 'dni'} z rzędu</span></div>
            <div className="wr-stat"><b>{String(peak).padStart(2, '0')}:00</b><span>{vibe}</span></div>
          </div>
          <section className="section">
            <div className="sec-head"><h2>Top utwory</h2></div>
            <div className="wr-list">
              {topTracks.map((e, i) => (
                <button key={e.x.id} className="wr-row" onClick={() => { tap(); playList(topTracks.map((t) => ({ type: 'song', id: t.x.id, title: t.x.title, subtitle: t.x.subtitle, thumb: t.x.thumb })), i); }}>
                  <span className="wr-rank">{i + 1}</span>
                  <Cover src={e.x.thumb} className="row-cover" />
                  <span className="wr-txt"><b><Marquee text={e.x.title} /></b><small>{e.x.subtitle}</small></span>
                  <span className="wr-n">{e.n}×</span>
                </button>
              ))}
            </div>
          </section>
          <section className="section">
            <div className="sec-head"><h2>Top wykonawcy</h2></div>
            <div className="wr-list">
              {topArtists.map((e, i) => (
                <div key={i} className="wr-row"><span className="wr-rank">{i + 1}</span><Cover src={e.x.thumb} className="row-cover round" /><span className="wr-txt"><b>{(e.x.subtitle || '').split(',')[0]}</b><small>{Math.round(e.sec / 60)} min</small></span><span className="wr-n">{e.n}×</span></div>
              ))}
            </div>
          </section>
          <section className="section">
            <div className="sec-head"><h2>Kiedy słuchasz</h2></div>
            <div className="wr-hours">{hours.map((v, i) => <i key={i} style={{ transform: `scaleY(${Math.max(0.04, v / (Math.max(...hours) || 1))})` }} className={i === peak ? 'peak' : ''} />)}</div>
            <div className="wr-hours-l"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
          </section>
        </>
      )}
    </div>
  );
}

function LocalShelf({ onOpen, signedIn = false }) {
  const [lists, setLists] = useState(localLists());
  const [importing, setImporting] = useState(false);
  useEffect(() => { loadLocal().then(setLists); return onLocal((l) => setLists([...l])); }, []);
  const create = async () => {
    const n = prompt('Nazwa nowej playlisty', 'Moja playlista');
    if (!n) return;
    const l = await createLocal(n.trim());
    onOpen(localCard(l));
  };
  const off = useOffline();
  return (
    <section className="local-shelf">
      <div className="lib-grid">
        {signedIn && (
          <button className="lt lt-liked" onClick={() => { tap(); onOpen({ type: 'playlist', id: 'LM', title: 'Polubione' }); }}>
            <span className="lt-ico">♥</span><span className="lt-t">Polubione</span><span className="lt-s">z Twojego konta YouTube</span><i className="lt-shine" />
          </button>
        )}
        <button className="lt lt-dl" onClick={() => { tap(); onOpen({ type: 'downloads', id: 'downloads' }); }}>
          <span className="lt-ico">{Icon.download}</span><span className="lt-t">Pobrane</span><span className="lt-s">{off.count ? `${off.count} utw. offline` : 'gra bez internetu'}</span>
        </button>
        <button className="lt lt-imp" onClick={() => { tap(); setImporting(true); }}>
          <span className="lt-ico">⇄</span><span className="lt-t">Import</span><span className="lt-s">Spotify · Apple Music</span>
        </button>
        <button className="lt lt-new" onClick={() => { tap(); create(); }}>
          <span className="lt-ico">{Icon.plus}</span><span className="lt-t">Nowa playlista</span><span className="lt-s">w telefonie</span>
        </button>
        <button className="lt lt-wrap" onClick={() => { tap(); onOpen({ type: 'wrapped', id: 'wrapped' }); }}>
          <span className="lt-ico">✦</span><span className="lt-t">Boss Wrapped</span><span className="lt-s">Twoje statystyki</span>
        </button>
        <div className="lt lt-stat" aria-hidden="true">
          <span className="lt-num">{lists.length}</span><span className="lt-s">{lists.length === 1 ? 'playlista' : 'playlist'} w telefonie</span>
        </div>
      </div>
      {lists.length > 0 && (
        <section className="section">
          <div className="sec-head"><h2>Playlisty w telefonie</h2></div>
          <div className="local-row">
            {lists.map((l, i) => <Card key={l.id} item={localCard(l)} onOpen={onOpen} i={i} />)}
          </div>
        </section>
      )}
      {importing && <ImportSheet onClose={() => setImporting(false)} onDone={(l) => { setImporting(false); onOpen(localCard(l)); }} />}
    </section>
  );
}

function ImportSheet({ onClose, onDone }) {
  const [link, setLink] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | reading | matching
  const [prog, setProg] = useState({ done: 0, total: 0, matched: 0 });
  const [err, setErr] = useState('');
  const src = detectSource(link);
  const go = async () => {
    setErr(''); setPhase('reading');
    try {
      const pl = await readPlaylist(link);
      setPhase('matching'); setProg({ done: 0, total: pl.tracks.length, matched: 0 });
      const found = await matchTracks(pl.tracks, (done, total, matched) => setProg({ done, total, matched }));
      const tracks = found.filter(Boolean);
      if (!tracks.length) throw new Error('Nie znalazłem żadnego z tych utworów na YouTube.');
      const l = await createLocal(pl.title, tracks, pl.source);
      onDone(l);
    } catch (e) { setErr(e?.message || String(e)); setPhase('idle'); }
  };
  return (
    <div className="sheet-backdrop" onClick={phase === 'idle' ? onClose : undefined}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="np-grabber" />
        <h3>Import playlisty</h3>
        <p className="hint">Wklej link do publicznej playlisty albo albumu ze Spotify lub Apple Music. Apka znajdzie te utwory na YouTube i zrobi z nich playlistę w telefonie.</p>
        <label className="sr-only" htmlFor="imp-link">Link do playlisty</label>
        <input id="imp-link" className="text-input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://open.spotify.com/playlist/…" disabled={phase !== 'idle'} />
        {link && !src && <p className="hint warn">To nie wygląda na link ze Spotify ani Apple Music.</p>}
        {phase === 'reading' && <p className="hint">Czytam playlistę…</p>}
        {phase === 'matching' && (
          <div className="imp-prog">
            <div className="imp-bar"><i style={{ transform: `scaleX(${prog.total ? prog.done / prog.total : 0})` }} /></div>
            <p className="hint">Szukam na YouTube: {prog.done}/{prog.total} · znalezione {prog.matched}</p>
          </div>
        )}
        {err && <Err text={err} />}
        <div className="sheet-actions">
          <button className="ghost" onClick={onClose} disabled={phase !== 'idle'}>Anuluj</button>
          <button className="primary" onClick={go} disabled={!src || phase !== 'idle'}>Importuj</button>
        </div>
      </div>
    </div>
  );
}

// "Add to playlist" sheet, opened from anywhere via openAddSheet(track)
function AddSheet() {
  const [track, setTrack] = useState(null);
  const [lists, setLists] = useState(localLists());
  const [done, setDone] = useState('');
  useEffect(() => onAddSheet((t) => { setDone(''); setTrack(t); loadLocal().then((l) => setLists([...l])); }), []);
  useEffect(() => onLocal((l) => setLists([...l])), []);
  if (!track) return null;
  const close = () => setTrack(null);
  const add = async (id, title) => { tap(); await addToLocal(id, track); setDone(title); setTimeout(close, 700); };
  return (
    <div className="sheet-backdrop" onClick={close}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="np-grabber" />
        <div className="add-head">
          <Cover src={track.thumb} className="row-cover" />
          <div className="row-text"><div className="row-title"><Marquee text={track.title} /></div><div className="row-sub"><Marquee text={track.subtitle} /></div></div>
        </div>
        {done ? <p className="add-done">{Icon.check} Dodano do „{done}”</p> : (
          <>
            <button className="add-item new" onClick={async () => { const n = prompt('Nazwa nowej playlisty', 'Moja playlista'); if (!n) return; const l = await createLocal(n.trim()); add(l.id, l.title); }}>{Icon.plus} Nowa playlista</button>
            {lists.map((l) => (
              <button key={l.id} className="add-item" onClick={() => add(l.id, l.title)}>
                <Cover src={l.tracks[0]?.thumb} className="add-cover" />
                <span><b>{l.title}</b><small>{l.tracks.length} utw.</small></span>
                {l.tracks.some((x) => x.id === track.id) && <i className="add-has">{Icon.check}</i>}
              </button>
            ))}
            <button className="add-item" onClick={() => { tap(); addNext(track); close(); }}>{Icon.next} Zagraj jako następny</button>
            {isDownloaded(track.id)
              ? <button className="add-item" onClick={() => { tap(); removeDownload(track.id); close(); }}>{Icon.minus} Usuń z pobranych</button>
              : <button className="add-item" onClick={() => { tap(); downloadTracks([track]); setDone('pobierania'); setTimeout(close, 700); }}>{Icon.download} Pobierz na telefon</button>}
          </>
        )}
      </div>
    </div>
  );
}

function LibraryView({ onOpen, fresh }) {
  const [signed, setSigned] = useState(null);
  const [cookie, setCookie] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    yt.isSignedIn().then(setSigned).catch((e) => setErr(e.message));
    return yt.onAuthEvent((e) => {
      if (e.type === 'signed-in') { setSigned(true); setReload((x) => x + 1); }
      if (e.type === 'signed-out') setSigned(false);
    });
  }, []);

  const lib = useAsync(() => (signed ? yt.library() : Promise.resolve([])), [signed, reload, fresh]);

  if (signed === null) return <div className="view"><h1 className="big">Biblioteka</h1><Loader /></div>;

  if (!signed) {
    const submit = async () => {
      setErr(''); setBusy(true);
      try { await yt.signInWithCookie(cookie); setCookie(''); } catch (e) { setErr(e.message); }
      setBusy(false);
    };
    const google = async () => {
      setErr(''); setBusy(true);
      try { await googleSignIn(); } catch (e) { if (!/cancel/i.test(e?.message || '')) setErr(e?.message || String(e)); }
      setBusy(false);
    };
    return (
      <div className="view">
        <h1 className="big">Biblioteka</h1>
        <div className="login">
          {canGoogleLogin() && (
            <>
              <p>Zaloguj się swoim kontem Google, a apka pokaże twoje playlisty, polubione i spersonalizowaną główną.</p>
              <button className="primary google-btn" disabled={busy} onClick={google}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3ZM12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Zm-5.6-8a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9.1L6.4 14Zm5.6-8c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5L6.4 10C7.2 7.7 9.4 6 12 6Z" /></svg>
                {busy ? 'Łączę…' : 'Zaloguj przez Google'}
              </button>
              <p className="hint">Logujesz się bezpośrednio w Google. Sesja zostaje tylko w tym telefonie, nikt inny jej nie widzi.</p>
              {err && <Err text={err} />}
            </>
          )}
          <details className="manual-login" open={!canGoogleLogin()}>
          <summary>Zaloguj ręcznie (wklejenie cookies)</summary>
          <p>Wklej cookies z zalogowanego YouTube Music, a apka będzie widziała twoje playlisty i polubione.</p>
          <ol className="steps">
            <li>Na kompie otwórz <b>music.youtube.com</b> (zalogowany).</li>
            <li>F12 / Cmd+Opt+I → zakładka <b>Network</b> → odśwież stronę.</li>
            <li>Kliknij dowolne zapytanie <b>browse</b> albo <b>next</b> → <b>Request Headers</b> → skopiuj całą wartość <b>cookie</b>.</li>
            <li>Wyślij to sobie na telefon (np. notatka) i wklej tutaj.</li>
          </ol>
          <textarea className="cookie-box" value={cookie} onChange={(e) => setCookie(e.target.value)} placeholder="SAPISID=...; __Secure-3PAPISID=...; ..." rows={4} />
          <button className="primary" disabled={busy || !cookie.trim()} onClick={submit}>{busy ? 'Łączę…' : 'Zaloguj'}</button>
          <p className="hint">Cookies zostają tylko w telefonie. Kto je ma, ten ma dostęp do konta, więc nie wrzucaj ich nigdzie indziej.</p>
          {!canGoogleLogin() && err && <Err text={err} />}
          </details>
        </div>
        <LocalShelf onOpen={onOpen} />
        <VersionLine />
      </div>
    );
  }

  return (
    <div className="view">
      <h1 className="big">Biblioteka</h1>
      <LocalShelf onOpen={onOpen} signedIn />
      {lib.loading && (lib.data ? <div className="refreshing" /> : <Loader />)}
      {lib.error && <Err text={lib.error} />}
      {lib.data?.map((sec, i) => <Section key={i} s={sec} onOpen={onOpen} />)}
      <div className="lib-account">
        {canGoogleLogin() && <button className="ghost" onClick={async () => { await yt.signOut(); try { await googleSignIn(); } catch { /* cancelled */ } }}>Zmień konto</button>}
        <button className="ghost" onClick={() => yt.signOut()}>Wyloguj</button>
      </div>
      <VersionLine />
    </div>
  );
}

function ArtistView({ id, onOpen }) {
  const s = useAsync(() => yt.artist(id), [id]);
  if (s.loading) return <div className="view"><Loader /></div>;
  if (s.error) return <div className="view"><Err text={s.error} /></div>;
  const a = s.data;
  const firstTracks = a.sections.find((x) => x.items.some(yt.isPlayable));
  return (
    <div className="view no-pad-top">
      <div className="hero" style={{ backgroundImage: a.thumb ? `url(${a.thumb})` : undefined }}>
        <div className="hero-fade" />
        <h1 className="hero-title">{a.title}</h1>
        {firstTracks && (
          <button className="play-fab" onClick={() => playList(firstTracks.items.filter(yt.isPlayable), 0)}>{Icon.play}</button>
        )}
      </div>
      {a.sections.map((sec, i) => <Section key={i} s={sec} onOpen={onOpen} />)}
      {a.description && <p className="about">{a.description}</p>}
    </div>
  );
}

function useOffline() {
  const [st, setSt] = useState({ ...offlineState, count: 0 });
  useEffect(() => { loadIndex(); return onOffline(setSt); }, []);
  return st;
}

function DownloadAllButton({ tracks }) {
  const st = useOffline();
  const playable = (tracks || []).filter(yt.isPlayable);
  if (!playable.length) return null;
  const have = playable.filter((t) => isDownloaded(t.id)).length;
  const busy = playable.some((t) => isQueued(t.id));
  const all = have === playable.length;
  return (
    <button className={`secondary dl-btn ${all ? 'done' : ''}`} disabled={all || busy} onClick={() => { tap(); downloadTracks(playable); }}>
      {all ? Icon.check : Icon.download} {all ? 'Pobrane' : busy ? `Pobieram ${have}/${playable.length}` : have ? `Pobierz resztę (${playable.length - have})` : 'Pobierz'}
      {st.error && !busy && <span className="dl-err" />}
    </button>
  );
}

// Banner while songs download in the background
function OfflineBar() {
  const st = useOffline();
  if (!st.current) return null;
  return (
    <div className="offline-bar">
      {Icon.download}<span><Marquee text={`Pobieram: ${st.current.title} · ${(st.progress / 1048576).toFixed(1)} MB${st.queue.length ? ` · jeszcze ${st.queue.length}` : ''}`} /></span>
    </div>
  );
}

function DownloadsView({ onOpen }) {
  const st = useOffline();
  const tracks = downloadedTracks();
  return (
    <div className="view">
      <h1 className="big">Pobrane</h1>
      <p className="hint">{tracks.length} utworów w telefonie. Grają bez internetu.</p>
      {tracks.length > 0 && (
        <div className="coll-actions">
          <button className="primary" onClick={() => playList(tracks, 0)}>{Icon.play} Odtwórz</button>
          <button className="secondary" onClick={() => playList(tracks.slice().sort(() => Math.random() - 0.5), 0)}>⤮ Losowo</button>
        </div>
      )}
      {st.error && <Err text={st.error} />}
      <div className="tracklist">
        {tracks.map((t, i) => <TrackRow key={t.id} t={t} list={tracks} i={i} onOpen={onOpen} onRemove={() => { if (confirm(`Usunąć „${t.title}” z pobranych?`)) removeDownload(t.id); }} />)}
      </div>
      {!tracks.length && <p className="empty-note">Nic jeszcze nie pobrałeś. Przytrzymaj utwór i wybierz „Pobierz na telefon” albo użyj przycisku „Pobierz” na playliście.</p>}
    </div>
  );
}

function LocalCollection({ id, onOpen, onBack }) {
  const [, force] = useState(0);
  useEffect(() => { loadLocal().then(() => force((x) => x + 1)); return onLocal(() => force((x) => x + 1)); }, []);
  const c = getLocal(id);
  if (!c) return <div className="view"><Loader /></div>;
  const total = c.tracks.reduce((a, t) => a + (t.duration || 0), 0);
  return (
    <div className="view">
      <div className="coll-head">
        <div className="coll-bg" style={{ backgroundImage: c.tracks[0]?.thumb ? `url(${c.tracks[0].thumb})` : undefined }} />
        <Cover src={c.tracks[0]?.thumb} className="coll-cover" />
        <h1 onClick={() => { const n = prompt('Nazwa playlisty', c.title); if (n && n.trim()) renameLocal(id, n.trim()); }}>{c.title}</h1>
        <div className="coll-sub">W telefonie{c.source ? ` · z ${c.source}` : ''}</div>
        <div className="coll-meta">{c.tracks.length} utworów{total ? ` · ${Math.round(total / 60)} min` : ''}</div>
        <div className="coll-actions">
          <button className="primary" disabled={!c.tracks.length} onClick={() => playList(c.tracks, 0)}>{Icon.play} Odtwórz</button>
          <button className="secondary" disabled={!c.tracks.length} onClick={() => playList(c.tracks.slice().sort(() => Math.random() - 0.5), 0)}>⤮ Losowo</button>
          <DownloadAllButton tracks={c.tracks} />
        </div>
      </div>
      {!c.tracks.length && <p className="empty-note">Pusta playlista. Przytrzymaj dowolny utwór albo użyj przycisku w playerze, żeby go tu dodać.</p>}
      <div className="tracklist">
        {c.tracks.map((t, i) => <TrackRow key={t.id + i} t={t} list={c.tracks} i={i} onOpen={onOpen} onRemove={() => removeFromLocal(id, i)} />)}
      </div>
      <button className="ghost danger" onClick={() => { if (confirm(`Usunąć playlistę „${c.title}”?`)) { deleteLocal(id); onBack?.(); } }}>Usuń playlistę</button>
    </div>
  );
}

function CollectionView({ id, kind, onOpen }) {
  const s = useAsync(() => (kind === 'album' ? yt.album(id) : yt.playlist(id)), [id, kind]);
  if (s.loading) return <div className="view"><Loader /></div>;
  if (s.error) return <div className="view"><Err text={s.error} /></div>;
  const c = s.data;
  const total = c.tracks.reduce((a, t) => a + (t.duration || 0), 0);
  return (
    <div className="view">
      <div className="coll-head">
        <div className="coll-bg" style={{ backgroundImage: c.thumb ? `url(${c.thumb})` : undefined }} />
        <Cover src={c.thumb} className="coll-cover" />
        <h1>{c.title}</h1>
        <div className="coll-sub">{c.subtitle}</div>
        <div className="coll-meta">{c.meta || `${c.tracks.length} utworów${total ? ' · ' + Math.round(total / 60) + ' min' : ''}`}</div>
        <div className="coll-actions">
          <button className="primary" onClick={() => playList(c.tracks, 0)}>{Icon.play} Odtwórz</button>
          <button className="secondary" onClick={() => {
            const sh = c.tracks.slice().sort(() => Math.random() - 0.5);
            playList(sh, 0);
          }}>⤮ Losowo</button>
          <DownloadAllButton tracks={c.tracks} />
        </div>
      </div>
      <div className="tracklist">
        {c.tracks.map((t, i) => <TrackRow key={t.id + i} t={t} list={c.tracks} i={i} onOpen={onOpen} showCover={kind !== 'album'} />)}
      </div>
      {c.more.map((sec, i) => <Section key={i} s={sec} onOpen={onOpen} />)}
    </div>
  );
}

/* ---------------- player UI ---------------- */

function MiniProgress() {
  const { time, duration } = useTime();
  const pct = duration ? (time / duration) * 100 : 0;
  return <div className="mini-progress" style={{ transform: `scaleX(${pct / 100})` }} />;
}

function MiniPlayer({ hidden, onDrag, onDragEnd }) {
  const p = usePlayer();
  const t = current();
  const ref = useRef();
  const cb = useRef({ onDrag, onDragEnd });
  cb.current = { onDrag, onDragEnd };

  // Native, non-passive listeners: preventDefault on move so iOS can't take the gesture.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let s0 = null;
    const start = (e) => {
      if (e.target.closest('button')) return;
      const y = e.touches[0].clientY;
      s0 = { y, ly: y, lt: performance.now(), v: 0, moved: false };
    };
    const move = (e) => {
      if (!s0) return;
      e.preventDefault();
      const y = e.touches[0].clientY, now = performance.now();
      s0.v = (y - s0.ly) / Math.max(1, now - s0.lt); s0.ly = y; s0.lt = now;
      if (Math.abs(y - s0.y) > 3) s0.moved = true;
      cb.current.onDrag(Math.min(0, y - s0.y));
    };
    const end = (e) => {
      if (!s0) return;
      const y = e.changedTouches?.[0]?.clientY ?? s0.ly;
      const st = s0; s0 = null;
      cb.current.onDragEnd(st.moved ? y - st.y : 0, st.v);
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end, { passive: true });
    el.addEventListener('touchcancel', end, { passive: true });
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [!!t]);

  if (!t) return null;
  return (
    <div ref={ref} className={`mini ${hidden ? 'mini-hidden' : ''}`}>
      <div className="mini-glow" style={{ backgroundImage: t.thumb ? `url(${t.thumb})` : undefined }} />
      <MiniProgress />
      <Cover key={t.id} src={t.thumb} className={`mini-cover ${p.playing ? 'spin-in' : ''}`} />
      <div className="mini-text" key={'t' + t.id}>
        <div className="mini-title"><Marquee text={t.title} /></div>
        <div className="mini-sub">{p.error ? p.error : t.subtitle}</div>
      </div>
      <button className="icon-btn pop" key={p.playing ? 'pa' : 'pl'} onClick={(e) => { e.stopPropagation(); tap(); toggle(); }}>{p.loading ? <span className="spin" /> : p.playing ? Icon.pause : Icon.play}</button>
      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); tap(); next(); }}>{Icon.next}</button>
    </div>
  );
}

// Modern live waveform: thin rounded bars growing from the centre, driven by the song's real
// band levels (bass in the middle, highs to the sides), smoothed, tinted by the cover.
function Visualizer() {
  const N = 41;
  const wrap = useRef(null);
  useEffect(() => {
    const bars = Array.from(wrap.current?.querySelectorAll('i') || []);
    const level = new Float32Array(N);
    const t0 = performance.now();
    const off = onFrame((L, now) => {
      if (!document.documentElement.classList.contains('np-open')) return; // player closed: nobody sees the bars
      const paused = audioElement.paused;
      const mid = (N - 1) / 2;
      for (let k = 0; k < N; k++) {
        const d = Math.abs(k - mid) / mid; // 0 centre .. 1 edge
        let target = 0.08 + 0.04 * Math.sin((now - t0) / 700 + k * 0.5); // idle shimmer
        if (L) {
          const pos = d * (L.length - 1), a = Math.floor(pos), f = pos - a;
          const v = L[a] * (1 - f) + (L[a + 1] ?? L[a]) * f;
          target = Math.max(0.08, v * (1 - d * 0.35));
        }
        level[k] = paused ? 0.08 : level[k] + (target - level[k]) * (target > level[k] ? 0.3 : 0.07);
        const v = level[k].toFixed(2);
        if (bars[k]._v !== v) { bars[k]._v = v; bars[k].style.transform = `scaleY(${v})`; }
      }
    });
    return off;
  }, []);
  return (
    <div className="viz wave" ref={wrap} aria-hidden="true">
      {[...Array(N)].map((_, i) => <i key={i} />)}
    </div>
  );
}

// Apple-Music-style scrubber: grab anywhere, drag is relative (no jump on touch),
// bar thickens while dragging, tap jumps to the spot.
function SleepChip() {
  const p = usePlayer();
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 15000); return () => clearInterval(i); }, []);
  const cur = p.sleep === 'track' ? 'track' : p.sleep ? 'time' : 0;
  const label = cur === 'track' ? 'Do końca' : cur === 'time' ? `${Math.max(1, Math.round((p.sleep - Date.now()) / 60000))} min` : 'Timer';
  const cycle = () => {
    tap();
    const mins = cur === 'time' ? Math.round((p.sleep - Date.now()) / 60000) : 0;
    const pick = cur === 0 ? 15 : cur === 'track' ? 0 : mins < 15 ? 30 : mins < 30 ? 45 : mins < 45 ? 60 : 'track';
    setSleep(pick);
  };
  return <button className={'np-key'+(cur ? ' on' : '')} aria-label={cur === 'track' ? 'Timer: koniec utworu' : `Timer: ${label}`} aria-pressed={!!cur} onClick={cycle}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.5A8.8 8.8 0 0 1 8.5 4 8.8 8.8 0 1 0 20 15.5z"/></svg><span>{label}</span></button>;
}

// Car mode: huge controls, readable from a phone holder
function CarMode() {
  const p = usePlayer();
  const t = current();
  const [on, setOn] = useState(false);
  useEffect(() => { const f = () => setOn(true); window.addEventListener('mtb-car', f); return () => window.removeEventListener('mtb-car', f); }, []);
  if (!on || !t) return null;
  return (
    <div className="car">
      <button className="car-x" onClick={() => { tap(); setOn(false); }} aria-label="Zamknij tryb auta">×</button>
      <div className="car-main">
        <Cover src={t.thumb} className="car-cover" />
        <div className="car-meta">
          <div className="car-title"><Marquee text={t.title} /></div>
          <div className="car-sub"><Marquee text={t.subtitle} /></div>
          <MiniProgress />
        </div>
      </div>
      <div className="car-ctl">
        <button onClick={() => { tap(); prev(); }} aria-label="Poprzedni">{Icon.prev}</button>
        <button className="car-play" onClick={() => { tap(ImpactStyle.Medium); toggle(); }} aria-label="Odtwarzaj / pauza">{p.playing ? Icon.pause : Icon.play}</button>
        <button onClick={() => { tap(); next(); }} aria-label="Następny">{Icon.next}</button>
      </div>
    </div>
  );
}

// Drop jump + playback speed, above the scrubber
function NpTools() {
  const p = usePlayer();
  const t = current();
  const [, force] = useState(0);
  useEffect(() => onDrop(() => force((x) => x + 1)), []);
  const drop = t && dropTime(t.id);
  const rate = p.rate || 1;
  const label = `${rate}×`;
  const [open, setOpen] = useState(false);
  useEffect(() => { const f = () => setOpen((x) => !x); window.addEventListener('mtb-tools', f); return () => window.removeEventListener('mtb-tools', f); }, []);
  const nextRate = () => { tap(); const i = RATES.indexOf(rate); setRate(RATES[(i + 1) % RATES.length]); };
  if (p.mode === 'video' || !open) return null;
  return (
    <div className={`np-tools ${open ? 'open' : ''}`}>
      {(
        <div className="np-tools-more np-console" role="group" aria-label="Narzędzia odtwarzacza">
          {drop ? <button className="np-key drop-ready" aria-label={`Przejdź do dropu ${fmt(drop)}`} onClick={() => { tap(ImpactStyle.Medium); seek(Math.max(0, drop - 1.5)); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 3-8 11h7l-1 7 8-11h-7z"/></svg><span>Drop · {fmt(drop)}</span></button>
            : <button className="np-key" disabled aria-label="Szukam dropu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 3-8 11h7l-1 7 8-11h-7z"/></svg><span>Drop · …</span></button>}
          <button className={'np-key'+(rate !== 1 ? ' on' : '')} aria-label={`Prędkość odtwarzania ${label}`} onClick={nextRate} onContextMenu={(e) => { e.preventDefault(); setRate(1); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.2 18a9 9 0 1 1 15.6 0H4.2zM12 14l4-5M6 13h1M12 6v1M17 13h1"/><circle cx="12" cy="14" r="1"/></svg><span>{label}</span></button>
          <SleepChip />
          <button className="np-key" aria-label="Tryb samochodowy" onClick={() => { tap(); window.dispatchEvent(new Event('mtb-car')); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 10 2-5h10l2 5M4 10h16l1 3v5H3v-5l1-3zM6 18v2M18 18v2M6 14h2M16 14h2"/></svg><span>Auto</span></button>
        </div>
      )}
    </div>
  );
}

function Scrubber() {
  const { time, duration } = useTime();
  const [drag, setDrag] = useState(null);
  const bar = useRef();
  const [, forceDrop] = useState(0);
  useEffect(() => onDrop(() => forceDrop((x) => x + 1)), []);
  const dropAt = current() && dropTime(current().id);
  const g = useRef(null);
  const max = duration || 1;
  const clamp = (v) => Math.max(0, Math.min(max, v));
  const val = drag ?? time;
  const onStart = (e) => {
    const r = bar.current.getBoundingClientRect();
    g.current = { x: e.touches[0].clientX, left: r.left, w: r.width, start: time, moved: false, v: time };
  };
  const onMove = (e) => {
    const s0 = g.current;
    if (!s0) return;
    const dx = e.touches[0].clientX - s0.x;
    if (!s0.moved && Math.abs(dx) < 4) return;
    if (!s0.moved) { s0.moved = true; tap(); }
    s0.v = clamp(s0.start + (dx / s0.w) * max);
    setDrag(s0.v);
  };
  const onEnd = (e) => {
    const s0 = g.current;
    g.current = null;
    if (!s0) return;
    if (!s0.moved) {
      const x = (e.changedTouches?.[0]?.clientX ?? s0.x) - s0.left;
      seek(clamp((x / s0.w) * max));
      tap();
    } else {
      seek(s0.v);
      tap(ImpactStyle.Medium);
    }
    setDrag(null);
  };
  return (
    <div className={`scrub ${drag != null ? 'active' : ''}`} ref={bar}
      onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onTouchCancel={onEnd}>
      <div className="scrub-track"><div className="scrub-fill" style={{ transform: `scaleX(${val / max})` }} /></div>
      {dropAt && max > 0 && <i className="scrub-drop" style={{ left: `${(dropAt / max) * 100}%` }} />}
      <div className="scrub-times"><span>{fmt(val)}</span><span>-{fmt(Math.max(0, (duration || 0) - val))}</span></div>
    </div>
  );
}

// Background scene picked per song (same song = same scene), all react to --bass / --mid / --high.
const SCENES = ['grid', 'rings', 'tunnel', 'hex', 'dots', 'prism'];
// warp starfield: fixed pseudo-random angles/speeds so it looks the same every render
const STARS = Array.from({ length: 46 }, (_, i) => {
  const r = (n) => { const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x); };
  return { '--a': `${r(1) * 360}deg`, '--d': `${2.2 + r(2) * 2.6}s`, '--o': `${-r(3) * 4}s`, '--s': `${2 + r(4) * 3}px` };
});
function sceneFor(id = '') { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return SCENES[h % SCENES.length]; }
// One clipped canvas for the three vector scenes; reuse the existing beat frame clock.
function GeometryScene({ kind, id }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const sheet = canvas.closest('.np');
    let w = 0, h = 0, ratio = 1, elapsed = 0, last = 0, drawn = false;
    let color = '#65d9ff', bass = 0, mid = 0, kick = 0;
    let colorDirty = true;
    const paletteChanged = () => { colorDirty = true; drawn = false; window.dispatchEvent(new Event('mtb-render-wake')); };
    const paletteObserver = new MutationObserver(paletteChanged);
    const app = canvas.closest('.app');
    if (app) paletteObserver.observe(app, {attributes:true, attributeFilter:['style']});
    const resize = () => {
      w = canvas.clientWidth; h = canvas.clientHeight;
      if (!w || !h) return;
      ratio = Math.min(window.devicePixelRatio || 1, energyLevel() >= 2 ? 1 : 1.5, 1200 / Math.max(w, h));
      const bw = Math.max(1, Math.round(w * ratio)), bh = Math.max(1, Math.round(h * ratio));
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      drawn = false;
      window.dispatchEvent(new Event('mtb-render-wake'));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas); resize();
    window.addEventListener('mtb-energy', resize);
    const poly = (points, scale, angle, alpha, width) => {
      ctx.save(); ctx.rotate(angle); ctx.scale(scale, scale);
      ctx.globalAlpha = alpha; ctx.lineWidth = width / scale;
      ctx.beginPath();
      points.forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
      ctx.closePath(); ctx.stroke(); ctx.restore();
    };
    const hex = [[0,-80],[69,-40],[69,40],[0,80],[-69,40],[-69,-40]];
    const tri = [[0,-70],[61,35],[-61,35]];
    const stars = STARS.map(s => ({
      angle: parseFloat(s['--a'])*Math.PI/180,
      duration: parseFloat(s['--d']), offset: -parseFloat(s['--o']),
      size: parseFloat(s['--s'])
    }));
    // Cache one tiny glow sprite, instead of 46 animated CSS shadows.
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 32;
    const glow = sprite.getContext('2d');
    let spriteColor = '';
    function updateSprite() {
      if (!glow || spriteColor === color) return;
      spriteColor = color;
      glow.clearRect(0,0,32,32);
      const g = glow.createRadialGradient(16,16,2,16,16,16);
      g.addColorStop(0,color); g.addColorStop(.3,color); g.addColorStop(1,'transparent');
      glow.fillStyle = g; glow.fillRect(0,0,32,32);
    }
    const off = onFrame((levels, now) => {
      if (profIsolated('scene')) return;
      if (!w || !h || !sheet?.classList.contains('open')) { last = 0; return; }
      const playing = sheet.classList.contains('is-playing');
      if ((!playing || energyLevel() >= 3) && drawn) { last = 0; return; }
      const dt = last ? Math.min(50, now-last) : 0;
      // Cap drawing at ~60 Hz, not the whole UI. No catch-up work after hiding.
      if (last && now-last < 15) return;
      const prof = profStart();
      last = now;
      if (playing) elapsed += dt / 1000;
      if (colorDirty) {
        color = getComputedStyle(canvas).color; colorDirty = false;
      }
      const reactive = sheet.classList.contains('beat-on') && playing;
      const b = reactive && levels ? (levels[0]+levels[1])/2 : 0;
      const m = reactive && levels ? (levels[2]+levels[3]+levels[4])/3 : 0;
      kick = Math.max(b, kick * .82);
      bass += (b-bass)*.35; mid += (m-mid)*.35;
      const unit = Math.max(w,h)*1.15/200;
      const pulse = kind === 'hex' ? 1+bass*.14+kick*.1 : kind === 'prism' ? 1+mid*.18+kick*.1 : 1+kick*.06;
      ctx.setTransform(ratio,0,0,ratio,0,0);
      ctx.clearRect(0,0,w,h);
      ctx.translate(w/2,h*.38);
      ctx.strokeStyle = color; ctx.lineJoin = 'round';
      ctx.scale(unit*pulse,unit*pulse);
      if (kind === 'hex') {
        for(let i=0;i<5;i++) {
          const s=.25+i*.22;
          poly(hex,s,elapsed*2*Math.PI/(30+i*6)*(i%2?-1:1),.5*(reactive ? .65+kick*.35 : 1),(reactive?1:.6)*s);
        }
      } else if (kind === 'prism') {
        for(let i=0;i<6;i++) {
          const phase=(1-Math.cos((elapsed+i*1.4)*2*Math.PI/14))/2, s=.3+i*.2;
          poly(tri,s,(i*20+phase*60)*Math.PI/180,(.5+.05*phase)*(reactive ? .65+kick*.35 : 1),(reactive?1:.6)*s);
        }
      } else if (kind === 'rings') {
        ctx.scale(1/unit/pulse,1/unit/pulse);
        const scale = reactive ? 1+bass*.2+kick*.15 : 1;
        for(let i=0;i<6;i++) {
          const p=((elapsed+i)%6)/6, s=.05+.95*p;
          ctx.globalAlpha=.5*Math.min(p/.15,(1-p)/.85);
          ctx.lineWidth=1.5*s*scale;
          ctx.beginPath(); ctx.arc(0,0,Math.max(w,h)*.525*s*scale,0,Math.PI*2); ctx.stroke();
        }
      } else if (kind === 'dots') {
        ctx.scale(1/unit/pulse,1/unit/pulse);
        updateSprite();
        const scale=reactive ? 1+bass*.25+kick*.2 : 1;
        const high=reactive && levels ? (levels[5]+levels[6]+levels[7])/3 : 0;
        const vmax=Math.max(w,h);
        for(const star of stars) {
          const p=((elapsed+star.offset)%star.duration)/star.duration;
          const q=p*p;
          const distance=vmax*(.04+.71*q)*scale;
          const sx=star.size*(.3+4.7*q), sy=star.size*(.3+.9*q);
          ctx.save(); ctx.rotate(star.angle); ctx.translate(distance,0);
          ctx.globalAlpha=Math.min(1,p/.15)*(reactive ? Math.min(1,.75+high*.25+kick*.3) : 1);
          ctx.drawImage(sprite,-sx*1.5,-sy*2.5,sx*3,sy*5);
          ctx.fillStyle=color; ctx.beginPath(); ctx.ellipse(0,0,sx/2,sy/2,0,0,Math.PI*2); ctx.fill();
          ctx.restore();
        }
      } else {
        for(let i=0;i<8;i++) {
          const p=((elapsed+i)%8)/8, s=.02+1.08*p;
          ctx.save(); ctx.rotate((p*90+mid*7)*Math.PI/180); ctx.scale(s,s);
          ctx.globalAlpha=.45*Math.min(p/.2,(1-p)/.8);
          ctx.lineWidth=1.5/(unit*pulse*s);
          ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(-60,-60,120,120,9); else ctx.rect(-60,-60,120,120); ctx.stroke(); ctx.restore();
        }
      }
      drawn = true;
      profEnd('canvas.'+kind, prof);
    });
    return () => { off(); observer.disconnect(); paletteObserver.disconnect(); window.removeEventListener('mtb-energy', resize); };
  }, [kind,id]);
  return <canvas ref={ref} className={'sc-geometry geometry-'+kind} />;
}
function Scene({ id }) {
  const kind = sceneFor(id);
  const geometry = kind !== 'grid';
  return (
    <div className={`np-scene ${geometry ? 'sc-geometry-wrap' : 'sc-'+kind}`} key={kind} aria-hidden="true">
      {kind === 'grid' && (<><div className="np-sun" /><div className="np-grid" /></>)}
      {geometry && <GeometryScene kind={kind} id={id} />}
    </div>
  );
}

function LyricsPanel({ t }) {
  const [ly, setLy] = useState(undefined);
  const box = useRef(null);
  useEffect(() => { setLy(undefined); let alive = true; getLyrics(t).then((r) => alive && setLy(r)); return () => { alive = false; }; }, [t?.id]);
  const { time } = useTime();
  let cur = -1;
  if (ly?.synced) {
    for (let i = 0; i < ly.lines.length; i++) {
      if (ly.lines[i].t <= time + .25) cur = i;
      else break;
    }
  }
  useEffect(() => {
    const el = box.current?.querySelector('.ly-line.on');
    if (el && box.current) box.current.scrollTo({ top: el.offsetTop - box.current.clientHeight * 0.38, behavior: 'smooth' });
  }, [cur]);
  return (
    <div className="np-lyrics" ref={box}>
      {ly === undefined && <Loader />}
      {ly === null && <p className="ly-empty">Nie znalazłem tekstu do tego utworu.</p>}
      {ly?.lines.map((l, i) => (
        <p key={i} className={`ly-line ${ly.synced ? (i === cur ? 'on' : i < cur ? 'past' : '') : 'plain'}`}
          onClick={() => { if (ly.synced) { tap(); seek(l.t); } }}>{l.text || '♪'}</p>
      ))}
      {ly && <p className="ly-src">Tekst: {ly.source}{ly.synced ? ' · zsynchronizowany' : ''}</p>}
    </div>
  );
}

// Bake the expensive full-screen blur once per artwork, not on every composite.
const backdropCache = new Map();
function BgBlur({ src }) {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !src) return;
    let alive = true;
    const cached = backdropCache.get(src);
    if (cached) { ctx.drawImage(cached, 0, 0); setReady(true); return; }
    const image = new Image();
    image.onload = () => {
      if (!alive) return;
      const w = image.naturalWidth, h = image.naturalHeight;
      if (!w || !h) return;
      const tile = document.createElement('canvas');
      tile.width = tile.height = 48;
      const c = tile.getContext('2d');
      if (!c) return;
      const scale = 48 / Math.min(w,h);
      c.drawImage(image,(48-w*scale)/2,(48-h*scale)/2,w*scale,h*scale);
      // Repeated low-resolution resampling produces a soft texture without live CSS blur.
      const small = document.createElement('canvas');
      small.width = small.height = 6;
      const sc = small.getContext('2d');
      if (!sc) return;
      sc.drawImage(tile,0,0,6,6);
      c.imageSmoothingQuality = 'high';
      c.drawImage(small,0,0,48,48);
      ctx.drawImage(tile,0,0);
      backdropCache.set(src,tile);
      while (backdropCache.size > 12) backdropCache.delete(backdropCache.keys().next().value);
      setReady(true);
    };
    image.src = src;
    return () => { alive = false; image.onload = null; };
  }, [src]);
  return <div className={'np-bg'+(ready?' baked':'')} style={!ready && src ? {backgroundImage:`url(${src})`} : undefined}><canvas ref={ref} width={48} height={48} /></div>;
}

function NowPlaying({ open, onClose, onOpen, sheetRef }) {
  const p = usePlayer();
  const t = current();
  const videoBox = useRef();
  const sheet = sheetRef;
  const [showQueue, setShowQueue] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [slide, setSlide] = useState('');
  const g = useRef(null);
  const [beat, setBeatState] = useState(beatOn());
  const goFull = () => {
    tap();
    const v = videoElement;
    if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iOS native player, rotates to landscape
    else v.requestFullscreen?.();
  };
  const [, bumpBeat] = useState(0);
  useEffect(() => onBeat((v) => { setBeatState(v); bumpBeat((x) => x + 1); }), []);
  useEffect(() => { restoreBeat(); }, []);
  useLayoutEffect(() => { setBeatTarget(sheet.current); }, [t?.id, p.mode, open, showLyrics, showQueue]);
  // Only one screen animates at a time: the player when open, the app behind it otherwise.
  useEffect(() => { document.documentElement.classList.toggle('np-open', !!open); window.dispatchEvent(new Event('mtb-render-wake')); }, [open]);

  // Move the single <video> engine into view when in video mode.
  useEffect(() => {
    const holder = document.getElementById('engine-holder');
    const pop = document.getElementById('video-pop-box');
    if (open && p.mode === 'video' && videoBox.current) videoBox.current.appendChild(videoElement);
    else if (!open && p.mode === 'video' && pop) pop.appendChild(videoElement); // floating window
    // While a music video is on (incl. system PiP), don't park it in the hidden holder:
    // moving the element mid-PiP closes the PiP window.
    else if (p.mode !== 'video' && holder && videoElement.parentElement !== holder) holder.appendChild(videoElement);
    if (!videoElement.paused) videoElement.play().catch(() => {}); // moving the node can pause it
  }, [open, p.mode]);

  // Interactive drag: down = shrink into the mini player, sideways on the cover = skip.
  const setT = (dy, animate) => {
    const el = sheet.current;
    if (!el) return;
    const h = window.innerHeight;
    const k = Math.min(1, Math.max(0, dy / h));
    el.style.transition = animate ? '' : 'none';
    el.style.transform = dy ? `translate3d(0, ${dy}px, 0) scale(${1 - k * 0.06})` : '';
    el.style.borderRadius = dy ? `${Math.min(36, 14 + k * 60)}px` : '';
  };
  const onStart = (e) => {
    if (e.target.closest('.scrub, button, .np-queue, input')) return;
    const tt = e.touches[0];
    g.current = { x: tt.clientX, y: tt.clientY, axis: null, onArt: !!e.target.closest('.np-art'), ly: tt.clientY, lt: performance.now(), v: 0, t0: performance.now() };
  };
  const onMove = (e) => {
    const s0 = g.current;
    if (!s0) return;
    const tt = e.touches[0];
    const dx = tt.clientX - s0.x, dy = tt.clientY - s0.y;
    const now = performance.now();
    s0.v = (tt.clientY - s0.ly) / Math.max(1, now - s0.lt); s0.ly = tt.clientY; s0.lt = now;
    if (!s0.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      s0.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
    }
    if (s0.axis === 'y' && dy > 0) setT(dy, false);
    if (s0.axis === 'x' && s0.onArt) {
      s0.dx = dx;
      const strip = sheet.current.querySelector('.np-strip, .np-video');
      if (strip) { strip.style.transition = 'none'; strip.style.transform = `translate3d(${dx}px, 0, 0)`; if (strip.classList.contains('np-strip')) setProg(strip, dx, false); }
    }
  };
  const onEnd = (e) => {
    const s0 = g.current;
    g.current = null;
    if (!s0) return;
    const tt = e.changedTouches?.[0];
    const dy = (tt ? tt.clientY : s0.ly) - s0.y;
    if (s0.axis === 'y') {
      setT(0, true);
      if (dy > 120 || (dy > 30 && s0.v > 0.5)) { tap(); onClose(); }
    }
    if (s0.axis === 'x') {
      const strip = sheet.current.querySelector('.np-strip, .np-video');
      const dx = s0.dx || 0;
      const vx = dx / Math.max(1, performance.now() - (s0.t0 || performance.now() - 300));
      const goNext = dx < 0 && p.queue[p.index + 1];
      const goPrev = dx > 0 && (p.queue[p.index - 1] || true);
      if (strip && s0.onArt && (Math.abs(dx) > 70 || Math.abs(vx) > 0.6) && (goNext || goPrev)) {
        tap();
        const step = (strip.parentElement?.clientWidth || window.innerWidth) * 0.51;
        strip.style.transition = 'transform .24s cubic-bezier(.25,.8,.3,1)';
        strip.style.transform = `translate3d(${dx < 0 ? -step : step}px, 0, 0)`;
        if (strip.classList.contains('np-strip')) setProg(strip, dx < 0 ? -step : step, true);
        let fired = false;
        const go = () => { if (fired) return; fired = true; strip.removeEventListener('transitionend', go); setSlide('none'); dx < 0 ? next() : prev(); };
        strip.addEventListener('transitionend', go);
        setTimeout(go, 320);
      } else if (strip) {
        strip.style.transition = 'transform .35s cubic-bezier(.2,1.3,.3,1)';
        strip.style.transform = '';
        if (strip.classList.contains('np-strip')) setProg(strip, 0, true);
      }
    }
  };

  // Swipe progress -> centre cover shrinks, incoming side cover grows into the centre
  const setProg = (strip, dx, animate) => {
    const step = (strip.parentElement?.clientWidth || window.innerWidth) * 0.51;
    const k = Math.min(1, Math.abs(dx) / step);
    strip.classList.toggle('dragging', !animate);
    strip.style.setProperty('--sp', k.toFixed(3));
    strip.style.setProperty('--pl', dx > 0 ? k.toFixed(3) : '0');
    strip.style.setProperty('--pr', dx < 0 ? k.toFixed(3) : '0');
    strip.dataset.dir = dx < 0 ? 'r' : dx > 0 ? 'l' : '';
  };

  // New track is centred now -> snap the strip back with no animation, before paint.
  useLayoutEffect(() => {
    const strip = sheet.current?.querySelector('.np-strip');
    if (strip) {
      strip.style.transition = 'none'; strip.style.transform = '';
      strip.classList.add('dragging');
      ['--sp', '--pl', '--pr'].forEach((v) => strip.style.setProperty(v, '0'));
      strip.dataset.dir = '';
      requestAnimationFrame(() => requestAnimationFrame(() => strip.classList.remove('dragging')));
    }
  }, [t?.id]);

  if (!t) return null;
  const liked = !!p.liked[t.id];
  return (
    <div
      ref={sheet}
      className={`np mode-${p.mode} ${open ? 'open' : ''} ${p.playing ? 'is-playing' : ''} ${beat ? 'beat-on' : ''}`}
      onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onTouchCancel={onEnd}
    >
      <BgBlur key={'bg' + t.id} src={t.thumb} />
      <div className="np-blobs"><i className="b1" /><i className="b2" /><i className="b3" /></div>
      <div className="np-grain" />
      <Scene id={t.id} />
      <div className="np-inner">
        <div className="np-grabber" />
        {beat && beatStatus && <div className="beat-note">BEAT: {beatStatus}</div>}
        <div className="np-top np-console" role="group" aria-label="Sterowanie odtwarzaczem">
          <button className="np-key" onClick={() => { tap(); if (!pickOutput()) alert('Zmień wyjście w Centrum sterowania (ikona AirPlay przy odtwarzaczu).'); }} aria-label="Wybierz urządzenie"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-2"/><path d="m12 14 5 6H7z"/></svg></button>
          <button className={'np-key'+(p.mode === 'audio' ? ' on' : '')} aria-pressed={p.mode === 'audio'} onClick={() => { tap(); setMode('audio'); }}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5"/><path d="M5.5 9.5a7 7 0 0 1 4-4M14.5 18.5a7 7 0 0 0 4-4"/></svg><span>Utwór</span></button>
          <button className={'np-key'+(p.mode === 'video' ? ' on' : '')} aria-pressed={p.mode === 'video'} onClick={() => { tap(); setMode('video'); }}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/></svg><span>Teledysk</span></button>
          <button className={'np-key'+(beat ? ' on' : '')} aria-label="Puls do beatu" aria-pressed={beat} onClick={() => { tap(); setBeat(!beat); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h3l3-7 4 14 3-10 2 3h3"/></svg><span>Beat</span></button>
          <button className={'np-key'+(showLyrics ? ' on' : '')} aria-pressed={showLyrics} onClick={() => { tap(); setShowQueue(false); setShowLyrics((x) => !x); }} aria-label="Tekst"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 10h16M4 15h10M4 20h7"/></svg></button>
          <button className={'np-key'+(showQueue ? ' on' : '')} aria-pressed={showQueue} onClick={() => { tap(); setShowLyrics(false); setShowQueue((x) => !x); }} aria-label="Kolejka"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 10h16M4 15h9M4 20h9m4-6 4 3-4 3z"/></svg></button>
        </div>

        {showLyrics && !showQueue ? (
          <LyricsPanel t={t} />
        ) : showQueue ? (
          <div className="np-queue">
            <h3>Kolejka</h3>
            {p.queue.map((q, i) => (
              <div key={q.id + i} style={{ '--i': Math.min(i, 20) }} className={`row stagger ${i === p.index ? 'active' : ''} ${i < p.index ? 'past' : ''}`} onClick={() => { tap(); jump(i); }}>
                <Cover src={q.thumb} className="row-cover" />
                <div className="row-text"><div className="row-title"><Marquee text={q.title} /></div><div className="row-sub"><Marquee text={q.subtitle} /></div></div>
              </div>
            ))}
          </div>
        ) : (
          <div className="np-art">
            {p.mode === 'video'
              ? (
                <div className="np-video" ref={videoBox} onDoubleClick={goFull}>
                  <button className="np-full pip" onClick={(e) => { e.stopPropagation(); tap(); togglePip(); }} aria-label="Obraz w obrazie">
                    <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="2" /><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" /></svg>
                  </button>
                  <button className="np-full" onClick={(e) => { e.stopPropagation(); goFull(); }} aria-label="Pełny ekran">
                    <svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                  </button>
                </div>
              )
              : (
                <div className="np-sway"><div className="np-strip">
                  {p.queue[p.index - 1] && (
                    <div className="np-side left" key={'l' + p.queue[p.index - 1].id} onClick={() => { tap(); prev(); }}>
                      <Cover src={p.queue[p.index - 1].thumb} />
                    </div>
                  )}
                  <Cover key={t.id} src={t.thumb} className={`np-cover ${p.playing ? 'big' : ''} ${slide === 'none' ? 'no-anim' : ''}`} />
                  {p.queue[p.index + 1] && (
                    <div className="np-side right" key={'r' + p.queue[p.index + 1].id} onClick={() => { tap(); next(); }}>
                      <Cover src={p.queue[p.index + 1].thumb} />
                    </div>
                  )}
                </div></div>
              )}
          </div>
        )}

        <div className="np-nav" key={'n' + t.id}>
          <button className="np-nav-item left" disabled={!p.queue[p.index - 1]} onClick={() => { tap(); prev(); }}>
            <span className="np-nav-label">‹ Poprzednio</span>
            <span className="np-nav-title"><Marquee text={p.queue[p.index - 1]?.title || '—'} /></span>
          </button>
          <button className="np-nav-item right" disabled={!p.queue[p.index + 1]} onClick={() => { tap(); next(); }}>
            <span className="np-nav-label">Następnie ›</span>
            <span className="np-nav-title"><Marquee text={p.queue[p.index + 1]?.title || 'Radio z tego utworu'} /></span>
          </button>
        </div>
        <div className="np-info">
          <div className="np-meta" key={'m' + t.id}>
            <div className="np-title"><Marquee text={t.title} /></div>
            <div
              className={`np-artist ${t.artistId ? 'link' : ''}`}
              onClick={() => { if (t.artistId) { onClose(); onOpen({ type: 'artist', id: t.artistId }); } }}
            ><Marquee text={t.subtitle} /></div>
          </div>
          <button className={`icon-btn more-btn ${(p.rate || 1) !== 1 || p.sleep ? 'dot' : ''}`} onClick={() => { tap(); window.dispatchEvent(new Event('mtb-tools')); }} aria-label="Więcej opcji">
            <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2" fill="currentColor" /><circle cx="12" cy="12" r="2" fill="currentColor" /><circle cx="19" cy="12" r="2" fill="currentColor" /></svg>
          </button>
          <button className="icon-btn" onClick={() => { tap(); openAddSheet(t); }} aria-label="Dodaj do playlisty">{Icon.addList}</button>
          <button className={`icon-btn like ${liked ? 'on' : ''}`} onClick={() => { tap(ImpactStyle.Medium); toggleLike(t); }}>{liked ? Icon.heart : Icon.heartO}</button>
        </div>
        {p.error && <div className="np-error">{p.error}</div>}
        {p.error && (
          <div className="dbg">
            <button onClick={() => { navigator.clipboard?.writeText(getLogs()).then(() => alert('Skopiowane — wklej Claude')).catch(() => {}); }}>Kopiuj logi</button>
            <button onClick={() => clearLogs()}>Wyczyść</button>
          </div>
        )}
        <Visualizer />
        <NpTools />
        <Scrubber />
        <div className="np-controls np-transport" role="group" aria-label="Sterowanie muzyką">
          <button className={'transport-key secondary'+(p.shuffle?' lit':'')} aria-label="Losowo" aria-pressed={p.shuffle} onClick={() => { tap(); toggleShuffle(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 4-3 5-6s3-6 7-6h3m-4-4 4 4-4 4"/></svg></button>
          <button className="transport-key skip" aria-label="Poprzedni utwór" onClick={() => { tap(); setSlide('from-left'); prev(); }}><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 6v20M25 6 11 16l14 10z"/></svg></button>
          <button className="transport-key transport-main" aria-label={p.playing?'Pauza':'Odtwórz'} onClick={() => { tap(ImpactStyle.Medium); toggle(); }}>{p.loading ? <span className="spin big" /> : <svg viewBox="0 0 32 32" aria-hidden="true">{p.playing?<><path d="M11 7v18M21 7v18"/></>:<path d="m11 6 15 10-15 10z"/>}</svg>}</button>
          <button className="transport-key skip" aria-label="Następny utwór" onClick={() => { tap(); setSlide('from-right'); next(); }}><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M25 6v20M7 6l14 10L7 26z"/></svg></button>
          <button className={'transport-key secondary'+(p.repeat!=='off'?' lit':'')} aria-label={p.repeat==='one'?'Powtarzaj utwór':p.repeat==='all'?'Powtarzaj kolejkę':'Powtarzanie wyłączone'} aria-pressed={p.repeat!=='off'} onClick={() => { tap(); cycleRepeat(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m17 2 4 4-4 4M21 6H7a4 4 0 0 0-4 4m4 12-4-4 4-4M3 18h14a4 4 0 0 0 4-4"/></svg>{p.repeat==='one'&&<b className="transport-one">1</b>}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- app shell ---------------- */

// Music video keeps playing in a small floating window when the big player is closed.
function VideoPop({ show, onOpen }) {
  const p = usePlayer();
  if (!show || p.mode !== 'video' || p.pip || !current()) return null;
  return (
    <div className="vpop" onClick={() => { tap(); onOpen(); }}>
      <div id="video-pop-box" className="vpop-box" />
      <div className="vpop-bar">
        <button onClick={(e) => { e.stopPropagation(); tap(); togglePip(); }} aria-label="Obraz w obrazie">
          <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="2" /><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" /></svg>
        </button>
        <button onClick={(e) => { e.stopPropagation(); tap(); setMode('audio'); }} aria-label="Tylko dźwięk">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
        </button>
      </div>
    </div>
  );
}

// Small version line at the bottom of the Library: shows what's running and what OTA is doing.
function VersionLine() {
  const [o, setO] = useState(otaState);
  useEffect(() => onOta(setO), []);
  const label = { idle: '', checking: 'sprawdzam…', latest: 'aktualna', downloading: `pobieram ${o.version}…`, ready: 'nowa wersja gotowa', error: `błąd: ${o.message || ''}` }[o.status] || o.status;
  return (
    <div className="version-wrap">
      <button className="version-line" onClick={() => (o.status === 'ready' ? applyNow() : recheck())}>
        Boss build {BUILD || 'dev'}{o.remote ? ` · serwer ${o.remote}` : ''}{label ? ` · ${label}` : ''}
      </button>
      <button className="version-line logs" onClick={profilerPanel}>Profiler wydajności</button>
      <button className="version-line logs" onClick={() => { navigator.clipboard?.writeText(getLogs()).then(() => alert('Logi skopiowane, wklej je Claude')).catch(() => alert('Nie udało się skopiować')); }}>Kopiuj logi</button>
    </div>
  );
}

// First launch: sign in with Google, or continue as a guest.
function Welcome() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    (async () => {
      const { value } = await Preferences.get({ key: 'welcome_seen' });
      if (value) return;
      if (await yt.isSignedIn().catch(() => false)) return;
      setShow(true);
    })();
  }, []);
  if (!show) return null;
  const close = () => { Preferences.set({ key: 'welcome_seen', value: '1' }); setShow(false); };
  const login = async () => {
    setErr(''); setBusy(true);
    try { await googleSignIn(); close(); } catch (e) { if (!/cancel/i.test(e?.message || '')) setErr(e?.message || String(e)); }
    setBusy(false);
  };
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <Wordmark size="xl" />
        <p className="welcome-lead">Twoja muzyka z YouTube, bez reklam, w tle i z ekranem blokady.</p>
        {canGoogleLogin() ? (
          <button className="primary google-btn" disabled={busy} onClick={login}>{busy ? 'Łączę…' : 'Zaloguj przez Google'}</button>
        ) : (
          <p className="hint">Zalogować się możesz w zakładce Biblioteka.</p>
        )}
        <p className="hint">Z kontem utwory grają w całości, a apka pokazuje Twoje playlisty i polubione. Sesja zostaje tylko w tym telefonie.</p>
        {err && <Err text={err} />}
        <button className="ghost" onClick={close}>Kontynuuj bez logowania</button>
        <p className="hint small">Bez logowania YouTube daje tylko ok. 70 sekund z każdego utworu.</p>
      </div>
    </div>
  );
}

// Guest hit YouTube's ~70 s limit
function LoginPrompt() {
  const p = usePlayer();
  const [busy, setBusy] = useState(false);
  if (!p.loginPrompt) return null;
  return (
    <div className="sheet-backdrop" onClick={dismissLoginPrompt}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="np-grabber" />
        <h3>Zaloguj się, żeby słuchać całości</h3>
        <p className="hint">Bez logowania YouTube daje tylko ok. 70 sekund z każdego utworu. Z kontem Google grają w całości.</p>
        <div className="sheet-actions">
          <button className="ghost" onClick={() => { dismissLoginPrompt(); next(); }}>Następny utwór</button>
          {canGoogleLogin()
            ? <button className="primary" disabled={busy} onClick={async () => { setBusy(true); try { await googleSignIn(); dismissLoginPrompt(); toggle(); } catch { /* cancelled */ } setBusy(false); }}>{busy ? 'Łączę…' : 'Zaloguj przez Google'}</button>
            : <button className="primary" onClick={dismissLoginPrompt}>OK</button>}
        </div>
      </div>
    </div>
  );
}

function OtaPill() {
  const [o, setO] = useState(otaState);
  useEffect(() => onOta(setO), []);
  if (o.status !== 'ready') return null;
  return (
    <button className="ota-pill" onClick={() => { tap(); applyNow(); }}>
      <b>Nowa wersja gotowa</b><span>Dotknij, żeby przeładować</span>
    </button>
  );
}

export default function App() {
  const [tab, setTab] = useState('home');
  const [fresh, setFresh] = useState({ home: 0, search: 0, library: 0 });
  const bump = (t) => setFresh((f) => ({ ...f, [t]: (f[t] || 0) + 1 }));
  const [stack, setStack] = useState([]);
  const [npOpen, setNpOpen] = useState(false);
  const homeNeedsRefresh = useRef(false);
  const homeLastListenRefresh = useRef(0);
  useEffect(() => { const mark = () => { homeNeedsRefresh.current = true; }; window.addEventListener('mtb-listened', mark); return () => window.removeEventListener('mtb-listened', mark); }, []);
  useEffect(() => {
    if(npOpen || tab !== 'home' || stack.length) return;
    const refresh = () => { if(document.hidden || !homeNeedsRefresh.current || Date.now()-homeLastListenRefresh.current<60000) return; homeNeedsRefresh.current=false; homeLastListenRefresh.current=Date.now(); bump('home'); };
    refresh();
    const timer=setInterval(refresh,15000);
    document.addEventListener('visibilitychange',refresh);
    return () => {clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  }, [npOpen,tab,stack.length]);
  const scroller = useRef();
  const sheetRef = useRef();

  // Drag up from the mini player: the full player follows the finger.
  const dragSheet = (dy) => {
    const el = sheetRef.current;
    if (!el) return;
    const h = window.innerHeight;
    const up = Math.min(h, -dy);
    const k = up / h; // 0 = closed, 1 = open
    el.style.transition = 'none';
    el.style.transform = `translate3d(0, ${h - up}px, 0) scale(${0.94 + 0.06 * k})`;
    el.style.borderRadius = `${36 - 36 * k}px`;
    el.style.opacity = '1';
    const mini = document.querySelector('.mini');
    if (mini) { mini.style.transition = 'none'; mini.style.opacity = String(1 - Math.min(1, k * 3)); }
  };
  const endDragSheet = (dy, v = 0) => {
    const el = sheetRef.current;
    const mini = document.querySelector('.mini');
    if (el) { el.style.transition = ''; el.style.transform = ''; el.style.borderRadius = ''; el.style.opacity = ''; }
    if (mini) { mini.style.transition = ''; mini.style.opacity = ''; }
    if (-dy > 90 || (-dy > 20 && v < -0.4) || Math.abs(dy) < 6) { tap(); setNpOpen(true); }
  };

  const open = useCallback((item) => {
    if (yt.isPlayable(item)) return playList([item], 0);
    setStack((s) => [...s, { kind: kindOf(item), id: item.id }]);
    scroller.current?.scrollTo(0, 0);
  }, []);
  const back = () => setStack((s) => s.slice(0, -1));
  const switchTab = (t) => {
    setTab(t); setStack([]); scroller.current?.scrollTo(0, 0);
    bump(t); // every tap on a tab re-fetches it, like a reload in YT Music
  };
  const tabRef = useRef(tab); tabRef.current = tab;
  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 20000 && !document.documentElement.classList.contains('np-open')) bump(tabRef.current);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const top = stack[stack.length - 1];
  const curThumb = usePlayer(s => s.queue[s.index]?.thumb);
  const nextThumb = usePlayer(s => s.queue[s.index + 1]?.thumb);
  useEffect(() => {
    if (!nextThumb || nextThumb === curThumb) return;
    const timer = setTimeout(() => { if (!document.hidden && energyLevel() < 2) coverColors(nextThumb); }, 1800);
    return () => clearTimeout(timer);
  }, [nextThumb, curThumb]);
  const cols = useCoverColors(curThumb);
  const vars = cols ? { '--c1': cols[0], '--c2': cols[1], '--c3': cols[2] } : {};

  return (
    <div className="app" style={vars}>
      <Splash />
      <div className="ambient" aria-hidden="true"><i className="a1" /><i className="a2" /><i className="a3" /></div>
      <div id="engine-holder" className="engine-holder" />
      <main ref={scroller} className="scroller" onScroll={(e) => {
        const y = e.currentTarget.scrollTop;
        e.currentTarget.style.setProperty('--sy', String(y));
        e.currentTarget.parentElement.classList.toggle('scrolled', y > 90);
      }}>
        <div className="topbar"><span className="tb-title">{top ? '' : ({ home: 'Główna', search: 'Szukaj', library: 'Biblioteka' })[tab]}</span></div>
        {top && <button className="back" onClick={back}>{Icon.back}</button>}
        <div style={{ display: top ? 'none' : 'block' }}>
          <div style={{ display: tab === 'home' ? 'block' : 'none' }}><HomeView onOpen={open} fresh={fresh.home} /></div>
          <div style={{ display: tab === 'search' ? 'block' : 'none' }}><SearchView onOpen={open} /></div>
          <div style={{ display: tab === 'library' ? 'block' : 'none' }}><LibraryView onOpen={open} fresh={fresh.library} /></div>
        </div>
        {top?.kind === 'artist' && <ArtistView key={top.id} id={top.id} onOpen={open} />}
        {(top?.kind === 'album' || top?.kind === 'playlist') && <CollectionView key={top.id} id={top.id} kind={top.kind} onOpen={open} />}
        {top?.kind === 'local' && <LocalCollection key={top.id} id={top.id} onOpen={open} onBack={back} />}
        {top?.kind === 'downloads' && <DownloadsView key="dl" onOpen={open} />}
        {top?.kind === 'wrapped' && <WrappedView key="wr" onOpen={open} />}
      </main>
      <MiniPlayer hidden={npOpen} onDrag={dragSheet} onDragEnd={endDragSheet} />
      <nav className="tabs">
        <button className={tab === 'home' ? 'on' : ''} onClick={() => switchTab('home')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10H3zM9 20v-6h6v6"/></svg><span>Główna</span></button>
        <button className={tab === 'search' ? 'on' : ''} onClick={() => switchTab('search')}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><span>Szukaj</span></button>
        <button className={tab === 'library' ? 'on' : ''} onClick={() => switchTab('library')}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="4" height="16" rx="1"/><path d="M12 4v16m4-15 4 14"/></svg><span>Biblioteka</span></button>
      </nav>
      <OtaPill />
      <CarMode />
      <Welcome />
      <LoginPrompt />
      <OfflineBar />
      <AddSheet />
      <VideoPop show={!npOpen} onOpen={() => setNpOpen(true)} />
      <NowPlaying sheetRef={sheetRef} open={npOpen} onClose={() => { pipIfVideo(); setNpOpen(false); }} onOpen={open} />
    </div>
  );
}
