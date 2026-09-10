/**
 * QR proxy core: the request handling shared by both entry points.
 *
 * Why a proxy exists at all: the provider requires a secret `ApiKey` header, and
 * anything in a `VITE_*` variable is inlined into the client bundle, so the browser
 * must never hold that key. This module attaches it server-side.
 *
 * Two processes use it, and neither owns a second copy of the logic:
 *   - server/serve.mjs   — the single-port app server: the built SPA and /api/qr on
 *                          one port, no separate service and no extra reverse-proxy
 *                          route;
 *   - server/qr-proxy.mjs — the proxy alone on its own port, for a split deployment.
 *
 * Paths handled by handle() (anything else is left to the caller, which gets `false`):
 *   POST /api/qr     JSON InputParameters body, forwarded verbatim; the upstream
 *                    status, content type and body are passed straight back, so a
 *                    provider failure stays visible to the app
 *   OPTIONS /api/qr  CORS preflight, for a genuine cross-origin caller
 *   GET /healthz     liveness; reports whether a key is configured (never the key)
 *
 * Configuration (process environment):
 *   QR_API_KEY          required  provider key, sent as the `ApiKey` header
 *   QR_API_URL          optional  provider base, default https://artqrcode.oxog.net
 *   QR_ALLOWED_ORIGINS  optional  comma list of browser origins allowed to call the
 *                                 proxy CROSS-origin, default http://localhost:5173;
 *                                 `*` allows any origin
 */

const MAX_BODY = 64 * 1024;

export const QR_PATH = '/api/qr';
export const HEALTH_PATH = '/healthz';

export function qrConfigFromEnv(env = process.env) {
  return {
    provider: (env.QR_API_URL || 'https://artqrcode.oxog.net').replace(/\/+$/, ''),
    key: (env.QR_API_KEY || '').trim(),
    allowedOrigins: (env.QR_ALLOWED_ORIGINS || 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** A host without its default port, lower-cased, for the same-origin comparison. */
function bareHost(host) {
  return String(host).trim().toLowerCase().replace(/:(?:80|443)$/, '');
}

/**
 * Browsers send `Origin` on every POST, even a same-origin one. That request is not
 * a CORS request at all, so it must not be judged by the allowlist: doing so forces
 * every deployment to enumerate its own hostnames, which breaks the moment a domain
 * is added, renamed, or served on a second name. Comparing the origin against the
 * host the request actually arrived on is the same rule the browser itself applies.
 */
function isSameOrigin(origin, host) {
  if (!host) return false;
  try {
    return bareHost(new URL(origin).host) === bareHost(host);
  } catch {
    return false;
  }
}

/**
 * null    — no CORS reply is needed (no Origin at all, or a same-origin request)
 * object  — the CORS response headers to send
 * false   — a browser page on another origin, which must be refused
 */
function corsFor(origin, host, allowed) {
  if (!origin) return null;
  if (isSameOrigin(origin, host)) return null;
  if (allowed.includes('*')) return { 'Access-Control-Allow-Origin': '*' };
  if (allowed.includes(origin)) return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
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

/** The host the client actually used, honouring a reverse proxy's X-Forwarded-Host. */
function requestHost(req) {
  const forwarded = req.headers['x-forwarded-host'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? req.headers.host ?? '');
  return String(raw).split(',')[0].trim();
}

export function createQrHandler(config = qrConfigFromEnv()) {
  const { provider, key, allowedOrigins } = config;

  async function handle(req, res) {
    const path = (req.url ?? '').split('?')[0];

    if (path === HEALTH_PATH && req.method === 'GET') {
      sendJson(res, 200, { ok: true, provider, keyConfigured: key.length > 0 });
      return true;
    }

    if (path !== QR_PATH) return false;

    const cors = corsFor(req.headers.origin, requestHost(req), allowedOrigins);
    if (cors === false) {
      sendJson(res, 403, { error: `origin ${req.headers.origin} is not allowed by QR_ALLOWED_ORIGINS` });
      return true;
    }
    const corsHeaders = cors ?? {};

    if (req.method === 'OPTIONS') {
      send(res, 204, {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Max-Age': '600',
      });
      return true;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'use POST' }, { ...corsHeaders, Allow: 'POST, OPTIONS' });
      return true;
    }

    if (!key) {
      sendJson(res, 500, { error: 'QR_API_KEY is not configured on the proxy' }, corsHeaders);
      return true;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { error: `invalid JSON body: ${err.message}` }, corsHeaders);
      return true;
    }
    if (typeof payload?.inputText !== 'string' || payload.inputText.length === 0) {
      sendJson(res, 400, { error: 'inputText is required' }, corsHeaders);
      return true;
    }

    try {
      const upstream = await fetch(`${provider}/QR/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ApiKey: key },
        body: JSON.stringify(payload),
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get('content-type');
      console.log(`[qr] POST ${QR_PATH} -> ${upstream.status} (${body.length} bytes)`);
      send(res, upstream.status, { ...(contentType ? { 'Content-Type': contentType } : {}), ...corsHeaders }, body);
    } catch (err) {
      console.log(`[qr] POST ${QR_PATH} -> 502 upstream error`);
      sendJson(res, 502, { error: 'upstream request failed', detail: String(err?.message ?? err) }, corsHeaders);
    }
    return true;
  }

  return { handle, provider, keyConfigured: key.length > 0, allowedOrigins };
}
