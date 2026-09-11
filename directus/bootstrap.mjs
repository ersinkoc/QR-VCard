#!/usr/bin/env node
/**
 * One-time (idempotent) Directus setup for the QR-VCard project.
 *
 * Prerequisite: a running Directus instance — local via
 *   docker compose -f directus/docker-compose.yml up -d
 * or remote: put DIRECTUS_URL + DIRECTUS_ADMIN_TOKEN (admin static token) in directus/.env.
 *
 * Ensures the `vcards` collection, roles `vcard-editor` / `vcard-user` (policies
 * WITHOUT any direct data access), the service account whose static token the
 * app server uses (written to the root .env as DIRECTUS_TOKEN), the two demo
 * accounts and one published seed card (code `demo-01`). Safe to re-run.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, '.env');
/** The app server's env file — where DIRECTUS_URL / DIRECTUS_TOKEN are written. */
const ROOT_ENV_PATH = join(HERE, '..', '.env');

function readRootEnv() {
  if (!existsSync(ROOT_ENV_PATH)) return {};
  const out = {};
  for (const line of readFileSync(ROOT_ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2].trim() !== '') out[m[1]] = m[2].trim();
  }
  return out;
}

/** Sets keys in the root .env, replacing existing lines and appending new ones. */
function writeRootEnv(values) {
  let text = existsSync(ROOT_ENV_PATH) ? readFileSync(ROOT_ENV_PATH, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, `${key}=${value}`);
    else text += `${text === '' || text.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
  }
  writeFileSync(ROOT_ENV_PATH, text);
}

const DEFAULTS = {
  DIRECTUS_URL: 'http://localhost:8055',
  ADMIN_EMAIL: 'admin@local.dev',
  ADMIN_PASSWORD: 'vcard-admin',
  ADMIN_SEED_CODE: 'demo-admin',
  DIRECTUS_ADMIN_TOKEN: '',
  EDITOR_EMAIL: 'editor@local.dev',
  EDITOR_PASSWORD: 'vcard-editor',
  USER_EMAIL: 'ada@local.dev',
  USER_PASSWORD: 'vcard-user',
  SEED_CODE: 'demo-01',
};

function readEnvFile() {
  if (!existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

if (!existsSync(ENV_PATH)) {
  writeFileSync(
    ENV_PATH,
    Object.entries({ ...DEFAULTS, KEY: randomUUID(), SECRET: randomUUID() })
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
  );
  console.log(`[bootstrap] wrote ${ENV_PATH}`);
}

// Precedence: process env > directus/.env file > defaults — the reverse of the old
// order. `DIRECTUS_URL=https://remote npm run directus:bootstrap` (the remote
// admin-token flow in README) must not be silently overridden by leftover
// localhost values in directus/.env; verify.mjs already resolves env this way.
const env = { ...DEFAULTS, ...readEnvFile(), ...process.env };
const BASE = env.DIRECTUS_URL.replace(/\/+$/, '');

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${res.status} ${method} ${path}: ${JSON.stringify(json.errors?.map((e) => e.message) ?? json)}`);
  }
  return json.data;
}

async function login(email, password) {
  const data = await api('/auth/login', { method: 'POST', body: { email, password } });
  return data.access_token ?? data.token;
}

async function findOne(path, token) {
  const rows = await api(path, { token });
  return Array.isArray(rows) ? (rows[0] ?? null) : rows;
}

async function main() {
  console.log(`[bootstrap] target: ${BASE}`);
  const hasRealToken = env.DIRECTUS_ADMIN_TOKEN && !/placeholder/i.test(env.DIRECTUS_ADMIN_TOKEN);
  const adminToken = hasRealToken ? env.DIRECTUS_ADMIN_TOKEN : await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);

  // ---- collection: vcards -------------------------------------------------
  let vcards = null;
  try {
    vcards = await api('/collections/vcards', { token: adminToken });
  } catch {
    /* not created yet */
  }
  if (!vcards) {
    await api('/collections', {
      method: 'POST',
      token: adminToken,
      body: {
        collection: 'vcards',
        meta: { icon: 'contact_mail', note: 'Digital business cards shared via QR short URLs', sort_field: 'sort', archive_field: 'status', archive_value: 'archived', unarchive_value: 'draft' },
        schema: {},
        fields: [
          { field: 'id', type: 'uuid', meta: { hidden: true, readonly: true, interface: 'input', special: ['uuid'] }, schema: { is_primary_key: true } },
          { field: 'status', type: 'string', meta: { interface: 'select-dropdown', display: 'labels', options: { choices: [{ text: 'Published', value: 'published' }, { text: 'Draft', value: 'draft' }, { text: 'Archived', value: 'archived' }] }, default_value: 'draft', required: true, width: 'half' }, schema: { default_value: 'draft' } },
          { field: 'sort', type: 'integer', meta: { hidden: true } },
          { field: 'user_created', type: 'uuid', meta: { special: ['user-created'] } },
          { field: 'date_created', type: 'timestamp', meta: { special: ['date-created'], interface: 'datetime', readonly: true } },
          { field: 'code', type: 'string', meta: { interface: 'input', required: true, width: 'half', note: 'Short code behind the QR link: /c/<code>' }, schema: { is_unique: true, max_length: 32 } },
          { field: 'first_name', type: 'string', meta: { interface: 'input', width: 'half' } },
          { field: 'last_name', type: 'string', meta: { interface: 'input', width: 'half' } },
          { field: 'organization', type: 'string', meta: { interface: 'input', width: 'half' } },
          { field: 'job_title', type: 'string', meta: { interface: 'input', width: 'half' } },
          { field: 'phone', type: 'string', meta: { interface: 'input', width: 'half' } },
          { field: 'email', type: 'string', meta: { interface: 'input', width: 'half' } },
          { field: 'website', type: 'string', meta: { interface: 'input' } },
          { field: 'address', type: 'text', meta: { interface: 'input-multiline', options: { placeholder: 'Street, city…' } } },
          { field: 'note', type: 'text', meta: { interface: 'input-multiline' } },
          { field: 'accent_color', type: 'string', meta: { interface: 'select-color', default_value: '#4f46e5' }, schema: { default_value: '#4f46e5' } },
          { field: 'photo', type: 'uuid', meta: { special: ['file'], interface: 'file-image' } },
        ],
      },
    });
    console.log('[bootstrap] collection vcards created');
  } else {
    console.log('[bootstrap] collection vcards exists');
  }

  // Repair installs created before `special: ['uuid']` was set on `id`:
  // without it Directus does not generate a PK on insert (400 "id required").
  // POST /fields requires a full definition, so send the complete field meta.
  await api('/fields/vcards/id', {
    method: 'PATCH',
    token: adminToken,
    body: { meta: { hidden: true, readonly: true, interface: 'input', special: ['uuid'] }, schema: { is_primary_key: true } },
  });

  // Session epoch on accounts: the app server bumps it whenever a password is set,
  // which invalidates every existing session cookie of that account.
  const hasEpoch = await api('/fields/directus_users/qrv_session_epoch', { token: adminToken }).then(() => true, () => false);
  if (!hasEpoch) {
    await api('/fields/directus_users', {
      method: 'POST',
      token: adminToken,
      body: { field: 'qrv_session_epoch', type: 'integer', meta: { hidden: true, readonly: true, interface: 'input', note: 'QR-VCard session epoch (managed by the app server)' }, schema: { default_value: 0 } },
    });
    console.log('[bootstrap] field directus_users.qrv_session_epoch created');
  }

  // ---- policies ------------------------------------------------------------
  // The vCard policies grant NOTHING and no Studio access: people sign in to the
  // QR-VCard app, whose server authorises each request and talks to Directus with
  // the service token. The policies exist only so roles have something to hang on.
  const policies = await api('/policies?limit=-1', { token: adminToken });
  const ensurePolicy = async (name) => {
    const found = policies.find((p) => p.name === name);
    if (found) {
      if (found.app_access || found.admin_access) {
        await api(`/policies/${found.id}`, { method: 'PATCH', token: adminToken, body: { app_access: false, admin_access: false } });
      }
      return found.id;
    }
    const created = await api('/policies', { method: 'POST', token: adminToken, body: { name, app_access: false, admin_access: false } });
    return created.id;
  };
  // The built-in anonymous policy is stored under the untranslated label key
  // `$t:public_label` on a fresh Directus 12 install — matching only on
  // "Public" silently creates a second, unused policy and puts the public read
  // permission on the wrong one (anonymous requests then get 403).
  const PUBLIC_POLICY_NAMES = ['$t:public_label', 'Public'];
  const publicId = (PUBLIC_POLICY_NAMES.map((n) => policies.find((p) => p.name === n)).find(Boolean)
    ?? (await api('/policies', { method: 'POST', token: adminToken, body: { name: 'Public', app_access: true, admin_access: false } }))).id;
  const editorPolicyId = await ensurePolicy('vCard Editor');
  const userPolicyId = await ensurePolicy('vCard User');

  // ---- roles ---------------------------------------------------------------
  // Directus 12 rejects POST /roles with a non-empty `policies` array
  // (403 FORBIDDEN) and only accepts the staged-create form on PATCH, so roles
  // are created bare and the policy link is ensured afterwards — including for
  // roles created by an earlier run whose link attempt failed.
  const ensureRole = async (name, icon, description, policyId) => {
    const roles = await api(`/roles?filter[name][_eq]=${encodeURIComponent(name)}&fields=id,policies.policy&limit=-1`, { token: adminToken });
    let roleId = roles[0]?.id;
    if (!roleId) {
      const created = await api('/roles', { method: 'POST', token: adminToken, body: { name, icon, description } });
      roleId = created.id;
    }
    const linked = (roles[0]?.policies ?? []).some((p) => (p.policy?.id ?? p.policy) === policyId);
    if (!linked) {
      await api(`/roles/${roleId}`, { method: 'PATCH', token: adminToken, body: { policies: { create: [{ policy: policyId }] } } });
      console.log(`[bootstrap] role ${name} linked to its policy`);
    }
    return roleId;
  };
  const editorRoleId = await ensureRole('vcard-editor', 'shield', 'QR-VCard: manages every card', editorPolicyId);
  const userRoleId = await ensureRole('vcard-user', 'account_circle', 'QR-VCard: owns and manages only their own cards', userPolicyId);

  // ---- permissions: lock the data away from browsers ------------------------
  // Earlier versions granted the public and vCard policies direct access to
  // `vcards` and `directus_files`. Without a Directus license those grants could
  // not be row-scoped, so any signed-in user could read, edit and delete EVERY
  // card straight through the Directus API. Card access now lives in the app
  // server (server/api.mjs), so every such grant is removed here.
  const LOCKED = new Set(['vcards', 'directus_files']);
  const lockedPolicies = new Set([publicId, editorPolicyId, userPolicyId]);
  const existingPerms = await api('/permissions?limit=-1', { token: adminToken });
  const stale = existingPerms.filter((p) => lockedPolicies.has(p.policy) && LOCKED.has(p.collection));
  for (const perm of stale) {
    await api(`/permissions/${perm.id}`, { method: 'DELETE', token: adminToken });
    console.log(`[bootstrap] removed direct grant ${perm.collection}.${perm.action}`);
  }
  if (existsSync(join(HERE, '.bootstrap-state.json'))) rmSync(join(HERE, '.bootstrap-state.json'));
  console.log('[bootstrap] public / vCard policies hold no direct data access');

  // ---- service account: the app server's identity ---------------------------
  // An Administrator-role account without a password, used only through its
  // static token by server/api.mjs. Its token goes to DIRECTUS_TOKEN in the root
  // .env — never to the browser.
  const adminRole = (await api(`/roles?filter[name][_eq]=Administrator&fields=id&limit=1`, { token: adminToken }))[0];
  if (!adminRole) throw new Error('no "Administrator" role found — the service account needs it');
  // Directus validates the address strictly (a `.local` domain is refused).
  const serviceEmail = env.SERVICE_EMAIL || 'qr-vcard-service@example.com';
  let service = (await api(`/users?filter[email][_eq]=${encodeURIComponent(serviceEmail)}&fields=id&limit=1`, { token: adminToken }))[0];
  if (!service) {
    service = await api('/users', { method: 'POST', token: adminToken, body: { email: serviceEmail, first_name: 'QR-VCard', last_name: 'Service', role: adminRole.id, status: 'active' } });
    console.log(`[bootstrap] service account ${serviceEmail} created`);
  }
  const rootEnv = readRootEnv();
  const current = process.env.DIRECTUS_TOKEN || rootEnv.DIRECTUS_TOKEN || '';
  const currentWorks = current
    ? await api('/users/me?fields=id', { token: current }).then((me) => me?.id === service.id, () => false)
    : false;
  if (currentWorks) {
    console.log('[bootstrap] DIRECTUS_TOKEN already belongs to the service account');
  } else {
    const token = randomBytes(32).toString('hex');
    await api(`/users/${service.id}`, { method: 'PATCH', token: adminToken, body: { token } });
    writeRootEnv({ DIRECTUS_TOKEN: token, ...(rootEnv.DIRECTUS_URL ? {} : { DIRECTUS_URL: BASE }) });
    console.log(`[bootstrap] service token issued and written to ${ROOT_ENV_PATH} (DIRECTUS_TOKEN) — copy it to your deploy platform's variables`);
  }

  // Directus caches permission/role metadata, so a verify run immediately after
  // bootstrap can still see the pre-change ACLs (public read intermittently
  // 403). Flush the cache once provisioning is done.
  await api('/utils/cache/clear', { method: 'POST', token: adminToken });
  console.log('[bootstrap] cache cleared');

  // ---- ownership: vcards.owner -------------------------------------------------
  // Directus stamps `user_created` with the CALLER on every create, and every
  // create now comes from the service token — so ownership needs its own column,
  // written only by the app server. It is an m2o to directus_users, so Studio
  // shows the owner's email.
  const hasOwner = await api('/fields/vcards/owner', { token: adminToken }).then(() => true, () => false);
  if (!hasOwner) {
    await api('/fields/vcards', {
      method: 'POST',
      token: adminToken,
      body: {
        field: 'owner',
        type: 'uuid',
        meta: { interface: 'select-dropdown-m2o', special: ['m2o'], display: 'related-values', display_options: { template: '{{email}}' }, options: { template: '{{email}}' }, width: 'half', note: 'Card owner (managed by the QR-VCard server)' },
        schema: {},
      },
    });
    await api('/relations', {
      method: 'POST',
      token: adminToken,
      body: { collection: 'vcards', field: 'owner', related_collection: 'directus_users', schema: { on_delete: 'SET NULL' } },
    });
    console.log('[bootstrap] field vcards.owner created (m2o -> directus_users)');
  }
  // How the card image is framed: `avatar` (round, cropped) or `logo` (uncropped).
  const hasPhotoStyle = await api('/fields/vcards/photo_style', { token: adminToken }).then(() => true, () => false);
  if (!hasPhotoStyle) {
    await api('/fields/vcards', {
      method: 'POST',
      token: adminToken,
      body: {
        field: 'photo_style',
        type: 'string',
        meta: { interface: 'select-dropdown', options: { choices: [{ text: 'Photo (round)', value: 'avatar' }, { text: 'Logo (uncropped)', value: 'logo' }] }, width: 'half' },
        schema: { default_value: 'avatar', max_length: 16 },
      },
    });
    console.log('[bootstrap] field vcards.photo_style created');
  }

  // Migrate: cards from before the owner column belong to whoever created them —
  // unless that was the service account, in which case the admin takes them.
  const adminMe = await api('/users/me?fields=id', { token: adminToken });
  const unowned = await api('/items/vcards?filter[owner][_null]=true&fields=id,user_created&limit=-1', { token: adminToken });
  for (const row of unowned) {
    const creator = typeof row.user_created === 'object' ? row.user_created?.id : row.user_created;
    const owner = creator && creator !== service.id ? creator : adminMe.id;
    await api(`/items/vcards/${row.id}`, { method: 'PATCH', token: adminToken, body: { owner } });
  }
  if (unowned.length) console.log(`[bootstrap] ${unowned.length} card(s) given an owner`);

  // ---- panel users -----------------------------------------------------------
  const ensureUser = async (email, password, roleId, first, last = '') => {
    const existing = await api(`/users?filter[email][_eq]=${encodeURIComponent(email)}&limit=-1`, { token: adminToken });
    if (existing.length) {
      const u = existing[0];
      const updates = {};
      if (u.status !== 'active') updates.status = 'active';
      if ((u.role?.id ?? u.role) !== roleId) updates.role = roleId;
      if (!u.first_name && first) updates.first_name = first;
      if (!u.last_name && last) updates.last_name = last;
      if (Object.keys(updates).length > 0) {
        await api(`/users/${u.id}`, { method: 'PATCH', token: adminToken, body: updates });
        console.log(`[bootstrap] user ${email} updated`);
      }
      return u.id;
    }
    await api('/users', {
      method: 'POST',
      token: adminToken,
      body: { email, password, role: roleId, first_name: first, ...(last ? { last_name: last } : {}), status: 'active' },
    });
    console.log(`[bootstrap] user ${email} created`);
    return (await api(`/users?filter[email][_eq]=${encodeURIComponent(email)}&limit=-1`, { token: adminToken }))[0].id;
  };

  // 1. Administrator: manages everything (cards + user accounts)
  const adminId = await ensureUser(env.ADMIN_EMAIL, env.ADMIN_PASSWORD, adminRole.id, 'Admin', 'User');
  // 2. Editor: manages all cards across the system, cannot manage users
  const editorId = await ensureUser(env.EDITOR_EMAIL, env.EDITOR_PASSWORD, editorRoleId, 'Editor', 'User');
  // 3. User: has their own account, manages only their own cards
  const userId = await ensureUser(env.USER_EMAIL, env.USER_PASSWORD, userRoleId, 'Ada', 'Lovelace');

  // ---- seed cards ------------------------------------------------------------
  // 1. User demo card (/c/demo-01) owned by Ada (vcard-user)
  const seed = await findOne(`/items/vcards?filter[code][_eq]=${encodeURIComponent(env.SEED_CODE)}&limit=-1`, adminToken);
  if (!seed) {
    await api('/items/vcards', {
      method: 'POST',
      token: adminToken,
      body: {
        owner: userId,
        status: 'published',
        code: env.SEED_CODE,
        first_name: 'Ada',
        last_name: 'Lovelace',
        organization: 'Analytical Engines Ltd',
        job_title: 'Chief Mathematician',
        phone: '+44 20 7946 0958',
        email: 'ada@example.com',
        website: 'https://example.com/ada',
        address: '12 St James’s Square, London',
        note: 'Seed user demo card — owned by Ada (vcard-user).',
        accent_color: '#4f46e5',
      },
    });
    console.log(`[bootstrap] seed user card created (code ${env.SEED_CODE}, owner: ${env.USER_EMAIL})`);
  } else {
    console.log('[bootstrap] seed user card exists');
    const updates = {};
    if (seed.status !== 'published') updates.status = 'published';
    const currentOwner = typeof seed.owner === 'object' ? seed.owner?.id : seed.owner;
    if (!currentOwner && userId) updates.owner = userId;
    if (Object.keys(updates).length > 0) {
      await api(`/items/vcards/${seed.id}`, { method: 'PATCH', token: adminToken, body: updates });
      console.log('[bootstrap] seed user card updated/healed');
    }
  }

  // 2. Admin demo card (/c/demo-admin) owned by Admin (Administrator)
  const adminCardCode = env.ADMIN_SEED_CODE || 'demo-admin';
  const adminSeed = await findOne(`/items/vcards?filter[code][_eq]=${encodeURIComponent(adminCardCode)}&limit=-1`, adminToken);
  if (!adminSeed) {
    await api('/items/vcards', {
      method: 'POST',
      token: adminToken,
      body: {
        owner: adminId,
        status: 'published',
        code: adminCardCode,
        first_name: 'Admin',
        last_name: 'System',
        organization: 'QR-VCard Operations',
        job_title: 'System Administrator',
        phone: '+90 555 000 0000',
        email: env.ADMIN_EMAIL,
        website: 'https://example.com',
        address: 'Istanbul, Turkey',
        note: 'Seed admin demo card — owned by Admin (Administrator).',
        accent_color: '#0f172a',
      },
    });
    console.log(`[bootstrap] seed admin card created (code ${adminCardCode}, owner: ${env.ADMIN_EMAIL})`);
  } else {
    console.log('[bootstrap] seed admin card exists');
    const updates = {};
    if (adminSeed.status !== 'published') updates.status = 'published';
    const currentOwner = typeof adminSeed.owner === 'object' ? adminSeed.owner?.id : adminSeed.owner;
    if (!currentOwner && adminId) updates.owner = adminId;
    if (Object.keys(updates).length > 0) {
      await api(`/items/vcards/${adminSeed.id}`, { method: 'PATCH', token: adminToken, body: updates });
      console.log('[bootstrap] seed admin card updated/healed');
    }
  }

  console.log(`[bootstrap] done. Scan targets: /c/${env.SEED_CODE} (User) and /c/${adminCardCode} (Admin)`);
}

main()
  .then(() => {
    // Set the code instead of calling process.exit(): exiting while fetch
    // sockets are still tearing down has thrown a libuv assertion on Windows,
    // and process.exit can truncate buffered output.
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error(`[bootstrap] FAILED: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
