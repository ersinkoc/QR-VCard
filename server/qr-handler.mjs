/**
 * QR endpoint, served by the app server itself — the same origin as everything else.
 *
 *   GET /api/qr/:code             PNG encoding `${origin}/c/${code}`
 *   GET /api/qr/:code?download=1  the same, as an attachment
 *   GET /healthz                  liveness; reports whether a key is configured
 *
 * The browser only names a short CODE. The server builds the link and the complete
 * provider body itself, so the metered provider cannot be used as a general
 * "encode anything" service, and the provider's ApiKey never leaves the server.
 *
 * `origin` is PUBLIC_URL when set (recommended in production), otherwise the host
 * and scheme the request arrived with (X-Forwarded-Host / -Proto aware). Images are
 * cached in memory keyed by the full encoded text, so a request with a forged Host
 * can only ever produce — and cache — an image for that forged text, never poison
 * the image other visitors get. Browsers cache the PNG for a day as well.
 *
 * Only cache misses reach the provider, and only those count against the per-client
 * rate limit (QR_RATE_LIMIT_MAX per QR_RATE_LIMIT_WINDOW_MS, 429 + Retry-After beyond).
 *
 * Two facts about the provider, established against the live API, are load-bearing:
 *   1. The body must be COMPLETE: a missing nested parameter (even `{inputText}` on
 *      its own) makes it answer a bare 500 with no body. `qrBody()` mirrors a payload
 *      verified to return 200; `npm run qr:verify` re-checks it.
 *   2. Success is RAW PNG bytes (`image/png`), not JSON, despite its Swagger.
 */
import { clientKey, createRateLimiter } from './rate-limit.mjs';

export const QR_PREFIX = '/api/qr/';
export const HEALTH_PATH = '/healthz';

const CODE_RE = /^[A-Za-z0-9-]{1,32}$/;
const HOST_RE = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9a-fA-F:]+\](?::\d{1,5})?$/;
const CACHE_MAX = 150; // ~100–150 KB per image
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX = 30;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

const COLOR_PARAMETERS = {
  premiumFiveFirst: '000000',
  premiumFiveSecond: 'ff0000',
  premiumFourFirst: '000000',
  premiumFourSecond: 'ff0000',
  premiumThreeFirst: '000000',
  premiumThreeSecond: 'ff0000',
  premiumTwoFirst: '000000',
  premiumTwoSecond: 'ff0000',
  premiumTwoTwoFirst: '000000',
  premiumTwoTwoSecond: 'ff0000',
  premiumCrossFirst: '000000',
  premiumCrossSecond: 'ff0000',
  premiumCrossThird: '555555',
  premiumCrossFourth: '888888',
  first: '000000',
  second: 'ff0000',
  third: '555555',
  fourth: '888888',
  background: 'ffffff',
  useRandomColors: false,
};

const EYE_PARAMETERS = {
  eyeFrameType: 'Square',
  eyeBallType: 'Circle',
  eyeFrameColorMarker: 'ff0000',
  eyeFrameColorTopRight: 'ff0000',
  eyeFrameColorLeftBottom: 'ff0000',
  eyeBallColorMarker: '000000',
  eyeBallColorTopRight: '000000',
  eyeBallColorLeftBottom: '000000',
  randomEyeFrame: false,
};

const GRADIENT_PARAMETERS = {
  linearGradient: false,
  radialGradient: false,
  eyeGradient: false,
  gradientColorFirstHex: 'ff0000',
  gradientColorSecondHex: '000000',
};

const LOGO_PARAMETERS = {
  logoName: 'empty',
  logoVariation: 'Normal',
  logoBackgroundColorHexFormat: '',
  logoRemoveBackground: true,
  logoFile: '',
};

const PREMIUM_PARAMETERS = { five: true, four: true, three: true, two: true, twoTwo: true, cross: true, horizontal: true, vertical: true };

/** The complete InputParameters body the provider requires. */
export function qrBody(inputText) {
  return {
    colorParameters: COLOR_PARAMETERS,
    eyeParameters: EYE_PARAMETERS,
    gradientParameters: GRADIENT_PARAMETERS,
    logoParameters: LOGO_PARAMETERS,
    premiumParameters: PREMIUM_PARAMETERS,
    inputText,
    exportWidth: 1000,
    exportPNG: true,
    eccLevel: 'H',
    shapeName: 'One',
  };
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function qrConfigFromEnv(env = process.env) {
  return {
    provider: (env.QR_API_URL || 'https://artqrcode.oxog.net').replace(/\/+$/, ''),
    key: (env.QR_API_KEY || '').trim(),
    publicUrl: (env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    rateMax: positiveInt(env.QR_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
    rateWindowMs: positiveInt(env.QR_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
    trustProxy: (env.TRUST_PROXY || env.QR_TRUST_PROXY) === '1',
  };
}

const firstValue = (h) => String(Array.isArray(h) ? h[0] : (h ?? '')).split(',')[0].trim();

/** The origin the visitor used, or null when the Host header is not a plausible host. */
export function requestOrigin(req) {
  const host = firstValue(req.headers['x-forwarded-host']) || firstValue(req.headers.host);
  if (!HOST_RE.test(host)) return null;
  const proto = req.socket?.encrypted ? 'https' : firstValue(req.headers['x-forwarded-proto']) === 'https' ? 'https' : 'http';
  return `${proto}://${host.toLowerCase()}`;
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
}

export function createQrHandler(config = qrConfigFromEnv(), { fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now(), log = console } = {}) {
  const { provider, key } = config;
  const publicUrl = config.publicUrl ?? '';
  const rateMax = config.rateMax ?? DEFAULT_RATE_LIMIT_MAX;
  const rateWindowMs = config.rateWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const trustProxy = config.trustProxy ?? false;
  const limiter = createRateLimiter({ max: rateMax, windowMs: rateWindowMs });

  /** text -> { png, at }; Map order doubles as LRU order. */
  const cache = new Map();
  /** text -> Promise<Buffer>: one provider call per text, however many ask at once. */
  const inFlight = new Map();

  function cached(text) {
    const hit = cache.get(text);
    if (!hit) return null;
    if (now() - hit.at > CACHE_TTL_MS) {
      cache.delete(text);
      return null;
    }
    cache.delete(text);
    cache.set(text, hit);
    return hit.png;
  }

  function remember(text, png) {
    cache.set(text, { png, at: now() });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  async function generate(text) {
    const upstream = await fetchImpl(`${provider}/QR/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ApiKey: key },
      body: JSON.stringify(qrBody(text)),
      signal: AbortSignal.timeout(20_000),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const type = upstream.headers.get('content-type') ?? '';
    log.log?.(`[qr] provider -> ${upstream.status} (${body.length} bytes)`);
    if (!upstream.ok || !type.startsWith('image/') || body.length === 0) {
      throw new Error(`provider answered ${upstream.status} ${type || '(no type)'} ${body.length} B`);
    }
    return body;
  }

  function generateOnce(text) {
    const pending = inFlight.get(text);
    if (pending) return pending;
    const request = generate(text).finally(() => inFlight.delete(text));
    inFlight.set(text, request);
    return request;
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === HEALTH_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, { ok: true, provider, keyConfigured: key.length > 0 });
      return true;
    }
    if (path !== '/api/qr' && !path.startsWith(QR_PREFIX)) return false;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET /api/qr/<code>' } }, { Allow: 'GET, HEAD' });
      return true;
    }
    let code = '';
    try {
      code = decodeURIComponent(path.slice(QR_PREFIX.length));
    } catch {
      /* stays empty: refused below */
    }
    if (!CODE_RE.test(code)) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown QR code path' } });
      return true;
    }
    const origin = publicUrl || requestOrigin(req);
    if (!origin) {
      sendJson(res, 400, { error: { code: 'BAD_HOST', message: 'invalid Host header' } });
      return true;
    }
    const text = `${origin}/c/${code}`;

    let png = cached(text);
    if (!png) {
      const rate = limiter.hit(clientKey(req, trustProxy), now());
      if (rate.limited) {
        sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: `max ${rateMax} QR codes per ${Math.round(rateWindowMs / 1000)}s` } }, { 'Retry-After': String(rate.retryAfterSec) });
        return true;
      }
      if (!key) {
        sendJson(res, 503, { error: { code: 'QR_NOT_CONFIGURED', message: 'the QR provider key is not configured' } });
        return true;
      }
      try {
        png = await generateOnce(text);
        remember(text, png);
      } catch (err) {
        log.error?.(`[qr] ${text}: ${err?.message ?? err}`);
        sendJson(res, 502, { error: { code: 'QR_UPSTREAM', message: 'the QR provider failed' } });
        return true;
      }
    }

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      ...(url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="qr-${code}.png"` } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : png);
    return true;
  }

  return { handle, provider, keyConfigured: key.length > 0, publicUrl, rateMax, rateWindowMs, trustProxy };
}
