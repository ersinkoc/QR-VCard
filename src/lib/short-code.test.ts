import { describe, expect, it } from 'vitest';
import { generateCode } from './short-code';

describe('generateCode', () => {
  const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  it('produces codes of the requested length from the unambiguous alphabet', () => {
    for (const len of [5, 7, 12]) {
      const code = generateCode(len);
      expect(code).toHaveLength(len);
      for (const ch of code) expect(ALPHABET).toContain(ch);
    }
  });

  it('is effectively collision-free over a realistic batch', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => generateCode()));
    expect(seen.size).toBe(5000);
  });
});
