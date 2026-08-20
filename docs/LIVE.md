# Live deployment reference

The actual production URLs and settings for this project, and how to re-verify them. Written after the first successful deploy on 2026-08-21.

## Deployed services

| Service | URL | Platform | Root dir | Status |
|---|---|---|---|---|
| jqp dashboard | https://jqp-web-89h2-wheat.vercel.app | Vercel | `apps/web` | live |
| OpenReply | https://jqp-openreply-1.vercel.app | Vercel | `vendor/openreply` | live |
| jqp publish worker | — | Render | `apps/worker` | **not deployed** |
| OpenReply DM worker | — | Render | `vendor/openreply` | **not deployed** |

Until the two workers exist: the dashboard queues publish jobs that nothing processes, and matched comments never get a DM.

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
- `APP_BASE_URL` = `https://jqp-web-89h2-wheat.vercel.app`
- `META_OAUTH_REDIRECT_URI` = `https://jqp-web-89h2-wheat.vercel.app/api/meta/oauth/callback`
- `OPENREPLY_DASHBOARD_URL` = `https://jqp-openreply-1.vercel.app`

**jqp-openreply**
- `NEXTAUTH_URL` = `https://jqp-openreply-1.vercel.app` — magic-link login silently breaks if this is wrong, since Auth.js builds every login URL from it

## Meta configuration

- Webhook callback: `https://jqp-openreply-1.vercel.app/api/webhook`
- OAuth redirect: `https://jqp-web-89h2-wheat.vercel.app/api/meta/oauth/callback`
- Subscribed fields: `comments`, `messages`, `messaging_postbacks`
- `messaging_seen` deliberately NOT subscribed — see `docs/COMPLIANCE.md`

## Prisma baseline (one-time, already done)

OpenReply's 18 migrations were originally applied as raw SQL, so Prisma had no `_prisma_migrations` table and `migrate deploy` failed the build with **P3005** ("schema is not empty"). Baselined with:

```bash
cd vendor/openreply
for m in $(ls prisma/migrations | grep -v migration_lock); do npx prisma migrate resolve --applied "$m"; done
```

`prisma migrate deploy` now reports "No pending migrations to apply." Future OpenReply migrations apply cleanly on deploy. Do not repeat this unless the tracking table is lost.

## Re-verify everything

```bash
cd /d/jqp && TOKEN=$(grep "^WEBHOOK_VERIFY_TOKEN=" vendor/openreply/.env | cut -d= -f2) && echo "--- jqp-web ---" && curl -s https://jqp-web-89h2-wheat.vercel.app/api/health && echo && echo "--- openreply webhook ---" && curl -s -w " HTTP:%{http_code}\n" "https://jqp-openreply-1.vercel.app/api/webhook?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=OK" && echo "--- openreply health ---" && curl -s https://jqp-openreply-1.vercel.app/api/health
```

Expected:
- jqp-web → `{"success":true,"db":"ok",...}`
- webhook → `OK HTTP:200`
- OpenReply → `database: ok`, `redis: ok`, `queue: ok`. `worker.healthy` stays `false` until the Render worker is deployed — that alone makes the endpoint return 503, which is correct, not a fault.

## Build gotchas already solved

Recorded so they aren't rediscovered:

- **Route files may only export handlers.** `export const OAUTH_STATE_COOKIE` from a `route.ts` passes `next dev` and typecheck, then fails `next build` with "not assignable to type 'never'". Shared constants live in `app/api/_lib/`.
- **`dist/` is gitignored**, so a fresh clone has no compiled `@jqp/*`. `npm run build --workspaces` runs alphabetically, not topologically, and per-package `prepare` scripts fail the same way. Hence `build:packages` at the root with the order spelled out.
- **Vercel scopes its install** to the target workspace's dependency closure, so `@jqp/ai`'s AWS SDK isn't present. `@jqp/ai` is excluded from `build:packages`; nothing deployed imports it.
- **Test files were being compiled** into `dist/`, which coupled the build to `vitest` (a root-only devDependency absent in Vercel's build). All package tsconfigs now exclude `*.test.ts`.
