// Proof-of-Origin tokens via BotGuard (bgutils-js). The app's WebView is a real
// browser, so YouTube's own BotGuard VM runs here and attests the session.
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { buildURL, getHeaders } from 'bgutils-js/utils';

// YouTube's request key for the WAA integrity endpoint (from BgUtils examples).
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

function loadInterpreter(js, hash) {
  const id = 'bg-' + (hash || 'vm');
  if (document.getElementById(id)) return;
  const s = document.createElement('script');
  s.id = id;
  s.textContent = js;
  document.head.appendChild(s);
}

export async function createPoMinter(yt, fetchFn) {
  const ch = await yt.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND');
  const bg = ch.bg_challenge;
  if (!bg) throw new Error('brak bg_challenge');

  const url = bg.interpreter_url?.private_do_not_access_or_else_trusted_resource_url_wrapped_value;
  if (!url) throw new Error('brak interpretera BotGuard');
  const js = await (await fetchFn(url.startsWith('//') ? 'https:' + url : url)).text();
  loadInterpreter(js, bg.interpreter_hash);

  const client = await BotGuardClient.create({
    program: bg.program,
    globalName: bg.global_name,
    globalObject: window,
  });

  const webPoSignalOutput = [];
  const botguardResponse = await client.snapshot({ webPoSignalOutput });

  const r = await fetchFn(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  const resp = await r.json();
  if (typeof resp?.[0] !== 'string') throw new Error('brak integrity token');

  return WebPoMinter.create({ integrityToken: resp[0], estimatedTtlSecs: resp[1] }, webPoSignalOutput);
}
