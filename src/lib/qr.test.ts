import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadQr, qrRequest, qrUrl, requestQr } from './qr';

// 1x1 PNG — stands in for the provider's raw image bytes.
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

  it('sends the COMPLETE InputParameters body the provider requires', () => {
    const body = JSON.parse(String(qrRequest('https://host/c/abc').init.body));

    expect(body).toMatchObject({
      inputText: 'https://host/c/abc',
      exportWidth: 1000,
      exportPNG: true,
      eccLevel: 'H',
      shapeName: 'One',
    });

    // Regression lock: a partial body — `inputText` alone, or one missing the
    // premium colour fields — makes the provider answer a bare 500 (verified
    // against the live API). Every nested object must stay complete.
    expect(body.colorParameters).toMatchObject({
      premiumFiveFirst: '000000',
      premiumCrossFourth: '888888',
      background: 'ffffff',
      useRandomColors: false,
    });
    expect(body.eyeParameters).toMatchObject({ eyeFrameType: 'Square', eyeBallType: 'Circle', randomEyeFrame: false });
    expect(body.gradientParameters).toMatchObject({ linearGradient: false, gradientColorFirstHex: 'ff0000' });
    expect(body.logoParameters).toMatchObject({ logoName: 'empty', logoBackgroundColorHexFormat: '' });
    expect(body.premiumParameters).toMatchObject({ five: true, cross: true, vertical: true });
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

  it('resolves to a blob: URL carrying the provider PNG', async () => {
    reply = { status: 200, contentType: 'image/png', body: PNG };

    const src = await qrUrl('https://host/c/abc');

    expect(src.startsWith('blob:')).toBe(true);
    const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    URL.revokeObjectURL(src);
  });

  it('surfaces a provider 500 passed through the proxy (empty body, no content type)', async () => {
    await expect(qrUrl('https://host/c/abc')).rejects.toThrow(/HTTP 500 \(empty body\)/);
  });

  it('reports a missing proxy route when the origin answers with the SPA shell', async () => {
    reply = {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from('<!doctype html><html><body>app</body></html>'),
    };
    await expect(qrUrl('https://host/c/abc')).rejects.toThrow(/returned HTML.*no route handled/);
  });

  it('rejects a 200 that is not an image, and says what it got', async () => {
    reply = { status: 200, contentType: 'application/json', body: Buffer.from('{"url":"https://cdn.example/qr.png"}') };
    await expect(qrUrl('https://host/c/abc')).rejects.toThrow(/expected raw image bytes/);
  });

  it('mints a distinct blob URL per call, so each caller owns its own', async () => {
    reply = { status: 200, contentType: 'image/png', body: PNG };

    const first = await qrUrl('https://host/c/abc');
    const second = await qrUrl('https://host/c/abc');

    // This is why downloadQr may safely revoke the URL it created: QrDisplay's
    // URL comes from a different qrUrl() call and is revoked by QrDisplay.
    expect(first).not.toBe(second);
    URL.revokeObjectURL(first);
    URL.revokeObjectURL(second);
  });

  it('downloads straight from the blob URL without minting a second one', async () => {
    reply = { status: 200, contentType: 'image/png', body: PNG };

    const anchors: { href: string; download: string; clicked: boolean }[] = [];
    vi.stubGlobal('document', {
      createElement: () => {
        const a = {
          href: '',
          download: '',
          clicked: false,
          click() {
            this.clicked = true;
          },
        };
        anchors.push(a);
        return a;
      },
    });
    const created = vi.spyOn(URL, 'createObjectURL');

    await downloadQr('https://host/c/abc', 'qr-abc.png');

    expect(anchors).toHaveLength(1);
    expect(anchors[0].href.startsWith('blob:')).toBe(true);
    expect(anchors[0].download).toBe('qr-abc.png');
    expect(anchors[0].clicked).toBe(true);
    // Regression lock: the old implementation fetched the blob URL and wrapped
    // it in a SECOND object URL, which retained the PNG for the page's life.
    expect(created).toHaveBeenCalledTimes(1);
  });
});
