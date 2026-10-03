# jqp

> **Start here:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the one-page map with a diagram. [`docs/INDEX.md`](docs/INDEX.md) says which document to read for what.

Instagram carousel publishing plus comment-to-DM automation, using the official Meta APIs only (Instagram API with Instagram Login). Built for a single operator running one Instagram professional account today, with a documented path to more (see `docs/ADD-ACCOUNT.md`).

This guide takes you from nothing to a working system, then covers daily operation, deployment, and a troubleshooting runbook. Every command shown exists in the root `package.json` or in `scripts/`. Where something could not be verified from the repository alone, it says so.

---

## 1. What the system is

Two halves that share one Supabase Postgres database and one Meta app:

| Half | Code | What it does |
|---|---|---|
| **Our publisher** | `packages/*`, `apps/web`, `apps/worker` | Scans a local post folder, validates it, uploads images to Supabase Storage, drives Meta's container/carousel/publish flow as a crash-resumable state machine, and exposes a dashboard. |
| **OpenReply** | `vendor/openreply` (vendored, do not modify) | The comment-to-DM engine: receives Meta webhooks, matches comment keywords, and sends the private reply / button DM through a BullMQ worker backed by Redis. It has its own web app, login and dashboard. |

The bridge between them is `packages/publisher/src/openreply-bridge.ts`. When a post is `PUBLISHED` and its campaign is enabled, the `sync-campaign-to-openreply` job writes a normal `Automation` row straight into OpenReply's tables in the shared `public` schema. OpenReply then treats it like any campaign created by hand.

## 2. Architecture

```
                         Operator (browser)
                 +-------------+--------------+
                 |                            |
                 v                            v
   +---------------------------+   +---------------------------+
   | jqp-web  (Vercel, bom1)   |   | jqp-openreply-1 (Vercel)  |
   | apps/web dashboard + API  |   | vendor/openreply web      |
   | https://jqp-web-tau...    |   | /api/webhook  /api/health |
   +------+--------------+-----+   +-----+-------------+-------+
          | enqueue      | SQL           | SQL         | BullMQ jobs
          | (pg-boss)    |               |             |
          v              v               v             v
   +------------------------------------------+   +--------------+
   |  Supabase Postgres (session pooler :5432)|   | Upstash Redis|
   |  posts, post_media, campaigns, ig_accounts|  | (OpenReply   |
   |  pgboss.* queue, webhook_events, ...      |  |  queue +     |
   |  + OpenReply PascalCase tables (public)   |  |  heartbeat)  |
   +-------+----------------------+-----------+   +------+-------+
           ^                      ^                       ^
           | dequeue              | SQL                   | consume
   +-------+--------------+   +---+-----------------------+------+
   | publish worker       |   | OpenReply DM worker              |
   | apps/worker          |   | vendor/openreply worker/         |
   | LOCAL ONLY (your PC) |   | host: Oracle free VM (pm2)       |
   | reads D:\ folders    |   | see docs/ORACLE-WORKER.md        |
   +-------+--------------+   +----------------+-----------------+
           |                                   |
           | Content Publishing API            | private replies / DMs
           v                                   v
        +----------------------------------------------+
        |   Meta: graph.instagram.com                  |
        |   webhooks (comments, messaging_postbacks) --+--> jqp-openreply-1 /api/webhook
        +----------------------------------------------+

   Resend: sends OpenReply's magic-link login emails.
   Supabase Storage: public bucket `instagram-media` (Meta fetches images by URL).
```

### What runs where

| Component | Host | Why there |
|---|---|---|
| Dashboard `apps/web` | Vercel project **`jqp-web`**, https://jqp-web-tau.vercel.app (region `bom1`, see `apps/web/vercel.json`) | Stateless Next.js app. `jqp-web-89h2` is an old duplicate, see `docs/LIVE.md`. |
| OpenReply web + webhook | Vercel project **`jqp-openreply-1`**, https://jqp-openreply-1.vercel.app | This is the project wired to Meta. `jqp-openreply` is a duplicate copy. |
| **Publish worker** `apps/worker` | **Your own machine only** | See below. |
| OpenReply DM worker | A host you run 24/7. Documented: Oracle Cloud free VM under pm2 (`docs/ORACLE-WORKER.md`). Render alternative: `docs/RENDER-FREE.md`. | A comment can arrive at any hour and the reply must go out inside Meta's messaging window. |
| Database + file storage | Supabase (Mumbai, session pooler) | One project shared by everything. |
| Queue for OpenReply | Upstash Redis | BullMQ queue, rate limiter and the worker heartbeat all live in Redis. |
| Login emails for OpenReply | Resend (or your own SMTP) | OpenReply login is magic-link only. |
| Our own job queue | pg-boss, inside the same Postgres (`pgboss` schema) | No extra service. |

### Why the publish worker is local-only

The pipeline calls `scanPostFolder(post.folder_path)` (`packages/publisher/src/pipeline.ts`), and `folder_path` is a path on the operator's disk such as `D:\jqp\posts\POST_001`. A remote host cannot read it and would fail with ENOENT on the first post. So publishing happens when you start `apps/worker` on the machine that holds the folders. Nothing is lost while it is off: jobs wait in Postgres.

Three consequences to remember:

1. The `sync-campaign-to-openreply` job and the nightly retention purge also run in this worker, so they only run while it is up.
2. Ingesting a folder through the **deployed** dashboard cannot work, because the Vercel function cannot see your disk (this follows from the code path above; it has not been separately tested against production). Ingest from a locally running dashboard (`npm run dev:web`) or with `npm run ingest`.
3. Only the DM worker needs 24/7 hosting.

---

## 3. Prerequisites

- Node 20 or newer (`engines` in `package.json`), npm.
- A Supabase project (Postgres + Storage).
- An Instagram **Business or Creator** account.
- A Meta developer app using the **Instagram API with Instagram Login** product. Step by step in `docs/SETUP.md` and `docs/ADD-ACCOUNT.md`.
- Upstash Redis (free tier) for OpenReply.
- Resend (or SMTP) for OpenReply login emails.
- Vercel account for the two web apps; a 24/7 host for the DM worker.

## 4. Setup, step by step

### 4.1 Clone and install

```bash
npm install
cp .env.example .env
```

Fill in `.env` using the comments in `.env.example`. Never commit it (it is gitignored). Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`ENCRYPTION_KEY` must be exactly 64 hex characters. Back it up outside git: losing it makes stored Instagram tokens unreadable.

```bash
npm run check-env
```

`check-env` validates `.env` against the schema in `packages/core/src/env.ts` and prints a pass/fail table. Note that `META_IG_USER_ID` is required by that schema (see `docs/ADD-ACCOUNT.md`).

### 4.2 Database

Use the **session pooler** connection string for `DATABASE_URL` (see section 9). Then:

```bash
npm run migrate
```

This applies `supabase/migrations/0001` to `0006` in order and records them in `public._migrations_applied`, so re-running is safe. Because local and production use the same Supabase project, running it locally applies it to production. It is deliberately not part of the Vercel build.

### 4.3 Meta app, Upstash, Resend

Follow `docs/SETUP.md` for Supabase, Meta app, Upstash and Resend, and `docs/ADD-ACCOUNT.md` for the exact Meta configuration (scopes, redirect URIs, webhook fields). Put the resulting values in `.env` (`META_*`, `OPENREPLY_*`).

### 4.4 Generate OpenReply's env file

OpenReply needs its own `vendor/openreply/.env`. It is generated, never hand-edited:

```bash
npm run sync-openreply-env
```

Re-run it whenever you change an `OPENREPLY_*` or shared `META_*` value.

### 4.5 Try it locally with the mock Meta server

Proves the pipeline without touching real Instagram (set `MOCK_META=true`). Full walkthrough in `docs/LOCAL.md`.

```bash
npm run mock-meta        # terminal 1: fake Graph API on :8787
npm run dev:worker       # terminal 2: publish worker
npm run dev:web          # terminal 3: dashboard on :3000
```

Log in with `DASHBOARD_SHARED_SECRET`, ingest `posts/POST_001`, and press Publish.

### 4.6 Run OpenReply locally (optional)

```bash
cd vendor/openreply
npm run db:generate
npm run db:migrate
npm run dev -- -p 3100
npx tsx --env-file=.env worker/dm-worker.ts
```

The last command needs `--env-file=.env`: plain `npm run worker` does not load `.env` on its own (`docs/LOCAL.md` Stage 2). Meta cannot reach `localhost`, so real webhooks need a tunnel (`docs/LOCAL.md` Stage 3).

### 4.7 Connect the Instagram account

Two separate connections exist today. Both must be done (details and caveats in `docs/ADD-ACCOUNT.md`):

1. **OpenReply**: sign in to OpenReply, Settings, Connect Instagram. Required before any campaign can sync; the bridge looks up OpenReply's `InstagramAccount` row.
2. **Publishing token**: currently comes from the bootstrap env vars `META_IG_USER_ID` and `META_LONG_LIVED_ACCESS_TOKEN`. The dashboard's Settings, Connect Instagram button stores an encrypted token in `ig_accounts`, but no code sets `posts.ig_account_id`, so the publish pipeline falls back to the env token (`resolveAccountForPost` in `packages/publisher/src/repository.ts`).

---

## 5. Daily operation

### 5.1 Add a post folder

One folder per post, named for the campaign (the folder name becomes `campaign_id`):

```
posts/POST_003/
  1.jpg
  2.jpg
  3.jpg
  caption.md
```

Rules enforced by `packages/publisher/src/scanner.ts` and `validator.ts`:

- Images are `N.jpg`, `N.jpeg` or `N.png`, optionally followed by `-` or `_` and a description (`01-macro-lip.jpg`). Order is by the leading number, numerically.
- 1 image becomes a single-image post; 2 to 10 become a carousel. More than 10 is rejected.
- `caption.md` is required and must not be empty.
- Aspect ratio between 0.79 and 1.92; each encoded image at most 8 MB. PNGs are converted to JPEG.
- Any other file in the folder is rejected.

Optional AI caption pre-step (off unless `AI_ENABLED=true`, needs Bedrock settings):

```bash
npm run generate-caption -- "D:\jqp\posts\POST_003" "a short brief"
```

Register the folder (either way creates a `DISCOVERED` post; repeating it is a no-op):

```bash
npm run ingest -- "D:\jqp\posts\POST_003"
```

or use the Ingest form on the Posts page of a **locally running** dashboard.

### 5.2 Publish

1. Start the local worker: `npm run dev:worker` (or `npm run build:worker` then `npm run start --workspace apps/worker`).
2. In the dashboard (local or https://jqp-web-tau.vercel.app), open Posts and press **Publish** on a `DISCOVERED` post. The web app only enqueues the job; your local worker does the work.
3. Status walks `VALIDATING, UPLOADING, CREATING_CHILDREN, WAITING_FOR_CHILDREN, CREATING_CAROUSEL, WAITING_FOR_CAROUSEL, PUBLISHING, PUBLISHED` (see the post detail page). If the worker is killed mid-run it resumes from the last saved status.
4. Failed posts show a **Retry** button; failures are never retried automatically.

### 5.3 Configure a comment-to-DM campaign

1. Open Campaigns (being renamed Automations in the navigation; the URL is `/campaigns`).
2. Pick the post, set trigger keywords (comma separated; empty means match any word), match mode, the DM message, optional public reply, and optionally the two-step **opening DM + button** flow (recommended, see `docs/COMPLIANCE.md`). Enable it.
3. Once the post is `PUBLISHED` and the campaign is enabled, a `sync-campaign-to-openreply` job is queued. It runs **in the local worker**. Status shows `DM_SYNC_PENDING`, `DM_SYNCING`, then `DM_SYNCED` (or `DM_SYNC_FAILED` with the error).
4. Test from a *different* Instagram account (OpenReply ignores your own comments) that has a role on the Meta app while it is in development mode.

### 5.4 Dashboard pages

| Route | Sidebar label today | Purpose |
|---|---|---|
| `/` | Overview / Home | Morning cockpit: what needs attention, recent posts, recent DMs, active campaigns |
| `/posts` | Posts | Ingest, publish, retry |
| `/posts/[id]` | (detail) | Status timeline and media for one post |
| `/campaigns` | Campaigns / Automations | Create and toggle comment-to-DM campaigns |
| `/dm-activity` | DM Activity / Activity | DM logs read from OpenReply's tables |
| `/settings` | Settings | Connected accounts, token-expiry banner, link to OpenReply, health link |
| `/login` | | Shared-secret login |
| `/api/health` | | Public liveness check (DB only) |

Labels are being renamed (Home, Posts, Automations, Activity, Settings) on branch `perf-ux-hardening`; the routes are intended to keep working.

---

## 6. Scripts

| Command | What it does |
|---|---|
| `npm run build:packages` | Builds `core`, `meta`, `storage`, `queue`, `publisher` in dependency order (required before web/worker builds) |
| `npm run build` | `build:packages`, then web, then worker |
| `npm run build:web` / `build:worker` | Build one app |
| `npm run build:ai` | Build the optional `@jqp/ai` package (excluded from `build:packages`) |
| `npm run dev:web` | Dashboard dev server on :3000 |
| `npm run dev:worker` | Publish worker with file watching |
| `npm run typecheck` | Typecheck all workspaces |
| `npm test` / `npm run test:watch` | Vitest |
| `npm run lint` | ESLint |
| `npm run check-env` | Validate `.env` |
| `npm run doctor` | Integration check: schema, migrations, Meta token and webhook subscription, OpenReply account, storage, Redis (read-only, prints no secrets) |
| `npm run smoke` | Live test of the deployed site: real login, every page, webhook, security controls |
| `npm run check-redis` | Host, TLS and PING for the DM queue's Redis (never prints the password) |
| `npm run set-redis` / `set-database-url` | Replace a connection string everywhere from your clipboard, after proving it works (`-- --vercel` also updates Vercel) |
| `npm run dm-worker` | Run OpenReply's DM worker on this computer. Sends real DMs; see the warning in `scripts/run-dm-worker.cjs` |
| `npm run rotate-db-password` | Change the database password and update Vercel and local files without printing it (needs a Supabase access token for the one command) |
| `npm run backup` | Local read-only snapshot of every table (git-ignored; contains personal data) |
| `npm run mcp:selftest` | Start the Claude Code server and exercise its tools |
| `npm run migrate` | Apply Supabase migrations (ledgered, re-runnable) |
| `npm run ingest -- "<folder>"` | Register a post folder |
| `npm run generate-caption -- "<folder>" "<brief>"` | AI caption pre-step (needs `AI_ENABLED=true`) |
| `npm run sync-openreply-env` | Generate `vendor/openreply/.env` from root `.env` |
| `npm run mock-meta` | Fake Graph API for offline testing |
| `npm run simulate-webhook -- --media-id ... --account-id ... --comment ...` | Send a correctly signed fake comment webhook to local OpenReply (:3100). Reads the signing secret from `vendor/openreply/.env` |
| `npx tsx --env-file=.env scripts/purge-dry-run.ts` | Show what the retention purge would delete (`--apply` runs it once) |

Package-level: `apps/web` has `vercel-build`; `vendor/openreply` has `db:generate`, `db:migrate`, `worker`, `typecheck`, `test`.

## 7. Tests

```bash
npm run typecheck
npm test
```

Covers scanner/validator (real generated images), the publish state machine (resumability), the OpenReply bridge, the Meta client/webhook/OAuth (including a real-HTTP mock server), crypto and AI caption generation. Nothing in the suite talks to real Meta, Redis or Supabase; real-infrastructure behavior is verified by the live checks in `docs/LIVE.md` and the round trip in `docs/PRODUCTION.md` section 10.

---

## 8. Deployment

Summary (full detail in `docs/DEPLOY.md` and `docs/LIVE.md`):

1. **Migrations** run from your machine: `npm run migrate`.
2. **`jqp-web`** on Vercel: root directory `apps/web`; env vars from `.env.example` except the `MOCK_META*` ones; `APP_BASE_URL` and `META_OAUTH_REDIRECT_URI` set to the real domain; `DATABASE_URL` is the **session pooler** string. The build command is `vercel-build` from `apps/web/package.json`.
3. **`jqp-openreply-1`** on Vercel: root directory `vendor/openreply`; its own env vars (`NEXTAUTH_URL` must be its own domain); its `vercel-build` runs `prisma migrate deploy`.
4. **DM worker** on an always-on host with the same `DATABASE_URL`, `REDIS_URL` and `ENCRYPTION_KEY` as `jqp-openreply-1` (`docs/ORACLE-WORKER.md`).
5. **Publish worker**: not deployed; run locally.
6. **Meta console**: redirect URIs and webhook pointing at the live domains (`docs/ADD-ACCOUNT.md`), app Live, `messaging_postbacks` subscribed and verified by API.

Go-live checklist: `docs/DEPLOY.md` section 6 and `docs/PRODUCTION.md`.

---

## 9. Troubleshooting runbook

**Database unreachable from Vercel** (`P1001: Can't reach database server`, or `/api/health` returns `{"success":false,"db":"error"}` while local dev works). The direct Supabase host `db.<ref>.supabase.co` is IPv6-only and Vercel has no IPv6 egress. Use the **session pooler** on port **5432**: user `postgres.<project-ref>`, host `aws-0-<region>.pooler.supabase.com`. Not the transaction pooler (6543): pg-boss needs session semantics. Update `DATABASE_URL` in both Vercel projects and any worker, then redeploy. (`docs/LIVE.md`)

**OpenReply `/api/health` hangs or times out.** The endpoint pings Redis, reads queue counts and reads the worker heartbeat (which is stored in Redis). The ioredis client is created with `maxRetriesPerRequest: null` (`vendor/openreply/lib/queue/client.ts`, required by BullMQ), which means commands are retried forever rather than failing, so an unreachable Redis makes the request hang instead of returning an error. Check `REDIS_URL` on the Vercel project and the worker (must be the `rediss://` Upstash URL and identical in both) and that the Upstash database is active. Status as of 2026-10-01: owner is verifying Upstash; not fixable in this repo.

**Campaign stuck at `DM_SYNC_PENDING`.** The sync job runs in the local publish worker. Start it (`npm run dev:worker`) and it will process. If it then goes to `DM_SYNC_FAILED`, read the campaign's sync error; the usual cause is that the Instagram account was never connected inside OpenReply (Settings, Connect Instagram) - the bridge needs OpenReply's `InstagramAccount` row.

**Token expiry banner on Settings.** The banner is driven by OpenReply's `InstagramAccount.tokenExpiresAt` (and unresolved token-refresh errors), not by our `ig_accounts`. Act on it: reconnect in OpenReply. OpenReply's refresh cron fails silently, so this banner is the only alert. Note that the publishing token from `META_LONG_LIVED_ACCESS_TOKEN` is a separate credential with its own 60-day life; no code in this repo refreshes it (the `refresh_access_token` helper exists in `packages/meta/src/oauth.ts` but nothing calls it on a schedule - unverified in production). Replace it before it expires.

**Publish jobs sit untouched.** The local worker is not running or points at a different `DATABASE_URL`. Start it and look for `worker_ready` in its logs.

**Post `VALIDATION_FAILED`.** Read the post's error message; it lists the exact rule (unexpected file, missing caption, aspect ratio, size). Fix the folder and press Retry.

**Comments arrive but no DM is sent.** In order: is the DM worker running (OpenReply `/api/health` `checks.worker.healthy`)? Do `REDIS_URL` and `ENCRYPTION_KEY` on the worker match `jqp-openreply-1` exactly? Is the campaign `DM_SYNCED` and enabled? Did a `WebhookEvent` row appear (`docs/PRODUCTION.md` section 8: DMs arriving alone is not proof the webhook works, because OpenReply also polls)?

**Button tapped, nothing happens.** `messaging_postbacks` is not subscribed. Verify with the `subscribed_apps` call in `docs/ADD-ACCOUNT.md`.

**Webhook verification fails in the Meta console.** The verify token in Meta must equal `META_WEBHOOK_VERIFY_TOKEN` (OpenReply reads it as `WEBHOOK_VERIFY_TOKEN`; regenerate with `npm run sync-openreply-env` and redeploy OpenReply).

**OAuth "Insufficient Developer Role" or redirect mismatch.** Add the account as an Instagram tester and accept the invite; register the redirect URIs exactly (`docs/ADD-ACCOUNT.md`).

**Magic-link login never arrives or loops.** `NEXTAUTH_URL` on `jqp-openreply-1` must equal its real domain; check Resend domain verification.

---

## 10. Security notes

- Dashboard auth is one shared secret (`DASHBOARD_SHARED_SECRET`) in an httpOnly cookie holding a signed, expiring token (`v1.<expiry>.<HMAC>`, 7 days), enforced in `apps/web/middleware.ts`. Rotating the secret ends every session. Public paths: `/login`, `/api/auth/login`, `/api/health`; `/api/cron/*` is open to the middleware but each route requires the `MONITOR_TOKEN` bearer token and refuses everything when it is unset. This is a single-operator tool, not multi-user.
- `POST /api/posts` accepts a filesystem path (authenticated only). Do not share the dashboard with anyone you would not give disk read access to.
- Instagram tokens are stored AES-256-GCM encrypted (`ENCRYPTION_KEY`). Never expose `SUPABASE_SERVICE_ROLE_KEY` or `META_APP_SECRET` to a browser; there are no `NEXT_PUBLIC_*` variables.
- Generate fresh production secrets; do not reuse local ones. OpenReply's `ENCRYPTION_KEY` is a different value from ours.
- Supabase public-schema API roles are locked down by `0006_lockdown_public_api_roles.sql`; re-verify with the command in `docs/PRODUCTION.md` section 1.
- Retention: raw webhook payloads 30 days, commenter PII 90 days (`docs/COMPLIANCE.md`). The purge runs daily from `POST /api/cron/purge` (scheduled by `.github/workflows/monitor.yml` once `MONITOR_TOKEN` is configured) and also from the local worker when it is up.
- An independent audit is tracked in `docs/SECURITY-AUDIT.md` when present.
- Never paste `.env` contents into chats or tickets.

## 11. Documentation map

| Doc | Read it for |
|---|---|
| `docs/SETUP.md` | First-time Supabase, Meta app, Upstash, Resend setup |
| `docs/ADD-ACCOUNT.md` | Plugging in an Instagram account (and more later); multi-account limitations |
| `docs/LOCAL.md` | Running everything locally in three stages |
| `docs/DEPLOY.md` | Deploying web apps and workers |
| `docs/LIVE.md` | Actual production URLs, DB string, build gotchas, re-verify commands |
| `docs/PRODUCTION.md` | Production-readiness checklist with verification commands |
| `docs/COMPLIANCE.md` | Meta rules, webhook fields, scopes, retention |
| `docs/DATA-PROTECTION.md` | What personal data is held, Meta data obligations, scale review, open gaps |
| `docs/SECURITY-AUDIT.md` | Independent security audit and what was fixed |
| `docs/RATE-LIMITS.md` | Meta's limits, what the code does when throttled, known gaps |
| `docs/CLAUDE-CONTENT-GUIDE.md` | Instructions for Claude: how to package a post, name files, write human copy, store text safely, verify, and recover |
| `docs/RECOVERY.md` | Backups (`npm run backup`) and manual restore |
| `docs/REMEDIATION-PLAN.md` | What to fix, in order, and what is not worth fixing (merges all four audits) |
| `docs/SYSTEM-AUDIT.md` | Reliability audit: double-post paths, silent failures, single points of failure |
| `docs/AUDIT-2026-10-01.md` | Latest audit summary and the action list, in priority order |
| `docs/REMOTE-ACCESS-PLAN.md` | Plan for operating the system from outside the laptop (not built yet) |
| `docs/MONITORING.md` | The System page, error recording, alerts, scale notes |
| `docs/CLAUDE-CODE.md` | Driving the system from Claude Code (MCP tools, safety, prompts) |
| `docs/MORNING-CHECKLIST.md` | What only the owner can do next, in priority order |
| `docs/ORACLE-WORKER.md` | DM worker on an Oracle free VM |
| `docs/RENDER-FREE.md` | Render free-tier alternative for workers (sleeps; needs a pinger) |
| `docs/TASKS.md` | Historical build log and honest ratings |
| `DESIGN.md` | Dashboard design tokens |
| `instagram_automation_updated_plan-1.md` | Original architecture plan |
