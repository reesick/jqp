# Deploying the workers on Render's free plan

Blueprints (deploying from `render.yaml`) are a paid feature, so create both services by hand. `render.yaml` still documents the same settings.

## What changes on the free plan

Render's free plan offers **web services**, not always-on **background workers**. So both processes are deployed as web services, which means each must bind `$PORT`:

- **`apps/worker`** already ran a health server, and now prefers `$PORT` when Render sets it. Nothing else needed.
- **OpenReply's `dm-worker`** is a pure BullMQ consumer that binds nothing, so its start command runs a tiny inline HTTP server alongside it. No vendored code is modified.

**Free web services sleep after ~15 minutes without inbound HTTP.** A sleeping worker processes nothing, so both need an external pinger (below).

Nothing is *lost* while asleep — publish jobs sit in Postgres (pg-boss), DM jobs sit in Redis (BullMQ), and both drain once the service wakes. The cost is latency, not data.

---

## Service 1 — jqp-worker (publishing)

Render → **New → Web Service** → connect `reesick/jqp`

| Setting | Value |
|---|---|
| Name | `jqp-worker` |
| Language | **Docker** |
| Dockerfile Path | `apps/worker/Dockerfile` |
| Docker Build Context | `.` (repo root) |
| Instance Type | **Free** |
| Health Check Path | `/` |

Docker is required here because `sharp` ships native binaries that must match the runtime platform.

**Environment variables** — same values as the `jqp-web` Vercel project:

```
NODE_ENV=production
APP_BASE_URL=https://jqp-web-tau.vercel.app
DASHBOARD_SHARED_SECRET=<same as Vercel>
SUPABASE_URL=<same as Vercel>
SUPABASE_SERVICE_ROLE_KEY=<same as Vercel>
DATABASE_URL=<the session pooler string — see docs/LIVE.md>
SUPABASE_STORAGE_BUCKET=instagram-media
META_APP_ID=<same as Vercel>
META_APP_SECRET=<same as Vercel>
META_GRAPH_VERSION=v26.0
META_API_BASE=https://graph.instagram.com
META_IG_USER_ID=<same as Vercel>
META_LONG_LIVED_ACCESS_TOKEN=<same as Vercel>
META_OAUTH_REDIRECT_URI=https://jqp-web-tau.vercel.app/api/meta/oauth/callback
META_WEBHOOK_VERIFY_TOKEN=<same as Vercel>
ENCRYPTION_KEY=<same as Vercel — must match, or stored tokens can't be decrypted>
BRIDGE_SHARED_SECRET=<same as Vercel>
OPENREPLY_DASHBOARD_URL=https://jqp-openreply-1.vercel.app
QUEUE_CONCURRENCY=5
MOCK_META=false
RAW_PAYLOAD_RETENTION_DAYS=30
PII_RETENTION_DAYS=90
```

Do **not** set `WORKER_HEALTH_PORT` — Render injects `PORT`, and the worker prefers it.

**Verify:** logs show `health_server_listening`, `purge_schedule_registered`, `worker_ready`, and the service URL returns `{"status":"ok"}`.

---

## Service 2 — openreply-worker (DM sending)

Render → **New → Web Service** → same repo

| Setting | Value |
|---|---|
| Name | `openreply-worker` |
| Root Directory | `vendor/openreply` |
| Language | **Node** |
| Build Command | `npm install && npm run db:generate` |
| Instance Type | **Free** |
| Health Check Path | `/` |

**Start Command** — paste exactly:

```
node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(process.env.PORT||10000)" & npm run worker
```

**Environment variables** — same values as the `jqp-openreply` Vercel project:

```
NODE_ENV=production
DATABASE_URL=<session pooler string>
REDIS_URL=<Upstash — must be identical to Vercel's, or the worker watches a different queue>
ENCRYPTION_KEY=<same as jqp-openreply Vercel — different from jqp-worker's>
NEXTAUTH_SECRET=<same as jqp-openreply Vercel>
CRON_SECRET=<same as jqp-openreply Vercel>
INSTAGRAM_APP_ID=<same>
INSTAGRAM_APP_SECRET=<same>
FACEBOOK_APP_SECRET=<same>
META_GRAPH_API_VERSION=v26.0
WEBHOOK_VERIFY_TOKEN=<same>
RESEND_API_KEY=<same>
EMAIL_FROM=<same>
```

`REDIS_URL` and `ENCRYPTION_KEY` are the two that silently break things if they drift: a different Redis means the worker never sees the jobs Vercel enqueues, and a different encryption key means it can't decrypt the stored Instagram token.

**Verify:** `https://jqp-openreply-1.vercel.app/api/health` flips `worker.healthy` to `true` and the endpoint returns 200 instead of 503.

---

## Keep-alive pinger (required)

Without this both services sleep and stop working within 15 minutes.

- Sign up at [cron-job.org](https://cron-job.org) (free, no card)
- Create two jobs, each every **10 minutes**:
  - `https://jqp-worker-<suffix>.onrender.com/`
  - `https://openreply-worker-<suffix>.onrender.com/`
- Take the URLs from each Render service's page

[UptimeRobot](https://uptimerobot.com) works equally well (5-minute interval on free).

---

## Health signals, and one blind spot

| Check | Meaning |
|---|---|
| `jqp-worker` URL → `{"status":"ok"}` | Publishing worker alive and queues attached |
| OpenReply `/api/health` → `worker.healthy: true` | DM worker is actually sending |
| Render logs → `purge_completed` daily | Retention job running |

**Blind spot:** for `openreply-worker`, the inline HTTP server keeps `$PORT` bound even if the BullMQ worker crashes — so a green Render health check there means "container alive", not "DMs sending". The authoritative signal is OpenReply's own `worker.healthy`, which is driven by a heartbeat the worker writes. Trust that one.

---

## If free-tier latency becomes a problem

Cold starts take ~50 seconds, so a DM can arrive a minute or more after the comment. If that stops being acceptable:

- **$7/mo** per Render background worker removes sleeping entirely
- **Oracle Cloud free tier** is genuinely always-on and free (OpenReply's own docs recommend it for this exact worker) — 4 ARM cores / 24GB RAM, at the cost of manual Linux setup
