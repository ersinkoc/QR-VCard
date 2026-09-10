import { afterEach, describe, expect, it, vi } from 'vitest';
import { externalQrUrl, qrUrl } from './qr';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('externalQrUrl', () => {
  it('appends data=<encoded> to a plain base URL', () => {
    vi.stubEnv('VITE_QR_API_URL', 'https://qr.example.com/gen');
    expect(externalQrUrl('https://host/c/abc')).toBe('https://qr.example.com/gen?data=https%3A%2F%2Fhost%2Fc%2Fabc');
  });

  it('uses & when the base URL already carries a query string', () => {
    vi.stubEnv('VITE_QR_API_URL', 'https://qr.example.com/gen?size=512');
    expect(externalQrUrl('a b')).toBe('https://qr.example.com/gen?size=512&data=a%20b');
  });

  it('substitutes a {data} placeholder without dropping other params', () => {
    vi.stubEnv('VITE_QR_API_URL', 'https://qr.example.com/make?text={data}&format=png');
    expect(externalQrUrl('https://host/c/a b')).toBe(
      'https://qr.example.com/make?text=https%3A%2F%2Fhost%2Fc%2Fa%20b&format=png',
    );
  });

  it('ignores surrounding whitespace in the configured URL', () => {
    vi.stubEnv('VITE_QR_API_URL', '  https://qr.example.com/gen  ');
    expect(externalQrUrl('x')).toBe('https://qr.example.com/gen?data=x');
  });

  it('throws when the endpoint is not configured', () => {
    vi.stubEnv('VITE_QR_API_URL', '');
    expect(() => externalQrUrl('https://host/c/abc')).toThrow(/VITE_QR_API_URL/);
  });
});

describe('qrUrl', () => {
  it('resolves to the API URL (async contract kept for future POST-based APIs)', async () => {
    vi.stubEnv('VITE_QR_API_URL', 'https://qr.example.com/gen');
    await expect(qrUrl('https://host/c/abc')).resolves.toBe(
      'https://qr.example.com/gen?data=https%3A%2F%2Fhost%2Fc%2Fabc',
    );
  });

  it('rejects when misconfigured, so callers can show a failure state', async () => {
    vi.stubEnv('VITE_QR_API_URL', '');
    await expect(qrUrl('https://host/c/abc')).rejects.toThrow(/VITE_QR_API_URL/);
  });
});
