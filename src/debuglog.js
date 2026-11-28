// Keeps the last few hundred console lines so they can be copied from the app.
import { Logger, LogLevel } from 'googlevideo/utils';

const lines = [];
const MAX = 400;
const KEY = 'mtb.blackbox.v1', PREV = KEY+'.previous';
const session = Date.now().toString(36);
let previous = '', dirty = false, timer = null;
try {
  const old = localStorage.getItem(KEY);
  if (old) localStorage.setItem(PREV,old);
  previous = localStorage.getItem(PREV) || '';
} catch {}
const trail = [];
const redact = s => s.replace(/https?:\/\/[^\s"<>]+/g,'[url]').slice(0,700);
function flush() {
  if(timer !== null) { clearTimeout(timer); timer=null; }
  if(!dirty) return;
  try { localStorage.setItem(KEY, JSON.stringify({session,at:new Date().toISOString(),hidden:document.hidden,lines:trail})); dirty=false; } catch {}
}
function record(line, urgent=false) {
  trail.push(redact(line)); if(trail.length>100) trail.shift();
  dirty=true;
  if(urgent) flush();
  else if(timer===null) timer=setTimeout(flush,1500);
}
record('[blackbox] boot '+session,true);
window.addEventListener('error',e=>record('[uncaught] '+(e.message||'resource error')+' '+(e.error?.stack||''),true));
window.addEventListener('unhandledrejection',e=>record('[rejection] '+String(e.reason?.stack||e.reason),true));
document.addEventListener('visibilitychange',()=>record('[visibility] hidden='+document.hidden,true));
window.addEventListener('pagehide',e=>record('[pagehide] persisted='+e.persisted,true));
window.addEventListener('pageshow',e=>record('[pageshow] persisted='+e.persisted,true));
const fmt = (a) => {
  if (a instanceof Error) return a.message;
  if (typeof a === 'object') { try { return JSON.stringify(a).slice(0, 300); } catch { return String(a); } }
  return String(a);
};
for (const lvl of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...args) => {
    const t = new Date().toISOString().slice(11, 19);
    lines.push(`${t} ${lvl[0].toUpperCase()} ${args.map(fmt).join(' ')}`);
    if (lines.length > MAX) lines.shift();
    if (lvl === 'error' || lvl === 'warn' || (lvl !== 'debug' && !String(args[0]).startsWith('[DEBUG]') && !String(args[0]).startsWith('[prof] css'))) record(lines[lines.length-1],lvl==='error');
    orig(...args);
  };
}
try { Logger.getInstance().setLogLevels(LogLevel.ERROR, LogLevel.WARN, LogLevel.INFO, LogLevel.DEBUG); } catch { /* */ }

export const getLogs = () => {
  flush();
  let old = '';
  try { const p=JSON.parse(previous); old='[blackbox previous] '+p.session+' last='+p.at+' hidden='+p.hidden+'\n'+p.lines.join('\n')+'\n'; } catch {}
  return old+'[blackbox current] '+session+'\n'+lines.join('\n');
};
export const clearLogs = () => { lines.length=0; trail.length=0; previous=''; dirty=false; if(timer!==null){clearTimeout(timer);timer=null;} try {localStorage.removeItem(KEY);localStorage.removeItem(PREV);} catch {} };
