#!/usr/bin/env node
/**
 * The QR proxy alone, on its own port — the split deployment, where a reverse proxy
 * routes /api/qr to this process (see server/README.md).
 *
 * If you would rather run one process on one port, use server/serve.mjs instead: it
 * serves the built SPA and this same /api/qr from a single port, and needs no extra
 * reverse-proxy route.
 *
 * The request handling itself lives in server/qr-handler.mjs, so both entry points
 * share one implementation rather than drifting apart.
 *
 *   npm run qr:proxy        # loads the root .env; listens on PORT (default 8787)
 *
 * Configuration: QR_API_KEY (required), QR_API_URL, PORT, QR_ALLOWED_ORIGINS — see
 * the module header of server/qr-handler.mjs.
 */
import { createServer } from 'node:http';
import { createQrHandler, qrConfigFromEnv } from './qr-handler.mjs';

const PORT = Number(process.env.PORT || 8787);
const qr = createQrHandler(qrConfigFromEnv());

const server = createServer((req, res) => {
  Promise.resolve(qr.handle(req, res))
    .then((handled) => {
      if (handled) return;
      const path = (req.url ?? '').split('?')[0];
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `unknown path ${path}; use POST /api/qr` }));
    })
    .catch((err) => {
      console.error(`[qr-proxy] handler failed: ${err?.message ?? err}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    });
});

server.listen(PORT, () => {
  console.log(`[qr-proxy] listening on http://localhost:${PORT}/api/qr`);
  console.log(`[qr-proxy] provider: ${qr.provider}`);
  console.log(`[qr-proxy] allowed origins (cross-origin callers): ${qr.allowedOrigins.join(', ')}`);
  if (!qr.keyConfigured) {
    console.warn('[qr-proxy] WARNING: QR_API_KEY is not set — POST requests will fail with 500');
  }
});
