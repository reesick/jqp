# Data protection and Meta platform compliance review

Reviewer: independent review, 2026-10-01. Read-only review of the repo (including `vendor/openreply`, read only). No `.env` files were read and no live database or Meta account was queried, so anything that depends on live state is marked **unverified**.

This is a technical review, not legal advice. The DPDP Act and GDPR sections are general information only.

Target load: about 500 comment-triggered DMs/day now, about 1000/day soon, one Instagram account, multi-account later.

---

## 1. Data inventory

Who can read: `anon` and `authenticated` Supabase roles are locked out of every `public` table by `supabase/migrations/0006_lockdown_public_api_roles.sql:38-47` (revoke all, enable and force RLS, zero policies), and default privileges are revoked for future Prisma tables (`:65-67`). `0002_rls.sql:18-35` does the same for our 7 tables. Both apps connect as the `postgres` superuser (0006:27-28), so in practice the readers are: anyone holding `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, or the Supabase dashboard login. There is no least-privilege application role.

| Store (table.column) | What | Purpose | Encryption at rest in app code | Retention actually enforced | Notes |
|---|---|---|---|---|---|
| `DmLog.commenterId` | Instagram-scoped id (pseudonymous, still personal data) | Dedup, opening-DM read tracking (`webhook/route.ts:200-213` queries by `commenterId`) | None | **Never deleted or nulled** (`retention.ts:78-80` keeps it on purpose) | No index on `commenterId` (`schema.prisma:249-253`): erasure by id is a seq scan |
| `DmLog.commenterName` | Commenter display name | Personalise DM, dashboard | None | Nulled after `PII_RETENTION_DAYS` (default 90) `retention.ts:81-86` | Only if the job runs (see below) |
| `DmLog.commentText` | Free text written by a third party | Keyword match, dashboard | None | Set to `''` after 90 days, **but only for rows where `commenterName is not null`** (`retention.ts:84`). Rows with a null name keep their comment text forever | Bug, see gap G2 |
| `DmLog.errorMessage`, `publicReplyError` | Meta error strings | Debugging | None | Not purged | Strings can contain ids; low risk |
| `WebhookEvent.payload` (json) | Full raw Meta webhook incl. commenter id, username, comment text (`webhook/route.ts:61-69`) | Debug | None | Deleted after `RAW_PAYLOAD_RETENTION_DAYS` (30) `retention.ts:61-69` | Written for **every** webhook, matching or not |
| `OperationalEvent.payload` | On bad signature stores `bodyPreview` = first 200 chars of the unauthenticated body (`webhook/route.ts:48-53`); worker failures store ids | Ops | None | **Not covered by retention** | Attacker-controlled content can be stored; first 200 chars of a forged or malformed payload |
| `ProcessedComment` (`commentId`, account) | Every comment id seen | Dedup set | None | **Not covered** | Grows with total comment volume, not DM volume |
| `LinkClick.ipHash`, `userAgent`, `referrer` | Click tracking of DM links | Analytics | Hash only for IP (hash scheme not audited) | **Not covered** | Personal data of end users |
| `InstagramAccount.accessToken` (OpenReply) | IG token | Send DMs | AES-256-GCM, `iv|tag|ciphertext` base64 (`vendor/openreply/lib/meta/oauth.ts:121-134`), key `ENCRYPTION_KEY` | Deleted on Disconnect (`api/instagram/disconnect/route.ts:26`); `tokenExpiresAt` | Key shared across web and worker hosts |
| `ig_accounts.access_token_encrypted/_iv/_tag` (ours) | IG token | Publishing | AES-256-GCM (`packages/core/src/crypto.ts:16-38`), hex key from `ENCRYPTION_KEY` | Until row deleted | No key versioning or rotation path in code |
| env `META_LONG_LIVED_ACCESS_TOKEN` | Bootstrap token | Bootstrap | **Plaintext in env** (Vercel, local `.env`) | Until rotated | Also `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DASHBOARD_SHARED_SECRET` |
| OpenReply `User.email`, `Session.sessionToken`, `VerificationToken.token`, `Account.access_token/refresh_token/id_token` | Operator identity (NextAuth) | Login | Not encrypted (session and verification tokens stored raw) | Sessions expire; not purged | Operator data only |
| `WorkspaceInvitation.email` | Invitee email | Invites | None | Not purged | Operator data |
| `webhook_events.payload`, `comment_events.commenter_*`, `dm_logs` (ours, `0001_init.sql:246-316`) | Same content as the OpenReply tables | Planned own pipeline | None | Covered by retention (`retention.ts:91-116`) | Code search found no writer outside `retention.ts`, so these tables appear unused; drop them or keep as is (they are still covered) |
| Redis (Upstash) BullMQ jobs | Job data includes `commentText`, `commenterName`, `commenterId` (`webhook/route.ts:83-95`) | Queue | TLS in transit only | `removeOnComplete: {count: 1000}` keeps the last 1000 completed jobs **with payload, no age limit**; `removeOnFail: {age:300,count:2000}` (`lib/queue/client.ts:83-90`) | A third store of commenter personal data, with no retention clock |
| `system_events`, `alert_state` (ours, 0008) | Technical events | Alerts | None | `SYSTEM_EVENT_RETENTION_DAYS` 90, pruned in `events.ts:117` | Designed to hold no personal data: scrub in `events.ts:33-60` drops keys matching name/text/email/token/url/payload etc. Good pattern |
| Supabase Storage bucket | Post images | Publishing | None | Never cleaned (`docs/TASKS.md:72`) | Not personal data of third parties |
| Vercel and host logs | See logging below | Ops | n/a | Platform default | |

### Retention: does it cover OpenReply and does it run?

- Code covers `"DmLog"` and `"WebhookEvent"` by name (`retention.ts:61`, `:71`), guarded by `to_regclass` (`:31-35`). **Yes it reaches OpenReply's two main tables.** It does not cover `OperationalEvent`, `ProcessedComment`, `LinkClick`, `Session`, `VerificationToken`, invitations, or Redis.
- It is scheduled as a pg-boss job in `apps/worker/src/index.ts:41-44`. `docs/LIVE.md:27-32` states `apps/worker` is **local only, run on demand**. So the purge runs only while the operator's machine has the worker up. On any day it does not run, nothing is deleted. There is no evidence in the repo that it has run against production (**unverified**; check `system_events` for code `retention` rows or worker logs).
- Index support for the purge: `DmLog` has no `createdAt` index in Prisma (`schema.prisma:249-253`). Migration `0008_system_events.sql:47-58` adds `idx_dmlog_created_at`, `idx_dmlog_status_created`, `idx_webhookevent_created_at`. `0008` is **untracked in git and not shown as applied** (git status: `?? supabase/migrations/0008_system_events.sql`). Applied state is **unverified**.
- Anonymising in place (`update`) rewrites rows; at 365k rows/year it is fine, but batch it (see P1).

### Logging leakage

- `packages/core/src/logger.ts:25-45,72`: key-name redaction for token/secret/password/authorization/cookie/session etc. It redacts by **key name only**, not by value, and does not redact `commenterName`, `commentText`, `username`, `email`. No call site found logging those in our packages (grep of `apps`: names appear only in rendered pages). Low current risk, no structural guard for personal keys. Suggest adding `comment`, `commenter`, `username`, `email`, `payload`, `body` to the redact list, as `events.ts:30` already does for the DB log.
- OpenReply uses raw `console.*` (no redaction): `lib/queue/dm-worker.ts:169,381,601,766,854,923,1232,1258,1277`. They log `formatError(error)` (Meta error code and message), job id, and attempt count. Meta error messages can echo request fragments but no code path logs `commentText` or a token directly (**not exhaustively proven**; errors from `fetch` could include URLs).
- Token in URL: OpenReply's Meta client passes `access_token` as a **query string** on several calls (`lib/meta/client.ts:432,462,525,542,557,576,598,630,683`) while others use `Authorization: Bearer`. Query-string tokens end up in any proxy, CDN, or error logging that records URLs. Prefer the header form everywhere (vendored; needs an upstream patch or accept risk).
- Webhook signature failure path stores `bodyPreview` (`webhook/route.ts:52`) in the database, see inventory.
- Our `packages/publisher/src/events.ts` scrubs URLs, bearer tokens, and 32+ char opaque strings before writing to Postgres. Good.

---

## 2. Meta obligations

### Verified from official pages (fetched 2026-10-01 via WebFetch, which returns a model-generated extract of the page; wording below is from that extract, not a raw copy)

Source: Meta Platform Terms, https://developers.facebook.com/terms/

- Data security, s.6.a.i: maintain "administrative, physical, and technical safeguards" that "meet or exceed industry standards given the sensitivity of the Platform Data".
- Deletion, s.3.d.i.1: "Update or delete Platform Data promptly after receiving a request from us or the User to do so and give Users an easily accessible and clearly marked way to ask for their Platform Data to be modified or deleted."
- Deletion, s.3.d.i.2.d: delete when a user requests it or "no longer has an account with you", unless aggregated or de-identified so it cannot be associated with a particular user, browser or device.
- Breach notification, s.6.b.i: notify Meta via Meta's form "as soon as practicable but no later than required under applicable laws and regulations". A Meta developer blog post (https://developers.facebook.com/blog/post/2020/07/01/platform-terms-developer-policies/, search snippet only) adds that developers must begin remediation immediately and cooperate with Meta.
- Service providers, s.5.a: you are responsible for your service providers and their sub-providers (Vercel, Supabase, Upstash, hosting) complying as if they were you.
- Data use limits, s.3.a: no surveillance, sale, discriminatory use, profile building without consent, or use outside what the docs allow. Comment text and commenter ids must be used only to run the requested automation.
- Data deletion mechanism: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/ says you must specify **either** a data deletion request callback URL **or** a data deletion instructions URL. The callback receives a `signed_request` (HMAC-SHA256 with the app secret, contains `user_id`) and must return JSON `{ url, confirmation_code }`. The page says non-compliance may lead to the callback being removed or the app being disabled. The instructions-URL option is therefore acceptable to Meta for the dashboard setting, but the Platform Terms duty to delete promptly on request still applies either way.
- Deauthorization callback: search snippet for https://developers.facebook.com/docs/instagram-platform/create-an-instagram-app/ says the Deauthorization callback URL and Data deletion request URL are added in Business login settings. **Exact payload and whether it is mandatory for Instagram Login apps: could not verify from the page text returned.**
- Messaging window: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/ : app has 24 hours to respond to a message from a user; human agent tag allows sending outside the window; automated chat "must disclose that a person is interacting with an automated service" at the start of a conversation, after a significant lapse, or when moving from human to automated (extra attention for California and Germany). Permissions: `instagram_business_basic`, `instagram_business_manage_messages`.
- Private replies: https://developers.facebook.com/docs/instagram-platform/private-replies/ : send within 7 days of the comment, **one message per comment**, follow-ups only if the recipient responds and within 24 hours of the response, Live comments only during the broadcast.
- Rate limit: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ : "750 calls per hour per Instagram professional account for private replies to comments on Instagram posts and reels".
- Data Use Checkup: https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/data-use-checkup (via search summary): annual; required for apps live **with Advanced Access or a use case**; not required for apps with **Standard Access only**; not required in Development mode but required before switching to Live. Requires certifying Platform Terms compliance, answering data handling questions and supplying testing instructions.
- Business Verification: https://developers.facebook.com/docs/development/release/business-verification : required for Advanced Access and for apps that let other businesses connect; "If your app will only be used by app users who have a role on the app itself you do not need to complete verification."

### Could not verify (treat as open)

- Opt-out requirement for Instagram DMs: the messaging page extract did not cover opt-out. No official text obtained. Good practice and likely expected during App Review, but unconfirmed.
- Whether a deauthorization callback is mandatory for this app type, and its payload for Instagram Login.
- Exact breach-notification form URL and any fixed hour deadline (Terms point to "applicable law").
- Whether the owner's current app is Live with Advanced Access (then Business Verification and annual Data Use Checkup apply) or Standard Access with role users only (then they do not). `docs/COMPLIANCE.md:102` says Advanced Access for `comments` is being requested, which would make both apply.
- Current Meta Developer Policy wording beyond the Platform Terms page (not fetched separately).

### App status against these obligations

| Obligation | Status | Evidence |
|---|---|---|
| User-facing deletion mechanism | **Partial.** `/data-deletion` in OpenReply is an **informational page only**: it says disconnect in Settings, or email support to delete data (`vendor/openreply/app/data-deletion/page.tsx:17-35`). No support email is named on the page; the privacy page says "contact the repository owner through GitHub or the support email configured" (`privacy/page.tsx:66`) | Acceptable as an "instructions URL" only if a real process stands behind it. See below |
| Request path that deletes one commenter's rows | **Does not exist.** Grep for `deauth`, `signed_request`, `deletion` found no handler in `vendor/openreply` or `apps/web`. The only deletion is Disconnect (`disconnect/route.ts:26`), which deletes the `InstagramAccount`; `DmLog` has `onDelete: Cascade` from `InstagramAccount` (`schema.prisma:247`), so that wipes all logs for the account, not one person | Gap G1 |
| Deauthorize handling | **None.** When an IG user removes the app, nothing deletes the token or data | Gap G4 |
| Data security safeguards | Partial: token encryption at rest, RLS lockdown, webhook HMAC (`webhook/route.ts:39`), timing-safe compare. Weak: plaintext bootstrap token in env, superuser DB role, no key rotation, shared-secret operator login | |
| Retention limited to need | Partial: policy exists; enforcement depends on local worker; gaps G2, G3 | |
| Breach notification | No runbook in repo before this document | See section 4 |
| Automated disclosure | Template default says "This is an automated reply" (`apps/web/app/components/campaign-form.tsx:35`) but it is a default the operator can edit; not enforced | P1 |
| 24h window and 7 day reply window | Handled by Meta API errors; worker logs "messaging window closed" (`dm-worker.ts:854`); not audited further | |
| One private reply per comment | Enforced by `SKIPPED_DEDUP` logic (`dm-worker.ts:423`) | |
| Opt-out | Not implemented in vendored code (no stop/unsubscribe handling found in `dm-worker.ts`) | P1; unverified Meta requirement |

---

## 3. Scale review (500-1000 DMs/day and bursts)

### Meta rate ceiling
- 750 private replies/hour/account (verified, above). 1000 DMs/day averages about 42/hour, so the ceiling only matters for bursts (a viral reel: hundreds of comments in minutes). Limiter is a fixed Redis window (`lib/utils/rate-limiter.ts:19-20,47-58`): a burst straddling the window edge can exceed 750 in a rolling hour. On block it requeues 30 minutes, up to 3 times, then `SKIPPED_RATE_LIMIT` and **the comment is never answered** (`rate-limiter.ts:20-21,74`). A 750+ burst within the 7-day reply window is lost rather than deferred. Recommend a lower cap (e.g. 600) for headroom, and a replay step for `SKIPPED_RATE_LIMIT` rows younger than 7 days.
- Worker concurrency 5 (`dm-worker.ts:1245`).

### Upstash Redis
- Official limits (https://upstash.com/docs/redis/overall/pricing, WebFetch extract, 2026-10-01): Free = 500K commands/month, 256 MB, 10 GB bandwidth, 1 database. Pay as you go = $0.2 per 100K commands, first 1 GB storage free. Fixed 250 MB = $10/month.
- Upstash's BullMQ page (https://upstash.com/docs/redis/integrations/bullmq) states BullMQ "accesses Redis regularly, even when there is no queue activity" and recommends **Fixed plans** for BullMQ to avoid high cost.
- Repo-derived command sources (my estimate, **not measured**; measure with the Upstash console command graph): heartbeat `SET` every 30 s = 2,880/day (`worker/dm-worker.ts:9,31`; `lib/ops/worker-health.ts`); BullMQ blocking poll, stalled-job checks and lock renewals run continuously even when idle; reconciler every 5 min (`dm-worker.ts:16-20` worker file) plus the per-DM cost (add, move to active, lock, complete, rate-limiter Lua, events), roughly 15-30 commands/job. Idle BullMQ alone plausibly costs 20-50K commands/day. That is about 0.6-1.5M/month idle, which **already exceeds the free 500K/month**. At 1000 DMs/day add about 30K/day. Expect roughly 1.5-3M commands/month: about $3-6/month pay-as-you-go, or $10 fixed. The free tier is not viable for this volume; budget for a paid plan. Note the current live `/api/health` hang (`docs/LIVE.md:16-19`) may itself be a quota or paused-database symptom: check the Upstash console first (**unverified**).
- Storage: job payloads are small; 1000 retained completed jobs is well under 256 MB.

### Postgres
- `DmLog` indexes in Prisma: `workspaceId`, `automationId`, `instagramAccountId`, `status`, unique `(automationId, commentId)` (`schema.prisma:249-253`). Missing for dashboard queries in `packages/publisher/src/stats.ts`: `order by "createdAt" desc limit N` (`stats.ts:91-96,157-168`), `group by status` with `dmSentAt` filter (`:70-73`), and `count(*)` (`:170-171`). `0008` adds `(createdAt desc)` and `(status, createdAt desc)` (0008:51-52). **Applied state unverified.** With 365k rows a seq scan for `group by status` and `count(*)` is still under a second, but it runs on every dashboard load; `OFFSET` pagination (`:151-168`) degrades with depth. `dmSentAt` has no index; fine at this size.
- Suggested extra indexes: `DmLog ("commenterId")` (erasure, read-fallback lookup `webhook/route.ts:200`), `OperationalEvent` already indexed, `ProcessedComment` is unique on `commentId`.
- Row growth: DmLog rows are anonymised, never deleted. 500/day = 182,500 rows/year; 1000/day = 365,000/year (about 0.5 KB/row plus 5 indexes, roughly 0.3-0.6 GB/year at 1000/day, my estimate). `WebhookEvent` holds one row per webhook delivery (every comment on the account, not just matching ones; JSON ~1 KB) for 30 days only if the purge runs: at 1000 webhooks/day about 30K rows steady state, but **unbounded if the purge does not run**. `ProcessedComment` grows with all comments, forever. Check the Supabase plan's disk limit (**unverified**; the free plan's database size cap is small).
- Connections: our `postgres.js` pool max 5 (`env.ts:24`, `db.ts:17`), one web and one worker process. OpenReply uses `PrismaPg(databaseUrl)` with **no explicit pool size** (`vendor/openreply/lib/db/client.ts:14-15`), so node-pg default (10 per instance) applies and each Vercel serverless instance and the DM worker opens its own pool. Supabase's serverless guidance (https://supabase.com/docs/guides/database/connecting-to-postgres): "A few dozen instances is enough to exhaust the pool" with default pool sizes; set pool to 1 per serverless instance. Exact session-mode pool limits for this project's compute size **could not be verified** (page did not give numbers). Session mode is required for pg-boss (`docs/LIVE.md:54-56`); the OpenReply web app on Vercel could use the transaction pooler (port 6543 with `pgbouncer`/no prepared statements) but this is not configurable without touching vendor code other than via `DATABASE_URL` — verify compatibility before changing.

### Single points of failure
1. DM worker host: one always-on process does queueing, sending and the 5-minute poll (`worker/dm-worker.ts`). If it dies, comments queue up; the reconciler (`COMMENT_POLL_INTERVAL_MS`) catches up only when the worker is back, and only within the 7-day private-reply window. Alert on heartbeat absence (heartbeat key TTL 120 s, `worker-health.ts:3-5`).
2. Redis: queue, rate limiter and heartbeat all depend on it. Down = no DMs, and `maxRetriesPerRequest: null` makes requests hang instead of fail (`docs/LIVE.md:16-19`). Webhook POST hangs or 500s while `WebhookEvent` row is written first (`webhook/route.ts:61`), then `queue.add` fails and the event is marked FAILED; Meta retries deliveries, but for a bounded time.
3. Meta token expiry: long-lived IG tokens need refresh; OpenReply's cron logs an error and returns 200 (`docs/COMPLIANCE.md` known limitations); surfaced by `getTokenHealth()` (`stats.ts:115-145`). Only visible if someone opens Settings; needs push alert.
4. Local publish worker also carries the retention purge (see section 1).
5. One operator secret (`DASHBOARD_SHARED_SECRET`) and one `postgres` credential.
6. `ENCRYPTION_KEY` loss = all tokens unreadable (`vendor/openreply/docs/setup.md:339`); back it up in a password manager.

---

## 4. Gaps and recommendations

| # | Pri | Gap | Concrete change | File | Effort |
|---|---|---|---|---|---|
| G1 | P0 | No way to erase one commenter; `/data-deletion` is informational and names no contact | Adopt the erasure procedure below as a script; state a real contact and SLA on the page or (preferably) in `apps/web` hosted privacy and deletion pages you control; register that URL as the data deletion instructions URL | new `scripts/erase-commenter.ts`; `vendor/openreply/app/data-deletion/page.tsx` is vendored, so host your own page in `apps/web` | 0.5-1 day |
| G2 | P0 | Retention bug: rows with null `commenterName` keep `commentText` | Change predicate to `where "createdAt" < cutoff and ("commenterName" is not null or "commentText" <> '')` | `packages/publisher/src/retention.ts:74,84,94,100` (and `comment_events` equivalent) | 30 min + test |
| G3 | P0 | Purge runs only when the local worker runs; nothing proves it ran | Run the purge from something always on: a Vercel cron route in `apps/web` calling `purgeExpiredData()` (daily), or GitHub Actions scheduled job, authenticated with a cron secret. Record `system_events` code `retention` with counts and alert if none in 48 h | `apps/web/app/api/cron/purge/route.ts`, `vercel.json`, `packages/publisher/src/alerts.ts` | 0.5 day |
| G4 | P0 | No deauthorize/delete callback; Meta-initiated removal leaves token and data | Implement `POST /api/meta/deauthorize` and `/api/meta/data-deletion` in `apps/web` (verify `signed_request` HMAC-SHA256 with app secret, delete tokens and the user's rows, return `{url, confirmation_code}`); configure in Meta app. Needs a host for the Meta callback that shares the DB | `apps/web/app/api/meta/*` | 1 day. Confirm payload against Meta docs before building (could not verify) |
| G5 | P0 | Redis job payloads hold commenter name and text with no age limit | Cannot change vendored options; set Upstash database eviction/TTL policy, and periodically `DEL`/flush completed jobs via `bullmq` `queue.clean(ageMs, limit, 'completed')` in an ops script | `scripts/clean-queue.ts` | 0.25 day |
| G6 | P0 | Free Upstash tier will be exhausted; outages break DMs silently | Move to Upstash pay-as-you-go or Fixed 250 MB ($10); set budget alert; check free quota status now | Upstash console | 15 min |
| G7 | P1 | Retention does not cover `OperationalEvent`, `ProcessedComment`, `LinkClick`, `Session`, `VerificationToken` | Add deletes: OperationalEvent older than 90 d, ProcessedComment older than 60 d (only needs to outlast the 7-day reply window plus polling horizon), LinkClick older than 180 d (or null userAgent/referrer) | `retention.ts` | 0.5 day |
| G8 | P1 | `bodyPreview` of unauthenticated requests stored in DB | Store length and a boolean only | vendored `webhook/route.ts:52`; note in vendor patch list or front with a proxy | patch upstream |
| G9 | P1 | Apply and verify migration 0008 (indexes plus system_events); commit it | Run `supabase db push` or the SQL; `\d "DmLog"` to confirm indexes | `supabase/migrations/0008_system_events.sql` | 15 min |
| G10 | P1 | Add index for erasure and read-fallback | `create index concurrently idx_dmlog_commenter on "DmLog"("commenterId")` | new migration 0009 | 15 min |
| G11 | P1 | Logger lacks personal-key redaction | Add `comment`, `commenter`, `username`, `email`, `payload`, `body` to `REDACT_KEY_PATTERNS` | `packages/core/src/logger.ts:25-38` | 15 min |
| G12 | P1 | Rate-limit burst loses comments | Lower cap to about 600; add a replay job for `SKIPPED_RATE_LIMIT` within 7 days | vendored `rate-limiter.ts` (upstream patch) plus a replay script | 0.5-1 day |
| G13 | P1 | Opt-out and automated disclosure not enforced | Keep "automated" wording mandatory in templates and add a "reply STOP" line; honour it (needs vendor change or pre-filter) | campaign form, vendored worker | 0.5-1 day |
| G14 | P1 | Token-expiry and worker-down alerts only visible in dashboard | Push alerts (email) on heartbeat missing more than 5 min, token under 14 days, purge not run 48 h, Redis ping failing | `packages/publisher/src/alerts.ts` | 0.5 day |
| G15 | P1 | Privacy text gives no retention periods, controller or contact | Publish an accurate policy: what (commenter id, name, comment text), why, 30/90 day periods, subprocessors (Vercel, Supabase, Upstash, host, Resend), contact | hosted page in `apps/web` | 0.5 day |
| G16 | P2 | Superuser DB role used everywhere | Create an app role with `BYPASSRLS`, least privilege; keep service role out of workers (0006:30-33 warns of the landmine) | DB, env | 0.5 day |
| G17 | P2 | No encryption key rotation or versioning | Add key id prefix to ciphertext and a re-encrypt script; store `ENCRYPTION_KEY` backup | `packages/core/src/crypto.ts` | 1 day |
| G18 | P2 | Plaintext bootstrap token in env | Move to `ig_accounts` (encrypted) and remove `META_LONG_LIVED_ACCESS_TOKEN` | `packages/core/src/bootstrap.ts` | 0.5 day |
| G19 | P2 | Tokens in URL query string (vendored client) | Upstream patch to Bearer header everywhere | `vendor/openreply/lib/meta/client.ts` | 0.5 day |
| G20 | P2 | Shared-secret operator login; OpenReply NextAuth magic link | Acceptable for one operator; add MFA-capable auth when multi-user | apps/web | 1-2 days |
| G21 | P2 | Consider pseudonymising `commenterId` (HMAC with secret) in our own reporting copies | Only if you add your own tables; OpenReply needs raw ids to send | n/a | n/a |

### Non-compliant or at-risk today
- No real per-person deletion path and a deletion page that only describes email handling with no contact named (G1). This conflicts with the Platform Terms duty to give users "an easily accessible and clearly marked way" to request deletion.
- Retention policy (90/30 days) is advertised in docs and `.env.example` but is not reliably enforced (local-only worker, null-name bug, Redis payloads, uncovered tables).
- No deauthorization handling (G4).
- Whether this app is out of compliance with Data Use Checkup or Business Verification depends on its access level (unverified).

### Right-to-erasure procedure (keyed by commenter id)

Inputs: the Instagram-scoped commenter id (from the requester's DM thread, or found by username lookup in `DmLog`/`WebhookEvent` payload). Verify the requester controls that Instagram account (they can DM or comment from it, or send from the account email listed in their Instagram profile) before deleting. Record the request and completion date in a private ledger (request id, date, result counts) without the id.

Run as a transaction after a dry run (replace `:cid`):

```sql
begin;
-- 1. OpenReply
delete from "DmLog"         where "commenterId" = :cid;
delete from "WebhookEvent"  where payload::text like '%' || :cid || '%';   -- slow seq scan, acceptable for a rare request
-- ProcessedComment holds only comment ids; delete those linked via DmLog before step 1:
--   delete from "ProcessedComment" where "commentId" in (select "commentId" from "DmLog" where "commenterId" = :cid);
-- 2. Ours (if used)
delete from comment_events  where commenter_ig_id = :cid;   -- dm_logs cascade via comment_event_id
delete from webhook_events  where payload::text like '%' || :cid || '%';
commit;
```

Notes: take `ProcessedComment` ids first (the delete from `DmLog` removes the lookup). `LinkClick` stores only a hashed IP, not the commenter id, so it cannot be tied to a person; leave it. Then purge Redis: `queue.getJobs(['completed','failed','delayed','waiting'])` and remove jobs where `data.commenterId === cid` (BullMQ API). Backups: Supabase backups retain data until they roll off; state this period in the policy. Add a `system_events` row with code `erasure_done` and counts only, no id. Target completion within 30 days (GDPR) and promptly per Meta Terms.

Data-loss caution: deleting `DmLog` rows also removes the dedup record, so the same person could receive another DM if they comment again on an old comment id. Keep the `(automationId, commentId)` marker in `ProcessedComment` for the 7-day reply window.

### Incident-response checklist

If an Instagram token leaks:
1. Revoke: have the account owner remove the app in Instagram Settings, Apps and websites (invalidates the token), or reconnect through OAuth to mint a new one; update `InstagramAccount`/`ig_accounts`.
2. Rotate `META_APP_SECRET`/app secret in the Meta app dashboard if the webhook or app secret may also be exposed; update Vercel and worker envs; redeploy; re-verify webhook signature.
3. Check Graph API activity and Instagram "Login activity" for unauthorized sends; check `DmLog` for messages you did not expect.

If `DATABASE_URL`, service role key or `ENCRYPTION_KEY` leaks:
1. Reset the Postgres password in Supabase (Database settings), rotate service role and anon keys (JWT secret rotation), update Vercel, worker and OpenReply envs; redeploy all four Vercel projects (two are duplicates, see LIVE.md) and restart workers.
2. If `ENCRYPTION_KEY` leaked together with DB access, treat all stored IG tokens as compromised: revoke all and reconnect, then set a new key.
3. Rotate `DASHBOARD_SHARED_SECRET`, `NEXTAUTH_SECRET` (invalidates sessions), `CRON_SECRET`, `WEBHOOK_VERIFY_TOKEN`, `REDIS_URL` password.
4. Review Supabase logs and `pg_stat_activity` for unknown connections; export evidence before changing.
5. Decide if personal data of commenters was accessed. If yes: notify Meta using its breach notification form "as soon as practicable but no later than required under applicable laws" (Platform Terms s.6.b.i), and notify regulators and affected people per applicable law (see below). Keep a timeline.
6. Post-incident: update this document, add detection that would have caught it.

### Monitoring that supports compliance (record without personal data)

Use `system_events` (opaque ids, counters only):
- `retention` run: rows deleted/anonymised per table, duration; alert if no run in 48 h.
- `erasure_done`: request counter and counts, never the id.
- Token: days to expiry, refresh success or failure, per account opaque id.
- Webhook: signature failures count per hour, payload size anomalies, processing failures (status counts).
- Rate limit: hourly DM count per account, `SKIPPED_RATE_LIMIT` count, 429 counts from Meta.
- Queue: waiting, active and failed depth, oldest waiting job age, worker heartbeat age.
- Redis: command count per day (Upstash console) against budget; ping latency.
- DB: connection count versus pool limit, table sizes for `DmLog`, `WebhookEvent`, `ProcessedComment`.
- Auth: failed operator logins per hour, secret rotation dates.
- Deployment: migration applied versions.
Never record: commenter ids, names, usernames, comment text, tokens, raw payloads.

### General information on India DPDP Act and GDPR (not legal advice)

- Roles: the account owner decides why and how commenters' data is used, so they would usually be the controller (GDPR) / data fiduciary (DPDP); hosting and database vendors are processors / data processors. Whether a one-account personal or business operation falls under either law depends on facts (business vs household activity, targeting EU or Indian residents). Take qualified advice.
- Both laws broadly expect: a clear purpose, data minimisation, a stated retention period, security safeguards, a way for people to access and erase their data, a named contact, and breach reporting (GDPR: to the authority generally within 72 hours of becoming aware where risk exists; DPDP: to the Board and affected persons, with timelines set by rules). Verify current DPDP Rules timelines, which were phased in and may have changed.
- Cross-border transfer: data sits in Supabase Mumbai, Vercel, Upstash and the worker host in whatever regions they are set to. Record regions in the privacy notice. Upstash region is **unverified**.
- Consent versus legitimate purpose: commenters wrote a public comment that triggers a message they implicitly invited; still tell them in the DM that it is automated and how to opt out.
- Children's data: Instagram users may be minors; DPDP has stricter rules for children. Nothing in the app checks age.

---

## Appendix: what this review did not do
- Did not query the live database (applied migrations, row counts, index presence, grants) or Redis (command usage, region).
- Did not read `.env`, Vercel settings, Meta app dashboard, or Upstash console.
- Meta pages were read through WebFetch extracts and search summaries, not raw text; quoted phrases should be re-read on the source pages before any App Review submission.
