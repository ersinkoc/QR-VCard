import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApiHandler } from './api.mjs';
import { DirectusError } from './directus-client.mjs';

/**
 * The API is the only enforcement point for "a user sees only their own cards"
 * (Directus grants browsers nothing), so these tests pin the authorisation rules
 * against an in-memory Directus. No network is involved.
 */

const ROLES = [
  { id: '00000000-0000-4000-8000-00000000a001', name: 'Administrator' },
  { id: '00000000-0000-4000-8000-00000000a002', name: 'vcard-editor' },
  { id: '00000000-0000-4000-8000-00000000a003', name: 'vcard-user' },
];
const [ADMIN_ROLE, EDITOR_ROLE, USER_ROLE] = ROLES;
const ID = {
  svc: '00000000-0000-4000-8000-000000000000',
  admin: '00000000-0000-4000-8000-000000000001',
  editor: '00000000-0000-4000-8000-000000000002',
  ada: '00000000-0000-4000-8000-000000000003',
  bob: '00000000-0000-4000-8000-000000000004',
  adaCard: '00000000-0000-4000-8000-0000000000c1',
  bobCard: '00000000-0000-4000-8000-0000000000c2',
};

function matches(row, filter) {
  if (!filter) return true;
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '_and') return cond.every((f) => matches(row, f));
    if (key === '_or') return cond.some((f) => matches(row, f));
    const value = row[key];
    if (cond && typeof cond === 'object') {
      if ('_eq' in cond) return value === cond._eq;
      if ('_neq' in cond) return value !== cond._neq;
      if ('_in' in cond) return cond._in.includes(value);
      if ('_gte' in cond) return value !== null && value !== undefined && value >= cond._gte;
      if ('_lte' in cond) return value !== null && value !== undefined && value <= cond._lte;
      if ('_null' in cond) return cond._null ? value === null || value === undefined : value !== null;
      return matches(value ?? {}, cond);
    }
    return value === cond;
  });
}

/** A tiny Directus: just the endpoints and query shapes server/api.mjs uses. */
function fakeDirectus() {
  const db = {
    users: [
      { id: ID.svc, email: 'svc@example.com', role: ADMIN_ROLE.id, status: 'active', password: null },
      { id: ID.admin, email: 'admin@example.com', role: ADMIN_ROLE.id, status: 'active', password: 'admin-pass' },
      { id: ID.editor, email: 'editor@example.com', role: EDITOR_ROLE.id, status: 'active', password: 'editor-pass' },
      { id: ID.ada, email: 'ada@example.com', role: USER_ROLE.id, status: 'active', password: 'ada-pass' },
      { id: ID.bob, email: 'bob@example.com', role: USER_ROLE.id, status: 'active', password: 'bob-pass' },
    ].map((u) => ({ first_name: null, last_name: null, last_access: null, username: null, qrv_session_epoch: 0, ...u })),
    cards: [
      { id: ID.adaCard, code: 'adaCard', status: 'published', first_name: 'Ada', owner: ID.ada, photo: null },
      { id: ID.bobCard, code: 'bobCard', status: 'draft', first_name: 'Bob', phone: '+1 555', owner: ID.bob, photo: null },
    ].map((c) => ({ is_primary: false, date_created: '2026-01-01T00:00:00.000Z', ...c })),
    files: [],
    audit: [],
    viewDays: [],
    cardAccess: [],
  };
  const withRole = (u) => ({ ...u, role: ROLES.find((r) => r.id === u.role) ?? null });
  let seq = 100;
  const newId = () => `00000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`;

  async function request(path, { method = 'GET', query = {}, body, auth } = {}) {
    const actorId = auth === undefined ? ID.svc : typeof auth === 'string' ? auth.replace(/^tok:/, '') : null;
    let m;

    if (path === '/auth/login') {
      const user = db.users.find((u) => u.email === body.email && u.password && u.password === body.password && u.status === 'active');
      if (!user) throw new DirectusError(401, 'INVALID_CREDENTIALS', 'Invalid user credentials.');
      return { access_token: `tok:${user.id}`, refresh_token: 'r' };
    }
    if (path === '/auth/logout') return null;
    if (path === '/users/me') return { id: actorId };

    if (path === '/users' && method === 'GET') {
      const q = (query.search ?? '').toLowerCase();
      return db.users.map(withRole).filter((u) => matches(u, query.filter) && (!q || u.email.includes(q)));
    }
    if (path === '/users' && method === 'POST') {
      if (db.users.some((u) => u.email === body.email)) throw new DirectusError(400, 'RECORD_NOT_UNIQUE', 'dup');
      if (body.username && db.users.some((u) => u.username === body.username)) throw new DirectusError(400, 'RECORD_NOT_UNIQUE', 'dup');
      const user = { id: newId(), first_name: null, last_name: null, last_access: null, username: null, qrv_session_epoch: 0, ...body };
      db.users.push(user);
      return { id: user.id };
    }
    if ((m = path.match(/^\/users\/(.+)$/))) {
      const user = db.users.find((u) => u.id === m[1]);
      if (method === 'PATCH') {
        if (body.email && db.users.some((u) => u.id !== user.id && u.email === body.email)) {
          throw new DirectusError(400, 'RECORD_NOT_UNIQUE', 'dup');
        }
        if (body.username && db.users.some((u) => u.id !== user.id && u.username === body.username)) {
          throw new DirectusError(400, 'RECORD_NOT_UNIQUE', 'dup');
        }
        Object.assign(user, body);
      }
      if (method === 'DELETE') db.users.splice(db.users.indexOf(user), 1);
      return null;
    }
    if (path === '/roles') return ROLES.filter((r) => matches(r, query.filter));

    if (path === '/items/vcards' && method === 'GET') {
      const rows = db.cards.filter((c) => matches(c, query.filter));
      if (query.aggregate) {
        if (query.groupBy) {
          const counts = new Map();
          for (const c of rows) counts.set(c.owner, (counts.get(c.owner) ?? 0) + 1);
          return [...counts].map(([owner, count]) => ({ owner, count }));
        }
        return [{ count: rows.length }];
      }
      const sort = query.sort ?? [];
      const sorted = [...rows].sort((a, b) => {
        for (const key of sort) {
          const desc = key.startsWith('-');
          const field = desc ? key.slice(1) : key;
          const av = a[field];
          const bv = b[field];
          if (av === bv) continue;
          const cmp = av === true && bv === false ? 1 : av === false && bv === true ? -1 : String(av ?? '') < String(bv ?? '') ? -1 : 1;
          return desc ? -cmp : cmp;
        }
        return 0;
      });
      // Directus: limit -1 (or absent) means “all rows”.
      const limit = typeof query.limit === 'number' && query.limit >= 0 ? query.limit : rows.length;
      return sorted.slice(0, limit).map((c) => ({ ...c }));
    }
    if (path === '/items/vcards' && method === 'POST') {
      if (db.cards.some((c) => c.code === body.code)) throw new DirectusError(400, 'RECORD_NOT_UNIQUE', 'dup');
      const card = { id: newId(), photo: null, is_primary: false, date_created: new Date().toISOString(), ...body };
      db.cards.push(card);
      return { ...card };
    }
    if (path === '/items/vcards' && method === 'PATCH') {
      // Batch-by-keys form ({keys, data})…
      if (body.keys) {
        for (const c of db.cards) if (body.keys.includes(c.id)) Object.assign(c, body.data);
        return null;
      }
      // …and query-scoped form ({query, data}) used by the view counter.
      const targets = db.cards.filter((c) => matches(c, body.query?.filter));
      for (const c of targets) Object.assign(c, body.data);
      return null;
    }
    if (path === '/items/vcards' && method === 'DELETE') {
      db.cards = db.cards.filter((c) => !body.includes(c.id));
      return null;
    }
    if ((m = path.match(/^\/items\/vcards\/(.+)$/))) {
      const card = db.cards.find((c) => c.id === m[1]);
      if (method === 'PATCH') return { ...Object.assign(card, body) };
      if (method === 'DELETE') db.cards.splice(db.cards.indexOf(card), 1);
      return null;
    }
    if (path === '/files' && method === 'POST') {
      const file = { id: newId() };
      db.files.push(file);
      return file;
    }
    if ((m = path.match(/^\/files\/(.+)$/))) {
      db.files = db.files.filter((f) => f.id !== m[1]);
      return null;
    }
    if (path === '/items/qrv_audit_log' && method === 'POST') {
      db.audit.push({ id: newId(), date_created: new Date().toISOString(), actor: body.actor ? { id: body.actor } : null, actor_email: body.actor_email, action: body.action, target: body.target, detail: body.detail });
      return db.audit[db.audit.length - 1];
    }
    // ---- qrv_view_days: the daily scan-trend collection -------------------
    if (path === '/items/qrv_view_days' && method === 'GET') {
      let rows = db.viewDays.filter((v) => matches(v, query.filter));
      if (query.aggregate) {
        const groups = new Map();
        for (const v of rows) groups.set(v.day, (groups.get(v.day) ?? 0) + v.views);
        const day = query.groupBy?.[0];
        if (!day) throw new DirectusError(400, 'INVALID_QUERY', 'groupBy required');
        // Real Directus shapes grouped sums as { day, sum: { views } }.
        return [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, sum]) => ({ [day]: d, sum: { views: sum } }));
      }
      return rows.map((v) => ({ ...v }));
    }
    if (path === '/items/qrv_view_days' && method === 'POST') {
      const row = { id: newId(), ...body };
      db.viewDays.push(row);
      return row;
    }
    // ---- qrv_card_access: the card↔collaborator junction -------------------
    if (path === '/items/qrv_card_access' && method === 'GET') {
      let rows = db.cardAccess.filter((a) => matches(a, query.filter));
      // The fake honours the same lazy-expiry filter the server sends for counts.
      if (query.aggregate) {
        const groups = new Map();
        for (const a of rows) groups.set(a.card, (groups.get(a.card) ?? 0) + 1);
        const key = query.groupBy?.[0];
        if (!key) throw new DirectusError(400, 'INVALID_QUERY', 'groupBy required');
        return [...groups].map(([card, count]) => ({ [key]: card, count }));
      }
      return rows.map((a) => ({ ...a }));
    }
    if ((m = path.match(/^\/items\/qrv_card_access\/(.+)$/))) {
      const row = db.cardAccess.find((a) => a.id === m[1]);
      if (method === 'PATCH') Object.assign(row, body);
      if (method === 'DELETE') db.cardAccess = db.cardAccess.filter((a) => a.id !== m[1]);
      return null;
    }
    if (path === '/items/qrv_card_access' && method === 'POST') {
      if (db.cardAccess.some((a) => a.card === body.card && a.user === body.user)) {
        throw new DirectusError(400, 'RECORD_NOT_UNIQUE', 'dup');
      }
      const row = { id: newId(), date_created: new Date().toISOString(), ...body };
      db.cardAccess.push(row);
      return row;
    }
    if (path === '/items/qrv_card_access' && method === 'DELETE') {
      // Query-scoped form only ({query:{filter}}).
      db.cardAccess = db.cardAccess.filter((a) => !matches(a, body.query?.filter));
      return null;
    }
    if ((m = path.match(/^\/items\/qrv_view_days\/(.+)$/))) {
      const row = db.viewDays.find((v) => v.id === m[1]);
      if (method === 'PATCH') return { ...Object.assign(row, body) };
      if (method === 'DELETE') db.viewDays.splice(db.viewDays.indexOf(row), 1);
      return null;
    }
    if (path === '/items/qrv_audit_log' && method === 'GET') {
      return db.audit.filter((e) => !query.search || [e.action, e.target, e.actor_email, e.detail].some((v) => String(v ?? '').toLowerCase().includes(query.search.toLowerCase())));
    }
    throw new Error(`fake directus: unhandled ${method} ${path}`);
  }

  return { db, request };
}

/**
 * A Readable, like node's IncomingMessage: the body waits until the handler reads
 * it. (An EventEmitter firing on a microtask loses the body whenever the handler
 * awaits — e.g. authentication — before attaching its listeners.)
 */
function makeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = { host: 'app.test', ...headers };
  req.socket = { remoteAddress: '10.0.0.1' };
  return req;
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    writeHead(status, headers = {}) {
      this.status = status;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk.toString();
    },
    json() {
      return this.body ? JSON.parse(this.body) : null;
    },
  };
}

let directus;
let api;

beforeEach(() => {
  directus = fakeDirectus();
  api = createApiHandler({
    directus,
    sessionSecret: 'test-secret-0123456789',
    maxCardsPerUser: 3,
    log: { warn() {}, error() {} },
  });
});

async function call(method, url, { body, cookie, headers = {} } = {}) {
  const res = makeRes();
  const write = method !== 'GET';
  const handled = await api.handle(
    makeReq({ method, url, body, headers: { ...(write ? { 'x-qrv': '1' } : {}), ...(cookie ? { cookie } : {}), ...headers } }),
    res,
  );
  return { handled, status: res.status, json: res.json(), headers: res.headers };
}

async function signIn(email, password) {
  const r = await call('POST', '/api/auth/login', { body: { email, password } });
  expect(r.status).toBe(200);
  return String(r.headers['Set-Cookie']).split(';')[0];
}

describe('routing', () => {
  it('leaves non-API paths and the QR endpoint to other handlers', async () => {
    expect((await call('GET', '/panel')).handled).toBe(false);
    expect((await call('POST', '/api/qr')).handled).toBe(false);
    expect((await call('GET', '/api/qr/abc')).handled).toBe(false);
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const r = await call('GET', '/api/nope');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('NOT_FOUND');
  });

  it('answers 503 when Directus is not configured', async () => {
    api = createApiHandler({ log: { warn() {}, error() {} } });
    expect((await call('GET', '/api/me')).json.error.code).toBe('NOT_CONFIGURED');
  });
});

describe('authentication', () => {
  it('refuses wrong credentials without a cookie', async () => {
    const r = await call('POST', '/api/auth/login', { body: { email: 'ada@example.com', password: 'nope' } });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('INVALID_CREDENTIALS');
    expect(r.headers['Set-Cookie']).toBeUndefined();
  });

  it('issues an HttpOnly, SameSite session cookie and resolves /api/me', async () => {
    const r = await call('POST', '/api/auth/login', { body: { email: 'ADA@example.com ', password: 'ada-pass' } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ id: ID.ada, role: 'user' });
    expect(r.headers['Set-Cookie']).toMatch(/HttpOnly/);
    expect(r.headers['Set-Cookie']).toMatch(/SameSite=Lax/);
    const cookie = String(r.headers['Set-Cookie']).split(';')[0];
    expect((await call('GET', '/api/me', { cookie })).json.data.email).toBe('ada@example.com');
  });

  it('rejects requests without a session and with a forged one', async () => {
    expect((await call('GET', '/api/cards')).status).toBe(401);
    const cookie = await signIn('ada@example.com', 'ada-pass');
    // Corrupt a character INSIDE the payload's base64 (not the HMAC's tail, where
    // the last character carries only padding bits and can decode identically).
    const forged = cookie.replace(/^(.{12})/, '$1A') + 'x';
    expect((await call('GET', '/api/cards', { cookie: forged })).status).toBe(401);
  });

  it('never lets the service account sign in', async () => {
    directus.db.users[0].password = 'svc-pass';
    expect((await call('POST', '/api/auth/login', { body: { email: 'svc@example.com', password: 'svc-pass' } })).status).toBe(401);
  });

  it('rate-limits repeated failures for one account', async () => {
    let last;
    for (let i = 0; i < 9; i++) last = await call('POST', '/api/auth/login', { body: { email: 'ada@example.com', password: 'bad' } });
    expect(last.status).toBe(429);
    expect(last.headers['Retry-After']).toBeDefined();
  });
});

describe('CSRF defences', () => {
  it('refuses writes without the X-QRV header', async () => {
    const res = makeRes();
    await api.handle(makeReq({ method: 'POST', url: '/api/auth/login', body: { email: 'a', password: 'b' } }), res);
    expect(res.status).toBe(403);
    expect(res.json().error.code).toBe('CSRF');
  });

  it('refuses writes from another origin', async () => {
    const r = await call('POST', '/api/auth/login', { body: {}, headers: { origin: 'https://evil.test' } });
    expect(r.status).toBe(403);
  });

  it('accepts writes from the same origin', async () => {
    const r = await call('POST', '/api/auth/login', { body: { email: 'ada@example.com', password: 'ada-pass' }, headers: { origin: 'http://app.test' } });
    expect(r.status).toBe(200);
  });
});

describe('card isolation for plain users', () => {
  it('lists only the caller’s own cards, without owner details', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    const r = await call('GET', '/api/cards', { cookie });
    expect(r.json.data.map((c) => c.code)).toEqual(['adaCard']);
    expect(r.json.data[0].owner).toBeUndefined();
  });

  it('ignores an owner filter from a plain user', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    const r = await call('GET', `/api/cards?owner=${ID.bob}`, { cookie });
    expect(r.json.data.map((c) => c.code)).toEqual(['adaCard']);
  });

  it('answers 404 for another user’s card and leaves it untouched', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    expect((await call('PATCH', `/api/cards/${ID.bobCard}`, { cookie, body: { first_name: 'Hacked' } })).status).toBe(404);
    expect((await call('DELETE', `/api/cards/${ID.bobCard}`, { cookie })).status).toBe(404);
    expect((await call('GET', `/api/cards/${ID.bobCard}/photo`, { cookie })).status).toBe(404);
    expect(directus.db.cards.find((c) => c.id === ID.bobCard)).toMatchObject({ first_name: 'Bob' });
  });

  it('stamps the caller as owner and refuses owner assignment', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    const created = await call('POST', '/api/cards', { cookie, body: { first_name: 'New' } });
    expect(created.status).toBe(201);
    expect(directus.db.cards.find((c) => c.id === created.json.data.id).owner).toBe(ID.ada);
    expect(created.json.data.code).toMatch(/^[2-9A-HJ-NP-Za-km-z]{7}$/);

    const assigned = await call('POST', '/api/cards', { cookie, body: { first_name: 'X', owner_id: ID.bob } });
    expect(assigned.status).toBe(403);
  });

  it('cannot move an own card to someone else', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    expect((await call('PATCH', `/api/cards/${ID.adaCard}`, { cookie, body: { owner_id: ID.bob } })).status).toBe(403);
  });

  it('enforces the per-user card limit', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    await call('POST', '/api/cards', { cookie, body: { first_name: 'Two' } });
    await call('POST', '/api/cards', { cookie, body: { first_name: 'Three' } });
    const r = await call('POST', '/api/cards', { cookie, body: { first_name: 'Four' } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('CARD_LIMIT');
  });

  it('reports validation problems per field', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    const r = await call('POST', '/api/cards', { cookie, body: { first_name: 'A', email: 'nope', website: 'not a url', accent_color: 'red' } });
    expect(r.status).toBe(400);
    expect(r.json.error.fields).toEqual({ email: 'invalid_email', website: 'invalid_url', accent_color: 'invalid_color' });
    const style = await call('POST', '/api/cards', { cookie, body: { first_name: 'A', photo_style: 'banner' } });
    expect(style.json.error.fields).toEqual({ photo_style: 'invalid' });
  });

  it('refuses a taken or reserved vanity code', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    expect((await call('POST', '/api/cards', { cookie, body: { first_name: 'A', code: 'bobCard' } })).json.error.code).toBe('CODE_TAKEN');
    expect((await call('POST', '/api/cards', { cookie, body: { first_name: 'A', code: 'admin' } })).json.error.fields.code).toBe('code_reserved');
  });

  it('refuses a photo that is not an image', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    const r = await call('POST', `/api/cards/${ID.adaCard}/photo`, { cookie, body: Buffer.from('<svg onload=alert(1)>') });
    expect(r.status).toBe(415);
  });
});

describe('privileged roles', () => {
  it('shows admins every card with its owner', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass');
    const r = await call('GET', '/api/cards', { cookie });
    expect(r.json.data.map((c) => c.owner.email).sort()).toEqual(['ada@example.com', 'bob@example.com']);
  });

  it('filters by owner for admins', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass');
    const r = await call('GET', `/api/cards?owner=${ID.bob}`, { cookie });
    expect(r.json.data.map((c) => c.code)).toEqual(['bobCard']);
  });

  it('lets an admin create a card on someone’s behalf, beyond the user limit', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass');
    const r = await call('POST', '/api/cards', { cookie, body: { first_name: 'For Bob', owner_id: ID.bob } });
    expect(r.status).toBe(201);
    expect(r.json.data.owner.email).toBe('bob@example.com');
  });

  it('lets editors manage every card but not accounts', async () => {
    const cookie = await signIn('editor@example.com', 'editor-pass');
    expect((await call('PATCH', `/api/cards/${ID.bobCard}`, { cookie, body: { status: 'published' } })).status).toBe(200);
    expect((await call('GET', '/api/users', { cookie })).status).toBe(403);
  });
});

describe('user administration', () => {
  it('is admin-only', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    expect((await call('GET', '/api/users', { cookie })).status).toBe(403);
    expect((await call('POST', '/api/users', { cookie, body: {} })).status).toBe(403);
    expect((await call('GET', '/api/roles', { cookie })).status).toBe(403);
  });

  it('lists accounts with card counts and hides the service account', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass');
    const r = await call('GET', '/api/users', { cookie });
    const byEmail = Object.fromEntries(r.json.data.map((u) => [u.email, u]));
    expect(byEmail['svc@example.com']).toBeUndefined();
    expect(byEmail['ada@example.com']).toMatchObject({ card_count: 1, role: 'user', status: 'active' });
    expect(byEmail['admin@example.com'].card_count).toBe(0);
  });

  it('creates an account that can sign in, and refuses a duplicate email', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass');
    const body = { email: 'new@example.com', password: 'new-password', first_name: 'New', role: USER_ROLE.id };
    expect((await call('POST', '/api/users', { cookie, body })).status).toBe(201);
    await signIn('new@example.com', 'new-password');
    expect((await call('POST', '/api/users', { cookie, body })).json.error.code).toBe('EMAIL_TAKEN');
  });

  it('creates an account with a username and refuses duplicates', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass');
    expect((await call('POST', '/api/users', { cookie, body: { email: 'u1@example.com', password: 'u1-password', first_name: 'U', role: USER_ROLE.id, username: 'Uma' } })).json.data.username).toBe('uma');
    const dup = await call('POST', '/api/users', { cookie, body: { email: 'u2@example.com', password: 'u2-password', first_name: 'U', role: USER_ROLE.id, username: 'UMA' } });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatchObject({ code: 'USERNAME_TAKEN', fields: { username: 'username_taken' } });
  });

  it('refuses updating an account to an existing email', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass');
    const r = await call('PATCH', `/api/users/${ID.ada}`, { cookie, body: { email: 'bob@example.com' } });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'EMAIL_TAKEN', fields: { email: 'email_taken' } });
  });

  it('suspending an account ends its session', async () => {
    const adaCookie = await signIn('ada@example.com', 'ada-pass');
    const cookie = await signIn('admin@example.com', 'admin-pass');
    expect((await call('PATCH', `/api/users/${ID.ada}`, { cookie, body: { status: 'suspended' } })).status).toBe(200);
    expect((await call('GET', '/api/me', { cookie: adaCookie })).status).toBe(401);
  });

  it('setting a password signs the account out everywhere', async () => {
    const adaCookie = await signIn('ada@example.com', 'ada-pass');
    const cookie = await signIn('admin@example.com', 'admin-pass');
    expect((await call('PATCH', `/api/users/${ID.ada}`, { cookie, body: { password: 'brand-new-pass' } })).status).toBe(200);
    expect((await call('GET', '/api/me', { cookie: adaCookie })).status).toBe(401);
  });

  it('protects the admin from locking themselves out', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass');
    expect((await call('PATCH', `/api/users/${ID.admin}`, { cookie, body: { status: 'suspended' } })).json.error.code).toBe('SELF_LOCKOUT');
    expect((await call('PATCH', `/api/users/${ID.admin}`, { cookie, body: { role: USER_ROLE.id } })).json.error.code).toBe('SELF_LOCKOUT');
    expect((await call('DELETE', `/api/users/${ID.admin}`, { cookie })).json.error.code).toBe('SELF_LOCKOUT');
  });

  it('lets one admin demote another while an admin remains, and the change applies at once', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass');
    expect((await call('PATCH', `/api/users/${ID.editor}`, { cookie, body: { role: ADMIN_ROLE.id } })).json.data.role).toBe('admin');
    const promoted = await signIn('editor@example.com', 'editor-pass');
    expect((await call('GET', '/api/users', { cookie: promoted })).status).toBe(200);

    expect((await call('PATCH', `/api/users/${ID.admin}`, { cookie: promoted, body: { role: USER_ROLE.id } })).status).toBe(200);
    expect((await call('GET', '/api/users', { cookie })).status).toBe(403);
  });

  it('refuses an unknown role', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass');
    const r = await call('PATCH', `/api/users/${ID.ada}`, { cookie, body: { role: '00000000-0000-4000-8000-00000000ffff' } });
    expect(r.json.error.fields).toEqual({ role: 'invalid_role' });
  });

  it('refuses the service account as a target', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass');
    expect((await call('PATCH', `/api/users/${ID.svc}`, { cookie, body: { status: 'suspended' } })).status).toBe(404);
    expect((await call('DELETE', `/api/users/${ID.svc}`, { cookie })).status).toBe(404);
  });

  it('deletes an account with its cards, or hands the cards over', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass');
    const moved = await call('DELETE', `/api/users/${ID.bob}?cards=transfer`, { cookie });
    expect(moved.json.data).toEqual({ cards: 1, mode: 'transfer' });
    expect(directus.db.cards.find((c) => c.id === ID.bobCard).owner).toBe(ID.admin);

    const removed = await call('DELETE', `/api/users/${ID.ada}`, { cookie });
    expect(removed.json.data).toEqual({ cards: 1, mode: 'delete' });
    expect(directus.db.cards.some((c) => c.id === ID.adaCard)).toBe(false);
    expect(directus.db.users.some((u) => u.id === ID.ada)).toBe(false);
  });
});

describe('own account', () => {
  it('changes the password only with the current one, keeping this session', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    const wrong = await call('POST', '/api/me/password', { cookie, body: { current_password: 'nope', new_password: 'another-pass' } });
    expect(wrong.json.error.code).toBe('WRONG_PASSWORD');

    const ok = await call('POST', '/api/me/password', { cookie, body: { current_password: 'ada-pass', new_password: 'another-pass' } });
    expect(ok.status).toBe(200);
    const renewed = String(ok.headers['Set-Cookie']).split(';')[0];
    expect((await call('GET', '/api/me', { cookie: renewed })).status).toBe(200);
    expect((await call('GET', '/api/me', { cookie })).status).toBe(401);
  });

  it('updates profile and email, and signs in with the new email', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    const r = await call('PATCH', '/api/me', { cookie, body: { email: 'ada-new@example.com', first_name: 'Adalovelace' } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ email: 'ada-new@example.com', first_name: 'Adalovelace' });

    // The existing session still works with updated email
    const me = await call('GET', '/api/me', { cookie });
    expect(me.json.data.email).toBe('ada-new@example.com');

    // And new sign-ins use the new email
    const newCookie = await signIn('ada-new@example.com', 'ada-pass');
    expect(newCookie).toBeTruthy();
  });

  it('refuses an email that is already taken by another account', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    const r = await call('PATCH', '/api/me', { cookie, body: { email: 'bob@example.com' } });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'EMAIL_TAKEN', fields: { email: 'email_taken' } });
  });

  it('allows saving profile with the same email', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    const r = await call('PATCH', '/api/me', { cookie, body: { email: 'ada@example.com', first_name: 'Ada Augusta' } });
    expect(r.status).toBe(200);
    expect(r.json.data.first_name).toBe('Ada Augusta');
  });

  it('claims, keeps and clears a username via /api/me', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');

    const claim = await call('PATCH', '/api/me', { cookie, body: { username: 'Ada_L' } });
    expect(claim.status).toBe(200);
    expect(claim.json.data.username).toBe('ada_l'); // normalised to lowercase

    // Saving the profile with the same username must not 409 against itself.
    const keep = await call('PATCH', '/api/me', { cookie, body: { username: 'ada_l', first_name: 'Ada' } });
    expect(keep.status).toBe(200);

    // Clearing releases the handle.
    const clear = await call('PATCH', '/api/me', { cookie, body: { username: '' } });
    expect(clear.status).toBe(200);
    expect(clear.json.data.username).toBeNull();
  });

  it('refuses a username that another user already holds', async () => {
    const admin = await signIn('admin@example.com', 'admin-pass');
    expect((await call('PATCH', '/api/me', { cookie: admin, body: { username: 'root' } })).status).toBe(200);

    const ada = await signIn('ada@example.com', 'ada-pass');
    const r = await call('PATCH', '/api/me', { cookie: ada, body: { username: 'ROOT' } }); // case-insensitive
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'USERNAME_TAKEN', fields: { username: 'username_taken' } });
  });

  it('rejects malformed and reserved usernames', async () => {
    const cookie = await signIn('ada@example.com', 'ada-pass');
    for (const bad of ['A', 'has space', 'Ada!', '-lead', 'trail-', 'panel']) {
      const r = await call('PATCH', '/api/me', { cookie, body: { username: bad } });
      expect([400, 409]).toContain(r.status);
    }
    expect((await call('PATCH', '/api/me', { cookie, body: { username: 'panel' } })).json.error.fields.username).toBe('username_reserved');
  });
});

describe('public card page', () => {
  it('serves a published card without owner or internal fields', async () => {
    const r = await call('GET', '/api/public/cards/adaCard');
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ code: 'adaCard', first_name: 'Ada' });
    expect(r.json.data).not.toHaveProperty('owner');
    expect(r.json.data).not.toHaveProperty('id');
    expect(r.json.data).not.toHaveProperty('status');
  });

  it('hides drafts', async () => {
    expect((await call('GET', '/api/public/cards/bobCard')).status).toBe(404);
  });

  it('counts anonymous public views but not signed-in panel previews', async () => {
    // The public DTO deliberately omits the count; the panel listing shows it.
    expect(directus.db.cards.find((c) => c.code === 'adaCard').qrv_views ?? 0).toBe(0);

    // Anonymous visits count, and the counter lands after a turn of the loop.
    await call('GET', '/api/public/cards/adaCard');
    await call('GET', '/api/public/cards/adaCard');
    await new Promise((r) => setTimeout(r, 10));
    expect(directus.db.cards.find((c) => c.code === 'adaCard').qrv_views).toBe(2);

    // A signed-in visitor (panel preview) does not count.
    const ada = await signIn('ada@example.com', 'ada-pass');
    await call('GET', '/api/public/cards/adaCard', { cookie: ada });
    await new Promise((r) => setTimeout(r, 10));
    expect(directus.db.cards.find((c) => c.code === 'adaCard').qrv_views).toBe(2);

    // Drafts never count.
    expect((await call('GET', '/api/public/cards/bobCard')).status).toBe(404);
    await new Promise((r) => setTimeout(r, 10));
    expect(directus.db.cards.find((c) => c.code === 'bobCard').qrv_views ?? 0).toBe(0);
    expect(directus.db.cards.find((c) => c.code === 'adaCard').qrv_views).toBe(2);

    // Every count also lands in the daily series — same day, since both writes
    // share the visit's timestamp.
    const today = new Date().toISOString().slice(0, 10);
    const dayRow = directus.db.viewDays.find((v) => v.card === ID.adaCard && v.day === today);
    expect(dayRow?.views).toBe(2);
  });

  it('keeps serving cards when the qrv_views column is missing (pre-bootstrap installs)', async () => {
    const plain = fakeDirectus();
    // An install that has not re-run bootstrap: Directus rejects any query
    // selecting the unknown column. The API must degrade, not break.
    const strict = {
      request(path, opts = {}) {
        if (JSON.stringify(opts.query ?? {}).includes('qrv_views')) {
          throw new DirectusError(400, 'INVALID_QUERY', 'qrv_views does not exist in this collection');
        }
        return plain.request(path, opts);
      },
    };
    api = createApiHandler({ directus: strict, sessionSecret: 'test-secret-0123456789', log: { warn() {}, error() {} } });

    const r = await call('GET', '/api/public/cards/adaCard');
    expect(r.status).toBe(200);
    expect(r.json.data.qrv_views).toBeUndefined();

    const ada = await signIn('ada@example.com', 'ada-pass');
    expect((await call('GET', '/api/cards', { cookie: ada })).status).toBe(200);
  });

  it('counts into the daily series too', async () => {
    await call('GET', '/api/public/cards/adaCard');
    await new Promise((r) => setTimeout(r, 10));
    expect(directus.db.viewDays).toHaveLength(1);
    expect(directus.db.viewDays[0].views).toBe(1);
    expect(directus.db.viewDays[0].day).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('username short URL (/<username>)', () => {
  async function giveUsername(email, password, username) {
    const cookie = await signIn(email, password);
    const r = await call('PATCH', '/api/me', { cookie, body: { username } });
    expect(r.status).toBe(200);
    return cookie;
  }

  it('makes the first card primary and resolves /<username> to it', async () => {
    await giveUsername('ada@example.com', 'ada-pass', 'ada');
    expect(directus.db.cards.find((c) => c.id === ID.adaCard).is_primary).toBe(true);

    const r = await call('GET', '/api/public/u/ada');
    expect(r.status).toBe(200);
    expect(r.json.data.code).toBe('adaCard');
    expect(r.json.data).not.toHaveProperty('owner');
  });

  it('resolves case-insensitively and counts anonymous views', async () => {
    await giveUsername('ada@example.com', 'ada-pass', 'ada');
    await call('GET', '/api/public/u/ADA');
    await new Promise((r) => setTimeout(r, 10));
    expect(directus.db.cards.find((c) => c.code === 'adaCard').qrv_views).toBe(1);
  });

  it('404s when the primary card is a draft, falling back to the oldest published', async () => {
    const ada = await giveUsername('ada@example.com', 'ada-pass', 'ada');
    // A second, published card; primary stays on adaCard.
    const second = await call('POST', '/api/cards', { cookie: ada, body: { first_name: 'Second' } });
    expect(second.status).toBe(201);
    expect(directus.db.cards.find((c) => c.id === second.json.data.id).is_primary).toBe(false);
    await call('PATCH', `/api/cards/${second.json.data.id}`, { cookie: ada, body: { status: 'published' } });

    expect((await call('GET', '/api/public/u/ada')).status).toBe(200);

    // Draft the primary: the username URL must fall back to the published card.
    await call('PATCH', `/api/cards/${ID.adaCard}`, { cookie: ada, body: { status: 'draft' } });
    const fb = await call('GET', '/api/public/u/ada');
    expect(fb.status).toBe(200);
    expect(fb.json.data.code).not.toBe('adaCard');
  });

  it('switches the primary explicitly and unsets the old one', async () => {
    const ada = await giveUsername('ada@example.com', 'ada-pass', 'ada');
    const second = await call('POST', '/api/cards', { cookie: ada, body: { first_name: 'Second' } });
    const secondId = second.json.data.id;

    const moved = await call('PATCH', `/api/cards/${secondId}`, { cookie: ada, body: { status: 'published', is_primary: true } });
    expect(moved.status).toBe(200);
    expect(moved.json.data.is_primary).toBe(true);
    expect(directus.db.cards.find((c) => c.id === ID.adaCard).is_primary).toBe(false);
    expect((await call('GET', '/api/public/u/ada')).json.data.code).toBe(second.json.data.code);
  });

  it('promotes the oldest remaining card when the primary is deleted', async () => {
    const ada = await giveUsername('ada@example.com', 'ada-pass', 'ada');
    const second = await call('POST', '/api/cards', { cookie: ada, body: { first_name: 'Second' } });
    await call('PATCH', `/api/cards/${second.json.data.id}`, { cookie: ada, body: { status: 'published' } });

    await call('DELETE', `/api/cards/${ID.adaCard}`, { cookie: ada });
    expect(directus.db.cards.find((c) => c.id === second.json.data.id).is_primary).toBe(true);
    expect((await call('GET', '/api/public/u/ada')).status).toBe(200);
  });

  it('serves the primary card of an owner without any username as nothing', async () => {
    // Bob has no username: /api/public/u/... must not leak his cards.
    expect((await call('GET', '/api/public/u/bob')).status).toBe(404);
  });

  it('does not let a plain user see another user’s trend but still 403s nothing new', async () => {
    expect((await call('GET', '/api/public/u/ada')).status).toBe(404); // no username claimed yet
  });
});

describe('card sharing (collaborators)', () => {
  const CARD_ID = ID.bobCard; // Bob owns it (draft); Ada gets access.

  async function share(adaEmail = 'ada@example.com') {
    const bob = await signIn('bob@example.com', 'bob-pass');
    const r = await call('POST', `/api/cards/${CARD_ID}/shares`, { cookie: bob, body: { email: adaEmail } });
    expect(r.status).toBe(201);
    return bob;
  }

  it('lets the owner share by email, idempotently, and list collaborators', async () => {
    const bob = await share();
    const list = await call('GET', `/api/cards/${CARD_ID}/shares`, { cookie: bob });
    expect(list.status).toBe(200);
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0]).toMatchObject({ email: 'ada@example.com' });

    // Re-sharing the same person does not duplicate the row.
    const again = await call('POST', `/api/cards/${CARD_ID}/shares`, { cookie: bob, body: { email: 'ada@example.com' } });
    expect(again.status).toBe(200); // idempotent → 200, not 201
    expect(directus.db.cardAccess).toHaveLength(1);
  });

  it('shows the shared card to the collaborator and lets them edit it', async () => {
    await share();
    const ada = await signIn('ada@example.com', 'ada-pass');

    const list = await call('GET', '/api/cards', { cookie: ada });
    expect(list.status).toBe(200);
    const shared = list.json.data.find((c) => c.id === CARD_ID);
    expect(shared).toBeTruthy();
    expect(shared.owner.email).toBe('bob@example.com');
    expect(shared.collaborator_count).toBe(1);

    const edit = await call('PATCH', `/api/cards/${CARD_ID}`, { cookie: ada, body: { job_title: 'Guest Editor' } });
    expect(edit.status).toBe(200);
    expect(edit.json.data.job_title).toBe('Guest Editor');

    // ...and her own card is still there beside it.
    expect(list.json.data.some((c) => c.id === ID.adaCard)).toBe(true);
  });

  it('keeps a collaborator from deleting, re-sharing and reassigning', async () => {
    await share();
    const ada = await signIn('ada@example.com', 'ada-pass');
    expect((await call('DELETE', `/api/cards/${CARD_ID}`, { cookie: ada })).status).toBe(403);
    expect((await call('POST', `/api/cards/${CARD_ID}/shares`, { cookie: ada, body: { email: 'editor@example.com' } })).status).toBe(403);
    expect((await call('PATCH', `/api/cards/${CARD_ID}`, { cookie: ada, body: { owner_id: ID.ada } })).status).toBe(403);
    // The card survives all of it.
    expect(directus.db.cards.some((c) => c.id === CARD_ID)).toBe(true);
  });

  it('unshares: access ends immediately, card keeps existing', async () => {
    const bob = await share();
    const adaId = directus.db.users.find((u) => u.email === 'ada@example.com').id;
    const un = await call('DELETE', `/api/cards/${CARD_ID}/shares/${adaId}`, { cookie: bob });
    expect(un.status).toBe(200);
    expect(un.json.data).toHaveLength(0);

    const ada = await signIn('ada@example.com', 'ada-pass');
    // No GET-by-id route exists: existence is checked via the list and a PATCH.
    const list = await call('GET', '/api/cards', { cookie: ada });
    expect(list.json.data.some((c) => c.id === CARD_ID)).toBe(false);
    expect((await call('PATCH', `/api/cards/${CARD_ID}`, { cookie: ada, body: { note: 'sneak' } })).status).toBe(404);
    expect(directus.db.cards.some((c) => c.id === CARD_ID)).toBe(true);
  });

  it('keeps strangers out and does not leak foreign shares', async () => {
    await share();
    // A third plain user sees neither the card nor its share list.
    const editor = await signIn('editor@example.com', 'editor-pass'); // privileged: CAN see
    expect((await call('GET', `/api/cards/${CARD_ID}/shares`, { cookie: editor })).status).toBe(200);

    directus.db.users.push({ id: '00000000-0000-4000-8000-000000000009', email: 'carol@example.com', first_name: null, last_name: null, last_access: null, username: null, qrv_session_epoch: 0, role: USER_ROLE.id, status: 'active', password: 'carol-pass' });
    const carol = await signIn('carol@example.com', 'carol-pass');
    expect((await call('PATCH', `/api/cards/${CARD_ID}`, { cookie: carol, body: { note: 'x' } })).status).toBe(404);
    expect((await call('GET', `/api/cards/${CARD_ID}/shares`, { cookie: carol })).status).toBe(404);
    // And Carol's own list is untouched by the share.
    expect((await call('GET', '/api/cards', { cookie: carol })).json.data).toHaveLength(0);
  });

  it('refuses sharing to the owner, unknown or suspended accounts', async () => {
    const bob = await share();
    const nope = await call('POST', `/api/cards/${CARD_ID}/shares`, { cookie: bob, body: { email: 'bob@example.com' } });
    expect(nope.status).toBe(400);
    expect(nope.json.error.fields.email).toBe('is_owner');
    expect((await call('POST', `/api/cards/${CARD_ID}/shares`, { cookie: bob, body: { email: 'ghost@example.com' } })).status).toBe(404);

    directus.db.users.find((u) => u.email === 'ada@example.com').status = 'suspended';
    const susp = await call('POST', `/api/cards/${CARD_ID}/shares`, { cookie: bob, body: { email: 'ada@example.com' } });
    expect(susp.status).toBe(400);
    expect(susp.json.error.fields.email).toBe('suspended');
  });

  it('audits share and unshare actions', async () => {
    const bob = await share();
    const adaId = directus.db.users.find((u) => u.email === 'ada@example.com').id;
    await call('DELETE', `/api/cards/${CARD_ID}/shares/${adaId}`, { cookie: bob });
    await new Promise((r) => setTimeout(r, 10));
    const actions = directus.db.audit.map((e) => e.action);
    expect(actions).toContain('card.share');
    expect(actions).toContain('card.unshare');
  });

  it('honours share expiry: future ok, past ends access, re-add revives, PATCH extends', async () => {
    const bob = await signIn('bob@example.com', 'bob-pass');
    const future = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
    const past = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    // A past expiry is refused at write time...
    const bad = await call('POST', `/api/cards/${CARD_ID}/shares`, { cookie: bob, body: { email: 'ada@example.com', expires_on: past } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.fields.expires_on).toBe('expires_on_past');

    // ...today is allowed (the day is still running)...
    expect((await call('POST', `/api/cards/${CARD_ID}/shares`, { cookie: bob, body: { email: 'ada@example.com', expires_on: today } })).status).toBe(201);
    let ada = await signIn('ada@example.com', 'ada-pass');
    expect((await call('GET', '/api/cards', { cookie: ada })).json.data.some((c) => c.id === CARD_ID)).toBe(true);

    // ...and once the day passes (row aged behind the fake's clock), access ends.
    directus.db.cardAccess[0].expires_on = past;
    ada = await signIn('ada@example.com', 'ada-pass');
    expect((await call('GET', '/api/cards', { cookie: ada })).json.data.some((c) => c.id === CARD_ID)).toBe(false);
    // The list endpoint hides the expired row, and the count excludes it.
    expect((await call('GET', `/api/cards/${CARD_ID}/shares`, { cookie: bob })).json.data).toHaveLength(0);
    const list = await call('GET', '/api/cards', { cookie: bob });
    expect(list.json.data.find((c) => c.id === CARD_ID).collaborator_count).toBeUndefined();

    // Re-adding revives the dormant row (unique pair does not block it).
    const revived = await call('POST', `/api/cards/${CARD_ID}/shares`, { cookie: bob, body: { email: 'ada@example.com' } });
    expect(revived.status).toBe(201);
    expect(directus.db.cardAccess).toHaveLength(1);
    ada = await signIn('ada@example.com', 'ada-pass');
    expect((await call('GET', '/api/cards', { cookie: ada })).json.data.some((c) => c.id === CARD_ID)).toBe(true);

    // PATCH extends, clears, and refuses malformed values.
    const adaId = directus.db.users.find((u) => u.email === 'ada@example.com').id;
    expect((await call('PATCH', `/api/cards/${CARD_ID}/shares/${adaId}`, { cookie: bob, body: { expires_on: future } })).status).toBe(200);
    expect(directus.db.cardAccess[0].expires_on).toBe(future);
    expect((await call('PATCH', `/api/cards/${CARD_ID}/shares/${adaId}`, { cookie: bob, body: { expires_on: null } })).status).toBe(200);
    expect(directus.db.cardAccess[0].expires_on).toBeNull();
    expect((await call('PATCH', `/api/cards/${CARD_ID}/shares/${adaId}`, { cookie: bob, body: { expires_on: 'soon' } })).json.error.fields.expires_on).toBe('invalid_expires_on');
  });

  it('keeps expiry management owner-only', async () => {
    await share();
    const ada = await signIn('ada@example.com', 'ada-pass');
    const adaId = directus.db.users.find((u) => u.email === 'ada@example.com').id;
    expect((await call('PATCH', `/api/cards/${CARD_ID}/shares/${adaId}`, { cookie: ada, body: { expires_on: null } })).status).toBe(403);
  });

  it('survives installs where the junction is missing (pre-bootstrap)', async () => {
    const plain = fakeDirectus();
    const strict = {
      request(path, opts = {}) {
        if (path.includes('qrv_card_access')) {
          throw new DirectusError(400, 'INVALID_QUERY', "qrv_card_access does not exist");
        }
        return plain.request(path, opts);
      },
    };
    api = createApiHandler({ directus: strict, sessionSecret: 'test-secret-0123456789', log: { warn() {}, error() {} } });
    const ada = await signIn('ada@example.com', 'ada-pass');
    const r = await call('GET', '/api/cards', { cookie: ada });
    expect(r.status).toBe(200);
    expect(r.json.data.some((c) => c.id === ID.adaCard)).toBe(true);
    // Sharing endpoints answer 404-ish cleanly (collection gone → no grants).
    const shares = await call('GET', `/api/cards/${ID.adaCard}/shares`, { cookie: ada });
    expect(shares.status).toBe(200);
    expect(shares.json.data).toHaveLength(0);
  });
});

describe('scan trend', () => {
  it('is admin and editor only', async () => {
    expect((await call('GET', '/api/cards/views')).status).toBe(401);
    const ada = await signIn('ada@example.com', 'ada-pass');
    expect((await call('GET', '/api/cards/views', { cookie: ada })).status).toBe(403);
  });

  it('returns a contiguous 30-day window with holes at zero', async () => {
    await call('GET', '/api/public/cards/adaCard');
    await call('GET', '/api/public/cards/adaCard');
    await call('GET', '/api/public/cards/adaCard');
    await new Promise((r) => setTimeout(r, 10));

    const admin = await signIn('admin@example.com', 'admin-pass');
    const r = await call('GET', '/api/cards/views', { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.json.data.days).toBe(30);
    expect(r.json.data.series).toHaveLength(30);
    expect(r.json.data.total).toBe(3);
    expect(r.json.data.series.at(-1)).toMatchObject({ day: new Date().toISOString().slice(0, 10), views: 3 });
    expect(r.json.data.series.at(-2)).toMatchObject({ views: 0 });
  });

  it('honours a shorter window and clamps absurd ones', async () => {
    await call('GET', '/api/public/cards/adaCard');
    await new Promise((r) => setTimeout(r, 10));

    const admin = await signIn('admin@example.com', 'admin-pass');
    const week = await call('GET', '/api/cards/views?days=7', { cookie: admin });
    expect(week.status).toBe(200);
    expect(week.json.data.series).toHaveLength(7);
    expect(week.json.data.series.at(-1).views).toBe(1);

    const huge = await call('GET', '/api/cards/views?days=5000', { cookie: admin });
    expect(huge.json.data.series.length).toBeLessThanOrEqual(90);
    expect(huge.json.data.series.at(-1).views).toBe(1);
  });

  it('keeps working when the qrv_view_days collection is missing (pre-bootstrap installs)', async () => {
    const plain = fakeDirectus();
    directus = plain; // assertions read this fake's db
    const strict = {
      request(path, opts = {}) {
        if (String(path).includes('qrv_view_days')) {
          throw new DirectusError(403, 'FORBIDDEN', 'qrv_view_days does not exist in this install');
        }
        return plain.request(path, opts);
      },
    };
    api = createApiHandler({ directus: strict, sessionSecret: 'test-secret-0123456789', log: { warn() {}, error() {} } });

    // Totals keep counting without the series.
    await call('GET', '/api/public/cards/adaCard');
    await new Promise((r) => setTimeout(r, 10));
    expect(directus.db.cards.find((c) => c.code === 'adaCard').qrv_views).toBe(1);

    const admin = await signIn('admin@example.com', 'admin-pass');
    const r = await call('GET', '/api/cards/views', { cookie: admin });
    expect(r.status).toBe(501);
    expect(r.json.error.code).toBe('NOT_SUPPORTED');
  });
});

describe('audit log', () => {
  it('is admin-only', async () => {
    expect((await call('GET', '/api/audit')).status).toBe(401);
    const ada = await signIn('ada@example.com', 'ada-pass');
    expect((await call('GET', '/api/audit', { cookie: ada })).status).toBe(403);
  });

  it('records account create / update / password-set / delete with old → new detail', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass');

    const created = await call('POST', '/api/users', {
      cookie,
      body: { email: 'new@example.com', password: 'new-password', role: USER_ROLE.id, first_name: 'New', last_name: 'User' },
    });
    expect(created.status).toBe(201);

    const updated = await call('PATCH', `/api/users/${created.json.data.id}`, { cookie, body: { status: 'suspended', role: EDITOR_ROLE.id } });
    expect(updated.status).toBe(200);

    await call('PATCH', `/api/users/${created.json.data.id}`, { cookie, body: { password: 'another-pass1' } });

    const deleted = await call('DELETE', `/api/users/${created.json.data.id}?cards=delete`, { cookie });
    expect(deleted.status).toBe(200);

    // Fire-and-forget: one turn of the event loop for the writes to land.
    await new Promise((r) => setTimeout(r, 10));

    const trail = await call('GET', '/api/audit', { cookie });
    expect(trail.status).toBe(200);
    const entries = trail.json.data;

    expect(entries.find((e) => e.action === 'user.create')).toMatchObject({ actor_email: 'admin@example.com', target: 'new@example.com' });
    expect(entries.find((e) => e.action === 'user.create').detail).toContain('role:');

    const update = entries.find((e) => e.action === 'user.update');
    expect(update.detail).toContain('status: active → suspended');
    expect(update.detail).toContain('role: vcard-user → vcard-editor');

    expect(entries.find((e) => e.action === 'password.set')).toMatchObject({ target: 'new@example.com' });
    expect(JSON.stringify(entries)).not.toContain('another-pass1');

    const del = entries.find((e) => e.action === 'user.delete');
    expect(del).toMatchObject({ actor_email: 'admin@example.com', target: 'new@example.com' });
    expect(del.detail).toContain('cards:');
  });

  it('records card deletion by name and code, including editors', async () => {
    const editor = await signIn('editor@example.com', 'editor-pass');
    expect((await call('DELETE', `/api/cards/${ID.adaCard}`, { cookie: editor })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    const admin = await signIn('admin@example.com', 'admin-pass');
    const trail = (await call('GET', '/api/audit', { cookie: admin })).json.data;
    const entry = trail.find((e) => e.action === 'card.delete');
    expect(entry).toMatchObject({ actor_email: 'editor@example.com', target: 'adaCard' });
    expect(entry.detail).toContain('name: Ada');
  });

  it('records own-password changes without recording the secret', async () => {
    const ada = await signIn('ada@example.com', 'ada-pass');
    expect((await call('POST', '/api/me/password', { cookie: ada, body: { current_password: 'ada-pass', new_password: 'brand-new-pass' } })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    const admin = await signIn('admin@example.com', 'admin-pass');
    const trail = (await call('GET', '/api/audit', { cookie: admin })).json.data;
    expect(trail.find((e) => e.action === 'password.change')).toMatchObject({ actor_email: 'ada@example.com', target: 'ada@example.com' });
    expect(JSON.stringify(trail)).not.toContain('brand-new-pass');
  });

  it('tolerates a broken audit backend instead of failing the user request', async () => {
    directus.db.audit = null; // the fake will throw on push — the API must not care
    const cookie = await signIn('admin@example.com', 'admin-pass');
    expect((await call('POST', '/api/users', { cookie, body: { email: 'still@example.com', password: 'still-pass1', role: USER_ROLE.id, first_name: 'S', last_name: 'T' } })).status).toBe(201);
    expect(directus.db.users.some((u) => u.email === 'still@example.com')).toBe(true);
  });
});
