import { describe, expect, it } from 'vitest';
import { normalizeSignature, validateSignatureConfig } from '../../server/signature-config.mjs';
import type { SignatureData } from './signature';
import { checkCustomHtml, CUSTOM_HTML_STARTER, GMAIL_SIGNATURE_LIMIT, layoutToCustomHtml, renderSignature, SIGNATURE_TEMPLATES, signatureText, templateSignature as baseTemplate } from './signature';

/** Every template, the free-HTML one seeded with its starter markup. */
const templateSignature = (t?: (typeof SIGNATURE_TEMPLATES)[number], keep = {}) => ({ ...baseTemplate(t, keep), ...(t === 'custom' ? { customHtml: CUSTOM_HTML_STARTER } : {}) });

const full: SignatureData = {
  name: 'Ayşe Gül YILMAZ',
  title: 'Chief Mathematician',
  organization: 'Analytical Engines Ltd',
  phone: '+90 555 000 00 00',
  email: 'ayse@example.com',
  website: 'https://example.com/ayse',
  address: 'Büyükdere Cad. No:1\nLevent / İstanbul',
  socials: [
    { key: 'linkedin', url: 'https://www.linkedin.com/in/ayse' },
    { key: 'instagram', url: 'https://www.instagram.com/ayse/' },
    { key: 'whatsapp', url: 'https://wa.me/905550000000' },
    { key: 'telegram', url: 'https://t.me/ayse' },
  ],
  cardUrl: 'https://cards.example.com/c/ayse',
  accent: '#2457f5',
  photo: { src: 'https://cards.example.com/api/public/cards/ayse/photo?format=jpg&v=1', width: 96, height: 96 },
  logo: { src: 'https://cards.example.com/api/public/cards/ayse/logo?format=jpg&v=2', width: 138, height: 46 },
  qr: { src: 'https://cards.example.com/api/qr/ayse', width: 88, height: 88 },
};
const empty: SignatureData = { ...full, title: null, organization: null, phone: null, email: null, website: null, address: null, socials: [], photo: null, logo: null, qr: null };
const XSS = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
const hostile: SignatureData = {
  ...full,
  name: XSS,
  title: XSS,
  organization: XSS,
  phone: XSS,
  email: XSS,
  address: XSS,
  website: `javascript:alert(1)//${XSS}`,
  socials: [{ key: 'linkedin', url: `javascript:alert(1)` }],
  cardUrl: 'https://cards.example.com/c/x',
};

/** Every option on: the heaviest signature a template can produce. */
const loaded = (template: (typeof SIGNATURE_TEMPLATES)[number]) => ({
  ...templateSignature(template),
  size: 'l' as const,
  logo: true,
  fields: ['phone', 'email', 'website', 'address'] as ('phone' | 'email' | 'website' | 'address')[],
  labels: 'full' as const,
  social: 'badges' as const,
  qr: true,
  cta: true,
  ctaText: XSS.slice(0, 40),
  disclaimer: `${XSS} `.repeat(10).slice(0, 600),
  tagline: XSS.slice(0, 80),
  extraLabel: XSS.slice(0, 30),
  extraUrl: 'https://cal.example.com/ayse',
  spacing: 'relaxed' as const,
  nameColor: 'accent' as const,
});

describe('signature renderer', () => {
  for (const template of SIGNATURE_TEMPLATES) {
    describe(template, () => {
      for (const [label, data] of [['full card', full], ['nearly empty card', empty]] as const) {
        it(`stays email-safe for a ${label}`, () => {
          for (const design of [templateSignature(template), loaded(template)]) {
            const html = renderSignature(design, data);
            expect(html.length).toBeLessThan(GMAIL_SIGNATURE_LIMIT);
            expect(html).not.toMatch(/<svg|data:|display:\s*(flex|grid)|position:|margin/i);
            expect(html.startsWith('<table')).toBe(true);
            for (const tag of html.match(/<img\b[^>]*>/g) ?? []) {
              expect(tag).toMatch(/\swidth="\d+"/);
              expect(tag).toMatch(/\sheight="\d+"/);
            }
            for (const m of html.matchAll(/\s(?:src|href)="([^"]*)"/g)) expect(m[1]).toMatch(/^(https:\/\/|mailto:|tel:)/);
            expect(html).toContain('Ayşe Gül YILMAZ');
          }
        });
      }

      it('escapes everything a card or the design can carry', () => {
        const html = renderSignature(loaded(template), hostile);
        // Hostile text survives only as escaped text: no raw tag, no handler inside a tag, no script URL in a link.
        // Attribute values are quoted and escaped (no `"` inside), so blanking them leaves only real markup.
        const markup = html.replace(/"[^"]*"/g, '""');
        expect(markup).not.toMatch(/<img src=x|<script|<[^>]*\son\w+=/i);
        expect(html).not.toMatch(/(?:href|src)="\s*javascript:/i);
        // A malformed email or phone is shown, never linked.
        expect(html).not.toMatch(/href="(?:mailto|tel):[^"]*&lt;/);
        expect(html).toContain('&lt;img src=x');
      });
    });
  }

  it('shows only the chosen social profiles, the tagline and an https extra link', () => {
    const design = { ...templateSignature('classic'), social: 'text' as const, socials: ['linkedin' as const], tagline: 'Yaratıcı çözümler', extraLabel: 'Randevu al', extraUrl: 'https://cal.example.com/ayse' };
    const html = renderSignature(design, full);
    expect(html).toContain('LinkedIn');
    expect(html).not.toContain('Instagram');
    expect(html).toContain('Yaratıcı çözümler');
    expect(html).toContain('href="https://cal.example.com/ayse"');
    // A non-https target never becomes a link, even if it slipped past validation.
    expect(renderSignature({ ...design, extraUrl: 'http://cal.example.com' }, full)).not.toContain('Randevu al');
  });

  it('drops images, QR and the second logo when the design turns them off', () => {
    const html = renderSignature({ ...templateSignature('classic'), image: 'none', logo: false, qr: false }, full);
    expect(html).not.toContain('<img');
  });

  it('uses the language of the signature for labels and the button, not the panel', () => {
    const base = { ...templateSignature('corporate'), labels: 'full' as const, cta: true };
    expect(renderSignature({ ...base, lang: 'tr' }, full)).toContain('Telefon');
    expect(renderSignature({ ...base, lang: 'tr' }, full)).toContain('Dijital kartvizitim');
    expect(renderSignature({ ...base, lang: 'en' }, full)).toContain('Phone');
    expect(renderSignature({ ...base, lang: 'en' }, full)).toContain('My digital card');
  });

  it('writes a plain-text version with the card link', () => {
    const text = signatureText(templateSignature('classic'), full);
    expect(text.split('\n')[0]).toBe('Ayşe Gül YILMAZ');
    expect(text).toContain('example.com/ayse');
    expect(text).toContain(full.cardUrl);
  });
});

describe('signature document', () => {
  it('keeps content choices when the template changes and fills the rest from the preset', () => {
    const before = { ...templateSignature('classic'), fields: ['email' as const], disclaimer: 'Gizlidir.', lang: 'en' as const, image: 'none' as const };
    const after = templateSignature('corporate', before);
    expect(after).toMatchObject({ template: 'corporate', fields: ['email'], disclaimer: 'Gizlidir.', lang: 'en', image: 'logo' });
  });

  it('validates writes strictly', () => {
    expect(validateSignatureConfig(null)).toEqual({ value: null, error: null });
    expect(validateSignatureConfig(templateSignature('banner')).error).toBeNull();
    for (const bad of [{ extraUrl: 'http://x.example' }, { extraUrl: 'javascript:alert(1)' }, { socials: ['facebook'] }, { spacing: 'huge' }, { tagline: 'x'.repeat(81) }, { template: 'fancy' }, { accent: 'red' }, { fields: ['phone', 'phone'] }, { fields: ['fax'] }, { qr: 'yes' }, { disclaimer: 'x'.repeat(601) }, { ctaText: 'x'.repeat(41) }, { font: 'comic' }]) {
      expect(validateSignatureConfig({ ...templateSignature(), ...bad }).error, JSON.stringify(bad)).toBe('invalid');
    }
    expect(validateSignatureConfig({ customHtml: 'x'.repeat(15000) }).error).toBe('too_long');
  });

  it('reads stored documents leniently, filling missing keys', () => {
    expect(normalizeSignature({ template: 'minimal' }).value).toMatchObject({ template: 'minimal', image: 'none', lang: 'tr' });
  });
});

describe('free HTML signatures', () => {
  it('accepts the starter and plain email markup with tokens and sections', () => {
    expect(checkCustomHtml(CUSTOM_HTML_STARTER)).toBeNull();
    expect(checkCustomHtml('<table><tr><td style="color:{{accent}}">{{#phone}}<a href="{{phoneHref}}">{{phone}}</a>{{/phone}}</td></tr></table>')).toBeNull();
  });

  it('refuses anything active, foreign or able to smuggle CSS', () => {
    const refused: [string, string][] = [
      ['<script>alert(1)</script>', 'tag'], ['<x:script>', 'tag'], ['<iframe src="https://x"></iframe>', 'tag'], ['<style>a{}</style>', 'tag'], ['<svg></svg>', 'tag'], ['<form></form>', 'tag'],
      ['<img src="https://a.example/c.png" onload="x()">', 'event'], ['<a href="javascript:alert(1)">x</a>', 'href'], ['<a href="jav&#x61;script:alert(1)">x</a>', 'href'],
      ['<img src="http://a.example/c.png">', 'src'], ['<img src="{{name}}">', 'src'], ['<div style="background:url(https://x)">a</div>', 'style'], ['<div style="background:&#117;rl(x)">a</div>', 'entity'],
      ['<div style="color:{{title}}">a</div>', 'style_token'], ['<a title="{{photo}}">a</a>', 'image_token'], ['<!--[if mso]><b>x</b><![endif]-->', 'comment'], ['<div class="x">a</div>', 'attribute'],
      ['<b><i>x</b></i>', 'nesting'], ['{{password}}', 'unknown_token'], ['{{#phone}}x', 'section'], ['<a href="https://x"title="y">a</a>', 'markup'], ['<img src="https://x/a.png" / onerror=alert(1)>', 'markup'], ['a < b', 'markup'],
    ];
    for (const [html, code] of refused) expect(checkCustomHtml(html)?.code, html).toBe(code);
    expect(checkCustomHtml('x'.repeat(8001))?.code).toBe('too_long');
  });

  it('fills tokens escaped, drops empty sections and never renders refused markup', () => {
    const design = { ...baseTemplate('custom'), customHtml: '<b>{{name}}</b>{{#address}}<i>{{address}}</i>{{/address}}{{photo}}' };
    const html = renderSignature(design, { ...empty, name: '<img src=x onerror=1>' });
    expect(html).toBe('<b>&lt;img src=x onerror=1&gt;</b>');
    expect(renderSignature(design, full)).toContain('<img src="https://cards.example.com/api/public/cards/ayse/photo');
    expect(renderSignature({ ...design, customHtml: '<script>alert(1)</script>' }, full)).toBe('');
  });

  it('is stored only when the checker accepts it', () => {
    expect(validateSignatureConfig({ ...baseTemplate('custom'), customHtml: CUSTOM_HTML_STARTER }).error).toBeNull();
    expect(validateSignatureConfig({ ...baseTemplate('custom'), customHtml: '<a href="javascript:x">x</a>' }).error).toBe('invalid');
  });
});

describe('layout → free HTML', () => {
  it('turns every ready-made layout into valid token HTML that renders the very same signature', () => {
    for (const t of SIGNATURE_TEMPLATES.filter((x) => x !== 'custom')) {
      const design = { ...baseTemplate(t), qr: true, cta: true, fields: ['phone', 'email', 'website', 'address'] as ('phone' | 'email' | 'website' | 'address')[], disclaimer: 'Gizlidir.' };
      const html = layoutToCustomHtml(design, full);
      expect(checkCustomHtml(html), t).toBeNull();
      expect(html).not.toContain('QRVMARK');
      expect(renderSignature({ ...baseTemplate('custom'), customHtml: html }, full).replace(/\n/g, ''), t).toBe(renderSignature(design, full));
    }
  });
});
