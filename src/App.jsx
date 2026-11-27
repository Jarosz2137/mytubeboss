import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import * as yt from './yt.js';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { useCoverColors } from './colors.js';
import { getLogs, clearLogs } from './debuglog.js';
import {
  usePlayer, current, playList, addNext, jump, toggle, next, prev, seek, setMode, videoElement,
  cycleRepeat, toggleShuffle, toggleLike, useTime, togglePip, pickOutput,
} from './player.js';
import { setBeat, beatOn, onBeat, setBeatTarget } from './beat.js';
import { onOta, otaState, applyNow, BUILD, recheck } from './ota.js';
import { canGoogleLogin, googleSignIn } from './googleLogin.js';

/* ---------------- helpers ---------------- */

const tap = (style = ImpactStyle.Light) => { Haptics.impact({ style }).catch(() => {}); };

// Long text scrolls like a car-radio display instead of being cut off.
function Marquee({ text }) {
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
    check();
    const ro = new ResizeObserver(check);
    ro.observe(box.current);
    return () => ro.disconnect();
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
}

function Wordmark({ size = 'md' }) {
  return (
    <div className={`wm wm-${size}`} aria-label="Egzey MyTube Boss">
      <span className="wm-egzey">EGZEY</span>
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

function TrackRow({ t, list, i, onOpen, showCover = true, index }) {
  const p = usePlayer();
  const cur = current();
  const active = cur && cur.id === t.id;
  return (
    <div className={`row stagger ${active ? 'active' : ''}`} style={{ '--i': Math.min(i, 14) }} onClick={() => { tap(); playList(list, i); }}>
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
      {active && p.playing ? <div className="eq"><span /><span /><span /></div> : <div className="row-dur">{t.duration ? fmt(t.duration) : ''}</div>}
      <button className="icon-btn small" onClick={(e) => { e.stopPropagation(); addNext(t); }} aria-label="Zagraj następne">{Icon.plus}</button>
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
      const mid = box.left + box.width / 2;
      for (const c of el.children) {
        const r = c.getBoundingClientRect();
        const d = Math.max(-1.6, Math.min(1.6, (r.left + r.width / 2 - mid) / box.width));
        const cov = c.firstChild;
        if (cov) {
          cov.style.transform = `perspective(600px) rotateY(${d * -14}deg) scale(${1 - Math.abs(d) * 0.1})`;
          cov.style.opacity = String(1 - Math.abs(d) * 0.3);
        }
      }
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(paint); };
    paint();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
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
                <div className="qp-row stagger" style={{ '--i': i }} key={t.id + i} onClick={() => { tap(); playList(tracks, i); }}>
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

function HomeView({ onOpen, fresh }) {
  const [chip, setChip] = useState(null);
  const s = useAsync(() => yt.home(chip), [chip, fresh]);
  const [chips, setChips] = useState([]);
  useEffect(() => { if (s.data?.chips?.length && !chips.length) setChips(s.data.chips); }, [s.data]);
  return (
    <div className="view">
      <div className="home-head">
        <Wordmark />
        <div className="greet">{greeting()}</div>
      </div>
      {chips.length > 0 && (
        <div className="chips">
          <button className={!chip ? 'on' : ''} onClick={() => { tap(); setChip(null); }}>Wszystko</button>
          {chips.map((c) => <button key={c} className={chip === c ? 'on' : ''} onClick={() => { tap(); setChip(chip === c ? null : c); }}>{c}</button>)}
        </div>
      )}
      {s.loading && (s.data ? <div className="refreshing" /> : <Loader />)}
      {s.error && <Err text={s.error} />}
      {s.data?.sections.map((sec, i) =>
        sec.kind === 'quick' ? <QuickPicks key={i} s={sec} />
          : sec.kind === 'again' ? <ListenAgain key={i} s={sec} onOpen={onOpen} />
            : <Section key={i} s={sec} onOpen={onOpen} />)}
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
        <VersionLine />
      </div>
    );
  }

  return (
    <div className="view">
      <h1 className="big">Biblioteka</h1>
      <div className="lib-quick">
        <div className="lib-tile liked" onClick={() => onOpen({ type: 'playlist', id: 'LM', title: 'Polubione' })}>♥<span>Polubione utwory</span></div>
      </div>
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

function Visualizer() {
  const bars = useRef([...Array(28)].map(() => ({ d: 0.45 + Math.random() * 0.7, o: -Math.random() }))).current;
  return (
    <div className="viz" aria-hidden="true">
      {bars.map((b, i) => <i key={i} style={{ animationDuration: b.d + 's', animationDelay: b.o + 's' }} />)}
    </div>
  );
}

// Apple-Music-style scrubber: grab anywhere, drag is relative (no jump on touch),
// bar thickens while dragging, tap jumps to the spot.
function Scrubber() {
  const { time, duration } = useTime();
  const [drag, setDrag] = useState(null);
  const bar = useRef();
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
      <div className="scrub-times"><span>{fmt(val)}</span><span>-{fmt(Math.max(0, (duration || 0) - val))}</span></div>
    </div>
  );
}

function NowPlaying({ open, onClose, onOpen, sheetRef }) {
  const p = usePlayer();
  const t = current();
  const videoBox = useRef();
  const sheet = sheetRef;
  const [showQueue, setShowQueue] = useState(false);
  const [slide, setSlide] = useState('');
  const g = useRef(null);
  const [beat, setBeatState] = useState(beatOn());
  const goFull = () => {
    tap();
    const v = videoElement;
    if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iOS native player, rotates to landscape
    else v.requestFullscreen?.();
  };
  useEffect(() => onBeat(setBeatState), []);
  useEffect(() => { setBeatTarget(sheet.current); }, [t?.id]);

  // Move the single <video> engine into view when in video mode.
  useEffect(() => {
    const holder = document.getElementById('engine-holder');
    const pop = document.getElementById('video-pop-box');
    if (open && p.mode === 'video' && videoBox.current) videoBox.current.appendChild(videoElement);
    else if (!open && p.mode === 'video' && pop) pop.appendChild(videoElement); // floating window
    else if (holder && videoElement.parentElement !== holder) holder.appendChild(videoElement);
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
      if (strip) { strip.style.transition = 'none'; strip.style.transform = `translate3d(${dx}px, 0, 0)`; }
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
        let fired = false;
        const go = () => { if (fired) return; fired = true; strip.removeEventListener('transitionend', go); setSlide('none'); dx < 0 ? next() : prev(); };
        strip.addEventListener('transitionend', go);
        setTimeout(go, 320);
      } else if (strip) {
        strip.style.transition = 'transform .35s cubic-bezier(.2,1.3,.3,1)';
        strip.style.transform = '';
      }
    }
  };

  // New track is centred now -> snap the strip back with no animation, before paint.
  useLayoutEffect(() => {
    const strip = sheet.current?.querySelector('.np-strip');
    if (strip) { strip.style.transition = 'none'; strip.style.transform = ''; }
  }, [t?.id]);

  if (!t) return null;
  const liked = !!p.liked[t.id];
  return (
    <div
      ref={sheet}
      className={`np mode-${p.mode} ${open ? 'open' : ''} ${p.playing ? 'is-playing' : ''} ${beat ? 'beat-on' : ''}`}
      onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onTouchCancel={onEnd}
    >
      <div className="np-bg" key={'bg' + t.id} style={{ backgroundImage: t.thumb ? `url(${t.thumb})` : undefined }} />
      <div className="np-blobs"><i className="b1" /><i className="b2" /><i className="b3" /></div>
      <div className="np-grain" />
      <div className="np-scene" aria-hidden="true">
        <div className="np-sun" />
        <div className="np-grid" />
      </div>
      <div className="np-inner">
        <div className="np-grabber" />
        <div className="np-brand">
          <Wordmark size="xs" />
          <span className="boss-badge">👑 BOSS MODE · 0 reklam</span>
          <button className={`beat-btn ${beat ? 'on' : ''}`} onClick={() => { tap(); setBeat(!beat); }} aria-label="Puls do beatu">BEAT</button>
        </div>
        <div className="np-top">
          <button className="icon-btn" onClick={onClose}>{Icon.down}</button>
          <div className={`seg ${p.mode}`}>
            <span className="seg-pill" />
            <button className={p.mode === 'audio' ? 'on' : ''} onClick={() => { tap(); setMode('audio'); }}>Utwór</button>
            <button className={p.mode === 'video' ? 'on' : ''} onClick={() => { tap(); setMode('video'); }}>Teledysk</button>
          </div>
          <div className="np-top-r">
            <button className="icon-btn" onClick={() => { tap(); if (!pickOutput()) alert('Zmień wyjście w Centrum sterowania (ikona AirPlay przy odtwarzaczu).'); }} aria-label="Wybierz urządzenie">
              <svg viewBox="0 0 24 24"><path d="M6 17H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M12 14l5 6H7z" fill="currentColor" /></svg>
            </button
            >{' '}<button className={`icon-btn ${showQueue ? 'lit' : ''}`} onClick={() => { tap(); setShowQueue((x) => !x); }}>{Icon.queue}</button>
          </div>
        </div>

        {showQueue ? (
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
        <Scrubber />
        <div className="np-controls">
          <button className={`icon-btn small-ctl ${p.shuffle ? 'lit' : ''}`} onClick={() => { tap(); toggleShuffle(); }}>{Icon.shuffle}</button>
          <button className="icon-btn large" onClick={() => { tap(); setSlide('from-left'); prev(); }}>{Icon.prev}</button>
          <button className="icon-btn huge pop" key={p.playing ? 'pa' : 'pl'} onClick={() => { tap(ImpactStyle.Medium); toggle(); }}>{p.loading ? <span className="spin big" /> : p.playing ? Icon.pause : Icon.play}</button>
          <button className="icon-btn large" onClick={() => { tap(); setSlide('from-right'); next(); }}>{Icon.next}</button>
          <button className={`icon-btn small-ctl ${p.repeat !== 'off' ? 'lit' : ''}`} onClick={() => { tap(); cycleRepeat(); }}>
            {Icon.repeat}{p.repeat === 'one' && <b className="rep1">1</b>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- app shell ---------------- */

// Music video keeps playing in a small floating window when the big player is closed.
function VideoPop({ show, onOpen }) {
  const p = usePlayer();
  if (!show || p.mode !== 'video' || !current()) return null;
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
    <button className="version-line" onClick={() => (o.status === 'ready' ? applyNow() : recheck())}>
      Boss build {BUILD || 'dev'}{o.remote ? ` · serwer ${o.remote}` : ''}{label ? ` · ${label}` : ''}
    </button>
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
      else if (hiddenAt && Date.now() - hiddenAt > 20000) bump(tabRef.current);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const top = stack[stack.length - 1];
  const pl = usePlayer();
  const curThumb = pl.queue[pl.index]?.thumb;
  const cols = useCoverColors(curThumb);
  const vars = cols ? { '--c1': cols[0], '--c2': cols[1], '--c3': cols[2] } : {};

  return (
    <div className="app" style={vars}>
      <Splash />
      <div id="engine-holder" className="engine-holder" />
      <main ref={scroller} className="scroller" onScroll={(e) => {
        const y = e.currentTarget.scrollTop;
        e.currentTarget.style.setProperty('--sy', String(y));
        e.currentTarget.parentElement.classList.toggle('scrolled', y > 40);
      }}>
        <div className="topbar" />
        {top && <button className="back" onClick={back}>{Icon.back}</button>}
        <div style={{ display: top ? 'none' : 'block' }}>
          <div style={{ display: tab === 'home' ? 'block' : 'none' }}><HomeView onOpen={open} fresh={fresh.home} /></div>
          <div style={{ display: tab === 'search' ? 'block' : 'none' }}><SearchView onOpen={open} /></div>
          <div style={{ display: tab === 'library' ? 'block' : 'none' }}><LibraryView onOpen={open} fresh={fresh.library} /></div>
        </div>
        {top?.kind === 'artist' && <ArtistView key={top.id} id={top.id} onOpen={open} />}
        {(top?.kind === 'album' || top?.kind === 'playlist') && <CollectionView key={top.id} id={top.id} kind={top.kind} onOpen={open} />}
      </main>
      <MiniPlayer hidden={npOpen} onDrag={dragSheet} onDragEnd={endDragSheet} />
      <nav className="tabs">
        <button className={tab === 'home' ? 'on' : ''} onClick={() => switchTab('home')}>{Icon.home}<span>Główna</span></button>
        <button className={tab === 'search' ? 'on' : ''} onClick={() => switchTab('search')}>{Icon.search}<span>Szukaj</span></button>
        <button className={tab === 'library' ? 'on' : ''} onClick={() => switchTab('library')}>{Icon.lib}<span>Biblioteka</span></button>
      </nav>
      <OtaPill />
      <VideoPop show={!npOpen} onOpen={() => setNpOpen(true)} />
      <NowPlaying sheetRef={sheetRef} open={npOpen} onClose={() => setNpOpen(false)} onOpen={open} />
    </div>
  );
}
