# 02. Database, storage, Redis and data handling

Everything about where state lives, how each process connects to it, what the tables are, and how personal data is treated. Read from the SQL migrations, the Prisma schema, `packages/core`, `packages/queue`, `packages/publisher` and live checks on 2026-10-21. No credentials appear here; file 06 says where they are kept.

## 1. The stores at a glance

| Store | Provider / location | Used by | Holds |
|---|---|---|---|
| **Postgres** (`public` schema) | Supabase project `jqp`, ref `rligoaiclwjwfbixnrry`, region ap-south-1 (Mumbai), via pgBouncer poolers | dashboard, publish worker, scripts, MCP (session pooler); OpenReply web + DM worker (transaction pooler) | our tables (snake_case) and OpenReply's tables (PascalCase) |
| **Postgres** (`pgboss` schema) | same database | publish worker, dashboard (enqueue) | pg-boss job queue and schedules |
| **Supabase Storage** | same project, public bucket `instagram-media` (25 MB limit, JPEG/PNG only) | publisher uploads; Meta fetches by URL | temporary post images (deleted after publish) |
| **Redis** | Redis Cloud database (plain `redis://`, host name in the `doctor` output, e.g. `harmonious-crate-eggnog-42587.db.redis.io`), eviction `noeviction`, no append-only file (read 2026-10-13) | OpenReply only: BullMQ DM queue, rate limiter, worker heartbeat | transient queue jobs (hold commenter name and comment text while queued), counters |
| Local disk | owner's laptop | publish worker | post folders (`posts/`, `POST-F/`), `backups/`, `dist/` |
| Local `D:\jqp-private\env-backups` | owner's laptop, locked to the owner's account | env helper scripts | timestamped `.env` backups (newest 5 per file) |

## 2. Connection rules (the thing that broke production twice)

| Rule | Why |
|---|---|
| Never use the direct host `db.<ref>.supabase.co` from Vercel | It resolves to IPv6 only; Vercel has no IPv6 egress. Symptom: Prisma `P1001: Can't reach database server`, or `/api/health` returns `db: error` while local dev works (it did on 2026-08 and again on `jqp-web-tau`) |
| Use the **session pooler, port 5432**, user `postgres.<ref>`, host `aws-0-ap-south-1.pooler.supabase.com` for the dashboard, publish worker, scripts and MCP | pg-boss needs session semantics (LISTEN/NOTIFY, prepared statements) |
| Use the **transaction pooler, port 6543** for OpenReply (Vercel and the VM worker) | Session pooler allows only about **15 clients in total across every process**. OpenReply (Prisma, up to 10 per serverless instance) plus pg-boss (library default 10) exhausted it on 2026-10-01 (`EMAXCONNSESSION`) and took the dashboard and DMs down |
| Our pools: `DB_POOL_MAX` default 5, `BOSS_POOL_MAX` default 3 | Keep the total small. The worker, the web enqueue calls and the MCP server can each take connections; never run two heavy things at once (for example `npm run doctor` while the worker and a script run) |
| `npm run sync-openreply-env`, `set-env`, `set-database-url`, `rotate-db-password` apply the right port per target. **Do not paste URLs by hand** | A pooler-port mix-up silently breaks either pg-boss (6543) or the connection budget (5432) |
| `prisma migrate deploy` (OpenReply) needs a **session** connection and hangs through 6543 | That hang made Vercel builds run 45 minutes. The Vercel project `jqp-openreply-1` therefore builds with `npx prisma generate && npx next build` (a project setting, not in the repo). Run OpenReply migrations by hand with `DATABASE_URL` on 5432 |
| The apps connect as the `postgres` superuser | Superusers bypass RLS and ignore grants. If `DATABASE_URL` is ever pointed at a non-superuser role, `FORCE ROW LEVEL SECURITY` with zero policies means **total denial**; give that role `BYPASSRLS` or write policies first (moving to a restricted worker role is on the before-scaling list) |

## 3. Our tables (migration `0001_init.sql`, snake_case)

Enums: `post_status` (DISCOVERED, VALIDATING, VALIDATION_FAILED, UPLOADING, CREATING_CHILDREN, WAITING_FOR_CHILDREN, CREATING_CAROUSEL, WAITING_FOR_CAROUSEL, PUBLISHING, PUBLISHED, FAILED), `container_status` (PENDING, IN_PROGRESS, FINISHED, ERROR, EXPIRED, PUBLISHED), `campaign_sync_status` (DM_SYNC_PENDING, DM_SYNCING, DM_SYNCED, DM_SYNC_FAILED), `match_mode` (WHOLE_WORD, PARTIAL, EXACT), plus `dm_status`, `comment_event_status`, `webhook_event_status` (legacy). `set_updated_at()` trigger keeps `updated_at` fresh.

| Table | Purpose | Key columns |
|---|---|---|
| `ig_accounts` | Connected Instagram accounts and their **encrypted** tokens | `ig_user_id` (unique), `username`, `access_token_encrypted` + `access_token_iv` + `access_token_tag` (AES-256-GCM parts), `token_expires_at`, `connected_at`, `is_active` |
| `posts` | One row per content folder; the publish state machine's system of record | `campaign_id` (unique, the folder slug), `folder_name`, `folder_path` (absolute path on the laptop), `ig_account_id` (nullable FK, **never written by any code today**; the default account is used), `caption`, `media_type` (IMAGE or CAROUSEL), `status`, `instagram_media_id` (unique once published), `carousel_container_id`, `published_at`, `error_message` |
| `post_media` | One row per image | `post_id`, `sequence` 1 to 10 (unique with post), `original_filename`, `storage_path`, `public_url`, `child_container_id`, `container_status` |
| `campaigns` | DM configuration staged against a post (1:1, `post_id` unique) | `instagram_media_id`, `trigger_keywords text[]`, `match_mode`, `dm_message`, `destination_url`, `public_reply_enabled`, `public_reply_message`, `enabled`, `sync_status`, `sync_error`, `openreply_automation_id`, and from migration 0005 `opening_dm_enabled`, `opening_dm_message`, `opening_dm_button_label` |
| `system_events` (0008) | Durable, scrubbed record of what happened | `level` (info/warn/error), `source` (publish, dm-sync, api, auth, monitor, retention), `code`, `message` (<= 300 chars, scrubbed), `correlation_id`, `meta jsonb` (scalars only) |
| `alert_state` (0008) | One row per monitored check for transition alerts | `key` (primary), `status` (ok/failing), `since`, `last_notified_at`, `detail` |
| `_migrations_applied` | Ledger written by `scripts/migrate.ts` | `filename`, `applied_at` |
| `webhook_events`, `comment_events`, `dm_logs` | **Legacy / unused.** They were designed for an in-house webhook path that was replaced by OpenReply. Nothing writes them; only the retention job touches them (guarded by `to_regclass`). Do not build on them |

Workflow facts worth knowing:
- `campaigns.sync_status` and `sync_error` drive the Automations page badges and the "Campaign sync" health check (failed or stuck > 15 minutes after publish).
- `posts.campaign_id` is the **folder name**, not a row in `campaigns`; the two are linked through `campaigns.post_id`.
- Rows in `post_media` are kept after publish (audit), but the storage objects are deleted.

## 4. OpenReply's tables (PascalCase, Prisma, same `public` schema)

Defined in `vendor/openreply/prisma/schema.prisma`, 18 migrations, baselined (see section 5). Models: `User`, `Account`, `Session`, `VerificationToken` (Auth.js), `Workspace`, `WorkspaceMember`, `WorkspaceInvitation`, `InstagramAccount`, `FollowerSnapshot`, `Automation`, `DmLog`, `ProcessedComment`, `TrackedLink`, `LinkClick`, `WebhookEvent`, `OperationalEvent`.

The ones we read or write:

| Table | Our interaction |
|---|---|
| `InstagramAccount` (`instagramId` unique, `username`, **`accessToken` encrypted with OpenReply's own `ENCRYPTION_KEY`**, `tokenExpiresAt`, `webhookSubscribed`, `workspaceId`) | Bridge looks up by `instagramId`; `doctor` and the Settings page read token expiry; `connect-openreply-account` writes it |
| `Automation` (`postId` = Instagram media id, `keywords[]`, `matchAnyWord`, `wholeWordMatch`, `dmMessage`, `openingDmEnabled/Message/ButtonLabel`, `publicReplyEnabled/Message/Messages[]`, `requireFollow`, `followUp*`, `isActive`, `name` like `jqp: <slug>`) | Bridge inserts/updates/deactivates; the column contract (21 columns) is verified by `doctor` |
| `DmLog` (`status` PENDING/SENT/FAILED/SKIPPED_*, `commenterId`, `commenterName`, `commentText`, `commentId`, `dmSentAt`, `errorMessage`, `publicReplySentAt`; **unique `(automationId, commentId)`** is the idempotency key) | Activity page, System page aggregates, retention anonymisation |
| `WebhookEvent`, `OperationalEvent` | System page "last webhook" and recent OpenReply errors; retention deletes old rows |
| `LinkClick` | Retention nulls `ipHash`, `userAgent`, `referrer` after 90 days |

Important: `Automation.postId` equals `posts.instagram_media_id`, and that is the only join between the two halves. The two encryption keys differ: our `ENCRYPTION_KEY` (root env) versus OpenReply's (`OPENREPLY_ENCRYPTION_KEY` in the root env, `ENCRYPTION_KEY` in OpenReply's env). Never "unify" them: tokens encrypted with one cannot be read with the other.

Indexes added for scale in migration 0008 (guarded): `"DmLog"("createdAt" desc)`, `"DmLog"(status, "createdAt" desc)`, `"WebhookEvent"("createdAt" desc)`.

## 5. Migrations

Files in `supabase/migrations/`, applied in filename order by `npm run migrate` (`scripts/migrate.ts`) which records each in `public._migrations_applied` so re-runs only run new files. **Running it locally applies to production** (one shared database). It is not part of any Vercel build. Applying by pasting into the Supabase SQL editor also works (files are written to be re-runnable).

| File | Does |
|---|---|
| `0001_init.sql` | Extension `pgcrypto`, enums, the tables in section 3, indexes and triggers |
| `0002_rls.sql` | Enable and **force** RLS on our 7 original tables with no policies (deny-all for `anon`/`authenticated`; the service role and superuser bypass) |
| `0003_storage.sql` | Create public bucket `instagram-media` (25 MB, `image/jpeg`, `image/png`) with a public-read policy; writes are service-role only |
| `0004_openreply_schema.sql` | **Superseded no-op**: `drop schema if exists openreply cascade` (the isolated schema approach failed because Prisma hardcodes `public.`) |
| `0005_opening_dm.sql` | Adds the three opening-DM columns to `campaigns` |
| `0006_lockdown_public_api_roles.sql` | Loops over every table/sequence in `public`: revoke all from `anon`, `authenticated`; enable and force RLS; revoke default privileges for future objects created by `postgres`; revoke `USAGE` on schema `public`. Added after verification showed OpenReply's tables (sessions, magic-link tokens, DM text) were readable and writable with only the public anon key |
| `0007_storage_no_list.sql` | Drop the public SELECT policy on `storage.objects` so the anon key cannot list the bucket (public objects are still served by URL) |
| `0008_system_events.sql` | `system_events`, `alert_state`, their lockdown, and the DmLog/WebhookEvent indexes |

`npm run doctor` reports "our tables exist (migrations 0001-0006)", "monitoring tables exist (migration 0008)" and "media bucket listing is closed (migration 0007)"; all pass as of 2026-10-21.

OpenReply's own migrations live in `vendor/openreply/prisma/migrations`. They were originally applied as raw SQL, so Prisma had no history table and `migrate deploy` failed with **P3005**; it was **baselined once** with `prisma migrate resolve --applied <name>` for each folder. `migrate deploy` now reports "No pending migrations". Do not repeat the baseline unless the `_prisma_migrations` table is lost. When OpenReply adds a migration, run `npx prisma migrate deploy` by hand from `vendor/openreply` with `DATABASE_URL` on port 5432.

## 6. Supabase Storage

- Bucket `instagram-media`, public read, writes only with the service-role key (`SUPABASE_SERVICE_ROLE_KEY`). Meta's servers must be able to GET `image_url` unauthenticated, and signed URLs can expire during a slow retry, so a public bucket was chosen (decision in `0003`).
- Object path `{campaign_id}/{sequence}-{sanitizedFilename}` (`packages/storage/src/upload.ts`); upload uses `upsert: true`, so a resumed run overwrites rather than duplicates. `preflightMediaUrl` fetches the public URL before handing it to Meta.
- After a successful publish the objects are deleted (`deletePostMedia`), best effort. Nothing sensitive is stored (they are the same images being posted publicly), but there is no archive of the images in Supabase afterward; the source of truth is the folder on the laptop.
- The browser never uses Supabase directly: there are no `NEXT_PUBLIC_*` variables. `SUPABASE_ANON_KEY` exists in env but nothing relies on it; the smoke test uses it to prove it is locked out.

## 7. Redis (OpenReply's BullMQ)

| Fact | Detail |
|---|---|
| Provider | Redis Cloud, which replaced a deleted Upstash database on 2026-10-01/02. The plan tier is not recorded in the repo (**UNVERIFIED**; check the Redis Cloud console) |
| URL form | plain `redis://` (unencrypted), the owner's decision. The traffic includes commenter names and comment text while a job is queued, and the password could queue forged DMs. TLS (`rediss://`) is the first item in the before-scaling list. The VM worker connects across the public internet |
| Where the URL lives | root env `OPENREPLY_REDIS_URL` (generated into `vendor/openreply/.env` as `REDIS_URL`), Vercel `jqp-web` (`OPENREPLY_REDIS_URL`), Vercel `jqp-openreply-1` (`REDIS_URL`), and the VM `/etc/jqp/worker.env` (`REDIS_URL`). **All must match exactly.** A mismatch means "comments arrive, no DMs, no errors" |
| Eviction / persistence | `maxmemory-policy noeviction` (jobs are never silently dropped; Redis refuses new ones when full) and no append-only file (a Redis restart could in theory lose queued jobs; the poller recovers what it can) as read on 2026-10-13. Memory used then: 2.6 MB. Re-check with `npm run check-redis` |
| Connection style | ioredis with `maxRetriesPerRequest: null` (required by BullMQ). Side effect: if Redis is unreachable the OpenReply `/api/health` request **hangs** instead of erroring; our System page treats a 6 s timeout as "OpenReply down, usually Redis" |
| BullMQ queue | one DM queue (`getDMQueue`) carrying job names `process-comment`, `process-postback`, `process-follow-up`, `process-message`. Worker concurrency 5; retry backoff 5, 15, 45 minutes |
| Rate limiter | a Lua script on a fixed 1-hour window, cap **750** private replies per account per hour (Meta's documented cap); over-limit comments are requeued after 30 minutes, at most 3 times, then given up on (a viral burst could leave comments unanswered) |
| Heartbeat | key `health:worker:dm`, TTL 120 s, rewritten every 30 s by the DM worker; also an `alerts:worker:dm` key for worker failure notes |
| Not in Redis | our own jobs (publish, sync, purge, token refresh) use pg-boss in Postgres |

## 8. pg-boss (our queue) in Postgres

Schema `pgboss`, created and migrated by pg-boss itself on `boss.start()`. Details of queues, retry and schedules are in file 01 section 7. The schedule definitions (`purge-expired-data` daily 04:00 UTC, `refresh-ig-tokens` Mondays 03:00 UTC) are upserted on every worker boot, so they live in code, not in someone's console. Jobs and schedules only run while the **local publish worker** is up.

## 9. Retention and personal data

What personal data exists, where, and what removes it (`packages/publisher/src/retention.ts`; settings `RAW_PAYLOAD_RETENTION_DAYS` default 30 and `PII_RETENTION_DAYS` default 90, `SYSTEM_EVENT_RETENTION_DAYS` default 90; the numbers are self-set, Meta mandates none):

| Data | Where | Treatment |
|---|---|---|
| Raw Meta webhook payloads | `"WebhookEvent"`, `webhook_events` | **Deleted** after 30 days |
| Commenter name and comment text | `"DmLog"."commenterName"`, `"DmLog"."commentText"`; `comment_events.commenter_username`, `comment_text` | **Nulled / blanked in place** after 90 days; the row stays so counts do not change. `commenterId` (opaque Meta-scoped id) is kept because the send path uses it as a dedup key |
| OpenReply operational events (include a preview of requests that failed the signature check) | `"OperationalEvent"` | **Deleted** after 30 days |
| Link click metadata | `"LinkClick"` hashed IP, user agent, referrer | **Nulled** after 90 days |
| System events | `system_events` | Deleted after 90 days by `purgeOldEvents`; also scrubbed at write time |
| Queued jobs in Redis | BullMQ | Transient; completed jobs may linger (BullMQ keeps recent completed jobs) |
| Instagram access tokens | `ig_accounts` (our key), `"InstagramAccount"` (OpenReply's key) | Encrypted at rest with AES-256-GCM; never logged or put in events |

The purge runs daily from the publish worker (04:00 UTC) and, once the GitHub secrets exist, from `POST /api/cron/purge` (04:30 UTC) so it does not depend on the laptop being on. `npx tsx --env-file=.env scripts/purge-dry-run.ts` shows what would be deleted (`--apply` runs it).

**Gaps (open):** no per-person erasure path, and the data-deletion page names no contact (Meta's terms expect one; required before App Review or multi-account); Redis is unencrypted; commenter data sits in OpenReply's `DmLog` until anonymised. See `docs/DATA-PROTECTION.md`.

### Event log privacy (`packages/publisher/src/events.ts`)
`recordEvent` never throws, truncates messages to 300 chars, replaces URLs and connection strings, redacts long opaque strings, and **drops metadata keys** matching `name|text|comment|email|username|handle|token|secret|password|authorization|cookie|key|url|payload|body`. Only scalar metadata survives. Known small gap (`REMEDIATION-PLAN` B11): `scrubText` still lets emails and @handles through in free-text messages, so do not put them in messages.

## 10. Backups and recovery

- **No automatic backups** (Supabase free plan). `npm run backup` writes one JSON-lines file per table to `backups/<timestamp>/` with a `MANIFEST.json` of row counts, in a single read-only snapshot. The folder is git-ignored and **contains personal data and encrypted tokens**: keep it private. The only snapshot on the laptop is `backups/2026-10-01T20-25-32-846Z`, so anything since then is not backed up. Run it before any migration, bulk edit or risky change and weekly (scheduling it with Task Scheduler is open item B12).
- Restore is manual on purpose (`docs/RECOVERY.md`): stop both workers, take a fresh backup of the damaged state, restore one table at a time with a parameterised script, compare row counts to the manifest, restart, run `doctor` and `smoke`. Tables safe to rebuild: `system_events`, `alert_state`, `webhook_events`, `"WebhookEvent"`, `"OperationalEvent"`. Tables that matter: `posts`, `post_media`, `campaigns`, `"Automation"`, `"InstagramAccount"`, `"DmLog"`, `"User"`, `"Workspace"`.
- Not covered by backup: pg-boss contents and Redis (transient; jobs are re-created from database state) and Storage images (deleted after publish; originals are in the post folders).
- The encryption keys are a single point of failure: **back up `ENCRYPTION_KEY` (ours) and OpenReply's `ENCRYPTION_KEY` outside git**. Losing either makes the matching stored tokens unreadable and forces reconnecting the account (`connect-account`, `connect-openreply-account`).

## 11. Common data-layer failures and the fix

| Symptom | Cause | Fix |
|---|---|---|
| Dashboard 500, `P1001` or `db: error` on Vercel only | Direct DB host (IPv6) in `DATABASE_URL` | Session pooler URL on 5432; redeploy |
| `EMAXCONNSESSION` / "max clients reached" | Too many session connections (about 15 total) | Stop extra scripts/workers; ensure OpenReply is on 6543; keep pool caps |
| pg-boss errors after a URL change | Transaction pooler (6543) used for our side | Put our `DATABASE_URL` back on 5432 |
| OpenReply Vercel build runs for 45 min | `prisma migrate deploy` through 6543 | Build command `npx prisma generate && npx next build`; migrate by hand on 5432 |
| Campaign stuck at `DM_SYNC_PENDING` | The publish worker is not running (the sync job runs there) | Start `npm run dev:worker`; if it then goes to `DM_SYNC_FAILED`, read `sync_error` (usually the account is not registered in OpenReply) |
| "Token decryption error" in the DM worker | VM worker's `ENCRYPTION_KEY` differs from the one on Vercel's `jqp-openreply-1` | Re-run `sync-openreply-env` and `deploy-dm-worker --push-env --restart` |
| Comments arrive, no DMs, no errors | Worker's `REDIS_URL` differs from Vercel's | Make them identical |
| Everything denies access after a role change | `FORCE ROW LEVEL SECURITY` with zero policies and a non-superuser role | Give the role `BYPASSRLS` or add policies |
