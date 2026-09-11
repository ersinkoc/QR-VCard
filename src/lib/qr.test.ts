import { describe, expect, it } from 'vitest';
import { qrDownloadUrl, qrImageUrl } from './qr';

describe('QR URLs', () => {
  it('point at the same-origin endpoint with only the code', () => {
    expect(qrImageUrl('abc123')).toBe('/api/qr/abc123');
    expect(qrDownloadUrl('abc123')).toBe('/api/qr/abc123?download=1');
  });

  it('encode the code, so it can never escape the path', () => {
    expect(qrImageUrl('a/../b')).toBe('/api/qr/a%2F..%2Fb');
  });

  it('supports style option for standard and art QR', () => {
    expect(qrImageUrl('demo', { style: 'standard' })).toBe('/api/qr/demo?style=standard');
    expect(qrDownloadUrl('demo', { style: 'standard' })).toBe('/api/qr/demo?download=1&style=standard');
  });
});
