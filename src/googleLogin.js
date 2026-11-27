// In-app Google sign-in (native plugin on iOS). Returns the YouTube cookie header,
// which then goes through the same path as a pasted cookie. Stays on the device.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { signInWithCookie } from './yt.js';

const GoogleLogin = registerPlugin('GoogleLogin');

// Show the button on every native build; if the native part is missing, the tap reports it.
export const canGoogleLogin = () => Capacitor.isNativePlatform();
export const googlePluginPresent = () => Capacitor.isPluginAvailable('GoogleLogin');

export async function googleSignIn() {
  let res;
  try { res = await GoogleLogin.signIn(); }
  catch (e) {
    const m = e?.message || String(e);
    if (/not implemented|unimplemented/i.test(m)) throw new Error('Ta wersja apki nie ma jeszcze logowania Google (wgraj nowy IPA). [' + m + ']');
    throw e;
  }
  const { cookie } = res || {};
  if (!cookie) throw new Error('Google nie zwrócił sesji, spróbuj jeszcze raz.');
  await signInWithCookie(cookie);
}
