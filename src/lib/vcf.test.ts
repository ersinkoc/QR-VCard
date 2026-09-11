import { describe, expect, it } from 'vitest';
import { buildVcf, contactFromCard, fileNameFor, fold } from './vcf';

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

  it('names an organization-only card after the organization', () => {
    expect(buildVcf({ organization: 'Acme' })).toContain('FN:Acme');
  });

  it('embeds a photo as folded base64', () => {
    const base64 = 'A'.repeat(300);
    const vcf = buildVcf({ firstName: 'Ada', photo: { base64, type: 'JPEG' } });
    const lines = vcf.split('\r\n');
    const start = lines.findIndex((l) => l.startsWith('PHOTO;ENCODING=b;TYPE=JPEG:'));
    expect(start).toBeGreaterThan(0);
    expect(lines.every((l) => l.length <= 75)).toBe(true);
    // Unfolding (CRLF + space removed) restores the exact value.
    expect(vcf.replace(/\r\n /g, '')).toContain(`PHOTO;ENCODING=b;TYPE=JPEG:${base64}`);
  });
});

describe('fold', () => {
  it('leaves short lines alone', () => {
    expect(fold('NOTE:short')).toBe('NOTE:short');
  });
});

describe('contactFromCard', () => {
  it('maps every API field — name, organization and title included', () => {
    const vcf = buildVcf(
      contactFromCard({
        first_name: 'Ada',
        last_name: 'Lovelace',
        organization: 'Analytical Engines',
        job_title: 'Mathematician',
        phone: '+44 20',
        email: 'ada@example.com',
        website: 'https://example.com',
        address: 'London',
        note: null,
      }),
    );
    expect(vcf).toContain('N:Lovelace;Ada;;;');
    expect(vcf).toContain('ORG:Analytical Engines');
    expect(vcf).toContain('TITLE:Mathematician');
    expect(vcf).toContain('TEL;TYPE=CELL:+44 20');
  });
});

describe('fileNameFor', () => {
  it('joins name parts and sanitizes the download filename', () => {
    expect(fileNameFor({ firstName: 'Ada', lastName: 'Lovelace' })).toBe('Ada-Lovelace.vcf');
    expect(fileNameFor({ firstName: 'Zoë & Co!' })).toBe('Zoe--Co.vcf');
    expect(fileNameFor({})).toBe('contact.vcf');
  });

  it('keeps Turkish names readable instead of dropping letters', () => {
    expect(fileNameFor({ firstName: 'Şükrü', lastName: 'Işık' })).toBe('Sukru-Isik.vcf');
    expect(fileNameFor({ firstName: 'İlkay', lastName: 'Çağlar' })).toBe('Ilkay-Caglar.vcf');
  });
});
