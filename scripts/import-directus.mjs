#!/usr/bin/env node
/**
 * Import a folder produced by scripts/export-directus.mjs into ANY Directus —
 * the local SQLite container, the Postgres stack in docker-compose.full.yml,
 * a managed instance. Works through the REST API, so database engines do not
 * matter. Merge by default (existing records are left alone); --update also
 * overwrites existing rows.
 *
 *   npm run directus:import -- exports/<timestamp>
 *   npm run directus:import -- exports/<timestamp> --update
 *   npm run directus:import -- exports/<timestamp> --password=TempPass123
 *
 * Order: files → users → vcards → qrv_view_days → qrv_card_access →
 * qrv_audit_log. Rows are matched on their natural key (email, card code,
 * card+day, card+user), so re-running an import is safe. If the QR-VCard
 * schema is missing, directus/bootstrap.mjs runs first — a completely empty
 * Directus is enough.
 *
 * Passwords: the Directus API re-hashes `password` on every write, so hashes
 * cannot be restored through it. New users get a generated password
 * (written to <export>/import-credentials.txt) or the --password value.
 * To keep the original passwords, restore the database itself instead
 * (`npm run restore` for the local stack, a DB dump for Postgres).
 *
 * `token` and `tfa_secret` are never imported — clobbering the token would
 * break the running app's DIRECTUS_TOKEN.
 *
 * Run: npm run directus:import -- exports/<timestamp>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argValue } from './backup-directus.mjs';
import { loadEnv } from './export-directus.mjs';
import { verifyManifest } from './restore-directus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** User fields the API accepts back. Everything else is dropped on import. */
const USER_WRITE_FIELDS = ['id', 'email', 'first_name', 'last_name', 'status', 'username', 'qrv_session_epoch', 'last_access', 'last_page', 'theme', 'language', 'title', 'description', 'location', 'tags', 'appearance', 'avatar'];

/** Fields that may legally reject a write; retried without them one by one. */
const USER_DROPPABLE = ['qrv_session_epoch', 'username', 'avatar', 'last_access', 'last_page', 'id'];
const CARD_DROPPABLE = ['user_created', 'date_created', 'photo', 'id'];
const ROW_DROPPABLE = ['id'];

/** Body for POST /users: whitelisted fields, mapped role + avatar, password. Exported for tests. */
export function userPayload(row, { roleId = null, password = null, fileMap = new Map() } = {}) {
  const out = {};
  for (const f of USER_WRITE_FIELDS) {
    if (row[f] !== undefined && row[f] !== null) out[f] = row[f];
  }
  if (row.avatar) out.avatar = fileMap.get(row.avatar) ?? null;
  out.role = roleId;
  if (password) out.password = password;
  return out;
}

/** Body for POST /items/vcards: owner/photo ids mapped onto the target instance. Exported for tests. */
export function cardPayload(row, { userMap = new Map(), fileMap = new Map() } = {}) {
  const out = { ...row };
  out.owner = row.owner ? (userMap.get(row.owner) ?? null) : null;
  out.photo = row.photo ? (fileMap.get(row.photo) ?? null) : null;
  delete out.user_created;
  return out;
}

/** The field a Directus error blames (`"username" has to be unique`), if droppable. Exported for tests. */
export function blockingField(message, body, droppable) {
  // api() JSON-stringifies the errors array, so quotes arrive escaped: \"field\".
  const clean = String(message).replace(/\\/g, '');
  return droppable.find((f) => body[f] !== undefined && clean.includes(`"${f}"`));
}

/** Fail fast with one readable line. */
function fatal(message, hint) {
  console.error(`[import] ${message}`);
  if (hint) console.error(`[import] hint: ${hint}`);
  process.exitCode = 1;
  process.exit(1);
}

function makeApi(base, token) {
  return async function api(path, { method = 'GET', body } = {}) {
    const isForm = body instanceof FormData;
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body === undefined || isForm ? {} : { 'Content-Type': 'application/json' }),
          Authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new Error(`Directus unreachable at ${base} (${method} ${path}): ${err?.cause?.code ?? err?.cause?.message ?? err?.message ?? err}`);
    }
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(`${res.status} ${method} ${path}: ${JSON.stringify(json.errors?.map((e) => e.message) ?? json)}`);
    }
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    return json?.data ?? null;
  };
}

/** POST/PATCH with progressive field-dropping for write-rejecting columns. */
async function send(api, path, method, body, droppable) {
  const dropped = [];
  for (;;) {
    try {
      return { row: await api(path, { method, body }), dropped };
    } catch (err) {
      const field = blockingField(err.message, body, droppable);
      if (!field) throw err;
      delete body[field];
      dropped.push(field);
    }
  }
}

function summarize(name, s) {
  console.log(`[import] ${name}: ${s.created} created, ${s.skipped} kept as-is, ${s.updated ?? 0} updated, ${s.failed} failed`);
}

async function main() {
  const argv = process.argv.slice(2);
  const update = argv.includes('--update');
  const sharedPassword = argValue(argv, 'password');
  const target = argv.find((a) => !a.startsWith('-'));
  if (!target) return fatal('no export directory given', 'npm run directus:import -- exports/<timestamp>');

  const dir = resolve(target);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const problems = verifyManifest(manifest, dir);
  if (problems.length > 0) {
    console.error('[import] export failed verification:');
    for (const p of problems) console.error(`[import]   - ${p}`);
    return fatal('refusing to import a damaged export');
  }
  const data = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8'));
  console.log(`[import] verified ${basename(dir)}: ${JSON.stringify(manifest.counts)}`);

  const env = loadEnv();
  const base = (env.DIRECTUS_URL || '').replace(/\/+$/, '');
  const token = (env.DIRECTUS_TOKEN || '').trim();
  if (!base || !token) return fatal('DIRECTUS_URL and DIRECTUS_TOKEN are required for the TARGET instance');
  const api = makeApi(base, token);
  console.log(`[import] target: ${base}`);

  // Schema first: an empty Directus gets the QR-VCard collections/roles here.
  const hasSchema = await api('/collections/vcards').then(() => true, () => false);
  if (!hasSchema) {
    console.log('[import] schema missing — running directus/bootstrap.mjs first');
    const r = spawnSync(process.execPath, [join(ROOT, 'directus', 'bootstrap.mjs')], {
      stdio: 'inherit',
      env: { ...env, DIRECTUS_URL: base, DIRECTUS_TOKEN: token, BOOTSTRAP_RUNTIME: '1', BOOTSTRAP_SEED_DEMO: '0' },
    });
    if (r.status !== 0) return fatal('schema bootstrap failed — fix Directus first');
  }

  const roles = await api('/roles?limit=-1&fields=id,name');
  const roleIdByName = new Map(roles.map((r) => [r.name, r.id]));

  // Existing rows, so merges never collide with unique constraints.
  const existingUsers = await api('/users?fields=id,email&limit=-1');
  const userByEmail = new Map(existingUsers.map((u) => [String(u.email).toLowerCase(), u]));
  const existingCards = await api('/items/vcards?fields=id,code&limit=-1');
  const cardByCode = new Map(existingCards.map((c) => [c.code, c]));

  // ---- files ---------------------------------------------------------------
  const fileMap = new Map();
  const fileStats = { created: 0, skipped: 0, failed: 0 };
  for (const f of data.files ?? []) {
    const bin = join(dir, 'files', f.id);
    if (!existsSync(bin)) {
      fileStats.skipped++;
      continue;
    }
    try {
      const form = new FormData();
      if (f.title) form.append('title', f.title);
      if (f.filename_download) form.append('filename_download', f.filename_download);
      const buf = readFileSync(bin);
      form.append('file', new Blob([buf], { type: f.type || 'application/octet-stream' }), f.filename_download || f.id);
      const created = await api('/files', { method: 'POST', body: form });
      fileMap.set(f.id, created.id);
      fileStats.created++;
    } catch (err) {
      fileStats.failed++;
      console.log(`[import] file ${f.id}: ${err.message}`);
    }
  }
  summarize('files', fileStats);

  // ---- users ----------------------------------------------------------------
  const userMap = new Map();
  const credentials = [];
  const userStats = { created: 0, skipped: 0, updated: 0, failed: 0 };
  for (const u of data.users ?? []) {
    const existing = userByEmail.get(String(u.email).toLowerCase());
    const roleId = u.role_name ? (roleIdByName.get(u.role_name) ?? null) : null;
    if (u.role_name && !roleId) console.log(`[import] user ${u.email}: role "${u.role_name}" not found on target — imported without a role`);
    if (existing) {
      userMap.set(u.id, existing.id);
      if (update) {
        try {
          const fields = userPayload(u, { roleId, fileMap });
          delete fields.id;
          // A role missing on the target must not strip the existing one.
          if (roleId === null) delete fields.role;
          await send(api, `/users/${existing.id}`, 'PATCH', fields, USER_DROPPABLE);
          userStats.updated++;
        } catch (err) {
          userStats.failed++;
          console.log(`[import] user ${u.email}: update failed (${err.message})`);
        }
      } else {
        userStats.skipped++;
      }
      continue;
    }
    const password = sharedPassword || randomBytes(9).toString('hex');
    try {
      const { row, dropped } = await send(api, '/users', 'POST', userPayload(u, { roleId, password, fileMap }), USER_DROPPABLE);
      userMap.set(u.id, row.id);
      credentials.push({ email: u.email, password });
      userStats.created++;
      if (dropped.length) console.log(`[import] user ${u.email}: dropped unwritable field(s) ${dropped.join(', ')}`);
    } catch (err) {
      userStats.failed++;
      console.log(`[import] user ${u.email}: ${err.message}`);
    }
  }
  summarize('users', userStats);

  // ---- vcards ----------------------------------------------------------------
  const cardMap = new Map();
  const cardStats = { created: 0, skipped: 0, updated: 0, failed: 0 };
  for (const c of data.vcards ?? []) {
    const existing = cardByCode.get(c.code);
    if (existing) {
      cardMap.set(c.id, existing.id);
      if (update) {
        try {
          const fields = cardPayload(c, { userMap, fileMap });
          delete fields.id;
          delete fields.code;
          await send(api, `/items/vcards/${existing.id}`, 'PATCH', fields, CARD_DROPPABLE);
          cardStats.updated++;
        } catch (err) {
          cardStats.failed++;
          console.log(`[import] card ${c.code}: update failed (${err.message})`);
        }
      } else {
        cardStats.skipped++;
      }
      continue;
    }
    try {
      const { row, dropped } = await send(api, '/items/vcards', 'POST', cardPayload(c, { userMap, fileMap }), CARD_DROPPABLE);
      cardMap.set(c.id, row.id);
      cardStats.created++;
      if (dropped.length) console.log(`[import] card ${c.code}: dropped unwritable field(s) ${dropped.join(', ')}`);
    } catch (err) {
      cardStats.failed++;
      console.log(`[import] card ${c.code}: ${err.message}`);
    }
  }
  summarize('vcards', cardStats);

  // ---- per-card daily views ----------------------------------------------------
  const existingDays = new Set(
    ((await api('/items/qrv_view_days?fields=card,day&limit=-1').catch(() => [])) ?? []).map((r) => `${r.card}|${r.day}`),
  );
  const dayStats = { created: 0, skipped: 0, failed: 0 };
  for (const d of data.qrv_view_days ?? []) {
    const card = cardMap.get(d.card);
    if (!card || existingDays.has(`${card}|${d.day}`)) {
      dayStats.skipped++;
      continue;
    }
    try {
      await send(api, '/items/qrv_view_days', 'POST', { ...d, card }, ROW_DROPPABLE);
      dayStats.created++;
    } catch (err) {
      dayStats.failed++;
      console.log(`[import] qrv_view_days ${d.day}: ${err.message}`);
    }
  }
  summarize('qrv_view_days', dayStats);

  // ---- card collaborators -------------------------------------------------------
  const existingAccess = new Set(
    ((await api('/items/qrv_card_access?fields=card,user&limit=-1').catch(() => [])) ?? []).map((r) => `${r.card}|${r.user}`),
  );
  const accessStats = { created: 0, skipped: 0, failed: 0 };
  for (const a of data.qrv_card_access ?? []) {
    const card = cardMap.get(a.card);
    const user = userMap.get(a.user);
    if (!card || !user || existingAccess.has(`${card}|${user}`)) {
      accessStats.skipped++;
      continue;
    }
    try {
      await send(api, '/items/qrv_card_access', 'POST', { ...a, card, user }, ROW_DROPPABLE);
      accessStats.created++;
    } catch (err) {
      accessStats.failed++;
      console.log(`[import] qrv_card_access: ${err.message}`);
    }
  }
  summarize('qrv_card_access', accessStats);

  // ---- audit log (append-only; date_created always stamps "now" via the API) ----
  const existingAudit = new Set(
    ((await api('/items/qrv_audit_log?fields=id&limit=-1').catch(() => [])) ?? []).map((r) => r.id),
  );
  const auditStats = { created: 0, skipped: 0, failed: 0 };
  for (const a of data.qrv_audit_log ?? []) {
    if (existingAudit.has(a.id)) {
      auditStats.skipped++;
      continue;
    }
    try {
      await send(api, '/items/qrv_audit_log', 'POST', { ...a, actor: a.actor ? (userMap.get(a.actor) ?? null) : null }, ['id', 'actor']);
      auditStats.created++;
    } catch (err) {
      auditStats.failed++;
      console.log(`[import] qrv_audit_log: ${err.message}`);
    }
  }
  summarize('qrv_audit_log', auditStats);

  // ---- credentials --------------------------------------------------------------
  if (credentials.length && !sharedPassword) {
    const file = join(dir, 'import-credentials.txt');
    writeFileSync(file, credentials.map((c) => `${c.email}\t${c.password}`).join('\n') + '\n');
    console.log(`[import] generated passwords for ${credentials.length} account(s) -> ${file}`);
  } else if (credentials.length) {
    console.log(`[import] ${credentials.length} account(s) created with the --password value`);
  }

  console.log('[import] done. date_created/user_created always stamp "now" through the API; original timestamps survive only in a database-level restore.');
}

function isMain() {
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((err) => fatal(err?.message ?? err));
}
