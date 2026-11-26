// Keeps the last few hundred console lines so they can be copied from the app.
import { Logger, LogLevel } from 'googlevideo/utils';

const lines = [];
const MAX = 400;
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
    orig(...args);
  };
}
try { Logger.getInstance().setLogLevels(LogLevel.ERROR, LogLevel.WARN, LogLevel.INFO, LogLevel.DEBUG); } catch { /* */ }

export const getLogs = () => lines.join('\n');
export const clearLogs = () => { lines.length = 0; };
