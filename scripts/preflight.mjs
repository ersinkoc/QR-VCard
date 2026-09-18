#!/usr/bin/env node
/**
 * Deployment preflight — the checks production startup runs before anything else,
 * and a standalone doctor (`npm run doctor`) for the same checks by hand.
 *
 *   1. validateEnv()      the runtime variables: required ones present, URLs well
 *                         formed, template placeholders replaced. Pure, no I/O.
 *   2. waitForDirectus()  polls /server/ping until Directus answers, so an app that
 *                         starts next to a Directus still booting waits instead of
 *                         crash-looping.
 *   3. probeToken()       whether DIRECTUS_TOKEN is accepted and whether it carries
 *                         Administrator rights (automatic provisioning needs them).
 *
 * Every failure is reported as one readable line that names the variable to fix.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER_RE = /replace-with|changeme|change-me|example\.com|<[^>]+>|\.\.\./i;
const FALSY = new Set(['0', 'false', 'no', 'off']);

const isFalsy = (value) => FALSY.has(String(value ?? '').trim().toLowerCase());

function httpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Validates the runtime environment. `errors` block startup; `warnings` are
 * printed and startup continues.
 */
export function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const get = (name) => String(env[name] ?? '').trim();

  const directusUrl = get('DIRECTUS_URL');
  if (!directusUrl) {
    errors.push('DIRECTUS_URL is not set — the Directus base URL, e.g. https://directus.example.org');
  } else if (!httpUrl(directusUrl)) {
    errors.push(`DIRECTUS_URL is not an http(s) URL: "${directusUrl}"`);
  } else if (PLACEHOLDER_RE.test(directusUrl)) {
    errors.push(`DIRECTUS_URL still holds the template value "${directusUrl}"`);
  }

  const token = get('DIRECTUS_TOKEN');
  if (!token) {
    errors.push('DIRECTUS_TOKEN is not set — the static token of a Directus user with Administrator access');
  } else if (PLACEHOLDER_RE.test(token)) {
    errors.push('DIRECTUS_TOKEN still holds the template value — paste the static token from Directus (user → Token)');
  }

  const secret = get('SESSION_SECRET');
  if (!secret) {
    warnings.push('SESSION_SECRET is not set — sessions are signed with a key derived from DIRECTUS_TOKEN (rotating the token signs everyone out); set one with `openssl rand -hex 32`');
  } else if (secret.length < 16) {
    errors.push('SESSION_SECRET must be at least 16 characters (`openssl rand -hex 32`)');
  } else if (PLACEHOLDER_RE.test(secret)) {
    errors.push('SESSION_SECRET still holds the template value — generate one with `openssl rand -hex 32`');
  }

  const publicUrl = get('PUBLIC_URL');
  if (!publicUrl) {
    warnings.push('PUBLIC_URL is not set — QR codes use the host each request arrived with; set it to the public address, e.g. https://kart.example.org');
  } else if (!httpUrl(publicUrl)) {
    errors.push(`PUBLIC_URL is not an http(s) URL: "${publicUrl}"`);
  } else if (PLACEHOLDER_RE.test(publicUrl)) {
    errors.push(`PUBLIC_URL still holds the template value "${publicUrl}"`);
  } else if (httpUrl(publicUrl).pathname.replace(/\/+$/, '') !== '') {
    errors.push(`PUBLIC_URL must be an origin without a path: "${publicUrl}"`);
  }

  const port = get('PORT');
  if (port && !(/^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536)) {
    errors.push(`PORT must be a port number, got "${port}"`);
  }

  if ((env.TRUST_PROXY || env.QR_TRUST_PROXY) !== '1') {
    warnings.push('TRUST_PROXY is not 1 — behind a reverse proxy (Coolify, Traefik, Railway, nginx) every visitor shares one rate-limit bucket; set TRUST_PROXY=1 there');
  }

  const qrKey = get('QR_API_KEY');
  if (!qrKey || PLACEHOLDER_RE.test(qrKey)) {
    warnings.push('QR_API_KEY is not set — standard QR codes work; artistic QR codes are unavailable');
  }

  return { errors, warnings };
}

export const bootstrapWanted = (env = process.env) => !isFalsy(env.DIRECTUS_BOOTSTRAP ?? '1');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Polls `<url>/server/ping` until it answers 2xx or `timeoutMs` passes. Resolves
 * `{ ok, attempts, error }` — never throws.
 */
export async function waitForDirectus({ url, timeoutMs = 120_000, intervalMs = 2_000, fetchImpl = globalThis.fetch, log = () => {} }) {
  const base = String(url).replace(/\/+$/, '');
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError = '';
  for (;;) {
    attempts += 1;
    try {
      const res = await fetchImpl(`${base}/server/ping`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return { ok: true, attempts };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err?.cause?.code || err?.cause?.message || err?.message || String(err);
    }
    if (Date.now() + intervalMs > deadline) return { ok: false, attempts, error: lastError };
    if (attempts === 1 || attempts % 5 === 0) log(`waiting for Directus at ${base} (${lastError})`);
    await sleep(intervalMs);
  }
}

/**
 * What the token can do. `valid`: Directus accepts it; `admin`: it may read
 * roles, which only an Administrator can on a QR-VCard Directus (the app's own
 * policies grant nothing). Never throws.
 */
export async function probeToken({ url, token, fetchImpl = globalThis.fetch }) {
  const base = String(url).replace(/\/+$/, '');
  const call = async (path) => {
    try {
      const res = await fetchImpl(`${base}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json().catch(() => null);
      return { status: res.status, data: body?.data ?? null };
    } catch (err) {
      return { status: 0, error: err?.cause?.message || err?.message || String(err) };
    }
  };
  const me = await call('/users/me?fields=id,email,role.name');
  if (me.status === 0) return { valid: false, admin: false, error: `Directus unreachable: ${me.error}` };
  if (me.status === 401 || me.status === 403) return { valid: false, admin: false, error: 'Directus rejected DIRECTUS_TOKEN (invalid or expired static token)' };
  if (me.status >= 400 || !me.data?.id) return { valid: false, admin: false, error: `unexpected answer from /users/me (HTTP ${me.status})` };
  const roles = await call('/roles?limit=1&fields=id');
  return {
    valid: true,
    admin: roles.status === 200,
    identity: me.data.email || me.data.id,
    roleName: me.data.role?.name ?? null,
  };
}

/** `npm run doctor`: every check, printed as a report; exit 1 when anything blocks a start. */
async function doctor() {
  const env = process.env;
  const { errors, warnings } = validateEnv(env);
  for (const w of warnings) console.log(`  warn  ${w}`);
  for (const e of errors) console.log(`  FAIL  ${e}`);
  if (errors.length) {
    console.log(`\n${errors.length} problem(s) block startup.`);
    process.exitCode = 1;
    return;
  }
  const url = env.DIRECTUS_URL.trim();
  const reach = await waitForDirectus({ url, timeoutMs: 10_000 });
  if (!reach.ok) {
    console.log(`  FAIL  Directus at ${url} is unreachable (${reach.error})`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ok    Directus reachable at ${url}`);
  const probe = await probeToken({ url, token: env.DIRECTUS_TOKEN.trim() });
  if (!probe.valid) {
    console.log(`  FAIL  ${probe.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ok    DIRECTUS_TOKEN accepted (${probe.identity}${probe.roleName ? `, role ${probe.roleName}` : ''})`);
  if (!probe.admin && bootstrapWanted(env)) {
    console.log('  FAIL  DIRECTUS_TOKEN lacks Administrator access, which automatic provisioning needs (or set DIRECTUS_BOOTSTRAP=0)');
    process.exitCode = 1;
    return;
  }
  console.log(probe.admin ? '  ok    token has Administrator access (automatic provisioning will work)' : '  ok    provisioning disabled (DIRECTUS_BOOTSTRAP=0)');
  console.log('\nReady to deploy.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  doctor().catch((error) => {
    console.error(`[doctor] FAILED: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
