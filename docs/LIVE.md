# Live deployment reference

The actual production URLs and settings for this project, and how to re-verify them. Written after the first successful deploy on 2026-08-21.

## Deployed services

Updated 2026-10-01. There are four Vercel projects; only two matter.

| Service | Vercel project | URL | Root dir | Status |
|---|---|---|---|---|
| jqp dashboard (**production**) | `jqp-web` | https://jqp-web-tau.vercel.app | `apps/web` | live, canonical |
| jqp dashboard (old duplicate) | `jqp-web-89h2` | https://jqp-web-89h2-wheat.vercel.app | `apps/web` | **duplicate, candidate for retirement** |
| OpenReply (**wired to Meta**) | `jqp-openreply-1` | https://jqp-openreply-1.vercel.app | `vendor/openreply` | live, canonical; webhook + OpenReply OAuth point here |
| OpenReply (duplicate copy) | `jqp-openreply` | https://jqp-openreply-zeta.vercel.app | `vendor/openreply` | duplicate, not wired to Meta |
| jqp publish worker | (none) | none | `apps/worker` | **local only**, run on demand |
| OpenReply DM worker | (none) | none | `vendor/openreply` | always-on host, e.g. Oracle free VM, see `docs/ORACLE-WORKER.md` |

Before retiring either duplicate, confirm nothing still references it: the Meta app's redirect URIs and webhook callback, any bookmarks, and the env vars in the other projects (`OPENREPLY_DASHBOARD_URL`, `NEXTAUTH_URL`). Do not delete a project that shares env or domains with the canonical one without checking first. Retirement has not been done.

### Known issue: OpenReply `/api/health` hangs (Redis)

Status: **resolved 2026-10-01** (new Redis Cloud database; see below). Original cause: **confirmed.** The Upstash database `joint-civet-121910` no longer exists: its hostname does not resolve (`ENOTFOUND`) while other hosts resolve from the same machine. `npm run check-redis` reproduces this. Fix: create a new database and update `REDIS_URL` everywhere (`docs/MORNING-CHECKLIST.md`, step 1).

The endpoint checks the database, pings Redis, reads queue counts and reads the DM worker heartbeat, and the heartbeat is stored in Redis too. OpenReply creates its ioredis clients with `maxRetriesPerRequest: null` (`vendor/openreply/lib/queue/client.ts` and `lib/utils/rate-limiter.ts`; required by BullMQ), which makes commands retry forever instead of erroring. If Redis is unreachable (paused or deleted Upstash database, wrong or rotated `REDIS_URL`, TLS/URL format), the request hangs until the platform times it out rather than returning `redis: error`. Comment-to-DM cannot work while Redis is down because the queue and rate limiter need it. Not fixable in this repo, because `vendor/openreply` is vendored unmodified. Check the Upstash console and `REDIS_URL` (must be the `rediss://` ioredis URL, identical on `jqp-openreply-1` and the DM worker).

## Why the publish worker is not deployed anywhere

It **cannot** be. `stepValidate` and `stepUpload` in `packages/publisher/src/pipeline.ts` call `scanPostFolder(post.folder_path)`, and `folder_path` is a path on the operator's own machine (`D:\jqp\...`). Any remote host fails with ENOENT on the first post. Publishing is therefore a local operation by construction — start `apps/worker` when you want to post.

Only the DM worker genuinely needs 24/7 hosting, because a comment can arrive at any time and the reply has to go out inside Meta's messaging window.

Knock-on effect: `sync-campaign-to-openreply` also runs in `apps/worker`, so it only fires while the local worker is up. The retention purge additionally runs from the cloud (`/api/cron/purge`) once `MONITOR_TOKEN` and the GitHub Actions variables are set. A campaign stuck at `DM_SYNC_PENDING` just means the local worker hasn't run since it was enabled.

## Database — use the pooler, not the direct host

```
postgresql://postgres.rligoaiclwjwfbixnrry:<PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
```

**The direct host does not work from Vercel.** `db.rligoaiclwjwfbixnrry.supabase.co` resolves to IPv6 only, and Vercel functions have no IPv6 outbound — you get `P1001: Can't reach database server` from Prisma, or a silent `db: error` from our health endpoint. Local dev works either way, which is what makes this confusing to diagnose.

**Session pooler (5432), not transaction pooler (6543).** pg-boss needs session semantics — `LISTEN/NOTIFY` and prepared statements break under transaction pooling. Verified both `postgres.js` and pg-boss connect and operate correctly through session mode.

Note the connection string differs from the direct one in **two** places, and the port is the same in both — easy to think you've swapped it when you haven't:

| | Direct (broken on Vercel) | Session pooler (works) |
|---|---|---|
| user | `postgres` | `postgres.rligoaiclwjwfbixnrry` |
| host | `db.rligoaiclwjwfbixnrry.supabase.co` | `aws-0-ap-south-1.pooler.supabase.com` |

## Environment values that must match the live domains

**jqp-web**
- `APP_BASE_URL` = `https://jqp-web-tau.vercel.app`
- `META_OAUTH_REDIRECT_URI` = `https://jqp-web-tau.vercel.app/api/meta/oauth/callback`
- `OPENREPLY_DASHBOARD_URL` = `https://jqp-openreply-1.vercel.app`

**jqp-openreply-1**
- `NEXTAUTH_URL` = `https://jqp-openreply-1.vercel.app` — magic-link login silently breaks if this is wrong, since Auth.js builds every login URL from it

## Meta configuration

- Webhook callback: `https://jqp-openreply-1.vercel.app/api/webhook`
- OAuth redirect (dashboard): `https://jqp-web-tau.vercel.app/api/meta/oauth/callback`
- OAuth redirect (OpenReply's own Connect Instagram): `https://jqp-openreply-1.vercel.app/api/instagram/callback`
- Subscribed fields: `comments`, `messaging_postbacks` are required; `messages` is optional and is subscribed automatically when an account is connected in OpenReply
- Full account setup: `docs/ADD-ACCOUNT.md`
- `messaging_seen` deliberately NOT subscribed — see `docs/COMPLIANCE.md`

## OpenReply build command (changed 2026-10-02)

The Vercel project `jqp-openreply-1` builds with `npx prisma generate && npx next build` (project setting, not a file in the repo). The default `npm run vercel-build` also ran `prisma migrate deploy`, which takes a database lock that **hangs through the transaction pooler** (port 6543, which OpenReply now uses at runtime). Every build then ran 45 minutes and was killed. Migrations are applied by hand when OpenReply adds one:

```bash
cd vendor/openreply
# DATABASE_URL must be the SESSION pooler (port 5432) for this one command
npx prisma migrate deploy
```

## Prisma baseline (one-time, already done)

OpenReply's 18 migrations were originally applied as raw SQL, so Prisma had no `_prisma_migrations` table and `migrate deploy` failed the build with **P3005** ("schema is not empty"). Baselined with:

```bash
cd vendor/openreply
for m in $(ls prisma/migrations | grep -v migration_lock); do npx prisma migrate resolve --applied "$m"; done
```

`prisma migrate deploy` now reports "No pending migrations to apply." Future OpenReply migrations apply cleanly on deploy. Do not repeat this unless the tracking table is lost.

## Re-verify everything

```bash
# Set TOKEN to your webhook verify token (the META_WEBHOOK_VERIFY_TOKEN value). Do not commit it or paste it into shared places.
TOKEN="<YOUR_VERIFY_TOKEN>"
echo "--- jqp-web ---" && curl -s https://jqp-web-tau.vercel.app/api/health && echo && echo "--- openreply webhook ---" && curl -s -w " HTTP:%{http_code}\n" "https://jqp-openreply-1.vercel.app/api/webhook?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=OK" && echo "--- openreply health ---" && curl -s --max-time 20 https://jqp-openreply-1.vercel.app/api/health
```

Expected:
- jqp-web → `{"success":true,"db":"ok",...}`
- webhook → `OK HTTP:200`
- OpenReply → JSON with `checks.database.status`, `checks.redis.status`, `checks.queue.status` all `ok` and `checks.worker.healthy` true. `worker.healthy` is `false` whenever the DM worker is not running, which alone makes the endpoint return 503; that is expected, not a fault. If the request hangs instead of answering, see the known issue above.

## Build gotchas already solved

Recorded so they aren't rediscovered:

- **Route files may only export handlers.** `export const OAUTH_STATE_COOKIE` from a `route.ts` passes `next dev` and typecheck, then fails `next build` with "not assignable to type 'never'". Shared constants live in `app/api/_lib/`.
- **`dist/` is gitignored**, so a fresh clone has no compiled `@jqp/*`. `npm run build --workspaces` runs alphabetically, not topologically, and per-package `prepare` scripts fail the same way. Hence `build:packages` at the root with the order spelled out.
- **Vercel scopes its install** to the target workspace's dependency closure, so `@jqp/ai`'s AWS SDK isn't present. `@jqp/ai` is excluded from `build:packages`; nothing deployed imports it.
- **Test files were being compiled** into `dist/`, which coupled the build to `vitest` (a root-only devDependency absent in Vercel's build). All package tsconfigs now exclude `*.test.ts`.
