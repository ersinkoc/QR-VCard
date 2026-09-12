import { describe, expect, it, vi } from 'vitest';
import { createQrHandler, qrBody, qrConfigFromEnv, requestOrigin } from './qr-handler.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk !== undefined) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    },
    json() {
      return JSON.parse(this.body.toString('utf8'));
    },
  };
}

function makeReq({ method = 'GET', url = '/', headers = {}, socket = { remoteAddress: '10.0.0.1' } } = {}) {
  return { method, url, headers: { host: 'cards.example.com', ...headers }, socket };
}

function providerOk() {
  return vi.fn(async () => new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } }));
}

function setup(overrides = {}, fetchImpl = providerOk()) {
  const h = createQrHandler(
    { provider: 'https://provider.test', key: 'secret-key', publicUrl: '', rateMax: 30, rateWindowMs: 60_000, trustProxy: false, fallbackToStandard: false, ...overrides },
    { fetchImpl, log: {} },
  );
  const get = async (url, headers) => {
    const res = makeRes();
    const handled = await h.handle(makeReq({ url, headers }), res);
    return { handled, res };
  };
  return { h, fetchImpl, get };
}

describe('qrConfigFromEnv', () => {
  it('applies defaults, trims the key and reads PUBLIC_URL', () => {
    const c = qrConfigFromEnv({ QR_API_KEY: '  abc ', PUBLIC_URL: 'https://cards.example.com/' });
    expect(c).toMatchObject({ provider: 'https://artqrcode.oxog.net', key: 'abc', publicUrl: 'https://cards.example.com', rateMax: 30, rateWindowMs: 60_000 });
  });

  it('never turns the rate limit off with a bad value', () => {
    expect(qrConfigFromEnv({ QR_RATE_LIMIT_MAX: '0' }).rateMax).toBe(30);
    expect(qrConfigFromEnv({ QR_RATE_LIMIT_WINDOW_MS: 'x' }).rateWindowMs).toBe(60_000);
    expect(qrConfigFromEnv({ TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(qrConfigFromEnv({ QR_TRUST_PROXY: '1' }).trustProxy).toBe(true);
  });
});

describe('qrBody', () => {
  it('is the COMPLETE body the provider requires (a partial one gets a bare 500)', () => {
    const body = qrBody('https://host/c/abc');
    expect(body).toMatchObject({ inputText: 'https://host/c/abc', exportWidth: 1000, exportPNG: true, eccLevel: 'H', shapeName: 'One' });
    expect(body.colorParameters).toMatchObject({ premiumFiveFirst: '000000', premiumCrossFourth: '888888', background: 'ffffff', useRandomColors: false });
    expect(body.eyeParameters).toMatchObject({ eyeFrameType: 'Square', eyeBallType: 'Circle', randomEyeFrame: false });
    expect(body.gradientParameters).toMatchObject({ linearGradient: false, gradientColorFirstHex: 'ff0000' });
    expect(body.logoParameters).toMatchObject({ logoName: 'empty', logoBackgroundColorHexFormat: '' });
    expect(body.premiumParameters).toMatchObject({ five: true, cross: true, vertical: true });
  });
});

describe('requestOrigin', () => {
  it('uses the forwarded host and scheme of a reverse proxy', () => {
    expect(requestOrigin(makeReq({ headers: { host: '127.0.0.1:8080', 'x-forwarded-host': 'Cards.Example.com', 'x-forwarded-proto': 'https' } }))).toBe('https://cards.example.com');
    expect(requestOrigin(makeReq({ headers: { host: 'localhost:5173' } }))).toBe('http://localhost:5173');
  });

  it('refuses a Host that is not a host', () => {
    expect(requestOrigin(makeReq({ headers: { host: 'evil.com/path?x' } }))).toBeNull();
  });
});

describe('GET /api/qr/:code', () => {
  it('encodes the site’s own short link, with the key attached server-side', async () => {
    const { get, fetchImpl } = setup();
    const { res } = await get('/api/qr/abc123', { 'x-forwarded-proto': 'https' });

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['Cache-Control']).toMatch(/max-age=86400/);
    expect(res.body.equals(PNG)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://provider.test/QR/create');
    expect(init.headers.ApiKey).toBe('secret-key');
    expect(JSON.parse(init.body).inputText).toBe('https://cards.example.com/c/abc123');
  });

  it('prefers PUBLIC_URL over the request host', async () => {
    const { get, fetchImpl } = setup({ publicUrl: 'https://kart.example.com' });
    await get('/api/qr/abc', { host: 'internal:8080' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).inputText).toBe('https://kart.example.com/c/abc');
  });

  it('serves repeats from the cache — one provider call per link', async () => {
    const { get, fetchImpl } = setup();
    await get('/api/qr/abc');
    await get('/api/qr/abc');
    await Promise.all([get('/api/qr/xyz'), get('/api/qr/xyz')]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keys the cache on the full link, so a forged Host cannot poison it', async () => {
    const { get, fetchImpl } = setup();
    await get('/api/qr/abc', { host: 'evil.example' });
    await get('/api/qr/abc');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).inputText).toBe('http://cards.example.com/c/abc');
  });

  it('offers a download variant', async () => {
    const { res } = await setup().get('/api/qr/abc?download=1');
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="qr-abc.png"');
  });

  it('refuses anything that is not a short code, without calling the provider', async () => {
    const { get, fetchImpl } = setup();
    expect((await get('/api/qr/')).res.status).toBe(404);
    expect((await get('/api/qr/has%20space')).res.status).toBe(404);
    expect((await get('/api/qr/a/b')).res.status).toBe(404);
    expect((await get('/api/qr/%E0%A4%A')).res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('only answers GET — there is no free-form POST any more', async () => {
    const { h, fetchImpl } = setup();
    const res = makeRes();
    await h.handle(makeReq({ method: 'POST', url: '/api/qr' }), res);
    expect(res.status).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 503 without a key and 502 when the provider fails', async () => {
    expect((await setup({ key: '' }).get('/api/qr/abc')).res.status).toBe(503);
    const failing = vi.fn(async () => new Response(null, { status: 500 }));
    const { res } = await setup({}, failing).get('/api/qr/abc');
    expect(res.status).toBe(502);
    expect(res.json().error.code).toBe('QR_UPSTREAM');
  });

  it('generates standard QR code with ?style=standard locally without calling the provider', async () => {
    const { get, fetchImpl } = setup({ key: '' });
    const { res } = await get('/api/qr/abc?style=standard');
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.body.length).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to standard QR code when fallbackToStandard: true and key is missing', async () => {
    const { get, fetchImpl } = setup({ key: '', fallbackToStandard: true });
    const { res } = await get('/api/qr/abc');
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keys cache independently for standard and art styles', async () => {
    const { get, fetchImpl } = setup();
    await get('/api/qr/abc?style=standard');
    await get('/api/qr/abc?style=art');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await get('/api/qr/abc?style=standard');
    await get('/api/qr/abc?style=art');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rate-limits cache misses per client, with Retry-After', async () => {
    const { get } = setup({ rateMax: 2 });
    await get('/api/qr/a1');
    await get('/api/qr/a2');
    const third = await get('/api/qr/a3');
    expect(third.res.status).toBe(429);
    expect(third.res.headers['Retry-After']).toBeDefined();
    // A cached image costs nothing and is never limited.
    expect((await get('/api/qr/a1')).res.status).toBe(200);
  });

  it('keys the limit on the last X-Forwarded-For hop only behind a trusted proxy', async () => {
    const { get } = setup({ rateMax: 1, trustProxy: true });
    await get('/api/qr/b1', { 'x-forwarded-for': '203.0.113.7' });
    expect((await get('/api/qr/b2', { 'x-forwarded-for': '203.0.113.8' })).res.status).toBe(200);
    expect((await get('/api/qr/b3', { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' })).res.status).toBe(429);
  });
});

describe('everything else', () => {
  it('answers /healthz without exposing the key', async () => {
    const { handled, res } = await setup().get('/healthz');
    expect(handled).toBe(true);
    expect(res.json()).toEqual({ ok: true, provider: 'https://provider.test', keyConfigured: true, standardQrSupported: true });
    expect(res.body.toString()).not.toContain('secret-key');
  });

  it('reports the baked commit sha on /healthz (post-deploy verification)', async () => {
    process.env.QRV_COMMIT_SHA = 'abc1234def5678abc1234def5678abc1234def56';
    try {
      const { res } = await setup().get('/healthz');
      expect(res.json()).toMatchObject({ ok: true, sha: 'abc1234def5678abc1234def5678abc1234def56' });
    } finally {
      delete process.env.QRV_COMMIT_SHA;
    }
  });

  it('ignores a malformed QRV_COMMIT_SHA instead of echoing it', async () => {
    process.env.QRV_COMMIT_SHA = '<script>alert(1)</script>';
    try {
      const { res } = await setup().get('/healthz');
      expect(res.json().sha).toBeUndefined();
    } finally {
      delete process.env.QRV_COMMIT_SHA;
    }
  });

  it('leaves paths it does not own to the caller', async () => {
    expect((await setup().get('/c/abc')).handled).toBe(false);
    expect((await setup().get('/api/qrx')).handled).toBe(false);
  });
});
