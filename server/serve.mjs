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
 * Environment:
 *   PORT        optional  listen port, default 8080
 *   DIST_DIR    optional  directory to serve, default ./dist
 *   QR_API_KEY  required  provider key, attached server-side (never sent to the client)
 *   QR_API_URL  optional  provider base, default https://artqrcode.oxog.net
 *
 * VITE_DIRECTUS_URL is a BUILD-time value: Vite inlines it into the bundle, so changing
 * which Directus the app talks to means rebuilding (or passing --build-arg in Docker).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const qr = createQrHandler(qrConfigFromEnv());

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
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
  const body = await readFile(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': cacheControl(pathname),
  });
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
    `[app] QR endpoint: POST /api/qr -> ${qr.provider} (key ${qr.keyConfigured ? 'configured' : 'MISSING — POST will fail with 500'})`,
  );
});
