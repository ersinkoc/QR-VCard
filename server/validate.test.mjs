import { describe, expect, it } from 'vitest';
import { normalizeSocial, validateCardInput } from './validate.mjs';

describe('normalizeSocial', () => {
  it('builds the canonical URL from a bare handle', () => {
    expect(normalizeSocial('instagram', '@ada')).toBe('https://www.instagram.com/ada/');
    expect(normalizeSocial('instagram', 'ada.lovelace_x')).toBe('https://www.instagram.com/ada.lovelace_x/');
    expect(normalizeSocial('telegram', '@ada')).toBe('https://t.me/ada');
    expect(normalizeSocial('linkedin', 'ada-lovelace')).toBe('https://www.linkedin.com/in/ada-lovelace');
  });

  it('builds wa.me from a bare phone number', () => {
    expect(normalizeSocial('whatsapp', '+90 555 000 00 00')).toBe('https://wa.me/905550000000');
    expect(normalizeSocial('whatsapp', '905550000000')).toBe('https://wa.me/905550000000');
  });

  it('normalises full profile URLs, http included', () => {
    expect(normalizeSocial('linkedin', 'https://www.linkedin.com/in/ada-lovelace/')).toBe('https://www.linkedin.com/in/ada-lovelace');
    expect(normalizeSocial('linkedin', 'http://tr.linkedin.com/in/ada')).toBe('https://www.linkedin.com/in/ada');
    expect(normalizeSocial('instagram', 'https://instagram.com/ada')).toBe('https://www.instagram.com/ada/');
    expect(normalizeSocial('telegram', 'https://t.me/ada')).toBe('https://t.me/ada');
    expect(normalizeSocial('whatsapp', 'https://wa.me/905550000000')).toBe('https://wa.me/905550000000');
  });

  it('keeps non-profile linkedin paths intact (company, school)', () => {
    expect(normalizeSocial('linkedin', 'https://www.linkedin.com/company/acme/')).toBe('https://www.linkedin.com/company/acme');
  });

  it('refuses wrong networks and junk', () => {
    expect(normalizeSocial('instagram', 'https://facebook.com/ada')).toMatch(/^invalid_/);
    expect(normalizeSocial('telegram', 'https://instagram.com/ada')).toMatch(/^invalid_/);
    expect(normalizeSocial('linkedin', 'nota-handle!')).toMatch(/^invalid_/);
    expect(normalizeSocial('whatsapp', '12345')).toMatch(/^invalid_/); // too short
    expect(normalizeSocial('instagram', 'https://instagram.com/ada?utm=x')).toMatch(/^invalid_/);
    expect(normalizeSocial('telegram', 'https://t.me/joinchat/ABC')).toMatch(/^invalid_/);
    expect(normalizeSocial('instagram', 'ftp://instagram.com/ada')).toMatch(/^invalid_/);
  });

  it('round-trips its own canonical output', () => {
    for (const [field, url] of [
      ['linkedin', 'https://www.linkedin.com/in/ada-lovelace'],
      ['instagram', 'https://www.instagram.com/ada/'],
      ['whatsapp', 'https://wa.me/905550000000'],
      ['telegram', 'https://t.me/ada'],
    ]) {
      expect(normalizeSocial(field, url)).toBe(url);
    }
  });
});

describe('validateCardInput social fields', () => {
  it('stores canonical https URLs from handle input', () => {
    const { data, errors } = validateCardInput({ first_name: 'Ada', instagram: '@ada', whatsapp: '+90 555 000 00 00' });
    expect(errors).toEqual({});
    expect(data.instagram).toBe('https://www.instagram.com/ada/');
    expect(data.whatsapp).toBe('https://wa.me/905550000000');
  });

  it('reports per-network error codes and never keeps a non-canonical value', () => {
    const { data, errors } = validateCardInput({ linkedin: 'https://facebook.com/ada', telegram: 'bad handle!' }, { partial: true });
    expect(errors.linkedin).toBe('invalid_linkedin');
    expect(errors.telegram).toBe('invalid_telegram');
    expect(data.linkedin).toBeUndefined();
    expect(data.telegram).toBeUndefined();
  });

  it('leaves the fields untouched when absent and accepts null resets', () => {
    const { data, errors } = validateCardInput({ first_name: 'Ada', instagram: null });
    expect(errors).toEqual({});
    expect(data.instagram).toBeNull();
    expect('linkedin' in data).toBe(false);
  });
});
