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
    const value = row[key];
    if (cond && typeof cond === 'object') {
      if ('_eq' in cond) return value === cond._eq;
      if ('_neq' in cond) return value !== cond._neq;
      if ('_in' in cond) return cond._in.includes(value);
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
    ].map((u) => ({ first_name: null, last_name: null, last_access: null, qrv_session_epoch: 0, ...u })),
    cards: [
      { id: ID.adaCard, code: 'adaCard', status: 'published', first_name: 'Ada', owner: ID.ada, photo: null },
      { id: ID.bobCard, code: 'bobCard', status: 'draft', first_name: 'Bob', phone: '+1 555', owner: ID.bob, photo: null },
    ],
    files: [],
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
      const user = { id: newId(), first_name: null, last_name: null, last_access: null, qrv_session_epoch: 0, ...body };
      db.users.push(user);
      return { id: user.id };
    }
    if ((m = path.match(/^\/users\/(.+)$/))) {
      const user = db.users.find((u) => u.id === m[1]);
      if (method === 'PATCH') {
        if (body.email && db.users.some((u) => u.id !== user.id && u.email === body.email)) {
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
      return rows.map((c) => ({ ...c }));
    }
    if (path === '/items/vcards' && method === 'POST') {
      if (db.cards.some((c) => c.code === body.code)) throw new DirectusError(400, 'RECORD_NOT_UNIQUE', 'dup');
      const card = { id: newId(), photo: null, date_created: new Date().toISOString(), ...body };
      db.cards.push(card);
      return { ...card };
    }
    if (path === '/items/vcards' && method === 'PATCH') {
      for (const c of db.cards) if (body.keys.includes(c.id)) Object.assign(c, body.data);
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
  api = createApiHandler({ directus, sessionSecret: 'test-secret-0123456789', maxCardsPerUser: 3, log: { warn() {}, error() {} } });
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
    const forged = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
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
});
