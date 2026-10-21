# Handoff: everything from the long working session (2026-09-30 to 2026-10-03)

**Newer and more complete: `docs/context/` (start with `00-START-HERE-OVERVIEW-AND-DECISIONS.md`, written 2026-10-21). Where it disagrees with this file, it wins; this file stops at 2026-10-14.**

For a fresh Claude session (or a person) taking over. Read this, then `docs/ARCHITECTURE.md`, then `docs/REMEDIATION-PLAN.md`. Nothing secret is written here; secrets live in the root `.env`, `vendor/openreply/.env`, Vercel and the private backup folder.

## UPDATE 2026-10-13 (read this first; where it disagrees with the sections below, this wins)

**New account:** @addaddy.ai replaces @anveya.d as the account to post from and answer comments on. The owner is adding it as an Instagram tester on the Meta app and will supply its access token; `npm run connect-account` (see `docs/LAUNCH-TASKS.md`) validates and stores it. Nothing has been published and no campaign enabled on it.

**Done and verified since the sections below were written** (commits 4b5b6ea to the latest on main, 201 tests pass, build and typecheck clean):
- Campaign off switch fixed (it now switches the OpenReply automation off first). Not yet exercised on a live campaign.
- Publish safety: never publishes blind (container status and recent-media check), compare-and-set checkpoints, guarded failure writes, Retry refuses a post that may already be live (`LIVE_CHECK_REQUIRED`) and clears dead containers, throttled enqueue with a separate key for Retry, wrong-account guard (a token for another account cannot publish).
- Weekly token refresh job (stored tokens only), System page checks for token expiry, stuck posts and failed campaign sync.
- New SQL was verified against the live database inside rolled-back transactions.
- Retention now also purges OpenReply operational events and link-click identifiers, and fixes comments with no name. Backups skip Session and VerificationToken.
- **Oracle VM exists and is installed**: ubuntu@130.210.51.252 (Mumbai, E2.1.Micro, Ubuntu 24.04), key `~/.ssh/oracle_jqp`. The worker is installed but NOT enabled or started. Verified on the real VM: guard mail, force-stop file path (create fires the stop, delete is a no-op, the unit will not start while it exists), `jqp check` passes inside the full service sandbox, systemd exposure scores 1.8 (worker) and 3.1 (guard), guard runs as its own user. The first `jqp start` has not happened.
- Five independent reviews were run (code, security, Meta compliance, Oracle terms, docs-versus-code). Their findings are fixed or listed below.

**2026-10-14 update:** @addaddy.ai is connected for publishing (`connect-account`) and registered in OpenReply without the browser login via `node --import tsx scripts/connect-openreply-account.ts --expect addaddy.ai` (reads our stored token, writes OpenReply's `InstagramAccount` row encrypted with OpenReply's key, subscribes `comments`, `messages`, `messaging_postbacks`). The Instagram app secret was reset and updated locally, on both Vercel projects, but NOT yet on the VM (`/etc/jqp/worker.env`) which must be updated before the first `jqp start`. OpenReply login emails only reach the Resend owner address (Resend test mode); the old @anveya.d account and its automations no longer exist in OpenReply, but two old campaigns in our `campaigns` table are still marked enabled and must be switched off.

**Still open (in priority order)**
1. **Meta access (decides who can use the automation):** see `docs/COMPLIANCE-AUDIT-3.md`. Meta says Advanced Access is required for comment webhooks and Development mode delivers none. Do the Live-mode test with a no-role account; start App Review and Business Verification. Until approved, only role holders reliably trigger DMs.
2. Start the VM worker (`jqp check` then `jqp start`) and run the worker drills; set the GitHub secret `MONITOR_TOKEN` and variable `MONITOR_URL`; rotate the Redis password, Brevo key and delete the Supabase token (all appeared in chat).
3. **OpenReply on Vercel is public with open email sign-up** (security audit H1): anyone can create a workspace, send magic-link mail through the owner's mail account and connect their own Instagram accounts to the owner's Meta app. Vendored Next.js and Auth.js also have advisories. Needs the owner's decision: (a) a Vercel Firewall rule that limits /login, /api/auth and the dashboard to the owner's IP while leaving /api/webhook and the legal pages open, and/or (b) upgrading the vendored packages (touches vendor, needs approval), and/or (c) a database trigger that rejects new User rows unless the email is on an allow list.
4. Vercel hygiene: remove the unused `META_LONG_LIVED_ACCESS_TOKEN` from jqp-web (the dashboard never uses it), set `MOCK_META` to false if it is true, set a strong dashboard password (32+ characters; the code does not enforce it), set a distinct `CRON_SECRET` on jqp-openreply-1.
5. Before scaling: erasure script, several public-reply variants, per-person DM cap, lower the 750 rate-limit cap, Redis TLS, a separate low-privilege database role for the worker, env allow-list for the VM, certificate-verified Postgres TLS, an `ig_account_id` on posts for true multi-account.
6. Docs still stale in places (README mentions pm2/Upstash, MORNING-CHECKLIST and MONITORING step numbers, CLAUDE-CONTENT-GUIDE PowerShell syntax). The authoritative documents are this file, LAUNCH-TASKS, ORACLE-WORKER, COMPLIANCE-AUDIT-3.

**Useful facts learned today**
- Smoke needs explicit URLs: `SMOKE_WEB_URL=https://jqp-web-tau.vercel.app SMOKE_OPENREPLY_URL=https://jqp-openreply-1.vercel.app npm run smoke` (the local .env points at localhost). Result today: 40 of 41, the one failure is the DM worker heartbeat.
- In PowerShell 5.1, `npm run x -- --flag` loses the flags; use `node --import tsx scripts/x.ts --flag`.
- The Meta compliance and Oracle research are in `docs/COMPLIANCE-AUDIT-3.md` and the Oracle section notes in `docs/ORACLE-WORKER.md`; both mark what could not be verified.

## 1. The project in one paragraph
Instagram carousel publishing plus comment-to-DM automation, official Meta APIs only, for one operator (Sri) and one Instagram account (@anveya.d), about 100 to 200 DMs a day now, with 500 to 1000 as the planned scale. Our code publishes posts. OpenReply (vendored in `vendor/openreply`, must stay unmodified) answers comments with DMs. They share one Supabase Postgres and one Meta app. The owner writes informally, wants things done rather than discussed, and insists on **not breaking production**.

## 2. Current state (verified 2026-10-03)
| Area | State |
|---|---|
| Dashboard `https://jqp-web-tau.vercel.app` (Vercel project `jqp-web`) | Healthy, login works, all pages render, new dark UI, System page, ⌘K |
| OpenReply `https://jqp-openreply-1.vercel.app` (project `jqp-openreply-1`) | Healthy: database, Redis, queue ok. Reports "degraded" only because **no DM worker is running** |
| Database (Supabase project `jqp`, ref `rligoaiclwjwfbixnrry`, ap-south-1) | Healthy; password **rotated 2026-10-03** and applied everywhere; migrations 0001 to 0008 applied; no automatic backups (free plan) |
| Redis (Redis Cloud, plain `redis://`, not TLS) | Working. Replaced a deleted Upstash database. Unencrypted by the owner's decision |
| Meta | Token valid; app no longer blocked; webhook subscribed to `comments` and `messaging_postbacks` |
| Instagram account in OpenReply | Connected (@anveya.d); 2 campaigns (keyword `PROMPT`, whole word) synced to 2 active automations; public replies on |
| DM worker | **Not running.** Was run on the laptop as a session background process, which dies with the session |
| Publish worker | Local only (reads images from a laptop folder) |
| Alerts | SMTP (Brevo) configured and tested; the **scheduler is not on** (GitHub secret and variable missing) |
| Git | `main` at the latest push, clean, private repo `reesick/jqp` |
| Tests | 119 unit tests pass; `npm run smoke` 40 of 41 (only the DM worker heartbeat fails) |

## 3. Everything that was done (by area)
**Production fixes**
- Dashboard 500 on `jqp-web-tau`: its `DATABASE_URL` used the direct (IPv6-only) host. Use the session pooler (5432), never the direct host, from Vercel.
- Speed: sidebar scanned whole tables on every page; fixed with shared stats, caching, loading skeletons and region `bom1`. Pages went from 3 to 4 s to under half a second.
- Outage 2026-10-01: Supabase session pooler allows about 15 clients in total; OpenReply (Prisma, up to 10 per instance) plus pg-boss (default 10) exhausted it (`EMAXCONNSESSION`). Fixed by moving **OpenReply to the transaction pooler (6543)** and capping our pools (`DB_POOL_MAX`, `BOSS_POOL_MAX`). Everything else stays on 5432 because pg-boss needs session mode.
- Vercel builds for OpenReply hung 45 minutes because `prisma migrate deploy` needs a session connection. Fixed by setting the project's build command to `npx prisma generate && npx next build`. Run OpenReply migrations by hand (`docs/LIVE.md`).
- Redis: the Upstash database was deleted (DNS gone), which hung OpenReply's health check and stopped all DMs. Replaced with Redis Cloud.

**Product and UI**: Linear-style dark reskin from `DESIGN.md`; Home as a "needs attention first" cockpit; nav renamed Home, Posts, Automations, Activity, System, Settings (URLs unchanged); toasts; Ctrl+K palette with `G` then `H/P/A/Y/X/S`; optimistic automation toggle; mobile bottom nav.

**Security (see `docs/SECURITY-AUDIT.md`, `SECURITY-AUDIT-2.md`)**: signed expiring session cookie (7 days), login delay, cross-site POST blocking, security headers, Next.js patched, storage listing closed (migration 0007), SMTP requires TLS, bearer-token guard on `/api/cron/*`, event log scrubbing.

**Monitoring and ops**: System page, privacy-scrubbed `system_events` log, state-change alert emails, daily cloud retention purge endpoint, `.github/workflows/monitor.yml` (inert until configured), Meta rate-limit handling (80002 retryable, wait hints honoured, 4 hour retry schedule, usage warnings).

**Tooling (`npm run ...`)**: `doctor` (inside check), `smoke` (live site), `backup` (local snapshot), `check-redis`, `set-env`, `set-redis`, `set-database-url`, `rotate-db-password`, `test-email`, `dm-worker`, `mcp:selftest`, `bundle-dm-worker` (builds `dist/dm-host`), `deploy-dm-worker` (ships it to a VM over ssh).

**Claude Code integration**: `apps/mcp` (tools: system_health, list_posts, get_post, list_campaigns, recent_problems, preview_dm, ingest_post_folder, configure_campaign, publish_post, retry_post). Live actions need `confirm: true`. Currently **disabled** in the owner's Claude settings; they must approve it.

**Message cleaning**: every campaign write strips Markdown, converts literal `\n`, turns a spaced `--` into a dash, leaves URLs and `{placeholders}` alone.

**Docs created**: ARCHITECTURE (diagram), INDEX, HANDOFF (this), CLAUDE-CONTENT-GUIDE, CLAUDE-CODE, MONITORING, RATE-LIMITS, RECOVERY, REMEDIATION-PLAN, REMOTE-ACCESS-PLAN, GCP-WORKER, MORNING-CHECKLIST, four audit reports, ADD-ACCOUNT, rewritten README. A published architecture page exists at `https://claude.ai/artifact/7tSTuRziJimeRjtqbZmCQ3` (private).

## 4. Open work, in priority order (full scoring in `docs/REMEDIATION-PLAN.md`)
**A. Owner actions**
1. Get the DM worker running 24/7. Current plan (2026-10-13): the owner now has an Oracle Cloud account; follow `docs/ORACLE-WORKER.md` (AMD micro VM, `npm run deploy-dm-worker`, VM guard emails on disk, memory, outbound data, worker down, reboot). Read its section 1 first: Oracle can reclaim idle free VMs, so keep the GCP worker (`docs/GCP-WORKER.md`) as a backup. Until a host exists run `npm run dm-worker` in the owner's own terminal. Built and tested here: the bundle (6 MB, works against the live database and Redis via `selfcheck`), the guard logic (24 unit tests, including the automatic worker stop at 95% of disk or of Oracle's 10 TB outbound allowance; the stop-file path was run locally) and a test email. **Not tested on a real Linux/Oracle machine** (no WSL or Docker on the laptop): `install.sh`, the systemd units and `jqp-ctl.sh` have only had a syntax check, so the first real run may need small fixes.
2. Rotate the remaining secrets that appeared in chat: **Redis password** (then `npm run set-redis -- --vercel`), **Brevo SMTP key** (then `npm run set-env`), and **delete the Supabase access token** used for the rotation. The database password is already rotated.
3. GitHub: secret `MONITOR_TOKEN` (copy with `npm run set-env -- --clipboard MONITOR_TOKEN`) and variable `MONITOR_URL=https://jqp-web-tau.vercel.app`, then run the workflow once.
4. Set a dedicated `CRON_SECRET` on `jqp-openreply-1`; make the dashboard password 32+ characters.
5. Decide the first campaign's missing "this is automated" line (direct DM, no disclosure).
6. Free disk space on C: (it hit 0 GB; Chrome data, Downloads, VS Code are the big users).

**B. Code fixes (do next, with tests and an independent review each)**
1. **Disabling a campaign does not stop DMs** (bridge returns early; API only syncs enabled campaigns). Verified. Until fixed, stop DMs by turning the automation off in OpenReply's dashboard or stopping the DM worker.
2. **Double-publish paths**: publish then record is not atomic; pg-boss `singletonKey` has no effect under the default queue policy; Retry reuses dead containers; bridge insert is not atomic (duplicate automations, duplicate public replies).
3. **Publishing token** is a 60-day env var with no refresh job.
4. Then the "before scaling" list (Redis TLS, burst pacing patch to vendored code, reply variations, erasure path, connection budget, monitor coverage, scheduled backups).

**C. Pending decisions from the owner**
- Content-queue system (Claude inserts rows, a webhook posts them). Five questions: endpoint vs direct table access (recommend endpoint), full-auto vs approval gate with daily caps (recommend caps), where image links come from, multi-account scope, worker location. Not built. Today's flow is folder plus MCP tools (`docs/CLAUDE-CONTENT-GUIDE.md`).
- Remote access option 1, 2 or 3 (`docs/REMOTE-ACCESS-PLAN.md`).
- Approval to patch the vendored sender for viral-burst pacing (about 30 lines).
- Whether to stop using helper agents (the owner once objected, thinking they ran on a remote VM; they run locally in the session).

## 5. Rules of engagement
- Production: do not publish, enable a campaign or change live data without the owner's explicit request. Run `npm run build:packages`, `typecheck`, `npx vitest run` and `build:web` before pushing; a push to `main` deploys two Vercel projects.
- Never read, print or commit `.env` files or any secret. A hook blocks `.env` in shell command text; use the helper scripts (aliases `root`/`openreply` in `set-env`).
- `vendor/openreply` stays unmodified; the one exception requested is the pacing patch, which needs approval.
- Copy written for the owner's audience must sound human: no em or en dashes, no "not X but Y" or "X and Y" tricks, no hype words (`docs/CLAUDE-CONTENT-GUIDE.md`).
- For big or risky work: plan first, then execute; use fresh independent agents for audits and reviews; report honestly when something was not verified.
- The owner prefers short, direct updates, and asked for things to be fixed rather than explained. Be candid about my own mistakes (two outages this week followed changes I made).

## 6. Tooling gotchas learned the hard way
- Git Bash rewrites paths starting with `/` (use `MSYS_NO_PATHCONV=1`); long heredocs with quotes can fail to parse (use the file-writing tool); files are CRLF, so exact-match edits in scripts must normalise line endings.
- Supabase's connector in this session belongs to a different account (projects `Indradhanu`, `AUTONOMOUS_CRM`). Use the management API with the owner's token for `jqp`, never the connector.
- `vercel env` values marked sensitive cannot be pulled back; changes apply only to the next deployment, so always redeploy after changing one.
- Never run two things that each open many database sessions (pooler limit about 15).
- The Vercel CLI is logged in as `reesick`; there is no GitHub CLI and no gcloud on the laptop.
- Env-file backups from the helper scripts go to `D:\jqp-private\env-backups` (locked to the owner's account). The repo folder itself is readable by other Windows accounts (inherited `Authenticated Users` access); tightening it is on the remediation list.

## 7. Where to look
`docs/INDEX.md` lists every document by purpose. Start with `docs/ARCHITECTURE.md` for the map and `docs/REMEDIATION-PLAN.md` for what to do next.
