#!/usr/bin/env node
/**
 * One-time (idempotent) Directus setup for the QR-VCard project.
 *
 * Prerequisite: a running Directus instance — local via
 *   docker compose -f directus/docker-compose.yml up -d
 * or remote: put DIRECTUS_URL + DIRECTUS_ADMIN_TOKEN (admin static token) in directus/.env.
 *
 * Ensures the `vcards` collection, roles `vcard-editor` / `vcard-user`
 * (each with its own policy + permissions), the two panel users and one
 * published seed card (code `demo-01`). Safe to re-run.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, '.env');

const DEFAULTS = {
  DIRECTUS_URL: 'http://localhost:8055',
  ADMIN_EMAIL: 'admin@local.dev',
  ADMIN_PASSWORD: 'vcard-admin',
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

  // ---- policies ------------------------------------------------------------
  const policies = await api('/policies?limit=-1', { token: adminToken });
  const ensurePolicy = async (name) => {
    const found = policies.find((p) => p.name === name);
    if (found) return found.id;
    const created = await api('/policies', { method: 'POST', token: adminToken, body: { name, app_access: true, admin_access: false } });
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
      const created = await api('/roles', { method: 'POST', token: adminToken, body: { name, icon, description, app_access: true, admin_access: false } });
      roleId = created.id;
    }
    const linked = (roles[0]?.policies ?? []).some((p) => (p.policy?.id ?? p.policy) === policyId);
    if (!linked) {
      await api(`/roles/${roleId}`, { method: 'PATCH', token: adminToken, body: { policies: { create: [{ policy: policyId }] } } });
      console.log(`[bootstrap] role ${name} linked to its policy`);
    }
    return roleId;
  };
  const editorRoleId = await ensureRole('vcard-editor', 'shield', 'Shared panel account: full vCard management', editorPolicyId);
  const userRoleId = await ensureRole('vcard-user', 'account_circle', 'Owns and manages only their own vCards', userPolicyId);

  // ---- permissions (upsert under each policy) ------------------------------
  const CONTACT_FIELDS = ['code', 'status', 'first_name', 'last_name', 'organization', 'job_title', 'phone', 'email', 'website', 'address', 'note', 'accent_color', 'photo', 'date_created'];
  const SPEC = [
    { policy: publicId, collection: 'directus_files', action: 'read', fields: ['*'], permissions: null },
    { policy: editorPolicyId, collection: 'directus_files', action: 'read', fields: ['*'], permissions: null },
    { policy: editorPolicyId, collection: 'directus_files', action: 'create', fields: ['*'], permissions: null },
    { policy: userPolicyId, collection: 'directus_files', action: 'read', fields: ['*'], permissions: null },
    { policy: userPolicyId, collection: 'directus_files', action: 'create', fields: ['*'], permissions: null },
    { policy: publicId, collection: 'vcards', action: 'read', fields: CONTACT_FIELDS, permissions: { status: { _eq: 'published' } } },
    { policy: editorPolicyId, collection: 'vcards', action: 'create', fields: ['*'], permissions: null },
    { policy: editorPolicyId, collection: 'vcards', action: 'read', fields: ['*'], permissions: null },
    { policy: editorPolicyId, collection: 'vcards', action: 'update', fields: ['*'], permissions: null },
    { policy: editorPolicyId, collection: 'vcards', action: 'delete', fields: [], permissions: null },
    { policy: userPolicyId, collection: 'vcards', action: 'create', fields: [...CONTACT_FIELDS.filter((f) => f !== 'date_created'), 'user_created'], permissions: null },
    { policy: userPolicyId, collection: 'vcards', action: 'read', fields: ['*'], permissions: { user_created: { _eq: '$CURRENT_USER' } } },
    { policy: userPolicyId, collection: 'vcards', action: 'update', fields: ['*'], permissions: { user_created: { _eq: '$CURRENT_USER' } } },
    { policy: userPolicyId, collection: 'vcards', action: 'delete', fields: [], permissions: { user_created: { _eq: '$CURRENT_USER' } } },
  ];

  const existingPerms = await api('/permissions?limit=-1', { token: adminToken });
  let restrictedRule = false;
  for (const spec of SPEC) {
    const found = existingPerms.find((p) => p.policy === spec.policy && p.collection === spec.collection && p.action === spec.action);
    const write = async (body) => {
      try {
        if (found) await api(`/permissions/${found.id}`, { method: 'PATCH', token: adminToken, body });
        else await api('/permissions', { method: 'POST', token: adminToken, body });
      } catch (err) {
        // Directus 12 gates row-level filter rules behind a license
        // (RESOURCE_RESTRICTED: custom_permission_rules_enabled). Fall back to a
        // rule-less permission so local development still works.
        if (/RESOURCE_RESTRICTED|custom_permission_rules_enabled/.test(err?.message ?? '')) {
          restrictedRule = true;
          // Directus 12 (unlicensed) accepts exactly one shape for any
          // permission write: `permissions: null` + `fields: ['*']`. Both row
          // filters and explicit field lists are gated features.
          const downgraded = { ...body, fields: ['*'], permissions: null };
          try {
            if (found) await api(`/permissions/${found.id}`, { method: 'PATCH', token: adminToken, body: downgraded });
            else await api('/permissions', { method: 'POST', token: adminToken, body: downgraded });
            console.warn(`[bootstrap]   rule skipped for ${spec.collection}.${spec.action} (license-restricted)`);
          } catch (retryErr) {
            console.warn(`[bootstrap]   DOWNGRADE FAILED for ${spec.collection}.${spec.action}: ${retryErr?.message ?? retryErr}`);
            throw retryErr;
          }
          return;
        }
        throw err;
      }
    };
    await write(spec);
  }
  if (restrictedRule) {
    console.warn('[bootstrap] WARNING: this Directus has no license, so row-level permission rules were skipped.');
    console.warn('[bootstrap]          Isolation of "own vCards" is therefore enforced in the app (listCards filters on user_created), not by the API.');
  }
  // Record the capability so verify.mjs can report API-level isolation checks
  // as explicit SKIPs instead of failures on an unlicensed instance.
  writeFileSync(join(HERE, '.bootstrap-state.json'), `${JSON.stringify({ rowRulesSupported: !restrictedRule, at: new Date().toISOString() }, null, 2)}\n`);
  console.log('[bootstrap] permissions ensured (public/editor/user policies)');

  // Directus caches permission/role metadata, so a verify run immediately after
  // bootstrap can still see the pre-change ACLs (public read intermittently
  // 403). Flush the cache once provisioning is done.
  await api('/utils/cache/clear', { method: 'POST', token: adminToken });
  console.log('[bootstrap] cache cleared');

  // ---- panel users -----------------------------------------------------------
  const ensureUser = async (email, password, roleId, first) => {
    const existing = await api(`/users?filter[email][_eq]=${encodeURIComponent(email)}&limit=-1`, { token: adminToken });
    if (existing.length) return existing[0].id;
    await api('/users', { method: 'POST', token: adminToken, body: { email, password, role: roleId, first_name: first, status: 'active' } });
    console.log(`[bootstrap] user ${email} created`);
    return (await api(`/users?filter[email][_eq]=${encodeURIComponent(email)}&limit=-1`, { token: adminToken }))[0].id;
  };
  await ensureUser(env.EDITOR_EMAIL, env.EDITOR_PASSWORD, editorRoleId, 'Panel');
  await ensureUser(env.USER_EMAIL, env.USER_PASSWORD, userRoleId, 'Ada');

  // ---- seed card -------------------------------------------------------------
  const seed = await findOne(`/items/vcards?filter[code][_eq]=${encodeURIComponent(env.SEED_CODE)}&limit=-1`, adminToken);
  if (!seed) {
    await api('/items/vcards', {
      method: 'POST',
      token: adminToken,
      body: {
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
        note: 'Seed demo card — publish or delete freely.',
        accent_color: '#4f46e5',
      },
    });
    console.log(`[bootstrap] seed card created (code ${env.SEED_CODE})`);
  } else {
    console.log('[bootstrap] seed card exists');
    // Self-heal: the demo card must stay published, otherwise the public scan
    // page (and verify.mjs) has nothing to read.
    if (seed.status !== 'published') {
      await api(`/items/vcards/${seed.id}`, { method: 'PATCH', token: adminToken, body: { status: 'published' } });
      console.log('[bootstrap] seed card restored to published');
    }
  }

  console.log('[bootstrap] done. Scan target for testing: /c/' + env.SEED_CODE);
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
