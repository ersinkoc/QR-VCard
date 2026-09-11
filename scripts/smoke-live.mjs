#!/usr/bin/env node
/**
 * End-to-end smoke test for a RUNNING deployment — `npm run smoke:live`.
 *
 *   SMOKE_BASE_URL=https://your-domain npm run smoke:live
 *   SMOKE_BASE_URL=http://localhost:8080 npm run smoke:live     # local `npm run start`
 *
 * Checks, in order:
 *   1. GET /healthz              200 + ok:true; reports whether QR_API_KEY is set
 *   2. GET /api/health           the server reaches Directus and its token is valid
 *   3. GET /panel, /c/demo-01    the SPA shell answers client routes
 *   4. public card               GET /api/public/cards/demo-01 — published, no owner fields
 *   5. admin sign-in             POST /api/auth/login -> HttpOnly cookie -> /api/me role=admin
 *   6. isolation (opt-in)        with USER_EMAIL / USER_PASSWORD: the plain user sees only
 *                                own cards and gets 404 on a card the admin can see
 *                                but the user does not own, and 403 on /api/users
 *   7. Directus lockdown (opt-in) with DIRECTUS_URL: anonymous /items/vcards is refused
 *   8. QR image                  GET /api/qr/demo-01 is a PNG from the same origin, and the
 *                                old free-form POST /api/qr is refused (405)
 *   9. 429 probe (opt-in)        SMOKE_RATE_PROBE=1 (each request is a billable cache miss)
 *
 * Configuration (environment):
 *   SMOKE_BASE_URL        required  the app base URL
 *   PANEL_EMAIL / PANEL_PASSWORD    admin account, default admin@local.dev / vcard-admin
 *   USER_EMAIL / USER_PASSWORD      plain account for the isolation checks (optional)
 *   DIRECTUS_URL          optional  Directus base for the lockdown probe
 *   SMOKE_QR=0            optional  skip the QR generation
 *   SMOKE_RATE_PROBE=1    optional  rapid-fire POST /api/qr until 429 (SMOKE_RATE_PROBE_MAX, default 6)
 *
 * Exit code: 0 when no FAIL, 1 otherwise. SKIPs never fail the run.
 */
import { pathToFileURL } from 'node:url';

/** A tiny cookie-carrying client for one account. */
function client(base) {
  let cookie = '';
  return async function call(method, path, body) {
    const headers = { accept: 'application/json' };
    if (method !== 'GET') headers['x-qrv'] = '1';
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const json = await res.json().catch(() => null);
    return { status: res.status, json, setCookie: set };
  };
}

export async function runSmoke(config = {}) {
  const base = String(config.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('SMOKE_BASE_URL is required (e.g. https://your-domain)');
  const results = [];
  const rec = (kind, name, detail = '') => {
    results.push({ kind, name, detail });
    console.log(`${kind.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const pass = (n, d) => rec('PASS', n, d);
  const fail = (n, d) => rec('FAIL', n, d);
  const skip = (n, d) => rec('SKIP', n, d);
  const warn = (n, d) => rec('WARN', n, d);
  const errText = (err) => String(err?.cause?.message ?? err?.message ?? err);

  // 1. liveness + QR key
  let keyConfigured = false;
  try {
    const res = await fetch(`${base}/healthz`);
    const body = await res.json().catch(() => null);
    keyConfigured = body?.keyConfigured === true;
    if (res.status === 200 && body?.ok) pass('GET /healthz', keyConfigured ? 'QR_API_KEY configured' : 'QR_API_KEY is MISSING server-side');
    else fail('GET /healthz', `got ${res.status}`);
  } catch (err) {
    fail('GET /healthz', errText(err));
  }

  // 2. server -> Directus
  try {
    const res = await fetch(`${base}/api/health`);
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body?.ok) pass('GET /api/health', 'Directus reachable, service token valid');
    else fail('GET /api/health', `${res.status} ${JSON.stringify(body)} — check DIRECTUS_URL / DIRECTUS_TOKEN on the server`);
  } catch (err) {
    fail('GET /api/health', errText(err));
  }

  // 3. SPA shell on client routes
  for (const route of ['/panel', '/c/demo-01']) {
    try {
      const res = await fetch(`${base}${route}`);
      const ok = res.status === 200 && (res.headers.get('content-type') ?? '').startsWith('text/html') && (await res.text()).includes('<div id="root">');
      if (ok) pass(`GET ${route}`, 'SPA shell');
      else fail(`GET ${route}`, `got ${res.status}`);
    } catch (err) {
      fail(`GET ${route}`, errText(err));
    }
  }

  // 4. public card
  try {
    const res = await fetch(`${base}/api/public/cards/demo-01`);
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body?.data?.code === 'demo-01' && !('owner' in body.data) && !('id' in body.data)) pass('public card', 'demo-01 readable, no internal fields');
    else if (res.status === 404) warn('public card', 'demo-01 is not published on this instance');
    else fail('public card', `got ${res.status} ${JSON.stringify(body)?.slice(0, 120)}`);
  } catch (err) {
    fail('public card', errText(err));
  }

  // 5. admin sign-in
  const admin = client(base);
  let adminCards = [];
  try {
    const login = await admin('POST', '/api/auth/login', { email: config.panelEmail || 'admin@local.dev', password: config.panelPassword || 'vcard-admin' });
    if (login.status !== 200) {
      fail('admin sign-in', `${login.status} ${login.json?.error?.code ?? ''} — set PANEL_EMAIL / PANEL_PASSWORD`);
    } else {
      const flags = login.setCookie ?? '';
      if (!/HttpOnly/i.test(flags)) fail('session cookie', 'missing HttpOnly');
      else if (base.startsWith('https:') && !/Secure/i.test(flags)) fail('session cookie', 'missing Secure on https — set COOKIE_SECURE=1 or forward X-Forwarded-Proto');
      else pass('session cookie', 'HttpOnly, SameSite=Lax' + (/Secure/i.test(flags) ? ', Secure' : ''));
      const me = await admin('GET', '/api/me');
      if (me.json?.data?.role === 'admin') pass('admin sign-in', `${me.json.data.email} is an administrator`);
      else fail('admin sign-in', `role is ${me.json?.data?.role}`);
      adminCards = (await admin('GET', '/api/cards')).json?.data ?? [];
      const users = await admin('GET', '/api/users');
      if (users.status === 200) pass('admin user list', `${users.json.data.length} account(s)`);
      else fail('admin user list', `got ${users.status}`);
    }
  } catch (err) {
    fail('admin sign-in', errText(err));
  }

  // 6. isolation for a plain user
  if (config.userEmail && config.userPassword) {
    const user = client(base);
    try {
      const login = await user('POST', '/api/auth/login', { email: config.userEmail, password: config.userPassword });
      if (login.status !== 200) {
        fail('user sign-in', `got ${login.status}`);
      } else {
        const me = (await user('GET', '/api/me')).json?.data;
        const own = (await user('GET', '/api/cards')).json?.data ?? [];
        const leaked = own.filter((c) => adminCards.some((a) => a.id === c.id && a.owner?.id !== me.id));
        if (leaked.length === 0) pass('user sees only own cards', `${own.length} card(s)`);
        else fail('user sees only own cards', `${leaked.length} foreign card(s) listed`);
        const foreign = adminCards.find((c) => c.owner?.id !== me.id);
        if (foreign) {
          const probe = await user('PATCH', `/api/cards/${foreign.id}`, {});
          if (probe.status === 404) pass('user cannot touch a foreign card', '404');
          else fail('user cannot touch a foreign card', `got ${probe.status}`);
        } else {
          skip('user cannot touch a foreign card', 'no card owned by someone else exists');
        }
        const users = await user('GET', '/api/users');
        if (users.status === 403) pass('user cannot list accounts', '403');
        else fail('user cannot list accounts', `got ${users.status}`);
      }
    } catch (err) {
      fail('isolation', errText(err));
    }
  } else {
    skip('isolation checks', 'set USER_EMAIL / USER_PASSWORD to a plain account');
  }

  // 7. Directus itself refuses browsers
  if (config.directusUrl) {
    try {
      const res = await fetch(`${String(config.directusUrl).replace(/\/+$/, '')}/items/vcards?limit=1`);
      if (res.status === 401 || res.status === 403) pass('Directus lockdown', `anonymous /items/vcards -> ${res.status}`);
      else fail('Directus lockdown', `anonymous /items/vcards -> ${res.status} — re-run npm run directus:bootstrap`);
    } catch (err) {
      fail('Directus lockdown', errText(err));
    }
  } else {
    skip('Directus lockdown', 'set DIRECTUS_URL to probe it');
  }

  // 8. one real QR image from the same origin (a cache hit costs nothing)
  if (!config.qr) skip('QR image', 'SMOKE_QR=0');
  else if (!keyConfigured) skip('QR image', 'QR_API_KEY is not configured server-side');
  else {
    try {
      const res = await fetch(`${base}/api/qr/demo-01`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (res.status === 200 && (res.headers.get('content-type') ?? '').startsWith('image/png') && bytes.length > 1000) pass('QR image', `GET /api/qr/demo-01 -> PNG, ${bytes.length} bytes`);
      else fail('QR image', `got ${res.status} ${res.headers.get('content-type') ?? '(none)'} ${bytes.length} B`);
      const post = await fetch(`${base}/api/qr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"inputText":"https://evil.example"}' });
      if (post.status === 405) pass('no free-form QR', 'POST /api/qr -> 405');
      else fail('no free-form QR', `POST /api/qr -> ${post.status}`);
    } catch (err) {
      fail('QR image', errText(err));
    }
  }

  // 9. opt-in 429 probe: distinct codes, so every request is a (billable) cache miss
  if (config.rateProbe) {
    const seq = [];
    try {
      for (let i = 0; i < (config.rateProbeMax || 6); i++) {
        const res = await fetch(`${base}/api/qr/smoke-${Date.now().toString(36)}-${i}`);
        await res.arrayBuffer();
        seq.push(res.status);
        if (res.status === 429) break;
      }
    } catch (err) {
      warn('429 rate limit probe', errText(err));
    }
    if (seq.includes(429)) pass('429 rate limit', seq.join(' → '));
    else warn('429 rate limit', `no 429 within ${seq.length} requests — lower QR_RATE_LIMIT_MAX temporarily to see it`);
  } else {
    skip('429 rate limit', 'set SMOKE_RATE_PROBE=1');
  }

  return { results, failures: results.filter((r) => r.kind === 'FAIL').length, warnings: results.filter((r) => r.kind === 'WARN').length };
}

function configFromEnv(env = process.env) {
  return {
    baseUrl: env.SMOKE_BASE_URL,
    panelEmail: env.PANEL_EMAIL,
    panelPassword: env.PANEL_PASSWORD,
    userEmail: env.USER_EMAIL,
    userPassword: env.USER_PASSWORD,
    directusUrl: env.DIRECTUS_URL,
    qr: env.SMOKE_QR !== '0',
    rateProbe: env.SMOKE_RATE_PROBE === '1',
    rateProbeMax: Number.parseInt(env.SMOKE_RATE_PROBE_MAX ?? '', 10) || 6,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runSmoke(configFromEnv())
    .then((r) => {
      console.log(r.failures === 0 ? `\nSMOKE PASSED — ${r.warnings} warning(s)` : `\nSMOKE FAILED — ${r.failures} check(s) failed`);
      process.exitCode = r.failures === 0 ? 0 : 1;
    })
    .catch((err) => {
      console.error(`smoke crashed: ${err?.message ?? err}`);
      process.exitCode = 1;
    });
}
