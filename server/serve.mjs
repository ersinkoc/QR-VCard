#!/usr/bin/env node
/**
 * App server on a single port: the built SPA and the QR proxy in one process.
 *
 * This is the simple deployment — nothing else to run and no reverse-proxy route for
 * /api/qr to get wrong, because the same server answers it. Directus is still called
 * by the browser directly, so point the build at it (VITE_DIRECTUS_URL) and allow this
 * app's origin in Directus.
 *
 *   npm run build          # produces dist/ (reads VITE_DIRECTUS_URL from .env)
 *   npm run start          # http://localhost:8080
 *
 * Static answers carry baseline security headers (nosniff, same-origin framing,
 * referrer policy, HSTS) and are gzipped when the client accepts gzip — platform
 * proxies do not always compress, and QR landing pages are opened on phones.
 *
 * Environment:
 *   PORT        optional  listen port, default 8080
 *   DIST_DIR    optional  directory to serve, default ./dist
 *   QR_API_KEY  required  provider key, attached server-side (never sent to the client)
 *   QR_API_URL  optional  provider base, default https://artqrcode.oxog.net
 *   QR_RATE_LIMIT_MAX          optional  POST /api/qr cap per client per window, default 30
 *   QR_RATE_LIMIT_WINDOW_MS    optional  rate window, default 60000
 *   QR_TRUST_PROXY             optional  1 = rate-limit per real client behind a reverse
 *                                        proxy (last X-Forwarded-For hop) instead of per
 *                                        proxy socket address
 *
 * VITE_DIRECTUS_URL is a BUILD-time value: Vite inlines it into the bundle, so changing
 * which Directus the app talks to means rebuilding (or passing --build-arg in Docker).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createQrHandler, qrConfigFromEnv } from './qr-handler.mjs';

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
};

/** Extensions worth compressing; everything else (png/jpg/woff2) is already dense. */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.map']);

function acceptsGzip(req) {
  const enc = req.headers['accept-encoding'];
  return typeof enc === 'string' && /\bgzip\b/i.test(enc);
}

const qr = createQrHandler(qrConfigFromEnv());

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
  try {
    // The QR endpoint and /healthz are answered in-process.
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
    console.error(`[app] ${req.method} ${req.url} failed: ${err?.message ?? err}`);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`[app] serving ${DIST} on http://localhost:${PORT}`);
  console.log(
    `[app] QR endpoint: POST /api/qr -> ${qr.provider} (key ${qr.keyConfigured ? 'configured' : 'MISSING — POST will fail with 500'}, rate ${qr.rateMax}/${Math.round(qr.rateWindowMs / 1000)}s${qr.trustProxy ? '' : ', socket-keyed — set QR_TRUST_PROXY=1 behind a reverse proxy'})`,
  );
});
