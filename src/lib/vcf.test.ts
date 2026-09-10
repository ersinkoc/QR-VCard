import { describe, expect, it } from 'vitest';
import { buildVcf, fileNameFor } from './vcf';

describe('buildVcf', () => {
  it('uses CRLF line endings and includes required N/FN fields', () => {
    const vcf = buildVcf({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(vcf).toContain('BEGIN:VCARD\r\nVERSION:3.0\r\n');
    expect(vcf).toContain('N:Lovelace;Ada;;;');
    expect(vcf).toContain('FN:Ada Lovelace');
    expect(vcf.endsWith('END:VCARD\r\n')).toBe(true);
  });

  it('escapes commas, semicolons, backslashes and newlines', () => {
    const vcf = buildVcf({
      firstName: 'A,B;C\nD',
      note: 'line1\nline2, x; y',
    });
    expect(vcf).toContain('FN:A\\,B\\;C\\nD');
    expect(vcf).toContain('NOTE:line1\\nline2\\, x\\; y');
  });

  it('omits empty fields and falls back to a generic FN', () => {
    const vcf = buildVcf({});
    expect(vcf).toContain('FN:Contact');
    expect(vcf).not.toContain('TEL');
    expect(vcf).not.toContain('EMAIL');
    expect(vcf).not.toContain('ORG');
  });

  it('joins name parts and sanitizes the download filename', () => {
    expect(fileNameFor({ firstName: 'Ada', lastName: 'Lovelace' })).toBe('Ada-Lovelace.vcf');
    expect(fileNameFor({ firstName: 'Zoë & Co!' })).toBe('Zo--Co.vcf');
    expect(fileNameFor({})).toBe('contact.vcf');
  });
});
