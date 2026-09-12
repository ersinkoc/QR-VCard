# Backup & restore runbook — Directus data

Everything the app serves lives in two Docker volumes owned by the
`directus/docker-compose.yml` project:

| Volume | Inside the container | What it holds |
|---|---|---|
| `directus_directus_database` | `/directus/database/data.db` | The SQLite database: accounts, roles, cards, the `qrv_session_epoch` |
| `directus_directus_uploads` | `/directus/uploads/` | Card photos — the file ids the database points at |

Losing the database loses the accounts and cards. Losing the uploads volume
**without** the database leaves every card pointing at a photo that no longer
exists — a half-restored system that looks broken to every visitor. **Both
volumes are part of one backup**, and that is what `npm run backup` takes.

Container configuration is *not* inside the backup: `directus/.env` and
`directus/docker-compose.yml` live in the repository / your secret store, and
the schema plus roles can always be rebuilt with `npm run directus:bootstrap`.

## The commands

```bash
npm run backup                # -> backups/<timestamp>/ with db + photos + manifest
npm run backup -- --keep=14   # keep 14 runs (default 7)
BACKUP_DIR=/mnt/nas/qrv npm run backup   # write somewhere safer than the repo

npm run restore -- backups/<timestamp>      # dry preview: verifies, asks for --yes
npm run restore -- backups/<timestamp> --yes
```

What a backup folder contains:

```
backups/2026-09-11T21-11-37-839Z/
  db.sqlite         consistent snapshot, taken with SQLite's VACUUM INTO
  uploads.tar.gz    the whole uploads volume, packed inside the container
  manifest.json     container/image/volume provenance + size + SHA-256 of both files
```

`db.sqlite` is a self-contained database file (journal included at snapshot
time), so Directus can open it directly — no WAL merge step, no lock on the
live service beyond one read. The restore script **refuses** a folder whose
files no longer match the manifest hashes.

## How often, and where

- **Daily** on any real deployment: a cron line is enough, e.g. on the host:
  `0 3 * * * cd /srv/qr-vcard && npm run backup >> /var/log/qrv-backup.log 2>&1`
- **Off the machine**: a backup on the same disk as the database protects
  against nothing. Copy the newest folder elsewhere (object storage, another
  host) after every run. Both artifacts are small — well under a megabyte per
  run for a typical installation, growing with the number of photos.
- **Retention**: 7 runs by default; raise with `--keep=`. Only folders matching
  the timestamp pattern are ever deleted.

## Restore: the steps

1. `npm run restore -- backups/<timestamp>` — verifies hashes and prints the
   target volumes; **changes nothing** until you add `--yes`.
2. With `--yes`, the script:
   stops the compose project → copies the current DB to host `/tmp` as a
   courtesy snapshot → wipes and repopulates **both** volumes from the backup
   → starts the project → waits until Directus reports healthy.
3. Prove it, don't trust it: open `/panel` and sign in, open a card, and check
   that its photo renders. `curl -s -o /dev/null -w '%{http_code}\n'
   https://your-domain/api/public/cards/demo-01` should say 200.

On a **new host** (disaster recovery): install the repo, put `directus/.env`
and the root `.env` back (they hold `KEY`, `SECRET`, `DIRECTUS_TOKEN` and the
seed accounts), start the compose project once so the volumes exist, then run
the restore. The backup's `manifest.json` records which volumes it came from;
a name mismatch on the new host is expected and fine.

## Prove your backups: the 10-minute drill

A backup that has never been restored is a hope, not a plan. Run this quarterly —
it touches nothing live:

```bash
npm run backup                                       # 1. fresh backup
docker volume create qrv-drill-db                    # 2. scratch volumes
docker volume create qrv-drill-uploads
docker run -d --name qrv-fill -v qrv-drill-db:/data -v qrv-drill-uploads:/photos alpine:3 sleep 120
docker cp backups/<stamp>/db.sqlite qrv-fill:/data/data.db
docker cp backups/<stamp>/uploads.tar.gz qrv-fill:/tmp/u.tgz
docker exec qrv-fill sh -c "tar -xzf /tmp/u.tgz -C /photos; rm /tmp/u.tgz"
docker rm -f qrv-fill
docker run -d --name qrv-drill-directus --env-file directus/.env \   # 3. boot from the backup
  -p 127.0.0.1:8056:8055 -v qrv-drill-db:/directus/database \
  -v qrv-drill-uploads:/directus/uploads directus/directus:latest
# wait ~15s, then:  curl http://127.0.0.1:8056/server/ping            # 4. expect 200
docker rm -f qrv-drill-directus                      # 5. clean up
docker volume rm qrv-drill-db qrv-drill-uploads
```

Pass criteria: `/server/ping` answers 200, and
`curl -H "Authorization: Bearer <DIRECTUS_TOKEN>" 'http://127.0.0.1:8056/items/vcards?limit=1'`
returns a card.

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| Restore finishes but Directus is `unhealthy` | The DB and image disagree, or the volume restore was partial: `docker logs qr-vcard-directus`, and re-run the restore after `npm run backup` from the healthy instance. |
| `container qr-vcard-directus is not running` | Start it (`npm run directus:up`); the scripts read the volume names from the running container, and the restore needs the compose project. |
| `node:sqlite unavailable` warning during backup | Older image without Node ≥ 22.5; the script falls back to the `sqlite3` CLI inside the container. |
| Seed/admin password fails after a restore | Expected if the password changed since: passwords live **in the DB** and the backup restores the DB faithfully — use the password from backup time, or set a new one with `npm run directus:bootstrap` (idempotent). |
| `manifest.json` verification fails | The folder was moved incompletely or corrupted in transit — re-copy or take a new backup. The restore script will not use it. |

**Related reading:** `server/README.md` (reverse-proxy setup), root `README.md`
(the security model — why `DIRECTUS_TOKEN` in the root `.env` is the credential
that matters after a restore).
