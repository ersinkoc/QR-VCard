import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { argValue, runsToDelete, runsToKeep, stamp } from './backup-directus.mjs';
import { restoreCommands, verifyManifest } from './restore-directus.mjs';

describe('backup-directus', () => {
  it('stamps a sortable, Windows-safe directory name', () => {
    expect(stamp(new Date('2026-09-11T20:59:59.123Z'))).toBe('2026-09-11T20-59-59-123Z');
  });

  it('keeps the newest runs and marks older ones for deletion', () => {
    const dirs = ['2026-09-08T10-00-00-000Z', 'random-folder', '2026-09-10T10-00-00-000Z', '2026-09-11T10-00-00-000Z', '2026-09-09T10-00-00-000Z', 'not-a-stamp.txt'];
    expect(runsToKeep(dirs, 2)).toEqual(['2026-09-11T10-00-00-000Z', '2026-09-10T10-00-00-000Z']);
    expect(runsToDelete(dirs, 2)).toEqual(['2026-09-08T10-00-00-000Z', '2026-09-09T10-00-00-000Z']);
    expect(runsToDelete(dirs, 99)).toEqual([]);
    expect(runsToDelete([], 7)).toEqual([]);
  });

  it('parses --keep=14 and --keep 14, and ignores unknown flags', () => {
    expect(argValue(['--keep=14'], 'keep')).toBe('14');
    expect(argValue(['--keep', '14'], 'keep')).toBe('14');
    expect(argValue(['--keep=14', '--yes'], 'keep')).toBe('14');
    expect(argValue(['--yes'], 'keep')).toBeUndefined();
    expect(argValue(['--keep'], 'keep')).toBeUndefined();
  });
});

describe('restore-directus', () => {
  it('verifies files against the manifest and reports every mismatch kind', async () => {
    const dir = join(tmpdir(), `qrv-restore-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const db = Buffer.from('db-bytes');
      const uploads = Buffer.from('uploads-bytes');
      writeFileSync(join(dir, 'db.sqlite'), db);
      writeFileSync(join(dir, 'uploads.tar.gz'), uploads);
      const manifest = {
        files: {
          'db.sqlite': { size: db.length, sha256: createHash('sha256').update(db).digest('hex') },
          'uploads.tar.gz': { size: uploads.length, sha256: createHash('sha256').update(uploads).digest('hex') },
        },
      };
      expect(verifyManifest(manifest, dir)).toEqual([]);

      // A byte flipped in the archive (same size!) is caught by the hash…
      const flipped = Buffer.from('uploads-byteZ');
      writeFileSync(join(dir, 'uploads.tar.gz'), flipped);
      expect(verifyManifest(manifest, dir)).toEqual(['uploads.tar.gz sha256 mismatch (expected ' + manifest.files['uploads.tar.gz'].sha256.slice(0, 12) + '…, got ' + createHash('sha256').update(flipped).digest('hex').slice(0, 12) + '…)']);

      // …a truncated file by the size check.
      writeFileSync(join(dir, 'uploads.tar.gz'), Buffer.from('uploads-by'));
      expect(verifyManifest(manifest, dir)).toContain('uploads.tar.gz size 10 != manifest 13');

      // …a truncated file by the size check, and a lost file by existence.
      rmSync(join(dir, 'db.sqlite'));
      expect(verifyManifest(manifest, dir)).toContain('db.sqlite is missing');

      expect(verifyManifest(null, dir)).toEqual(['manifest.json is missing or unreadable']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds docker commands that wipe and repopulate the right volumes', () => {
    const { db, uploads } = restoreCommands({ dbVolume: 'proj_db', uploadsVolume: 'proj_uploads', srcDb: '/b/run/db.sqlite', srcUploads: '/b/run/uploads.tar.gz' });
    expect(db[0]).toBe('run');
    expect(db).toContain('proj_db:/data');
    expect(db.at(-1)).toContain('rm -f /data/data.db');
    expect(db.at(-1)).toContain('cp /src/db.sqlite /data/data.db');
    expect(uploads).toContain('proj_uploads:/data');
    expect(uploads.at(-1)).toContain('find /data -mindepth 1 -delete');
    expect(uploads.at(-1)).toContain('tar -xzf /src/uploads.tar.gz -C /data');
  });
});
