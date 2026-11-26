import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-only proxy: in a desktop browser, YouTube blocks requests via CORS.
// The app sends them to /__proxy?u=<url>, and this middleware forwards them.
// In the native iOS app none of this is used (requests go out natively).
function youtubeDevProxy() {
  const SKIP = new Set(['host', 'origin', 'referer', 'connection', 'content-length', 'accept-encoding', 'cookie']);
  return {
    name: 'youtube-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/__proxy', async (req, res) => {
        try {
          const target = new URL(req.url, 'http://x').searchParams.get('u');
          if (!target || !/^https:\/\/([a-z0-9-]+\.)*(youtube\.com|google\.com|googleapis\.com|googlevideo\.com|ytimg\.com|googleusercontent\.com)\//.test(target)) {
            res.statusCode = 400;
            return res.end('bad target');
          }
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = chunks.length ? Buffer.concat(chunks) : undefined;
          const headers = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (!SKIP.has(k.toLowerCase())) headers[k] = v;
          }
          const fwdCookie = req.headers['x-yt-cookie'];
          if (fwdCookie) headers.cookie = fwdCookie;
          delete headers['x-yt-cookie'];
          const r = await fetch(target, {
            method: req.method,
            headers,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
            redirect: 'follow',
          });
          res.statusCode = r.status;
          r.headers.forEach((v, k) => {
            if (!['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie'].includes(k)) res.setHeader(k, v);
          });
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) {
          res.statusCode = 502;
          res.end(String(e));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), youtubeDevProxy()],
  build: { target: 'es2020' },
});
