import { Capacitor, registerPlugin } from '@capacitor/core';
const native = registerPlugin('MTBEnergy');
let state = null, started = false, pending = false, timer = 0;
let level = 0, recovery = 0, recoveryTarget = -1;
const rank = { nominal:0, fair:1, serious:2, critical:3 };
export const energyLevel = () => level;
function apply(data) {
  state = {...state,...data};
  const next = Math.max(rank[state.thermal] ?? 0, state.lowPower ? 1 : 0);
  if (next !== recoveryTarget || next >= level) { clearTimeout(recovery); recovery = 0; recoveryTarget = next; }
  const commit = () => {
    if (level === next) return;
    level = next;
    document.documentElement.dataset.energy = String(level);
    window.dispatchEvent(new Event('mtb-energy'));
    console.info('[energy] policy', level);
  };
  if (next >= level) commit(); else if (!recovery) recovery = setTimeout(() => { recovery = 0; commit(); }, 60000);
  console.info('[energy]', JSON.stringify({...state, policy:level}));
}
async function sample() {
  if (pending || document.hidden) return;
  pending = true;
  try { apply(await native.snapshot()); } catch(e) { console.warn('[energy] snapshot unavailable', e?.message); }
  finally { pending = false; }
}
export function initEnergy() {
  if (started || Capacitor.getPlatform() !== 'ios') return;
  started = true;
  if (!Capacitor.isPluginAvailable('MTBEnergy')) { console.info('[energy] native IPA required'); return; }
  native.addListener('change', data => apply(data)).catch(e => console.warn('[energy] listener', e?.message));
  const schedule = () => { clearInterval(timer); if (!document.hidden) { void sample(); timer = setInterval(sample, 30000); } };
  document.addEventListener('visibilitychange', schedule);
  schedule();
}
