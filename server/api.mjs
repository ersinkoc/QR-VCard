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
import { generateCode, UUID_RE, validateCardInput, validateCode, validatePassword, validateUserInput } from './validate.mjs';

const JSON_LIMIT = 64 * 1024;
const PHOTO_LIMIT = 4 * 1024 * 1024;
const USER_CACHE_MS = 10_000;
const EPOCH_FIELD = 'qrv_session_epoch';

const CARD_FIELDS = ['id', 'status', 'code', 'first_name', 'last_name', 'organization', 'job_title', 'phone', 'email', 'website', 'address', 'note', 'accent_color', 'photo', 'photo_style', 'date_created', 'owner'];
const PUBLIC_FIELDS = ['code', 'first_name', 'last_name', 'organization', 'job_title', 'phone', 'email', 'website', 'address', 'note', 'accent_color', 'photo', 'photo_style'];
const USER_FIELDS = ['id', 'email', 'first_name', 'last_name', 'status', 'last_access', 'role.id', 'role.name'];
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

// --- DTOs --------------------------------------------------------------------

function cardDto(row, owners) {
  const dto = {};
  for (const f of CARD_FIELDS) if (f !== 'owner') dto[f] = row[f] ?? null;
  if (owners) {
    const owner = row.owner ? owners.get(row.owner) : null;
    dto.owner = row.owner
      ? { id: row.owner, email: owner?.email ?? null, name: owner ? [owner.first_name, owner.last_name].filter(Boolean).join(' ') || null : null }
      : null;
  }
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

function meDto(user) {
  return {
    id: user.id,
    email: user.email,
    first_name: user.first_name ?? null,
    last_name: user.last_name ?? null,
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

  const loginPerAccount = createRateLimiter({ max: 8, windowMs: 15 * 60_000 });
  const loginPerClient = createRateLimiter({ max: 40, windowMs: 15 * 60_000 });
  const passwordChecks = createRateLimiter({ max: 8, windowMs: 15 * 60_000 });

  const userCache = new Map();
  let epochSupported = true;
  let serviceUserId = null;

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

  async function findCard(id, fields = CARD_FIELDS) {
    if (!UUID_RE.test(id)) return null;
    const rows = await directus.request('/items/vcards', { query: { fields, filter: { id: { _eq: id } }, limit: 1 } });
    return rows?.[0] ?? null;
  }

  /** The card, if it exists AND `actor` may manage it; a foreign card is a 404, not a 403. */
  async function managedCard(id, actor) {
    const card = await findCard(id);
    if (!card || !canManageCard(card, actor)) throw new ApiError(404, 'NOT_FOUND');
    return card;
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
    const epochOk = !epochSupported || (Number(user?.[EPOCH_FIELD]) || 0) === session.epoch;
    if (!user || user.status !== 'active' || !epochOk || user.id === (await getServiceUserId())) {
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
    const { data, errors } = validateUserInput(candidate, { partial: true });
    if (Object.keys(errors).length) fail(errors);

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
      throw mapUniqueEmail(err);
    }
    userCache.delete(actor.id);
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
    const rows =
      (await directus.request('/items/vcards', {
        query: {
          fields: CARD_FIELDS,
          sort: ['-date_created'],
          limit: 1000,
          ...(filters.length ? { filter: filters.length === 1 ? filters[0] : { _and: filters } } : {}),
          ...(q ? { search: q } : {}),
        },
      })) ?? [];
    const owners = privileged ? await ownersFor(rows.map((r) => r.owner)) : null;
    sendJson(res, 200, { data: rows.map((r) => cardDto(r, owners)) });
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
      throw new ApiError(409, 'CARD_LIMIT', `at most ${maxCardsPerUser} cards per account`);
    }

    // owner is written explicitly: the service token would otherwise be
    // stamped as the creator, and the card would belong to nobody real.
    const base = { status: 'draft', accent_color: '#4f46e5', ...data, owner: ownerId };
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = customCode ?? generateCode();
      try {
        const created = await directus.request('/items/vcards', { method: 'POST', body: { ...base, code }, query: { fields: CARD_FIELDS } });
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
    if (ownerId) data.owner = ownerId;
    const updated = Object.keys(data).length
      ? await directus.request(`/items/vcards/${card.id}`, { method: 'PATCH', body: data, query: { fields: CARD_FIELDS } })
      : card;
    const owners = canSeeAllCards(actor.kind) ? await ownersFor([updated.owner]) : null;
    sendJson(res, 200, { data: cardDto(updated, owners) });
  }

  async function deleteCard({ res, actor, params }) {
    const card = await managedCard(params.id, actor);
    await directus.request(`/items/vcards/${card.id}`, { method: 'DELETE' });
    await deleteFileQuietly(card.photo);
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
    const card = await managedCard(params.id, actor);
    if (!card.photo) throw new ApiError(404, 'NOT_FOUND');
    await streamPhoto(res, card, { format: url.searchParams.get('format'), cache: 'private, max-age=300' });
  }

  async function uploadCardPhoto({ req, res, actor, params }) {
    const card = await managedCard(params.id, actor);
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
    const card = await managedCard(params.id, actor);
    const updated = await directus.request(`/items/vcards/${card.id}`, { method: 'PATCH', body: { photo: null }, query: { fields: CARD_FIELDS } });
    await deleteFileQuietly(card.photo);
    const owners = canSeeAllCards(actor.kind) ? await ownersFor([updated.owner]) : null;
    sendJson(res, 200, { data: cardDto(updated, owners) });
  }

  async function publishedByCode(code) {
    if (!/^[A-Za-z0-9-]{1,32}$/.test(code)) return null;
    const rows = await directus.request('/items/vcards', {
      query: { fields: PUBLIC_FIELDS, filter: { code: { _eq: code }, status: { _eq: 'published' } }, limit: 1 },
    });
    return rows?.[0] ?? null;
  }

  async function getPublicCard({ res, params }) {
    const card = await publishedByCode(params.code);
    if (!card) throw new ApiError(404, 'NOT_FOUND');
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

  async function listRoles({ res }) {
    const rows = await directus.request('/roles', { query: { fields: ['id', 'name'], sort: ['name'], limit: -1 } });
    sendJson(res, 200, { data: (rows ?? []).map((r) => ({ id: r.id, name: r.name, kind: roleKind(r.name) })) });
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

  async function createUser({ req, res }) {
    const body = await readJson(req);
    const { data, errors } = validateUserInput(body);
    if (Object.keys(errors).length) fail(errors);
    await assertRole(data.role);

    if (data.email) {
      const existing = await directus.request('/users', {
        query: { filter: { email: { _eq: data.email } }, fields: ['id'], limit: 1 },
      });
      if (existing && existing.length > 0) {
        throw new ApiError(409, 'EMAIL_TAKEN', 'email already in use', { email: 'email_taken' });
      }
    }

    let created;
    try {
      created = await directus.request('/users', { method: 'POST', body: { ...data, status: data.status ?? 'active' }, query: { fields: ['id'] } });
    } catch (err) {
      throw mapUniqueEmail(err);
    }
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

    try {
      await directus.request(`/users/${target.id}`, { method: 'PATCH', body: data });
    } catch (err) {
      throw mapUniqueEmail(err);
    }
    userCache.delete(target.id);
    const fresh = await loadUser(target.id, { fresh: true });
    sendJson(res, 200, { data: userDto(fresh, await countCards(target.id)) });
  }

  async function deleteUser({ res, url, actor, params }) {
    const target = await targetUser(params.id);
    if (target.id === actor.id) throw new ApiError(409, 'SELF_LOCKOUT', 'you cannot delete your own account');
    await assertAdminRemains(target, { deleting: true });

    const mode = url.searchParams.get('cards') === 'transfer' ? 'transfer' : 'delete';
    const cards = (await directus.request('/items/vcards', { query: { fields: ['id', 'photo'], filter: { owner: { _eq: target.id } }, limit: -1 } })) ?? [];
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
    ['GET', /^\/api\/public\/cards\/(?<code>[^/]+)$/, getPublicCard, 'none'],
    ['GET', /^\/api\/public\/cards\/(?<code>[^/]+)\/photo$/, getPublicPhoto, 'none'],
    ['GET', /^\/api\/me$/, getMe, 'user'],
    ['PATCH', /^\/api\/me$/, patchMe, 'user'],
    ['POST', /^\/api\/me\/password$/, changeMyPassword, 'user'],
    ['GET', /^\/api\/cards$/, listCards, 'user'],
    ['POST', /^\/api\/cards$/, createCard, 'user'],
    ['PATCH', /^\/api\/cards\/(?<id>[^/]+)$/, updateCard, 'user'],
    ['DELETE', /^\/api\/cards\/(?<id>[^/]+)$/, deleteCard, 'user'],
    ['GET', /^\/api\/cards\/(?<id>[^/]+)\/photo$/, getCardPhoto, 'user'],
    ['POST', /^\/api\/cards\/(?<id>[^/]+)\/photo$/, uploadCardPhoto, 'user'],
    ['DELETE', /^\/api\/cards\/(?<id>[^/]+)\/photo$/, deleteCardPhoto, 'user'],
    ['GET', /^\/api\/users$/, listUsers, 'admin'],
    ['POST', /^\/api\/users$/, createUser, 'admin'],
    ['PATCH', /^\/api\/users\/(?<id>[^/]+)$/, updateUser, 'admin'],
    ['DELETE', /^\/api\/users\/(?<id>[^/]+)$/, deleteUser, 'admin'],
    ['GET', /^\/api\/roles$/, listRoles, 'admin'],
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
