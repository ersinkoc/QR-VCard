import { describe, expect, it } from 'vitest';
import { DESIGN_MAX_BLOCKS, defaultDesign, normalizeDesign, resolveDesign, validateDesignConfig } from './design-config.mjs';

describe('design config', () => {
  it('accepts the default document unchanged', () => {
    const d = defaultDesign();
    expect(validateDesignConfig(d)).toEqual({ value: d, error: null });
  });

  it('fills missing keys with defaults and drops unknown ones', () => {
    const { value, errors } = normalizeDesign({ theme: { radius: 4, evil: 'x' }, junk: true });
    expect(errors).toEqual([]);
    expect(value.theme.radius).toBe(4);
    expect(value.theme.font).toBe('onest');
    expect(value).not.toHaveProperty('junk');
    expect(value.theme).not.toHaveProperty('evil');
  });

  it('clears with null or an empty string', () => {
    expect(validateDesignConfig(null)).toEqual({ value: null, error: null });
    expect(validateDesignConfig('')).toEqual({ value: null, error: null });
  });

  it('never lets CSS or URLs into style values', () => {
    for (const bad of [
      { theme: { light: { accent: 'red;background:url(https://evil.example/x)' } } },
      { theme: { light: { bg: 'url(x)' } } },
      { hero: { background: { kind: 'image', color: '#fff' } } },
      { hero: { background: { angle: '45deg' } } },
      { theme: { font: "Arial'; }" } },
      { theme: { radius: 999 } },
      { avatar: { size: 4 } },
    ]) {
      expect(validateDesignConfig(bad).error).toBe('invalid');
    }
  });

  it('lowercases colours and rounds integers', () => {
    const { value } = validateDesignConfig({ theme: { light: { accent: '#ABCDEF' }, radius: 7.6 } });
    expect(value.theme.light.accent).toBe('#abcdef');
    expect(value.theme.radius).toBe(8);
  });

  it('only accepts https link targets', () => {
    const link = (url) => validateDesignConfig({ blocks: [{ id: 'l1', type: 'link', label: 'Go', url }] });
    expect(link('example.com/menu').value.blocks[0].url).toBe('https://example.com/menu');
    expect(link('').value.blocks[0].url).toBe('');
    for (const url of ['javascript:alert(1)', 'http://example.com', 'https://user:pw@example.com', 'data:text/html,x', 'https://localhost']) {
      expect(link(url).error).toBe('invalid');
    }
  });

  it('cleans text: control characters out, single-line fields flattened', () => {
    const { value } = validateDesignConfig({
      blocks: [
        { id: 'h', type: 'header', tag: ' Dijital\nKartvizit\u0007 ' },
        { id: 't', type: 'text', title: 'Hi', body: 'line 1\nline 2' },
      ],
    });
    expect(value.blocks[0].tag).toBe('Dijital Kartvizit');
    expect(value.blocks[1].body).toBe('line 1\nline 2');
  });

  it('rejects bad block lists', () => {
    expect(validateDesignConfig({ blocks: 'x' }).error).toBe('invalid');
    expect(validateDesignConfig({ blocks: [{ type: 'iframe' }] }).error).toBe('invalid');
    expect(validateDesignConfig({ blocks: [{ id: 'a', type: 'hero' }, { id: 'b', type: 'hero' }] }).error).toBe('invalid');
    expect(validateDesignConfig({ blocks: [{ id: 'a', type: 'text' }, { id: 'a', type: 'text' }] }).error).toBe('invalid');
    expect(validateDesignConfig({ blocks: [{ id: 'a', type: 'contacts', fields: ['phone', 'phone'] }] }).error).toBe('invalid');
    expect(validateDesignConfig({ blocks: Array.from({ length: DESIGN_MAX_BLOCKS + 1 }, (_, i) => ({ id: `d${i}`, type: 'divider' })) }).error).toBe('invalid');
  });

  it('caps the serialised size', () => {
    expect(validateDesignConfig({ blocks: [], filler: 'x'.repeat(20000) }).error).toBe('too_long');
  });

  it('resolves stored values, including JSON strings, leniently', () => {
    expect(resolveDesign(null)).toBeNull();
    expect(resolveDesign('not json')).toBeNull();
    expect(resolveDesign(JSON.stringify({ theme: { radius: 3 } })).theme.radius).toBe(3);
    // A value an older client stored badly still renders (bad key → default).
    expect(resolveDesign({ theme: { radius: 'big' } }).theme.radius).toBe(12);
  });
});
