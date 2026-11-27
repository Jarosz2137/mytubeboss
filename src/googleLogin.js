// In-app Google sign-in. The native side is just a private browser that obeys commands
// (open / load / cookies / cover / close); the whole flow lives here so fixes ship via OTA.
// Nothing leaves the phone: the cookies go straight into this app's own storage.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { signInWithCookie } from './yt.js';

const Browser = registerPlugin('MTBBrowser');
const LegacyLogin = registerPlugin('GoogleLogin');

export const canGoogleLogin = () => Capacitor.getPlatform() === 'ios'; // Android/desktop: coming with their ports
export const googlePluginPresent = () => Capacitor.isPluginAvailable('MTBBrowser') || Capacitor.isPluginAvailable('GoogleLogin');

const START = 'https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue=https%3A%2F%2Fmusic.youtube.com%2F';
// Google's passive sign-in for YouTube: copies the Google session to youtube.com (SetSID).
const HANDOFF = 'https://accounts.google.com/ServiceLogin?service=youtube&passive=true&uilel=3&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F';
const CONSENT = ['.youtube.com', '.google.com'].flatMap((domain) => [
  { domain, name: 'SOCS', value: 'CAI' },
  { domain, name: 'CONSENT', value: 'PENDING+987' },
]);

function flow() {
  return new Promise((resolve, reject) => {
    let done = false, handoffs = 0, busy = false;
    const subs = [];
    const finish = async (err, cookie) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      subs.forEach((s) => s?.remove?.());
      if (!err) await Browser.close().catch(() => {});
      err ? reject(err) : resolve(cookie);
    };
    const step = async () => {
      if (done || busy) return;
      busy = true;
      try {
        const { cookies = [], url = '' } = await Browser.getCookies({ domain: '' });
        let host = '', path = '';
        try { const u = new URL(url); host = u.host; path = u.pathname; } catch { /* about:blank */ }
        const yt = cookies.filter((c) => c.domain.endsWith('youtube.com'));
        const googleIn = cookies.some((c) => c.domain.endsWith('google.com') && (c.name === 'SAPISID' || c.name === 'SID'));
        if (yt.some((c) => c.name === 'SAPISID')) {
          // one value per name, preferring the shared ".youtube.com" domain
          const by = {};
          for (const c of yt) if (!by[c.name] || c.domain === '.youtube.com') by[c.name] = c;
          return finish(null, Object.values(by).map((c) => `${c.name}=${c.value}`).join('; '));
        }
        const signingIn = host === 'accounts.google.com' && /signin|ServiceLogin|challenge|identifier|pwd/i.test(path + url);
        const consent = /^consent\.(youtube|google)\.com$/.test(host);
        const parked = googleIn && !signingIn && (consent || host.endsWith('google.com') || host.endsWith('youtube.com'));
        if (parked && handoffs < 3) {
          handoffs++;
          console.info('[login] handoff', handoffs, 'from', host);
          await Browser.cover({ show: true, text: 'Łączę z YouTube…' });
          await Browser.setCookies({ cookies: CONSENT });
          await Browser.load({ url: HANDOFF });
        } else if (parked && handoffs >= 3) {
          await Browser.cover({ show: false });
          return finish(new Error('Google zalogował, ale YouTube nie przyjął sesji. Spróbuj jeszcze raz.'));
        }
      } catch (e) { console.warn('[login] step', e?.message); }
      finally { busy = false; }
    };
    const poll = setInterval(step, 1500);
    (async () => {
      subs.push(await Browser.addListener('nav', () => setTimeout(step, 300)));
      subs.push(await Browser.addListener('closed', () => finish(new Error('cancelled'))));
      await Browser.open({ url: START, title: 'Zaloguj przez Google' });
      await Browser.setCookies({ cookies: CONSENT }).catch(() => {});
    })().catch((e) => finish(e));
  });
}

export async function googleSignIn() {
  let cookie;
  if (Capacitor.isPluginAvailable('MTBBrowser')) {
    cookie = await flow();
  } else {
    // older app builds: the all-native flow
    try { cookie = (await LegacyLogin.signIn())?.cookie; }
    catch (e) {
      const m = e?.message || String(e);
      if (/not implemented|unimplemented/i.test(m)) throw new Error('Ta wersja apki nie ma jeszcze logowania Google (wgraj nowy IPA). [' + m + ']');
      throw e;
    }
  }
  if (!cookie) throw new Error('Google nie zwrócił sesji, spróbuj jeszcze raz.');
  await signInWithCookie(cookie);
}
