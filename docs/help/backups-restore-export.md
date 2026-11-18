---
title: Backups, restore and export
summary: Nightly backups and where they're kept, how to take one now, restore one, keep an extra copy on your machine, and export all your data.
group: Operations
order: 1
anchors:
  - settings.service-health
  - problems.extra_backup_failed
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
- Backups hold no keys or tokens. Restoring onto a new volume makes new ones, so unlock again and give your agents the new token.

## Export

To keep a readable copy of everything outside Docket, or to move to another tool:

```bash
docker compose exec docket docket export
```

It writes one `.tar.gz` with every table as JSON, every document version, and a manifest with checksums, then prints the command to copy it out. It never includes the owner key or the agent token. An export is for reading, not for restoring: use a backup to restore.

## What deletes data

- `docker compose down` keeps your data. `docker compose down --volumes` deletes the volume and everything in it, except backup copies on your machine.
- Deleting a project (**Settings → Projects → Delete…**) removes its items and documents. Backups keep a copy until they age out.
