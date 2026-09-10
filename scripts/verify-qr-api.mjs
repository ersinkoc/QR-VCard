#!/usr/bin/env node
/**
 * Diagnostic for the Art QR generation API (POST /QR/create).
 *
 * Why this exists: the endpoint authenticates but currently answers every
 * authenticated request with a bare 500 — no Content-Type header, zero bytes —
 * so the app cannot generate QR codes yet. Run this to re-check the endpoint in
 * one command once the provider ships a fix, and to capture the exact success
 * response shape that src/lib/qr.ts must parse.
 *
 * Usage:
 *   npm run qr:verify
 *
 * Configuration (root .env, or the real environment — environment wins):
 *   QR_API_KEY   required  Raw API key, sent in the `ApiKey` header. Note the
 *                          Swagger's documented "ApiKey <key>" form is rejected
 *                          with 401; only the bare key authenticates.
 *   QR_API_URL   optional  API base URL; default https://artqrcode.oxog.net
 *   QR_SAMPLE    optional  Text to encode; default is a sample short link.
 *
 * SECURITY: do not rename the key to a VITE_* variable. Vite inlines VITE_*
 * values into the client bundle, which would publish the key to every visitor.
 * This script reads the key locally and only ever sends it as the auth header
 * of the request it is probing; it never prints or stores it.
 *
 * Exit code: 0 when the endpoint returns 200 for every probe, 1 otherwise.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const env = {};
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
}
Object.assign(env, process.env);

const BASE = (env.QR_API_URL || 'https://artqrcode.oxog.net').replace(/\/+$/, '');
const SAMPLE = env.QR_SAMPLE || 'https://qr-vcard.local/c/abc123';
const key = env.QR_API_KEY || env.VITE_QR_API_KEY || '';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Classifies a response body so the success shape is obvious at a glance. */
function describe(bytes, contentType) {
  if (bytes.length === 0) return 'empty body';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'raw PNG image';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'raw JPEG image';
  const text = bytes.subarray(0, 400).toString('utf8');
  const trimmed = text.trim();
  if (trimmed.startsWith('<svg') || trimmed.startsWith('<?xml')) return 'SVG markup';
  if (trimmed.startsWith('%PDF')) return 'PDF';
  try {
    const json = JSON.parse(bytes.toString('utf8'));
    if (json === null || typeof json !== 'object') return `JSON scalar (${typeof json})`;
    if (Array.isArray(json)) return `JSON array (${json.length} items)`;
    return `JSON object — top-level keys: ${Object.keys(json).join(', ') || '(none)'}`;
  } catch {
    /* not JSON */
  }
  if (/^[A-Za-z0-9+/=\s]{200,}$/.test(trimmed)) return 'base64 payload (decode to an image)';
  return 'unrecognised';
}

async function post(label, body, { withKey = true } = {}) {
  const res = await fetch(`${BASE}/QR/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(withKey ? { ApiKey: key } : {}) },
    body: JSON.stringify(body),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type');
  const shape = describe(bytes, ct);
  console.log(`      status=${res.status} content-type=${ct ?? '(none)'} bytes=${bytes.length}`);
  console.log(`      shape: ${shape}`);
  if (bytes.length && !shape.startsWith('raw ') && !shape.startsWith('base64')) {
    console.log(`      body: ${bytes.subarray(0, 300).toString('utf8').replace(/\s+/g, ' ')}`);
  }
  if (res.status === 500 && bytes.length === 0) {
    console.log('      hint: known provider failure — bare 500, no Content-Type, no body.');
  }
  return { status: res.status, shape };
}

const colors = { first: '000000', second: 'ff0000', third: '555555', fourth: '888888', background: 'ffffff', useRandomColors: false };
const eyes = { eyeFrameType: 'Square', eyeBallType: 'Circle' };
const gradient = { linearGradient: false, radialGradient: false, eyeGradient: false, gradientColorFirstHex: 'ff0000', gradientColorSecondHex: '000000' };
const logo = { logoName: 'empty', logoVariation: 'Normal', logoRemoveBackground: true, logoFile: '' };
const premium = { five: true, four: true, three: true, two: true, twoTwo: true, cross: true, horizontal: true, vertical: true };

async function main() {
  console.log(`[qr-api] target: ${BASE}/QR/create`);
  console.log(`[qr-api] sample text: ${SAMPLE}`);

  if (!key) {
    check('API key available', false, 'set QR_API_KEY in .env (see the header of this script)');
    return;
  }
  if (!env.QR_API_KEY && env.VITE_QR_API_KEY) {
    console.log('[qr-api] NOTE: using VITE_QR_API_KEY. Vite inlines VITE_* values into the client');
    console.log('[qr-api]       bundle — rename it to QR_API_KEY so the key never ships to browsers.');
  }
  check('API key available', true, `length ${key.length}, sent as the ApiKey header`);

  // Control: without the key the API must reject the request. A 401 here also
  // proves we reached the API itself and not an intermediary error page.
  const control = await fetch(`${BASE}/QR/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputText: SAMPLE }),
  });
  await control.arrayBuffer(); // drain, so the socket closes before we exit
  check('control: request without a key is rejected (401)', control.status === 401, `got ${control.status}`);

  console.log('\n-- probe: minimal body --');
  const minimal = await post('minimal', { inputText: SAMPLE });
  check('minimal body returns 200', minimal.status === 200, `got ${minimal.status} (${minimal.shape})`);

  console.log('\n-- probe: documented example body --');
  const full = await post('documented', {
    inputText: SAMPLE,
    exportWidth: 1000,
    exportPNG: true,
    eccLevel: 'H',
    shapeName: 'One',
    colorParameters: colors,
    eyeParameters: eyes,
    gradientParameters: gradient,
    logoParameters: logo,
    premiumParameters: premium,
  });
  check('documented example returns 200', full.status === 200, `got ${full.status} (${full.shape})`);
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nALL PROBES PASSED — wire the reported shape into src/lib/qr.ts.' : `\n${failures} CHECK(S) FAILED`);
    // Set the code instead of calling process.exit(): exiting while a fetch
    // socket is still tearing down trips a libuv assertion on Windows.
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((err) => {
    console.error(`qr-api verify crashed: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
