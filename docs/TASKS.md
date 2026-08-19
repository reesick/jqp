# Build log

Maintained through the build, not written after the fact. Ratings are honest against the rubric below — a task that "looks done" but was never executed against real infrastructure is capped, and the cap is stated rather than hidden.

## Rubric

| Score | Means |
|---|---|
| 9-10 | Verified running, tested, handles failure, no known gaps |
| 7-8 | Written + unit tested, one unverified dependency |
| 5-6 | Written and type-checks, correctness rests on docs I can't execute against |
| 3-4 | Structurally right, materially untested |
| 1-2 | Scaffold |

**Hard cap**: anything touching live Meta, live Redis, or live OpenReply auth cannot exceed 6/10 from me, regardless of code quality — I have no credentials to execute against. That cap is lifted only by you actually running it.

## Mid-build pivot

Originally planned (and approved) as a **native** DM engine built in this monorepo, with OpenReply cloned only as a read-only reference. Mid-build, you directed a switch to actually running OpenReply's own code for the DM engine rather than rebuilding it. This changed:

- The queue (`packages/queue`) dropped `poll-containers` and `send-dm`/`reconcile-comments` jobs — those are entirely OpenReply's own BullMQ workers now.
- `packages/meta/src/oauth.ts` was rewritten from a Facebook-Login-for-Business flow to the Instagram API with Instagram Login flow, because OpenReply's own setup docs are explicit that picking the wrong Meta login product breaks its OAuth — and since one Meta app now serves both halves, both had to agree.
- The bridge (`packages/publisher/src/openreply-bridge.ts`) writes directly into `"openreply"."Automation"` via raw SQL (reconstructed from OpenReply's actual Prisma migration history, not guessed), because their `/api/automations` endpoint requires an authenticated dashboard session with no service-to-service path.
- A new isolated Postgres schema (`openreply`) was added so OpenReply's Prisma tables can't collide with ours in the same Supabase database.

This is a real architecture change, not a superficial one. It's also, on reflection, closer to the *original* plan document's diagram (§92) than my first native-engine decision was.

## Per-task ratings

| # | Task | Rating | Why |
|---|---|---|---|
| T01 | Monorepo scaffold, env contract | **9/10** | `npm install`, `check-env` both run and produce the exact expected output, including the failure-mode table. |
| T02 | Supabase schema SQL | **6/10** | Carefully written, but never executed against real Postgres. One real bug (`campaigns.instagram_media_id NOT NULL`, wrong for staged-before-publish campaigns) was caught and fixed during T12 review — a sign there could be others uncaught. |
| T03 | RLS + storage bucket SQL | **6/10** | Same — reasoned through, not executed. |
| T04 | core: db/logger/errors/crypto | **8/10** | Crypto fully unit tested (round-trip, tamper detection, key generation — 5 tests). The Postgres client (`db.ts`) was smoke-tested for real in T14 — it made an actual wire-protocol connection to a live Postgres server and got a genuine `password authentication failed`, proving the client code itself is correct even though no real query has run yet. |
| T05 | meta: client, OAuth, webhook | **7/10** | Webhook signature/challenge/payload parsing fully unit tested (12 tests). OAuth was rewritten after discovering the real flow from OpenReply's docs and integration-tested against the mock server (T15) — request shapes and response parsing are verified; a real Meta round-trip is not. |
| T06 | meta: publishing (containers/carousel/publish) | **8/10** | Unit tested (state transitions, error classification, child-order preservation — 8 tests) and integration-tested end-to-end against the mock server. |
| T07 | storage: Supabase Storage upload | **5/10** | Typechecks, no dedicated test written, never run — the one package with the least direct verification. Real risk area for T16. |
| T08 | publisher: scanner + validator | **9/10** | 17 tests against real generated image fixtures (sharp), not mocks — numeric ordering, 2/3/10/11-image boundaries, corrupt images, PNG→JPEG conversion, duplicates, unexpected files. |
| T09 | queue: pg-boss | **6/10** | pg-boss's actual v10 API (a real breaking change — queues must be explicitly created) was confirmed by reading its shipped `.d.ts` and source directly, not guessed or assumed from possibly-stale docs. Typechecks. Never executed against a real Postgres — `ensureQueues`/`send`/`work` are unverified in practice. |
| T10 | publisher: state machine | **8/10** | 10 tests covering resumability (mid-pipeline resume without redoing finished steps), single-image vs. carousel branching, and terminal-vs-retryable error classification — run through the actual orchestration logic, not just asserted. Never run against a real DB + real Meta together. |
| T11 | Vendor OpenReply | **6/10** | `prisma generate` and their own `typecheck` both actually run clean on this machine. Schema-isolation SQL and `.env` wiring are correct by inspection but unexecuted — blocked on real Postgres/Redis/Resend credentials. |
| T12 | Bridge to `openreply.Automation` | **6/10** | The raw SQL was built from OpenReply's *actual* migration history (grepped every `ALTER TABLE "Automation"` across their real migration files to get the true NOT NULL/default columns) rather than inferred from `schema.prisma` alone, which is meaningfully more reliable than a guess. Still never executed against the live table. |
| T13 | Dashboard (apps/web) | **7/10** | Full production build (`next build`) succeeds — all 18 routes compile and typecheck, including every cross-package import. Zero runtime verification against a real database; every page does a real DB query at request time that's never actually fired yet. |
| T14 | Workers (ours + OpenReply's) | **8/10** | Our worker's entire startup path ran for real: env loaded correctly across a working-directory mismatch that testing caught empirically (not assumed), health server bound, and the DB client made a genuine Postgres connection attempt. OpenReply's own worker starts without crashing, blocked cleanly on missing Redis/DB credentials rather than an error in our wiring. |
| T15 | Tests + mock Meta harness | **8/10** | 66 tests passing across 8 files. The mock-Meta integration test is real HTTP, not mocked function calls, and it caught and led to fixing an actual bug (params encoded as query string vs. body) — the harness proved its value during its own construction. |
| T16 | Local run, full verification | **4/10 — incomplete** | Everything achievable without your real Supabase credentials is done and green (install, typecheck, full test suite, production build, worker startup). The task's actual goal — running the full pipeline against real Postgres/Storage — has not happened yet. This is the next step once you provide Supabase values. |
| T17 | Docs | **7/10** | Comprehensive and cross-referenced against real files in this repo. The Meta-console click-paths are reconstructed from OpenReply's own setup guide plus training knowledge, not verified against today's actual Meta developer console UI — Meta changes this UI without notice, so treat the exact button/menu names as approximate. |
| T18 | This document | n/a | — |
| — | AI captions (`packages/ai`) + env consolidation | **7/10** | Added after you pushed back on Bedrock being fully omitted and on two separate `.env` files. `generateCaption()` is unit tested (4 tests, mocked AWS SDK client) including the disabled-by-default guard and error classification — never called against real Bedrock. `scripts/sync-openreply-env.ts` was smoke-tested end to end with fake values and produces a correct `vendor/openreply/.env`, including the `?schema=openreply` append and the `FACEBOOK_APP_SECRET` fallback. Still capped: no real Bedrock model ID has been validated to exist in any account. |

## Addendum — Bedrock and the single-env-file request

Two things were pushed back on after the initial pass, both addressed:

- **Bedrock was fully out, now it's in behind a flag.** The original plan (`instagram_automation_updated_plan-1.md` §84) argues for not starting with AI, and you explicitly chose "Skip entirely for V1" when asked directly early in this build. On reflection that was too literal a reading — "skip building the feature yet" doesn't have to mean "leave no path to it at all." `packages/ai` now exists: `AI_ENABLED=false` by default, real Bedrock Converse API call when true, never imported by the publish pipeline (matching plan §7's "AI failure does not prevent manual posting"). `npm run generate-caption` is a standalone pre-step.
- **Two `.env` files → one.** OpenReply technically still needs its own physical `vendor/openreply/.env` (Next.js only auto-loads env files from its own project directory — that's a Next.js constraint, not a choice made here), but you now only ever hand-edit the root `.env`. `npm run sync-openreply-env` generates the second file from the first.

## Audit — before real credentials went in

You asked for a low-level audit (error handling, security, use-case gaps) before connecting real keys. Ran a structured code review (correctness/security/error-handling angles, each candidate independently verified) against the entire codebase. 7 findings, all real, 6 fixed immediately, 1 accepted as a documented limitation:

| Finding | Severity | Outcome |
|---|---|---|
| `vendor/openreply` was a nested git repo, never actually captured by the parent repo — a fresh clone would deploy with the DM engine silently missing | High | **Fixed** — nested `.git` removed |
| Bridge always wrote `matchAnyWord: false`; a campaign with blank keywords (submittable from the UI, no validation stopped it) synced "successfully" but matched zero comments, forever, with no error anywhere | High | **Fixed** — `matchAnyWord` now derived from keyword count; caught by 6 new tests in `openreply-bridge.test.ts` |
| Same file: Automation's display name in OpenReply's dashboard used the internal post UUID instead of the human-readable folder name | Medium | **Fixed**, found while fixing the above |
| A token-decryption failure (rotated `ENCRYPTION_KEY`, corrupted row) wasn't classified as `AuthError` like its two sibling checks in the same function — caused pointless retries instead of an immediate, clear "reconnect your account" failure | High | **Fixed** |
| Every GET route and every server-rendered page called the database with zero error handling, and no `error.tsx` existed anywhere — a Postgres blip crashed to Next's generic error page with no retry path, worst possible moment for a status-monitoring dashboard | Medium | **Fixed** — try/catch added everywhere, root `error.tsx` added |
| Campaign PATCH used `??` to fall back to the existing DM message, which doesn't catch an explicit empty string — a blank message could silently overwrite a working one | Medium | **Fixed** — explicit rejection of blank `dmMessage` |
| Dashboard auth cookie was a plain non-constant-time string compare, and stored the raw shared secret as the session value itself | Low-Medium | **Fixed** — cookie now stores `sha256(secret)`, compared in constant time via a new edge-safe Web Crypto module |
| No cleanup path for images from failed/abandoned posts — they stay in the public bucket forever | Low | **Not fixed** — real scope (a retention/deletion feature), low severity since these are meant-to-be-public images. Documented, not built. |

76/76 tests passing after fixes (up from 70 — 6 new regression tests for the campaign-matching bug specifically).

## What will most likely break first when you go live

1. **`packages/storage`'s upload path (T07)** — the least-verified package. If Supabase Storage's actual response shape differs even slightly from what `@supabase/supabase-js`'s types promise, this is where it surfaces.
2. **The `openreply.Automation` raw insert (T12)** — reconstructed from migration history, but if OpenReply pulls in a newer schema change after this build, the column list will be stale. This is the single most likely source of a silent bridge failure — check `campaigns.sync_error` first if DMs aren't firing for a published post.
3. **pg-boss's `createQueue` semantics (T09)** — confirmed from source, but its conflict-handling on repeated calls was not traced to the SQL level; if `ensureQueues()` throws on a second run instead of no-op'ing, that's the first place to look.
4. **Meta's actual current API version and permission set** — this build used `v25.0`, taken from OpenReply's own freshly-cloned `.env.example` rather than assumed, but neither that nor the permission scopes in `docs/SETUP.md` have been checked against Meta's live docs at the moment you read this.
5. **OpenReply schema drift** — it's vendored unmodified and pinned to whatever commit was cloned. If you later `git pull` inside `vendor/openreply` to pick up upstream fixes, re-check `openreply-bridge.ts`'s column list against their new migrations before trusting the bridge again.

## Real-infrastructure findings (first live run)

Once real Supabase/Meta/Upstash/Resend credentials went in, three real bugs surfaced that no amount of mock-based testing could have caught — exactly the kind of thing this cap system was meant to flag honestly in advance:

1. **Isolated `openreply` Postgres schema didn't actually work.** The original design (T11/T12) put OpenReply's tables in their own schema, reached via `?schema=openreply` in `DATABASE_URL`. That query param is only understood by Prisma's *migration* engine — `prisma migrate deploy` genuinely worked with it. But OpenReply's *runtime* client uses `@prisma/adapter-pg`, whose query engine hardcodes `public.` on every generated query unless the schema is declared inside `schema.prisma` itself (Prisma's multiSchema feature — which would mean editing vendored code). Real symptom: magic-link login threw `AdapterError` / `The table \`public.User\` does not exist`. Fix: verified zero table-name collisions between our schema (snake_case) and OpenReply's (PascalCase model names), then moved OpenReply into the same `public` schema as our own tables. `packages/publisher/src/openreply-bridge.ts`, `scripts/sync-openreply-env.ts`, and `supabase/migrations/0004_openreply_schema.sql` (now a no-op) were all updated; `docs/SETUP.md`, `docs/LOCAL.md`, `docs/DEPLOY.md` corrected to match.
2. **`campaigns.instagram_media_id` — SQL said nullable, the TypeScript type didn't.** Fixed in the SQL during T12 (campaigns are staged before a post publishes, so this column starts null) but the corresponding fix to `CampaignRow` in `packages/core/src/types.ts` was missed at the time. TypeScript itself caught this the moment a new test touched the field — exactly the value of keeping types hand-synced with schema changes in the same commit, and a reminder that "typechecks clean" only proves internal consistency, not consistency with what's actually on disk in a migration file you didn't just execute.
3. **`npm run worker` (OpenReply's own script) doesn't load `.env` locally.** `tsx` doesn't auto-load env files; unlike the Next.js dev server (which has this built in), a plain `tsx worker/dm-worker.ts` invocation gets nothing. Not a bug in OpenReply's code — their own docs just assume a workflow (`docker-compose`, or a process manager that injects env directly) that doesn't apply to running it standalone on Windows. Fix: `npx tsx --env-file=.env worker/dm-worker.ts` for local dev only; production (Render) is unaffected since the platform injects env vars directly, no `.env` file involved.

All three are now fixed and documented at the point of failure, not just noted here. This section exists because the honest thing to do with a cap like "never executed against real infrastructure" is to show what happened the first time it *was* executed, not quietly patch it and let the earlier ratings stand unchallenged.
