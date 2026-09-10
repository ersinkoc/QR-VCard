#!/usr/bin/env node
/**
 * Diagnostic for the Art QR generation API (POST /QR/create).
 *
 * What it checks, and why in this order:
 *   1. the key works (an unauthenticated control request must return 401),
 *   2. the COMPLETE InputParameters body returns a 200 image — this is the
 *      contract the app depends on, so it is the only hard requirement here,
 *   3. a minimal body is reported for context: the provider answers a bare 500
 *      for partial bodies, which is exactly how an incomplete body was mistaken
 *      for a broken provider once already.
 *
 * The provider's own CORS headers are reported but not checked: the browser
 * never calls the provider (it calls server/qr-proxy.mjs, which is
 * server-to-server), so a missing Allow-Methods/Allow-Headers cannot break the
 * app. They appear as INFO lines instead of failures.
 *
 * Usage:
 *   npm run qr:verify
 *
 * Configuration (root .env, or the real environment — environment wins):
 *   QR_API_KEY   required  Raw API key, sent in the `ApiKey` header. Note the
 *                          Swagger's documented "ApiKey <key>" form is rejected
 *                          with 401; only the bare key authenticates.
 *   QR_API_URL   optional  API base URL; default https://artqrcode.oxog.net
 *   QR_ORIGIN    optional  Origin to send on the CORS probes; default
 *                          http://localhost:5173
 *   QR_SAMPLE    optional  Text to encode; default is a sample short link.
 *
 * SECURITY: never store this key in a VITE_* variable. Vite inlines VITE_*
 * values into the client bundle, publishing the key to every visitor. This
 * script only reads the key locally and sends it solely as the auth header of
 * the requests it probes; it never prints or stores it.
 *
 * Exit code: 0 when the complete body returns 200, 1 otherwise.
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
const ORIGIN = env.QR_ORIGIN || 'http://localhost:5173';
const key = env.QR_API_KEY || env.VITE_QR_API_KEY || '';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
function info(name, detail = '') {
  console.log(`INFO  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Classifies a response body so the success shape is obvious at a glance. */
function describe(bytes, contentType) {
  if (bytes.length === 0) return 'empty body';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'raw PNG image';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'raw JPEG image';
  const trimmed = bytes.subarray(0, 400).toString('utf8').trim();
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
  if (res.status === 500 && bytes.length === 0) {
    console.log('      note: a bare 500 means the body was INCOMPLETE — the provider throws on partial InputParameters.');
  }
  return { status: res.status, shape, bytes: bytes.length, contentType: ct };
}

/** The full payload the app sends; keep in step with src/lib/qr.ts. */
const COMPLETE_BODY = {
  colorParameters: {
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
  },
  eyeParameters: {
    eyeFrameType: 'Square',
    eyeBallType: 'Circle',
    eyeFrameColorMarker: 'ff0000',
    eyeFrameColorTopRight: 'ff0000',
    eyeFrameColorLeftBottom: 'ff0000',
    eyeBallColorMarker: '000000',
    eyeBallColorTopRight: '000000',
    eyeBallColorLeftBottom: '000000',
    randomEyeFrame: false,
  },
  gradientParameters: {
    linearGradient: false,
    radialGradient: false,
    eyeGradient: false,
    gradientColorFirstHex: 'ff0000',
    gradientColorSecondHex: '000000',
  },
  logoParameters: {
    logoName: 'empty',
    logoVariation: 'Normal',
    logoBackgroundColorHexFormat: '',
    logoRemoveBackground: true,
    logoFile: '',
  },
  premiumParameters: { five: true, four: true, three: true, two: true, twoTwo: true, cross: true, horizontal: true, vertical: true },
  inputText: SAMPLE,
  exportWidth: 1000,
  exportPNG: true,
  eccLevel: 'H',
  shapeName: 'One',
};

async function preflight() {
  const res = await fetch(`${BASE}/QR/create`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'apikey',
    },
  });
  await res.arrayBuffer();
  return {
    status: res.status,
    allowOrigin: res.headers.get('access-control-allow-origin'),
    allowMethods: res.headers.get('access-control-allow-methods'),
    allowHeaders: res.headers.get('access-control-allow-headers'),
  };
}

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

  console.log('\n-- probe: COMPLETE body (what the app sends) --');
  const complete = await post('complete', COMPLETE_BODY);
  check(
    'complete body returns 200 with an image',
    complete.status === 200 && complete.contentType?.startsWith('image/') && complete.bytes > 1000,
    `got ${complete.status} ${complete.contentType ?? '(none)'} ${complete.bytes} B (${complete.shape})`,
  );

  console.log('\n-- probe: minimal body (context: why partial bodies fail) --');
  const minimal = await post('minimal', { inputText: SAMPLE });
  info(
    'minimal body',
    minimal.status === 200
      ? 'unexpectedly succeeded — the completeness requirement may have been relaxed'
      : `${minimal.status} (${minimal.shape}) — expected while the provider requires every nested parameter`,
  );

  console.log('\n-- probe: provider CORS (informational — the app uses the proxy) --');
  const pf = await preflight();
  console.log(`      OPTIONS status=${pf.status}`);
  console.log(`      access-control-allow-origin:  ${pf.allowOrigin ?? '(absent)'}`);
  console.log(`      access-control-allow-methods: ${pf.allowMethods ?? '(absent)'}`);
  console.log(`      access-control-allow-headers: ${pf.allowHeaders ?? '(absent)'}`);
  info('provider CORS is not a blocker here', 'the browser calls server/qr-proxy.mjs, which calls the provider server-to-server');
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nALL CHECKS PASSED — the app-shaped request produces a QR image.' : `\n${failures} CHECK(S) FAILED`);
    // Set the code instead of calling process.exit(): exiting while a fetch
    // socket is still tearing down trips a libuv assertion on Windows.
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((err) => {
    console.error(`qr-api verify crashed: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
