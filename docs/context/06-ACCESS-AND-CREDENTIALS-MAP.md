# 06. How to access every external connection, and where each credential lives

This file tells a new agent or person how to **reach, check and operate** each system, which tool or command to use, who owns the account, and what an assistant is and is not allowed to do. It never contains a secret value. Everything was verified on 2026-10-21 unless marked **UNVERIFIED**.

## 0. Ground rules for secrets
1. Never read, print, paste or commit `.env` files or any secret. The repo's `CLAUDE.md` says a hook blocks reading them; do not look for a way around it. If you need a value, ask the owner (Sri) to run a command and tell you the outcome.
2. Use the helper scripts that move secrets without printing them (`set-env`, `set-redis`, `set-database-url`, `rotate-db-password`, `deploy-dm-worker`, `connect-account`). They validate the new value, apply the right pooler port per target, back up the old file to `D:\jqp-private\env-backups`, and update Vercel with `--vercel`.
3. A permission classifier can refuse to let an agent **write a secret to a secret store** (it refused `vercel env add`). That is intentional. Prepare the exact command, give it to the owner for their own PowerShell window, and carry on with everything else.
4. Secrets that once appeared in chat transcripts (Redis password, Brevo SMTP key, a Supabase access token) are treated as compromised and should be rotated (file 05 section 7).
5. `.gitignore` excludes `.env`, `.env.*` (except `.env.example`), `backups/`, `dist/`, `.vercel/`, `POST-F/`, `combined-gptimage2-high-01to10/`, and `posts/**` images (except `posts/POST_001`). Do not weaken it.

## 1. Where each credential physically lives

| Credential (variable) | Root `.env` (laptop) | `vendor/openreply/.env` (generated) | Vercel `jqp-web` | Vercel `jqp-openreply-1` | VM `worker.env` | VM `guard.env` | Other |
|---|---|---|---|---|---|---|---|
| `DATABASE_URL` (session 5432) | yes | no (6543 copy) | yes | no | no | no | |
| `DATABASE_URL` (transaction 6543) | no | yes | no | yes | yes | no | |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_STORAGE_BUCKET` | yes | no | yes | no | no | no | Supabase dashboard |
| `DASHBOARD_SHARED_SECRET` | yes | no | yes | no | no | no | owner's password manager (UNVERIFIED) |
| `ENCRYPTION_KEY` (ours, 64 hex) | yes | no | yes | no | no | no | **back it up outside git** |
| `OPENREPLY_ENCRYPTION_KEY` / OpenReply `ENCRYPTION_KEY` | yes (`OPENREPLY_`) | yes (`ENCRYPTION_KEY`) | yes (`OPENREPLY_`) | yes | yes | no | **back it up outside git** |
| `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION`, `META_API_BASE` | yes | as `INSTAGRAM_APP_ID/SECRET`, `META_GRAPH_API_VERSION` | yes | yes (OpenReply names) | `INSTAGRAM_APP_ID/SECRET`, `META_GRAPH_API_VERSION` | no | Meta developer console |
| `OPENREPLY_FACEBOOK_APP_SECRET` | yes | `FACEBOOK_APP_SECRET` | yes | yes | no | no | Meta console, App settings, Basic |
| `META_WEBHOOK_VERIFY_TOKEN` | yes | `WEBHOOK_VERIFY_TOKEN` | yes | yes | no | no | Meta console webhook config |
| `META_IG_USER_ID`, `META_OAUTH_REDIRECT_URI`, `APP_BASE_URL`, `OPENREPLY_DASHBOARD_URL` | yes | `NEXTAUTH_URL` is local on the generated file | yes | `NEXTAUTH_URL` | `NEXTAUTH_URL` (public URL) | no | |
| Instagram access token (publishing) | `META_LONG_LIVED_ACCESS_TOKEN` (bootstrap/fallback) | no | same (production + preview) | no | no | no | **encrypted in `ig_accounts`** (our key) |
| Instagram access token (OpenReply copy) | no | no | no | no | no | no | **encrypted in `"InstagramAccount"`** (OpenReply's key) |
| `OPENREPLY_NEXTAUTH_SECRET`, `OPENREPLY_CRON_SECRET` | yes | `NEXTAUTH_SECRET`, `CRON_SECRET` | yes | yes | **deliberately not on the VM** | no | |
| Redis URL | `OPENREPLY_REDIS_URL` | `REDIS_URL` | `OPENREPLY_REDIS_URL` | `REDIS_URL` | yes | no | Redis Cloud console |
| Resend / email server for magic links | `OPENREPLY_RESEND_API_KEY`, `OPENREPLY_EMAIL_FROM`, `OPENREPLY_EMAIL_SERVER` | `RESEND_API_KEY`, `EMAIL_FROM` | yes | yes | no | no | Resend dashboard |
| Brevo SMTP (`ALERT_SMTP_HOST/PORT/USER/PASS`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`) | yes | no | yes (production) | no | no | **yes** | Brevo dashboard |
| `MONITOR_TOKEN` | yes | no | yes (production) | no | no | no | GitHub Actions secret (UNVERIFIED) |
| `VM_REPORT_TOKEN` | **no** | no | yes (production, Sensitive) | no | no | **yes** | nowhere else; the temp copy was deleted |
| `DASHBOARD_URL` | no | no | no | no | no | yes | |
| AWS Bedrock keys | optional | no | yes | no | no | no | not in use |
| Oracle VM SSH private key | `~/.ssh/oracle_jqp` (`C:\Users\ASUS\.ssh\oracle_jqp`) | | | | | | public half uploaded to the instance; passphrase UNVERIFIED |
| GitHub access | SSH key for `git@github.com` (UNVERIFIED which) | | | | | | |
| Vercel access | CLI login stored by the Vercel CLI (user `reesick`) | | | | | | |
| Supabase management token | only while running `rotate-db-password`, then deleted | | | | | | |

Backups of changed env files: `D:\jqp-private\env-backups` (outside the repo, locked to the owner's Windows account, newest 5 per file). Database snapshots (with personal data and encrypted tokens): `D:\jqp\backups\<timestamp>` (git-ignored).

## 2. System-by-system access

### 2.1 This repository and the laptop
| Item | Fact |
|---|---|
| Path / OS | `D:\jqp`, Windows 11, user `ASUS`; Node via nvm4w at `C:\nvm4w\nodejs`; repo requires Node >= 20 |
| Branch / remote | `main`, remote `origin` `git@github.com:reesick/jqp.git` (SSH). Commits made on this machine use the git user configured locally ("DIng DING DIng" in the session snapshot) |
| Install / build | `npm install`; `npm run build:packages` before building apps |
| Check it works | `npm run doctor` (inside view) and `SMOKE_WEB_URL=https://jqp-web-tau.vercel.app SMOKE_OPENREPLY_URL=https://jqp-openreply-1.vercel.app npm run smoke` (in PowerShell: `$env:SMOKE_WEB_URL='...'; npx tsx scripts/smoke-test.ts`) |
| Disk | C: had 0 GB free on 2026-10-14 and about 6 GB on 2026-10-21; D: has about 55 GB. If C: fills, `$env:TEMP='D:\tmp'; $env:TMP='D:\tmp'` |
| Laptop network | Occasionally slow or failing to some hosts (node `fetch` timed out calling OpenReply and graph.instagram.com during `doctor`/`smoke` on 2026-10-21 while `curl` succeeded). Re-run with `curl.exe` before concluding a service is down |

### 2.2 Shell quirks that have cost time (carry these forward)
- The Claude Code **`!` prefix runs in Bash** (Git Bash), not PowerShell. Give PowerShell commands as copy-paste blocks for the owner's own PowerShell window and Bash commands for `!`. A PowerShell `cd D:\x; Get-Content ...` run through `!` fails ("cd: D:x: No such file").
- **PowerShell 5.1 drops `--` flags after `npm run x`.** Use `node --import tsx scripts/<name>.ts --flag value`. `&&` and `||` do not exist in 5.1; use `;` and `if ($?)`.
- Git Bash rewrites paths beginning with `/`: use `MSYS_NO_PATHCONV=1` when passing Unix paths to Windows programs.
- Repo files are CRLF; exact-match scripted edits must normalise line endings. Long heredocs with quotes can fail to parse; write files with the file tool instead.
- `native commands with stderr` in PowerShell 5.1 show as `NativeCommandError` even when the exit code is 0 (git push progress, npx); read the exit code and the text.
- `npx vitest run` prints a harmless "CJS build of Vite's Node API is deprecated" warning.

### 2.3 GitHub (`reesick/jqp`, private)
- Browse: https://github.com/reesick/jqp (owner login required). Push with `git push` over SSH.
- Actions: Settings > Secrets and variables > Actions. Needs secret `MONITOR_TOKEN` and variable `MONITOR_URL` (`https://jqp-web-tau.vercel.app`) for `.github/workflows/monitor.yml` to do anything. Run it manually from the Actions tab (workflow_dispatch). **No GitHub CLI is installed**; whether the secret/variable exist is UNVERIFIED.
- Vercel is connected through the GitHub integration (push to `main` deploys).

### 2.4 Vercel
- Console: https://vercel.com (team `reesicks-projects`). CLI (works now): `vercel whoami` -> `reesick`; `vercel project ls`; `vercel env ls production` (in a linked folder); `vercel api "/v9/projects/jqp-web"` for project metadata (no secret values); `vercel api "/v13/deployments/<url>"` for a deployment; `vercel logs <deployment-url>` for runtime logs.
- To use `vercel env add/rm`, run `vercel link --project jqp-web --yes` in a **fresh empty folder** (it may download `.env.local`; delete it and `.vercel`). The owner did this in `D:\tmp\vlink` (now deleted). Projects: `jqp-web`, `jqp-openreply-1` (live); `jqp-web-89h2`, `jqp-openreply` (duplicates).
- Env values are Sensitive (write-only). Change then redeploy. Details: file 05 section 2.

### 2.5 Supabase (project `jqp`, ref `rligoaiclwjwfbixnrry`)
- Console: https://supabase.com/dashboard/project/rligoaiclwjwfbixnrry (owner login). SQL editor is where migrations were first applied by hand; Storage browser for `instagram-media`; Database settings has the pooler strings.
- From the laptop, use the scripts (they read `DATABASE_URL`): `npm run migrate`, `npm run backup`, `npm run doctor`. For ad-hoc SQL an agent should write a small `tsx` script using `getDb()` from `@jqp/core` (and wrap writes in a transaction that is rolled back first, as the earlier reviews did) rather than pasting secrets anywhere.
- The Claude **Supabase connector** (`mcp__claude_ai_Supabase__*`) was found on 2026-10-03 to be logged into a different Supabase account; re-check with `list_projects` before trusting it. Never use it to change the `jqp` project unless it lists `jqp`.
- Management API (token needed, used by `rotate-db-password` only): `https://api.supabase.com`.

### 2.6 Redis Cloud
- Console: Redis Cloud (redis.io/cloud, owner login): the database host printed by `doctor` is `harmonious-crate-eggnog-42587.db.redis.io`; the plan tier is UNVERIFIED. Public endpoint, plain `redis://`, user/password in the URL.
- From the laptop: `npm run check-redis` (host, TLS?, PING, never the password). An ad-hoc `redis-cli` is not installed (UNVERIFIED); use `check-redis` or a small ioredis script.
- Must be identical in four places (file 06 section 1). Rotation: `npm run set-redis -- --vercel` (PowerShell: `node --import tsx scripts/set-redis.ts --vercel`).

### 2.7 Meta (Instagram) developer console
- Console: https://developers.facebook.com/apps (owner's Meta developer account; one Business-type app using "Instagram API with Instagram Login"). An assistant has **no API access** to the console; it is a manual UI. What lives there: App roles (testers), Instagram > API setup with Instagram login (tokens, webhooks, redirect URIs, callback and verify token), App settings > Basic (app secret, privacy/terms/data-deletion URLs, Live toggle, App Review, Business Verification).
- Token/API checks an agent can run through our scripts: `npm run doctor` (token valid, webhook subscription), `node --import tsx scripts/connect-account.ts --expect addaddy.ai --check`, and the documented `curl` against `https://graph.instagram.com/{version}/{ig-user-id}/subscribed_apps` with the owner's token (the owner pastes nothing into chat; run it in their terminal).
- The Instagram account **@addaddy.ai**: professional account; the owner must have accepted the tester invite. A second non-role account is needed for the "stranger test".
- Docs to consult first: `docs/ADD-ACCOUNT.md`, `docs/COMPLIANCE-AUDIT-3.md`, `vendor/openreply/META_APP_REVIEW.md`.

### 2.8 OpenReply (the app UI)
- URL https://jqp-openreply-1.vercel.app. Login is an email magic link sent via Resend (test mode: only the owner's Resend address receives it). An assistant cannot log in; ask the owner to look, or use the database/doctor/System page. Public pages: `/privacy`, `/terms`, `/data-deletion`, `/meta-review`.
- Health JSON: `curl -s https://jqp-openreply-1.vercel.app/api/health` (database, Redis, queue counts, worker heartbeat with hostname, pid, start time, age).

### 2.9 Oracle Cloud and the VM
- Console: https://cloud.oracle.com (owner's tenancy, Always Free, region Mumbai). Instance `jqp-dm-worker`. An assistant has no console access; ask the owner to start/stop/rebuild the instance, check Budgets, or read Oracle's emails. The account email should be one the owner reads (idle-reclaim notices).
- **SSH works from this laptop** (verified 2026-10-21): `ssh -i "$HOME\.ssh\oracle_jqp" ubuntu@130.210.51.252` (host key already trusted). `ubuntu` has passwordless `sudo`. Use the `jqp` command (file 05 section 3.3). Never `cat` `/etc/jqp/*.env` into a chat; list key names with `sudo cut -d= -f1 /etc/jqp/worker.env`, and read individual non-secret settings with `sudo grep -E '^(COMMENT_POLL|NEXTAUTH_URL|META_GRAPH)' /etc/jqp/worker.env`.
- Read-only things that are fine for an agent to do unprompted: `jqp status`, `jqp check`, `journalctl`, `systemctl is-active`. **Ask first** for anything that changes state: `jqp start/stop/restart/resume`, `deploy-dm-worker`, editing env files.
- A guard report can be triggered with `jqp report` (sends one email to the owner).

### 2.10 Email services
- **Brevo**: SMTP relay `smtp-relay.brevo.com:587` (STARTTLS) under the owner's Brevo account; verify the sender address there. Used by alerts, digest and the VM guard.
- **Resend**: OpenReply magic links; account in test mode.
- Check: `npm run test-email` (laptop), `jqp test-email` (VM), the owner's inbox.

### 2.11 Claude Code configuration for this project
| Item | Fact |
|---|---|
| Project instructions | `D:\jqp\CLAUDE.md` (ground rules, layout, conventions); points to `docs/HANDOFF.md` and `docs/CLAUDE-CONTENT-GUIDE.md` |
| MCP server | `.mcp.json` registers `jqp` (file 03 section 7). **Disabled** by `.claude/settings.local.json` (`disabledMcpjsonServers: ["jqp"]`) |
| Memory | `C:\Users\ASUS\.claude\projects\D--jqp\memory\` with `MEMORY.md` index, `jqp-infrastructure.md` (where things run), `feedback-sure-answers-with-sources.md` (the owner's standing preference) |
| User-level hooks | GSD tooling hooks in `C:\Users\ASUS\.claude\hooks` (session start, context monitor, prompt guard on Write/Edit). They are environment plumbing, not part of the project |
| Scratch space | The session scratchpad under `C:\Users\ASUS\AppData\Local\Temp\claude\D--jqp\...\scratchpad` (and `D:\tmp` when C: is tight) |
| Connectors in the Claude session | Supabase (wrong account for `jqp`), Notion, Canva, Flora, higgsfield, viewmax, Gmail/Drive/Calendar (unauthenticated) are present but unrelated to this system, except the owner's content pipeline which uses Flora/higgsfield via separate skills (`addaddy-*` skills) |

## 3. What an assistant can and cannot do here (summary)

| Capability | Assistant | Owner only |
|---|---|---|
| Read/edit code, run tests, build, typecheck, `doctor`, `smoke`, `backup` (read-only DB) | yes | |
| Push to `main` (deploys production) | yes **when the owner says so**, after the full gate | |
| SSH to the VM, read status, logs | yes (read-only) | |
| Deploy to the VM, change VM state | only on explicit request | |
| Publish a post, enable a campaign, start the DM worker, pause all DMs | **only on explicit request** (and MCP needs `confirm: true`) | |
| Write secrets to Vercel/GitHub/Redis/Brevo/Meta | no (blocked by the permission layer); give the owner commands | yes |
| Meta console actions (Live mode, App Review, roles, webhooks, redirect URIs) | no | yes |
| Oracle console, Redis console, Brevo, Resend, Supabase dashboard actions | no | yes |
| Rotate secrets | prepare the steps/scripts and verify afterward | runs the commands that write secrets |

## 4. Ten-minute access verification for a new agent (all read-only)
1. `git status; git log --oneline -5` in `D:\jqp` (expect `2f0a981` or newer; the stray `README.md`, `docs/INDEX.md`, `docs/PUBLISHING.md`, `posts/0*` changes may still be there).
2. `curl.exe -s https://jqp-web-tau.vercel.app/api/health` -> `{"success":true,"db":"ok",...}`.
3. `curl.exe -s https://jqp-openreply-1.vercel.app/api/health` -> status ok, worker healthy, hostname `jqp-dm-worker`.
4. `vercel whoami` -> `reesick`; `vercel api "/v9/projects/jqp-web"` shows the latest production deployment and its sha.
5. `ssh -i "$HOME\.ssh\oracle_jqp" ubuntu@130.210.51.252 "jqp status"` -> worker running, readings ok.
6. `npm run build:packages; npm run typecheck; npx vitest run` -> clean, 218 tests.
7. `npm run doctor` -> mostly PASS (re-run if the Meta/OpenReply lines fail with network timeouts).
8. Open the dashboard System page (needs the owner's login) or read the latest 6-hourly status email.
9. Read `docs/context/00-START-HERE-OVERVIEW-AND-DECISIONS.md` section 7 for what is open, and ask the owner which item to take.
10. Do not publish, enable, start, stop or rotate anything until asked.

## 5. People and ownership
- **Sri** (the owner and sole operator) owns every account: GitHub, Vercel, Supabase, Redis Cloud, Meta developer, Instagram @addaddy.ai, Oracle, Brevo, Resend. They write informally, want direct short updates, and prioritise not breaking production. Their standing instruction: sure answers with sources, evidence over assurance.
- There are no other users: the dashboard has one shared password, OpenReply sign-up is open but mail only reaches the owner.
- Content for posts comes from a content pipeline outside this repo (delivery folder `POST-F/05_FINAL`, produced with the `addaddy-*` skills); this repo only stages and publishes it.
