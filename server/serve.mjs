#!/usr/bin/env node
/**
 * App server on a single port: the built SPA, the app API and the QR proxy.
 *
 *   npm run build          # produces dist/ (no Directus URL is baked in)
 *   npm run start          # http://localhost:8080, reads the root .env
 *
 * The browser only ever talks to this server. Card and user data go through
 * /api/* (server/api.mjs), which authorises every request and then calls Directus
 * with the service token — Directus is configured purely by runtime environment.
 *
 * Static answers carry security headers (CSP, nosniff, same-origin framing,
 * referrer policy, HSTS) and are gzipped when the client accepts gzip.
 *
 * Environment:
 *   DIRECTUS_URL     required  Directus base URL (server-to-server; never sent to the browser)
 *   DIRECTUS_TOKEN   required  static token of the service account (npm run directus:bootstrap)
 *   SESSION_SECRET   optional  cookie signing key (>= 16 chars); derived from the token if unset
 *   TRUST_PROXY      optional  1 behind a reverse proxy: rate limits key on the last
 *                              X-Forwarded-For hop (QR_TRUST_PROXY is honoured too)
 *   COOKIE_SECURE    optional  1 forces the Secure cookie flag (auto on https / X-Forwarded-Proto)
 *   MAX_CARDS_PER_USER optional cards a plain user may own, default 20
 *   PORT             optional  listen port, default 8080
 *   DIST_DIR         optional  directory to serve, default ./dist
 *   QR_API_KEY       required  QR provider key, attached server-side
 *   QR_API_URL, QR_RATE_LIMIT_MAX, QR_RATE_LIMIT_WINDOW_MS — see server/qr-handler.mjs
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { apiConfigFromEnv, createApiHandler } from './api.mjs';
import { createQrHandler, qrConfigFromEnv } from './qr-handler.mjs';
import { createLogger, loggerConfigFromEnv } from './logger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.env.DIST_DIR || join(HERE, '..', 'dist'));
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Baseline hardening for every response this server writes itself (static files and
 * JSON fallbacks; the QR handler manages its own headers and is covered by tests).
 * nosniff stops MIME-sniffed script execution, SAMEORIGIN keeps the card pages out
 * of third-party frames, strict-origin-when-cross-origin keeps short codes out of
 * cross-site Referrers, and HSTS is ignored over plain http, so it is safe in dev.
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  // Everything the app loads is same-origin now (API, QR, photos); blob: carries
  // generated QR images. Inline styles stay allowed for per-card accent colours.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
    "connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; " +
    "base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
};

/** Extensions worth compressing; everything else (png/jpg/woff2) is already dense. */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.map']);

function acceptsGzip(req) {
  const enc = req.headers['accept-encoding'];
  return typeof enc === 'string' && /\bgzip\b/i.test(enc);
}

const log = createLogger(loggerConfigFromEnv());
const qr = createQrHandler({ ...qrConfigFromEnv(), log: log.scoped('qr') });
const apiConfig = apiConfigFromEnv();
const api = createApiHandler({ ...apiConfig, log: log.scoped('api') });

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
  res.end(JSON.stringify(payload));
}

/**
 * Vite fingerprints everything under /assets/, so those can be cached forever. The
 * shell, the service worker and the PWA icons keep stable names and must revalidate,
 * or a deploy would leave browsers on the old build.
 */
function cacheControl(pathname) {
  return pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

async function sendFile(req, res, filePath, pathname) {
  let body = await readFile(filePath);
  const ext = extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': cacheControl(pathname),
    ...SECURITY_HEADERS,
  };
  // A compressible response exists in two encodings, so BOTH variants must carry
  // Vary: Accept-Encoding — including the identity one. An immutable /assets/* URL
  // cached by a shared proxy without the marker could hand a gzip body to a client
  // that cannot decode it (or the fat bundle to one that could).
  if (COMPRESSIBLE.has(ext)) headers['Vary'] = 'Accept-Encoding';
  // Reverse proxies do not all compress, and the JS bundles are the bulk of a scan
  // page's load on mobile data. Compress per request (dist is small; gzipSync of the
  // largest bundle is single-digit milliseconds) rather than caching a second copy.
  if (COMPRESSIBLE.has(ext) && acceptsGzip(req)) {
    body = gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = createServer(async (req, res) => {
  // One structured access line per request, whatever branch answers it. The
  // line is emitted when the response finishes (status/bytes known); the
  // request id is echoed as X-Request-Id for correlation with client reports.
  const rlog = log.start(req, res);
  res.on('finish', () => {
    const apiPath = (req.url ?? '').startsWith('/api/');
    rlog.finish(res.statusCode, {
      type: apiPath ? 'api' : 'static',
      bytes: Number(res.getHeader('Content-Length')) || undefined,
    });
  });
  try {
    // The app API, then the QR endpoint and /healthz, are answered in-process.
    if (await api.handle(req, res)) return;
    if (await qr.handle(req, res)) return;

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      json(res, 400, { error: 'malformed path' });
      return;
    }

    // Never let the shell answer an API path: a 200 text/html for a missing route is
    // exactly how a broken deployment looks like a working one.
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      json(res, 404, { error: `unknown API path ${pathname}` });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'use GET' });
      return;
    }

    // Resolve inside DIST and refuse anything that climbs out of it.
    const candidate = resolve(DIST, '.' + pathname);
    if (candidate !== DIST && !candidate.startsWith(DIST + sep)) {
      json(res, 404, { error: 'not found' });
      return;
    }

    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        await sendFile(req, res, candidate, pathname);
        return;
      }
    } catch {
      /* no such file: fall through to the SPA route below */
    }

    // A missing path that looks like a file is a missing asset; anything else is a
    // client-side route (/c/<code>, /panel) and gets the shell so the router can run.
    if (!pathname.endsWith('/') && extname(pathname)) {
      json(res, 404, { error: 'not found' });
      return;
    }
    await sendFile(req, res, join(DIST, 'index.html'), '/index.html');
  } catch (err) {
    log.error(`unhandled request failure`, { req_id: rlog.id, method: req.method, path: req.url, err: { name: err?.name ?? 'Error', message: String(err?.message ?? err) } });
    rlog.finish(500, { type: 'static', error: err });
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
  }
});

server.on('error', (err) => {
  // One readable line instead of an unhandled-error stack (which `npm run api`'s
  // --watch would otherwise repeat on every restart).
  if (err.code === 'EADDRINUSE') {
    log.error(`[app] port ${PORT} is already in use — stop the other process or set PORT`);
    process.exitCode = 1;
    return;
  }
  throw err;
});

server.listen(PORT, () => {
  log.info(`[app] serving ${DIST} on http://localhost:${PORT}`);
  log.info(
    api.configured
      ? `[app] API: /api/* -> Directus ${apiConfig.directusUrl}${apiConfig.derivedSecret ? ' (session key derived from DIRECTUS_TOKEN — set SESSION_SECRET to decouple)' : ''}`
      : '[app] API: NOT CONFIGURED — set DIRECTUS_URL and DIRECTUS_TOKEN (npm run directus:bootstrap writes them); /api/* answers 503',
  );
  log.info(
    `[app] QR endpoint: POST /api/qr -> ${qr.provider} (key ${qr.keyConfigured ? 'configured' : 'MISSING — POST will fail with 500'}, rate ${qr.rateMax}/${Math.round(qr.rateWindowMs / 1000)}s${qr.trustProxy ? '' : ', socket-keyed — set QR_TRUST_PROXY=1 behind a reverse proxy'})`,
  );
});
