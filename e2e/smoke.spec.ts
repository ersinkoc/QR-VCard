import { test, expect } from './helper';

/**
 * Post-deploy smoke against a RUNNING deployment — the Playwright successor of
 * the old `scripts/smoke-live.mjs` fetch-loop.
 *
 *   SMOKE_BASE_URL=https://your-domain npm run smoke
 *   SMOKE_BASE_URL=http://localhost:8080 npm run smoke   # local `npm run start`
 *   npm run smoke                                        # localhost, server started for you
 *
 * Checks: health endpoints, SPA shell on client routes, the public card, admin
 * sign-in with cookie flags, plain-user isolation, Directus lockdown, a real QR
 * PNG from the same origin and — opt-in — the 429 rate-limit path.
 *
 * Configuration (environment, all optional unless noted):
 *   SMOKE_BASE_URL        the app base URL (default http://127.0.0.1:4173; a
 *                         non-local value also enables the cookie-secure check)
 *   PANEL_EMAIL / PANEL_PASSWORD    admin account, default admin@local.dev / vcard-admin
 *   USER_EMAIL / USER_PASSWORD      plain account for the isolation checks
 *   DIRECTUS_URL          Directus base for the lockdown probe
 *   SMOKE_QR=0            skip the QR generation
 *   SMOKE_RATE_PROBE=1    rapid-fire QR codes until 429 (each request is a
 *                         billable cache miss; SMOKE_RATE_PROBE_MAX, default 6)
 *
 * The public-card check targets `demo-01` like the old script did; when it is
 * not published on the instance the check is skipped, never failed.
 */
test.describe('post-deploy smoke', () => {
  const base = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4173').replace(/\/+$/, '');
  const qrEnabled = process.env.SMOKE_QR !== '0';
  const rateProbe = process.env.SMOKE_RATE_PROBE === '1';
  const rateProbeMax = Number.parseInt(process.env.SMOKE_RATE_PROBE_MAX ?? '', 10) || 6;
  const nonLocalBase = !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(base);

  interface CardRow {
    id: string;
    owner: { id: string } | null;
  }

  async function login(request: import('@playwright/test').APIRequestContext, email: string, password: string) {
    return request.post(`${base}/api/auth/login`, {
      data: { email, password },
      headers: { 'X-QRV': '1' },
    });
  }

  test('health endpoints and SPA shell', async ({ request }) => {
    const pong = await request.get(`${base}/healthz`);
    expect(pong.status()).toBe(200);
    const ping = (await pong.json()) as { ok?: boolean; keyConfigured?: boolean };
    expect(ping.ok).toBe(true);
    console.log(`[smoke] QR_API_KEY ${ping.keyConfigured ? 'configured' : 'is MISSING server-side'}`);

    const deep = await request.get(`${base}/api/health`);
    expect(deep.status()).toBe(200);
    expect(((await deep.json()) as { ok?: boolean }).ok).toBe(true);

    for (const route of ['/panel', '/c/demo-01']) {
      const res = await request.get(`${base}${route}`);
      expect(res.status(), route).toBe(200);
      expect(res.headers()['content-type']).toMatch(/^text\/html/);
      expect(await res.text()).toContain('<div id="root">');
    }
  });

  test('published card is publicly readable without internal fields', async ({ request }) => {
    const res = await request.get(`${base}/api/public/cards/demo-01`);
    if (res.status() === 404) {
      test.skip(true, 'demo-01 is not published on this instance');
      return;
    }
    expect(res.status()).toBe(200);
    const card = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(card.code).toBe('demo-01');
    expect(card).not.toHaveProperty('owner');
    expect(card).not.toHaveProperty('id');
  });

  test('admin signs in, keeps a hardened cookie and administers', async ({ request }) => {
    const email = process.env.PANEL_EMAIL ?? 'admin@local.dev';
    const password = process.env.PANEL_PASSWORD ?? 'vcard-admin';
    const explicitCreds = Boolean(process.env.PANEL_EMAIL || process.env.PANEL_PASSWORD);

    const loginRes = await login(request, email, password);
    if (loginRes.status() !== 200 && !explicitCreds) {
      // The seed default only works on a freshly bootstrapped instance; on a
      // real deployment the admin password has (hopefully) been changed.
      test.skip(true, `seed admin sign-in failed (${loginRes.status()}) — set PANEL_EMAIL / PANEL_PASSWORD to verify a real admin account`);
      return;
    }
    expect(loginRes.status(), 'set PANEL_EMAIL / PANEL_PASSWORD to a real admin account').toBe(200);

    const setCookie = loginRes.headersArray().find((h) => h.name.toLowerCase() === 'set-cookie')?.value ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    if (nonLocalBase) {
      expect(setCookie, 'missing Secure on https — set COOKIE_SECURE=1 or forward X-Forwarded-Proto').toMatch(/Secure/i);
    }
    const me = await request.get(`${base}/api/me`);
    expect(me.status()).toBe(200);
    expect(((await me.json()) as { data: { role: string } }).data.role).toBe('admin');
    expect((await request.get(`${base}/api/users`)).status()).toBe(200);
  });

  test('plain user sees only own cards and is refused administration', async ({ request }) => {
    test.skip(!process.env.USER_EMAIL && !process.env.USER_PASSWORD, 'set USER_EMAIL / USER_PASSWORD to a plain account to check isolation');
    const panelEmail = process.env.PANEL_EMAIL ?? 'admin@local.dev';
    const panelPassword = process.env.PANEL_PASSWORD ?? 'vcard-admin';

    // One cookie slot, like the old smoke client: sign in as the admin to list
    // every card, then let the plain user take the session over.
    let allCards: CardRow[] = [];
    const adminLogin = await login(request, panelEmail, panelPassword);
    if (adminLogin.status() === 200) {
      allCards = ((await (await request.get(`${base}/api/cards`)).json()) as { data: CardRow[] }).data ?? [];
    } else {
      console.log(`[smoke] admin sign-in failed (${adminLogin.status()}) — set PANEL_EMAIL / PANEL_PASSWORD to enable the foreign-card probe`);
    }

    const userLogin = await login(request, process.env.USER_EMAIL!, process.env.USER_PASSWORD!);
    expect(userLogin.status()).toBe(200);

    const me = ((await (await request.get(`${base}/api/me`)).json()) as { data: { id: string } }).data;
    const listing = await request.get(`${base}/api/cards`);
    expect(listing.status()).toBe(200);
    const mine = ((await listing.json()) as { data: CardRow[] }).data;
    expect(mine.filter((c) => (c.owner?.id ?? null) !== me.id), 'a foreign card leaked into the user listing').toHaveLength(0);

    const foreign = allCards.find((c) => c.owner?.id !== me.id);
    test.skip(!foreign, 'no card owned by someone else exists (or admin credentials were not given)');
    if (foreign) {
      const probe = await request.patch(`${base}/api/cards/${foreign.id}`, { data: {}, headers: { 'X-QRV': '1' } });
      expect(probe.status()).toBe(404);
    }
    expect((await request.get(`${base}/api/users`)).status()).toBe(403);
    expect((await request.get(`${base}/api/audit`)).status()).toBe(403);
  });

  test('Directus itself refuses anonymous browsers', async ({ request }) => {
    test.skip(!process.env.DIRECTUS_URL, 'set DIRECTUS_URL to probe the Directus lockdown');
    const res = await request.get(`${process.env.DIRECTUS_URL!.replace(/\/+$/, '')}/items/vcards?limit=1`);
    expect([401, 403], 're-run npm run directus:bootstrap').toContain(res.status());
  });

  test('QR image is a real PNG from the same origin and free-form POST is refused', async ({ request }) => {
    test.skip(!qrEnabled, 'SMOKE_QR=0');
    const key = await request.get(`${base}/healthz`);
    test.skip(((await key.json()) as { keyConfigured?: boolean }).keyConfigured !== true, 'QR_API_KEY is not configured server-side');

    const qr = await request.get(`${base}/api/qr/demo-01`);
    expect(qr.status()).toBe(200);
    expect(qr.headers()['content-type']).toMatch(/^image\/png/);
    const bytes = await qr.body();
    expect(bytes.length).toBeGreaterThan(1000);

    const post = await request.post(`${base}/api/qr`, { data: { inputText: 'https://evil.example' } });
    expect(post.status()).toBe(405);
  });

  test('QR rate limit answers 429 under rapid fire', async ({ request }) => {
    test.skip(!rateProbe, 'set SMOKE_RATE_PROBE=1 (each request is a billable cache miss)');
    const seq: number[] = [];
    for (let i = 0; i < rateProbeMax; i++) {
      const res = await request.get(`${base}/api/qr/smoke-${Date.now().toString(36)}-${i}`);
      await res.body();
      const status = res.status();
      seq.push(status);
      if (status === 429) break;
    }
    expect(seq).toContain(429);
  });
});
