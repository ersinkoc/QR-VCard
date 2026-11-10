/**
 * Email signatures: the studio's document (server/signature-config.mjs) turned
 * into HTML that survives Gmail, Outlook and Apple Mail.
 *
 * Mail clients are hostile to modern CSS, so the output is deliberately old
 * school: nested tables, inline styles on every text cell (Outlook does not
 * inherit fonts), `bgcolor` next to `background-color`, numeric `width` /
 * `height` attributes on every image, no SVG, no web fonts, no flex/grid, no
 * margins, no data: URIs. Gmail caps a signature at 10,000 characters, so
 * style strings stay short.
 *
 * Every value from the card is HTML-escaped; colours come only from validated
 * `#rrggbb` values and URLs only as http(s), mailto: or tel:.
 */
import { checkCustomHtml } from '../../server/signature-config.mjs';
import type { SignatureDesign, SignatureField, SignatureFont, SignatureLang, SignatureToken } from '../../server/signature-config.mjs';

export type { SignatureDesign, SignatureField, SignatureTemplate } from '../../server/signature-config.mjs';
export { checkCustomHtml, CUSTOM_HTML_MAX, CUSTOM_HTML_STARTER, normalizeSignature, resolveSignature, SIGNATURE_TEMPLATES, SIGNATURE_TOKENS, templateSignature } from '../../server/signature-config.mjs';

export const GMAIL_SIGNATURE_LIMIT = 10000;

export interface SignatureImage {
  src: string;
  width: number;
  height: number;
}

/** What a signature says, already resolved from the card (and its institution). */
export interface SignatureData {
  name: string;
  /** Spelled by the card's rule ("Ayşe Gül", "YILMAZ"); for the free-HTML tokens. */
  firstName?: string | null;
  lastName?: string | null;
  title: string | null;
  organization: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  socials: { key: 'linkedin' | 'instagram' | 'whatsapp' | 'telegram'; url: string }[];
  cardUrl: string;
  /** The card's own accent, used when the design does not set one. */
  accent: string;
  photo: SignatureImage | null;
  logo: SignatureImage | null;
  qr: SignatureImage | null;
}

const FONT_STACKS: Record<SignatureFont, string> = {
  arial: 'Arial,Helvetica,sans-serif',
  helvetica: 'Helvetica,Arial,sans-serif',
  verdana: 'Verdana,Geneva,sans-serif',
  tahoma: 'Tahoma,Verdana,sans-serif',
  trebuchet: "'Trebuchet MS',Arial,sans-serif",
  georgia: 'Georgia,serif',
  times: "'Times New Roman',Times,serif",
};

/** Name / body / small text sizes, image edge, logo height, QR edge. */
const SIZES = {
  s: { name: 15, body: 12, small: 10, photo: 64, logo: 30, qr: 64 },
  m: { name: 18, body: 13, small: 11, photo: 80, logo: 38, qr: 76 },
  l: { name: 21, body: 14, small: 12, photo: 96, logo: 46, qr: 88 },
} as const;

const WORDS: Record<SignatureLang, { phone: string; email: string; website: string; address: string; cta: string }> = {
  tr: { phone: 'Telefon', email: 'E-posta', website: 'Web', address: 'Adres', cta: 'Dijital kartvizitim' },
  en: { phone: 'Phone', email: 'Email', website: 'Web', address: 'Address', cta: 'My digital card' },
};
const SHORT: Record<SignatureField, string> = { phone: 'T', email: 'E', website: 'W', address: 'A' };
const SOCIAL_NAMES = { linkedin: 'LinkedIn', instagram: 'Instagram', whatsapp: 'WhatsApp', telegram: 'Telegram' } as const;
const SOCIAL_BADGES = { linkedin: 'in', instagram: 'IG', whatsapp: 'WA', telegram: 'TG' } as const;

const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Only links a recipient can safely click: web, mail and phone. */
function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = url.trim();
  if (/^https?:\/\//i.test(s) || /^mailto:/i.test(s) || /^tel:/i.test(s)) return s;
  return null;
}

const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;
const stripScheme = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/$/, '');

/** `#rrggbb` → readable text colour on it (white or ink). */
function onColor(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 165 ? INK : '#ffffff';
}

/** Line height and the multiplier applied to vertical gaps, per spacing choice. */
const SPACING = { compact: { lh: 1.3, sp: 0.6 }, normal: { lh: 1.45, sp: 1 }, relaxed: { lh: 1.65, sp: 1.45 } } as const;

interface Ctx {
  lh: number;
  sp: number;
  d: SignatureDesign;
  data: SignatureData;
  accent: string;
  on: string;
  font: string;
  sz: (typeof SIZES)[keyof typeof SIZES];
  words: (typeof WORDS)['tr'];
}

/** A text cell's inline style: font on every cell, because Outlook does not inherit it. */
const ts = (c: Ctx, size: number, color = INK, extra = '') => `font-family:${c.font};font-size:${size}px;line-height:${c.lh};color:${color};${extra}`;

function img(c: Ctx, image: SignatureImage, alt: string, round: boolean) {
  const radius = !round ? '' : c.d.shape === 'circle' ? 'border-radius:50%;' : c.d.shape === 'rounded' ? 'border-radius:10px;' : '';
  return `<img src="${escapeHtml(image.src)}" width="${image.width}" height="${image.height}" alt="${escapeHtml(alt)}" style="display:block;border:0;${radius}width:${image.width}px;height:${image.height}px">`;
}

/** The main picture: the person (photo) or the organisation (logo), per the design. */
function mainImage(c: Ctx): string {
  if (c.d.image === 'photo' && c.data.photo) return img(c, c.data.photo, c.data.name, true);
  if (c.d.image === 'logo' && c.data.logo) return img(c, c.data.logo, c.data.organization ?? '', false);
  return '';
}

/** The logo as a second picture — only when the main one is not already the logo. */
function secondLogo(c: Ctx): string {
  return c.d.logo && c.d.image !== 'logo' && c.data.logo ? img(c, c.data.logo, c.data.organization ?? '', false) : '';
}

function nameLine(c: Ctx, color?: string, bump = 0) {
  const ink = color ?? (c.d.nameColor === 'accent' ? c.accent : INK);
  return `<div style="${ts(c, c.sz.name + bump, ink, 'font-weight:bold')}">${escapeHtml(c.data.name)}</div>`;
}

/** The free line under the title (slogan, department, hours). */
function taglineLine(c: Ctx, color = MUTED) {
  return c.d.tagline ? `<div style="${ts(c, c.sz.small, color, 'font-style:italic')}">${escapeHtml(c.d.tagline)}</div>` : '';
}

function titleLine(c: Ctx, color = c.accent, upper = false) {
  const parts = [c.data.title, c.data.organization].filter(Boolean) as string[];
  if (!parts.length) return taglineLine(c, color === c.on ? c.on : MUTED);
  const extra = upper ? 'text-transform:uppercase;letter-spacing:1px;font-weight:bold' : 'font-weight:bold';
  return `<div style="${ts(c, upper ? c.sz.small : c.sz.body, color, extra)}">${parts.map(escapeHtml).join(' &middot; ')}</div>${taglineLine(c, color === c.on ? c.on : MUTED)}`;
}

interface ContactItem {
  field: SignatureField;
  text: string;
  href: string | null;
}

function contactItems(c: Ctx): ContactItem[] {
  const out: ContactItem[] = [];
  for (const field of c.d.fields) {
    const v = c.data[field];
    if (!v) continue;
    // Only well-formed values become links; anything else stays plain (escaped) text.
    if (field === 'phone') out.push({ field, text: v, href: /\d{3}/.test(v) && !/[<>"']/.test(v) ? telHref(v) : null });
    else if (field === 'email') out.push({ field, text: v, href: EMAIL_RE.test(v) ? `mailto:${v}` : null });
    else if (field === 'website') out.push({ field, text: stripScheme(v), href: safeUrl(v) });
    else out.push({ field, text: v.replace(/\s*\n\s*/g, ', '), href: null });
  }
  return out;
}

function label(c: Ctx, field: SignatureField) {
  if (c.d.labels === 'none') return '';
  const text = c.d.labels === 'short' ? SHORT[field] : c.words[field];
  return `<span style="color:${c.accent};font-weight:bold">${escapeHtml(text)}</span>&nbsp;&nbsp;`;
}

function link(item: ContactItem, color = INK) {
  const text = escapeHtml(item.text);
  return item.href ? `<a href="${escapeHtml(item.href)}" style="color:${color};text-decoration:none">${text}</a>` : text;
}

/** One contact per line, or all on one line separated by a dot. */
function contacts(c: Ctx, mode: 'stack' | 'inline' | 'table', color = INK): string {
  const items = contactItems(c);
  if (!items.length) return '';
  if (mode === 'inline') {
    return `<div style="${ts(c, c.sz.body, color)}">${items.map((i) => `${label(c, i.field)}${link(i, color)}`).join(`&nbsp;&nbsp;<span style="color:${c.accent}">&middot;</span>&nbsp;&nbsp;`)}</div>`;
  }
  if (mode === 'table') {
    const rows = items
      .map((i) => {
        const head = c.d.labels === 'none' ? '' : `<td style="${ts(c, c.sz.small, c.accent, 'font-weight:bold;padding:1px 10px 1px 0;white-space:nowrap')}">${escapeHtml(c.d.labels === 'short' ? SHORT[i.field] : c.words[i.field])}</td>`;
        return `<tr>${head}<td style="${ts(c, c.sz.body, color, 'padding:1px 0')}">${link(i, color)}</td></tr>`;
      })
      .join('');
    return `<table cellpadding="0" cellspacing="0" border="0" role="presentation">${rows}</table>`;
  }
  return items.map((i) => `<div style="${ts(c, c.sz.body, color)}">${label(c, i.field)}${link(i, color)}</div>`).join('');
}

function socials(c: Ctx, color = c.accent): string {
  const list = c.data.socials.filter((s) => safeUrl(s.url) && c.d.socials.includes(s.key));
  if (c.d.social === 'none' || !list.length) return '';
  if (c.d.social === 'text') {
    const links = list.map((s) => `<a href="${escapeHtml(s.url)}" style="color:${color};text-decoration:none;font-weight:bold">${SOCIAL_NAMES[s.key]}</a>`);
    return `<div style="${ts(c, c.sz.small, color, 'padding-top:6px')}">${links.join('&nbsp;&nbsp;&middot;&nbsp;&nbsp;')}</div>`;
  }
  const cells = list
    .map((s) => `<td bgcolor="${c.accent}" style="background-color:${c.accent};border-radius:4px;padding:3px 6px"><a href="${escapeHtml(s.url)}" style="${ts(c, c.sz.small, c.on, 'font-weight:bold;text-decoration:none')}">${SOCIAL_BADGES[s.key]}</a></td><td width="5" style="font-size:1px">&nbsp;</td>`)
    .join('');
  return `${gap(c, 8)}<table cellpadding="0" cellspacing="0" border="0" role="presentation"><tr>${cells}</tr></table>`;
}

/** Vertical space that every client honours (margins are not). */
const gap = (c: Ctx, px: number) => {
  const h = Math.max(2, Math.round(px * c.sp));
  return `<div style="font-size:${h}px;line-height:${h}px">&nbsp;</div>`;
};

/** The optional extra link ("Book a meeting →"), https only. */
function extraLink(c: Ctx): string {
  const url = safeUrl(c.d.extraUrl);
  if (!c.d.extraLabel || !url || !/^https:\/\//i.test(url)) return '';
  return `<div style="${ts(c, c.sz.small, c.accent, 'padding-top:6px;font-weight:bold')}"><a href="${escapeHtml(url)}" style="color:${c.accent};text-decoration:none">${escapeHtml(c.d.extraLabel)}&nbsp;&rarr;</a></div>`;
}

function cta(c: Ctx): string {
  if (!c.d.cta) return extraLink(c);
  const text = escapeHtml(c.d.ctaText || c.words.cta);
  return `${extraLink(c)}${gap(c, 10)}<table cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td bgcolor="${c.accent}" style="background-color:${c.accent};border-radius:6px;padding:7px 14px"><a href="${escapeHtml(c.data.cardUrl)}" style="${ts(c, c.sz.small, c.on, 'font-weight:bold;text-decoration:none')}">${text}&nbsp;&rarr;</a></td></tr></table>`;
}

function qr(c: Ctx): string {
  return c.d.qr && c.data.qr ? `<a href="${escapeHtml(c.data.cardUrl)}">${img(c, c.data.qr, 'QR', false)}</a>` : '';
}

/** A vertical accent rule between two cells. */
const rule = (c: Ctx) => (c.d.divider ? `<td width="3" bgcolor="${c.accent}" style="background-color:${c.accent};width:3px;font-size:1px">&nbsp;</td><td width="16" style="font-size:1px">&nbsp;</td>` : '<td width="4" style="font-size:1px">&nbsp;</td>');
/** A horizontal hairline row. */
const hline = (color = LINE) => `<tr><td style="padding:10px 0"><table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%"><tr><td height="1" bgcolor="${color}" style="background-color:${color};height:1px;font-size:1px;line-height:1px">&nbsp;</td></tr></table></td></tr>`;

const table = (inner: string, style = '') => `<table cellpadding="0" cellspacing="0" border="0" role="presentation"${style ? ` style="${style}"` : ''}>${inner}</table>`;
const cell = (inner: string, style = '', attrs = '') => (inner ? `<td${attrs}${style ? ` style="${style}"` : ''}>${inner}</td>` : '');

function textBlock(c: Ctx, mode: 'stack' | 'inline' | 'table' = 'stack') {
  return `${nameLine(c)}${titleLine(c)}<div style="font-size:6px;line-height:6px">&nbsp;</div>${contacts(c, mode)}${socials(c)}${cta(c)}`;
}

const LAYOUTS: Record<Exclude<SignatureDesign['template'], 'custom'>, (c: Ctx) => string> = {
  classic: (c) => {
    const image = mainImage(c);
    const logo = secondLogo(c);
    const code = qr(c);
    return table(
      `<tr>${cell(image, 'padding-right:16px', ' valign="top"')}${image ? rule(c) : ''}${cell(textBlock(c), '', ' valign="top"')}${cell(logo, 'padding-left:20px', ' valign="top"')}${cell(code, 'padding-left:16px', ' valign="top"')}</tr>`,
    );
  },
  stacked: (c) => {
    const rows = [mainImage(c), nameLine(c) + titleLine(c), contacts(c, 'inline'), socials(c) + cta(c), secondLogo(c), qr(c)].filter(Boolean);
    return table(rows.map((r, i) => `<tr><td align="center" style="padding-top:${i ? 8 : 0}px">${r.replace(/<table /g, '<table align="center" ')}</td></tr>`).join(''));
  },
  compact: (c) => {
    const image = mainImage(c);
    const head = `<div style="${ts(c, c.sz.body + 1, INK)}"><b style="color:${INK}">${escapeHtml(c.data.name)}</b>${[c.data.title, c.data.organization].filter(Boolean).length ? `&nbsp;&nbsp;<span style="color:${MUTED}">${[c.data.title, c.data.organization].filter(Boolean).map((v) => escapeHtml(v!)).join(' &middot; ')}</span>` : ''}</div>`;
    return table(`<tr>${cell(image, 'padding-right:12px', ' valign="middle"')}<td valign="middle">${head}${taglineLine(c)}${contacts(c, 'inline')}${socials(c)}${cta(c)}</td>${cell(secondLogo(c), 'padding-left:14px', ' valign="middle"')}</tr>`);
  },
  corporate: (c) => {
    const top = c.data.logo ? `<tr><td style="padding-bottom:10px">${img(c, c.data.logo, c.data.organization ?? '', false)}</td></tr>` : '';
    const photo = c.d.image === 'photo' && c.data.photo ? img(c, c.data.photo, c.data.name, true) : '';
    const body = table(`<tr>${cell(photo, 'padding-right:14px', ' valign="top"')}<td valign="top">${nameLine(c)}${titleLine(c, MUTED)}</td></tr>`);
    return table(`${top}<tr><td>${body}</td></tr>${c.d.divider ? hline(c.accent) : '<tr><td style="font-size:8px;line-height:8px">&nbsp;</td></tr>'}<tr><td>${contacts(c, 'table')}${socials(c)}${cta(c)}</td>${cell(qr(c), 'padding-left:16px', ' valign="bottom"')}</tr>`);
  },
  banner: (c) => {
    const image = mainImage(c);
    const head = table(`<tr>${cell(image, 'padding-right:14px', ' valign="middle"')}<td valign="middle">${nameLine(c, c.on)}${titleLine(c, c.on)}</td>${cell(secondLogo(c), 'padding-left:18px', ' valign="middle" align="right"')}</tr>`);
    return table(
      `<tr><td bgcolor="${c.accent}" style="background-color:${c.accent};border-radius:10px 10px 0 0;padding:14px 18px">${head}</td></tr><tr><td style="border:1px solid ${LINE};border-top:0;border-radius:0 0 10px 10px;padding:12px 18px">${contacts(c, 'inline')}${socials(c)}${cta(c)}${qr(c) ? `<div style="padding-top:10px">${qr(c)}</div>` : ''}</td></tr>`,
    );
  },
  sidebar: (c) => {
    const side = [mainImage(c), secondLogo(c)].filter(Boolean).join('<div style="font-size:10px;line-height:10px">&nbsp;</div>');
    return table(
      `<tr>${side ? `<td bgcolor="${c.accent}" valign="middle" align="center" style="background-color:${c.accent};border-radius:10px 0 0 10px;padding:14px">${side}</td>` : `<td width="6" bgcolor="${c.accent}" style="background-color:${c.accent};border-radius:6px 0 0 6px;font-size:1px">&nbsp;</td>`}<td valign="top" style="border:1px solid ${LINE};border-left:0;border-radius:0 10px 10px 0;padding:12px 18px">${textBlock(c)}</td>${cell(qr(c), 'padding-left:14px', ' valign="middle"')}</tr>`,
    );
  },
  minimal: (c) => {
    const parts = [c.data.title, c.data.organization].filter(Boolean) as string[];
    const sub = parts.length ? `<div style="${ts(c, c.sz.body, MUTED)}">${parts.map(escapeHtml).join(' &middot; ')}</div>` : '';
    return table(`<tr>${cell(mainImage(c), 'padding-right:12px', ' valign="top"')}<td valign="top">${nameLine(c)}${sub}${taglineLine(c)}${contacts(c, 'inline', MUTED)}${socials(c, MUTED)}${cta(c)}</td>${cell(secondLogo(c) + qr(c), 'padding-left:16px', ' valign="top"')}</tr>`);
  },
  bold: (c) => {
    const bar = c.d.divider ? `<table cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td width="44" height="4" bgcolor="${c.accent}" style="background-color:${c.accent};width:44px;height:4px;font-size:1px;line-height:1px">&nbsp;</td></tr></table><div style="font-size:8px;line-height:8px">&nbsp;</div>` : '';
    return table(
      `<tr>${cell(mainImage(c), 'padding-right:16px', ' valign="top"')}<td valign="top">${nameLine(c, undefined, 6)}${titleLine(c, c.accent, true)}<div style="font-size:8px;line-height:8px">&nbsp;</div>${bar}${contacts(c, 'stack')}${socials(c)}${cta(c)}</td>${cell(secondLogo(c), 'padding-left:22px', ' valign="top"')}${cell(qr(c), 'padding-left:16px', ' valign="bottom"')}</tr>`,
    );
  },
  boxed: (c) => {
    const image = mainImage(c);
    const inner = table(`<tr>${cell(image, 'padding-right:16px', ' valign="top"')}<td valign="top">${textBlock(c)}</td>${cell(secondLogo(c), 'padding-left:18px', ' valign="top"')}${cell(qr(c), 'padding-left:14px', ' valign="top"')}</tr>`);
    return table(`<tr><td style="border:1px solid ${LINE};border-left:4px solid ${c.accent};border-radius:8px;padding:14px 18px">${inner}</td></tr>`);
  },
  modern: (c) => {
    const left = mainImage(c);
    const right = `${nameLine(c)}${titleLine(c, MUTED)}<div style="font-size:8px;line-height:8px">&nbsp;</div>${contacts(c, 'table')}${socials(c)}${cta(c)}`;
    return table(`<tr>${cell(left, 'padding-right:18px', ' valign="middle"')}${left ? rule(c) : ''}<td valign="top">${right}</td>${cell(secondLogo(c), 'padding-left:18px', ' valign="top"')}${cell(qr(c), 'padding-left:16px', ' valign="middle"')}</tr>`);
  },
};

/**
 * The free-HTML template: the owner's markup with the card's values filled in.
 * The markup itself passed checkCustomHtml (server and editor); every value is
 * escaped here, URL tokens are our own absolute URLs, and {{photo}} / {{logo}}
 * / {{qr}} become the same email-safe <img> tags the layouts use.
 */
function renderCustom(c: Ctx): string {
  const { d, data } = c;
  if (checkCustomHtml(d.customHtml)) return '';
  const d0 = data;
  const text: Partial<Record<SignatureToken, string>> = {
    name: d0.name,
    firstName: d0.firstName ?? '',
    lastName: d0.lastName ?? '',
    title: d0.title ?? '',
    organization: d0.organization ?? '',
    phone: d0.phone ?? '',
    phoneHref: d0.phone && /\d{3}/.test(d0.phone) ? telHref(d0.phone) : '',
    email: d0.email ?? '',
    emailHref: d0.email && EMAIL_RE.test(d0.email) ? `mailto:${d0.email}` : '',
    website: d0.website ? stripScheme(d0.website) : '',
    websiteUrl: safeUrl(d0.website) ?? '',
    address: d0.address ? d0.address.replace(/\s*\n\s*/g, ', ') : '',
    cardUrl: d0.cardUrl,
    qrUrl: d0.qr?.src ?? '',
    photoUrl: d0.photo?.src ?? '',
    logoUrl: d0.logo?.src ?? '',
    accent: c.accent,
  };
  for (const s of d0.socials) text[s.key] = safeUrl(s.url) ?? '';
  const tags: Partial<Record<SignatureToken, string>> = {
    photo: d0.photo ? img(c, d0.photo, d0.name, true) : '',
    logo: d0.logo ? img(c, d0.logo, d0.organization ?? '', false) : '',
    qr: d0.qr ? `<a href="${escapeHtml(d0.cardUrl)}">${img(c, d0.qr, 'QR', false)}</a>` : '',
  };
  const has = (k: string) => Boolean(tags[k as SignatureToken] || text[k as SignatureToken]);
  // Sections: {{#key}}…{{/key}} stay only when the card has that value.
  let html = d.customHtml;
  const SECTION = /\{\{\s*#([a-zA-Z]+)\s*\}\}([\s\S]*?)\{\{\s*\/\1\s*\}\}/g;
  for (let prev = ''; prev !== html; ) {
    prev = html;
    html = html.replace(SECTION, (_m, key: string, inner: string) => (has(key) ? inner : ''));
  }
  return html.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_m, key: string) => tags[key as SignatureToken] ?? escapeHtml(text[key as SignatureToken] ?? ''));
}

/** The signature HTML: one outer table, ready to paste into a mail client. */
export function renderSignature(design: SignatureDesign, data: SignatureData): string {
  const accent = design.accent && HEX_RE.test(design.accent) ? design.accent : HEX_RE.test(data.accent) ? data.accent : '#2457f5';
  const space = SPACING[design.spacing] ?? SPACING.normal;
  const c: Ctx = { lh: space.lh, sp: space.sp, d: design, data, accent, on: onColor(accent), font: FONT_STACKS[design.font] ?? FONT_STACKS.arial, sz: SIZES[design.size] ?? SIZES.m, words: WORDS[design.lang] ?? WORDS.tr };
  if (design.template === 'custom') return renderCustom(c);
  const body = (LAYOUTS as Partial<typeof LAYOUTS>)[design.template]?.(c) ?? LAYOUTS.classic(c);
  const disclaimer = design.disclaimer
    ? `<tr><td style="${ts(c, c.sz.small - 1, MUTED, 'padding-top:12px;max-width:520px')}">${escapeHtml(design.disclaimer).replace(/\r?\n/g, '<br>')}</td></tr>`
    : '';
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:separate"><tr><td>${body}</td></tr>${disclaimer}</table>`;
}

/**
 * A ready-made layout as editable free HTML: the layout is drawn with marker
 * values instead of the card's, then every marker is turned back into its
 * token. Only fields the card has are included — the result looks like the
 * card's signature, and the owner customises it from there.
 */
export function layoutToCustomHtml(design: SignatureDesign, data: SignatureData): string {
  const M = {
    name: 'QRVMARKNAME',
    title: 'QRVMARKTITLE',
    organization: 'QRVMARKORG',
    phone: '+900000000917',
    email: 'qrvmark@qrvmark.example',
    website: 'https://qrvmarkweb.example',
    address: 'QRVMARKADDRESS',
    cardUrl: 'https://qrvmarkcard.example',
    photoUrl: 'https://qrvmarkphoto.example/p',
    logoUrl: 'https://qrvmarklogo.example/l',
    qrUrl: 'https://qrvmarkqr.example/q',
  };
  const marked: SignatureData = {
    ...data,
    name: M.name,
    title: data.title ? M.title : null,
    organization: data.organization ? M.organization : null,
    phone: data.phone ? M.phone : null,
    email: data.email ? M.email : null,
    website: data.website ? M.website : null,
    address: data.address ? M.address : null,
    socials: data.socials.map((s) => ({ ...s, url: `https://qrvmark${s.key}.example` })),
    cardUrl: M.cardUrl,
    photo: data.photo ? { ...data.photo, src: M.photoUrl } : null,
    logo: data.logo ? { ...data.logo, src: M.logoUrl } : null,
    qr: data.qr ? { ...data.qr, src: M.qrUrl } : null,
  };
  let html = renderSignature({ ...design, template: design.template === 'custom' ? 'classic' : design.template }, marked);
  const accent = design.accent && HEX_RE.test(design.accent) ? design.accent : data.accent;
  const swaps: [string, string][] = [
    [telHref(M.phone), '{{phoneHref}}'],
    [`mailto:${M.email}`, '{{emailHref}}'],
    [M.website, '{{websiteUrl}}'],
    [stripScheme(M.website), '{{website}}'],
    [M.photoUrl, '{{photoUrl}}'],
    [M.logoUrl, '{{logoUrl}}'],
    [M.qrUrl, '{{qrUrl}}'],
    [M.cardUrl, '{{cardUrl}}'],
    [M.phone, '{{phone}}'],
    [M.email, '{{email}}'],
    [M.name, '{{name}}'],
    [M.title, '{{title}}'],
    [M.organization, '{{organization}}'],
    [M.address, '{{address}}'],
    ...data.socials.map((s) => [`https://qrvmark${s.key}.example`, `{{${s.key}}}`] as [string, string]),
  ];
  for (const [from, to] of swaps) html = html.split(from).join(to);
  if (HEX_RE.test(accent)) html = html.split(accent).join('{{accent}}');
  // One element per line: readable in the editor, harmless in mail.
  return html.replace(/></g, '>\n<');
}

/** The same signature as plain text (the clipboard's text/plain part). */
export function signatureText(design: SignatureDesign, data: SignatureData): string {
  const items: string[] = [data.name, [data.title, data.organization].filter(Boolean).join(' · ')];
  for (const field of design.fields) {
    const v = data[field];
    if (v) items.push(field === 'website' ? stripScheme(v) : v);
  }
  items.push(data.cardUrl);
  if (design.disclaimer) items.push('', design.disclaimer);
  return items.filter((l, i) => l || i > 1).join('\n');
}

/** Image sizes for a design: the photo is square; logos and QR keep their aspect at the design's height. */
export function signatureSizes(design: SignatureDesign) {
  return SIZES[design.size] ?? SIZES.m;
}
