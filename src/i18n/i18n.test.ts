import { describe, expect, it } from 'vitest';
import { dictionaries, lookup, translate } from './index';

function keys(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

// Every source file, as text, to find the translation keys it uses.
const sources = import.meta.glob(['../**/*.tsx', '../**/*.ts', '!../**/*.test.ts', '!../i18n/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('dictionaries', () => {
  it('Turkish and English carry exactly the same keys', () => {
    expect(keys(dictionaries.en).sort()).toEqual(keys(dictionaries.tr).sort());
  });

  it('every placeholder in Turkish exists in English too', () => {
    for (const key of keys(dictionaries.tr)) {
      const vars = (s: string | undefined) => [...(s ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(vars(lookup(dictionaries.en, key)), key).toEqual(vars(lookup(dictionaries.tr, key)));
    }
  });

  it('every literal t("…") key used in the app exists', () => {
    const used = new Set<string>();
    for (const text of Object.values(sources)) {
      for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z_]+\.[a-zA-Z_.]+)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(50);
    const missing = [...used].filter((k) => lookup(dictionaries.tr, k) === undefined);
    expect(missing).toEqual([]);
  });

  it('interpolates variables and falls back to the key', () => {
    expect(translate('en', 'users.cardCount', { count: 3 })).toBe('3 cards');
    expect(translate('tr', 'users.cardCount', { count: 3 })).toBe('3 kart');
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });
});
