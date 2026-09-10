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
