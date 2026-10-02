#!/usr/bin/env node
/**
 * Portable export of every QR-VCard record in Directus — through the REST API,
 * so it works against ANY Directus: the local SQLite container, the Postgres
 * stack in docker-compose.full.yml, a managed/hosted instance. It complements
 * `npm run backup`, which snapshots the Docker volumes of the local dev
 * container only and cannot move data between database engines.
 *
 *   npm run directus:export                          # -> exports/<timestamp>/
 *   npm run directus:export -- --out=/mnt/qrv --keep=14
 *   DIRECTUS_URL=... DIRECTUS_TOKEN=... npm run directus:export
 *
 * Needs an Administrator token — the app's DIRECTUS_TOKEN qualifies.
 *
 *   exports/<timestamp>/
 *     manifest.json   provenance, record counts, SHA-256 of every artifact
 *     data.json       users, vcards, qrv_view_days, qrv_card_access,
 *                     qrv_audit_log, plus file metadata
 *     files/<id>      one binary per directus_files row (card photos, avatars)
 *
 * The export contains password hashes — treat the folder like the database
 * itself. `directus_users.token` and `tfa_secret` are deliberately left out:
 * the token identifies the running service account, and neither can be
 * written through the API on import anyway.
 *
 * Run: npm run directus:export
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argValue, runsToDelete, runsToKeep, sha256File, stamp } from './backup-directus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DEFAULT_KEEP = 7;

/** directus/.env < root .env < process.env — same precedence as verify.mjs. */
export function loadEnv(env = process.env) {
  const out = {};
  for (const file of [join(ROOT, 'directus', '.env'), join(ROOT, '.env')]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[2].trim() !== '') out[m[1]] = m[2].trim();
    }
  }
  return { ...out, ...env };
}

/** What is exported, in import order (files come first — see the files map). */
const COLLECTIONS = [
  { key: 'users', path: '/users' },
  { key: 'vcards', path: '/items/vcards' },
  { key: 'qrv_view_days', path: '/items/qrv_view_days' },
  { key: 'qrv_card_access', path: '/items/qrv_card_access' },
  { key: 'qrv_audit_log', path: '/items/qrv_audit_log' },
];

/**
 * Fields the API can never accept back on a user write (or that would actively
 * hurt if re-applied): the service token, the 2FA secret, and SSO internals.
 */
const USER_STRIP = ['token', 'tfa_secret', 'external_identifier', 'auth_data'];

/** Remove fields that must never reach an import. Exported for tests. */
export function stripUser(row) {
  const out = { ...row };
  for (const f of USER_STRIP) delete out[f];
  return out;
}

/** Fail fast with one readable line. */
function fatal(message, hint) {
  console.error(`[export] ${message}`);
  if (hint) console.error(`[export] hint: ${hint}`);
  process.exitCode = 1;
}

function makeApi(base, token) {
  return async function api(path, { method = 'GET', body, raw = false } = {}) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          Authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new Error(`Directus unreachable at ${base} (${method} ${path}): ${err?.cause?.code ?? err?.cause?.message ?? err?.message ?? err}`);
    }
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(`${res.status} ${method} ${path}: ${JSON.stringify(json.errors?.map((e) => e.message) ?? json)}`);
    }
    if (raw) return res;
    const json = await res.json().catch(() => ({}));
    return json.data;
  };
}

async function main() {
  const env = loadEnv();
  const base = (env.DIRECTUS_URL || '').replace(/\/+$/, '');
  const token = (env.DIRECTUS_TOKEN || '').trim();
  if (!base || !token) {
    return fatal('DIRECTUS_URL and DIRECTUS_TOKEN are required', 'set them in .env, directus/.env or the environment');
  }
  const api = makeApi(base, token);
  console.log(`[export] source: ${base}`);

  const me = await api('/users/me?fields=id,email,role.name');
  console.log(`[export] as ${me.email ?? me.id} (role ${me.role?.name ?? 'unknown'})`);

  // ---- collections ----------------------------------------------------------
  const data = { app: 'qr-vcard', version: 1, exported_at: new Date().toISOString(), source: base };
  const counts = {};

  // Role names travel with the export so the import can map them onto whatever
  // ids the target instance gave its roles.
  const roles = await api('/roles?limit=-1&fields=id,name');
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  data.roles = roles.map((r) => r.name);

  for (const { key, path } of COLLECTIONS) {
    let rows = [];
    try {
      rows = await api(`${path}?limit=-1&fields=*`) ?? [];
    } catch (err) {
      // An app collection that does not exist (old install, never provisioned)
      // is an empty export section, not a fatal error.
      if (key.startsWith('qrv_')) {
        console.log(`[export] ${key}: skipped (${err.message.split(':')[0]})`);
        data[key] = [];
        counts[key] = 0;
        continue;
      }
      throw err;
    }
    if (key === 'users') {
      rows = rows.map((u) => ({ ...stripUser(u), role_name: roleName.get(typeof u.role === 'object' ? u.role?.id : u.role) ?? null }));
    }
    data[key] = rows;
    counts[key] = rows.length;
    console.log(`[export] ${key}: ${rows.length} row(s)`);
  }

  // ---- files ----------------------------------------------------------------
  const filesMeta = (await api('/files?limit=-1&fields=*')) ?? [];
  data.files = filesMeta;
  counts.files = filesMeta.length;
  console.log(`[export] files: ${filesMeta.length} object(s)`);

  const outRoot = resolve(argValue(process.argv, 'out') ?? join(ROOT, 'exports'));
  const dir = join(outRoot, stamp());
  mkdirSync(join(dir, 'files'), { recursive: true });

  let downloaded = 0;
  for (const f of filesMeta) {
    try {
      const res = await api(`/assets/${f.id}?download`, { raw: true });
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(join(dir, 'files', f.id), buf);
      downloaded++;
    } catch (err) {
      console.log(`[export] file ${f.id} (${f.filename_download ?? 'unnamed'}): ${err.message}`);
    }
  }
  if (downloaded < filesMeta.length) console.log(`[export] warning: ${filesMeta.length - downloaded} file(s) could not be downloaded`);

  writeFileSync(join(dir, 'data.json'), JSON.stringify(data, null, 2));

  // ---- manifest --------------------------------------------------------------
  const files = {};
  for (const name of ['data.json', ...readdirSync(join(dir, 'files')).map((f) => `files/${f}`)]) {
    const file = join(dir, name);
    files[name] = { size: statSync(file).size, sha256: sha256File(file) };
  }
  const manifest = { version: 1, created: data.exported_at, source: base, counts, files };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[export] manifest.json written`);

  // ---- retention --------------------------------------------------------------
  const keep = Number.parseInt(argValue(process.argv, 'keep') ?? '', 10);
  const retention = Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_KEEP;
  const stale = runsToDelete(readdirSync(outRoot), retention);
  for (const d of stale) {
    rmSync(join(outRoot, d), { recursive: true, force: true });
    console.log(`[export] retention: removed ${d}`);
  }

  console.log(`[export] done -> ${dir}`);
  console.log(`[export] restore it anywhere with: npm run directus:import -- ${dir}`);
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
