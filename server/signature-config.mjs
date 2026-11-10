/**
 * The email-signature document stored in `vcards.signature_config`: a layout
 * template plus the options the owner adjusts in the signature studio. Like
 * design-config.mjs, one schema serves both sides — the server validates
 * writes strictly, the browser normalises what it reads (missing keys →
 * the template's defaults).
 *
 * Pure JavaScript, no Node imports: the browser bundle imports this file too.
 *
 * Security: the signature is HTML that lands in other people's mail clients.
 * So nothing here is free-form markup or CSS: colours are `#rrggbb`,
 * everything else is an enum, a boolean or plain text that the renderer
 * HTML-escapes (CTA label, disclaimer).
 */

export const SIGNATURE_VERSION = 1;
/** Room for the free HTML (8,000 characters) plus the options. */
export const SIGNATURE_MAX_BYTES = 14000;

export const SIGNATURE_TEMPLATES = ['classic', 'stacked', 'compact', 'corporate', 'banner', 'sidebar', 'minimal', 'bold', 'boxed', 'modern', 'custom'];
export const SIGNATURE_FONTS = ['arial', 'helvetica', 'verdana', 'tahoma', 'trebuchet', 'georgia', 'times'];
export const SIGNATURE_SIZES = ['s', 'm', 'l'];
export const SIGNATURE_IMAGES = ['photo', 'logo', 'none'];
export const SIGNATURE_SHAPES = ['circle', 'rounded', 'square'];
export const SIGNATURE_FIELDS = ['phone', 'email', 'website', 'address'];
export const SIGNATURE_LABELS = ['none', 'short', 'full'];
export const SIGNATURE_SOCIAL = ['none', 'text', 'badges'];
export const SIGNATURE_LANGS = ['tr', 'en'];
export const SIGNATURE_SOCIAL_KEYS = ['linkedin', 'instagram', 'whatsapp', 'telegram'];
export const SIGNATURE_SPACING = ['compact', 'normal', 'relaxed'];
export const SIGNATURE_NAME_COLORS = ['ink', 'accent'];
export const CTA_MAX = 40;
export const DISCLAIMER_MAX = 600;
export const TAGLINE_MAX = 80;
export const EXTRA_LABEL_MAX = 30;
export const EXTRA_URL_MAX = 300;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Options every template shares; a template preset overrides some of them. */
const BASE = {
  v: SIGNATURE_VERSION,
  template: 'classic',
  font: 'arial',
  size: 'm',
  accent: null,
  image: 'photo',
  shape: 'circle',
  logo: true,
  fields: ['phone', 'email', 'website'],
  labels: 'short',
  social: 'text',
  qr: false,
  cta: false,
  ctaText: '',
  divider: true,
  disclaimer: '',
  lang: 'tr',
  /** A short line under the title: a slogan, a department, office hours. */
  tagline: '',
  /** Which of the card's social profiles to show (those the card has). */
  socials: ['linkedin', 'instagram', 'whatsapp', 'telegram'],
  spacing: 'normal',
  nameColor: 'ink',
  /** One extra link, e.g. "Book a meeting" → a calendar page (https only). */
  extraLabel: '',
  extraUrl: '',
  /** The free-HTML template's markup (tokens + sections), '' until written. */
  customHtml: '',
};

/** What choosing a template sets (layout look); content choices are kept. */
export const SIGNATURE_PRESETS = {
  classic: { image: 'photo', shape: 'circle', logo: true, labels: 'short', social: 'text', divider: true },
  stacked: { image: 'photo', shape: 'circle', logo: true, labels: 'none', social: 'badges', divider: true },
  compact: { image: 'none', shape: 'circle', logo: false, labels: 'none', social: 'text', divider: false },
  corporate: { image: 'logo', shape: 'square', logo: false, labels: 'full', social: 'text', divider: true },
  banner: { image: 'photo', shape: 'circle', logo: true, labels: 'short', social: 'badges', divider: false },
  sidebar: { image: 'photo', shape: 'rounded', logo: true, labels: 'short', social: 'badges', divider: false },
  minimal: { image: 'none', shape: 'circle', logo: false, labels: 'none', social: 'none', divider: false },
  bold: { image: 'none', shape: 'square', logo: true, labels: 'short', social: 'text', divider: true },
  boxed: { image: 'photo', shape: 'rounded', logo: true, labels: 'short', social: 'badges', divider: false },
  modern: { image: 'logo', shape: 'square', logo: false, labels: 'full', social: 'badges', divider: true },
  /** Free HTML: the layout options do not apply; the HTML decides everything. */
  custom: {},
};

export function templateSignature(template = 'classic', keep = {}) {
  const t = SIGNATURE_TEMPLATES.includes(template) ? template : 'classic';
  const content = {};
  for (const k of ['font', 'size', 'accent', 'fields', 'qr', 'cta', 'ctaText', 'disclaimer', 'lang', 'tagline', 'socials', 'spacing', 'nameColor', 'extraLabel', 'extraUrl', 'customHtml']) if (k in keep) content[k] = keep[k];
  return { ...BASE, ...content, ...SIGNATURE_PRESETS[t], template: t, fields: [...(content.fields ?? BASE.fields)], socials: [...(content.socials ?? BASE.socials)] };
}

const cleanText = (v, max) => String(v ?? '').replace(CONTROL_RE, '').trim().slice(0, max);

/**
 * Fills every key (template defaults for missing ones) and collects the paths
 * of present-but-invalid values. `value` is always a complete document.
 */
export function normalizeSignature(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const errors = [];
  const template = SIGNATURE_TEMPLATES.includes(src.template) ? src.template : 'classic';
  if ('template' in src && template !== src.template) errors.push('template');
  const out = templateSignature(template);
  const enumKey = (key, allowed) => {
    if (!(key in src)) return;
    if (allowed.includes(src[key])) out[key] = src[key];
    else errors.push(key);
  };
  enumKey('font', SIGNATURE_FONTS);
  enumKey('size', SIGNATURE_SIZES);
  enumKey('image', SIGNATURE_IMAGES);
  enumKey('shape', SIGNATURE_SHAPES);
  enumKey('labels', SIGNATURE_LABELS);
  enumKey('social', SIGNATURE_SOCIAL);
  enumKey('lang', SIGNATURE_LANGS);
  enumKey('spacing', SIGNATURE_SPACING);
  enumKey('nameColor', SIGNATURE_NAME_COLORS);
  if ('socials' in src) {
    const list = Array.isArray(src.socials) ? src.socials : null;
    if (!list || list.some((f) => !SIGNATURE_SOCIAL_KEYS.includes(f)) || new Set(list).size !== list.length) errors.push('socials');
    else out.socials = [...list];
  }
  for (const [key, max] of [['tagline', TAGLINE_MAX], ['extraLabel', EXTRA_LABEL_MAX]]) {
    if (!(key in src)) continue;
    if (typeof src[key] !== 'string' || src[key].length > max) errors.push(key);
    else out[key] = cleanText(src[key], max);
  }
  if ('customHtml' in src) {
    if (typeof src.customHtml !== 'string' || checkCustomHtml(src.customHtml)) errors.push('customHtml');
    else out.customHtml = src.customHtml;
  }
  if ('extraUrl' in src) {
    const url = typeof src.extraUrl === 'string' ? src.extraUrl.trim() : null;
    if (url === null || url.length > EXTRA_URL_MAX) errors.push('extraUrl');
    else if (url === '') out.extraUrl = '';
    else {
      // https only, like the page designer's link block: the link lands in other people's inboxes.
      const candidate = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
      let ok = false;
      try {
        const u = new URL(candidate);
        ok = u.protocol === 'https:' && u.hostname.includes('.');
      } catch {
        ok = false;
      }
      if (ok) out.extraUrl = candidate;
      else errors.push('extraUrl');
    }
  }
  for (const key of ['logo', 'qr', 'cta', 'divider']) {
    if (!(key in src)) continue;
    if (typeof src[key] === 'boolean') out[key] = src[key];
    else errors.push(key);
  }
  if ('accent' in src) {
    if (src.accent === null || src.accent === '') out.accent = null;
    else if (typeof src.accent === 'string' && HEX_RE.test(src.accent)) out.accent = src.accent.toLowerCase();
    else errors.push('accent');
  }
  if ('fields' in src) {
    const list = Array.isArray(src.fields) ? src.fields : null;
    if (!list || list.some((f) => !SIGNATURE_FIELDS.includes(f)) || new Set(list).size !== list.length) errors.push('fields');
    else out.fields = [...list];
  }
  if ('ctaText' in src) {
    if (typeof src.ctaText !== 'string' || src.ctaText.length > CTA_MAX) errors.push('ctaText');
    else out.ctaText = cleanText(src.ctaText, CTA_MAX);
  }
  if ('disclaimer' in src) {
    if (typeof src.disclaimer !== 'string' || src.disclaimer.length > DISCLAIMER_MAX) errors.push('disclaimer');
    else out.disclaimer = String(src.disclaimer).replace(CONTROL_RE, '').trim().slice(0, DISCLAIMER_MAX);
  }
  return { value: out, errors };
}

/** Server write: null clears; anything else must be a valid document. */
export function validateSignatureConfig(input) {
  if (input === null || input === '') return { value: null, error: null };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { value: null, error: 'invalid' };
  let size;
  try {
    size = JSON.stringify(input).length;
  } catch {
    return { value: null, error: 'invalid' };
  }
  if (size > SIGNATURE_MAX_BYTES) return { value: null, error: 'too_long' };
  const { value, errors } = normalizeSignature(input);
  return errors.length ? { value: null, error: 'invalid', paths: errors } : { value, error: null };
}

/** Client read: whatever is stored becomes a complete document, or null when there is none. */
export function resolveSignature(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  let src = raw;
  if (typeof raw === 'string') {
    try {
      src = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  return normalizeSignature(src).value;
}

// ---- free HTML ("custom" template) ------------------------------------------
//
// The owner writes the signature's HTML; card data comes in through tokens
// ({{name}}, {{photoUrl}} …) and optional sections ({{#phone}}…{{/phone}},
// shown only when the card has that value). The HTML ends up in other people's
// inboxes and in the panel's preview, so it is checked against an allowlist
// and REFUSED (with the reason) rather than silently cleaned: email-safe
// tags and attributes only, links to https / mailto / tel, images from https,
// inline styles without url(), escapes or positioning, no comments (Outlook's
// conditional comments could carry anything).

export const CUSTOM_HTML_MAX = 8000;

/** Every token the custom HTML may use, with what it stands for. */
export const SIGNATURE_TOKENS = ['photo', 'logo', 'qr', 'name', 'firstName', 'lastName', 'title', 'organization', 'phone', 'phoneHref', 'email', 'emailHref', 'website', 'websiteUrl', 'address', 'cardUrl', 'qrUrl', 'photoUrl', 'logoUrl', 'accent', 'linkedin', 'instagram', 'whatsapp', 'telegram'];
/** Tokens that are URLs (valid as href / src on their own). */
const URL_TOKENS = new Set(['phoneHref', 'emailHref', 'websiteUrl', 'cardUrl', 'qrUrl', 'photoUrl', 'logoUrl', 'linkedin', 'instagram', 'whatsapp', 'telegram']);
const IMAGE_TOKENS = new Set(['qrUrl', 'photoUrl', 'logoUrl']);
/** Tokens that become whole <img> tags: text only, never inside a tag. */
const TAG_TOKENS = new Set(['photo', 'logo', 'qr']);

const ALLOWED_TAGS = new Set(['a', 'abbr', 'b', 'big', 'blockquote', 'br', 'center', 'code', 'div', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul']);
const VOID_TAGS = new Set(['br', 'hr', 'img']);
const ALLOWED_ATTRS = new Set(['align', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'color', 'colspan', 'dir', 'face', 'height', 'href', 'hspace', 'lang', 'role', 'rowspan', 'size', 'src', 'style', 'target', 'title', 'valign', 'vspace', 'width']);
const TOKEN_RE = /\{\{\s*([#/]?)([a-zA-Z]+)\s*\}\}/g;
const ATTR_RE = /^\s+([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/;

function tokenOnly(value, allowed) {
  const m = /^\s*\{\{\s*([a-zA-Z]+)\s*\}\}\s*$/.exec(value);
  return Boolean(m && allowed.has(m[1]));
}

/**
 * Why a custom signature is refused, or null when it is fine. The reason is a
 * short machine code plus the offending piece, for the editor to show.
 */
export function checkCustomHtml(html) {
  if (typeof html !== 'string') return { code: 'invalid', detail: '' };
  if (html.length > CUSTOM_HTML_MAX) return { code: 'too_long', detail: String(CUSTOM_HTML_MAX) };
  // Tokens and sections first: only known names, balanced, not nested in themselves.
  const open = [];
  for (const m of html.matchAll(TOKEN_RE)) {
    const [, kind, name] = m;
    if (!SIGNATURE_TOKENS.includes(name)) return { code: 'unknown_token', detail: name };
    if (kind === '#') {
      if (open.includes(name)) return { code: 'section', detail: name };
      open.push(name);
    } else if (kind === '/') {
      if (open.pop() !== name) return { code: 'section', detail: name };
    }
  }
  if (open.length) return { code: 'section', detail: open[open.length - 1] };
  // Then the markup itself, tag by tag. Anything that is not a well-formed,
  // allowed tag where a '<' appears is refused.
  const stack = [];
  let i = 0;
  while ((i = html.indexOf('<', i)) !== -1) {
    const rest = html.slice(i);
    if (rest.startsWith('<!') || rest.startsWith('<?')) return { code: 'comment', detail: rest.slice(0, 12) };
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(rest);
    if (!m) return { code: 'markup', detail: rest.slice(0, 12) };
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return { code: 'tag', detail: tag };
    let pos = m[0].length;
    const attrs = [];
    if (!closing) {
      for (;;) {
        const a = ATTR_RE.exec(rest.slice(pos));
        if (!a) break;
        attrs.push({ name: a[1].toLowerCase(), value: a[2] ?? a[3] ?? a[4] ?? '' });
        pos += a[0].length;
      }
    }
    const end = /^\s*\/?>/.exec(rest.slice(pos));
    if (!end) return { code: 'markup', detail: rest.slice(0, Math.min(rest.length, pos + 12)) };
    for (const { name, value } of attrs) {
      for (const t of value.matchAll(TOKEN_RE)) if (TAG_TOKENS.has(t[2])) return { code: 'image_token', detail: t[2] };
      if (name.startsWith('on')) return { code: 'event', detail: name };
      if (!ALLOWED_ATTRS.has(name)) return { code: 'attribute', detail: `${tag} ${name}` };
      const v = value.trim();
      if (name === 'href' && !(/^(https?:\/\/|mailto:|tel:|#)/i.test(v) || tokenOnly(v, URL_TOKENS)) ) return { code: 'href', detail: v.slice(0, 40) };
      if (name === 'src' && !(/^https:\/\//i.test(v) || tokenOnly(v, IMAGE_TOKENS))) return { code: 'src', detail: v.slice(0, 40) };
      // href/src are judged on their RAW text, which must already start with
      // https:// (or mailto:/tel:/#): an entity later on cannot change the
      // scheme. In a style, though, entities could spell "url(" past the
      // plain-text check — so a style may not contain '&' at all.
      if (name === 'style' && v.includes('&')) return { code: 'entity', detail: `${tag} ${name}` };
      // Card text inside a style could inject CSS ("x;background:url(…)"):
      // the only token a style may use is the validated #rrggbb accent.
      if (name === 'style') {
        for (const t of v.matchAll(TOKEN_RE)) if (t[2] !== 'accent') return { code: 'style_token', detail: t[2] };
      }
      if (/javascript:|vbscript:|data:/i.test(v)) return { code: 'href', detail: v.slice(0, 40) };
      if (name === 'style' && /url\s*\(|expression|@import|behavior|-moz-binding|\\|position\s*:|<|>/i.test(v)) return { code: 'style', detail: v.slice(0, 40) };
    }
    if (closing) {
      if (stack.pop() !== tag) return { code: 'nesting', detail: tag };
    } else if (!VOID_TAGS.has(tag) && !end[0].includes('/')) {
      stack.push(tag);
    }
    i += pos + end[0].length;
  }
  if (stack.length) return { code: 'nesting', detail: stack[stack.length - 1] };
  return null;
}

/** A starting point for the free HTML: the classic layout, written with tokens. */
export const CUSTOM_HTML_STARTER = `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="font-family:Arial,Helvetica,sans-serif;color:#1f2937">
  <tr>
    {{#photo}}<td valign="top" style="padding-right:16px">{{photo}}</td>{{/photo}}
    <td valign="top" style="border-left:3px solid {{accent}};padding-left:16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#1f2937">
      <div style="font-size:18px;font-weight:bold">{{name}}</div>
      <div style="color:{{accent}};font-weight:bold">{{title}}{{#organization}} &middot; {{organization}}{{/organization}}</div>
      {{#phone}}<div><b style="color:{{accent}}">T</b>&nbsp; <a href="{{phoneHref}}" style="color:#1f2937;text-decoration:none">{{phone}}</a></div>{{/phone}}
      {{#email}}<div><b style="color:{{accent}}">E</b>&nbsp; <a href="{{emailHref}}" style="color:#1f2937;text-decoration:none">{{email}}</a></div>{{/email}}
      {{#website}}<div><b style="color:{{accent}}">W</b>&nbsp; <a href="{{websiteUrl}}" style="color:#1f2937;text-decoration:none">{{website}}</a></div>{{/website}}
      <div style="padding-top:8px"><a href="{{cardUrl}}" style="color:{{accent}};font-weight:bold;text-decoration:none">{{cardUrl}}</a></div>
    </td>
    {{#logo}}<td valign="top" style="padding-left:20px">{{logo}}</td>{{/logo}}
  </tr>
</table>`;
