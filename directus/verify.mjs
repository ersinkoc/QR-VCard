#!/usr/bin/env node
/**
 * End-to-end API smoke test against a RUNNING Directus (same env as bootstrap).
 * Verifies the exact permissions the app depends on; exits non-zero on failure.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = {};
if (existsSync(join(HERE, '.env'))) {
  for (const line of readFileSync(join(HERE, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
}
Object.assign(env, process.env);
const BASE = (env.DIRECTUS_URL || 'http://localhost:8055').replace(/\/+$/, '');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
function skip(name) {
  console.log(`SKIP  ${name}`);
}

// bootstrap.mjs records whether this Directus allowed row-level permission
// rules (license-gated in Directus 12). Absent file => assume supported.
let rowRules = true;
try {
  rowRules = JSON.parse(readFileSync(join(HERE, '.bootstrap-state.json'), 'utf8')).rowRulesSupported !== false;
} catch {
  /* keep default */
}

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    /* empty body ok */
  }
  return { status: res.status, json };
}

async function login(email, password) {
  const { status, json } = await call('/auth/login', { method: 'POST', body: { email, password } });
  if (status !== 200) throw new Error(`login ${email} failed (${status})`);
  return json.data.access_token ?? json.data.token;
}

async function main() {
  const seedCode = env.SEED_CODE || 'demo-01';

  // 1. Public read of the published seed card
  const pub = await call(`/items/vcards?filter[code][_eq]=${seedCode}`);
  const seed = pub.json?.data?.[0];
  check('public can read published seed card', pub.status === 200 && seed && seed.code === seedCode && seed.status === 'published');
  if (rowRules) check('public view hides owner field (user_created not exposed)', seed && !('user_created' in seed));
  else skip('public view hides owner field (needs a Directus license for field-level rules)');

  // 2. Public list filter excludes drafts implicitly (status filter path verified above)

  // 3. Editor login + full CRUD lifecycle on a throwaway card
  const editorToken = await login(env.EDITOR_EMAIL || 'editor@local.dev', env.EDITOR_PASSWORD || 'vcard-editor');
  check('editor can log in', !!editorToken);
  const code = `vrf-${randomUUID().slice(0, 6)}`;
  const created = await call('/items/vcards', { method: 'POST', token: editorToken, body: { status: 'draft', code, first_name: 'Verify', last_name: 'Bot', email: 'verify@example.com' } });
  const cardId = created.json?.data?.id;
  check('editor can create a card', created.status === 200 && !!cardId, `code=${code}`);
  if (cardId) {
    const upd = await call(`/items/vcards/${cardId}`, { method: 'PATCH', token: editorToken, body: { status: 'published', job_title: 'QA' } });
    check('editor can update a card', upd.status === 200 && upd.json?.data?.status === 'published' && upd.json?.data?.job_title === 'QA');
    const pub2 = await call(`/items/vcards?filter[code][_eq]=${code}`);
    check('newly published card is publicly visible', pub2.json?.data?.length === 1);
    const del = await call(`/items/vcards/${cardId}`, { method: 'DELETE', token: editorToken });
    check('editor can delete a card', del.status === 204 || del.status === 200);
    const after = await call(`/items/vcards?filter[code][_eq]=${code}`);
    check('deleted card no longer visible', after.json?.data?.length === 0);
  }

  // 4. Ownership isolation for vcard-user
  // Row-filter rules are license-gated in Directus 12; when bootstrap reports
  // they were unavailable, these guarantees are enforced in the app instead.
  const userToken = await login(env.USER_EMAIL || 'ada@local.dev', env.USER_PASSWORD || 'vcard-user');
  const others = await call(`/items/vcards?filter[code][_eq]=${seedCode}`, { token: userToken });
  if (rowRules) {
    check("user cannot read other users' cards", others.status === 200 && others.json?.data?.length === 0);
  } else {
    skip("user cannot read other users' cards (needs a Directus license for row-level rules)");
  }
  const ucode = `vrf-u-${randomUUID().slice(0, 6)}`;
  const own = await call('/items/vcards', { method: 'POST', token: userToken, body: { status: 'draft', code: ucode, first_name: 'Own', last_name: 'Card' } });
  const ownId = own.json?.data?.id;
  check('user can create own card', own.status === 200 && !!ownId, `code=${ucode}`);
  if (ownId) {
    const open = await call(`/items/vcards?filter[code][_eq]=${ucode}`);
    if (rowRules) check('own draft card is not publicly visible', open.json?.data?.length === 0);
    else skip('own draft card is not publicly visible (needs a Directus license for row-level rules)');
    const patchOther = rowRules
      ? await (async () => {
          // Probe with a throwaway card owned by the editor — never the seed,
          // which this check used to mutate (unpublishing it and breaking the
          // next run's public-read assertion).
          const probe = await call('/items/vcards', { method: 'POST', token: editorToken, body: { status: 'draft', code: `vrf-t-${randomUUID().slice(0, 6)}`, first_name: 'Probe', last_name: 'Target' } });
          const probeId = probe.json?.data?.id;
          const res = await call(`/items/vcards/${probeId}`, { method: 'PATCH', token: userToken, body: { status: 'draft' } });
          if (probeId) await call(`/items/vcards/${probeId}`, { method: 'DELETE', token: editorToken });
          return res;
        })()
      : null;
    if (rowRules) check('user cannot update another user card', patchOther.status === 403 || patchOther.status === 404);
    else skip('user cannot update another user card (needs a Directus license for row-level rules)');
    const del2 = await call(`/items/vcards/${ownId}`, { method: 'DELETE', token: userToken });
    check('user can delete own card', del2.status === 204 || del2.status === 200);
  }

  // 5. Core collections are NOT served by the Items API.
  // `/items/{collection}` only serves user-defined collections: for a core
  // collection it answers 403 even to an administrator (the route does not serve
  // it at all, so it is not a permission problem). That is why the adapter must
  // call the system endpoints (/users, /roles, ...). This contract is locked
  // here because unit tests cannot catch a wrong endpoint — the SDK request
  // object is opaque, so a mocked `request` sees nothing to assert on.
  const adminToken = await login(env.ADMIN_EMAIL || 'admin@local.dev', env.ADMIN_PASSWORD || 'vcard-admin');
  const itemsCore = await call('/items/directus_users?limit=1', { token: adminToken });
  check('core collection is refused by the Items API (403, even for an admin)', itemsCore.status === 403, `status=${itemsCore.status}`);
  const usersRes = await call('/users?limit=1', { token: adminToken });
  check('core collection is served by its system endpoint (/users)', usersRes.status === 200 && Array.isArray(usersRes.json?.data), `status=${usersRes.status}`);
  const rolesRes = await call('/roles?limit=1', { token: adminToken });
  check('roles are served by /roles', rolesRes.status === 200 && Array.isArray(rolesRes.json?.data), `status=${rolesRes.status}`);
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    // Set the code instead of calling process.exit(): exiting while fetch
    // sockets are still tearing down has thrown a libuv assertion on Windows,
    // and process.exit can truncate buffered output.
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((err) => {
    console.error(`verify crashed: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
