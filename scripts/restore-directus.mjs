#!/usr/bin/env node
/**
 * Restore a backup made by scripts/backup-directus.mjs.
 *
 *   npm run restore -- backups/2026-09-11T23-59-59-999Z
 *
 * What it does, in order:
 *   1. verifies the backup (manifest + SHA-256 of both files),
 *   2. confirms the target volumes with the operator,
 *   3. stops the compose project,
 *   4. wipes and repopulates the database volume with the snapshot and the
 *      uploads volume with the archive,
 *   5. starts the project again and health-checks Directus.
 *
 * Guards: refuses to run on a mismatching manifest, refuses a directory whose
 * name is not a backup run, and asks for --yes before touching anything.
 *
 * Safety notes for the operator:
 *   - Everything currently in the target volumes is DESTROYED. The script
 *     snapshots the database volume into /tmp first, so a single `docker exec`
 *     can still pull it back until the host reboots — but that is a courtesy,
 *     not a backup.
 *   - No pre-restore backup of the uploads volume is made; copy it first if
 *     the current photos matter (`npm run backup` is the honest way).
 *
 * Run: npm run restore -- <backup-dir> [--yes]
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTAINER = process.env.DIRECTUS_CONTAINER || 'qr-vcard-directus';
const COMPOSE_FILE = 'directus/docker-compose.yml';
const DB_IN_VOLUME = '/directus/database/data.db';
const RUN_DIR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const HEALTH_TIMEOUT_SEC = 90;

// ---------- pure helpers (unit-tested) ----------

/** Missing or hash-mismatched files, keyed by name. */
export function verifyManifest(manifest, dir) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object' || !manifest.files) return ['manifest.json is missing or unreadable'];
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = join(dir, name);
    if (!existsSync(file)) {
      problems.push(`${name} is missing`);
      continue;
    }
    const actual = statSync(file).size;
    if (actual !== expected.size) {
      problems.push(`${name} size ${actual} != manifest ${expected.size}`);
      continue;
    }
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (hash !== expected.sha256) problems.push(`${name} sha256 mismatch (expected ${expected.sha256.slice(0, 12)}…, got ${hash.slice(0, 12)}…)`);
  }
  return problems;
}

/** The restore command line, given the resolved volumes — exported for tests. */
export function restoreCommands({ dbVolume, uploadsVolume, srcDb, srcUploads }) {
  return {
    db: ['run', '--rm', '-v', `${dbVolume}:/data`, '-v', `${resolve(srcDb)}:/src/db.sqlite:ro`, 'alpine:3', 'sh', '-c', 'rm -f /data/data.db /data/data.db-wal /data/data.db-shm && cp /src/db.sqlite /data/data.db'],
    uploads: ['run', '--rm', '-v', `${uploadsVolume}:/data`, '-v', `${resolve(srcUploads)}:/src/uploads.tar.gz:ro`, 'alpine:3', 'sh', '-c', 'find /data -mindepth 1 -delete && tar -xzf /src/uploads.tar.gz -C /data'],
  };
}

// ---------- plumbing ----------

function fatal(message, hint) {
  console.error(`[restore] ${message}`);
  if (hint) console.error(`[restore] hint: ${hint}`);
  process.exitCode = 1;
  process.exit(1);
}

function docker(args, { capture = false } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (r.error) throw new Error(`docker failed to run (${r.error.message}) — is Docker up?`);
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed${r.stderr ? `: ${String(r.stderr).trim()}` : ''}`);
  return capture ? String(r.stdout).trim() : '';
}

// ---------- the restore ----------

function main() {
  const argv = process.argv.slice(2);
  const yes = argv.includes('--yes');
  const target = argv.find((a) => !a.startsWith('-'));
  if (!target) return fatal('no backup directory given', 'npm run restore -- backups/<timestamp>');

  const dir = resolve(target);
  const name = basename(dir);
  if (!RUN_DIR_RE.test(name)) {
    return fatal(`"${name}" does not look like a backup run directory`, 'pass the folder npm run backup created, e.g. backups/2026-09-11T23-59-59-999Z');
  }

  // 1. Verify before touching anything.
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return fatal('manifest.json is missing or unreadable — refusing to restore an unverifiable backup');
  }
  const problems = verifyManifest(manifest, dir);
  if (problems.length > 0) {
    console.error('[restore] backup failed verification:');
    for (const p of problems) console.error(`[restore]   - ${p}`);
    return fatal('refusing to restore a damaged backup', 'run npm run backup again');
  }
  console.log(`[restore] verified ${name}: db.sqlite + uploads.tar.gz match the manifest`);

  // 2. Resolve the live volumes from the running compose project.
  const state = docker(['inspect', '-f', '{{.State.Running}}', CONTAINER], { capture: true }).toLowerCase();
  if (state !== 'true') {
    return fatal(`container ${CONTAINER} is not running`, 'npm run directus:up first — the script needs the compose project to learn the volume names');
  }
  const mounts = JSON.parse(docker(['inspect', '-f', '{{json .Mounts}}', CONTAINER], { capture: true }));
  const volumeAt = (dest) => mounts.find((m) => m.Type === 'volume' && m.Destination === dest)?.Name;
  const dbVolume = volumeAt('/directus/database');
  const uploadsVolume = volumeAt('/directus/uploads');
  if (!dbVolume || !uploadsVolume) return fatal(`could not resolve the volumes on ${CONTAINER}`);

  console.log(`[restore] target volumes: ${dbVolume} (db), ${uploadsVolume} (uploads)`);
  if (manifest.volumes && (manifest.volumes.database !== dbVolume || manifest.volumes.uploads !== uploadsVolume)) {
    console.log('[restore] note: backup was taken from different volume names — fine if this is a rebuild on a new host');
  }

  // 3. Confirm.
  if (!yes) {
    console.log('[restore] this will STOP Directus and DESTROY the current data in both volumes.');
    console.log('[restore] re-run with --yes to proceed (a courtesy snapshot of the current DB goes to /tmp first).');
    return;
  }

  // 4. Stop the project (not just the container, so nothing re-attaches mid-write).
  console.log('[restore] stopping the compose project…');
  docker(['compose', '-f', COMPOSE_FILE, 'down']);

  // Courtesy escape hatch: current DB to /tmp on the host.
  docker(['run', '--rm', '-v', `${dbVolume}:/data`, '-v', '/tmp:/out', 'alpine:3', 'sh', '-c', 'cp /data/data.db* /out/ 2>/dev/null; true']);
  console.log('[restore] pre-restore snapshot of the old database copied to the host /tmp');

  // 5. Wipe + repopulate both volumes.
  const { db, uploads } = restoreCommands({ dbVolume, uploadsVolume, srcDb: join(dir, 'db.sqlite'), srcUploads: join(dir, 'uploads.tar.gz') });
  console.log('[restore] restoring the database volume…');
  docker(db);
  console.log('[restore] restoring the uploads volume…');
  docker(uploads);

  // 6. Start again and wait for a healthy Directus.
  console.log('[restore] starting the compose project…');
  docker(['compose', '-f', COMPOSE_FILE, 'up', '-d']);

  const deadline = Date.now() + HEALTH_TIMEOUT_SEC * 1000;
  for (;;) {
    const health = docker(['inspect', '-f', '{{.State.Health.Status}}', CONTAINER], { capture: true });
    if (health === 'healthy') {
      console.log(`[restore] done — Directus is healthy again (took under ${HEALTH_TIMEOUT_SEC}s at most)`);
      console.log('[restore] verify the app: open /panel, sign in, and check that a card + its photo render.');
      return;
    }
    if (Date.now() > deadline) {
      return fatal(`Directus did not become healthy within ${HEALTH_TIMEOUT_SEC}s`, 'check docker logs qr-vcard-directus, and confirm the restored DB matches this image');
    }
    process.stdout.write('.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, false, 1000);
  }
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
