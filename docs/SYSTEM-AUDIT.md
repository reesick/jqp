# System reliability audit

Date: 2026-10-02. Auditor: independent read-only review (did not write this code). Scope: what can break, lose data, double-send, deadlock or fail silently. Pure security is out of scope (see `SECURITY-AUDIT.md`, `SECURITY-AUDIT-2.md`).

Method: code reading plus offline snippets only. Nothing was run against live services, no `.env` was read, so anything that depends on a live value (Vercel env, Redis plan, token issue date) is marked "verify". File:line references are to the tree at commit `1f78fe6`.

Operating assumption for verdicts: one operator, 100 to 200 DMs a day, a few posts a week. "FIX BEFORE SCALE" means worth doing before 500 to 1000 DMs a day, not today.

## Summary

| ID | Title | Likelihood | Impact | Effort | Verdict |
|----|-------|-----------|--------|--------|---------|
| SA-01 | Post can be published twice (publish accepted by Meta but not recorded, then manual Retry) | Low-Med | High | 3 h | FIX NOW |
| SA-02 | `singletonKey` does nothing; no atomic claim of a post or campaign sync | Low | High | 2 h | FIX NOW |
| SA-03 | Disabling a campaign never reaches OpenReply; DMs keep sending | High | High | 2 h | FIX NOW |
| SA-04 | Monitor is probably not running, and has large blind spots | High | High | 0.3 h + 4 h | FIX NOW (enable), FIX BEFORE SCALE (checks) |
| SA-05 | Bridge insert is not atomic; a retry creates a duplicate Automation | Low-Med | Med | 1.5 h | FIX NOW |
| SA-06 | Publishing token is a 60-day env var, no refresh, expiry invisible | High (certain) | Med | 1 h / 4 h | FIX NOW (cheap check) |
| SA-07 | Manual Retry reuses dead containers, so a failed post can never succeed | Med | Med | 1 h | FIX NOW (after SA-01) |
| SA-08 | Job expiry 300 s vs whole pipeline in one job; fake concurrency | Low-Med | Med-High | 1 h | FIX BEFORE SCALE |
| SA-09 | DM worker on a laptop: delay, 72 h catch-up window, startup burst | High | Med | 3 h | FIX BEFORE SCALE |
| SA-10 | Campaign sync enqueue lost if it fails after PUBLISHED | Low | Med | 1 h | FIX BEFORE SCALE |
| SA-11 | Session-pooler connection budget is only held by convention | Med | High | 1 h | FIX BEFORE SCALE |
| SA-12 | Redis down: webhook function hangs; Redis Cloud connection cap | Low-Med | Med | 2 h (vendor) | ACCEPT |
| SA-13 | No CI; deploy docs contradict the build command; migrations by hand | Med | Med | 2 h | FIX BEFORE SCALE |
| SA-14 | Viral burst: rate limiter drops DMs after about 1.5 h, recovery uncertain | Low | Med | 2 h | DEFER (verify first) |
| SA-15 | Backups are manual, on the same laptop | Low | High | 3 h | ACCEPT with a reminder |
| SA-16 | Single alert channel; SMTP failure is silent | Low | Med | 0.5 h | ACCEPT with cheap tweak |
| SA-17 | Message normalizer rewrites some intentional characters | Low | Low | 0 | ACCEPT |

Data-loss / double-post paths: SA-01 (double post), SA-02 and SA-05 (duplicate Automation then duplicate public replies), SA-03 (messages sent that the operator believes are stopped). No path was found that deletes or corrupts rows by itself. DM double-send to one person is bounded by Meta (one private reply per comment).

---

## Details

### SA-01 Post can be published twice

Evidence:
- `packages/publisher/src/pipeline.ts:236-238`: `publishMedia(...)` is called, then `updatePostStatus(PUBLISHED, instagramMediaId)`. Nothing is recorded before the Meta call, and nothing checks whether the container was already published.
- `packages/meta/src/client.ts:81-100`: `graphRequest` retries the same POST inline up to 4 times on network errors and any 5xx (classified as `RateLimitError`, `errors.ts:48`). A `media_publish` whose response was lost, or that returned 5xx after succeeding, is simply re-sent.
- `packages/meta/src/errors.ts:53-55`: Meta's answer to publishing an already-published container is a 4xx, which becomes `NonRetryableError`, so `pipeline.ts:104-110` sets the post to `FAILED` (no `instagram_media_id`) although it is live.
- `repository.ts:105-111` plus `/api/posts/[id]/retry`: the operator sees FAILED, presses Retry, status goes back to DISCOVERED and the pipeline builds new containers and publishes a second copy.

Scenario: the process dies, the laptop sleeps, Supabase blips, or the response is lost between Meta accepting the publish (point of no return) and the DB write at line 238. The job retries or ends FAILED. Followers see a duplicate carousel, and the campaign (keyed on the media id) is never synced to the real post.

Likelihood Low-Med (needs a failure in a window of about 1 s, but the worker is a laptop and Meta 5xx on publish do occur). Impact High (public duplicate; DMs wired to nothing).

Fix:
1. Before calling `publishMedia`, call `getContainerStatus`; if `PUBLISHED`, look up the media id (`/{ig-user}/media?fields=id,caption,timestamp` and match the container or caption) and record it instead of publishing.
2. On a 4xx from `media_publish`, run the same lookup before declaring FAILED.
3. Do not inline-retry `media_publish` on 5xx or network errors (set `maxAttempts: 1` for that call); let the next job attempt run the check in step 1.
4. Write `publish_attempted_at` before the call so a stuck PUBLISHING post is visible in the monitor.

Verdict: FIX NOW. It is the only path that produces a public mistake, and the fix is small.

### SA-02 `singletonKey` does nothing; posts and syncs are not claimed atomically

Evidence:
- `packages/queue/src/jobs.ts:57` creates queues with no `policy`, so they are "standard". In pg-boss 10.4.2 (`node_modules/pg-boss/src/plans.js:336-348`) a `singletonKey` is only enforced by the `short`, `singleton` and `stately` policies, or together with `singletonSeconds`. For a standard queue, `jobs.ts:69` and `jobs.ts:74` (`post:<id>`, `sync:<id>`) are metadata only. The comment at `jobs.ts:65` ("never two jobs in flight") is wrong.
- `/api/posts/[id]/publish/route.ts:11-17` is check-then-act on `status === DISCOVERED`; `pipeline.ts:56-74` reads the row and runs with no compare-and-set (`updatePostStatus` has no `where status = ...`).

Scenario: a double click, or a Retry racing a job that is already running, enqueues two jobs. Today one worker loop runs jobs one at a time, which masks it (the second sees PUBLISHED and returns). It becomes a real double-publish the moment two worker processes exist (the docs describe Oracle and Render workers as alternatives to the laptop, so a stale second copy is plausible) or a job is re-run after expiry (SA-08). The same applies to `sync-campaign`, feeding SA-05.

Fix: create the publish and sync queues with `policy: "stately"` (or `singleton`) so the key is enforced; and make the first step an atomic claim, for example `update posts set status='VALIDATING' where id=$1 and status='DISCOVERED' returning *`, exiting if no row. About 2 h with a test.

Verdict: FIX NOW. Cheap, and removes a whole class of races.

### SA-03 Disabling a campaign never reaches OpenReply

Evidence:
- `apps/web/app/api/campaigns/[id]/route.ts:68-73`: sync is enqueued only `if (updated.enabled)`.
- `apps/web/app/api/campaigns/route.ts:67`: same, `campaign.enabled && post.status === "PUBLISHED"`. The dashboard toggle posts here (`campaign-toggle.tsx`), as does MCP (`apps/mcp/src/index.ts:311`).
- `packages/publisher/src/openreply-bridge.ts:83-86`: even if a sync ran, `if (!campaign.enabled) return;` skips it. `"isActive" = ${campaign.enabled}` (line 137) can therefore only ever write `true`.

Scenario: the operator switches a campaign off (wrong link, wrong copy, post deleted, complaint). Our table says `enabled=false`; the OpenReply Automation stays `isActive=true`, and the DM worker, which reads only `Automation.isActive`, keeps messaging every commenter. This is the one control that must work when something is going wrong.

Caveat: I found no other disable path in code; confirm once on live data by toggling a test campaign and reading `"Automation"."isActive"` (read-only SQL).

Fix: enqueue on every enabled change, and in the bridge, when the campaign is disabled and `openreply_automation_id` is set, run the UPDATE with `isActive=false` instead of returning. Add a test. About 2 h.

Verdict: FIX NOW.

### SA-04 Monitor is probably not running, and has blind spots

Evidence:
- `docs/MORNING-CHECKLIST.md:29`: "the scheduler still needs two GitHub settings" (secret `MONITOR_TOKEN`, variable `MONITOR_URL`). `.github/workflows/monitor.yml:35-40`: without them the job prints a notice and finishes green. So alerts have likely never fired from the cloud.
- No dead-man's switch: if GitHub stops the schedule (cron is best effort; scheduled workflows are disabled after 60 days without repo activity on public repos, as the file itself notes) nothing notices. Nothing records "monitor last ran".
- `system.ts` checks: our DB, OpenReply health (Redis, queue, DM worker heartbeat), DM failure rate, hourly limit, OpenReply token expiry, failed posts. It does not check:
  - the publish worker (no heartbeat, no pg-boss queue depth or failed-job count);
  - posts stuck in a non-terminal status (UPLOADING, CREATING_*, WAITING_*, PUBLISHING) for more than N minutes;
  - campaigns `DM_SYNC_FAILED`, or enabled and PUBLISHED but not `DM_SYNCED` after 15 minutes (SA-03, SA-10);
  - webhook silence (`lastWebhookAt` is computed at `system.ts:219` but never turned into a check);
  - the publish token's expiry (SA-06);
  - DB connection saturation (SA-11) or Redis memory.
- `monitor.yml` uses `curl --fail-with-body` and ignores the JSON body, so `emailed:false` (SMTP failure, missing config) leaves the run green.
- Every laptop sleep makes "DM worker" fail; with 6-hour reminders (`alerts.ts:18`) this teaches the operator to ignore the email.

Fix: (a) set the secret and variable and trigger `workflow_dispatch` once (15 minutes). (b) Add the missing checks above to `system.ts`, each a single SQL count (about 4 h). (c) Add a "monitor last ran" row to `alert_state` and a check that flags it as stale, or use a free external pinger on `/api/health`. (d) Fail the workflow step if the response has `failing.length > 0 && emailed == false`.

Verdict: enabling it is FIX NOW (nothing else in this document will be noticed without it). New checks: FIX BEFORE SCALE, but the stuck-post and sync-failed checks are the most valuable and cheap.

### SA-05 Bridge insert is not atomic; retry creates a duplicate Automation

Evidence: `openreply-bridge.ts:152-173`. `INSERT INTO "Automation"` and the following `updateCampaignSync(... openreplyAutomationId)` are two separate statements with a fresh `randomUUID()` each run. If the second fails (DB blip, process death), the catch (line 174) records `DM_SYNC_FAILED` and rethrows as retryable; the retry sees `openreply_automation_id` still null and inserts a second Automation. Concurrent syncs (SA-02) do the same. There is no unique constraint on `Automation.postId` in our control (vendored schema).

Effect: two active Automations on one post. DMs stay safe (`dm-worker.ts:407-425` skips the second as `SKIPPED_DEDUP`), but the public reply is sent per automation (`dm-worker.ts:361-390`), so each commenter gets duplicate public replies; counts and dashboards double. The orphan is invisible from our side.

Fix: derive the Automation id deterministically (uuid v5 of the campaign id) and `insert ... on conflict ("id") do update`, or wrap insert and ledger update in one `sql.begin`. About 1.5 h.

Also note, accept: the bridge overwrites any edits made directly in OpenReply's UI on each sync, and writes raw column names, so an OpenReply schema change with a new NOT NULL column fails every sync (retried 3 times, ends `DM_SYNC_FAILED`, no alert until SA-04 is done).

Verdict: FIX NOW (cheap; pairs with SA-02).

### SA-06 Publishing token expires silently

Evidence: `repository.ts:200-202` uses `META_LONG_LIVED_ACCESS_TOKEN` (60-day) because nothing sets `posts.ig_account_id`. `refreshLongLivedToken` exists (`packages/meta/src/oauth.ts`) but a repo-wide grep shows no caller; `docs/ADD-ACCOUNT.md:249` confirms it is a TODO. The token monitor (`stats.ts:getTokenHealth`) reads OpenReply's `InstagramAccount.tokenExpiresAt`, which OpenReply's own cron refreshes, so it says "healthy" while the separate publish token ages.

Scenario: about 60 days after the token was generated (date unknown, verify) every publish ends `AuthError` -> post `FAILED` ("Publishing" warn email if SA-04 is on). Nothing is lost, but the operator finds out at the moment they want to post, and rotating requires editing the worker's `.env`.

Fix (cheap, 1 h): record the issue date in `.env` (or call `GET /debug_token`/`/me` from the monitor) and warn at 10 days. Proper (4 h): store the account in `ig_accounts` via the existing OAuth flow, set `ig_account_id` on posts, and add a weekly pg-boss refresh job.

Verdict: FIX NOW for the cheap check, since expiry is certain.

### SA-07 Manual Retry reuses dead containers

Evidence: `resetPostForRetry` (`repository.ts:105-111`) only resets `posts.status`. `post_media.child_container_id`, `container_status` and `public_url` are kept, and `stepCreateChildren` skips rows that already have a container (`pipeline.ts:170`, "resume-safe"). Instagram containers expire after about 24 h, and a container that ended in ERROR stays in ERROR.

Scenario: a post fails with `CONTAINER_ERROR`/`CONTAINER_EXPIRED` (non-retryable), the operator presses Retry, the pipeline re-polls the same dead child container and fails the same way every time. Recovery needs hand-edited SQL.

Fix: on reset, null `child_container_id`, set `container_status` back to pending and clear `carousel_container_id` for non-published posts. Do this only after SA-01 (otherwise a "reset" of an already-live post is a free duplicate).

Verdict: FIX NOW (1 h), ordered after SA-01.

### SA-08 Job expiry 300 s vs. one long job, and no real concurrency

Evidence: `jobs.ts:44-49` queue default `expireInSeconds: 300`; `enqueuePublishPost` (line 69) does not override it. One job runs upload, child containers, up to 30 polls x 2 s per container, carousel container, poll, publish and cleanup (`pipeline.ts:54-115`, `publishing.ts:81`). With `QUEUE_CONCURRENCY=5` pg-boss fetches a batch of up to 5 jobs and `jobs.ts:80-88` runs them in a sequential `for`, all sharing the expiry clock started at fetch. So "concurrency 5" is really 1, and job 3 of a batch can expire before it starts.

Effect: pg-boss marks an expired job failed and schedules a retry while the first handler may still be running, so two pipeline runs overlap (SA-01/SA-02 territory). Rare at one post a day.

Fix: `expireInSeconds: 900` for the publish queue; set `batchSize: 1` (or run the batch with `Promise.all` plus the SA-02 claim). 1 h.

Verdict: FIX BEFORE SCALE.

### SA-09 The DM worker lives on a laptop

Evidence: `scripts/run-dm-worker.cjs:8-9` says so. Webhook receipt is on Vercel, so comments are accepted while the laptop is off and sit in Redis. Consequences:
- DMs are delayed until the laptop wakes. For a "comment to get the link" funnel that is most of the conversion.
- Catch-up is bounded by the poller's lookback: `COMMENT_POLL_LOOKBACK_HOURS` default 72 (`comment-reconciler.ts:41`) while Meta's private-reply window is 7 days. Comments missed by webhook for 72 h to 7 days are neither polled nor answerable later.
- Restart burst: after a long outage every matching comment from the last 72 h is queued at once; the 750/h limiter handles it, but expect a flood and 3 BullMQ attempts with 5/15/45 min backoff (`dm-worker.ts:42`).
- Publish worker and campaign sync run on the same laptop: enabling a campaign while it is off leaves `DM_SYNC_PENDING`, and the UI shows "enabled" (see SA-04 for the missing check).
- Sleep or hibernate drops the Postgres session; `postgres.js` reconnects, pg-boss reconnects on its pool error handler (`boss.ts:22` only logs), but a long-lived laptop process with a half-dead socket is a classic silent stall. The heartbeat TTL of 120 s (`worker-health.ts`) does catch the DM worker side.

Fix: run the DM worker (and publish worker) on the Oracle or Render host that the docs already describe, keep the laptop only for the image folder. 3 h.

Verdict: FIX BEFORE SCALE. At 100 to 200 DMs a day it already costs conversions whenever the laptop sleeps; if you are at the laptop daily it is tolerable.

### SA-10 Sync enqueue lost after PUBLISHED

Evidence: `pipeline.ts:238` sets PUBLISHED, then `:260-263` enqueues the sync. If `getCampaignByPostId` or `enqueueSyncCampaign` throws (DB blip), the error is a plain retryable error, pg-boss retries the job, but `pipeline.ts:63-66` returns immediately for PUBLISHED, so the sync is never enqueued. Result: published post, enabled campaign, `DM_SYNC_PENDING` forever, no alert. Same for the cleanup in the same step (best effort, fine).

Fix: wrap the post-publish tail in its own try/catch that never fails the job, plus the SA-04 check "PUBLISHED + enabled + not DM_SYNCED after 15 min" and a "re-sync" button. 1 h.

Verdict: FIX BEFORE SCALE (the SA-04 check makes this self-healing).

### SA-11 Connection budget

Evidence: session pooler allows about 15 clients in total (`docs/AUDIT-2026-10-01.md:21`). Our ceilings: `DB_POOL_MAX` 5 (`env.ts:24`, `db.ts:17`) plus `BOSS_POOL_MAX` 3 (`boss.ts:19`) per process, so up to 8 per process. Every place that can open them:
- `apps/worker`: db + boss (8 max; pg-boss polls 3 queues continuously).
- `apps/web`: `getDb()` in nearly every route and page; `getBoss()` in publish, retry and campaign routes. Each warm serverless instance can hold 5 + 3. Dashboard fan-out (`system.ts` runs about 8 parallel queries) can use all 5 in one instance. Idle timeout is 20 s (`db.ts:19`), which is the only thing that keeps the steady state low.
- `getBoss()` on Vercel calls `boss.start()` on every cold start, which checks migrations and starts maintenance timers in a short-lived function (wasted connections, and pg-boss maintenance racing with the worker's).
- `apps/mcp`: db 5 + boss 3 per Claude Code process (several windows means several servers).
- scripts: `backup-db` 1, `migrate` 1, `doctor`/`smoke` etc. The unauthenticated `/api/health` runs `select 1` per hit (noted in SECURITY-AUDIT).
- `vendor/openreply`: `new PrismaPg(databaseUrl)` with no pool size (default 10 per instance), now on the transaction pooler (6543) via `sync-openreply-env.ts:57` and `set-database-url.ts`. Fine as long as nobody re-points it at 5432 by hand.

These are ceilings, not steady state, but 2 web instances + worker + one MCP + a script reaches 15 without anything unusual. The failure mode is exactly the earlier outage (EMAXCONNSESSION -> 503 everywhere, including the monitor).

Fix: on Vercel set `DB_POOL_MAX=2` and `BOSS_POOL_MAX=1` (verify current values, I could not read them); use `boss.start()` only in the worker (use `new PgBoss({ ... }).send` with `noScheduling/supervise:false` in web); add `connection count` to the monitor via `select count(*) from pg_stat_activity`. 1 h.

Verdict: FIX BEFORE SCALE (verify Vercel values now; it is a one-line env change).

### SA-12 Redis down

Evidence: `vendor/openreply/lib/queue/client.ts:18` uses `maxRetriesPerRequest: null`, so a command against an unreachable Redis waits forever. In the webhook (`app/api/webhook/route.ts`) the order is: `webhookEvent.create` (DB) then `queue.add` per event. With Redis down, `queue.add` hangs until the function is killed (no `maxDuration` is set on this route), Meta sees a timeout and retries later, and the WebhookEvent row stays `PENDING`. The system monitor already detects an unreachable OpenReply as "no answer after 6 s" (`system.ts:98-104`).
Net effect: DMs delayed, not lost, provided the poller (laptop) runs after Redis returns and within the 72 h lookback. Our own publishing does not use Redis at all.

Other Redis notes: DM worker heartbeat is a Redis key (`worker-health.ts`), so a Redis outage also reads as "worker down" (acceptable). Completed jobs are capped (1000) and failed jobs expire in 300 s (`client.ts:74-82`), so no unbounded Redis growth. Each serverless instance opens its own ioredis connection (client plus rate limiter); on a small Redis Cloud plan the connection cap (verify, often 30) is the limit to watch.

Verdict: ACCEPT (vendored code; the remedy is a command timeout, which means editing vendor). Revisit with the plan's connection cap.

### SA-13 Deployment and change risk

- No CI: `.github/workflows` contains only `monitor.yml`. `CLAUDE.md` asks for build, typecheck and tests before pushing, but nothing enforces it; Vercel only runs `next build`. A push to `main` deploys both Vercel projects from the same repo, so a bad commit changes the dashboard and the webhook receiver together.
- Docs disagree: `docs/LIVE.md:70-89` says OpenReply's build command no longer runs `prisma migrate deploy` (it hung 45 minutes through the transaction pooler), yet line 89 says "Future OpenReply migrations apply cleanly on deploy", and `docs/DEPLOY.md:59` still says the build runs it. With the current build command a vendor update that adds a Prisma migration deploys code that expects a column that does not exist, until someone runs `npx prisma migrate deploy` against 5432 by hand. Our own `supabase/migrations` are also manual; there is no schema-version check at startup (only `system_events`/`alert_state` degrade gracefully).
- Vendor drift: the bridge writes raw SQL into `"Automation"`; a `vendor/openreply` update can break it silently (see SA-05).
- Scripts that mutate production: `set-env.ts`, `set-redis.ts`, `set-database-url.ts` write local `.env` files and Vercel production. Good: `set-database-url` connects and queries first, rejects the direct host and port 6543 for our session URL, and converts to 6543 for OpenReply. Gaps: they do not reach the DM worker host (they say so), and redeploys are manual, so drift between Vercel, the laptop and the worker host is likely over time. No dry-run was seen in `set-env`.

Env variables that must match across places (names from `sync-openreply-env.ts`, `.env.example`, docs; values not inspected):

| Variable | Must match | Differs by design |
|----------|-----------|-------------------|
| `META_APP_ID`/`META_APP_SECRET` (OpenReply: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`) | jqp-web, jqp-openreply-1, DM worker | no |
| `META_WEBHOOK_VERIFY_TOKEN` = OpenReply `WEBHOOK_VERIFY_TOKEN` | Meta app config, jqp-openreply-1 | no |
| `OPENREPLY_ENCRYPTION_KEY` = OpenReply `ENCRYPTION_KEY` | jqp-openreply-1 and DM worker (decrypts IG tokens; a mismatch makes every DM fail with "Failed to decrypt") | differs from our `ENCRYPTION_KEY` |
| `OPENREPLY_REDIS_URL` = OpenReply `REDIS_URL` | jqp-openreply-1, DM worker, jqp-web (health) | no |
| `DATABASE_URL` | same database everywhere | port: 5432 (session) for jqp-web, worker, MCP, scripts; 6543 (transaction) for jqp-openreply-1 and the DM worker |
| `MONITOR_TOKEN` | jqp-web and GitHub secret | no |
| `OPENREPLY_DASHBOARD_URL` (jqp-web) | URL of jqp-openreply-1 | default is localhost, so a missing value shows OpenReply as down |
| `ENCRYPTION_KEY`, `DASHBOARD_SHARED_SECRET`, `BRIDGE_SHARED_SECRET` | jqp-web, worker, MCP | OpenReply has its own |
| `META_LONG_LIVED_ACCESS_TOKEN`, `META_IG_USER_ID` | worker host only (publishing) | not on Vercel |
| `NEXTAUTH_URL` | n/a | localhost on the laptop worker, public URL on Vercel |
| `CRON_SECRET` (OpenReply) | jqp-openreply-1 | compliance audit notes it falls back to `NEXTAUTH_SECRET` if unset |

Test coverage on the riskiest paths: there are tests for the pipeline (10 cases), the bridge (11), alerts (3), the Meta client, validators and webhooks. There are none for `retention.ts`, `system.ts`, `repository.ts` (campaign upsert), the queue (`jobs.ts`), or the API routes. I did not see a test for "DB write fails after `publishMedia`" (SA-01), "duplicate sync" (SA-05), "disable propagates" (SA-03) or pg-boss singleton behaviour (SA-02), which is why four real defects survived.

Fix: add a GitHub Actions workflow (build:packages, typecheck, vitest, build:web) on push and PR; correct DEPLOY.md/LIVE.md; add a `doctor` check listing pending OpenReply migrations. 2 h.

Verdict: FIX BEFORE SCALE (CI itself is worth doing now at 1 h).

### SA-14 Viral burst

Evidence: Meta's cap and the limiter are both 750 private replies per hour (`rate-limiter.ts:18-19`). Over the cap the job is requeued 3 times at 30-minute intervals, then `SKIPPED_RATE_LIMIT` permanently (`rate-limiter.ts:21`, `dm-worker.ts:446-461`). A post that draws more than about 1100 matching comments in 90 minutes loses the remainder. Whether the poller later re-queues them is uncertain: BullMQ ignores `add` for an existing job id, and the deterministic id `comment_<acct>_<id>` stays reserved while the job is among the last 1000 completed. Also DM latency would be minutes to hours regardless.

At 1000 DMs a day on average this needs a spike; at 100 to 200 it needs a viral post. Verdict: DEFER; verify the poller behaviour with a small test before the first big campaign.

### SA-15 Backups

`scripts/backup-db.ts` is manual, writes to `backups/` on the laptop (git-ignored, 7 kept), and covers `public` only (pg-boss is intentionally skipped). The Supabase plan has no automatic backups (`docs/RECOVERY.md`). Losing the project loses posts, campaigns, DM history and encrypted tokens. Most of it is re-creatable (campaigns and tokens by hand), DM history is not. Verdict: ACCEPT with a weekly calendar reminder; a scheduled copy to cloud storage would also put PII outside the laptop, which has its own cost.

### SA-16 Alert channel

One path: SMTP (Brevo) or Resend. `sendAlertEmail` never throws and reports `sent:false` upward (`alerts.ts:43-91`), but only the HTTP response of `/api/cron/monitor` carries that, and the workflow ignores it. A failed email does keep retrying: `last_notified_at` only moves when email succeeds (`alerts.ts:199`), so the next run re-sends (good). Recovery emails are not retried because the state flips to ok. A second channel (for example a free push service) is not worth building yet. Fix: the workflow tweak in SA-04(d). Verdict: ACCEPT.

### SA-17 Message normalizer

`normalizeMessageText` runs on every campaign write (`repository.ts:277-280`), including the toggle, which resends all fields. I ran it offline on typical copy: it is idempotent (second pass returns the same text), keeps URLs and `{placeholders}`, and cannot throw on stored text because stored text already passed the 5000 limit. It does rewrite intentional characters: `_STOP_` becomes `STOP`, a leading `+ ` or `- ` becomes a bullet, a leading `# ` is removed, ` -- ` becomes an en dash. Stored messages are not previewed after the change. Verdict: ACCEPT; show the normalized text to the operator on save if it ever surprises you.

---

## Single points of failure (plan step 1)

| Failure | What happens | Covered by |
|---------|--------------|-----------|
| Laptop off or asleep | Publish worker stops (jobs wait in pg-boss, nothing lost); DM worker stops (comments accepted by Vercel, queued in Redis, DMs delayed; poller catches up only 72 h back); campaign enable/sync waits; MCP unavailable | DM worker heartbeat alert only; see SA-04, SA-09 |
| Redis down | No new DMs can be queued; webhook function hangs; publishing unaffected | OpenReply health in monitor; SA-12 |
| Supabase down or paused | Everything stops: dashboard data, webhook (`webhookEvent.create` first), both workers, publishing. Cookie login survives (HMAC). Meta retries webhooks for a limited time | DB check and a throttled "database unreachable" email (`alerts.ts:93-143`), if the monitor runs |
| Pooler exhaustion | 503 everywhere, as happened | SA-11 |
| Vercel build or deploy failure | Previous deployment keeps serving; OpenReply build hang was fixed by dropping `migrate deploy`, which created SA-13's migration gap | none automatic |
| Meta outage | Publish retries 4 times inline then pg-boss retries up to 8 times over about 4 h (`jobs.ts:69`), then FAILED (manual Retry); DM sends retry 3 times (5/15/45 min) | warn on failed posts; DM failure-rate check |
| Meta token expiry | Publish token: SA-06. DM token: refreshed by OpenReply cron daily, surfaced by `getTokenHealth` | partial |
| SMTP down | Alerts silently not delivered | SA-16 |
| GitHub Actions dead or unconfigured | No monitor, no cloud purge (the worker also schedules the purge at 04:00 UTC, so retention still runs if the worker is up) | SA-04 |

## Verified OK

- Resume logic of the pipeline: every step re-reads state, skips completed child containers and uploads, and PUBLISHED returns immediately (`pipeline.ts:54-115`). Only the publish step itself is unsafe (SA-01).
- Ingestion is idempotent (`on conflict (campaign_id) do nothing`, `repository.ts:36-47`).
- Error classification: auth and 4xx are terminal, 429/5xx/network are retried, long throttles are handed back to the queue instead of sleeping (`client.ts:89-94`). 80002 added to the retryable set.
- Retention purge (`retention.ts`): each statement is a single atomic UPDATE or DELETE with explicit cutoffs from validated integers, keeps rows and `commenterId` (the dedup key), guards on table existence, and has a dry-run script. It cannot touch posts, campaigns, or DmLog rows younger than 90 days. It is not one transaction, but each step is idempotent so a partial run is harmless. `returning 1` loads one row per affected row into memory: fine at this size.
- `recordEvent` never throws, has a 4 s timeout and tolerates a missing table; `apiError` always returns a response even when the DB is down (`events.ts:73-94`, `api-error.ts`).
- Alert state machine: alerts on transitions, reminds every 6 h, retries unsent emails, and handles a missing `alert_state` table and a dead database without spamming (`alerts.ts`).
- DM double-send to one person is bounded by Meta (one private reply per comment) and by OpenReply's `automationId_commentId` unique key and `SKIPPED_DEDUP` logic. A crash after Meta accepts but before `status = SENT` is recorded produces a misleading FAILED log, not a second DM.
- Time zones: `byDay` converts naive UTC timestamps correctly to Asia/Kolkata (`system.ts`, Prisma `timestamp` columns); retention and token math use epoch milliseconds. Comparisons of naive `createdAt` to `now()` rely on the pooler session being UTC (Supabase default).
- Redis growth is bounded (1000 completed, failed expire in 5 minutes). `system_events` is pruned daily (90 days). pg-boss archives on its own schedule. Not bounded: `ProcessedComment` and `DmLog` rows (small, about 70k rows a year at 200 a day) and orphan storage objects from posts that failed before publishing.
- Redis commands: idle BullMQ plus a 30 s heartbeat is negligible; at 1000 DMs a day the volume is far below any plan limit (verify the connection cap, SA-12).
- Vercel durations: the only explicit limits are monitor 30 s, purge 60 s; `monitor` does 1 outbound call (6 s timeout) plus about 8 queries and SMTP with 8 to 12 s timeouts, so it fits.
- `set-database-url.ts` validates the string against the real database before writing anything and keeps session/transaction ports straight.

## Scale notes (500 to 1000 DMs/day)

- DB: Postgres load is trivial; the constraint is connection slots (SA-11), not throughput. Dashboard `count(*)` over `DmLog` and `WebhookEvent` (`stats.ts`, `system.ts`) is fine to about 100k rows; index `DmLog(createdAt)` if pages slow down.
- Redis: fine. BullMQ worker concurrency is 5 (`dm-worker.ts:1245`), each send is one Graph call, so about 5 to 10 DMs a second is available, far above 1000 a day.
- Meta: 750 private replies an hour is the ceiling (SA-14). Polling uses one media-list call plus one comments call per post per automation every 5 minutes; with tens of live posts that is hundreds of calls an hour against the app's quota (the usage observer in `apps/worker/src/index.ts:35-43` only reports publishing-side usage).
- pg-boss: `QUEUE_CONCURRENCY` is ineffective (SA-08), irrelevant at a few posts a day.
- Vercel: the webhook route sets no `maxDuration` and does sequential DB and Redis calls per event; Meta wants a fast 200. Verify the OpenReply function region matches the database and Redis regions (`apps/web/vercel.json` pins jqp-web to `bom1`; the OpenReply project's setting was not visible to me).

## Steps completed

1. Single points of failure: done (table above, SA-04, SA-06, SA-09, SA-11, SA-12, SA-16). Pool openers checked: `core/db.ts`, `queue/boss.ts`, web routes, worker, MCP, scripts, vendored Prisma. Token refresh confirmed absent by grep. Not verifiable offline: live Vercel/Redis/Supabase settings.
2. Data integrity: done (pipeline, publish idempotency, pg-boss singleton semantics read from the installed pg-boss 10.4.2 source, bridge, retention, `recordEvent`/`apiError`, normalizer run offline on sample copy).
3. Operational blind spots: done (monitor workflow and checks, alert dedupe, growth, time zones).
4. Deployment and change risk: done at code and docs level; Vercel dashboard settings, Vercel env values and the DM worker host's env were not inspected (secrets), so the env table lists what must match, not whether it does.
5. Scale limits: done at reasoning level; no load was generated.
