/**
 * The page-designer document stored in `vcards.design_config`: a template
 * preset the owner can then rearrange and restyle (blocks, palette, fonts,
 * backgrounds). One schema serves both sides — the server validates writes
 * strictly, the client normalises what it reads (missing keys → defaults).
 *
 * Pure JavaScript, no Node imports: the browser bundle imports this file too.
 *
 * Security: the public page applies these values as inline CSS, and the page's
 * CSP allows inline styles. So nothing here is free-form CSS or a URL that
 * reaches a style: colours are `#rrggbb`, everything else is an enum or a
 * clamped integer. The only URL (a link block's target) is https-only and is
 * rendered as an `href`, never inside `style`.
 */

export const DESIGN_VERSION = 1;
/** Serialised size cap: a design is a few KB; anything bigger is not one. */
export const DESIGN_MAX_BYTES = 12000;
export const DESIGN_MAX_BLOCKS = 20;

export const PAGE_TEMPLATES = ['porcelain', 'banner', 'aurora', 'minimal', 'bold', 'noir', 'pattern', 'sunset'];
export const FONTS = ['onest', 'manrope', 'grotesk', 'fraunces', 'playfair', 'system', 'serif'];
export const BLOCK_TYPES = ['header', 'hero', 'contacts', 'note', 'text', 'link', 'qr', 'divider', 'footer'];
/** Blocks that make sense once per page. */
const SINGLE_BLOCKS = new Set(['header', 'hero', 'footer']);
export const CONTACT_FIELDS = ['phone', 'whatsapp', 'email', 'website', 'linkedin', 'instagram', 'telegram', 'address'];
export const BACKGROUND_KINDS = ['none', 'color', 'gradient', 'image', 'pattern'];
export const PATTERNS = ['dots', 'grid', 'diagonal', 'waves', 'rings'];
const PALETTE_KEYS = ['bg', 'surface', 'ink', 'muted', 'line', 'accent'];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const BLOCK_ID_RE = /^[a-z0-9]{1,12}$/;
// Control characters except tab/newline; text is rendered as React text, so
// this is hygiene (no invisible junk on a public page), not escaping.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const DEFAULT_LIGHT = { bg: '#faf9f5', surface: '#ffffff', ink: '#191919', muted: '#57544d', line: '#e5e4df', accent: '#dc2626' };
export const DEFAULT_DARK = { bg: '#141413', surface: '#1d1c1a', ink: '#f0eee8', muted: '#a8a49b', line: '#33312c', accent: '#ef4444' };

const DEFAULT_BACKGROUND = { kind: 'none', color: '#e5e4df', color2: '#faf9f5', angle: 160, pattern: 'dots', overlay: 0, blur: 0 };

/** Block props by type, with their defaults. `id` and `hidden` are common. */
const BLOCK_DEFAULTS = {
  header: { tag: '' },
  hero: { actions: true },
  contacts: { title: '', style: 'rows', fields: [...CONTACT_FIELDS] },
  note: { title: '' },
  text: { title: '', body: '' },
  link: { label: '', url: '' },
  qr: { title: '', body: '' },
  divider: {},
  footer: { text: '' },
};

export function defaultBlock(type, id) {
  return { id, type, hidden: false, ...clone(BLOCK_DEFAULTS[type] ?? {}) };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** The default document — the "Porcelain" template, minus its hero image. */
export function defaultDesign() {
  return {
    v: DESIGN_VERSION,
    template: 'porcelain',
    theme: {
      mode: 'auto',
      toggle: true,
      light: { ...DEFAULT_LIGHT },
      dark: { ...DEFAULT_DARK },
      font: 'onest',
      heading: 'onest',
      radius: 12,
      align: 'center',
      nameSize: 'xl',
      buttons: 'pill',
      primary: 'ink',
      surface: 'card',
    },
    hero: {
      layout: 'stack',
      framed: true,
      height: 'md',
      text: 'auto',
      background: { ...DEFAULT_BACKGROUND, kind: 'image', overlay: 76 },
    },
    page: { background: { ...DEFAULT_BACKGROUND } },
    avatar: { show: true, shape: 'circle', size: 132, status: true, ring: false },
    dock: true,
    blocks: [
      defaultBlock('header', 'header'),
      defaultBlock('hero', 'hero'),
      defaultBlock('contacts', 'contacts'),
      defaultBlock('note', 'note'),
      defaultBlock('qr', 'qr'),
      defaultBlock('footer', 'footer'),
    ],
  };
}

// ---- checkers: return the clean value, or INVALID -----------------------------

const INVALID = Symbol('invalid');
const oneOf = (list) => (v) => (list.includes(v) ? v : INVALID);
const color = (v) => (typeof v === 'string' && HEX_RE.test(v) ? v.toLowerCase() : INVALID);
const bool = (v) => (typeof v === 'boolean' ? v : INVALID);
const int = (min, max) => (v) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : INVALID);
const text = (max, { multiline = false } = {}) => (v) => {
  if (typeof v !== 'string') return INVALID;
  let s = v.replace(CONTROL_RE, '');
  if (!multiline) s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.trim();
  return s.length <= max ? s : INVALID;
};
/** A link block target: https only, no credentials, length-capped. Empty is allowed (block shows nothing). */
const httpsUrl = (v) => {
  if (typeof v !== 'string') return INVALID;
  const s = v.trim();
  if (s === '') return '';
  if (s.length > 300) return INVALID;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    return INVALID;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return INVALID;
  return u.href;
};

/** Reads `src[key]` through `check`; absent → fallback, bad → fallback + an error path. */
function field(src, key, check, fallback, errors, path) {
  if (!src || typeof src !== 'object' || !(key in src) || src[key] === undefined) return fallback;
  const value = check(src[key]);
  if (value === INVALID) {
    errors.push(`${path}${key}`);
    return fallback;
  }
  return value;
}

function object(src, key, errors, path) {
  if (!src || typeof src !== 'object' || src[key] === undefined) return {};
  const value = src[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path}${key}`);
    return {};
  }
  return value;
}

function palette(src, fallback, errors, path) {
  const out = {};
  for (const key of PALETTE_KEYS) out[key] = field(src, key, color, fallback[key], errors, path);
  return out;
}

function background(src, fallback, errors, path) {
  return {
    kind: field(src, 'kind', oneOf(BACKGROUND_KINDS), fallback.kind, errors, path),
    color: field(src, 'color', color, fallback.color, errors, path),
    color2: field(src, 'color2', color, fallback.color2, errors, path),
    angle: field(src, 'angle', int(0, 360), fallback.angle, errors, path),
    pattern: field(src, 'pattern', oneOf(PATTERNS), fallback.pattern, errors, path),
    overlay: field(src, 'overlay', int(0, 95), fallback.overlay, errors, path),
    blur: field(src, 'blur', int(0, 16), fallback.blur, errors, path),
  };
}

function block(src, index, errors) {
  const path = `blocks.${index}.`;
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    errors.push(`blocks.${index}`);
    return null;
  }
  const type = field(src, 'type', oneOf(BLOCK_TYPES), null, errors, path);
  if (!type) {
    if (!('type' in src)) errors.push(`${path}type`);
    return null;
  }
  const base = defaultBlock(type, `b${index}`);
  const out = {
    id: field(src, 'id', (v) => (typeof v === 'string' && BLOCK_ID_RE.test(v) ? v : INVALID), base.id, errors, path),
    type,
    hidden: field(src, 'hidden', bool, false, errors, path),
  };
  switch (type) {
    case 'header':
      out.tag = field(src, 'tag', text(40), base.tag, errors, path);
      break;
    case 'hero':
      out.actions = field(src, 'actions', bool, base.actions, errors, path);
      break;
    case 'contacts': {
      out.title = field(src, 'title', text(40), base.title, errors, path);
      out.style = field(src, 'style', oneOf(['rows', 'tiles', 'buttons']), base.style, errors, path);
      out.fields = field(
        src,
        'fields',
        (v) => (Array.isArray(v) && v.length <= CONTACT_FIELDS.length && v.every((f) => CONTACT_FIELDS.includes(f)) && new Set(v).size === v.length ? [...v] : INVALID),
        base.fields,
        errors,
        path,
      );
      break;
    }
    case 'note':
      out.title = field(src, 'title', text(40), base.title, errors, path);
      break;
    case 'text':
      out.title = field(src, 'title', text(80), base.title, errors, path);
      out.body = field(src, 'body', text(800, { multiline: true }), base.body, errors, path);
      break;
    case 'link':
      out.label = field(src, 'label', text(60), base.label, errors, path);
      out.url = field(src, 'url', httpsUrl, base.url, errors, path);
      break;
    case 'qr':
      out.title = field(src, 'title', text(80), base.title, errors, path);
      out.body = field(src, 'body', text(200), base.body, errors, path);
      break;
    case 'footer':
      out.text = field(src, 'text', text(80), base.text, errors, path);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Normalises any input into a complete design document. Missing keys take
 * defaults; invalid ones take defaults AND are reported in `errors` (paths
 * such as `theme.light.accent`, `blocks.3.url`). Unknown keys are dropped.
 */
export function normalizeDesign(input) {
  const errors = [];
  const d = defaultDesign();
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (input !== undefined && src !== input) errors.push('$');
  if ('v' in src && src.v !== DESIGN_VERSION) errors.push('v');

  const theme = object(src, 'theme', errors, '');
  const hero = object(src, 'hero', errors, '');
  const page = object(src, 'page', errors, '');
  const avatar = object(src, 'avatar', errors, '');

  const out = {
    v: DESIGN_VERSION,
    template: field(src, 'template', oneOf(PAGE_TEMPLATES), d.template, errors, ''),
    theme: {
      mode: field(theme, 'mode', oneOf(['light', 'dark', 'auto']), d.theme.mode, errors, 'theme.'),
      toggle: field(theme, 'toggle', bool, d.theme.toggle, errors, 'theme.'),
      light: palette(object(theme, 'light', errors, 'theme.'), d.theme.light, errors, 'theme.light.'),
      dark: palette(object(theme, 'dark', errors, 'theme.'), d.theme.dark, errors, 'theme.dark.'),
      font: field(theme, 'font', oneOf(FONTS), d.theme.font, errors, 'theme.'),
      heading: field(theme, 'heading', oneOf(FONTS), d.theme.heading, errors, 'theme.'),
      radius: field(theme, 'radius', int(0, 28), d.theme.radius, errors, 'theme.'),
      align: field(theme, 'align', oneOf(['center', 'left']), d.theme.align, errors, 'theme.'),
      nameSize: field(theme, 'nameSize', oneOf(['sm', 'md', 'lg', 'xl']), d.theme.nameSize, errors, 'theme.'),
      buttons: field(theme, 'buttons', oneOf(['pill', 'rounded', 'square']), d.theme.buttons, errors, 'theme.'),
      primary: field(theme, 'primary', oneOf(['ink', 'accent']), d.theme.primary, errors, 'theme.'),
      surface: field(theme, 'surface', oneOf(['card', 'glass', 'flat']), d.theme.surface, errors, 'theme.'),
    },
    hero: {
      layout: field(hero, 'layout', oneOf(['stack', 'banner', 'split']), d.hero.layout, errors, 'hero.'),
      framed: field(hero, 'framed', bool, d.hero.framed, errors, 'hero.'),
      height: field(hero, 'height', oneOf(['sm', 'md', 'lg']), d.hero.height, errors, 'hero.'),
      text: field(hero, 'text', oneOf(['auto', 'light', 'dark']), d.hero.text, errors, 'hero.'),
      background: background(object(hero, 'background', errors, 'hero.'), d.hero.background, errors, 'hero.background.'),
    },
    page: {
      background: background(object(page, 'background', errors, 'page.'), d.page.background, errors, 'page.background.'),
    },
    avatar: {
      show: field(avatar, 'show', bool, d.avatar.show, errors, 'avatar.'),
      shape: field(avatar, 'shape', oneOf(['circle', 'rounded', 'square']), d.avatar.shape, errors, 'avatar.'),
      size: field(avatar, 'size', int(64, 180), d.avatar.size, errors, 'avatar.'),
      status: field(avatar, 'status', bool, d.avatar.status, errors, 'avatar.'),
      ring: field(avatar, 'ring', bool, d.avatar.ring, errors, 'avatar.'),
    },
    dock: field(src, 'dock', bool, d.dock, errors, ''),
    blocks: d.blocks,
  };

  if ('blocks' in src) {
    if (!Array.isArray(src.blocks) || src.blocks.length > DESIGN_MAX_BLOCKS) {
      errors.push('blocks');
    } else {
      const blocks = [];
      const ids = new Set();
      const singles = new Set();
      src.blocks.forEach((raw, index) => {
        const b = block(raw, index, errors);
        if (!b) return;
        if (ids.has(b.id)) {
          errors.push(`blocks.${index}.id`);
          return;
        }
        if (SINGLE_BLOCKS.has(b.type)) {
          if (singles.has(b.type)) {
            errors.push(`blocks.${index}.type`);
            return;
          }
          singles.add(b.type);
        }
        ids.add(b.id);
        blocks.push(b);
      });
      out.blocks = blocks;
    }
  }
  return { value: out, errors };
}

/**
 * Server-side write check for `design_config`. `null`/'' clears the design
 * (the card falls back to its classic `design_style`). Anything else must be
 * a complete, valid document: a single bad value refuses the whole write, so
 * a tampered request can never half-apply.
 */
export function validateDesignConfig(input) {
  if (input === null || input === '') return { value: null, error: null };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { value: null, error: 'invalid' };
  let size;
  try {
    size = JSON.stringify(input).length;
  } catch {
    return { value: null, error: 'invalid' };
  }
  if (size > DESIGN_MAX_BYTES) return { value: null, error: 'too_long' };
  const { value, errors } = normalizeDesign(input);
  return errors.length ? { value: null, error: 'invalid', paths: errors } : { value, error: null };
}

/**
 * Client-side read: whatever is stored (object, or a JSON string from some
 * database drivers) becomes a complete document, or null when there is none.
 */
export function resolveDesign(raw) {
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
  return normalizeDesign(src).value;
}
