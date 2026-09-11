/**
 * Stateless sessions: an HMAC-signed cookie carrying the user id, a session
 * epoch and timestamps. Nothing is stored server-side, so restarts and multiple
 * instances need no shared store.
 *
 * Revocation works through two checks the API makes on every request, against
 * Directus itself: the account must still be `active`, and the cookie's epoch
 * must equal the user's `qrv_session_epoch` — bumped whenever a password is set,
 * which signs that account out everywhere.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'qrv_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A cookie older than this is re-issued on use, so active people stay signed in. */
export const SESSION_RENEW_MS = 24 * 60 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function createSessionCodec(secret, { ttlMs = SESSION_TTL_MS } = {}) {
  if (!secret || String(secret).length < 16) throw new Error('session secret must be at least 16 characters');
  const mac = (data) => createHmac('sha256', secret).update(data).digest();

  function sign({ uid, epoch = 0 }, now = Date.now()) {
    const payload = b64url(JSON.stringify({ uid, ep: epoch, iat: now, exp: now + ttlMs }));
    return `${payload}.${b64url(mac(payload))}`;
  }

  /** The payload, or null for anything forged, malformed or expired. */
  function verify(token, now = Date.now()) {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = mac(payload);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof data.uid !== 'string' || typeof data.exp !== 'number' || data.exp <= now) return null;
      return { uid: data.uid, epoch: Number(data.ep) || 0, iat: Number(data.iat) || 0, exp: data.exp };
    } catch {
      return null;
    }
  }

  return { sign, verify, ttlMs };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!(name in out)) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** HttpOnly + SameSite=Lax: unreadable by scripts, not sent on cross-site POSTs. */
export function serializeCookie(value, { secure, maxAgeSec }) {
  const attrs = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
