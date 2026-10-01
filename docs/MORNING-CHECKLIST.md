# Where things stand, and what is left

> Read `docs/AUDIT-2026-10-01.md` first: it has the latest audit results and a prioritised action list. Database connections now go through the transaction pooler for OpenReply (port 6543) after an outage on 2026-10-01; do not point OpenReply back at port 5432.

Updated 2026-10-01 after the production fixes. `npm run doctor` (inside view) and `npm run smoke` (live site) verify everything below.

## Fixed and verified

| Item | State |
|---|---|
| Dashboard on Vercel (`jqp-web-tau`) | Healthy, database connected, new password applied |
| Supabase password | Changed on both Vercel projects and in both local `.env` files; redeployed |
| Redis (DM queue) | New Redis Cloud database; OpenReply reports database, Redis and queue **ok** |
| Meta token and app | Valid for @anveya.d; webhook subscribed to `comments` and `messaging_postbacks` |
| Instagram account inside OpenReply | Connected (@anveya.d); 2 campaigns synced to 2 active automations |
| Security, monitoring, Claude Code server, docs | Shipped (see `docs/SECURITY-AUDIT.md`, `docs/MONITORING.md`, `docs/CLAUDE-CODE.md`) |
| Rate limits | Throttle handling shipped (`docs/RATE-LIMITS.md`) |

## Blocking: DMs are received but nothing sends them

**No DM worker is running.** OpenReply's health shows `worker: healthy: false`. Comments will be accepted and queued in Redis, and they wait there. Pick one:

- **Quick test, this computer only:** `npm run dm-worker`. Works only while the computer is on. **It sends real DMs**, and it also polls Meta every 5 minutes looking back 72 hours, so it will message anyone who commented a trigger word on a post with an active automation in the last 3 days and has not been messaged. To limit that on first start, add `COMMENT_POLL_LOOKBACK_HOURS=1` to `vendor/openreply/.env` first.
- **Always on:** follow `docs/ORACLE-WORKER.md` (free Oracle VM) or `docs/RENDER-FREE.md`. Give it the same `REDIS_URL` and `DATABASE_URL` that are now in `vendor/openreply/.env`. Check `npm run smoke`: the line "DM worker heartbeat" turns green when it works.

## Do next

1. **Apply migration `0008`** in the Supabase SQL editor (`supabase/migrations/0008_system_events.sql`). Adds the error log, alert state and DM-log indexes. The code works without it, but the System page has no history and alerts stay off until it is applied.
2. **Finish alerts:** email (Brevo SMTP) and `MONITOR_TOKEN` are configured locally and on Vercel `jqp-web`. The scheduler still needs two GitHub settings: repo → Settings → Secrets and variables → Actions → secret `MONITOR_TOKEN` (run `npm run set-env -- --clipboard MONITOR_TOKEN`, then paste) and variable `MONITOR_URL` = `https://jqp-web-tau.vercel.app`. Then Actions → monitor → Run workflow. This also runs data retention from the cloud.
3. **Security:** set a dedicated random `CRON_SECRET` on `jqp-openreply-1`. Rotate the Supabase database password again at the end, because it was shared in a chat during setup (`npm run set-database-url -- --vercel`, then redeploy and update the DM worker). Same for the Redis password (`npm run set-redis -- --vercel`).
4. **Redis connection is not encrypted** (`redis://`). The queue carries DM job data. Look for a TLS option in the Redis Cloud console, or move to a plan or provider with TLS. Also set the eviction policy to `noeviction` there (BullMQ needs it).
5. **Retire the duplicate Vercel projects** `jqp-web-89h2` and `jqp-openreply` once nothing points at them.

## Known gaps (decided or too large for now)

From `docs/DATA-PROTECTION.md` and `docs/RATE-LIMITS.md`:
- No per-person data-erasure path (Meta's terms expect one).
- A very large burst could leave comments unanswered (OpenReply's limiter).
- Publishing uses one token from an env var that nothing refreshes every 60 days; multi-account needs the pipeline to read `ig_accounts`.
- No post scheduler.
- Two `sharp` advisories remain (fix is a breaking upgrade in the publish path); no CSP header yet.
