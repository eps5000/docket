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

Run every command below from the `docker/` folder of your Task Lite checkout.

## Nightly backups

Every night at 03:00 (local time), Task Lite takes a verified backup of the database and every document, and keeps 14 days of them. They're stored in the data volume, under `/data/backups`.

**Settings → Service health → Backups** shows each location, when the last backup finished, and how long backups are kept.

To take one now:

```bash
docker compose exec tasklite tasklite backup now
```

## An extra copy on your machine

The volume copy is lost if the volume is. You can have each backup also copied to a folder on this machine, kept for the same 14 days:

1. Create the folder, for example `~/TaskLiteBackups`. On Linux, let the container write to it: `sudo chown 10001:10001 ~/TaskLiteBackups`.
2. In `docker/compose.yaml`, uncomment the line `- ~/TaskLiteBackups:/backups-extra`.
3. In `docker/.env` (copy `.env.example`), set `TASKLITE_BACKUP_EXTRA_DIR=/backups-extra`.
4. Run `docker compose up -d`, then take a backup now. Settings shows both locations.

If the extra copy fails (the folder is missing, full or not writable), the backup in the volume still succeeds, and Problems shows **Extra backup copy failed** until a copy works again. Click *Open* to see the details in Settings.

## Restore

Restoring replaces all current data with the backup. Stop the service first:

```bash
docker compose stop tasklite
docker compose run --rm tasklite tasklite restore tasklite-YYYYMMDD-HHMM.tar.gz
docker compose up -d
```

- It checks the archive before replacing anything, and refuses to run while the service is running.
- It accepts a backup from either location.
- It prints checksums of items, events and documents, which match the backup's.
- Backups hold no keys or tokens. Restoring onto a new volume makes new ones, so unlock again and give your agents the new token.

## Export

To keep a readable copy of everything outside Task Lite, or to move to another tool:

```bash
docker compose exec tasklite tasklite export
```

It writes one `.tar.gz` with every table as JSON, every document version, and a manifest with checksums, then prints the command to copy it out. It never includes the owner key or the agent token. An export is for reading, not for restoring: use a backup to restore.

## What deletes data

- `docker compose down` keeps your data. `docker compose down --volumes` deletes the volume and everything in it, except backup copies on your machine.
- Deleting a project (**Settings → Projects → Delete…**) removes its items and documents. Backups keep a copy until they age out.
