// Opt-in diagnostics; synchronous timings are CPU-side, async timings are elapsed wall time.
let enabled = false;
const stats = new Map(), jobs = new Map(), isolated = new Set();
export function profStart() { return enabled ? performance.now() : null; }
export function profEnd(name, start, bytes = 0) {
  if (!enabled || start === null) return;
  const ms = performance.now()-start, s = stats.get(name) || {n:0,total:0,max:0,bytes:0};
  s.n++; s.total+=ms; s.max=Math.max(s.max,ms); s.bytes+=bytes; stats.set(name,s);
}
export function profJob(name) {
  if (!enabled) return () => {};
  const start=performance.now(), token={name,start}; jobs.set(token,token);
  return (bytes=0) => { jobs.delete(token); profEnd(name,start,bytes); };
}
export function profReport(anims) {
  if (!enabled) return;
  const start = performance.now();
  const groups = new Map();
  for (const a of anims || document.getAnimations?.() || []) {
    if (a.playState !== 'running') continue;
    const t=a.effect?.target, el=t?.element || t;
    const region=el?.closest?.('.np')?'player':el?.closest?.('.ambient')?'ambient':el?.closest?.('.scroller')?'scroller':'other';
    const name=(a.animationName || a.transitionProperty || 'other')+'@'+region+'/'+(el?.tagName || '?')+'.'+(el?.getAttribute?.('class') || '').slice(0,90);
    groups.set(name,(groups.get(name)||0)+1);
  }
  console.info('[prof] tasks '+JSON.stringify([...stats].map(([name,s])=>({name,calls:s.n,totalMs:Math.round(s.total*10)/10,maxMs:Math.round(s.max*10)/10,bytes:s.bytes}))));
  console.info('[prof] active '+JSON.stringify([...jobs.values()].map(j=>({name:j.name,elapsedMs:Math.round(performance.now()-j.start)}))));
  for(const [name,n] of groups) console.info('[prof] css '+n+' '+name);
  stats.clear();
  console.info('[prof] report overhead '+(performance.now()-start).toFixed(2)+' ms');
}
export function profilerPanel() {
  const panel=document.createElement('div'); panel.className='prof-panel';
  const heading=document.createElement('strong'); heading.textContent='Profiler (CPU / wall time)'; panel.append(heading);
  const toggle=document.createElement('button'); const update=()=>toggle.textContent=enabled?'Pomiar: WŁ':'Pomiar: WYŁ'; update();
  toggle.onclick=()=>{ if(enabled)profReport(); enabled=!enabled; stats.clear(); jobs.clear(); update(); }; panel.append(toggle);
  for(const [key,label] of [['blur','Rozmycie'],['scene','Scena'],['art','Okładka BEAT'],['ambient','Ambient'],['css','Animacje CSS']]){
    const b=document.createElement('button'); const sync=()=>b.textContent=label+': '+(isolated.has(key)?'WYŁ':'WŁ');sync();
    b.onclick=()=>{if(isolated.has(key))isolated.delete(key);else isolated.add(key);document.documentElement.classList.toggle('prof-off-'+key,isolated.has(key));sync();};panel.append(b);
  }
  const report=document.createElement('button');report.textContent='Zapisz pomiar do logów';report.onclick=profReport;panel.append(report);
  const close=document.createElement('button');close.textContent='Zamknij / przywróć efekty';close.onclick=()=>{for(const k of isolated)document.documentElement.classList.remove('prof-off-'+k);isolated.clear();panel.remove();};panel.append(close);
  document.querySelector('.prof-panel')?.remove();document.body.append(panel);
}
export const profIsolated = key => isolated.has(key);
