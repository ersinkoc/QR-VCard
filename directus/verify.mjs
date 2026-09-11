#!/usr/bin/env node
/**
 * Lockdown check against a RUNNING Directus (same env as bootstrap).
 *
 * The app's security model is: browsers get nothing from Directus, the app server
 * gets everything through its service token. This proves both halves at the
 * Directus layer; the app-level rules (own cards only, admin-only users) are
 * covered by server/api.test.mjs and, end to end, by `npm run smoke:live`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const file of [join(HERE, '.env'), join(HERE, '..', '.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2].trim() !== '') env[m[1]] = m[2].trim();
  }
}
Object.assign(env, process.env);
const BASE = (env.DIRECTUS_URL || 'http://localhost:8055').replace(/\/+$/, '');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function login(email, password) {
  const { status, json } = await call('/auth/login', { method: 'POST', body: { email, password } });
  if (status !== 200) throw new Error(`login ${email} failed (${status})`);
  return json.data.access_token;
}

const denied = (status) => status === 401 || status === 403;

async function main() {
  console.log(`[verify] target: ${BASE}`);

  // 1. The service token works and can reach the data.
  const token = env.DIRECTUS_TOKEN;
  check('DIRECTUS_TOKEN is set', Boolean(token), token ? '' : 'run npm run directus:bootstrap');
  if (token) {
    const me = await call('/users/me?fields=id,email,role.name', { token });
    check('service token authenticates', me.status === 200, me.json?.data?.email ?? `status=${me.status}`);
    const cards = await call('/items/vcards?limit=1&fields=id', { token });
    check('service token can read vcards', cards.status === 200, `status=${cards.status}`);
    const users = await call('/users?limit=1&fields=id', { token });
    check('service token can read users', users.status === 200, `status=${users.status}`);
    const epoch = await call('/fields/directus_users/qrv_session_epoch', { token });
    check('session epoch field exists', epoch.status === 200, `status=${epoch.status}`);
  }

  // 2. Anonymous callers get nothing.
  const anonCards = await call('/items/vcards?limit=1');
  check('anonymous cannot read vcards directly', denied(anonCards.status), `status=${anonCards.status}`);
  const anonFiles = await call('/files?limit=1');
  check('anonymous cannot list files', denied(anonFiles.status), `status=${anonFiles.status}`);

  // 3. A signed-in plain user gets nothing either — the old hole.
  const userToken = await login(env.USER_EMAIL || 'ada@local.dev', env.USER_PASSWORD || 'vcard-user');
  const userRead = await call('/items/vcards?limit=1', { token: userToken });
  check('plain user cannot read vcards directly', denied(userRead.status), `status=${userRead.status}`);
  const userCreate = await call('/items/vcards', { method: 'POST', token: userToken, body: { code: 'verify-probe', status: 'draft' } });
  check('plain user cannot create vcards directly', denied(userCreate.status), `status=${userCreate.status}`);
  const userUsers = await call('/users?limit=1', { token: userToken });
  check('plain user cannot list accounts', denied(userUsers.status), `status=${userUsers.status}`);

  const editorToken = await login(env.EDITOR_EMAIL || 'editor@local.dev', env.EDITOR_PASSWORD || 'vcard-editor');
  const editorRead = await call('/items/vcards?limit=1', { token: editorToken });
  check('editor cannot read vcards directly', denied(editorRead.status), `status=${editorRead.status}`);
  const editorUsers = await call('/users?limit=1', { token: editorToken });
  check('editor cannot list accounts directly', denied(editorUsers.status), `status=${editorUsers.status}`);
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    // Set the code instead of calling process.exit(): exiting while fetch
    // sockets are still tearing down has thrown a libuv assertion on Windows.
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((err) => {
    console.error(`verify crashed: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
