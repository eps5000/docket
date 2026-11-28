---
title: Backups, restore and export
summary: Nightly backups and where they're kept, how to take one now, restore one, keep an extra copy on your machine, and export all your data.
group: Operations
order: 1
anchors:
  - settings.service-health
related:
  - crash-recovery
  - jira-import
---

Run every command below from the `docker/` folder of your Docket checkout.

## Nightly backups

Every night at 03:00 (local time), Docket takes a verified backup of the database and every document, and keeps 14 days of them. They're stored in the data volume, under `/data/backups`.

**Settings → Service health → Backups** shows each location, when the last backup finished, and how long backups are kept.

To take one now:

```bash
docker compose exec docket docket backup now
```

### If a backup is missed

If Docket was stopped or your computer was asleep at 03:00, Docket takes **one** catch-up backup as soon as it's running again, however many nights it missed.

If a backup fails, or one is still missing an hour after it was due, **Needs you** shows **Backup failed or overdue**. It says what went wrong and when your newest good backup is from. Check the free space on the data volume, then take one now. The problem clears on the next good backup. A failed backup is tried again at the next scheduled time, not over and over.

## An extra copy on your machine

The volume copy is lost if the volume is. You can have each backup also copied to a folder on this machine, kept for the same 14 days:

1. Create the folder, for example `~/DocketBackups`. On Linux, let the container write to it: `sudo chown 10001:10001 ~/DocketBackups`.
2. In `docker/compose.yaml`, uncomment the line `- ~/DocketBackups:/backups-extra`.
3. In `docker/.env` (copy `.env.example`), set `DOCKET_BACKUP_EXTRA_DIR=/backups-extra`.
4. Run `docker compose up -d`, then take a backup now. Settings shows both locations.

If the extra copy fails (the folder is missing, full or not writable), the backup in the volume still succeeds, and Problems shows **Extra backup copy failed** until a copy works again. Click *Open* to see the details in Settings.

## Restore

Restoring replaces all current data with the backup. Stop the service first:

```bash
docker compose stop docket
docker compose run --rm docket docket restore docket-YYYYMMDD-HHMM.tar.gz
docker compose up -d
```

- It checks the archive before replacing anything, and refuses to run while the service is running.
- It accepts a backup from either location.
- It prints checksums of items, events and documents, which match the backup's.
- Backups taken before the rename to Docket (named `tasklite-…tar.gz`) are still listed, kept for the same time and restorable. **Service health** names the data volume that's mounted; the README's "Moving from Task Lite" says how to copy an old `tasklite-data` volume into `docket-data`.
- Backups hold no keys or tokens. Restoring onto a new volume makes new ones; in protected mode, unlock again and give your agents the new token.

## Export

To keep a readable copy of everything outside Docket, or to move to another tool:

```bash
docker compose exec docket docket export
```

It writes one `.tar.gz` with every table as JSON, every document version, and a manifest with checksums, then prints the command to copy it out. It never includes the owner key or the agent token. An export is for reading, not for restoring: use a backup to restore.

### Current export without a live-volume write

For a supervised current-state check, use a **separate one-shot container** from the exact installed Docket image. Mount the running Docket data volume at `/source` **read-only** and a uniquely named disposable volume at `/scratch` writable. Create `/scratch/exports` on the disposable volume before the export. The container must have no published port, no network access, no host-code mount, and no other writable mount. Verify the image, both volume identities, exclusive scratch ownership, free capacity and a recovery backup before starting it.

Run this command *inside that isolated container*, after checking its mount manifest:

```bash
docket export --read-only-source --data-dir /source --out /scratch/exports/current.tar.gz
```

The read-only mode requires Linux mount metadata proving `/source` and `/scratch` are the exact mount points, the output is below `/scratch` on that mount, and their backing roots are disjoint; a second bind of the source volume or an output on `/tmp` is refused. The operator must still verify the exact Docker volume names and mount manifest independently. It opens SQLite without a write handle, includes committed WAL state in one snapshot, and checks the installed schema without migrating it. It reads existing service secrets only inside the one-shot process to scan exported table and document bytes; it does not create or change source secret files. Each referenced document must be a regular file beneath the docs root with no traversal or symlink component, and its file identity must remain stable through the read. It refuses a missing secret guard, an unsafe or missing referenced document, a source/destination mount alias, a pre-existing output file, a schema mismatch or a secret-bearing export. It prints bounded counts and checksums, not source paths or secret values.

Inspect the archive manifest and gzip integrity on the disposable volume, compare source database, WAL, SHM, document and secret metadata before and after, and verify the live service identity and health. Release only the exact one-shot container and disposable volume after an independent readback. A restored older backup can prove backup integrity, but its export is **historical** and does not satisfy a current export check. The ordinary `docket export` command above remains a writable-source operation and must not be used in place of this procedure when source writes are forbidden.

## What deletes data

- `docker compose down` keeps your data. `docker compose down --volumes` deletes the volume and everything in it, except backup copies on your machine.
- Deleting a project (**Settings → Projects → Delete…**) removes its items and documents. Backups keep a copy until they age out.
