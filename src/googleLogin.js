// In-app Google sign-in (native plugin on iOS). Returns the YouTube cookie header,
// which then goes through the same path as a pasted cookie. Stays on the device.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { signInWithCookie } from './yt.js';

const GoogleLogin = registerPlugin('GoogleLogin');

export const canGoogleLogin = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('GoogleLogin');

export async function googleSignIn() {
  const { cookie } = await GoogleLogin.signIn();
  if (!cookie) throw new Error('Google nie zwrócił sesji, spróbuj jeszcze raz.');
  await signInWithCookie(cookie);
}
