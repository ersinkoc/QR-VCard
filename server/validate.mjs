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
  address: 500,
  note: 1000,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9 ().\-/]{2,}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,30}[A-Za-z0-9]$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Paths a vanity code must never shadow, or that read as official. */
const RESERVED_CODES = new Set(['admin', 'panel', 'api', 'login', 'logout', 'assets', 'static', 'healthz', 'new', 'edit', 'settings', 'account', 'users']);

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

  if ('accent_color' in src) {
    const c = cleanString(src.accent_color);
    if (c !== null && !COLOR_RE.test(c)) errors.accent_color = 'invalid_color';
    else data.accent_color = c;
  }
  if ('status' in src) {
    if (src.status === 'draft' || src.status === 'published') data.status = src.status;
    else errors.status = 'invalid_status';
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
  return { data, errors };
}
