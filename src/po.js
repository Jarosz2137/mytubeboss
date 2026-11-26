// Proof-of-Origin tokens via BotGuard (bgutils-js). The app's WebView is a real
// browser, so YouTube's own BotGuard VM runs here and attests the session.
import { BotGuardClient, getChallenge } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { buildURL, getHeaders } from 'bgutils-js/utils';

// YouTube's request key for the WAA endpoints (from BgUtils examples).
// Challenge and integrity token must come from the same key.
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

function loadInterpreter(js, hash) {
  const id = 'bg-' + (hash || 'vm');
  if (document.getElementById(id)) return;
  const s = document.createElement('script');
  s.id = id;
  s.textContent = js;
  document.head.appendChild(s);
}

async function attempt(fetchFn, useYouTubeAPI) {
  const ch = await getChallenge({ requestKey: REQUEST_KEY, fetchFunction: fetchFn, useYouTubeAPI });

  let js = ch.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!js) {
    const url = ch.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
    if (!url) throw new Error('brak interpretera');
    js = await (await fetchFn(url.startsWith('//') ? 'https:' + url : url)).text();
  }
  loadInterpreter(js, ch.interpreterHash);

  const client = await BotGuardClient.create({
    program: ch.program,
    globalName: ch.globalName,
    globalObject: window,
  });

  const webPoSignalOutput = [];
  const botguardResponse = await client.snapshot({ webPoSignalOutput });

  const r = await fetchFn(buildURL('GenerateIT', useYouTubeAPI), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  const text = await r.text();
  let resp;
  try { resp = JSON.parse(text); } catch { resp = null; }
  if (typeof resp?.[0] !== 'string') {
    throw new Error('GenerateIT ' + r.status + ': ' + text.slice(0, 80));
  }
  return WebPoMinter.create({ integrityToken: resp[0], estimatedTtlSecs: resp[1] }, webPoSignalOutput);
}

export async function createPoMinter(_yt, fetchFn) {
  const errs = [];
  for (const yt of [false, true]) {
    try {
      return await attempt(fetchFn, yt);
    } catch (e) {
      errs.push((yt ? 'yt' : 'waa') + ': ' + (e?.message || e));
    }
  }
  throw new Error(errs.join(' / '));
}
