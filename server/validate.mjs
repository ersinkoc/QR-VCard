/**
 * Input validation for cards and users. Returns cleaned data plus per-field error
 * CODES (not sentences): the client translates them, so the API stays language-free.
 */
import { randomInt } from 'node:crypto';

export const CARD_LIMITS = {
  first_name: 80,
  last_name: 80,
  organization: 120,
  job_title: 120,
  phone: 40,
  email: 254,
  website: 300,
  linkedin: 300,
  instagram: 300,
  whatsapp: 300,
  telegram: 300,
  address: 500,
  note: 1000,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9 ().\-/]{2,}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** A handle as people actually type it: with or without @, dots/underscores allowed. */
const SOCIAL_HANDLE_RE = /^@?[A-Za-z0-9._-]{1,64}$/;
/** A bare number as people paste it: optional +, 7–15 digits. */
const PHONE_DIGITS_RE = /^[0-9]{7,15}$/;

/**
 * Normalises a social field to the canonical public URL, or returns an error
 * code. Accepts what people actually paste — a bare handle (`@ada`,
 * `ada.lovelace`), a phone number (`+90 555 …`) or a full profile URL — and
 * stores one https canonical form so the public buttons and the vCard can use
 * the value as-is. Only https survives: a card is a public artefact, so a
 * profile link must never downgrade the visitor to http.
 */
export function normalizeSocial(field, value) {
  const err = `invalid_${field}`;
  const clean = (h) => String(h).replace(/^@/, '').replace(/\/+$/, '');

  // Bare input — no scheme, no slash: a handle (or a phone number for WhatsApp).
  if (!value.includes('/') && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    if (field === 'whatsapp') {
      const digits = value.replace(/\D/g, '');
      return PHONE_DIGITS_RE.test(digits) ? `https://wa.me/${digits}` : err;
    }
    const handle = clean(value);
    if (!SOCIAL_HANDLE_RE.test(handle)) return err;
    if (field === 'linkedin') return `https://www.linkedin.com/in/${handle}`;
    if (field === 'instagram') return `https://www.instagram.com/${handle}/`;
    if (field === 'telegram') return `https://t.me/${handle}`;
    return err;
  }

  // URL-shaped input — with or without the scheme.
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return err;
  }
  if (!/^https?:$/.test(u.protocol) || u.search || u.hash) return err;
  const tail = clean(u.pathname).replace(/^\/+/, '');
  switch (field) {
    case 'linkedin': {
      if (!/(^|\.)linkedin\.com$/.test(u.hostname.toLowerCase())) return err;
      const m = /^in\/([A-Za-z0-9._%-]{3,100})$/.exec(u.pathname.replace(/^\//, ''));
      if (m) return `https://www.linkedin.com/in/${m[1]}`;
      if (tail) return `https://www.linkedin.com/${tail}`; // company/school posts …
      return err;
    }
    case 'instagram':
      if (!/(^|\.)instagram\.com$/.test(u.hostname.toLowerCase()) || !SOCIAL_HANDLE_RE.test(tail)) return err;
      return `https://www.instagram.com/${tail}/`;
    case 'whatsapp': {
      const digits = (u.hostname + u.pathname).replace(/\D/g, '');
      if (!PHONE_DIGITS_RE.test(digits)) return err;
      return `https://wa.me/${digits}`;
    }
    case 'telegram': {
      if (!/(^|\.)t\.me$/.test(u.hostname.toLowerCase())) return err;
      if (['share', 'joinchat', 'iv'].includes(u.pathname.replace(/^\//, '').split('/')[0].toLowerCase())) return err;
      if (!SOCIAL_HANDLE_RE.test(tail)) return err;
      return `https://t.me/${tail}`;
    }
    default:
      return err;
  }
}
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,30}[A-Za-z0-9]$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A username IS a public short URL (`/<username>`), so it is stricter than a
 * vanity card code: lowercase only (stored normalised), 2–32 chars, and it
 * must never shadow a system path.
 */
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/;

/**
 * Normalises and validates a username, or returns an error CODE. Accepts the
 * case people type (`Ada`) and stores lowercase, so `/Ada` and `/ada` are the
 * same short URL and the unique index stays race-proof.
 */
export function validateUsername(value) {
  if (typeof value !== 'string') return { value: null, error: 'invalid_username' };
  const username = value.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) return { value: null, error: 'invalid_username' };
  if (RESERVED_CODES.has(username)) return { value: null, error: 'username_reserved' };
  return { value: username, error: null };
}

/** Paths a vanity code must never shadow, or that read as official. */
const RESERVED_CODES = new Set(['admin', 'panel', 'api', 'login', 'logout', 'assets', 'static', 'healthz', 'new', 'edit', 'settings', 'account', 'users', 'c', 'u']);

/** Unambiguous alphabet: no 0/O/1/l/I, so a printed code survives being typed. */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function generateCode(length = 7) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Error code for a vanity short code, or null when it is acceptable. */
export function validateCode(code) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) return 'invalid_code';
  if (RESERVED_CODES.has(code.toLowerCase())) return 'code_reserved';
  return null;
}

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * `partial` (PATCH) validates only the fields present; a create additionally
 * requires something to call the card by.
 */
export function validateCardInput(input, { partial = false } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const data = {};
  const errors = {};

  for (const [field, max] of Object.entries(CARD_LIMITS)) {
    if (!(field in src)) continue;
    const value = cleanString(src[field]);
    if (value !== null && value.length > max) {
      errors[field] = 'too_long';
      continue;
    }
    data[field] = value;
  }

  if (data.email && !EMAIL_RE.test(data.email)) errors.email = 'invalid_email';
  if (data.phone && !PHONE_RE.test(data.phone)) errors.phone = 'invalid_phone';
  if (data.website) {
    const candidate = /^https?:\/\//i.test(data.website) ? data.website : `https://${data.website}`;
    try {
      const u = new URL(candidate);
      if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw new Error('bad');
      data.website = candidate;
    } catch {
      errors.website = 'invalid_url';
    }
  }

  // Social profiles: accept a full URL or a bare handle, store the canonical
  // https URL so both the buttons and the vCard can use the value as-is.
  // (The generic limits loop above already copied the raw value into `data`;
  // a failed normalisation must remove it, never leave it verbatim.)
  for (const field of ['linkedin', 'instagram', 'whatsapp', 'telegram']) {
    if (data[field]) {
      const normalized = normalizeSocial(field, data[field]);
      if (typeof normalized === 'string' && normalized.startsWith('https://')) data[field] = normalized;
      else {
        delete data[field];
        errors[field] = `invalid_${field}`;
      }
    }
  }

  if ('accent_color' in src) {
    const c = cleanString(src.accent_color);
    if (c !== null && !COLOR_RE.test(c)) errors.accent_color = 'invalid_color';
    else data.accent_color = c;
  }
  if ('status' in src) {
    if (src.status === 'draft' || src.status === 'published') data.status = src.status;
    else errors.status = 'invalid_status';
  }
  // Which card answers the owner's `/<username>` short URL. Only a boolean is
  // honoured; anything else is ignored rather than stored (a badge, not a field).
  if ('is_primary' in src) {
    if (typeof src.is_primary === 'boolean') data.is_primary = src.is_primary;
    else errors.is_primary = 'invalid';
  }

  if ('photo_style' in src) {
    if (src.photo_style === 'avatar' || src.photo_style === 'logo') data.photo_style = src.photo_style;
    else errors.photo_style = 'invalid';
  }

  if (!partial && !data.first_name && !data.last_name && !data.organization && !errors.first_name) {
    errors.first_name = 'name_required';
  }
  if (partial && ['first_name', 'last_name', 'organization'].every((f) => f in data && data[f] === null)) {
    errors.first_name = 'name_required';
  }

  return { data, errors };
}

/**
 * An optional share-expiry date: today or later, `YYYY-MM-DD`. Returns the
 * normalized string, null (no expiry — also for '' / null), or an error CODE.
 * Past dates are refused at write time; enforcement happens lazily at read
 * time (a share whose day has passed simply no longer grants access).
 */
export function validateExpiresOn(value) {
  if (value === null || value === undefined || value === '') return { value: null, error: null };
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { value: null, error: 'invalid_expires_on' };
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return { value: null, error: 'invalid_expires_on' };
  const today = new Date();
  const todayUtc = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
  if (s < todayUtc) return { value: null, error: 'expires_on_past' };
  return { value: s, error: null };
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return 'password_too_short';
  if (password.length > 128) return 'password_too_long';
  return null;
}

/** Admin-side user create/update. Role ids are checked against Directus by the caller. */
export function validateUserInput(input, { partial = false } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const data = {};
  const errors = {};

  if ('email' in src || !partial) {
    const email = cleanString(src.email)?.toLowerCase() ?? null;
    if (!email) errors.email = 'required';
    else if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = 'invalid_email';
    else data.email = email;
  }
  for (const field of ['first_name', 'last_name']) {
    if (!(field in src)) continue;
    const value = cleanString(src[field]);
    if (value !== null && value.length > 80) errors[field] = 'too_long';
    else data[field] = value;
  }
  if ('password' in src || !partial) {
    const problem = validatePassword(src.password);
    if (problem) errors.password = problem;
    else data.password = src.password;
  }
  if ('role' in src || !partial) {
    if (typeof src.role === 'string' && UUID_RE.test(src.role)) data.role = src.role;
    else errors.role = 'invalid_role';
  }
  if ('status' in src) {
    if (src.status === 'active' || src.status === 'suspended') data.status = src.status;
    else errors.status = 'invalid_status';
  }
  // Username is optional everywhere (never auto-generated): an install keeps
  // working with plain /c/<code> URLs until someone claims one. An explicit
  // null/'' clears it; anything else must be a valid handle.
  if ('username' in src) {
    if (src.username === null || src.username === '') data.username = null;
    else {
      const { value, error } = validateUsername(src.username);
      if (error) errors.username = error;
      else data.username = value;
    }
  }
  return { data, errors };
}
