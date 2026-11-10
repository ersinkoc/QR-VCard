import { describe, expect, it } from 'vitest';
import { PAGE_TEMPLATES, applyTemplate, backgroundLayers, designVars, readableOn, templateDesign, validateDesignConfig } from './page-design';

describe('page templates', () => {
  it('offers eight distinct templates that all pass the server’s strict check', () => {
    expect(PAGE_TEMPLATES).toHaveLength(8);
    const serialised = new Set<string>();
    for (const id of PAGE_TEMPLATES) {
      const design = templateDesign(id);
      expect(design.template).toBe(id);
      const check = validateDesignConfig(design);
      expect(check.error, `${id}: ${check.paths?.join(', ')}`).toBeNull();
      serialised.add(JSON.stringify({ ...design, template: '' }));
    }
    expect(serialised.size).toBe(8);
  });

  it('keeps the owner’s texts and custom blocks when switching template', () => {
    const start = templateDesign('porcelain');
    start.blocks = start.blocks.map((b) => (b.type === 'qr' ? { ...b, title: 'Beni kaydet' } : b));
    start.blocks.splice(2, 0, { id: 'menu', type: 'link', hidden: false, label: 'Menü', url: 'https://example.com/menu' });
    const next = applyTemplate(start, 'banner');
    expect(next.template).toBe('banner');
    expect(next.hero.layout).toBe('banner');
    expect(next.blocks.find((b) => b.type === 'qr')).toMatchObject({ title: 'Beni kaydet' });
    expect(next.blocks.find((b) => b.type === 'link')).toMatchObject({ id: 'menu', label: 'Menü' });
    // The contact style follows the new template.
    expect(next.blocks.find((b) => b.type === 'contacts')).toMatchObject({ style: 'tiles' });
    expect(validateDesignConfig(next).error).toBeNull();
  });
});

describe('design styling', () => {
  it('emits only validated colours, enums and sizes as CSS variables', () => {
    const vars = designVars(templateDesign('noir'), 'dark') as Record<string, string>;
    expect(vars['--pc-bg']).toMatch(/^#[0-9a-f]{6}$/);
    expect(vars['--pc-accent']).toBe('#d4af37');
    expect(vars['--pc-radius']).toBe('2px');
    for (const value of Object.values(vars)) expect(String(value)).not.toMatch(/url\(|;|\}/);
  });

  it('picks a readable text colour for the primary button', () => {
    expect(readableOn('#ffffff')).toBe('#111111');
    expect(readableOn('#191919')).toBe('#ffffff');
    expect(readableOn('#d4af37')).toBe('#111111');
  });

  it('falls back to a colour wash when an image background has no upload', () => {
    const palette = templateDesign('porcelain').theme.light;
    const bg = templateDesign('porcelain').hero.background;
    expect(backgroundLayers(bg, palette, null).base?.backgroundImage).toMatch(/^linear-gradient/);
    const withImage = backgroundLayers(bg, palette, '/api/public/cards/x/background?v=1');
    expect(withImage.base?.backgroundImage).toBe('url("/api/public/cards/x/background?v=1")');
    expect(withImage.veil?.opacity).toBe(0.76);
  });
});
