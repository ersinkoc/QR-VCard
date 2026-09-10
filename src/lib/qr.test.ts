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
    vi.stubEnv('VITE_QR_API_URL', 'https://artqrcode.oxog.net');
    vi.stubEnv('VITE_QR_API_KEY', 'test-key');
  });

  it('targets POST /QR/create on the configured base', () => {
    const { url, init } = qrRequest('https://host/c/abc');
    expect(url).toBe('https://artqrcode.oxog.net/QR/create');
    expect(init.method).toBe('POST');
  });

  it('sends the ApiKey header and a JSON InputParameters body', () => {
    const { init } = qrRequest('https://host/c/abc');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', ApiKey: 'test-key' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      inputText: 'https://host/c/abc',
      exportPNG: true,
      exportWidth: 512,
      eccLevel: 'M',
    });
  });

  it('trims surrounding whitespace and trailing slashes from the base URL', () => {
    vi.stubEnv('VITE_QR_API_URL', '  https://artqrcode.oxog.net///  ');
    expect(qrRequest('x').url).toBe('https://artqrcode.oxog.net/QR/create');
  });

  it('throws when the base URL is not configured', () => {
    vi.stubEnv('VITE_QR_API_URL', '');
    expect(() => qrRequest('x')).toThrow(/VITE_QR_API_URL/);
  });

  it('throws when the API key is not configured', () => {
    vi.stubEnv('VITE_QR_API_KEY', '');
    expect(() => qrRequest('x')).toThrow(/VITE_QR_API_KEY/);
  });
});

describe('qrUrl against a stub server (real HTTP, fake provider)', () => {
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
    vi.stubEnv('VITE_QR_API_URL', base);
    vi.stubEnv('VITE_QR_API_KEY', 'test-key');
  });

  it('POSTs the link with the ApiKey header to /QR/create', async () => {
    reply = { status: 200, contentType: 'image/png', body: PNG };

    const res = await requestQr('https://host/c/abc');

    expect(res.status).toBe(200);
    const last = seen.at(-1);
    expect(last?.method).toBe('POST');
    expect(last?.headers.apikey).toBe('test-key'); // node lower-cases header names
    expect(JSON.parse(last?.body ?? '{}').inputText).toBe('https://host/c/abc');
  });

  it("rejects a 500 the way the provider currently answers (empty body, no content type)", async () => {
    await expect(qrUrl('https://host/c/abc')).rejects.toThrow(/HTTP 500 \(empty body\)/);
  });

  it('rejects a 200 until response parsing is implemented, rather than guessing the shape', async () => {
    reply = { status: 200, contentType: 'image/png', body: PNG };
    await expect(qrUrl('https://host/c/abc')).rejects.toThrow(/not implemented/);
  });
});
