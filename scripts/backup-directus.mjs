#!/usr/bin/env node
/**
 * Backup the Directus data that the whole app runs on: the SQLite database and
 * the uploads volume (card photos). One command, one folder per run:
 *
 *   npm run backup                      # -> backups/<timestamp>/ + retention
 *   npm run backup -- --keep=14         # keep more runs (default 7)
 *   BACKUP_DIR=/mnt/nas/qrv npm run backup
 *
 * Why VACUUM INTO and not a file copy: Directus writes continuously and keeps
 * its journal in data.db-wal. Copying `data.db` while the container runs can
 * produce a torn snapshot — the pages and the WAL are two files copied at
 * different instants — and SQLite may refuse the result. `VACUUM INTO` is
 * SQLite's own online-backup statement: it reads the database AND its journal
 * and writes one complete, self-contained file. The live database is not
 * blocked for longer than a read.
 *
 * Photos are packed with tar from inside the container (no extra image pull).
 * Both artifacts get a manifest.json with sizes and SHA-256 hashes; the
 * restore script refuses a backup whose files no longer match the manifest.
 *
 * What is NOT backed up: Directus container configuration lives in
 * directus/docker-compose.yml + directus/.env (both in git / to be saved
 * separately), and the database alone is enough to re-run
 * `npm run directus:bootstrap` — but the photos are not regenerable, so the
 * uploads archive matters as much as the database.
 *
 * Retention deletes only directories under BACKUP_DIR whose name matches the
 * run pattern, oldest first, and never touches anything else.
 *
 * Run: npm run backup
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTAINER = process.env.DIRECTUS_CONTAINER || 'qr-vcard-directus';
const COMPOSE_FILE = 'directus/docker-compose.yml';
const BACKUP_ROOT = resolve(process.env.BACKUP_DIR || 'backups');
const DEFAULT_KEEP = 7;
const RUN_DIR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const TMP_DB = '/tmp/qrv-backup-snapshot.db';
const TMP_UPLOADS = '/tmp/qrv-backup-uploads.tar.gz';

// ---------- pure helpers (unit-tested) ----------

/** Windows-safe, sortable directory stamp: 2026-09-11T23-59-59-999Z. */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** The N newest run directories (name-sorted, newest first). */
export function runsToKeep(dirs, keep) {
  return dirs.filter((d) => RUN_DIR_RE.test(d)).sort().reverse().slice(0, Math.max(0, keep));
}

/** Run directories older than the keep list — the ones retention may delete. */
export function runsToDelete(dirs, keep) {
  const keepSet = new Set(runsToKeep(dirs, keep));
  return dirs.filter((d) => RUN_DIR_RE.test(d) && !keepSet.has(d));
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Parse `--keep=14` / `--keep 14` style args; unknown flags are ignored. */
export function argValue(argv, flag) {
  const inline = argv.find((a) => a.startsWith(`--${flag}=`));
  if (inline) return inline.slice(flag.length + 3);
  const i = argv.indexOf(`--${flag}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Fail fast with one readable line. */
function fatal(message, hint) {
  console.error(`[backup] ${message}`);
  if (hint) console.error(`[backup] hint: ${hint}`);
  process.exitCode = 1;
}

function docker(args, { capture = false } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (r.error) throw new Error(`docker failed to run (${r.error.message}) — is Docker Desktop / the daemon up?`);
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} failed${r.stderr ? `: ${String(r.stderr).trim()}` : ''}`);
  return capture ? String(r.stdout).trim() : '';
}

// ---------- the backup ----------

function main() {
  if (argValue(process.argv, 'help') !== undefined || process.argv.includes('-h')) {
    console.log('Usage: npm run backup [-- --keep=N]   (BACKUP_DIR overrides backups/)');
    return;
  }

  // The compose project must be running: the snapshot is taken inside the
  // container. A stopped instance backs up fine too, but rather than build a
  // second code path over raw volumes, say so and stop.
  const state = docker(['inspect', '-f', '{{.State.Running}}', CONTAINER], { capture: true }).toLowerCase();
  if (state !== 'true') {
    return fatal(`container ${CONTAINER} is not running`, 'start it with npm run directus:up, or set DIRECTUS_CONTAINER');
  }

  // Derive the real volume names from the container instead of guessing the
  // compose project prefix (docker compose prefixes with the folder name, but
  // an existing project or -p flag can differ).
  const mounts = JSON.parse(docker(['inspect', '-f', '{{json .Mounts}}', CONTAINER], { capture: true }));
  const volumeAt = (dest) => mounts.find((m) => m.Type === 'volume' && m.Destination === dest)?.Name;
  const dbVolume = volumeAt('/directus/database');
  const uploadsVolume = volumeAt('/directus/uploads');
  if (!dbVolume || !uploadsVolume) {
    return fatal(`could not find the database/uploads volumes on ${CONTAINER}`, 'is this the compose file from directus/docker-compose.yml?');
  }
  const image = docker(['inspect', '-f', '{{.Config.Image}}', CONTAINER], { capture: true });

  const keep = Number.parseInt(argValue(process.argv, 'keep') ?? '', 10);
  const retention = Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_KEEP;

  const dir = join(BACKUP_ROOT, stamp());
  mkdirSync(dir, { recursive: true });
  console.log(`[backup] volume ${dbVolume} + ${uploadsVolume} -> ${dir}`);

  // 1. A consistent snapshot of the live SQLite database, then copy it out.
  //   Preferred: node:sqlite (present since Node 22.5, which every recent
  //   directus image ships). Fallback: the sqlite3 CLI, for older images.
  const hasNodeSqlite = docker(
    ['exec', CONTAINER, 'node', '-e', "import('node:sqlite').then(() => console.log('yes')).catch(() => console.log('no'))"],
    { capture: true },
  );
  if (hasNodeSqlite === 'yes') {
    docker([
      'exec', CONTAINER, 'node', '-e',
      `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync('/directus/database/data.db');
        db.exec("VACUUM INTO '/tmp/qrv-backup-snapshot.db'");
        db.close();
      `,
    ]);
  } else {
    console.log('[backup] node:sqlite unavailable in this image — falling back to the sqlite3 CLI');
    docker(['exec', CONTAINER, 'sh', '-c', "sqlite3 /directus/database/data.db \"VACUUM INTO '/tmp/qrv-backup-snapshot.db';\""]);
  }
  docker(['cp', `${CONTAINER}:${TMP_DB}`, join(dir, 'db.sqlite')]);
  docker(['exec', CONTAINER, 'rm', '-f', TMP_DB]);

  // 2. The uploads volume (photos), packed from inside the same container.
  docker(['exec', CONTAINER, 'tar', '-czf', TMP_UPLOADS, '-C', '/directus/uploads', '.']);
  docker(['cp', `${CONTAINER}:${TMP_UPLOADS}`, join(dir, 'uploads.tar.gz')]);
  docker(['exec', CONTAINER, 'rm', '-f', TMP_UPLOADS]);

  // 3. Manifest: what, how big, and hashes to verify before any restore.
  const files = {};
  for (const name of ['db.sqlite', 'uploads.tar.gz']) {
    const file = join(dir, name);
    if (!existsSync(file)) return fatal(`${name} was not produced`);
    files[name] = { size: statSync(file).size, sha256: sha256File(file) };
  }
  const manifest = {
    created: new Date().toISOString(),
    container: CONTAINER,
    image,
    volumes: { database: dbVolume, uploads: uploadsVolume },
    db_path_in_container: '/directus/database/data.db',
    files,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const mb = (n) => `${(n / (1024 * 1024)).toFixed(2)} MB`;
  for (const [name, f] of Object.entries(files)) console.log(`[backup] ${name}: ${mb(f.size)} (sha256 ${f.sha256.slice(0, 12)}…)`);
  console.log(`[backup] manifest.json written`);

  // 4. Retention: keep the newest N runs, delete only our own directories.
  if (existsSync(BACKUP_ROOT)) {
    const stale = runsToDelete(readdirSync(BACKUP_ROOT), retention);
    for (const d of stale) {
      rmSync(join(BACKUP_ROOT, d), { recursive: true, force: true });
      console.log(`[backup] retention: removed ${d}`);
    }
    const kept = runsToKeep(readdirSync(BACKUP_ROOT), retention);
    console.log(`[backup] ${kept.length} backup(s) kept in ${basename(BACKUP_ROOT)}/ (limit ${retention})`);
  }

  console.log('[backup] done. Store a copy off this machine — a backup on the same disk protects against nothing.');
}

function isMain() {
  // ESM entrypoint check, robust under vitest workers that mock argv/path.
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    main();
  } catch (err) {
    fatal(err?.message ?? err);
  }
}
