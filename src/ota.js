// Over-the-air updates: GitHub Actions publishes bundle.zip + version.json as a GitHub Release
// in a PUBLIC repo; the app checks it on start, downloads in the background and swaps on next launch.
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { CapacitorUpdater } from '@capgo/capacitor-updater';

export const BUILD = Number(import.meta.env.VITE_BUILD || 0);
const REPO = import.meta.env.VITE_OTA_REPO || 'Jarosz2137/mytubeboss-ota';
const BASE = `https://github.com/${REPO}/releases/latest/download`;

let listeners = new Set();
export let otaState = { status: 'idle', version: null, id: null };
const emit = (s) => { otaState = { ...otaState, ...s }; listeners.forEach((f) => f(otaState)); };
export const onOta = (f) => { listeners.add(f); return () => listeners.delete(f); };

function parseInfo(d) {
  if (d && typeof d === 'object') return d;
  if (typeof d !== 'string') return null;
  const t = d.trim();
  try { return JSON.parse(t); } catch { /* not plain JSON */ }
  try { return JSON.parse(atob(t)); } catch { return null; }
}

export async function initOta() {
  if (!Capacitor.isNativePlatform()) return;
  // Tell the plugin this bundle booted fine; otherwise it rolls back to the previous one.
  try { await CapacitorUpdater.notifyAppReady(); } catch (e) { console.warn('[ota] notifyAppReady', e); }
  // A newer bundle downloaded last time? Apply it now, at launch (never mid-use).
  try {
    const { bundles = [] } = await CapacitorUpdater.list();
    const ready = bundles.filter((b) => b.status === 'success' && Number(b.version) > BUILD).sort((a, b) => Number(b.version) - Number(a.version))[0];
    if (ready) { console.log('[ota] applying downloaded', ready.version, 'at launch'); await CapacitorUpdater.set({ id: ready.id }); return; }
  } catch (e) { console.warn('[ota] list', e?.message); }
  try {
    emit({ status: 'checking' });
    // GitHub serves release assets as application/octet-stream, so the native layer may hand
    // the body back as an object, a JSON string, or base64 - accept all three.
    const r = await CapacitorHttp.get({ url: `${BASE}/version.json?t=${Date.now()}`, responseType: 'text' });
    const info = parseInfo(r.data);
    if (!info) throw new Error(`version.json nieczytelny (HTTP ${r.status})`);
    const remote = Number(info?.build || 0);
    console.log('[ota] local', BUILD, 'remote', remote);
    emit({ remote });
    if (!remote || remote <= BUILD) return emit({ status: 'latest' });
    emit({ status: 'downloading', version: String(remote) });
    if (!info.checksum) throw new Error('paczka bez sumy kontrolnej');
    const bundle = await CapacitorUpdater.download({ url: info.url || `${BASE}/bundle.zip`, version: String(remote), checksum: info.checksum });
    // No next(): that would swap the app the moment it goes to background (felt like random restarts).
    // It's applied when the pill is tapped, or at the next cold launch (see above).
    emit({ status: 'ready', id: bundle.id });
  } catch (e) {
    console.warn('[ota] check failed', e?.message || e);
    emit({ status: 'error', message: e?.message || String(e) });
  }
}

export const recheck = () => initOta();

export async function applyNow() {
  if (otaState.id) await CapacitorUpdater.set({ id: otaState.id });
}
