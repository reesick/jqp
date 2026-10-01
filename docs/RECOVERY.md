# Backup and restore

## Take a backup
```
npm run backup
```
Writes one JSON-lines file per table to `backups/<timestamp>/`, with a `MANIFEST.json` of row counts. It runs in a single read-only snapshot, so it never changes anything and the files are consistent with each other. The newest 7 snapshots are kept.

The folder is git-ignored and **contains personal data and encrypted tokens**. Keep it private, copy it somewhere safe (not a shared folder), and delete snapshots you no longer need.

Supabase's current plan has no automatic backups, so run this before any migration, bulk edit or risky change, and at least weekly.

## Restore (manual, on purpose)
Restoring overwrites live data, so it is never automatic.
1. Stop the DM worker and the publish worker.
2. Take a fresh `npm run backup` of the current state, even if it is damaged.
3. Decide the scope: one table, or everything. Prefer restoring only the damaged table.
4. For a table, read `backups/<timestamp>/<table>.jsonl` and insert rows with a parameterised script. Do not paste rows into SQL by hand. Compare row counts with `MANIFEST.json` afterwards.
5. Start the workers, then run `npm run doctor` and `npm run smoke`.

Tables that are safe to rebuild and rarely need restoring: `system_events`, `alert_state`, `webhook_events`, `WebhookEvent`, `OperationalEvent`.
Tables that matter most: `posts`, `post_media`, `campaigns`, `Automation`, `InstagramAccount`, `DmLog`, `User`, `Workspace`.

## Not covered
Job queue contents (schema `pgboss`) and Redis are not dumped, because they are transient. Jobs are re-created from the database state. Supabase storage images are deleted after publishing, so there is nothing to back up there.
