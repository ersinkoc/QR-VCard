import { describe, expect, it } from 'vitest';
import { CARD_DESIGNS, CARD_DESIGN_IDS } from './card-designs';

describe('card template catalog', () => {
  it('contains thirty unique, persistence-safe templates', () => {
    expect(CARD_DESIGNS).toHaveLength(30);
    expect(new Set(CARD_DESIGN_IDS).size).toBe(30);
    expect(CARD_DESIGNS.every((design) => /^[a-z][a-z0-9-]{0,15}$/.test(design.id))).toBe(true);
  });

  it('keeps every template discoverable and visually previewable', () => {
    for (const design of CARD_DESIGNS) {
      expect(design.label.length).toBeGreaterThan(2);
      expect(design.family.length).toBeGreaterThan(2);
      expect(design.swatch).toMatch(/gradient/);
    }
  });
});
