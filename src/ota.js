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

export async function initOta() {
  if (!Capacitor.isNativePlatform()) return;
  // Tell the plugin this bundle booted fine; otherwise it rolls back to the previous one.
  try { await CapacitorUpdater.notifyAppReady(); } catch (e) { console.warn('[ota] notifyAppReady', e); }
  try {
    emit({ status: 'checking' });
    const r = await CapacitorHttp.get({ url: `${BASE}/version.json?t=${Date.now()}`, responseType: 'json' });
    const info = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const remote = Number(info?.build || 0);
    console.log('[ota] local', BUILD, 'remote', remote);
    if (!remote || remote <= BUILD) return emit({ status: 'latest' });
    emit({ status: 'downloading', version: String(remote) });
    const bundle = await CapacitorUpdater.download({ url: info.url || `${BASE}/bundle.zip`, version: String(remote) });
    await CapacitorUpdater.next({ id: bundle.id }); // applied on next launch / background
    emit({ status: 'ready', id: bundle.id });
  } catch (e) {
    console.warn('[ota] check failed', e?.message || e);
    emit({ status: 'error' });
  }
}

export async function applyNow() {
  if (otaState.id) await CapacitorUpdater.set({ id: otaState.id });
}
