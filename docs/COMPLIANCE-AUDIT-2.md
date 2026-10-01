# Compliance and operational audit, round 2

Auditor: independent reviewer, 2026-10-01. Read-only: the only file written is this one. No `.env` file was read, no live service was called (no database, Redis, Meta account or Vercel queried; no npm script that touches live services was run). Anything that depends on live state is marked **unverified**. General information, not legal advice.

Steps completed: 1 (gap status), 2 (Meta compliance), 3 (burst safety, patch outline not applied), 4 (operational readiness), 5 (this document).

Evidence tags: file:line refers to the repo at HEAD `239e207`. "Summary" means the Meta page was read through WebFetch, which returns a model-written extract, not raw text. Re-read the source page before quoting it to Meta.

---

## (a) Verdict

The system is technically careful for a one-person build (token encryption, webhook HMAC, RLS lockdown, scrubbed event log, cloud-triggered purge route), but it is **not yet in a state I would call compliant or safe to leave unattended at 500 to 1000 DMs/day**. Three things matter most. First, the safety nets exist in code but are switched off: the GitHub workflow that runs both the health monitor and the cloud retention purge is inert until a secret and a variable are set, so today nothing outside the owner's laptop is scheduled, no alert email can fire, and the DM worker itself runs on that laptop. Second, there is still no way for a commenter to have their data erased, and the deletion page names no contact and is written for SaaS customers. Third, the live copy and burst behaviour carry real spam-report and account-flag risk: the first live campaign sends a direct DM without an automation disclosure, public replies are one identical string, there is no opt-out, and the vendored sender fires public replies ungated and up to 750 DMs in about 4 to 8 minutes. None of these is hard to fix, and most fixes are copy, configuration, or code outside `vendor/openreply`.

---

## (b) Gap status (from `docs/DATA-PROTECTION.md` section 4)

Status: **fixed**, **partly**, **open**. Live-state checks are unverified.

| # | Gap | Status | Evidence |
|---|---|---|---|
| G1 | No per-commenter erasure; deletion page names no contact | **Open** | No `erase`/`deletion` handler or script anywhere (`scripts/` has no erase tool; grep for `signed_request`, `deauth`, `erase` hits only docs and the vendored static page). `vendor/openreply/app/data-deletion/page.tsx:17-35` unchanged: tells *customers* to email support "from the email address used to sign in", names no address. `privacy/page.tsx` unchanged. A commenter has no usable path. The SQL recipe in DATA-PROTECTION.md remains the only procedure and it is manual |
| G2 | Null-name rows keep `commentText` | **Fixed** | `packages/publisher/src/retention.ts:74,84` predicate is now `("commenterName" is not null or "commentText" <> '')`. Not covered by a unit test (no `retention.test.ts` exists) |
| G3 | Purge only ran on the local worker | **Partly** | `apps/web/app/api/cron/purge/route.ts` exists and records `retention_run_completed`. But it is only called by `.github/workflows/monitor.yml`, which exits as a no-op until repo secret `MONITOR_TOKEN` and variable `MONITOR_URL` are set (`monitor.yml:30-36`; `docs/MORNING-CHECKLIST.md` step 2 says still to do). Nothing alerts if the purge has not run: no check for it in `packages/publisher/src/system.ts`. Whether the workflow is enabled on a public repo for more than 60 days is also a risk (`monitor.yml:11`). Effective status today: **not running in the cloud** (unverified: confirm no `retention_run_completed` row in `system_events`) |
| G4 | No deauthorize / data-deletion callback | **Open** | No route under `apps/web/app/api/meta/` other than `oauth`. Nuance: Meta's callback page (summary) requires **either** a callback URL **or** an instructions URL and does not mention a deauthorize callback at all. Commenters never authorise the app, so a Meta-initiated callback only concerns the account owner(s) who connect. It becomes necessary for other businesses connecting (multi-account). Priority lower than G1 for a single own account |
| G5 | Redis job payloads hold commenter data, no age limit | **Open** | `vendor/openreply/lib/queue/client.ts:83-90` unchanged (`removeOnComplete: {count: 1000}` retains payloads indefinitely). No `clean-queue` script. Made worse by Redis being plain `redis://` (see P1-5) |
| G6 | Free Upstash tier exhausted | **Partly / moot** | Moved to Redis Cloud (`MORNING-CHECKLIST.md`). Plan, command budget, region and eviction policy `noeviction` are **unverified** (checklist item 4 still open) |
| G7 | Retention misses OperationalEvent, ProcessedComment, LinkClick, Session, VerificationToken | **Open** | `retention.ts` touches only `WebhookEvent`, `DmLog`, `comment_events`, `webhook_events`; `purgeOldEvents` covers `system_events` only |
| G8 | `bodyPreview` of unauthenticated body stored | **Open** | `vendor/openreply/app/api/webhook/route.ts:49` still `rawBody.slice(0, 200)` |
| G9 | Migration 0008 committed and applied | **Partly** | Committed (`git ls-files` lists it; no longer untracked). **Applied: unverified**; `MORNING-CHECKLIST.md` "Do next" 1 still says to apply it. `runMonitor` silently disables all alerts if `alert_state` is missing (`alerts.ts:120-124`), so an unapplied 0008 means zero alerts |
| G10 | Index on `DmLog.commenterId` | **Open** | No migration defines it (`0008` adds only `createdAt` and `(status, createdAt)` indexes) |
| G11 | Logger personal-key redaction | **Open** | `packages/core/src/logger.ts:25-38` unchanged. The new `events.ts:41` `DROP_META_KEYS` regex does cover name/text/comment/email/username/payload/body, so the DB event log is fine; the console logger is not |
| G12 | Burst loses comments / cap too high | **Open, but softer than documented** | Limiter unchanged (`rate-limiter.ts:17-20`). However the comment reconciler re-enqueues any comment not yet SENT/publicly-replied with `requeueAttempt` reset, every 5 min, 30 per sweep, 72 h lookback (`comment-reconciler.ts:41,44,209-240`). So `SKIPPED_RATE_LIMIT` rows are not necessarily "never answered" as `RATE-LIMITS.md:40` and `DATA-PROTECTION.md` say, provided the poller is running. See section (d) |
| G13 | Disclosure and opt-out | **Partly** | Disclosure: default opening copy says "This is an automated reply" (`campaign-form.tsx:35`) and the form warns, but only when an opening DM is enabled and the text is edited (`:40-44`); a direct-DM campaign has no disclosure check at all. Opt-out: nothing in `dm-worker.ts`, `webhook/route.ts`, `webhook.ts` (grep for stop/unsubscribe/opt-out finds nothing) |
| G14 | Push alerts | **Partly** | SMTP alert path built and tested (`alerts.ts`); checks exist for DB, OpenReply, Redis, queue backlog >200, worker heartbeat, failure rate, hourly usage, token <=7 days, failed posts (`system.ts`). Missing checks: retention not run in 48 h, `SKIPPED_RATE_LIMIT` count, webhook silence, comments waiting too long, GitHub/scheduler itself dead. All inert until the scheduler is configured. Token warn threshold is 7 days (`system.ts` token check), which is late for a manual fix |
| G15 | Privacy text gives retention, controller, contact | **Open** | `vendor/openreply/app/privacy/page.tsx` unchanged (last updated May 2026; "repository owner through GitHub or support email configured") |
| G16 | Superuser DB role | **Open** | Not changed (no migration creating an app role) |
| G17 | Key rotation / versioning | **Open** | `packages/core/src/crypto.ts` unchanged by any commit since the first review |
| G18 | Plaintext bootstrap token in env | **Open** | Still the publish fallback: `packages/publisher/src/repository.ts:200-201`; nothing refreshes it (see section (e)) |
| G19 | Tokens in query string | **Open** | Vendored; unchanged |
| G20 | Shared-secret login | **Open** | `docs/SECURITY-AUDIT.md` findings 2-3 stand |
| G21 | Pseudonymise ids in own copies | n/a | No own copies used |

Items the owner added since, assessed: cloud purge route (good design, inert until scheduled; no batching, 60 s `maxDuration`, fine at current size), `system_events` scrubbing (good, tested), 80002 throttle handling (good for publish path; DM sends are inside OpenReply and report nothing back, `RATE-LIMITS.md:43`), SMTP alerts (good), message normaliser (fine), DM-log indexes (committed, applied unverified).

---

## (c) Meta compliance findings

Sources fetched 2026-10-01 (all summaries unless noted):
- Messenger Platform policy: https://developers.facebook.com/docs/messenger-platform/policy/policy-overview/
- Private replies: https://developers.facebook.com/docs/instagram-platform/private-replies/
- Data deletion callback: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/
- Instagram App Review: https://developers.facebook.com/docs/instagram-platform/app-review
- Data Use Checkup: https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/data-use-checkup
- Platform Terms (from the earlier review, summary): https://developers.facebook.com/terms/
- Supabase backups: https://supabase.com/docs/guides/platform/backups

What the sources say, and what they did not: the disclosure rule text is "at the beginning of any conversation or message thread, after a significant lapse of time, or when a chat moves from human interaction to automated experience". The same page's only "opt-out" language is that users can block or mute a conversation; **no explicit STOP/opt-out requirement was found**, and **no spam-pattern rule** (repeated identical messages) was found on the pages reached. Where I call something a risk below because of spam behaviour, that is reasoning from Meta's general "do not spam" policy wording (search extract) and platform mechanics, not a quoted limit.

### P0 (fix before relying on this unattended or before App Review)

**P0-1. The safety nets are not running (monitor, alerts, cloud retention).**
Evidence: `monitor.yml:30-36` skips when `MONITOR_TOKEN`/`MONITOR_URL` are unset; `MORNING-CHECKLIST.md` step 2 lists them as not done. Consequence: no email if the laptop sleeps, Redis dies, the token expires or the DM worker stops; the purge in `docs/COMPLIANCE.md` "Data retention" only runs when the laptop worker is up. This is a Platform Terms s.3.d / data minimisation exposure (retention advertised, not enforced) and an availability exposure.
Fix: set the GitHub secret and variable, run the workflow once, confirm a `retention_run_completed` event and a received test alert (`npm run test-email` is the owner's tool; I did not run it). Apply migration 0008 first (G9). Add two checks to `system.ts`: no retention event in 48 h; no successful monitor run (use an external dead-man's-switch, because GitHub is itself a single point and silently disables schedules).

**P0-2. First live campaign sends a direct DM with no automation disclosure.**
Evidence: the lead reports the first campaign is a direct (no opening DM) message; I could not read live copy (unverified). Code path: with `openingDmEnabled` false the worker sends `dmMessage` as the first private reply (`dm-worker.ts` direct branch near line 590 onward), and `campaign-form.tsx:40-44` only warns about the opening message, never `dmMessage`.
Assessment: a private reply from a comment *is* the start of a message thread with that person. The Messenger Platform policy (summary) requires disclosure of an automated experience at the beginning of a thread; Instagram's own help text (search extract) recommends "I'm a bot" style disclosure even where not legally required. The reviewer and Meta can read this as a violation, and unexpected unlabelled DMs from a comment are the main trigger of "report spam". Link-only DMs without context make it worse.
Fix: add one plain line to the copy of every campaign, for example "Automated message: here is the link you asked for. Reply STOP and I won't message you again." Extend the form warning to also check `dmMessage`. Changing live campaign text is the owner's action; I did not touch it.

**P0-3. No erasure path for commenters; deletion page unusable by them.**
Evidence: G1. Platform Terms s.3.d.i.1 (summary): delete Platform Data promptly on request and give users "an easily accessible and clearly marked way" to ask. Whether a commenter counts as a "User" under the Terms is arguable, but GDPR/DPDP-style erasure rights (general information) apply regardless of Meta's wording, and the OpenReply page directs people to an unnamed support address.
Fix: host `/privacy` and `/data-deletion` in `apps/web` with a real contact, a stated 30-day SLA, retention periods (30/90 days) and sub-processors (Vercel, Supabase, Redis Cloud, DM-worker host, Brevo); write `scripts/erase-commenter.ts` from the recipe in DATA-PROTECTION.md including Redis job removal; register the new URL as the instructions URL in the Meta app.

### P1

**P1-1. Public comment replies are one identical string on every comment.** `openreply-bridge.ts:96` writes `publicReplyMessages = [campaign.public_reply_message]`, a one-element pool, so the vendored random pick (`dm-worker.ts:355-366`) has nothing to vary. Hundreds of identical public replies in minutes is the classic Instagram spam pattern (reasoned, not a documented rule). Also, the public reply is posted **before** the rate-limit gate (`dm-worker.ts:354-396` precedes the gate at `:449`), so it is never paced. Fix: let the bridge accept 5 to 8 variants (outside vendor), and gate or pace public replies (section (d)).

**P1-2. No opt-out.** No STOP handling anywhere. Meta pages reached do not mandate it, but it is a standard expectation at review, a legal expectation in several regimes, and the cheapest spam-complaint reducer. Without vendor changes, the only option is the copy line in P0-2 plus manual blocklist (set campaign off / add a pre-filter in the bridge). Per-person dedup is also missing (known limitation in COMPLIANCE.md): the same person commenting on three posts gets three DMs.

**P1-3. 24h and 7-day rules.** Satisfied by design where the two-step flow is used: the reveal DM only goes after a button tap (`messaging_postbacks`), inside 24 h of the response. In direct-DM mode the link goes out as the single private reply, which is allowed within 7 days (summary of private-replies page). The reconciler's 72 h lookback keeps replies inside 7 days. One compliance-relevant behaviour: every button tap re-sends the reveal ("Duplicate sends are enabled", `dm-worker.ts:~718`); fine within the window, but it lets one person trigger unlimited DMs. Follow-ups (`processFollowUp`) are sent after `followUpDelayMinutes`; if that delay exceeds the 24 h window Meta rejects it (handled, logged and dropped).

**P1-4. One private reply per comment:** enforced (`DmLog @@unique`, `SKIPPED_DEDUP` at `dm-worker.ts:~409-430`). OK.

**P1-5. Redis is unencrypted `redis://` and carries commenter id, name and comment text** (`webhook/route.ts` job data; retained 1000 completed jobs). Platform Terms s.6.a.i (summary) requires safeguards that "meet or exceed industry standards"; plaintext personal data over the public internet is below that. This is the owner's current decision, so I record it as an accepted risk with these mitigations: IP allow-list the DM-worker host and Vercel egress if the provider supports it (Vercel egress IPs are not fixed on lower plans, which makes this hard), keep a strong password, and prefer TLS the moment the plan allows. If TLS is unavailable on the plan, that alone is a reason to change plan or provider before 1000/day.

**P1-6. Token storage.** Good: AES-256-GCM in both tables. Weak: plaintext env bootstrap token (G18), tokens in query strings (G19), `ENCRYPTION_KEY` without rotation (G17). The OpenReply token is refreshed by a Vercel cron (`vendor/openreply/vercel.json`, daily 05:00, refresh within 10 days of expiry); the **publishing token is not refreshed by anything** (section (e)).

**P1-7. Breach notification.** A runbook now exists in DATA-PROTECTION.md. Platform Terms s.6.b.i (summary): notify Meta "as soon as practicable but no later than required under applicable laws". Not verified: the exact Meta form URL. Add the Meta form link and a 72-hour internal clock to the runbook.

**P1-8. If the app is or goes Live.** Required by Meta (summaries): per-permission use-case text, screencast and at least one successful API call for Advanced Access (App Review page); Data Use Checkup annually and before moving Development to Live, unless Standard Access only; Business Verification for Advanced Access serving other businesses, not needed if only role-holders use the app. Scope justification list (from `COMPLIANCE.md`): `instagram_business_basic` (identify account), `instagram_business_manage_comments` (read comments, send private replies, post public replies), `instagram_business_manage_messages` (DMs, postback), `instagram_business_content_publish` (publisher). `instagram_business_manage_insights` is requested by OpenReply's OAuth but unused, so either remove it from the request (vendored; reconnect flow) or justify it. Our dashboard OAuth requests four scopes, OpenReply's five; reviewers compare. Whether the app is currently Live, and its access level, is **unverified**; for a single owned account Standard Access with the owner as app role may suffice and avoids Business Verification and Checkup entirely, which is the simplest compliant posture for now.

### P2

- Duplicate Vercel projects (`jqp-web-89h2`, `jqp-openreply`) hold copies of secrets and public pages: retire or rotate with the main ones.
- `human_agent` tag is not used: correct, do not start using it for automation.
- Webhook signature failures store a 200-char body preview (G8).
- Children's data: no age check (DPDP caution); mention in the notice.
- `messaging_seen` deliberately off: good; keep.
- AI-image label `is_ai_generated` optional (COMPLIANCE.md).

---

## (d) Viral-burst safety

### Mechanics read from the code

Constants (`vendor/openreply/lib/utils/rate-limiter.ts:17-20`): `RATE_LIMIT_MAX = 750`, `RATE_LIMIT_WINDOW = 3600 s`, `REQUEUE_DELAY_MS = 30 min`, `MAX_REQUEUE_ATTEMPTS = 3`. Worker concurrency 5 (`dm-worker.ts:1245`). Queue retries `attempts: 3` with backoff 5/15/45 min (`dm-worker.ts:42`, `client.ts`).

Behaviour:
- Counter is a Redis fixed window: `INCR` sets `EXPIRE 3600` only when the count becomes 1 (`:46-48`), so the window starts at the first send and does not slide.
- Per comment job the order is: dedup checks, **public reply** (`dm-worker.ts:354-396`), dedup across campaigns, monthly counter (limit 2 billion, effectively none: `lib/billing/usage.ts:9`), then `reserveDMSlot` (`:449`), then the private reply.
- There is **no spacing** between sends, only a count.

Timeline for a burst of 1000 matching comments arriving together. Assumption (not measured): one job takes 1.5 to 3 s (two Graph calls plus about 8 database round trips from a laptop to Supabase Mumbai). Throughput = 5 / (1.5 to 3 s) = about 1.7 to 3.3 jobs/s, i.e. **100 to 200 comments (public reply plus DM) per minute**, a send every 0.3 to 0.6 s.

| Time | What happens |
|---|---|
| t = 0 to about 4-8 min | 750 DMs and 750 public replies go out. Counter hits 750 |
| t = 4-8 min | Remaining 250 jobs: public reply still goes out (ungated), DM blocked, requeued +30 min (attempt 1). All 1000 public replies done in about 5 to 10 min |
| t = about 35-38 min | Retried: window still open (expires at t = 60), blocked again, requeued +30 min (attempt 2) |
| t = about 65-68 min | Window reset at t = 60; 250 DMs go out within about 2 min |
| t = about 95 min | A job still blocked at attempt 3 is marked `SKIPPED_RATE_LIMIT`. Total capacity in 90 min is about 1500, so ~1000 is answered, ~2000+ in a burst would start dropping the excess |

Fixed-window edge: 750 at the end of one window plus 750 at the start of the next can be 1500 inside a rolling hour. Meta documents 750 per hour per account for private replies (https://developers.facebook.com/docs/graph-api/overview/rate-limiting/, cited by earlier reviews; the private-replies page I fetched states no rate figure). If Meta counts on a rolling window, calls past the limit fail with a rate-limit error and enter the 3-attempt backoff (5/15/45 min), then FAILED.

Recovery: skipped or failed comments are re-queued by the poller (5 min, 72 h lookback, max 30 per sweep per campaign: about 360/h), so loss is limited to cases where the poller is not running or the comment is older than 72 h.

### Account-flag risk, honestly

**Meta publishes no "safe" sending rate.** The documented 750/h is an API throughput ceiling, not an assurance that an account will not be restricted. Restrictions come from unpublished anti-spam systems. Reasoning from mechanics, the riskiest features of the current burst are: (1) sustained machine speed, 100 to 200 messages a minute with no jitter, which no human or normal tool pattern resembles; (2) near-identical text to hundreds of strangers; (3) the same burst of identical **public** replies, which is ungated and arguably the stronger signal on a viral post; (4) unlabelled direct DMs (P0-2) raising report rates; (5) a single account with a modest history suddenly emitting hundreds of outbound messages. Mitigations that reduce all five at once are pacing, variation and disclosure. None eliminates the risk; I cannot give a number and anyone who gives you one is guessing. At today's 100 to 200 DMs/day the risk from rate is low; it appears with bursts.

### Postbacks and follow-ups

Verified by reading `processPostback` (`dm-worker.ts:681-880`) and `processFollowUp` (`:887-935`): **neither calls `reserveDMSlot`**. They only call `reserveWorkspaceDMSend` (2 billion cap). So reveal DMs and follow-ups bypass the 750 gate and are not blocked by it. They do, however, share the single `dm-processing` queue with comment jobs (FIFO, concurrency 5). During a burst a button tap waits behind waiting comment jobs, about the same few minutes as above. Jobs sitting in the *delayed* set (rate-limit requeues) do not block them. Therefore a design that requeues by delay keeps taps prompt; a design that sleeps inside the worker would delay them. The 24 h window from the tap is not at risk either way.

### Proposed design vs current

Proposal: hourly cap about 100 to 150, minimum gap 20 to 40 s with jitter between private replies per account, bigger requeue budget.

| | Current | Proposed |
|---|---|---|
| Peak rate | 100-200/min | max 1 per 20-40 s = 90-180/h |
| 1000-comment burst finishes | about 70 min | about 7 to 11 h (at 90-150/h) |
| 3000-comment burst | about 2000 answered, rest relies on poller | about 20 to 33 h, all inside the 7-day reply window |
| Reply latency for the typical viewer | seconds | minutes to hours in a burst, seconds otherwise |
| Flag risk (qualitative) | higher in bursts | lower; not zero |
| Public replies | ungated | must be gated too, or the benefit is partly lost |

The cost is slower replies during a spike; for comment-to-DM funnels the first reply being late reduces conversion but not compliance. Alternative if latency matters: a small fast lane (first 30 DMs of a burst at normal speed), then paced.

### Exact minimal patch outline (NOT applied)

`vendor/openreply` must stay unmodified per `CLAUDE.md`. Two routes; Option A respects that rule, Option B needs an explicit owner decision to patch the vendored tree.

**Option A (no vendor edit; untested idea).** The worker is started by `scripts/run-dm-worker.cjs:35` as `tsx worker/dm-worker.ts` with `cwd = vendor/openreply`. Resolve `@/lib/utils/rate-limiter` to a replacement module outside vendor via an overriding tsconfig `paths` entry, passed with `tsx --tsconfig <file>` (`paths` key listing the replacement before `@/*`). Replacement module `packages/publisher/src/dm-pacer.ts` (or `scripts/lib/`) exports the same API (`reserveDMSlot`, `checkRateLimit`, `incrementDMCounter`, `getCurrentDMCount`, `resetRateLimit`, constants). Everything below fits in that module because the worker already honours `shouldRequeue` and `requeueDelayMs` (`dm-worker.ts:498-520`). **Limits of Option A:** it cannot gate the public reply (that is in `dm-worker.ts:354`), and concurrency stays 5. Whether `tsx` honours the path override for the worker process is unverified; test against `scripts/mock-meta-server.ts` first.

**Option B (vendor patch, owner approval needed).** Files and edits:
1. `vendor/openreply/lib/utils/rate-limiter.ts`
   - `:17` `RATE_LIMIT_MAX = Number(process.env.DM_HOURLY_CAP ?? 120)` (keep 750 as a hard upper bound: `Math.min(cap, 750)`).
   - `:19` `REQUEUE_DELAY_MS` becomes the pacing delay returned by the gate (see below) instead of fixed 30 min; keep `Number(process.env.DM_REQUEUE_DELAY_MS ?? 600000)` as the fallback for cap blocks.
   - `:20` `MAX_REQUEUE_ATTEMPTS = Number(process.env.DM_MAX_REQUEUE_ATTEMPTS ?? 200)`.
   - Replace the fixed window in the Lua script (`:36-50`) with a sliding window: `ZREMRANGEBYSCORE key 0 (now-3600000)`, `ZCARD < cap`, `ZADD`.
   - Add pacing in the same Lua call: key `rate:dm:next:{account}` holds the next allowed send time in ms (use `redis.call('TIME')`). If `now >= next`: allowed, set `next = now + DM_MIN_GAP_MS + random(0, DM_GAP_JITTER_MS)`. Else return `wait = next - now`, and **reserve** that slot for this job by bumping `next` again so queued jobs get spaced slots instead of all waking together; return `shouldRequeue: true, requeueDelayMs: wait` (cap at `DM_MAX_WAIT_MS`). A pre-reserved job comes back and is allowed (store `pace:{account}:{commentId} = slotTime` with TTL, check it first).
2. `vendor/openreply/lib/queue/dm-worker.ts`
   - `:449-520`: pacing requeues must not count as failed attempts: pass `requeueAttempt` unchanged for pacing delays and increment only for cap blocks; change the job id at `:517` to include a pacing counter or timestamp to avoid duplicate-id rejection.
   - Move the public-reply block (`:354-396`) below the gate, or call the same reservation for it, so public replies are paced with the DM. Alternatively add a separate cap `PUBLIC_REPLY_HOURLY_CAP` for `sendCommentReply`.
   - `:1245` `concurrency: Number(process.env.DM_WORKER_CONCURRENCY ?? 5)` (keep 5; with delay-based pacing no change is required).
   - Do not add the gate to `processPostback` or `processFollowUp` (keeps taps prompt); optionally enqueue postbacks with BullMQ `priority: 1` at the producer (`webhook/route.ts`).
3. Poller: `COMMENT_POLL_MAX_PER_SWEEP` (`comment-reconciler.ts:44`, already an env knob) lower to 10 while pacing is on so the poller does not fight the pacing.

New env knobs (all optional, defaults shown for a conservative start):

| Knob | Default | Meaning |
|---|---|---|
| `DM_HOURLY_CAP` | 120 | sliding-window private replies per hour per account (hard max 750) |
| `DM_MIN_GAP_MS` | 20000 | minimum spacing between private replies |
| `DM_GAP_JITTER_MS` | 20000 | random extra, so gap is 20-40 s |
| `DM_MAX_WAIT_MS` | 518400000 | longest a comment may wait (6 days, inside the 7-day window) |
| `DM_REQUEUE_DELAY_MS` | 600000 | retry delay when the hourly cap blocks |
| `DM_MAX_REQUEUE_ATTEMPTS` | 200 | before `SKIPPED_RATE_LIMIT` |
| `DM_WORKER_CONCURRENCY` | 5 | unchanged |
| `PUBLIC_REPLY_HOURLY_CAP` | 120 | if public replies are gated separately |

Also change outside vendor: raise `HOURLY_DM_LIMIT` in `packages/publisher/src/system.ts:57` to follow `DM_HOURLY_CAP` so the System page's amber/red thresholds (70%/90%) match; add a `SKIPPED_RATE_LIMIT`/waiting-age check to the monitor; allow several public-reply variants in `openreply-bridge.ts:96`.

Capacity check: at cap 120 and gap 20-40 s the system sends at most about 2,880 DMs/day. For the planned 1000/day that is a sustained load of 35%, so headroom exists for a modest spike; a larger spike queues rather than drops.

---

## (e) Operational readiness for remote operation, and what must be rotated or decided

### What would tell the owner something broke while away

| Failure | Detected today? |
|---|---|
| DM worker stopped (laptop asleep) | Check exists (heartbeat >2 min) but **nothing runs the checks**: the workflow is inert (P0-1). Zero emails today |
| Redis down | Check exists; same dependency |
| Meta token expiry | Check exists (warn at 7 days, red at 3 days). OpenReply refreshes its own token daily via Vercel cron, but the cron secret falls back to `NEXTAUTH_SECRET` and a dedicated `CRON_SECRET` is not set (checklist item 3). **Publishing token** (env `META_LONG_LIVED_ACCESS_TOKEN`, `repository.ts:200`) has **no refresh job**: it dies at 60 days and publishing stops; the monitor reads only OpenReply's `InstagramAccount` expiry, so it would not warn about this one. Refresh also fails permanently once the token is expired |
| Comments piling up / skipped | Only queue backlog >200. No alert on skip counts or on oldest waiting comment |
| Purge not run | No check |
| Monitor itself dead | No check. GitHub disables inactive schedules (`monitor.yml:11`) |
| Supabase paused (free tier pauses on inactivity) | DB check would catch it, but only when the monitor runs. Free-tier pause behaviour is from memory, unverified |

### Single points of failure

1. Laptop-run DM worker (`scripts/run-dm-worker.cjs`; `docs/LIVE.md` "always-on host, e.g. Oracle", not deployed). The checklist lists "Blocking: DMs are received but nothing sends them" as the current state: comments queue in Redis only while a worker is running somewhere. Comments older than 7 days can never be answered.
2. Laptop-run publish worker: unavoidable by design (`LIVE.md`: images live on the laptop), so publishing is operator-attended.
3. Single Redis, plain TCP, single database, single operator secret, GitHub as the only scheduler, Brevo as the only alert channel (an alert about the alert channel being down cannot be sent).
4. 60-day token with no scheduled refresh for the publish token.

### Backups

Supabase free plan: not covered by automatic daily backups; Supabase recommends regular `db dump` exports and off-site copies (https://supabase.com/docs/guides/platform/backups, summary). Pro has 7 days of daily backups, PITR as an add-on. **The project's plan is unverified.** If free: there is no restore point today; the only copy of campaigns, DM logs, encrypted tokens and the dedup record is the live database. A lost dedup record could cause re-sending. Also back up `ENCRYPTION_KEY` in a password manager (loss makes stored tokens unreadable). No restore drill is documented.

### Rotation: credentials the owner shared in chat

Treat as exposed, rotate, then update every place that holds a copy:

| Credential | Update locations |
|---|---|
| Supabase database password (`DATABASE_URL`, shared during setup; checklist says rotate again at the end) | Vercel `jqp-web`, `jqp-openreply-1`, the two duplicate projects if kept, DM worker host, local `.env` and `vendor/openreply/.env`. Also the service-role key if it was shared |
| Redis Cloud password (`REDIS_URL`, and `OPENREPLY_REDIS_URL` in root `.env`) | Same list. Because it is unencrypted `redis://`, treat every previous password as potentially sniffable in transit |
| SMTP login and key for Brevo (`ALERT_SMTP_USER`, `ALERT_SMTP_PASS`) | Vercel `jqp-web`, local `.env`; regenerate the SMTP key in Brevo and revoke the old |
| Anything else pasted in that chat (check for `MONITOR_TOKEN`, `DASHBOARD_SHARED_SECRET`, `NEXTAUTH_SECRET`, Meta app secret, long-lived token) | Rotate those too if they appeared |
| `CRON_SECRET` on `jqp-openreply-1` | Create a dedicated random value (checklist item 3); stops fallback to `NEXTAUTH_SECRET` |

I could not verify whether any of this has already been done.

### Decisions the owner must make

1. Redis TLS: accept plaintext (current decision, recorded as accepted risk in P1-5) or move to a plan or provider with `rediss://` before 1000/day.
2. DM cap and pacing: adopt the paced design (cap about 120/h, 20-40 s gap) and decide Option A or B (B edits `vendor/openreply`).
3. Disclosure and opt-out wording for both live campaigns (P0-2), and whether to accept STOP handling as copy-only.
4. Where the DM worker runs 24/7 (Oracle free VM per `docs/ORACLE-WORKER.md`, Render, or the laptop with an accepted outage risk).
5. Supabase plan and backup routine (paid plan or scheduled `db dump`).
6. Meta app posture: stay Standard Access with owner as role-holder (no Business Verification or Data Use Checkup) or go Live with Advanced Access (needs both, plus annual checkup and per-scope justification; drop `instagram_business_manage_insights`).
7. Privacy contact and erasure SLA (P0-3), and whether to host your own privacy and deletion pages.
8. Publishing-token handling: add a refresh job or move to `ig_accounts` and drop the env bootstrap.

---

## What I could not verify

- Live database state (migration 0008 applied, indexes, row counts, grants, whether `retention_run_completed` ever ran), Supabase plan, Redis Cloud plan/region/eviction policy, Vercel and Meta app settings (Live or Development, access level, subscribed fields), the actual live campaign copy, GitHub repository settings.
- Raw text of Meta pages (all via summaries); the exact Meta breach-notification form; an explicit Meta opt-out requirement (none found); any Meta spam-rate figure (none published).
- Burst timings are computed from constants plus a stated latency assumption, not measured.
- Option A (tsconfig path override for the worker) is untested.
