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
 * POST /api/qr is rate limited per client — the provider is metered and the
 * endpoint is public. By default the client is the socket address, which header
 * rotation cannot change; with QR_TRUST_PROXY=1 it is the LAST X-Forwarded-For
 * hop — the value the edge proxy appended, which a client cannot forge (direct
 * socket keying behind a proxy would collapse every visitor into one bucket).
 * Preflights, /healthz and CORS-rejected requests never consume budget. Beyond
 * the cap the answer is 429 JSON with a Retry-After header.
 *
 * Configuration (process environment):
 *   QR_API_KEY          required  provider key, sent as the `ApiKey` header
 *   QR_API_URL          optional  provider base, default https://artqrcode.oxog.net
 *   QR_ALLOWED_ORIGINS  optional  comma list of browser origins allowed to call the
 *                                 proxy CROSS-origin, default http://localhost:5173;
 *                                 `*` allows any origin
 *   QR_RATE_LIMIT_MAX         optional  POST /api/qr cap per client per window,
 *                                       default 30; invalid values fall back to the
 *                                       default — the limit has no off switch
 *   QR_RATE_LIMIT_WINDOW_MS   optional  window length, default 60000
 *   QR_TRUST_PROXY            optional  set to 1 behind a reverse proxy that appends
 *                                       X-Forwarded-For (Railway, Coolify, nginx…)
 *                                       to rate-limit per real client instead of per
 *                                       proxy socket address
 */

const MAX_BODY = 64 * 1024;

export const QR_PATH = '/api/qr';
export const HEALTH_PATH = '/healthz';

/** Rate-limit defaults: generous for a human, a seatbelt against a metered provider. */
const DEFAULT_RATE_LIMIT_MAX = 30;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function qrConfigFromEnv(env = process.env) {
  return {
    provider: (env.QR_API_URL || 'https://artqrcode.oxog.net').replace(/\/+$/, ''),
    key: (env.QR_API_KEY || '').trim(),
    allowedOrigins: (env.QR_ALLOWED_ORIGINS || 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    rateMax: positiveInt(env.QR_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
    rateWindowMs: positiveInt(env.QR_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
    trustProxy: env.QR_TRUST_PROXY === '1',
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
  const rateMax = config.rateMax ?? DEFAULT_RATE_LIMIT_MAX;
  const rateWindowMs = config.rateWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const trustProxy = config.trustProxy ?? false;

  // Fixed-window counters, one bucket per client. Keyed on the socket address by
  // default: rotating client-supplied headers cannot mint fresh budget. Behind a
  // reverse proxy (QR_TRUST_PROXY=1) the key is the LAST X-Forwarded-For hop —
  // the address the edge appended, which a client cannot forge — because without
  // it every visitor would share the proxy's single socket address. Both modes
  // bound the bucket map to roughly the number of real clients.
  const rateBuckets = new Map();

  function rateKeyFor(req) {
    if (trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      const hops = String(Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? ''))
        .split(',')
        .map((hop) => hop.trim())
        .filter(Boolean);
      if (hops.length > 0) return hops[hops.length - 1];
    }
    return req.socket?.remoteAddress || 'unknown';
  }

  function checkRateLimit(key, now) {
    // Opportunistic sweep so abandoned buckets cannot grow without bound.
    if (rateBuckets.size >= 10_000) {
      for (const [k, bucket] of rateBuckets) {
        if (now - bucket.start >= rateWindowMs) rateBuckets.delete(k);
      }
    }
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start >= rateWindowMs) {
      rateBuckets.set(key, { start: now, count: 1 });
      return { limited: false };
    }
    bucket.count += 1;
    if (bucket.count > rateMax) {
      return { limited: true, retryAfterSec: Math.max(1, Math.ceil((bucket.start + rateWindowMs - now) / 1000)) };
    }
    return { limited: false };
  }

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

    const rate = checkRateLimit(rateKeyFor(req), Date.now());
    if (rate.limited) {
      console.log(`[qr] POST ${QR_PATH} -> 429 rate limited`);
      sendJson(
        res,
        429,
        { error: `rate limit exceeded: max ${rateMax} requests per ${Math.round(rateWindowMs / 1000)}s` },
        { ...corsHeaders, 'Retry-After': String(rate.retryAfterSec) },
      );
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

  return { handle, provider, keyConfigured: key.length > 0, allowedOrigins, rateMax, rateWindowMs, trustProxy };
}
