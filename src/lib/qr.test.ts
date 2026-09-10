import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { qrRequest, qrUrl, requestQr } from './qr';

// 1x1 PNG — stands in for whatever image bytes the provider eventually returns.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('qrRequest', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_QR_PROXY_URL', 'https://app.example.com/api/qr');
  });

  it('POSTs to the configured proxy endpoint', () => {
    const { url, init } = qrRequest('https://host/c/abc');
    expect(url).toBe('https://app.example.com/api/qr');
    expect(init.method).toBe('POST');
  });

  it('defaults to the same-origin proxy path when nothing is configured', () => {
    vi.stubEnv('VITE_QR_PROXY_URL', '');
    expect(qrRequest('x').url).toBe('/api/qr');
  });

  it('accepts an explicit same-origin path', () => {
    vi.stubEnv('VITE_QR_PROXY_URL', '/backend/qr');
    expect(qrRequest('x').url).toBe('/backend/qr');
  });

  it('rejects a malformed proxy URL instead of sending links to an arbitrary host', () => {
    vi.stubEnv('VITE_QR_PROXY_URL', 'wrong-host/api/qr'); // no scheme, no leading slash
    expect(() => qrRequest('x')).toThrow(/VITE_QR_PROXY_URL/);

    vi.stubEnv('VITE_QR_PROXY_URL', 'javascript:alert(1)');
    expect(() => qrRequest('x')).toThrow(/VITE_QR_PROXY_URL/);
  });

  it('trims surrounding whitespace and trailing slashes from the proxy URL', () => {
    vi.stubEnv('VITE_QR_PROXY_URL', '  https://app.example.com/api/qr///  ');
    expect(qrRequest('x').url).toBe('https://app.example.com/api/qr');
  });

  it('sends a JSON InputParameters body', () => {
    const { init } = qrRequest('https://host/c/abc');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      inputText: 'https://host/c/abc',
      exportPNG: true,
      exportWidth: 512,
      eccLevel: 'M',
    });
  });

  it('never sends an authorization header — the ApiKey lives only in the proxy', () => {
    const { init } = qrRequest('https://host/c/abc');
    const headerNames = Object.keys(init.headers as Record<string, string>).map((h) => h.toLowerCase());
    expect(headerNames).toEqual(['content-type']);
    expect(JSON.stringify(init)).not.toMatch(/apikey|authorization|bearer/i);
  });
});

describe('qrUrl against a stub proxy (real HTTP, fake provider)', () => {
  type Reply = { status: number; contentType?: string; body?: Buffer };
  const seen: { method?: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let reply: Reply = { status: 500 };
  let base = '';

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, headers: req.headers, body });
      res.writeHead(reply.status, reply.contentType ? { 'Content-Type': reply.contentType } : {});
      res.end(reply.body ?? Buffer.alloc(0));
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen.length = 0;
    reply = { status: 500 };
    vi.stubEnv('VITE_QR_PROXY_URL', base);
  });

  it('POSTs the link to the proxy without any credential', async () => {
    reply = { status: 200, contentType: 'image/png', body: PNG };

    const res = await requestQr('https://host/c/abc');

    expect(res.status).toBe(200);
    const last = seen.at(-1);
    expect(last?.method).toBe('POST');
    expect(last?.headers.apikey).toBeUndefined(); // node lower-cases header names
    expect(last?.headers.authorization).toBeUndefined();
    expect(JSON.parse(last?.body ?? '{}').inputText).toBe('https://host/c/abc');
  });

  it('surfaces a provider 500 passed through the proxy (empty body, no content type)', async () => {
    await expect(qrUrl('https://host/c/abc')).rejects.toThrow(/HTTP 500 \(empty body\)/);
  });

  it('rejects a 200 until response parsing is implemented, rather than guessing the shape', async () => {
    reply = { status: 200, contentType: 'image/png', body: PNG };
    await expect(qrUrl('https://host/c/abc')).rejects.toThrow(/not implemented/);
  });

  it('reports a missing proxy route when the origin answers with the SPA shell', async () => {
    reply = {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from('<!doctype html><html><body>app</body></html>'),
    };
    await expect(qrUrl('https://host/c/abc')).rejects.toThrow(/returned HTML.*no route handled/);
  });
});
