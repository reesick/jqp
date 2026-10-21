# 05. Production: Vercel, the Oracle VM, monitoring, and how it is all controlled

How the live system is deployed, what runs where, how each part is started/stopped/updated/rolled back, who watches it and how, and the runbooks for the things that go wrong. Verified against the live system on 2026-10-21 unless marked otherwise (Vercel project settings via the Vercel API, VM state over SSH, health endpoints with curl, `doctor`/`smoke`).

## 1. Production topology (what is "prod")

| Component | Where | Deployed by | State on 2026-10-21 |
|---|---|---|---|
| Dashboard + API | Vercel `jqp-web` -> `https://jqp-web-tau.vercel.app` | Git push to `main` (GitHub integration) | READY, built from `2f0a981` on 2026-10-14 09:04 UTC |
| OpenReply web + webhook | Vercel `jqp-openreply-1` -> `https://jqp-openreply-1.vercel.app` | Same push | READY, `2f0a981` |
| (duplicate) dashboard | Vercel `jqp-web-89h2` -> `https://jqp-web-89h2-wheat.vercel.app` | **Same push (still linked to GitHub)** | READY, `2f0a981`. A push therefore builds **three** projects, not two. It holds copies of the secrets and is a retirement candidate (`docs/COMPLIANCE-AUDIT-2.md`) |
| (dead) OpenReply copy | Vercel `jqp-openreply` | not linked; last production deploy ERROR on 2026-10-13 | Do not reconnect |
| DM worker + guard | Oracle VM `jqp-dm-worker`, ubuntu@130.210.51.252 | `scripts/deploy-dm-worker.ts` over ssh/scp, run from the laptop | worker active since 2026-10-13 20:10 UTC, 0 restarts |
| Publish worker | Owner's laptop | `npm run dev:worker` by hand | on demand |
| Database, Storage | Supabase `jqp` | migrations by hand (`npm run migrate`) | healthy |
| Redis | Redis Cloud | n/a | PONG, queue empty |
| Scheduler | GitHub Actions `monitor.yml` | repo | **UNVERIFIED** whether configured |

## 2. Vercel

### 2.1 Projects and settings (read from the Vercel API 2026-10-21)

| | `jqp-web` | `jqp-openreply-1` |
|---|---|---|
| Framework | Next.js | Next.js |
| Root directory | `apps/web` | `vendor/openreply` |
| Build command | `npm run vercel-build` (defined in `apps/web/package.json`) | **`npx prisma generate && npx next build`** (overridden; default `vercel-build` also runs `prisma migrate deploy`, which hangs through the transaction pooler) |
| Install command | default (Vercel scopes the install to the workspace closure) | default |
| Node | 24.x | 24.x |
| Function region | `bom1` (from `apps/web/vercel.json`; the project default is `iad1`, but the deployment's effective region is `bom1`, confirmed on the latest deployment) | project default `iad1` (US East; it talks to the Mumbai database across the world, which is why it uses the transaction pooler and why its pages are slower) |
| Git | GitHub `reesick/jqp`, production branch `main` | same |
| Team | `reesicks-projects` (CLI user `reesick`) | same |
| Aliases | `jqp-web-tau.vercel.app`, `jqp-web-reesicks-projects.vercel.app`, `jqp-web-git-main-reesicks-projects.vercel.app` | `jqp-openreply-1.vercel.app` (the one Meta uses), `...-reesicks-projects.vercel.app`, `...-git-main-...` |
| Crons (Vercel) | none | `vendor/openreply/vercel.json`: `/api/cron/refresh-tokens` 05:00 UTC, `/api/cron/attach-next-reel` 06:00 UTC, `/api/cron/snapshot-followers` 07:00 UTC |

Preview deployments exist for branches (some variables are scoped Production only; see below). The dashboard has no custom domain.

### 2.2 Environment variables (names, types and scope only; all are Sensitive, write-only)

**`jqp-web`** (45 variables). *Production + Preview:* `AI_ENABLED`, `APP_BASE_URL`, `AWS_ACCESS_KEY_ID`, `AWS_REGION`, `AWS_SECRET_ACCESS_KEY`, `BEDROCK_MODEL_ID`, `BRIDGE_SHARED_SECRET`, `DASHBOARD_SHARED_SECRET`, `ENCRYPTION_KEY`, `META_API_BASE`, `META_APP_ID`, `META_GRAPH_VERSION`, `META_LONG_LIVED_ACCESS_TOKEN`, `META_OAUTH_REDIRECT_URI`, `META_WEBHOOK_VERIFY_TOKEN`, `MOCK_META`, `MOCK_META_PORT`, `NODE_ENV`, `OPENREPLY_CRON_SECRET`, `OPENREPLY_DASHBOARD_URL`, `OPENREPLY_EMAIL_FROM`, `OPENREPLY_EMAIL_SERVER`, `OPENREPLY_ENCRYPTION_KEY`, `OPENREPLY_FACEBOOK_APP_SECRET`, `OPENREPLY_NEXTAUTH_SECRET`, `OPENREPLY_PORT`, `OPENREPLY_RESEND_API_KEY`, `QUEUE_CONCURRENCY`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`, `SUPABASE_URL`, `WORKER_HEALTH_PORT`. *Production only:* `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`, `ALERT_SMTP_HOST`, `ALERT_SMTP_PASS`, `ALERT_SMTP_PORT`, `ALERT_SMTP_USER`, `BOSS_POOL_MAX`, `DATABASE_URL`, `DB_POOL_MAX`, `META_APP_SECRET`, `META_IG_USER_ID`, `MONITOR_TOKEN`, `OPENREPLY_REDIS_URL`, **`VM_REPORT_TOKEN`** (added 2026-10-14).

Why so many: the dashboard calls `loadEnv()`, whose zod schema requires every variable the publisher needs, even ones the dashboard never uses (`META_APP_SECRET`, `ENCRYPTION_KEY`, ...). The `OPENREPLY_*` copies exist only because the root env generator reads them; Vercel `jqp-web` does not run OpenReply. Unused or risky ones to review: `META_LONG_LIVED_ACCESS_TOKEN` (fallback publishing token; the dashboard does not need it), `MOCK_META` (must be false in production), the AWS keys (AI is off).

**`jqp-openreply-1`** (13 variables). *Production + Preview:* `CRON_SECRET`, `EMAIL_FROM`, `ENCRYPTION_KEY`, `FACEBOOK_APP_SECRET`, `INSTAGRAM_APP_ID`, `META_GRAPH_API_VERSION`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `RESEND_API_KEY`, `WEBHOOK_VERIFY_TOKEN`. *Production only:* `DATABASE_URL` (transaction pooler 6543), `INSTAGRAM_APP_SECRET`, `REDIS_URL`.

Facts that bite:
- **Sensitive values cannot be pulled back** (`vercel env pull` omits them), so the Vercel copy is write-only; the root `.env` on the laptop is the working copy, and `D:\jqp-private\env-backups` holds backups made by the helper scripts.
- A changed variable applies **only to the next deployment**. After `set-env`, redeploy (push, or Redeploy in the Vercel UI, or `vercel redeploy`).
- `NEXTAUTH_URL` on `jqp-openreply-1` must equal its real domain or magic-link login silently breaks.
- `DATABASE_URL` differs on purpose: 5432 for `jqp-web`, 6543 for `jqp-openreply-1`.
- Helpers (never print values): `npm run set-env` (flags `--var NAME`, `--copy`, `--generate`, `--clipboard`; aliases `root`/`openreply`), `npm run set-redis -- --vercel`, `npm run set-database-url -- --vercel`, `npm run rotate-db-password`. Remember PowerShell 5.1 drops `--` flags after `npm run x`; use `node --import tsx scripts/<name>.ts --flag`.

### 2.3 Deploying a change to the dashboard / OpenReply
1. `npm run build:packages`, `npm run typecheck`, `npx vitest run`, `npm run build:web` (must all pass).
2. Commit; commit messages end with the attribution line the session's instructions specify.
3. `git push` to `main`. Vercel builds the linked projects (three, including the duplicate). A deployment takes about 1 to 3 minutes (the `digest-data` endpoint went from 404 to 401 in about 3 minutes on 2026-10-14).
4. Verify: `curl https://jqp-web-tau.vercel.app/api/health`; `SMOKE_WEB_URL=... SMOKE_OPENREPLY_URL=... npm run smoke`; the System page.
5. Rollback: in the Vercel project, promote a previous deployment, or `git revert` and push. Env var changes are not rolled back by redeploying an old build.
Do not rely on Vercel's runtime logs for history (short-lived); the durable record is `system_events` (System page).

### 2.4 Vercel CLI facts
Logged in as `reesick` on this laptop (`vercel whoami`), team `reesicks-projects`. `vercel project ls`, `vercel env ls production`, `vercel api /v9/projects/<name>` (metadata; env **values** are not shown for Sensitive vars), `vercel link --project <name>` in an empty folder to run `env add` (link creates `.vercel` and may download `.env.local`; delete both). The permission layer in Claude Code **blocked** an agent from running `vercel env add` (writing a secret to a secret store); the owner ran it themselves in their own terminal. There is no GitHub CLI and no gcloud on the laptop.

## 3. The Oracle VM

### 3.1 What is on it
| Item | Value |
|---|---|
| Instance | `jqp-dm-worker`, Oracle Always Free, `VM.Standard.E2.1.Micro`, Ubuntu 24.04, Mumbai, public IP **130.210.51.252**, user `ubuntu`, key `~/.ssh/oracle_jqp` (SSH keys only; password login disabled by `00-jqp.conf`) |
| Resources | 1 GB RAM (954 MB), 2 GB swapfile, 45 GB boot disk (12% used), Node v22.23.3 |
| Code | **No repo on the VM.** `/opt/jqp/bin/{dm-worker.mjs, selfcheck.mjs, vm-guard.mjs}` (esbuild bundles, 6.4 MB / 6.4 MB / 0.23 MB), `/opt/jqp/VERSION` (`9a3a310+uncommitted built 2026-10-14T09:02`), `/usr/local/bin/jqp` (control script) |
| Config | `/etc/jqp/worker.env` (mode 600 root) and `/etc/jqp/guard.env` (600 root); key names in file 00 section 3 |
| Users | `jqp` (runs the worker), `jqp-guard` (runs the guard); neither can read the other's env or process list (`ProtectProc=invisible`) |
| Units | `jqp-dm-worker.service` (enabled, active), `jqp-vm-guard.timer` + `.service` (every 60 s, first run 90 s after boot), `jqp-halt.path` + `jqp-halt.service` (force stop), all in `/etc/systemd/system/` |
| State | `/var/lib/jqp-guard/state.json` (guard state: per-check level and last alert time, month transfer accumulator, last report time, boot id) and the halt file `/var/lib/jqp-guard/halt` when stopped |
| Logs | `journalctl -u jqp-dm-worker` (journald capped at 100 MB by `/etc/systemd/journald.conf.d/jqp.conf`) |

### 3.2 The worker unit (hardening)
`ExecStart=/usr/bin/node --max-old-space-size=384 /opt/jqp/bin/dm-worker.mjs`, `Restart=always` `RestartSec=10`, `StartLimitIntervalSec=0` (keeps retrying), `MemoryMax=600M`, `MemorySwapMax=300M`, `ConditionPathExists=!/var/lib/jqp-guard/halt` (will not start while halted, even after reboot), plus `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, kernel/clock/hostname protections, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `SystemCallFilter=@system-service`, empty capability set, `UMask=0077`, and `IPAddressDeny=169.254.169.254` (no cloud metadata service). Systemd exposure scores 1.8 (worker) and 3.1 (guard). The worker is **enabled only by `jqp start`**; install and deploy never enable or start it, and a reboot does not start it unless it was enabled.

### 3.3 The `jqp` control command (on the VM)
`ssh -i $HOME\.ssh\oracle_jqp ubuntu@130.210.51.252`, then:

| Command | Does |
|---|---|
| `jqp status` | Worker service state, guard timer, and the live readings (service, disk, memory+swap, outbound data), restarts since boot, bundle version |
| `jqp check` | Read-only preflight inside the worker's sandbox: env present, database reachable (and port 6543), Redis reachable, how many DM jobs are waiting |
| `jqp start` | `systemctl enable --now jqp-dm-worker` (refuses if halted: use `resume`). **This is what begins sending DMs** |
| `jqp stop` | `systemctl disable --now` (stays stopped after reboot). Comments queue in Redis |
| `jqp restart` | Restart (refuses if halted or not enabled) |
| `jqp resume` | After a force stop: shows readings, asks "Cause fixed?", removes the halt file and starts the worker |
| `jqp rollback` | Swap `dm-worker.mjs` with `dm-worker.mjs.prev` (kept by `install.sh` when a new build differs; **there is no `.prev` on the VM right now** because the bundle has not changed) |
| `jqp logs` | Follow the worker log |
| `jqp test-email` | Send a test alert through the guard's mail settings |
| `jqp report` | Send the combined status email now (it also goes out every 6 hours) |

For a one-off in this environment I also ran the guard directly with `sudo systemd-run --pipe --wait --quiet -p User=jqp-guard -p EnvironmentFile=/etc/jqp/guard.env /usr/bin/node /opt/jqp/bin/vm-guard.mjs --report` (and `--dry-run --report` to print without sending). `jqp report` is the supported way.

### 3.4 The guard (`ops/vm/guard-core.ts`, `vm-guard.ts`)
Runs every minute, independent of Postgres and Redis (it needs only the `ALERT_*` mail settings, plus `DASHBOARD_URL` and `VM_REPORT_TOKEN` for the status email). Thresholds (override with `GUARD_*` lines in `guard.env`, e.g. `GUARD_DISK_WARN_PCT`):

| Check | Warn | Critical | Force-stop the worker |
|---|---|---|---|
| Boot disk used | 70% | 85% | **95%** (`GUARD_DISK_HALT_PCT`) |
| Memory available | < 150 MB | < 80 MB | no |
| Swap used | 50% | 80% | no |
| Outbound data this calendar month (sum of `/proc/net/dev` tx excluding lo/docker/veth/bridges, accumulated in state across reboots) | 5 GB | 20 GB | **95% of Oracle's 10 TB** (`GUARD_TRANSFER_HALT_PCT`) |
| Worker restarts between two checks | 2 | 5 | no |
| Worker service not active | | immediately | no |
| VM reboot | info email | | |

Alert behaviour: email on a level change (ok, warn, critical, back to ok), repeat every 6 hours while critical and every 24 hours while warn, a failed mail is retried the next minute, state saves never throw. The force stop works by writing the halt file; the root-owned `jqp-halt.path` unit stops the worker within a second; the worker unit's `ConditionPathExists=!` keeps it down across reboots. `jqp-halt.service` only acts while the file exists, so deleting the file (in `resume`) does not stop the worker you just started. Tested on the real VM on 2026-10-13.

Memory/crash-loop pressure never stops the worker (it costs nothing). Messages are not lost when the worker is stopped: the Vercel webhook still queues comments in Redis (`noeviction`); Meta accepts private replies for 7 days; and the poller recovers missed ones (**but only the last hour on this VM**, see file 01).

### 3.5 The combined status email
Every 6 hours (`REPORT_INTERVAL_MS`, `lastReportAt` in guard state) the guard builds one HTML+text email: it `POST`s `${DASHBOARD_URL}/api/cron/digest-data` with `Authorization: Bearer ${VM_REPORT_TOKEN}` (20 s timeout), receives the system section (13 checks, activity, rows), and adds the VM section (worker line, disk, memory/swap, outbound data against 10 TB, load, restarts, uptime, force-stop limits). Subject form: `[ALL OK] addaddy.ai: system 13/13, VM worker running, disk 12%`; `[WARNINGS]` or `[ATTENTION]` otherwise. **A missing or failed system fetch is shown in the email as "System report unavailable" and downgrades the headline to a warning, never to "all fine".** Sent first on demand on 2026-10-14 and verified to contain both halves. Meaning of silence: if this email stops arriving, the VM or its guard is down. The Vercel/GitHub digest (`/api/cron/digest`) is the older system-only version and would double up (file 00 item 4).

### 3.6 Deploying to the VM (from the laptop, PowerShell)
Everything is `scripts/deploy-dm-worker.ts`. It always rebuilds the bundle first, copies `dist/dm-host` to `/tmp/jqp-upload` (mode 700), then runs the requested steps. Flags: `--host user@ip`, `--key path`, `--install` (runs `install.sh`), `--push-env` (worker env from `vendor/openreply/.env`, **allowlisted**, and only if `DATABASE_URL` is on 6543 and `REDIS_URL` is set), `--push-guard-env` (mail settings plus the status-email settings), `--restart` (re-runs install and restarts **only if the worker is enabled and not halted**), `--dry-run`, `--lookback-hours N`, `--openreply-url URL`. It never prints env contents and never starts a stopped worker.

```powershell
cd D:\jqp
# ship a new build (code change in ops/, vendor/ or packages used by the bundle)
node --import tsx scripts/deploy-dm-worker.ts --host ubuntu@130.210.51.252 --key "$HOME\.ssh\oracle_jqp" --restart

# new database / Redis / Instagram secret for the worker (run `npm run sync-openreply-env` first)
node --import tsx scripts/deploy-dm-worker.ts --host ubuntu@130.210.51.252 --key "$HOME\.ssh\oracle_jqp" --push-env --restart

# new mail credentials or a new report token
$env:DASHBOARD_URL = 'https://jqp-web-tau.vercel.app'
$env:VM_REPORT_TOKEN = '<the token, from the owner>'      # only needed when replacing it
node --import tsx scripts/deploy-dm-worker.ts --host ubuntu@130.210.51.252 --key "$HOME\.ssh\oracle_jqp" --push-guard-env
```
Gotchas: `--push-guard-env` replaces the mail settings but **keeps** `GUARD_*` lines, and (since 2026-10-21) keeps the VM's existing `DASHBOARD_URL` and `VM_REPORT_TOKEN` when you do not supply new ones (before this fix a plain re-run silently dropped them and the email lost its system half). Deploys do not restart the worker unless you pass `--restart`, so the running process can be older than the files on disk (today: the process started 2026-10-13; the files are from 2026-10-14; the DM engine code is identical because `vendor/` and `ops/dm-worker` last changed 2026-10-13). `NEXTAUTH_URL` in the worker env is forced to the public OpenReply URL because DM links are built from it.

Rebuilding the VM from nothing: follow `docs/ORACLE-WORKER.md` sections 3 to 5 (create the instance with the same shape, add the SSH public key, run the deploy with `--install --push-env --push-guard-env`, `jqp test-email`, `jqp check`, `jqp start`). Ten to fifteen minutes; DMs queue in Redis meanwhile.

### 3.7 First-start safeguards (still in effect)
The deploy script writes `COMMENT_POLL_LOOKBACK_HOURS=1` and `COMMENT_POLL_MAX_PER_SWEEP=5` so the first start could never replay a backlog in a burst. They are still set (file 01 / file 00 open item 11b).

## 4. Who watches what (monitoring chain)

| Layer | Watches | Cadence | Delivers | Needs |
|---|---|---|---|---|
| VM guard | disk, memory, swap, outbound data, worker service, restarts, reboot | 1 min | email on change; force stop at limits | `guard.env` mail settings |
| VM combined status email | system (13 checks) + VM | 6 h | one HTML email | `DASHBOARD_URL`, `VM_REPORT_TOKEN`, Vercel `VM_REPORT_TOKEN` |
| Dashboard monitor (`/api/cron/monitor`) | the 13 system checks: database, dashboard password length, OpenReply, Redis, DM queue (>200 waiting), DM worker heartbeat (>2 min), DM delivery (failure rate >=10% warn, >=50% down, min 10 attempts), hourly send limit (70/90%), Instagram connection (token <=7 d warn, <=3 d or refresh failure down), publishing token, stuck posts (>30 min), campaign sync (failed, or not synced 15 min after publish), publishing (failed posts), plus "Dashboard data" if a read failed | 30 min | email when a check **starts** failing, once on recovery, reminder every 6 h | GitHub secret `MONITOR_TOKEN` + variable `MONITOR_URL` (UNVERIFIED), Vercel `MONITOR_TOKEN` and mail vars |
| Dashboard System page | same snapshot, live | on view | screen | login |
| Event log `system_events` | failures with correlation ids, publish and sync errors, token refreshes, retention runs | continuous | System page | migration 0008 |
| Oracle | idle-reclaim and maintenance mail; budget alert | Oracle's | email to the account owner | the account email must be read (UNVERIFIED budget alert exists) |
| OpenReply `/api/health` | database, Redis, queue, worker heartbeat | on request | JSON | none |
| `npm run doctor` / `smoke` | integration / outside-in | on demand | terminal | laptop `.env` (smoke needs explicit URLs) |

Blind spots to remember: a dead VM cannot email (the missing 6-hourly mail and the GitHub monitor are the signals, **if** the monitor is configured); nothing checks that Meta is actually delivering webhooks to non-role users; nothing alerts on the Redis connection being unencrypted; token expiry in OpenReply's copy is only visible on Settings/System.

## 5. Routine operations

| When | Do |
|---|---|
| Morning | Read the status email (or open `/system`). Anything amber/red: follow section 6 |
| Weekly | `npm run backup` (and copy it off the laptop); glance at the VM readings (`jqp status`); check Oracle's emails; confirm the publishing token renewed (System page shows days left, about 60 after a Monday refresh) |
| Monthly | Outbound data figure in the VM report; GitHub Actions minutes; Supabase database size (500 MB free) |
| Before any risky change | `npm run backup`; ensure `npm run doctor` is green; check no one else is mid-publish |
| After any deploy | `npm run doctor`, `smoke` with explicit URLs, System page |
| Before publishing | `docs/PUBLISHING.md`: start `npm run dev:worker`, wait for `worker_ready`, confirm correct post and account, click Publish once, leave the worker window open; stop with Ctrl+C when finished. Starting the worker consumes already-queued jobs |
| Before enabling a campaign | The post must be PUBLISHED; review copy (human voice, says it is automated, https link); the owner says go; then enable, wait for `DM_SYNCED`, test with a second account |

## 6. Runbooks

| Situation | Do |
|---|---|
| **Stop DMs now** | Dashboard System, "Pause all DMs" (also confirm in OpenReply's UI if needed). Or on the VM `jqp stop`. Comments queue and are answered later (within 7 days) |
| Worker crashed / restarting | `jqp status`, `jqp logs`. A crash loop is usually a wrong URL/secret in `worker.env`: fix locally, `sync-openreply-env`, `deploy ... --push-env --restart` |
| Guard says "STOPPED automatically" | Find the cause (disk: clear space; data: find what is sending), then `jqp resume`. Resume in the daytime if a backlog is large and watch `jqp logs`; a burst of identical DMs can trip Meta's spam checks |
| VM unreachable | Check the Oracle console (stopped? reclaimed?). Start it, or rebuild (section 3.6). The GCP backup worker is documented (`docs/GCP-WORKER.md`) but not built. Queued comments are safe in Redis for the 7-day window |
| Database password changed | `npm run rotate-db-password` updates Vercel and local files; then redeploy both Vercel projects and `deploy ... --push-env --restart` for the VM |
| Redis down | Fix at Redis Cloud; OpenReply `/api/health` will hang rather than error; restart the worker; the poller recovers missed comments within its look-back |
| Redis password changed | `npm run set-redis -- --vercel` (reads the new URL from the clipboard), redeploy, push to the VM |
| Meta rate-limited (80002) | Nothing to do; jobs retry by themselves (publish: 8 retries over about 4 hours). System shows `meta_throttled` |
| Instagram token expired / account mismatch | `npm run connect-account` (stop the publish worker first; `-- --expect addaddy.ai --check` first, run with `node --import tsx` form in PowerShell); then `connect-openreply-account` if OpenReply's copy is stale |
| Webhook stopped delivering | Meta console webhook status and subscription (`subscribed_apps`), app secret match (OperationalEvent "signature verification failed"), app Live mode / Advanced Access, `WebhookEvent` last time on the System page |
| Post stuck mid-publish | Publish worker not running; start it. If FAILED with `LIVE_CHECK_REQUIRED`, look at the Instagram profile before any Retry |
| A post may be live twice | Do not Retry. Compare profile vs `posts.instagram_media_id`; the safety checks make this unlikely |
| Campaign did not sync | Automations page shows `DM_SYNC_FAILED` + error; usually the account is not registered in OpenReply (`connect-openreply-account`), or the publish worker is off |
| Suspected compromise | `jqp stop`; rotate database, Redis, mail, Meta app secret and Instagram tokens; rebuild the VM; review `system_events` and Vercel logs |
| Disk full on the laptop | Free C: (Chrome data, Downloads, VS Code); use `D:\tmp` for temp (`$env:TEMP='D:\tmp'`). C: hit 0 GB on 2026-10-14; ~6 GB free on 2026-10-21 |

## 7. Secret rotation (procedure, never the values)

| Secret | Where it lives | Rotate with |
|---|---|---|
| Database password | root `.env`, `vendor/openreply/.env`, Vercel (both projects), VM `worker.env` | `npm run rotate-db-password` (needs a Supabase access token; delete the token afterwards), redeploy both projects, VM `--push-env --restart` |
| Redis URL/password | `OPENREPLY_REDIS_URL` root + Vercel `jqp-web`; `REDIS_URL` Vercel `jqp-openreply-1`; VM `worker.env` | `npm run set-redis -- --vercel`, redeploy, VM push |
| Brevo SMTP key | Vercel `ALERT_SMTP_PASS` (production), VM `guard.env`, root `.env` | `npm run set-env`, redeploy, VM `--push-guard-env` |
| Instagram app secret | Vercel both projects (`META_APP_SECRET`, `OPENREPLY_FACEBOOK_APP_SECRET`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`), root `.env`, VM `worker.env` | Reset in Meta console, update everywhere, `sync-openreply-env`, redeploy both, VM `--push-env --restart` (reset 2026-10-14 and updated on Vercel and locally; the handoff flagged the VM copy as still to do. `/etc/jqp/worker.env` was last modified 2026-10-13 18:55 UTC, before the worker started and before that reset, so the VM very likely still holds the **old** Instagram app secret (**UNVERIFIED**, contents not read). Impact is limited because the worker sends DMs with the account's access token, not the app secret, but push it: `deploy ... --push-env --restart`) |
| `ENCRYPTION_KEY` (ours) and OpenReply's | root `.env`, Vercel, VM (OpenReply's) | **Do not rotate** without reconnecting every account: stored tokens become unreadable |
| `DASHBOARD_SHARED_SECRET` | Vercel `jqp-web`, root `.env` | `npm run set-env` then redeploy; ends every session |
| `MONITOR_TOKEN` | Vercel `jqp-web`, GitHub Actions secret, root `.env` | `npm run set-env -- --generate`/`--clipboard`, update the GitHub secret, redeploy |
| `VM_REPORT_TOKEN` | Vercel `jqp-web` (production, Sensitive), VM `guard.env` | new random 32+ char value: `vercel env rm`/`add` in a linked folder (owner runs this), redeploy, then `$env:VM_REPORT_TOKEN=...; deploy ... --push-guard-env`. Today it is not stored in the root `.env` and the temp copy was deleted, so rotating is the clean way to ever redeploy it |
| Instagram access tokens | `ig_accounts` (encrypted), env fallback `META_LONG_LIVED_ACCESS_TOKEN`, OpenReply's `InstagramAccount` | auto-renewed weekly; manual: `connect-account` |
| Webhook verify token | root/Vercel `META_WEBHOOK_VERIFY_TOKEN` / OpenReply `WEBHOOK_VERIFY_TOKEN`, Meta console | change all three together, redeploy OpenReply |
| Supabase service-role key | Vercel, root `.env` | Supabase dashboard, then `set-env` and redeploy |
| Secrets once seen in chat (Redis password, Brevo key, Supabase access token) | | Rotate (file 00 item 3). The database password was rotated 2026-10-03 |

## 8. Cost and limits to keep an eye on
Plan tiers for Vercel, Supabase, Redis Cloud and Brevo are not recorded in the repo (**UNVERIFIED**; check each console). Known limits: Supabase free-plan database 500 MB and about 15 pooler clients; Redis memory (2.6 MB used on 2026-10-13); Oracle Always Free (10 TB outbound, 0.88 GB used this month); GitHub Actions 2,000 free minutes on private repos (about 1,500 used by the 30-minute monitor); Meta: 750 private replies per hour, 100 API posts per 24 hours.
