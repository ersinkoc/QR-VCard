/**
 * The app API — the only door to card and user data.
 *
 * The browser never talks to Directus. It signs in here, gets an HttpOnly session
 * cookie, and every request is authorised by this module before the service token
 * (DIRECTUS_TOKEN) touches Directus. Directus itself grants the public and the
 * vCard roles NOTHING on `vcards`, so a token lifted from a browser — there is none
 * to lift — or a direct API call cannot reach another person's card.
 *
 * Routes (JSON unless noted; every non-GET needs the `X-QRV: 1` header — a custom
 * header cannot be sent cross-site without a CORS preflight, which is never granted):
 *
 *   POST   /api/auth/login              {email, password} -> sets the session cookie
 *   POST   /api/auth/logout
 *   GET    /api/me
 *   PATCH  /api/me                      {email?, first_name?, last_name?}
 *   POST   /api/me/password             {current_password, new_password}
 *
 *   GET    /api/cards?owner=&q=         own cards; admins/editors: all (owner filter)
 *   POST   /api/cards                   create (code optional; owner_id: privileged only)
 *   PATCH  /api/cards/:id
 *   DELETE /api/cards/:id
 *   GET    /api/cards/:id/photo         image
 *   POST   /api/cards/:id/photo         raw image body (jpeg/png/webp, <= 4 MB)
 *   DELETE /api/cards/:id/photo
 *
 *   GET    /api/public/cards/:code      published card, public fields only
 *   GET    /api/public/cards/:code/photo[?format=jpg]
 *
 *   GET    /api/users?q=                admin: accounts with card counts
 *   POST   /api/users                   admin
 *   PATCH  /api/users/:id               admin (role, status, password, profile)
 *   DELETE /api/users/:id?cards=delete|transfer   admin
 *   GET    /api/roles                   admin
 *   GET    /api/audit                   admin: the audit trail (newest first)
 *
 *   GET    /api/health                  server -> Directus reachability + token validity
 *
 * Errors are `{ error: { code, message, fields? } }`; codes are stable and the
 * client translates them.
 */
import { createHmac } from 'node:crypto';
import { canManageCard, canManageUsers, canSeeAllCards, cardScope, roleKind, ROLE_ADMIN } from './access.mjs';
import { createDirectusClient, DirectusError } from './directus-client.mjs';
import { clientKey, createRateLimiter } from './rate-limit.mjs';
import { createSessionCodec, parseCookies, serializeCookie, SESSION_COOKIE, SESSION_RENEW_MS } from './session.mjs';
import { generateCode, UUID_RE, validateCardInput, validateCode, validateExpiresOn, validatePassword, validateUserInput } from './validate.mjs';

const JSON_LIMIT = 64 * 1024;
const PHOTO_LIMIT = 4 * 1024 * 1024;
const USER_CACHE_MS = 10_000;
const EPOCH_FIELD = 'qrv_session_epoch';

const CARD_FIELDS = ['id', 'status', 'code', 'first_name', 'last_name', 'organization', 'job_title', 'phone', 'email', 'website', 'linkedin', 'instagram', 'whatsapp', 'telegram', 'address', 'note', 'accent_color', 'photo', 'photo_style', 'qrv_views', 'is_primary', 'date_created', 'owner'];
/** The card↔collaborator junction (qrv_card_access): rows granting people access to a card. */
const ACCESS_FIELDS = ['id', 'card', 'user', 'expires_on'];
const PUBLIC_FIELDS = ['code', 'first_name', 'last_name', 'organization', 'job_title', 'phone', 'email', 'website', 'linkedin', 'instagram', 'whatsapp', 'telegram', 'address', 'note', 'accent_color', 'photo', 'photo_style'];
const USER_FIELDS = ['id', 'email', 'first_name', 'last_name', 'status', 'last_access', 'username', 'role.id', 'role.name'];
const AUDIT_FIELDS = ['id', 'date_created', 'actor', 'actor_email', 'action', 'target', 'detail'];
const AUDIT_COLLECTION = 'qrv_audit_log';
/** One row per card and UTC day, the panel trend's data source. */
const VIEW_DAYS_COLLECTION = 'qrv_view_days';
const ACCESS_COLLECTION = 'qrv_card_access';
/** The trend chart covers the last N days, today included. */
const VIEW_TREND_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export class ApiError extends Error {
  constructor(status, code, message = code, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

const positiveInt = (v, fallback) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export function apiConfigFromEnv(env = process.env) {
  const directusUrl = (env.DIRECTUS_URL || '').trim();
  const directusToken = (env.DIRECTUS_TOKEN || '').trim();
  let sessionSecret = (env.SESSION_SECRET || '').trim();
  let derivedSecret = false;
  if (!sessionSecret && directusToken) {
    // Stable across restarts without another variable to set; a dedicated
    // SESSION_SECRET is still preferred so rotating the token keeps sessions.
    sessionSecret = createHmac('sha256', 'qr-vcard-session').update(directusToken).digest('hex');
    derivedSecret = true;
  }
  return {
    directusUrl,
    directusToken,
    sessionSecret,
    derivedSecret,
    trustProxy: (env.TRUST_PROXY || env.QR_TRUST_PROXY) === '1',
    cookieSecure: env.COOKIE_SECURE === '1',
    maxCardsPerUser: positiveInt(env.MAX_CARDS_PER_USER, 20),
  };
}

// --- request/response helpers ------------------------------------------------

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload === undefined ? undefined : JSON.stringify(payload));
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError(413, 'PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  // A JSON API should not be fed arbitrary content types; the app always sends
  // application/json. (Empty bodies are still accepted for routes that need none.)
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType && contentType !== 'application/json') throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'expected application/json');
  const raw = await readRaw(req, JSON_LIMIT);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new ApiError(400, 'BAD_JSON');
  }
}

function requestHost(req) {
  const forwarded = req.headers['x-forwarded-host'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? req.headers.host ?? '');
  return String(raw).split(',')[0].trim().toLowerCase().replace(/:(?:80|443)$/, '');
}

function isSecureRequest(req) {
  if (req.socket?.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return proto === 'https';
}

/** JPEG / PNG / WebP by magic bytes — the Content-Type header alone is the client's word. */
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const fail = (fields) => {
  throw new ApiError(400, 'VALIDATION', 'validation failed', fields);
};

// --- DTOs ------

// --- DTOs --------------------------------------------------------------------

function cardDto(row, owners, collaborators) {
  const dto = {};
  for (const f of CARD_FIELDS) if (f !== 'owner' && f !== 'is_primary') dto[f] = row[f] ?? null;
  dto.is_primary = Boolean(row.is_primary);
  dto.qrv_views = Number(row.qrv_views ?? 0) || 0;
  if (owners) {
    const owner = row.owner ? owners.get(row.owner) : null;
    dto.owner = row.owner
      ? { id: row.owner, email: owner?.email ?? null, name: owner ? [owner.first_name, owner.last_name].filter(Boolean).join(' ') || null : null }
      : null;
  }
  if (collaborators) dto.collaborators = collaborators;
  return dto;
}

function publicCardDto(row) {
  const dto = {};
  for (const f of PUBLIC_FIELDS) if (f !== 'photo') dto[f] = row[f] ?? null;
  // The file id doubles as a cache-buster; it grants nothing on its own, because
  // photos are only ever served through this API.
  dto.photo = row.photo ? String(row.photo).slice(0, 8) : null;
  return dto;
}

/**
 * Keeps the newest entry per day, then fills every day from `start` to `end`
 * (inclusive) with a point — `0` where nobody visited. Chart data must be a
 * contiguous window, not the sparse set a sparse traffic log leaves behind.
 */
function fillDays(rows, start, end) {
  const perDay = new Map();
  for (const r of rows) {
    const day = String(r.day ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    perDay.set(day, (perDay.get(day) ?? 0) + (Number(r.views) || 0));
  }
  const series = [];
  const endMs = new Date(`${end}T00:00:00.000Z`).getTime();
  for (let t = new Date(`${start}T00:00:00.000Z`).getTime(); t <= endMs; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    series.push({ day, views: perDay.get(day) ?? 0 });
  }
  return series;
}

function meDto(user) {
  return {
    id: user.id,
    email: user.email,
    first_name: user.first_name ?? null,
    last_name: user.last_name ?? null,
    username: user.username ?? null,
    role: roleKind(user.role?.name),
    role_name: user.role?.name ?? null,
  };
}

function userDto(user, cardCount) {
  return { ...meDto(user), status: user.status, last_access: user.last_access ?? null, card_count: cardCount ?? 0 };
}

// --- the handler -------------------------------------------------------------

export function createApiHandler(config) {
  const directus =
    config.directus ?? (config.directusUrl && config.directusToken ? createDirectusClient({ url: config.directusUrl, token: config.directusToken }) : null);
  const configured = Boolean(directus && config.sessionSecret);
  const codec = configured ? createSessionCodec(config.sessionSecret) : null;
  const trustProxy = config.trustProxy ?? false;
  const maxCardsPerUser = config.maxCardsPerUser ?? 20;
  const now = config.now ?? (() => Date.now());
  const log = config.log ?? console;

  /**
   * Records an administrative action in `qrv_audit_log` — fire-and-forget: an
   * audit failure is logged and swallowed, never fails the user's request.
   * `detail` carries what changed (old → new), never secrets: passwords are
   * not included.
   */
  function audit({ req, actor, action, target, detail }) {
    const entry = {
      actor: actor.id,
      actor_email: actor.email ?? null,
      action,
      target: target ?? null,
      detail: detail ?? null,
    };
    // Promise.resolve().then(): a client that throws synchronously (or any
    // bug in building the call) becomes a rejected promise instead of escaping
    // into — and failing — the user's request.
    Promise.resolve()
      .then(() => directus.request(`/items/${AUDIT_COLLECTION}`, { method: 'POST', body: entry }))
      .catch((err) => {
        log.warn?.(`[api] audit write failed for ${action} by ${actor.email}: ${err?.message ?? err}`);
      });
    void req; // reserved for future request metadata (ip, user-agent)
  }

  const loginPerAccount = createRateLimiter({ max: 8, windowMs: 15 * 60_000 });
  const loginPerClient = createRateLimiter({ max: 40, windowMs: 15 * 60_000 });
  const passwordChecks = createRateLimiter({ max: 8, windowMs: 15 * 60_000 });

  const userCache = new Map();
  let epochSupported = true;
  let serviceUserId = null;

  // View counting needs the `qrv_views` column. Installs that have not yet
  // re-run bootstrap would fail every card query that selects it, so the first
  // complaint about the field degrades the selection (like epochSupported
  // above) and counting turns itself off with a pointer to bootstrap.
  let fieldsForCards = [...CARD_FIELDS];
  let viewsSupported = true;
  // `directus_users.username` (the /<username> short URL) degrades like the
  // view fields: missing column → one warning, usernames resolve to nothing,
  // /c/<code> keeps working.
  let userByUsernameSupported = true;
  // The daily trend needs the `qrv_view_days` collection. Like `qrv_views`
  // above, an install that has not re-run bootstrap degrades gracefully:
  // totals keep counting, only the series turns off (with one warning).
  let viewDaysSupported = true;
  // Card sharing (qrv_card_access) degrades like the other optional schema:
  // missing collection → one warning, cards keep working unshared.
  let accessSupported = true;
  function noteAccessUnsupported(err) {
    accessSupported = false;
    log.warn?.(`[api] ${ACCESS_COLLECTION} is missing — re-run npm run directus:bootstrap; card sharing is off (${err?.message ?? err})`);
  }
  function noteViewDaysUnsupported(err) {
    viewDaysSupported = false;
    log.warn?.(`[api] ${VIEW_DAYS_COLLECTION} is missing — re-run npm run directus:bootstrap; the daily scan trend is off (${err?.message ?? err})`);
  }
  async function cardsRequest(path, { method = 'GET', query, body } = {}) {
    try {
      return await directus.request(path, { method, query, body });
    } catch (err) {
      if (viewsSupported && err instanceof DirectusError && String(err.message).includes('qrv_views')) {
        viewsSupported = false;
        fieldsForCards = fieldsForCards.filter((f) => f !== 'qrv_views');
        log.warn?.('[api] vcards.qrv_views is missing — re-run npm run directus:bootstrap; view counting is off');
        if (query?.fields) query.fields = query.fields.filter((f) => f !== 'qrv_views');
        return directus.request(path, { method, query, body });
      }
      throw err;
    }
  }

  // ---- Directus access helpers ----

  async function fetchUser(id) {
    const fields = epochSupported ? [...USER_FIELDS, EPOCH_FIELD] : USER_FIELDS;
    try {
      const rows = await directus.request('/users', { query: { fields, filter: { id: { _eq: id } }, limit: 1 } });
      return rows?.[0] ?? null;
    } catch (err) {
      // Installs bootstrapped before the epoch field existed: keep working
      // without "sign out everywhere" rather than locking everyone out.
      if (epochSupported && err instanceof DirectusError && String(err.message).includes(EPOCH_FIELD)) {
        epochSupported = false;
        log.warn?.(`[api] directus_users.${EPOCH_FIELD} is missing — re-run npm run directus:bootstrap; password changes will not revoke other sessions`);
        return fetchUser(id);
      }
      throw err;
    }
  }

  async function loadUser(id, { fresh = false } = {}) {
    const hit = userCache.get(id);
    if (!fresh && hit && now() - hit.at < USER_CACHE_MS) return hit.user;
    const user = await fetchUser(id);
    if (user) userCache.set(id, { user, at: now() });
    else userCache.delete(id);
    return user;
  }

  async function getServiceUserId() {
    if (!serviceUserId) serviceUserId = (await directus.request('/users/me', { query: { fields: ['id'] } }))?.id ?? null;
    return serviceUserId;
  }

  async function findCard(id, fields) {
    if (!UUID_RE.test(id)) return null;
    const rows = await cardsRequest('/items/vcards', { query: { fields: fields ?? fieldsForCards, filter: { id: { _eq: id } }, limit: 1 } });
    return rows?.[0] ?? null;
  }

  /** The card, if it exists AND `actor` may manage it; a foreign card is a 404, not a 403. */
  async function managedCard(id, actor, fields) {
    const card = await findCard(id, fields);
    if (!card) throw new ApiError(404, 'NOT_FOUND');
    // Static rule first (privileged / owner), then the share grant: a plain
    // user with a qrv_card_access row manages the card like its owner —
    // except destructive/share operations, gated separately by canShareCard.
    if (canManageCard(card, actor)) return card;
    if (accessSupported && (await collaboratorsOf(card.id)).includes(actor.id)) return card;
    throw new ApiError(404, 'NOT_FOUND');
  }

  async function ownersFor(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await directus.request('/users', {
      query: { fields: ['id', 'email', 'first_name', 'last_name'], filter: { id: { _in: unique } }, limit: -1 },
    });
    return new Map((rows ?? []).map((u) => [u.id, u]));
  }

  async function countCards(ownerId) {
    const rows = await directus.request('/items/vcards', { query: { aggregate: { count: '*' }, filter: { owner: { _eq: ownerId } } } });
    return Number(rows?.[0]?.count ?? 0);
  }

  async function deleteFileQuietly(fileId) {
    if (!fileId) return;
    try {
      await directus.request(`/files/${fileId}`, { method: 'DELETE' });
    } catch (err) {
      log.warn?.(`[api] could not delete file ${fileId}: ${err?.message ?? err}`);
    }
  }

  async function activeAdminIds() {
    const rows = await directus.request('/users', {
      query: { fields: ['id'], filter: { role: { name: { _eq: ROLE_ADMIN } }, status: { _eq: 'active' } }, limit: -1 },
    });
    const service = await getServiceUserId();
    return (rows ?? []).map((u) => u.id).filter((id) => id !== service);
  }

  async function assertRole(roleId) {
    const rows = await directus.request('/roles', { query: { fields: ['id', 'name'], filter: { id: { _eq: roleId } }, limit: 1 } });
    if (!rows?.[0]) fail({ role: 'invalid_role' });
    return rows[0];
  }

  /** Validates credentials against Directus, then drops the Directus session at once. */
  async function checkPassword(email, password) {
    let tokens;
    try {
      tokens = await directus.request('/auth/login', { method: 'POST', auth: null, body: { email, password } });
    } catch (err) {
      if (err instanceof DirectusError && (err.status === 401 || err.status === 400)) return null;
      throw err;
    }
    const me = await directus.request('/users/me', { auth: tokens.access_token, query: { fields: ['id'] } });
    if (tokens.refresh_token) {
      directus.request('/auth/logout', { method: 'POST', auth: null, body: { refresh_token: tokens.refresh_token, mode: 'json' } }).catch(() => {});
    }
    return me?.id ?? null;
  }

  // ---- session helpers ----

  function setSession(req, res, user) {
    const token = codec.sign({ uid: user.id, epoch: Number(user[EPOCH_FIELD]) || 0 }, now());
    const secure = config.cookieSecure || isSecureRequest(req);
    res.setHeader('Set-Cookie', serializeCookie(token, { secure, maxAgeSec: Math.floor(codec.ttlMs / 1000) }));
  }

  function clearSession(req, res) {
    res.setHeader('Set-Cookie', serializeCookie('', { secure: config.cookieSecure || isSecureRequest(req), maxAgeSec: 0 }));
  }

  async function authenticate(req, res) {
    const session = codec.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE], now());
    if (!session) return null;
    const user = await loadUser(session.uid);
    if (!user) {
      // The account is gone: also drop the cookie, so the browser stops offering it.
      clearSession(req, res);
      return null;
    }
    const epochOk = !epochSupported || (Number(user?.[EPOCH_FIELD]) || 0) === session.epoch;
    if (user.status !== 'active' || !epochOk || user.id === (await getServiceUserId())) {
      clearSession(req, res);
      return null;
    }
    if (now() - session.iat > SESSION_RENEW_MS) setSession(req, res, user);
    return { id: user.id, email: user.email, kind: roleKind(user.role?.name), user };
  }

  // ---- route handlers ----

  async function login({ req, res }) {
    const body = await readJson(req);
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!email || !password) fail({ ...(email ? {} : { email: 'required' }), ...(password ? {} : { password: 'required' }) });

    const client = clientKey(req, trustProxy);
    const perClient = loginPerClient.hit(client, now());
    const perAccount = loginPerAccount.hit(`${client}|${email}`, now());
    const limited = perClient.limited ? perClient : perAccount.limited ? perAccount : null;
    if (limited) {
      sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: 'too many attempts', retry_after: limited.retryAfterSec } }, { 'Retry-After': String(limited.retryAfterSec) });
      return;
    }

    const id = await checkPassword(email, password);
    const user = id ? await loadUser(id, { fresh: true }) : null;
    if (!user || user.status !== 'active' || user.id === (await getServiceUserId())) {
      throw new ApiError(401, 'INVALID_CREDENTIALS');
    }
    loginPerAccount.reset(`${client}|${email}`);
    setSession(req, res, user);
    sendJson(res, 200, { data: meDto(user) });
  }

  async function logout({ req, res }) {
    clearSession(req, res);
    sendJson(res, 200, { data: null });
  }

  async function getMe({ res, actor }) {
    sendJson(res, 200, { data: meDto(actor.user) });
  }

  async function patchMe({ req, res, actor }) {
    const body = await readJson(req);
    const candidate = {};
    if ('email' in body) candidate.email = body.email;
    if ('first_name' in body) candidate.first_name = body.first_name;
    if ('last_name' in body) candidate.last_name = body.last_name;
    if ('username' in body) candidate.username = body.username;
    const { data, errors } = validateUserInput(candidate, { partial: true });
    if (Object.keys(errors).length) fail(errors);

    if (data.username && data.username !== actor.user.username) {
      await assertUsernameAvailable(data.username, { exceptUserId: actor.id });
    }

    if (data.email && data.email !== actor.email) {
      const existing = await directus.request('/users', {
        query: {
          filter: { email: { _eq: data.email }, id: { _neq: actor.id } },
          fields: ['id'],
          limit: 1,
        },
      });
      if (existing && existing.length > 0) {
        throw new ApiError(409, 'EMAIL_TAKEN', 'email already in use', { email: 'email_taken' });
      }
    }

    try {
      await directus.request(`/users/${actor.id}`, { method: 'PATCH', body: data });
    } catch (err) {
      throw mapUniqueUserField(err, data);
    }
    userCache.delete(actor.id);
    if (data.username) await ensurePrimary(actor.id);
    sendJson(res, 200, { data: meDto(await loadUser(actor.id, { fresh: true })) });
  }

  async function changeMyPassword({ req, res, actor }) {
    const body = await readJson(req);
    const problem = validatePassword(body.new_password);
    if (problem) fail({ new_password: problem });
    const limited = passwordChecks.hit(actor.id, now());
    if (limited.limited) throw new ApiError(429, 'RATE_LIMITED');
    if ((await checkPassword(actor.email, String(body.current_password ?? ''))) !== actor.id) {
      throw new ApiError(400, 'WRONG_PASSWORD', 'current password is wrong', { current_password: 'wrong_password' });
    }
    const patch = { password: body.new_password };
    if (epochSupported) patch[EPOCH_FIELD] = (Number(actor.user[EPOCH_FIELD]) || 0) + 1;
    await directus.request(`/users/${actor.id}`, { method: 'PATCH', body: patch });
    audit({ req, actor, action: 'password.change', target: actor.email });
    // Every other device is signed out by the epoch bump; this one keeps going.
    setSession(req, res, await loadUser(actor.id, { fresh: true }));
    sendJson(res, 200, { data: null });
  }

  async function listCards({ res, url, actor }) {
    const privileged = canSeeAllCards(actor.kind);
    const filters = [];
    const scope = cardScope(actor);
    if (scope) filters.push(scope);
    const owner = url.searchParams.get('owner');
    if (privileged && owner) {
      if (!UUID_RE.test(owner)) fail({ owner: 'invalid' });
      filters.push({ owner: { _eq: owner } });
    }
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
    let rows =
      (await cardsRequest('/items/vcards', {
        query: {
          fields: fieldsForCards,
          sort: ['-date_created'],
          limit: 1000,
          ...(filters.length ? { filter: filters.length === 1 ? filters[0] : { _and: filters } } : {}),
          ...(q ? { search: q } : {}),
        },
      })) ?? [];
    // A plain user also sees cards shared with them. Privileged actors already
    // see everything; the owner filter keeps working on the union.
    if (!privileged && accessSupported) {
      const sharedIds = await sharedCardIds(actor.id);
      const missing = sharedIds.filter((id) => !rows.some((r) => r.id === id));
      if (missing.length) {
        const shared = (await cardsRequest('/items/vcards', {
          query: { fields: fieldsForCards, filter: { id: { _in: missing } }, sort: ['-date_created'], limit: 1000 },
        })) ?? [];
        rows = [...rows, ...shared];
      }
    }
    const owners = privileged || rows.some((r) => r.owner !== actor.id) ? await ownersFor(rows.map((r) => r.owner)) : null;
    // One aggregate for the whole page: how many people share each card (the
    // badge); the full list comes from GET /api/cards/:id/shares on demand.
    let shareCounts = new Map();
    if (accessSupported && rows.length) {
      try {
        const counts = await accessRequest(`/items/${ACCESS_COLLECTION}`, {
          query: {
            aggregate: { count: '*' },
            groupBy: ['card'],
            filter: { card: { _in: rows.map((r) => r.id) }, _or: [{ expires_on: { _null: true } }, { expires_on: { _gte: todayUtc() } }] },
            limit: -1,
          },
        });
        shareCounts = new Map((counts ?? []).map((c) => [c.card, Number(c.count ?? 0)]));
      } catch {
        /* the badge is cosmetic — never fail the listing for it */
      }
    }
    sendJson(res, 200, { data: rows.map((r) => {
      const dto = cardDto(r, owners);
      const n = shareCounts.get(r.id);
      if (n) dto.collaborator_count = n;
      return dto;
    }) });
  }

  async function resolveOwner(body, actor) {
    if (body.owner_id === undefined || body.owner_id === null || body.owner_id === '') return null;
    if (!canSeeAllCards(actor.kind)) throw new ApiError(403, 'FORBIDDEN', 'only admins can assign an owner');
    const id = String(body.owner_id);
    if (!UUID_RE.test(id) || !(await loadUser(id, { fresh: true }))) fail({ owner_id: 'invalid' });
    return id;
  }

  async function createCard({ req, res, actor }) {
    const body = await readJson(req);
    const { data, errors } = validateCardInput(body);
    let customCode = null;
    if (body.code !== undefined && body.code !== null && String(body.code).trim() !== '') {
      customCode = String(body.code).trim();
      const problem = validateCode(customCode);
      if (problem) errors.code = problem;
    }
    if (Object.keys(errors).length) fail(errors);

    const ownerId = (await resolveOwner(body, actor)) ?? actor.id;
    if (!canSeeAllCards(actor.kind) && (await countCards(actor.id)) >= maxCardsPerUser) {
      throw new ApiError(409, 'CARD_LIMIT', `at most ${maxCardsPerUser} cards per account`, { max: String(maxCardsPerUser) });
    }

    // owner is written explicitly: the service token would otherwise be
    // stamped as the creator, and the card would belong to nobody real.
    const base = { status: 'draft', accent_color: '#4f46e5', is_primary: false, ...data, owner: ownerId };
    // A user's first card becomes their primary automatically: the /<username>
    // short URL must answer something the moment it exists.
    const isFirstCard = !canSeeAllCards(actor.kind) ? (await countCards(actor.id)) === 0 : null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = customCode ?? generateCode();
      try {
        const created = await directus.request('/items/vcards', { method: 'POST', body: { ...base, code }, query: { fields: CARD_FIELDS } });
        if (created.is_primary || (isFirstCard === true && !(await anyPrimaryCard(ownerId)))) {
          await setPrimaryCard(ownerId, created.id);
          created.is_primary = true;
        }
        const owners = canSeeAllCards(actor.kind) ? await ownersFor([created.owner]) : null;
        sendJson(res, 201, { data: cardDto(created, owners) });
        return;
      } catch (err) {
        const duplicate = err instanceof DirectusError && err.code === 'RECORD_NOT_UNIQUE';
        if (!duplicate) throw err;
        if (customCode) throw new ApiError(409, 'CODE_TAKEN', 'code already in use', { code: 'code_taken' });
      }
    }
    throw new ApiError(500, 'INTERNAL', 'could not allocate a unique code');
  }

  async function updateCard({ req, res, actor, params }) {
    const card = await managedCard(params.id, actor);
    const body = await readJson(req);
    const { data, errors } = validateCardInput(body, { partial: true });
    if (Object.keys(errors).length) fail(errors);
    const ownerId = await resolveOwner(body, actor);
    if (ownerId) {
      // Reassigning a card is ownership-level, like deleting: a collaborator
      // (who by definition is not the owner) cannot give the card away.
      if (!canShareCard(card, actor)) throw new ApiError(403, 'FORBIDDEN', 'only the owner can reassign a shared card');
      data.owner = ownerId;
    }
    const updated = Object.keys(data).length
      ? await directus.request(`/items/vcards/${card.id}`, { method: 'PATCH', body: data, query: { fields: CARD_FIELDS } })
      : card;
    // Claiming or re-pointing the /<username> URL at this card.
    if (updated.is_primary && !card.is_primary) await setPrimaryCard(updated.owner, updated.id);
    const owners = canSeeAllCards(actor.kind) ? await ownersFor([updated.owner]) : null;
    sendJson(res, 200, { data: cardDto(updated, owners) });
  }

  async function deleteCard({ req, res, actor, params }) {
    const card = await managedCard(params.id, actor);
    // A collaborator can edit but not destroy: deletion is the owner's (or a
    // privileged actor's) call — same rule as changing the share list.
    if (!canShareCard(card, actor)) throw new ApiError(403, 'FORBIDDEN', 'only the owner can delete a shared card');
    await directus.request(`/items/vcards/${card.id}`, { method: 'DELETE' });
    await deleteFileQuietly(card.photo);
    if (card.is_primary) await promotePrimary(card.owner);
    audit({ req, actor, action: 'card.delete', target: card.code, detail: `name: ${[card.first_name, card.last_name].filter(Boolean).join(' ') || card.organization || '—'}, owner: ${card.owner ?? 'none'}` });
    sendJson(res, 200, { data: null });
  }

  /**
   * A photo is cropped to a square (`cover`); a logo keeps its shape (`inside`).
   * JPEG has no transparency, so a logo headed for the vCard is flattened on white
   * rather than on the encoder's default black.
   */
  async function streamPhoto(res, card, { format, cache }) {
    const jpg = format === 'jpg';
    const logo = card.photo_style === 'logo';
    const upstream = await directus.request(`/assets/${card.photo}`, {
      raw: true,
      query: {
        width: 512,
        height: 512,
        fit: logo ? 'inside' : 'cover',
        quality: 82,
        format: jpg ? 'jpg' : 'webp',
        ...(jpg ? { transforms: JSON.stringify([['flatten', { background: '#ffffff' }]]) } : {}),
      },
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }

  async function getCardPhoto({ res, url, actor, params }) {
    const card = await managedCard(params.id, actor, fieldsForCards);
    if (!card.photo) throw new ApiError(404, 'NOT_FOUND');
    await streamPhoto(res, card, { format: url.searchParams.get('format'), cache: 'private, max-age=300' });
  }

  async function uploadCardPhoto({ req, res, actor, params }) {
    const card = await managedCard(params.id, actor, fieldsForCards);
    const buf = await readRaw(req, PHOTO_LIMIT).catch((err) => {
      if (err instanceof ApiError && err.code === 'PAYLOAD_TOO_LARGE') throw new ApiError(413, 'PHOTO_TOO_LARGE');
      throw err;
    });
    const type = sniffImage(buf);
    if (!type) throw new ApiError(415, 'PHOTO_TYPE', 'use a JPEG, PNG or WebP image');

    const form = new FormData();
    form.append('title', `vcard ${card.code}`);
    form.append('file', new Blob([buf], { type }), `vcard-${card.code}.${PHOTO_TYPES[type]}`);
    const file = await directus.request('/files', { method: 'POST', body: form });
    const updated = await directus.request(`/items/vcards/${card.id}`, { method: 'PATCH', body: { photo: file.id }, query: { fields: CARD_FIELDS } });
    await deleteFileQuietly(card.photo);
    const owners = canSeeAllCards(actor.kind) ? await ownersFor([updated.owner]) : null;
    sendJson(res, 200, { data: cardDto(updated, owners) });
  }

  async function deleteCardPhoto({ res, actor, params }) {
    const card = await managedCard(params.id, actor, fieldsForCards);
    const updated = await directus.request(`/items/vcards/${card.id}`, { method: 'PATCH', body: { photo: null }, query: { fields: CARD_FIELDS } });
    await deleteFileQuietly(card.photo);
    const owners = canSeeAllCards(actor.kind) ? await ownersFor([updated.owner]) : null;
    sendJson(res, 200, { data: cardDto(updated, owners) });
  }

  async function publishedByCode(code) {
    if (!/^[A-Za-z0-9-]{1,32}$/.test(code)) return null;
    // qrv_views rides along (stripped again by publicCardDto) so the view
    // counter can increment the value it just saw without a second read.
    const rows = await cardsRequest('/items/vcards', {      query: { fields: [...PUBLIC_FIELDS, 'qrv_views'], filter: { code: { _eq: code }, status: { _eq: 'published' } }, limit: 1 },
    });
  return rows?.[0] ?? null;
}

  /**
   * The published card a `/<username>` visit resolves to: the owner's primary
   * card when it is published, else their oldest published card. Defensive
   * about the flag (a torn is_primary lifecycle must not 500 a visitor) and
   * about installs that never re-ran bootstrap (no username column → null).
   */
  async function publishedByUsername(username) {
    if (!username || !/^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/.test(username)) return null;
    let userRows;
    try {
      userRows = await directus.request('/users', { query: { fields: ['id', 'username'], filter: { username: { _eq: username } }, limit: 1 } });
    } catch (err) {
      if (err instanceof DirectusError && String(err.message).includes('username')) {
        userByUsernameSupported = false;
        log.warn?.('[api] directus_users.username is missing — re-run npm run directus:bootstrap; /<username> URLs are off');
        return null;
      }
      throw err;
    }
    const user = userRows?.[0];
    if (!user) return null;
    const rows = await cardsRequest('/items/vcards', {
      query: {
        fields: [...PUBLIC_FIELDS, 'qrv_views', 'is_primary', 'date_created'],
        filter: { owner: { _eq: user.id }, status: { _eq: 'published' } },
        sort: ['-is_primary', 'date_created'],
        limit: 2,
      },
    });
    // Prefer the flagged primary, but never trust it exclusively: if it is not
    // among the published cards (or two rows claim it), the oldest published
    // card answers.
    return rows?.find((r) => r.is_primary) ?? rows?.[0] ?? null;
  }

  /** Public card behind /<username>: same shape as a code visit. */
  async function getPublicUserCard({ req, res, params }) {
    // Usernames are stored lowercase; a typed /Ada must still resolve.
    const card = await publishedByUsername(String(params.username ?? '').toLowerCase());
    if (!card) throw new ApiError(404, 'NOT_FOUND');
    if (!(await authenticate(req, res))) countCardView(card);
    sendJson(res, 200, { data: publicCardDto(card) });
  }

/**
 * The UTC calendar day (YYYY-MM-DD) a visit belongs to. QRV_TZ lets an install
 * count local days instead ("the card was scanned before breakfast here"), at
 * the cost of day boundaries drifting from UTC.
 */
function viewDay(nowMs) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.QRV_TZ || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(nowMs));
}

function dayString(msOrDate) {
  return viewDay(typeof msOrDate === 'number' ? msOrDate : msOrDate.getTime());
}

  /**
   * Counts a public page view. Fire-and-forget: an increment that fails (or a
   * missing `qrv_views` column on an install that has not re-run bootstrap)
   * must never delay or break the visitor's response.
   *
   * The value seen by the visitor's own fetch is incremented — one PATCH, no
   * extra read. The counter is deliberately approximate: two visitors landing
   * in the same instant can overwrite each other's increment, which is fine
   * for an analytics gauge (Directus' REST API has no atomic arithmetic).
   */
  /**
   * The trend's write path: today's row is read and written +1 (or created
   * with 1) — two background requests, never on the visitor's path. Directus
   * has no atomic arithmetic, so two same-instant first visitors can overwrite
   * each other (a lost +1, or a duplicate row) — the same accepted
   * approximation as the total counter.
   */
  function upsertViewDay(cardId, code, nowMs) {
    if (!viewDaysSupported) return;
    const day = viewDay(nowMs);
    Promise.resolve()
      .then(async () => {
        const rows = await directus.request(`/items/${VIEW_DAYS_COLLECTION}`, {
          query: { fields: ['id', 'views'], filter: { card: { _eq: cardId }, day: { _eq: day } }, limit: 1 },
        });
        const row = rows?.[0];
        if (row) {
          await directus.request(`/items/${VIEW_DAYS_COLLECTION}/${row.id}`, { method: 'PATCH', body: { views: (Number(row.views) || 0) + 1 } });
        } else {
          await directus.request(`/items/${VIEW_DAYS_COLLECTION}`, { method: 'POST', body: { card: cardId, day, views: 1 } });
        }
      })
      .catch((err) => {
        if (err instanceof DirectusError && (String(err.message).includes(VIEW_DAYS_COLLECTION) || err.code === 'FORBIDDEN' || err.code === 'INVALID_QUERY' || err.code === 'INVALID_PAYLOAD')) {
          noteViewDaysUnsupported(err);
          return;
        }
        log.warn?.(`[api] view day write failed for ${code}: ${err?.message ?? err}`);
      });
  }

  function countCardView(card) {
    if (!viewsSupported) return;
    const { code } = card;
    const nowMs = now();
    Promise.resolve()
      .then(async () => {
        // The value seen by the visitor's own fetch is incremented — one PATCH,
        // no extra read. Deliberately approximate (two visitors landing in the
        // same instant can overwrite each other's increment), fine for a gauge.
        await directus.request('/items/vcards', {
          method: 'PATCH',
          body: { query: { filter: { code: { _eq: code } } }, data: { qrv_views: (Number(card.qrv_views) || 0) + 1 } },
        });
        upsertViewDay(card.id, code, nowMs);
      })
      .catch((err) => {
        if (err instanceof DirectusError && String(err.message).includes('qrv_views')) {
          viewsSupported = false;
          fieldsForCards = fieldsForCards.filter((f) => f !== 'qrv_views');
          log.warn?.('[api] vcards.qrv_views is missing — re-run npm run directus:bootstrap; view counting is off');
          return;
        }
        log.warn?.(`[api] view count failed for ${code}: ${err?.message ?? err}`);
      });
  }

  async function getPublicCard({ req, res, params }) {
    const card = await publishedByCode(params.code);
    if (!card) throw new ApiError(404, 'NOT_FOUND');
    // Signed-in panel previews do not inflate the public counter; only an
    // anonymous visit — a real scan of the printed QR code — counts.
    if (!(await authenticate(req, res))) countCardView(card);
    sendJson(res, 200, { data: publicCardDto(card) });
  }

  async function getPublicPhoto({ res, url, params }) {
    const card = await publishedByCode(params.code);
    if (!card?.photo) throw new ApiError(404, 'NOT_FOUND');
    await streamPhoto(res, card, { format: url.searchParams.get('format'), cache: 'public, max-age=300' });
  }

  async function listUsers({ res, url }) {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
    const service = await getServiceUserId();
    const [rows, counts] = await Promise.all([
      directus.request('/users', { query: { fields: USER_FIELDS, sort: ['email'], limit: -1, ...(q ? { search: q } : {}) } }),
      directus.request('/items/vcards', { query: { aggregate: { count: '*' }, groupBy: ['owner'], limit: -1 } }),
    ]);
    const countBy = new Map((counts ?? []).map((c) => [c.owner, Number(c.count ?? 0)]));
    sendJson(res, 200, { data: (rows ?? []).filter((u) => u.id !== service).map((u) => userDto(u, countBy.get(u.id))) });
  }

  /**
   * The share list of a card. Readable by anyone who can manage the card
   * (owner, collaborator, privileged) — you can see who you work with.
   */
  /** Writes (or clears) one person's share expiry, honouring the unique pair. */
  async function setShareExpiry(cardId, userId, expiresOn) {
    const rows = await accessRequest(`/items/${ACCESS_COLLECTION}`, {
      query: { fields: ACCESS_FIELDS, filter: { card: { _eq: cardId }, user: { _eq: userId } }, limit: 1 },
    });
    const row = rows?.[0];
    if (!row) return;
    await accessRequest(`/items/${ACCESS_COLLECTION}/${row.id}`, { method: 'PATCH', body: { expires_on: expiresOn } });
  }

  /**
   * Sets or clears (null) one collaborator's expiry. Owner or privileged only.
   * This is the extend/shorten path — no delete + re-add needed.
   */
  async function patchCardShare({ req, res, actor, params }) {
    const card = await managedCard(params.id, actor);
    if (!canShareCard(card, actor)) throw new ApiError(403, 'FORBIDDEN', 'only the owner can change sharing of this card');
    const userId = String(params.userId ?? '');
    if (!UUID_RE.test(userId)) fail({ user_id: 'invalid' });
    const body = await readJson(req);
    if (!('expires_on' in body)) fail({ expires_on: 'required' });
    const { value, error } = validateExpiresOn(body.expires_on);
    if (error) fail({ expires_on: error });
    const known = await loadUser(userId, { fresh: true });
    if (!known) throw new ApiError(404, 'NOT_FOUND');
    await setShareExpiry(card.id, userId, value);
    audit({ req, actor, action: 'card.share', target: card.code, detail: `expiry for: ${known.email} → ${value ?? 'none'}` });
    sendJson(res, 200, { data: await shareDto(card.id) });
  }

  async function listCardShares({ res, actor, params }) {
    const card = await managedCard(params.id, actor);
    sendJson(res, 200, { data: await shareDto(card.id) });
  }

  /**
   * Grants access: POST { email } (recommended — the UI flow) or { user_id }.
   * Owner or privileged only. Sharing to yourself is a no-op (201, no row);
   * the owner can never be a collaborator on their own card.
   */
  async function addCardShare({ req, res, actor, params }) {
    const card = await managedCard(params.id, actor);
    if (!canShareCard(card, actor)) throw new ApiError(403, 'FORBIDDEN', 'only the owner can share this card');
    const body = await readJson(req);
    let target = null;
    if (body.user_id !== undefined && body.user_id !== null && body.user_id !== '') {
      if (!UUID_RE.test(String(body.user_id))) fail({ user_id: 'invalid' });
      target = await loadUser(String(body.user_id), { fresh: true });
    } else {
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!email) fail({ email: 'required' });
      const rows = await directus.request('/users', { query: { fields: ['id'], filter: { email: { _eq: email } }, limit: 1 } });
      target = rows?.[0] ? await loadUser(rows[0].id, { fresh: true }) : null;
    }
    if (!target || target.id === (await getServiceUserId())) throw new ApiError(404, 'NOT_FOUND', 'no such account');
    if (target.status !== 'active') fail({ email: 'suspended' });
    if (target.id === card.owner) fail({ email: 'is_owner' });
    const { value: expiresOn, error: expiryError } = validateExpiresOn(body.expires_on);
    if (expiryError) fail({ expires_on: expiryError });
    const active = await collaboratorsOf(card.id);
    if (active.includes(target.id)) {
      // Idempotent re-share — but an explicit expiry still updates the row.
      if (expiresOn !== null || body.expires_on !== undefined) await setShareExpiry(card.id, target.id, expiresOn);
      sendJson(res, 200, { data: await shareDto(card.id) });
      return;
    }
    const rowBody = { card: card.id, user: target.id, ...(expiresOn ? { expires_on: expiresOn } : {}) };
    try {
      await accessRequest(`/items/${ACCESS_COLLECTION}`, { method: 'POST', body: rowBody });
    } catch (err) {
      // Lost a race — or the person's earlier share has already expired and
      // the unique (card,user) pair still holds: revive the dormant row.
      if (!(err instanceof DirectusError && err.code === 'RECORD_NOT_UNIQUE')) throw err;
      await setShareExpiry(card.id, target.id, expiresOn);
    }
    audit({ req, actor, action: 'card.share', target: card.code, detail: `shared with: ${target.email}${expiresOn ? `, until: ${expiresOn}` : ''}` });
    sendJson(res, 201, { data: await shareDto(card.id) });
  }

  /** Revokes one collaborator's access. Owner or privileged only. */
  async function removeCardShare({ req, res, actor, params }) {
    const card = await managedCard(params.id, actor);
    if (!canShareCard(card, actor)) throw new ApiError(403, 'FORBIDDEN', 'only the owner can change sharing of this card');
    const userId = String(params.userId ?? '');
    if (!UUID_RE.test(userId)) fail({ user_id: 'invalid' });
    await accessRequest(`/items/${ACCESS_COLLECTION}`, {
      method: 'DELETE',
      body: { query: { filter: { card: { _eq: card.id }, user: { _eq: userId } } } },
    });
    const who = await loadUser(userId, { fresh: true });
    audit({ req, actor, action: 'card.unshare', target: card.code, detail: `unshared from: ${who?.email ?? userId}` });
    sendJson(res, 200, { data: await shareDto(card.id) });
  }

  async function listRoles({ res }) {
    const rows = await directus.request('/roles', { query: { fields: ['id', 'name'], sort: ['name'], limit: -1 } });
    sendJson(res, 200, { data: (rows ?? []).map((r) => ({ id: r.id, name: r.name, kind: roleKind(r.name) })) });
  }

  async function listAudit({ res, url }) {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
    const rows =
      (await directus.request(`/items/${AUDIT_COLLECTION}`, {
        query: {
          fields: AUDIT_FIELDS,
          sort: ['-date_created'],
          limit: 200,
          ...(q ? { search: q } : {}),
        },
      })) ?? [];
    sendJson(res, 200, { data: rows });
  }

  /**
   * Daily public-view totals for the last `days` days (default 30, max 90),
   * today included. A day without traffic still appears with `0` — charts
   * need holes filled, not gaps. Directus aggregates server-side (sum by day),
   * so raw rows never leave the database. Admins and editors only: a plain
   * user's trend would just be their own cards' — a misread “site traffic”.
   */
  async function getCardViews({ res, url, actor }) {
    if (!canSeeAllCards(actor.kind)) throw new ApiError(403, 'FORBIDDEN', 'the scan trend is an admin and editor view');
    if (!viewDaysSupported) throw new ApiError(501, 'NOT_SUPPORTED', 'the daily scan trend is unavailable — re-run npm run directus:bootstrap');

    const days = Math.min(Math.max(Number.parseInt(url.searchParams.get('days') ?? '', 10) || VIEW_TREND_DAYS, 1), 90);
    const start = dayString(now() - (days - 1) * DAY_MS);
    let rows;
    try {
      rows = (await directus.request(`/items/${VIEW_DAYS_COLLECTION}`, {
        // Directus aggregate form: aggregate[<fn>]=<field> → rows shaped
        // { day, sum: { views } }.
        query: { aggregate: { sum: ['views'] }, groupBy: ['day'], filter: { day: { _gte: start } }, sort: ['day'], limit: -1 },
      })) ?? [];
    } catch (err) {
      if (err instanceof DirectusError && String(err.message).includes(VIEW_DAYS_COLLECTION)) {
        noteViewDaysUnsupported(err);
        throw new ApiError(501, 'NOT_SUPPORTED', 'the daily scan trend is unavailable — re-run npm run directus:bootstrap');
      }
      throw err;
    }
    // Aggregate rows came back; shape the sum robustly (Directus versions
    // nest it differently: { views } flat or { sum: { views } }).
    const series = fillDays(
      rows.map((r) => ({ day: r.day, views: r.views?.sum ?? r.sum?.views ?? r.views })),
      start,
      dayString(now()),
    );
    sendJson(res, 200, { data: { start, days: series.length, total: series.reduce((sum, p) => sum + p.views, 0), series } });
  }

  function mapUniqueEmail(err) {
    if (
      err instanceof DirectusError &&
      (err.code === 'RECORD_NOT_UNIQUE' || /unique/i.test(err.message) || /already exists/i.test(err.message))
    ) {
      return new ApiError(409, 'EMAIL_TAKEN', 'email already in use', { email: 'email_taken' });
    }
    return err;
  }

  /** Same as mapUniqueEmail, but for the username unique index. */
  function mapUniqueUsername(err) {
    if (
      err instanceof DirectusError &&
      (err.code === 'RECORD_NOT_UNIQUE' || /unique/i.test(err.message) || /already exists/i.test(err.message))
    ) {
      return new ApiError(409, 'USERNAME_TAKEN', 'username already in use', { username: 'username_taken' });
    }
    return err;
  }

  /** Directus names no field in a unique violation; the payload decides which. */
  function mapUniqueUserField(err, payload) {
    if (!(err instanceof DirectusError) || !(err.code === 'RECORD_NOT_UNIQUE' || /unique/i.test(err.message))) return err;
    return payload?.username ? mapUniqueUsername(err) : mapUniqueEmail(err);
  }

  /**
   * Refuses a username another user already holds. This is the friendly 409
   * path — the unique index remains the last word against a race, mapped by
   * mapUniqueUsername wherever the write happens.
   */
  async function assertUsernameAvailable(username, { exceptUserId = null } = {}) {
    if (!username) return;
    const existing = await directus.request('/users', {
      query: {
        filter: { username: { _eq: username }, ...(exceptUserId ? { id: { _neq: exceptUserId } } : {}) },
        fields: ['id'],
        limit: 1,
      },
    });
    if (existing && existing.length > 0) {
      throw new ApiError(409, 'USERNAME_TAKEN', 'username already in use', { username: 'username_taken' });
    }
  }

  /**
   * Exactly one card per owner carries `is_primary` — it answers the owner's
   * `/<username>` short URL. Clears the flag on the owner's other cards first;
   * both writes together are not atomic, but the flag is a display hint and
   * every reader resolves primary cards defensively (see publishedByUsername).
   */
  async function setPrimaryCard(ownerId, cardId) {
    const others = await directus.request('/items/vcards', {
      query: { fields: ['id'], filter: { owner: { _eq: ownerId }, is_primary: { _eq: true }, id: { _neq: cardId } }, limit: -1 },
    });
    if (others?.length) {
      await directus.request('/items/vcards', { method: 'PATCH', body: { keys: others.map((c) => c.id), data: { is_primary: false } } });
    }
    await directus.request(`/items/vcards/${cardId}`, { method: 'PATCH', body: { is_primary: true } });
  }

  /** After a delete, promote the owner's oldest remaining card to primary. */
  async function promotePrimary(ownerId) {
    if (!ownerId) return;
    const remaining = await directus.request('/items/vcards', {
      query: { fields: ['id'], filter: { owner: { _eq: ownerId } }, sort: ['date_created'], limit: 1 },
    });
    if (remaining?.length) await setPrimaryCard(ownerId, remaining[0].id);
  }

  /**
   * Backfill for owners who claimed a username after having cards: point the
   * /<username> URL at their oldest card without disturbing an existing flag.
   */
  async function ensurePrimary(ownerId) {
    if (!ownerId || (await anyPrimaryCard(ownerId))) return;
    await promotePrimary(ownerId);
  }

  /** Whether the owner already has any primary card (create-time safety net). */
  async function anyPrimaryCard(ownerId) {
    const rows = await directus.request('/items/vcards', {
      query: { fields: ['id'], filter: { owner: { _eq: ownerId }, is_primary: { _eq: true } }, limit: 1 },
    });
    return Boolean(rows?.length);
  }

  // ---- card sharing (qrv_card_access) ---------------------------------------

  /**
   * Grants beyond ownership: rows in qrv_card_access let a *collaborator* open
   * and edit a card they do not own. Ownership stays singular — only the owner
   * (or a privileged actor) may delete the card or change who it is shared with.
   */
  async function accessRequest(path, { method = 'GET', query, body } = {}) {
    try {
      return await directus.request(path, { method, query, body });
    } catch (err) {
      if (accessSupported && err instanceof DirectusError && String(err.message).includes(ACCESS_COLLECTION)) {
        noteAccessUnsupported(err);
        return [];
      }
      throw err;
    }
  }

  /** User ids with explicit access to `cardId` (never includes the owner). */
  /** Today in UTC — the same clock share expiries are written against. */
  function todayUtc() {
    const d = new Date(now());
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  /** An access row grants access unless its expiry day has fully passed. */
  function accessActive(row) {
    return !row?.expires_on || String(row.expires_on).slice(0, 10) >= todayUtc();
  }

  async function collaboratorsOf(cardId) {
    if (!accessSupported) return [];
    const rows = await accessRequest(`/items/${ACCESS_COLLECTION}`, {
      query: { fields: ACCESS_FIELDS, filter: { card: { _eq: cardId } }, limit: -1 },
    });
    // Lazy expiry: an out-of-date row no longer grants access (and is not
    // written back — history stays, no cron, the next read costs the same).
    return (rows ?? []).filter(accessActive).map((r) => r.user).filter(Boolean);
  }

  /** Cards `userId` may collaborate on (only needed for plain users). */
  async function sharedCardIds(userId) {
    if (!accessSupported) return [];
    const rows = await accessRequest(`/items/${ACCESS_COLLECTION}`, {
      query: { fields: ACCESS_FIELDS, filter: { user: { _eq: userId } }, limit: -1 },
    });
    return (rows ?? []).filter(accessActive).map((r) => r.card).filter(Boolean);
  }

  /**
   * The share write-rule: collaborators edit; only the owner or a privileged
   * actor may change the share list itself (or delete the card).
   */
  function canShareCard(card, actor) {
    return canSeeAllCards(actor.kind) || card.owner === actor.id;
  }

  /** Resolves an /api/cards/:id/shares actor against the email map (uses loadUser's cache). */
  async function usersFor(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await directus.request('/users', {
      query: { fields: ['id', 'email', 'first_name', 'last_name'], filter: { id: { _in: unique } }, limit: -1 },
    });
    return new Map((rows ?? []).map((u) => [u.id, u]));
  }

  async function shareDto(cardId) {
    if (!accessSupported) return [];
    const rows = (await accessRequest(`/items/${ACCESS_COLLECTION}`, {
      query: { fields: ACCESS_FIELDS, filter: { card: { _eq: cardId } }, limit: -1 },
    })) ?? [];
    const active = rows.filter(accessActive);
    const users = await usersFor(active.map((r) => r.user));
    return active.map((r) => {
      const u = users.get(r.user);
      return {
        id: r.user,
        email: u?.email ?? null,
        name: [u?.first_name, u?.last_name].filter(Boolean).join(' ') || null,
        ...(r.expires_on ? { expires_on: String(r.expires_on).slice(0, 10) } : {}),
      };
    });
  }

  async function createUser({ req, res, actor }) {
    const body = await readJson(req);
    const { data, errors } = validateUserInput(body);
    if (Object.keys(errors).length) fail(errors);
    const role = await assertRole(data.role);

    if (data.email) {
      const existing = await directus.request('/users', {
        query: { filter: { email: { _eq: data.email } }, fields: ['id'], limit: 1 },
      });
      if (existing && existing.length > 0) {
        throw new ApiError(409, 'EMAIL_TAKEN', 'email already in use', { email: 'email_taken' });
      }
    }
    await assertUsernameAvailable(data.username);

    let created;
    try {
      created = await directus.request('/users', { method: 'POST', body: { ...data, status: data.status ?? 'active' }, query: { fields: ['id'] } });
    } catch (err) {
      throw mapUniqueUserField(err, data);
    }
    audit({ req, actor, action: 'user.create', target: data.email, detail: `role: ${role.name}, status: ${data.status ?? 'active'}` });
    sendJson(res, 201, { data: userDto(await loadUser(created.id, { fresh: true }), 0) });
  }

  /** The target account, refusing the service account and unknown ids alike. */
  async function targetUser(id) {
    if (!UUID_RE.test(id) || id === (await getServiceUserId())) throw new ApiError(404, 'NOT_FOUND');
    const user = await loadUser(id, { fresh: true });
    if (!user) throw new ApiError(404, 'NOT_FOUND');
    return user;
  }

  /** Refuses a change that would leave no active administrator. */
  async function assertAdminRemains(target, { nextRoleName, nextStatus, deleting = false }) {
    const isActiveAdmin = target.role?.name === ROLE_ADMIN && target.status === 'active';
    const staysActiveAdmin = !deleting && (nextRoleName ?? target.role?.name) === ROLE_ADMIN && (nextStatus ?? target.status) === 'active';
    if (isActiveAdmin && !staysActiveAdmin && (await activeAdminIds()).length <= 1) {
      throw new ApiError(409, 'LAST_ADMIN', 'at least one active administrator must remain');
    }
  }

  async function updateUser({ req, res, actor, params }) {
    const target = await targetUser(params.id);
    const body = await readJson(req);
    const { data, errors } = validateUserInput(body, { partial: true });
    if (Object.keys(errors).length) fail(errors);

    if (target.id === actor.id && ((data.role && data.role !== target.role?.id) || (data.status && data.status !== target.status))) {
      throw new ApiError(409, 'SELF_LOCKOUT', 'you cannot change your own role or status');
    }
    const nextRole = data.role ? await assertRole(data.role) : null;
    await assertAdminRemains(target, { nextRoleName: nextRole?.name, nextStatus: data.status });
    if (data.password && epochSupported) data[EPOCH_FIELD] = (Number(target[EPOCH_FIELD]) || 0) + 1;
    // (audit for this change is written after the successful patch below)

    if (data.email && data.email !== target.email) {
      const existing = await directus.request('/users', {
        query: {
          filter: { email: { _eq: data.email }, id: { _neq: target.id } },
          fields: ['id'],
          limit: 1,
        },
      });
      if (existing && existing.length > 0) {
        throw new ApiError(409, 'EMAIL_TAKEN', 'email already in use', { email: 'email_taken' });
      }
    }
    if (data.username && data.username !== target.username) {
      await assertUsernameAvailable(data.username, { exceptUserId: target.id });
    }

    // Changed fields, old → new, for the audit trail. Passwords are never recorded.
    const changed = [];
    if (data.email !== undefined && data.email !== target.email) changed.push(`email: ${target.email} → ${data.email}`);
    if (data.username !== undefined && data.username !== target.username) changed.push(`username: ${target.username ?? '—'} → ${data.username}`);
    if (data.role && data.role !== target.role?.id) changed.push(`role: ${target.role?.name ?? '?'} → ${nextRole?.name ?? '?'}`);
    if (data.status && data.status !== target.status) changed.push(`status: ${target.status} → ${data.status}`);
    if (data.password) changed.push('password: (set)');
    if (data.first_name !== undefined && data.first_name !== target.first_name) changed.push(`first_name: ${target.first_name ?? '—'} → ${data.first_name}`);
    if (data.last_name !== undefined && data.last_name !== target.last_name) changed.push(`last_name: ${target.last_name ?? '—'} → ${data.last_name}`);

    try {
      await directus.request(`/users/${target.id}`, { method: 'PATCH', body: data });
    } catch (err) {
      throw mapUniqueUserField(err, data);
    }
    if (changed.length) audit({ req, actor, action: 'user.update', target: target.email, detail: changed.join('; ') });
    userCache.delete(target.id);
    if (data.password) audit({ req, actor, action: 'password.set', target: target.email });
    const fresh = await loadUser(target.id, { fresh: true });
    sendJson(res, 200, { data: userDto(fresh, await countCards(target.id)) });
  }

  async function deleteUser({ req, res, url, actor, params }) {
    const target = await targetUser(params.id);
    if (target.id === actor.id) throw new ApiError(409, 'SELF_LOCKOUT', 'you cannot delete your own account');
    await assertAdminRemains(target, { deleting: true });    const mode = url.searchParams.get('cards') === 'transfer' ? 'transfer' : 'delete';
    const cards = (await directus.request('/items/vcards', { query: { fields: ['id', 'photo'], filter: { owner: { _eq: target.id } }, limit: -1 } })) ?? [];
    // Access rows pointing at the deleted user (as collaborator) are garbage.
    if (accessSupported) {
      await accessRequest(`/items/${ACCESS_COLLECTION}`, { method: 'DELETE', body: { query: { filter: { user: { _eq: target.id } } } } }).catch(() => {});
    }
    if (cards.length) {
      const keys = cards.map((c) => c.id);
      if (mode === 'transfer') {
        await directus.request('/items/vcards', { method: 'PATCH', body: { keys, data: { owner: actor.id } } });
      } else {
        await directus.request('/items/vcards', { method: 'DELETE', body: keys });
        for (const c of cards) await deleteFileQuietly(c.photo);
      }
    }
    await directus.request(`/users/${target.id}`, { method: 'DELETE' });
    userCache.delete(target.id);
    audit({ req, actor, action: 'user.delete', target: target.email, detail: `cards: ${cards.length} ${mode === 'transfer' ? 'transferred to the acting admin' : 'deleted'}` });
    sendJson(res, 200, { data: { cards: cards.length, mode } });
  }

  async function health({ res }) {
    try {
      const id = await getServiceUserId();
      sendJson(res, 200, { ok: true, directus: 'ok', token: id ? 'valid' : 'unknown' });
    } catch (err) {
      const status = err instanceof DirectusError ? err.status : 0;
      sendJson(res, 503, { ok: false, directus: status === 401 || status === 403 ? 'token-rejected' : 'unreachable' });
    }
  }

  // ---- routing ----

  const routes = [
    ['POST', /^\/api\/auth\/login$/, login, 'none'],
    ['POST', /^\/api\/auth\/logout$/, logout, 'none'],
    ['GET', /^\/api\/health$/, health, 'none'],
    // Must precede /api/public/cards/:code — no overlap today, but the username
    // pattern is narrower and safer to match first.
    ['GET', /^\/api\/public\/u\/(?<username>[^/]+)$/, getPublicUserCard, 'none'],
    ['GET', /^\/api\/public\/cards\/(?<code>[^/]+)$/, getPublicCard, 'none'],
    ['GET', /^\/api\/public\/cards\/(?<code>[^/]+)\/photo$/, getPublicPhoto, 'none'],
    ['GET', /^\/api\/me$/, getMe, 'user'],
    ['PATCH', /^\/api\/me$/, patchMe, 'user'],
    ['POST', /^\/api\/me\/password$/, changeMyPassword, 'user'],
    ['GET', /^\/api\/cards$/, listCards, 'user'],
    // Must precede /api/cards/:id — "views" also matches the id pattern and the
    // dispatcher serves the first regex+method match.
    ['GET', /^\/api\/cards\/views$/, getCardViews, 'user'],
    ['POST', /^\/api\/cards$/, createCard, 'user'],
    ['PATCH', /^\/api\/cards\/(?<id>[^/]+)$/, updateCard, 'user'],
    ['DELETE', /^\/api\/cards\/(?<id>[^/]+)$/, deleteCard, 'user'],
    ['GET', /^\/api\/cards\/(?<id>[^/]+)\/photo$/, getCardPhoto, 'user'],
    ['POST', /^\/api\/cards\/(?<id>[^/]+)\/photo$/, uploadCardPhoto, 'user'],
    ['DELETE', /^\/api\/cards\/(?<id>[^/]+)\/photo$/, deleteCardPhoto, 'user'],
    ['GET', /^\/api\/cards\/(?<id>[^/]+)\/shares$/, listCardShares, 'user'],
    ['POST', /^\/api\/cards\/(?<id>[^/]+)\/shares$/, addCardShare, 'user'],
    ['PATCH', /^\/api\/cards\/(?<id>[^/]+)\/shares\/(?<userId>[^/]+)$/, patchCardShare, 'user'],
    ['DELETE', /^\/api\/cards\/(?<id>[^/]+)\/shares\/(?<userId>[^/]+)$/, removeCardShare, 'user'],
    ['GET', /^\/api\/users$/, listUsers, 'admin'],
    ['POST', /^\/api\/users$/, createUser, 'admin'],
    ['PATCH', /^\/api\/users\/(?<id>[^/]+)$/, updateUser, 'admin'],
    ['DELETE', /^\/api\/users\/(?<id>[^/]+)$/, deleteUser, 'admin'],
    ['GET', /^\/api\/roles$/, listRoles, 'admin'],
    ['GET', /^\/api\/audit$/, listAudit, 'admin'],
  ];

  function respondError(res, err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof ApiError) {
      sendJson(res, err.status, { error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } });
      return;
    }
    if (err instanceof DirectusError) {
      if (err.status === 401 || err.status === 403) {
        log.error?.(`[api] Directus refused the service token (${err.status} ${err.code}: ${err.message}) — check DIRECTUS_TOKEN`);
        sendJson(res, 502, { error: { code: 'UPSTREAM_AUTH', message: 'the server is not authorised against Directus' } });
        return;
      }
      if (err.code === 'UPSTREAM_UNREACHABLE') {
        log.error?.(`[api] ${err.message}`);
        sendJson(res, 502, { error: { code: 'UPSTREAM_UNREACHABLE', message: 'Directus is unreachable' } });
        return;
      }
      log.error?.(`[api] Directus ${err.status} ${err.code}: ${err.message}`);
      sendJson(res, 502, { error: { code: 'UPSTREAM_ERROR', message: 'Directus request failed' } });
      return;
    }
    log.error?.(`[api] ${err?.stack ?? err}`);
    sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    // /api/qr/* is answered by the QR handler on the same server.
    if (!path.startsWith('/api/') || path === '/api/qr' || path.startsWith('/api/qr/')) return false;

    try {
      const candidates = routes.filter(([, re]) => re.test(path));
      if (candidates.length === 0) throw new ApiError(404, 'NOT_FOUND', `unknown API path ${path}`);
      // CORS preflight: browsers never grant this origin cross-site access, so no
      // Access-Control-* headers are earned — but a well-formed 204 keeps a probe
      // (or a stray browser preflight) from surfacing as a 405.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { Allow: [...new Set(candidates.map(([m]) => m)), 'OPTIONS'].join(', ') });
        res.end();
        return true;
      }
      const route = candidates.find(([method]) => method === req.method || (method === 'GET' && req.method === 'HEAD'));
      if (!route) {
        res.setHeader('Allow', [...new Set(candidates.map(([m]) => m))].join(', '));
        throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.headers['x-qrv'] !== '1') throw new ApiError(403, 'CSRF', 'missing X-QRV header');
        const origin = req.headers.origin;
        if (origin) {
          let originHost = '';
          try {
            originHost = new URL(origin).host.toLowerCase().replace(/:(?:80|443)$/, '');
          } catch {
            /* stays empty and fails below */
          }
          if (originHost !== requestHost(req)) throw new ApiError(403, 'CSRF', 'cross-origin request refused');
        }
      }

      if (!configured) throw new ApiError(503, 'NOT_CONFIGURED', 'DIRECTUS_URL / DIRECTUS_TOKEN are not set on the server');

      const [, re, fn, level] = route;
      const params = re.exec(path)?.groups ?? {};
      for (const k of Object.keys(params)) params[k] = decodeURIComponent(params[k]);

      let actor = null;
      if (level !== 'none') {
        actor = await authenticate(req, res);
        if (!actor) throw new ApiError(401, 'UNAUTHENTICATED');
        if (level === 'admin' && !canManageUsers(actor.kind)) throw new ApiError(403, 'FORBIDDEN');
      }
      await fn({ req, res, url, params, actor });
    } catch (err) {
      respondError(res, err);
    }
    return true;
  }

  return { handle, configured };
}
