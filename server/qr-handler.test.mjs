import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createQrHandler, qrConfigFromEnv } from './qr-handler.mjs';

/**
 * The origin gate is the part of the proxy that is easiest to get wrong and hardest
 * to notice: a browser sends `Origin` on every POST, even same-origin, and a wrong
 * answer here shows up as "QR generation failed." in the app while curl looks fine.
 * These cases run without a network — the provider is never called.
 */
function makeRes() {
  return {
    status: 0,
    headers: {},
    /** String chunks (JSON replies). */
    text: '',
    /** Buffer chunks (image bytes) — kept apart so a PNG never goes through utf8. */
    chunks: [],
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) {
        if (Buffer.isBuffer(chunk)) this.chunks.push(chunk);
        else this.text += chunk.toString();
      }
      return this;
    },
    json() {
      return this.text ? JSON.parse(this.text) : null;
    },
    bytes() {
      return Buffer.concat(this.chunks);
    },
  };
}

function makeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(body));
      req.emit('end');
    });
  }
  return req;
}

/** Keyless config, so an allowed request stops at the key check instead of the network. */
function handler(overrides = {}) {
  return createQrHandler({
    provider: 'https://provider.test',
    key: '',
    allowedOrigins: ['http://localhost:5173'],
    ...overrides,
  });
}

describe('qrConfigFromEnv', () => {
  it('applies the documented defaults and trims the key', () => {
    const config = qrConfigFromEnv({ QR_API_KEY: '  abc  ' });

    expect(config.provider).toBe('https://artqrcode.oxog.net');
    expect(config.key).toBe('abc');
    expect(config.allowedOrigins).toEqual(['http://localhost:5173']);
  });

  it('strips trailing slashes from the provider and splits the origin list', () => {
    const config = qrConfigFromEnv({
      QR_API_URL: 'https://provider.test///',
      QR_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com ,',
    });

    expect(config.provider).toBe('https://provider.test');
    expect(config.allowedOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('reads the rate limit env with sane fallbacks', () => {
    expect(qrConfigFromEnv({})).toMatchObject({ rateMax: 30, rateWindowMs: 60_000 });
    expect(
      qrConfigFromEnv({ QR_RATE_LIMIT_MAX: '10', QR_RATE_LIMIT_WINDOW_MS: '5000' }),
    ).toMatchObject({ rateMax: 10, rateWindowMs: 5000 });
    // Invalid values fall back to the defaults: the limit never turns itself off.
    expect(qrConfigFromEnv({ QR_RATE_LIMIT_MAX: '0' }).rateMax).toBe(30);
    expect(qrConfigFromEnv({ QR_RATE_LIMIT_MAX: '-3' }).rateMax).toBe(30);
    expect(qrConfigFromEnv({ QR_RATE_LIMIT_MAX: 'many' }).rateMax).toBe(30);
    expect(qrConfigFromEnv({ QR_RATE_LIMIT_WINDOW_MS: 'nope' }).rateWindowMs).toBe(60_000);
    // Trusted-proxy keying is strictly opt-in: the exact value '1'.
    expect(qrConfigFromEnv({ QR_TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(qrConfigFromEnv({ QR_TRUST_PROXY: 'true' }).trustProxy).toBe(false);
    expect(qrConfigFromEnv({}).trustProxy).toBe(false);
  });
});

describe('the origin gate', () => {
  it('allows a same-origin Origin, whatever port the app is served on', async () => {
    const res = makeRes();
    const handled = await handler().handle(
      makeReq({ method: 'POST', url: '/api/qr', headers: { origin: 'http://localhost:4173', host: 'localhost:4173' } }),
      res,
    );

    expect(handled).toBe(true);
    // Past the gate: no key configured, so it stops at the key check, not at 403.
    expect(res.status).toBe(500);
    expect(res.json().error).toMatch(/QR_API_KEY/);
  });

  it('allows a same-origin Origin whose host carries the default port', async () => {
    const res = makeRes();
    await handler().handle(
      makeReq({ method: 'POST', url: '/api/qr', headers: { origin: 'https://cards.example.com', host: 'cards.example.com:443' } }),
      res,
    );

    expect(res.status).toBe(500);
  });

  it("honours a reverse proxy's X-Forwarded-Host, which is the name the browser used", async () => {
    const res = makeRes();
    await handler().handle(
      makeReq({
        method: 'POST',
        url: '/api/qr',
        headers: { origin: 'https://cards.example.com', host: '127.0.0.1:8080', 'x-forwarded-host': 'cards.example.com' },
      }),
      res,
    );

    expect(res.status).toBe(500);
  });

  it('refuses a browser page on another origin, naming it', async () => {
    const res = makeRes();
    const handled = await handler().handle(
      makeReq({ method: 'POST', url: '/api/qr', headers: { origin: 'https://evil.example', host: 'cards.example.com' } }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.status).toBe(403);
    expect(res.json().error).toContain('https://evil.example');
  });

  it('still honours an explicitly listed cross-origin caller', async () => {
    const res = makeRes();
    await handler().handle(
      makeReq({ method: 'POST', url: '/api/qr', headers: { origin: 'http://localhost:5173', host: 'cards.example.com' } }),
      res,
    );

    expect(res.status).toBe(500);
  });

  it('treats a request without an Origin as a non-browser caller', async () => {
    const res = makeRes();
    await handler().handle(makeReq({ method: 'POST', url: '/api/qr', headers: { host: 'cards.example.com' } }), res);

    expect(res.status).toBe(500);
  });

  it('answers a preflight without reaching the provider', async () => {
    const res = makeRes();
    await handler().handle(
      makeReq({ method: 'OPTIONS', url: '/api/qr', headers: { origin: 'https://evil.example', host: 'cards.example.com' } }),
      res,
    );

    expect(res.status).toBe(403);
  });
});

describe('the provider call', () => {
  it('attaches the key, forwards the body verbatim and passes the answer back', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init.headers.ApiKey).toBe('secret-key');
      expect(JSON.parse(init.body)).toEqual({ inputText: 'https://app.example.com/c/abc' });
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const res = makeRes();
      const body = JSON.stringify({ inputText: 'https://app.example.com/c/abc' });
      await handler({ key: 'secret-key' }).handle(
        makeReq({
          method: 'POST',
          url: '/api/qr',
          headers: { origin: 'https://cards.example.com', host: 'cards.example.com', 'content-type': 'application/json' },
          body,
        }),
        res,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://provider.test/QR/create');
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toBe('image/png');
      expect(res.bytes().equals(png)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a body that is not JSON', async () => {
    const res = makeRes();
    await handler({ key: 'secret-key' }).handle(
      makeReq({
        method: 'POST',
        url: '/api/qr',
        headers: { origin: 'https://cards.example.com', host: 'cards.example.com' },
        body: 'not json',
      }),
      res,
    );

    expect(res.status).toBe(400);
  });
});

describe('everything else', () => {
  it('answers /healthz without exposing the key', async () => {
    const res = makeRes();
    const handled = await handler().handle(makeReq({ method: 'GET', url: '/healthz' }), res);

    expect(handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true, provider: 'https://provider.test', keyConfigured: false });
    expect(res.text).not.toMatch(/QR_API_KEY=/);
  });

  it('leaves paths it does not own to the caller', async () => {
    const res = makeRes();
    const handled = await handler().handle(makeReq({ method: 'GET', url: '/c/abc' }), res);

    expect(handled).toBe(false);
    expect(res.headersSent).toBe(false);
  });
});

describe('the rate limit', () => {
  /**
   * The limiter reads Date.now() for its fixed windows, so tests pin the clock
   * and advance it explicitly instead of sleeping.
   */
  function pinClock(at) {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(at);
    return (ms) => {
      at += ms;
      spy.mockReturnValue(at);
    };
  }

  /** Fires one POST from 203.0.113.7 and resolves with the captured response. */
  function fire(h, extraHeaders = {}) {
    const res = makeRes();
    return h
      .handle(
        makeReq({
          method: 'POST',
          url: '/api/qr',
          headers: { host: 'cards.example.com', 'x-forwarded-for': '203.0.113.7', ...extraHeaders },
        }),
        res,
      )
      .then(() => res);
  }

  it('allows requests up to the cap, answers 429 beyond it and resets after the window', async () => {
    const advance = pinClock(1_700_000_000_000);
    try {
      const h = handler({ rateMax: 2, rateWindowMs: 60_000, trustProxy: true });

      expect((await fire(h)).status).toBe(500); // under the cap: stops at the key check
      expect((await fire(h)).status).toBe(500);
      const third = await fire(h);
      expect(third.status).toBe(429);
      expect(third.headers['Retry-After']).toBe('60');
      expect(third.json().error).toMatch(/rate limit exceeded/);

      advance(60_001);
      expect((await fire(h)).status).toBe(500); // fresh window: the client counts from zero
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps the CORS headers on the 429 so the browser sees the refusal', async () => {
    pinClock(1_700_000_000_000);
    try {
      const h = handler({ rateMax: 1, rateWindowMs: 60_000, trustProxy: true });
      await fire(h); // the cap: one allowed request
      const second = await fire(h, { origin: 'http://localhost:5173' });

      expect(second.status).toBe(429);
      expect(second.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
      expect(second.headers.Vary).toBe('Origin');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('gives every client its own bucket', async () => {
    pinClock(1_700_000_000_000);
    try {
      const h = handler({ rateMax: 1, rateWindowMs: 60_000, trustProxy: true });
      await fire(h); // exhausts 203.0.113.7

      const other = makeRes();
      await h.handle(
        makeReq({
          method: 'POST',
          url: '/api/qr',
          headers: { host: 'cards.example.com', 'x-forwarded-for': '203.0.113.8' },
        }),
        other,
      );

      expect(other.status).toBe(500); // a different client is not affected

      // The key is the LAST hop (the one the edge appended), not the client's first.
      const spoofed = makeRes();
      await h.handle(
        makeReq({
          method: 'POST',
          url: '/api/qr',
          headers: { host: 'cards.example.com', 'x-forwarded-for': '9.9.9.9, 203.0.113.7' },
        }),
        spoofed,
      );
      expect(spoofed.status).toBe(429); // same bucket as 203.0.113.7 despite the forged first hop
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('never spends budget on the OPTIONS preflight or /healthz', async () => {
    pinClock(1_700_000_000_000);
    try {
      const h = handler({ rateMax: 1, rateWindowMs: 60_000, trustProxy: true });
      await fire(h, { 'x-forwarded-for': '198.51.100.4' }); // cap reached for that client
      expect((await fire(h, { 'x-forwarded-for': '198.51.100.4' })).status).toBe(429);

      const preflight = makeRes();
      await h.handle(
        makeReq({
          method: 'OPTIONS',
          url: '/api/qr',
          headers: { origin: 'http://localhost:5173', host: 'cards.example.com', 'x-forwarded-for': '198.51.100.4' },
        }),
        preflight,
      );
      expect(preflight.status).toBe(204);

      const health = makeRes();
      await h.handle(
        makeReq({ method: 'GET', url: '/healthz', headers: { 'x-forwarded-for': '198.51.100.4' } }),
        health,
      );
      expect(health.status).toBe(200);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('defaults to the socket address, so rotating X-Forwarded-For does not mint budget', async () => {
    const h = handler({ rateMax: 1, rateWindowMs: 60_000 });

    const request = (xff) => {
      const req = makeReq({
        method: 'POST',
        url: '/api/qr',
        headers: { host: 'cards.example.com', 'x-forwarded-for': xff },
      });
      req.socket = { remoteAddress: '10.0.0.9' };
      const res = makeRes();
      return h.handle(req, res).then(() => res);
    };

    expect((await request('203.0.113.1')).status).toBe(500); // allowed, socket-keyed
    const rotated = await request('203.0.113.2'); // a different forged header, same socket
    expect(rotated.status).toBe(429); // still the same bucket: rotation buys nothing
  });

  it('does not spend budget on a CORS-rejected request', async () => {
    const h = handler({ rateMax: 1, rateWindowMs: 60_000, trustProxy: true });

    // Refused at the CORS gate, before the limiter ever sees the client.
    const refused = makeRes();
    await h.handle(
      makeReq({
        method: 'POST',
        url: '/api/qr',
        headers: { origin: 'https://evil.example', host: 'cards.example.com', 'x-forwarded-for': '203.0.113.9' },
      }),
      refused,
    );
    expect(refused.status).toBe(403);

    // The 403 bought no budget: this client still has its full allowance.
    const allowed = makeRes();
    await h.handle(
      makeReq({
        method: 'POST',
        url: '/api/qr',
        headers: { host: 'cards.example.com', 'x-forwarded-for': '203.0.113.9' },
      }),
      allowed,
    );
    expect(allowed.status).toBe(500); // stopped by the key check, not 429
  });
});
