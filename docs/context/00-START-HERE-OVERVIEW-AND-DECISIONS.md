# 00. Start here: overview, current state and every decision made

Written 2026-10-21 for an agent (or person) taking over the project cold. Nothing secret is in these files. Where a fact was checked against the live system the date and method are given; anything not checked is marked **UNVERIFIED**. If this file disagrees with an older document in `docs/`, this one wins unless it says otherwise (older documents are listed with their staleness in section 8).

## The seven context files (read in this order)

| File | What it covers |
|---|---|
| `00-START-HERE-OVERVIEW-AND-DECISIONS.md` (this file) | What the project is, who the owner is, live state, the decision log, history, rules, open work, glossary |
| `01-ARCHITECTURE-AND-CODE-MAP.md` | Every component, how a post becomes DMs, the publish state machine, queues, packages, scripts, tests |
| `02-DATABASE-REDIS-AND-DATA.md` | Supabase Postgres (schemas, tables, migrations, poolers), Storage, Redis, retention, backups, personal data |
| `03-DASHBOARD-UI-API-AND-CLAUDE-TOOLS.md` | The Next.js dashboard: pages, components, design system, every API route, auth, the Claude Code MCP tools |
| `04-EXTERNAL-INTEGRATIONS-META-OPENREPLY-AND-SERVICES.md` | Meta/Instagram APIs, OpenReply internals and how we use it, Supabase, Redis Cloud, Brevo, Resend, GitHub Actions, Vercel, Oracle |
| `05-PRODUCTION-VERCEL-VM-AND-OPERATIONS.md` | How production is deployed and controlled: Vercel projects and env, the Oracle VM, the guard, monitoring chain, deploy and rollback, runbooks |
| `06-ACCESS-AND-CREDENTIALS-MAP.md` | How to reach and operate every external connection, where each credential lives (never the values), what is blocked, tooling gotchas |

Older, still-useful documents are indexed in `docs/INDEX.md`. The three most useful older ones: `docs/COMPLIANCE-AUDIT-3.md` (sourced Meta rules), `docs/ORACLE-WORKER.md` (VM runbook), `docs/CLAUDE-CONTENT-GUIDE.md` (how to prepare posts and write copy).

## 1. What the project is

**jqp** is an Instagram carousel publishing tool plus a comment-to-DM automation, using only Meta's official APIs (Instagram API with Instagram Login). It is built for one operator, **Sri** (the owner), and currently one Instagram professional account, **@addaddy.ai** (it replaced @anveya.d on 2026-10-13). Volume today is small (single digits to low hundreds of DMs a day); the design targets 500 to 1000 DMs a day.

It is two systems sharing one Postgres database and one Meta app:

1. **Our publisher** (this repo: `packages/*`, `apps/web`, `apps/worker`, `apps/mcp`). It scans a folder of images plus a `caption.md`, validates it, uploads the images to Supabase Storage, drives Meta's container then carousel then publish flow as a crash-resumable state machine, and shows everything in a dashboard.
2. **OpenReply** (`vendor/openreply`, vendored open-source Next.js + BullMQ app, **must stay unmodified**). It receives Meta's comment webhooks and sends the DMs. Our code hands each published post to it by writing a row straight into its `Automation` table (the "bridge").

Typical life of a post: a folder is staged, a campaign (keyword, DM copy, link) is configured but left OFF, the owner says go, the post is published, the campaign is switched on, a follower comments the keyword, Meta calls OpenReply's webhook, the comment is queued in Redis, the DM worker on the Oracle VM sends an opening DM with a button, the person taps, and the link DM is sent.

## 2. The owner and how to work with them

- Sri writes informally and fast, wants things **done rather than discussed**, and above all wants **production not broken**.
- Standing feedback (saved in memory, `feedback-sure-answers-with-sources`): "I don't want unsure answers. I want sure answers with proper citations." Fetch the primary source, quote it, mark unverified things UNVERIFIED, show evidence (test output, live results) rather than assurance. The owner has said they have "trust issues" with the work because earlier confident claims were wrong.
- Short, direct updates. Be candid about your own mistakes (two outages in the first week followed changes made by an agent).
- Never publish a post, enable a campaign, start or stop the DM worker, or change live data unless the owner asked for that exact action. The MCP tools enforce this with `confirm: true`.
- Owner-facing copy (captions, DMs) must sound human: no em or en dashes, no emoji, no hype words, no "not X but Y" constructions. Details in `docs/CLAUDE-CONTENT-GUIDE.md`.
- The owner runs Windows 11 and PowerShell. The `!` prefix in the Claude Code prompt runs commands in **Bash**, not PowerShell, so give PowerShell commands to paste into their own PowerShell window and Bash commands for `!`. See file 06 for tooling gotchas.

## 3. Live state (re-check before relying on it)

Observed 2026-10-21 unless a different date is given. "Verified" means I ran the check shown.

| Area | State | How verified |
|---|---|---|
| Dashboard `https://jqp-web-tau.vercel.app` (Vercel project `jqp-web`) | Up; `/api/health` returns `{"success":true,"db":"ok"}`; login works; all pages render (Home was slow once, 8.8 s, likely a cold start) | `curl` and `npm run smoke` (37 of 41 passed; the 3 failures were laptop network timeouts to OpenReply, re-checked with curl and all returned 200) |
| OpenReply `https://jqp-openreply-1.vercel.app` (project `jqp-openreply-1`) | Up; health `ok`: database ok, Redis `PONG`, queue 0 waiting / 0 active / 0 delayed / 0 failed, worker healthy | `curl /api/health` |
| DM worker on the Oracle VM | **Running** since 2026-10-13 20:10 UTC (so about 8 days), enabled, 0 restarts, 74 MB memory, VM at 12% disk, 0.88 GB outbound this month (0.009% of the 10 TB allowance) | `ssh` then `jqp status` |
| VM bundle on the VM | `9a3a310+uncommitted built 2026-10-14T09:02Z` which contains the combined-report guard (committed afterwards as `2f0a981`) | `/opt/jqp/VERSION` |
| Database | Healthy; migrations 0001 to 0008 present; OpenReply tables present; bridge column contract matches (21 columns) | `npm run doctor` |
| Instagram account in OpenReply | 1 account: `@addaddy.ai`; its token is not near expiry | `npm run doctor` |
| Publishing token | Valid for 52 more days, renewed weekly by the worker job | `npm run doctor` (System page "Publishing token") |
| Campaigns | 5 campaigns in our table, all 5 enabled, all 5 synced, 0 failed; **3 active automations** in OpenReply | `npm run doctor`. The 5 vs 3 gap is probably the two old @anveya.d campaigns the handoff said were still marked enabled (their automations no longer exist). **UNVERIFIED**; reconcile in the Automations page before launch |
| DM traffic | Low but real. The worker journal shows jobs completed on 2026-10-14, 10-15, 10-16 and 10-18 (comment jobs, a button postback and inbound-message jobs). 0 DMs in the 24 hours before the 2026-10-21 doctor run. On 2026-10-14 the combined report showed 3 DMs sent, 0 failed, 3 matched comments, 4 live posts, 2 posts waiting, 3 campaigns on | `journalctl` on the VM, combined status email, `doctor` |
| VM poll settings | `/etc/jqp/worker.env` has `COMMENT_POLL_LOOKBACK_HOURS=1` and `COMMENT_POLL_MAX_PER_SWEEP=5` (the deploy script's "first start" safety values). The comment-polling safety net therefore covers only the last hour. Env key names on the VM: worker has `DATABASE_URL REDIS_URL ENCRYPTION_KEY INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET META_GRAPH_API_VERSION NEXTAUTH_URL COMMENT_POLL_LOOKBACK_HOURS COMMENT_POLL_MAX_PER_SWEEP`; guard has `ALERT_EMAIL_TO ALERT_EMAIL_FROM ALERT_SMTP_HOST ALERT_SMTP_PORT ALERT_SMTP_USER ALERT_SMTP_PASS DASHBOARD_URL VM_REPORT_TOKEN` | `ssh` then `sudo grep` / `cut -d= -f1` (names only) |
| Status email | Combined email (system + VM) sent from the VM every 6 hours; first sent on demand 2026-10-14 and it showed 13 of 13 checks passing | VM `--report`, `--dry-run` |
| Git | `main` at `2f0a981`. Working tree has **someone else's** uncommitted edits: `README.md`, `docs/INDEX.md` (links to the new `docs/PUBLISHING.md`) and the untracked `docs/PUBLISHING.md`, plus untracked `posts/01_dot-and-key`, `02_nutella`, `03_hydro-flask`. These are not part of any commit | `git status` |
| Tests | 218 unit tests pass (21 files); web build and all typechecks clean at `2f0a981` | `npx vitest run`, `npm run build:web`, `npm run typecheck` |
| Laptop disk | C: has about 6 GB free now (it was at 0 GB on 2026-10-14 and broke file writes). Keep temp files on `D:\tmp` if it fills again | `Get-PSDrive C` |

Not verified this session: whether the Meta app is in **Live** mode, whether Advanced Access / App Review has been started, whether the GitHub Actions secret `MONITOR_TOKEN` and variable `MONITOR_URL` exist (there is no GitHub CLI; check the repo's Settings page), whether the owner has rotated the Redis, Brevo and Supabase secrets that once appeared in chat. See section 7.

## 4. Decision log

Each row: the decision, the reason, what was rejected, and where the detail lives. Dates are when it was decided or learned.

### Platform and scope
| # | Decision | Why | Rejected / notes | Detail |
|---|---|---|---|---|
| D1 | Official Meta APIs only (Instagram API with Instagram Login). No scraping, no unofficial automation, no Facebook Page dependency | Account safety and Meta platform terms | Facebook Login flow, third-party schedulers | file 04, `docs/COMPLIANCE-AUDIT-3.md` |
| D2 | One operator, one account now, documented path to more | Scope control; owner is solo | Multi-user auth, tenancy | `docs/ADD-ACCOUNT.md` |
| D3 | Vendor OpenReply as is, **never edit `vendor/openreply`**; everything it needs goes through `packages/publisher/src/openreply-bridge.ts` | Upgradability; the DM engine is someone else's tested code | Forking it; writing our own DM engine | file 01, file 04 |
| D4 | Bridge by **direct SQL into OpenReply's `Automation` table** rather than its HTTP API | Its API needs a NextAuth browser session and has no service auth | Calling `/api/automations` | file 01 section 5 |
| D5 | OpenReply tables share our `public` schema | Prisma's query engine hardcodes `public.`; an isolated `openreply` schema was tried and reverted (migration 0004 is now a no-op). No name collisions: ours are snake_case, theirs PascalCase | Prisma multiSchema (would edit vendored code) | file 02 |

### Data and infrastructure
| # | Decision | Why | Rejected / notes | Detail |
|---|---|---|---|---|
| D6 | Supabase Postgres in Mumbai (project ref `rligoaiclwjwfbixnrry`) is the single database, plus Supabase Storage for media | Free tier, one place for everything | Separate databases per app | file 02 |
| D7 | **Never use the direct DB host from Vercel** (IPv6 only, Vercel has no IPv6 egress). Use the pooler | Caused the first production 500 | Direct host | file 02, `docs/LIVE.md` |
| D8 | Dashboard, publish worker, pg-boss and scripts use the **session pooler (5432)**; **OpenReply uses the transaction pooler (6543)** | Session pooler allows only about 15 clients in total; OpenReply (Prisma, up to 10 per instance) exhausted it in the 2026-10-01 outage. pg-boss needs session mode (LISTEN/NOTIFY, prepared statements) | Putting everything on 6543 (breaks pg-boss); raising limits (paid) | file 02 |
| D9 | Our own job queue is **pg-boss inside the same Postgres** (`pgboss` schema), not another service | No extra infra | BullMQ/Redis for our side | file 01 |
| D10 | Redis (BullMQ) is used **only by OpenReply**: DM queue, rate limiter and the worker heartbeat. Hosted on Redis Cloud over plain `redis://` | The old Upstash database was deleted and hung OpenReply's health check; the owner chose plain redis for now | TLS `rediss://` (owner declined for now; listed as a before-scaling item); Upstash free tier (BullMQ polling burns the quota) | file 02, `docs/REMEDIATION-PLAN.md` B1 |
| D11 | **Publish worker is local only** (the owner's laptop), the **DM worker runs 24/7 on an Oracle Always Free VM** | A post's `folder_path` is a path on the laptop's disk, so a remote host cannot read it; a DM must go out inside Meta's window at any hour | Hosting the publisher remotely (needs the future "content queue" feature) | file 01, file 05 |
| D12 | DM worker ships as a **6 MB esbuild bundle**, run under systemd as a locked-down `jqp` user; the VM needs only Node 22, not the repo | Small, fast to deploy, small attack surface | Cloning the repo + npm + pm2 (first design, 800 MB); GCP e2-micro (kept as documented backup); Render free (sleeps) | file 05, `docs/ORACLE-WORKER.md` |
| D13 | A separate **VM guard** (own user `jqp-guard`, own env file) runs every minute and is independent of the database and Redis; it force-stops the worker at 95% disk or 95% of Oracle's 10 TB outbound allowance | It must still email when the DB or Redis is the thing that is broken; the worker and guard cannot read each other's secrets | Alerts only from the dashboard | file 05 |
| D14 | Stay on Oracle **Always Free** (not Pay As You Go), keep the GCP worker as the documented backup | Idle VMs can be reclaimed; PAYG exemption is unconfirmed; do not fake load | PAYG upgrade | `docs/ORACLE-WORKER.md` section 1 |

### Security and operations
| # | Decision | Why | Detail |
|---|---|---|---|
| D15 | Dashboard auth is **one shared secret** (`DASHBOARD_SHARED_SECRET`, owner uses 32+ chars) exchanged for a signed expiring cookie (`jqp_session`, HMAC, 7 days, HttpOnly, Secure, SameSite). No user accounts | Single operator; rotating the secret ends every session | file 03 |
| D16 | `/api/cron/*` skips the cookie check but every route must call a bearer-token guard (`requireMonitorToken`, or the separate `VM_REPORT_TOKEN` for `digest-data`); unset or short (<24 chars) token means the endpoint is closed (503) | Schedulers cannot hold a cookie | file 03 |
| D17 | Instagram tokens are stored **AES-256-GCM encrypted** with `ENCRYPTION_KEY` (64 hex). Losing that key makes stored tokens unreadable. Weekly job renews stored tokens. A wrong-account guard refuses to publish if the token belongs to a different Instagram account than the post expects | Prevent silent publishing to the old account (@anveya.d) | file 01, file 04 |
| D18 | Supabase `anon`/`authenticated` roles are locked out of the whole `public` schema (revoke + force RLS with zero policies + revoke USAGE; default privileges revoked too) and the storage bucket cannot be listed (migrations 0002, 0006, 0007) | OpenReply's PascalCase tables arrived with no RLS and were readable and writable with the public anon key (session tokens, magic-link tokens, DM text) | file 02 |
| D19 | `system_events` / `alert_state` hold **no personal data**; every message is scrubbed before storing (URLs, connection strings, long opaque strings redacted; keys that might hold names, text, emails, handles, tokens dropped) | Privacy; events survive Vercel's short logs | file 02 |
| D20 | Alerts are **transition-based**: email when a check starts failing, once when it recovers, a reminder every 6 hours while broken. Monitor runs every 30 minutes from GitHub Actions (10 minutes would use about 4,300 of 2,000 free minutes) | Noisy alerts get ignored | file 05 |
| D21 | Retention: raw webhook payloads 30 days (deleted), commenter identifiers 90 days (nulled in place so counts stay), system events 90 days. These numbers are **self-set**; Meta sets no fixed number | Data minimisation | file 02 |
| D22 | One **combined status email every 6 hours, sent by the VM** (dashboard system section fetched from `/api/cron/digest-data` plus the VM's own readings). A missing system section is shown as a warning, never as all fine | If it stops arriving, the VM or its guard is down; independent of Vercel/Actions | file 05 |

### Product behaviour and safety
| # | Decision | Why | Detail |
|---|---|---|---|
| D23 | Default DM pattern is **two-step**: a short opening DM that says it is automated plus a button; the link DM is sent only after the tap. Single-DM campaigns allowed but flagged | A tap is a user-initiated interaction; Meta expects automated messages to disclose | file 04, `docs/CLAUDE-CONTENT-GUIDE.md` |
| D24 | Keep `requireFollow` (follow gating) **off**; public replies **off** by default | Meta says a comment alone does not grant consent for the profile API, so follow-checks cannot work; identical public replies look like spam | `docs/COMPLIANCE-AUDIT-3.md` |
| D25 | **Off means off.** Switching a campaign off deactivates the OpenReply automation first, then saves `enabled=false`. A "Pause all DMs" emergency stop on the System page does this for every enabled campaign | The original off switch did not stop DMs (found in an audit, fixed in `4b5b6ea`, Pause-all added in `c167627`) | file 03 |
| D26 | **Never publish blind.** The publisher checks the container status and the account's recent media before publishing, uses compare-and-set status changes, refuses Retry when a post may already be live (`LIVE_CHECK_REQUIRED`), and a Retry gets a fresh container and its own queue key | Meta has no undo for a publish; double-posting was the top audit finding | file 01 |
| D27 | Message text is plain: Markdown stripped, literal `\n` converted, spaced `--` turned into a dash, URLs and `{placeholders}` left alone, on **every** campaign write (`normalizeMessageText`) | Text pasted from a chat tool arrived with Markdown and escaped newlines | file 01 |
| D28 | The Claude Code MCP server (`apps/mcp`) is the sanctioned way for Claude to touch the system (10 tools). Read tools are free. `publish_post` and `retry_post` always need `confirm: true`; `configure_campaign` needs it only when enabling a campaign on an already-published post (that starts real DMs at once); a Retry on a post that may be live also needs `confirmNotLive`. `ingest_post_folder` is limited to `POSTS_ROOT` **only when that variable is set** | A prompt-injected action must not publish | file 03 |

### UI and content
| # | Decision | Why | Detail |
|---|---|---|---|
| D29 | Dashboard is a dense dark Linear-style tool (tokens in `DESIGN.md` and `apps/web/app/globals.css`), nav renamed Home, Posts, Automations, Activity, Settings, System while **URLs stayed** `/`, `/posts`, `/campaigns`, `/dm-activity`, `/settings`, `/system` | Operational feel; avoid breaking bookmarks | file 03 |
| D30 | Status emails use their own cream (#FEFAE8) and red (#D9070B) palette with a dark header, not the dashboard's dark theme | Emails render in light clients | file 05 |

## 5. How we got here (history)

From `git log` (64 commits as of 2026-10-21) and the handoff documents.

- **2026-08-19 to 2026-08-21 (build phase, 19 commits):** first commit 2026-08-19; monorepo, publish state machine, mock Meta server, OpenReply vendored and bridged, two-step button DM, first Vercel deploy on 2026-08-21 (`docs/LIVE.md`). Then nothing was committed for six weeks.
- **2026-10-01 (22 commits in one day):** Linear-style reskin and Home "morning cockpit", auth and header hardening, System page, monitoring and alert emails, Meta rate-limit handling, Claude Code MCP server, message cleaning, README rewrite, first audits.
- **2026-09-30 to 2026-10-03 (the long session, commits on 10-01 to 10-03):** production fixes (IPv6 DB host 500; slow pages fixed with shared stats, caching and region `bom1`; **outage 2026-10-01** from session-pooler exhaustion fixed by moving OpenReply to 6543; Vercel build hang from `prisma migrate deploy` fixed by changing the build command; dead Upstash replaced with Redis Cloud); security hardening; database password rotated; four audit reports and `docs/REMEDIATION-PLAN.md`. `docs/HANDOFF.md` section 3 is the detailed record.
- **2026-10-13:** new account @addaddy.ai replaces @anveya.d. Oracle VM created and installed (Mumbai, E2.1.Micro). Campaign off-switch fixed; publish safety (never publish blind, compare-and-set, safe Retry, wrong-account guard); weekly token refresh; five independent reviews; Meta compliance research (`docs/COMPLIANCE-AUDIT-3.md`) finding that comment webhooks need Advanced Access. **DM worker started on the VM at 20:10 UTC.**
- **2026-10-14:** @addaddy.ai connected for publishing (`connect-account`) and registered in OpenReply without a browser login (`connect-openreply-account`); Instagram app secret reset and updated on both Vercel projects; dashboard safety (confirm before publish, no em dash or emoji in default DM, password strength check, VM env allowlist, 1 hour first-start lookback); Pause-all DMs; campaign preview builder and post staging scripts; HTML health digest; VM status report; then the **combined status email** (`2f0a981`) with `VM_REPORT_TOKEN` set on Vercel production and pushed to the VM, a test report sent from the VM, deploy verified live. The old `jqp-openreply` Vercel project was disconnected from GitHub (it failed every deploy with a stale DB password and caused daily "production failed" emails; never reconnect it).
- **2026-10-15 to 2026-10-21:** no new commits to `main` after `2f0a981`. Someone added `docs/PUBLISHING.md` and README/INDEX links (uncommitted). The worker ran continuously.

## 6. Rules of engagement (carry these forward)

1. **Production system.** Do not publish, enable a campaign, start/stop the DM worker or change live data without the owner's explicit request for that action.
2. Before pushing to `main` (it deploys the dashboard `jqp-web`, OpenReply `jqp-openreply-1` which is the live webhook receiver, and the still-linked duplicate `jqp-web-89h2`, verified 2026-10-21) run, in order: `npm run build:packages`, `npm run typecheck`, `npx vitest run`, `npm run build:web`.
3. Never read, print or commit `.env` files or any secret. A hook blocks reading them. Use the helper scripts (`npm run set-env`, `set-redis`, `set-database-url`, `rotate-db-password`) which apply the right pooler port per target and never print values. If you need a secret value, ask the owner.
4. A permission classifier may block writing a secret to a secret store (it blocked `vercel env add` once). Do not work around it; give the owner the exact command to run themselves.
5. `vendor/openreply` is untouched. The only requested exception (viral-burst pacing patch, about 30 lines) is **not approved**; ask first.
6. Match surrounding code style and comment density. Add tests with changes. Use independent review for risky work. Report honestly if something was not verified.
7. Do not run two things that each open many database sessions (the session pooler allows about 15 clients in total).
8. `vercel env` values marked Sensitive cannot be pulled back and changes apply only to the next deployment, so redeploy after changing one.

## 7. Open work, consolidated and prioritised

Order of importance. "Owner" = needs Sri's hands or decision.

| # | Item | Owner? | Source / status |
|---|---|---|---|
| 1 | **Meta access scope (G0 in `docs/LAUNCH-TASKS.md`)**: Meta says comment webhooks need Advanced Access and the app in Live mode; Development mode delivers none. Run the stranger test (a personal account with **no role** on the app comments the keyword; check webhook, opening DM, button reveal). If it fails, start App Review and Business Verification (draft wording in `vendor/openreply/META_APP_REVIEW.md`). Until then only role holders reliably trigger DMs | Owner | Not done. Whether comment webhooks arrive in Live mode on Standard Access is **UNVERIFIED** by Meta's docs |
| 2 | Reconcile the 5 enabled campaigns vs 3 active automations; switch off the two stale @anveya.d campaigns (use the Automations page toggle, which now deactivates OpenReply first) | Owner approves | Likely; UNVERIFIED |
| 3 | Rotate secrets that appeared in chat: Redis password (`npm run set-redis -- --vercel`, then redeploy and update the VM worker env), Brevo SMTP key (`npm run set-env`), delete the Supabase access token used for the DB rotation | Owner | Status UNVERIFIED |
| 4 | GitHub Actions: secret `MONITOR_TOKEN` and variable `MONITOR_URL=https://jqp-web-tau.vercel.app`; run the `monitor` workflow once. **Note:** the workflow still has a 6-hourly "Health digest email" step that calls `/api/cron/digest`. Now that the VM sends the combined email, you will receive **two** status emails every 6 hours if the secrets are set. Decide whether to delete that step from `.github/workflows/monitor.yml` | Owner decides | UNVERIFIED whether the secrets exist |
| 5 | OpenReply on Vercel is **public with open email sign-up** (security audit H1): anyone can create a workspace, send magic-link mail via the owner's mail account and connect their own Instagram accounts to the owner's Meta app. Options: Vercel Firewall rule limiting `/login`, `/api/auth` and the dashboard to the owner's IP while leaving `/api/webhook` and the legal pages open; upgrade vendored Next.js/Auth.js (touches vendor); DB trigger rejecting new `User` rows not on an allow list | Owner decides | Open |
| 6 | Vercel hygiene: remove unused `META_LONG_LIVED_ACCESS_TOKEN` from `jqp-web` if the dashboard never uses it (publishing falls back to it only if no stored token), make sure `MOCK_META` is false in production, set a distinct `CRON_SECRET` on `jqp-openreply-1` (it exists as an env var; confirm it is distinct) | Owner | UNVERIFIED |
| 7 | Resend is in test mode: OpenReply login emails only reach the owner's Resend address | Owner | Known |
| 8 | Before scaling: Redis TLS, burst pacing (needs vendor patch approval), several public-reply variants, per-person DM cap, lower the 750 cap to about 600, erasure script and named contact on the data-deletion page, a low-privilege DB role for the worker, certificate-verified Postgres TLS, `posts.ig_account_id` for true multi-account, scheduled backups (`npm run backup`) | Mixed | `docs/REMEDIATION-PLAN.md` B, `docs/COMPLIANCE-AUDIT-3.md` gaps 5 to 9 |
| 9 | Publishing is still manual-local: `npm run dev:worker` on the laptop must be running to publish, and also to run `sync-campaign-to-openreply`, the weekly token refresh and the nightly purge (the purge also runs from GitHub Actions if configured). See `docs/PUBLISHING.md` for the warning that starting it consumes already-queued jobs | Owner | By design (D11) |
| 10 | Pending product decisions: the "content queue" (Claude inserts rows, a webhook posts them: endpoint vs direct table, approval gate and daily caps, where image links come from, multi-account scope, worker location); remote access option 1/2/3 (`docs/REMOTE-ACCESS-PLAN.md`) | Owner | Not built |
| 11 | Backup second DM worker on GCP (`docs/GCP-WORKER.md`) in case Oracle reclaims the idle VM; two-worker behaviour (shared 750 cap, crashed job pickup) is **UNVERIFIED** | Owner | Not built |
| 11a | Push the reset Instagram app secret to the VM worker env (`deploy-dm-worker.ts ... --push-env --restart`): `/etc/jqp/worker.env` was last written 2026-10-13 18:55 UTC, before the 2026-10-14 reset. Also retire the linked duplicate Vercel project `jqp-web-89h2` (it rebuilds on every push and holds secret copies) | Owner approves | Open; contents UNVERIFIED |
| 11b | **Widen the VM's comment-poll look-back** from 1 hour to the intended 72 hours (and revisit `COMMENT_POLL_MAX_PER_SWEEP=5`) now that the first-start period is over; otherwise a worker outage longer than an hour can leave non-webhook comments unanswered. `deploy-dm-worker.ts ... --push-env --lookback-hours 72 --restart` (the 5 per sweep is hardcoded in that script) | Owner decides | Open; the docs claim 72 h, the live VM does 1 h |
| 12 | Commit or discard the stray working-tree changes (`README.md`, `docs/INDEX.md`, `docs/PUBLISHING.md`, `posts/0*`) | Owner | Open |

## 8. Staleness map of older docs

| Doc | Staleness |
|---|---|
| `docs/HANDOFF.md` | Accurate to 2026-10-14 in its top "UPDATE" sections; the body (sections 1 to 7) is the 2026-10-03 state and is partly superseded (e.g. it says the DM worker is not running; it has run on the VM since 2026-10-13) |
| `docs/MORNING-CHECKLIST.md`, `docs/MONITORING.md` step numbers | Dated 2026-10-01; MONITORING's alert/check table is still right |
| `README.md` | Mentions pm2 and Upstash in places; architecture section says Upstash (now Redis Cloud) |
| `docs/ARCHITECTURE.md` | Diagram shows both workers on the laptop; the DM worker is now on the Oracle VM (the mermaid is otherwise right) |
| `docs/LIVE.md` | Correct on poolers/URLs; its Redis "known issue" is resolved |
| `docs/DEPLOY.md`, `docs/PRODUCTION.md`, `docs/SETUP.md` | Original setup checklists; partly superseded (migrations are not run on deploy) |
| `docs/COMPLIANCE.md`, `COMPLIANCE-AUDIT-2.md` | Superseded by `COMPLIANCE-AUDIT-3.md` where they disagree |
| `docs/ORACLE-WORKER.md`, `LAUNCH-TASKS.md`, `COMPLIANCE-AUDIT-3.md` | Authoritative for their topics (as of 2026-10-13) |

## 9. Glossary

| Term | Meaning |
|---|---|
| Post | One folder of images plus `caption.md`, one row in `posts`. Its `campaign_id` is the folder slug |
| Campaign | Our staging row of DM settings for a post (keywords, DM text, link, opening DM, public reply, enabled). One per post |
| Automation | OpenReply's table row that actually answers comments. Created/updated from a campaign by the bridge. `Automation.postId` equals the Instagram media id |
| Bridge | `packages/publisher/src/openreply-bridge.ts`, the SQL that copies a campaign into an Automation |
| Container | Meta's draft media object: child containers per image, then a carousel container, then `media_publish` |
| Two-step / opening DM | First DM with a button; the link is revealed after the tap (postback `reveal:<automationId>`) |
| Private reply | A DM sent in reply to a comment, allowed within 7 days of the comment, one per comment, 750 per hour per account |
| Guard | The per-minute VM health script `vm-guard`, with the force-stop file `/var/lib/jqp-guard/halt` |
| `jqp` (on the VM) | The control command: `status`, `check`, `start`, `stop`, `restart`, `resume`, `rollback`, `logs`, `test-email`, `report` |
| Session / transaction pooler | Supabase's pgBouncer ports 5432 and 6543 |
| Sensitive env var | A Vercel variable whose value can never be read back, only replaced |
| MCP | The Claude Code tool server in `apps/mcp` (server name `jqp`, registered in `.mcp.json`) |
