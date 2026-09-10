#!/usr/bin/env node
/**
 * Server-side proxy for the Art QR API.
 *
 * Why this exists: the provider requires a secret `ApiKey` header on
 * `POST /QR/create`, but anything in a `VITE_*` variable is inlined into the
 * client bundle and readable by every visitor. This process holds the key and
 * forwards the request, so the browser never sees it.
 *
 * Endpoints (the app only uses the first):
 *   POST /api/qr     JSON InputParameters body -> forwarded verbatim; the
 *                    upstream status, content type and body are passed straight
 *                    back, so a provider failure stays visible to the app
 *   OPTIONS /api/qr  CORS preflight for browser callers
 *   GET /healthz     liveness, reports whether a key is configured (never it)
 *
 * Configuration (process env — see README):
 *   QR_API_KEY          required  provider key, sent as the `ApiKey` header
 *   QR_API_URL          optional  provider base, default https://artqrcode.oxog.net
 *   PORT                optional  listen port, default 8787
 *   QR_ALLOWED_ORIGINS  optional  comma list of browser origins, default
 *                                 http://localhost:5173 (the Vite dev server);
 *                                 use * to allow any origin
 *
 * Run with `npm run qr:proxy` (loads the root .env when present).
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const PROVIDER = (process.env.QR_API_URL || 'https://artqrcode.oxog.net').replace(/\/+$/, '');
const KEY = (process.env.QR_API_KEY || '').trim();
const ALLOWED = (process.env.QR_ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PATH = '/api/qr';
const MAX_BODY = 64 * 1024;

/**
 * CORS headers for a browser caller.
 * Returns null for a request with no Origin (curl, server-to-server), false when
 * the origin is explicitly not allowed, or the header object to use.
 */
function corsFor(origin) {
  if (!origin) return null;
  if (ALLOWED.includes('*')) return { 'Access-Control-Allow-Origin': '*' };
  if (ALLOWED.includes(origin)) return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  return false;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  send(res, status, { 'Content-Type': 'application/json', ...extraHeaders }, JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error(`request body exceeds ${MAX_BODY} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0];
  const origin = req.headers.origin;
  const cors = corsFor(origin);

  if (path === '/healthz' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, provider: PROVIDER, keyConfigured: KEY.length > 0 });
    return;
  }

  if (path !== PATH) {
    sendJson(res, 404, { error: `unknown path ${path}; use POST ${PATH}` });
    return;
  }

  if (cors === false) {
    sendJson(res, 403, { error: `origin ${origin} is not allowed by QR_ALLOWED_ORIGINS` });
    return;
  }
  const corsHeaders = cors ?? {};

  if (req.method === 'OPTIONS') {
    send(res, 204, {
      ...corsHeaders,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '600',
    });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'use POST' }, { ...corsHeaders, Allow: 'POST, OPTIONS' });
    return;
  }

  if (!KEY) {
    sendJson(res, 500, { error: 'QR_API_KEY is not configured on the proxy' }, corsHeaders);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { error: `invalid JSON body: ${err.message}` }, corsHeaders);
    return;
  }
  if (typeof payload?.inputText !== 'string' || payload.inputText.length === 0) {
    sendJson(res, 400, { error: 'inputText is required' }, corsHeaders);
    return;
  }

  try {
    const upstream = await fetch(`${PROVIDER}/QR/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ApiKey: KEY },
      body: JSON.stringify(payload),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type');
    console.log(`[qr-proxy] POST ${PATH} -> ${upstream.status} (${body.length} bytes)`);
    send(res, upstream.status, { ...(contentType ? { 'Content-Type': contentType } : {}), ...corsHeaders }, body);
  } catch (err) {
    console.log(`[qr-proxy] POST ${PATH} -> 502 upstream error`);
    sendJson(res, 502, { error: 'upstream request failed', detail: String(err?.message ?? err) }, corsHeaders);
  }
});

server.listen(PORT, () => {
  console.log(`[qr-proxy] listening on http://localhost:${PORT}${PATH}`);
  console.log(`[qr-proxy] provider: ${PROVIDER}`);
  console.log(`[qr-proxy] allowed origins: ${ALLOWED.join(', ')}`);
  if (!KEY) console.warn('[qr-proxy] WARNING: QR_API_KEY is not set — POST requests will fail with 500');
});
