# 04. External integrations: Meta, OpenReply and every third-party service

For each external system: what it is, why we use it, exactly how our code connects to it, how it is controlled, what its limits are, how it fails, and how to check it. Credentials are described by **variable name and storage location only** (file 06 is the access map). Facts come from code read on 2026-10-21 and the sourced research in `docs/COMPLIANCE-AUDIT-3.md` (2026-10-13). Anything unverified is marked **UNVERIFIED**.

## Inventory

| System | Role | Account / location | Section |
|---|---|---|---|
| **Meta Instagram API (Instagram Login)** | Publish posts, receive comment webhooks, send private replies and DMs | One Meta developer app, the owner's Meta developer account | 1 |
| **OpenReply** (vendored) | The comment-to-DM engine and its own web app | Vercel `jqp-openreply-1`; worker on the Oracle VM | 2 |
| **Supabase** | Postgres, Storage | project `jqp`, ref `rligoaiclwjwfbixnrry` | 3 |
| **Redis Cloud** | OpenReply's BullMQ queue | one database | 4 |
| **Vercel** | Hosts the dashboard and OpenReply | team/user `reesicks-projects` (CLI user `reesick`) | 5 |
| **Oracle Cloud** | Hosts the DM worker VM | Always Free tenancy, Mumbai | 6 |
| **GitHub** | Source, Actions scheduler | repo `reesick/jqp` (private), SSH remote | 7 |
| **Brevo** | SMTP for alert/status email | SMTP relay account | 8 |
| **Resend** | OpenReply's magic-link login email | Resend account in **test mode** | 8 |
| **AWS Bedrock** | Optional AI captions (off) | not in use | 9 |
| **Claude Code + MCP** | The operator's assistant | local | file 03 section 7 |

## 1. Meta / Instagram

### 1.1 Which API, and why
**Instagram API with Instagram Login** (graph.instagram.com), *not* Facebook Login for Business. No Facebook Page is involved. The Meta app type is **Business**, use case "Manage messaging and content on Instagram". Choosing the Facebook Login use case breaks the OAuth code (`packages/meta/src/oauth.ts`). One Meta app serves both our publisher and OpenReply, so both must use the same login product. The target account is a professional (Business/Creator) account: **@addaddy.ai**. Details of the console setup are in `docs/ADD-ACCOUNT.md` (partly superseded where `COMPLIANCE-AUDIT-3.md` disagrees).

### 1.2 Endpoints we call (all via `packages/meta`)
| Purpose | Call |
|---|---|
| OAuth code to short-lived token | `POST https://api.instagram.com/oauth/access_token` (form body) |
| Short to long-lived (about 60 days) | `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token` |
| Refresh a long-lived token | `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token` (token must be at least a day old and unexpired) |
| Who owns this token | `GET /me?fields=user_id,username` |
| Child container per image | `POST /{ig-user-id}/media` (`image_url`, `is_carousel_item`) |
| Carousel / single container | `POST /{ig-user-id}/media` (`media_type=CAROUSEL`, `children`, `caption`) |
| Container status | `GET /{container-id}?fields=status_code,status` |
| Publish | `POST /{ig-user-id}/media_publish` (`creation_id`) |
| Recent media (live-post check) | `GET /{ig-user-id}/media` (25 items) |
| Private reply / DM | `POST /{ig-user-id}/messages` with `recipient={"comment_id":...}` (OpenReply implements the button and link-button variants) |
| Public reply | `POST /{comment-id}/replies` |
| Webhook subscription | `POST /{ig-user-id}/subscribed_apps` |

`META_API_BASE` is `https://graph.instagram.com`; `META_GRAPH_VERSION` is a `vNN.N` string. `.env.example` says `v25.0`; the VM worker runs **v26.0** (read 2026-10-21); Meta says v25.0 is valid to 2028-07-29 and v26.0 is current. The Vercel values are Sensitive and cannot be read back (**UNVERIFIED** which version each project uses; the two halves tolerate a mismatch, but standardise when convenient).

### 1.3 Client behaviour (`packages/meta/src/client.ts`, `errors.ts`, `usage.ts`)
- `graphRequest`: up to 4 attempts, backoff 1 s, 3 s, 8 s plus jitter, only for retryable errors. A throttle Meta says lasts longer than 20 s is **not** waited out in-process; it is handed back to the queue.
- Error classes: codes 190, 102, 10 mean token/permission problems (`AuthError`, permanent, "reconnect the account"); 1, 2, 4, 17, 32, 613, **80002** (Instagram business-use-case throttle), HTTP 429 and 5xx are retryable (`RateLimitError` carrying the wait time from `Retry-After` / `estimated_time_to_regain_access`); 9004 is a dead media object; other 4xx are permanent. Everything else is retryable.
- Every response's `X-Business-Use-Case-Usage` header is parsed; at 75% an event `meta_usage_high` is recorded (at most one per 10 minutes) and a regain time becomes `meta_throttled`.
- `publishMedia` is a **single HTTP attempt** by design (no retry) because a lost reply must be handled by the "is it already live?" check, not by publishing again.

### 1.4 Tokens: types, storage, renewal
| Token | Where it lives | Lifetime and renewal |
|---|---|---|
| Publishing token for @addaddy.ai | `ig_accounts` (our table, encrypted with root `ENCRYPTION_KEY`), written by `npm run connect-account` or the dashboard's Connect Instagram. Fallback: env `META_LONG_LIVED_ACCESS_TOKEN` (bootstrap) | Long-lived about 60 days; **weekly job `refresh-ig-tokens`** (Mondays 03:00 UTC, in the local publish worker) renews stored tokens. As of 2026-10-21: valid 52 more days |
| OpenReply's token for the same account | `"InstagramAccount"."accessToken"` encrypted with OpenReply's own key; written by OpenReply's Connect Instagram or `connect-openreply-account` | OpenReply refreshes it with a daily Vercel cron (`/api/cron/refresh-tokens`, 05:00 UTC), which **fails silently**, so our Settings banner and System check "Instagram connection" are the only alert |
| App secret (Instagram App Secret and Facebook App Secret) | Vercel env (both projects) and root env; the VM worker has the Instagram app secret | Reset on 2026-10-14. Webhook signatures are HMAC-SHA256 of the raw body with the secret in `FACEBOOK_APP_SECRET` (falls back to the Instagram secret): a wrong one produces 401s and an `OperationalEvent` "Webhook signature verification failed" |
| Webhook verify token | `META_WEBHOOK_VERIFY_TOKEN` (root/Vercel `jqp-web`), `WEBHOOK_VERIFY_TOKEN` (OpenReply) | Static; must equal the value typed into the Meta console |

An **expired** token cannot be refreshed; the account must be reconnected (`npm run connect-account`, then `connect-openreply-account` if needed). Order matters: `connect-account` should be run with the publish worker **stopped** and restarted after.

### 1.5 Meta console configuration (what must be set there)
All of these were set up for the current account; re-verify in the console (it is a manual UI; there is no API check for most).

- App roles: the owner's account and a second test account as **Instagram testers**, invites accepted inside Instagram.
- Instagram product, Business login settings, **OAuth redirect URIs**: `https://jqp-web-tau.vercel.app/api/meta/oauth/callback` (dashboard) and `https://jqp-openreply-1.vercel.app/api/instagram/callback` (OpenReply). Exact match, no trailing slash.
- **Webhooks**: callback `https://jqp-openreply-1.vercel.app/api/webhook`, verify token as above. Account-level subscription fields: `comments`, `messages`, `messaging_postbacks`; **not** `messaging_seen` (deliberately off; it would activate OpenReply's "send anyway if the DM was read" fallback). OpenReply's connect step subscribes only `comments` and `messages`; `connect-openreply-account` subscribes all three. Verify with `GET https://graph.instagram.com/{version}/{ig-user-id}/subscribed_apps` (the console UI has shown "Subscribed" when the API returned nothing; do not use `GET /{app-id}/subscriptions`).
- Privacy policy, terms and data-deletion URLs: OpenReply serves `/privacy`, `/terms`, `/data-deletion` (all return 200 as of 2026-10-21). Entering them in the app dashboard is **UNVERIFIED**.
- App mode: **UNVERIFIED** (Development vs Live). `docs/COMPLIANCE-AUDIT-3.md` says Meta requires Live mode and Advanced Access for comment webhooks from non-role users.

### 1.6 Scopes
Dashboard OAuth requests `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_messages`. OpenReply's OAuth requests its own four, including `instagram_business_manage_insights` (only for OpenReply analytics pages we do not use; droppable or must be justified in App Review).

### 1.7 Rules and limits (sourced, see `docs/COMPLIANCE-AUDIT-3.md` for the quotes)
| Topic | Rule | How we comply |
|---|---|---|
| Comment webhooks | Need **Advanced Access** (App Review + Business Verification) and the app in **Live** mode; Development mode delivers none | **Open (file 00 item 1).** Whether Live mode alone on Standard Access delivers non-role comments is **UNVERIFIED**; the stranger test settles it |
| Private reply window | Within **7 days** of the comment, **one message** per comment | Unique `(automationId, commentId)`; BullMQ retries within the window |
| Follow-ups | Only if the recipient responds, within 24 hours; whether a button tap counts is UNVERIFIED | Two-step reveal; follow-up delay kept under 24 h |
| Rate | **750 private replies per hour per professional account**; error 80002 for Business Use Case throttling | Redis limiter with no headroom (open: lower to about 600) |
| Publishing | 100 API-published posts per 24 h moving window (carousel counts as one); one image JPEG; aspect 4:5 to 1.91:1; 8 MB; containers expire after 24 h | Validator and fail-fast on EXPIRED |
| Automation disclosure | Automated chat experiences must disclose that a person is interacting with an automated service | Every opening DM should say it is automated (checked in previews and launch review) |
| Consent | Developer Policy 5.2: do not message without legally sufficient consent/opt-in, and provide opt-out | Whether a keyword comment counts as opt-in is UNVERIFIED; **no STOP handling exists** |
| Data deletion | Delete platform data promptly on request | **Gap:** no per-person erasure script; retention is 30/90 days |
| Spam | Repetitive identical public replies look like spam | Public replies off by default; variants are an open item |
| Webhook retries | Meta retries failed deliveries for about 36 hours | Dedup by `jobId` and unique keys |
| Messaging API limits on tap-button template | Button title 20 chars, text 640 | Enforced in the bridge |

### 1.8 Checking Meta
`npm run doctor` section "Meta" (publishing token valid, webhook subscription readable); it printed "could not reach Meta" on 2026-10-21 because the laptop network timed out calling graph.instagram.com (14 s with curl), **not** because Meta was down; re-run when the network is steady. System page: "Instagram connection", "Publishing token", "Hourly send limit".

## 2. OpenReply (the DM engine)

### 2.1 What it is
Open-source "ManyChat alternative" (Next.js 16, Prisma 7, BullMQ, Auth.js). Vendored in `vendor/openreply` with its own README, CLAUDE.md, tests and `META_APP_REVIEW.md`. It has two runtime pieces:

1. **Web app + webhook** on Vercel (`jqp-openreply-1`): `/api/webhook` (GET handshake, POST signed events), `/api/health`, Instagram connect/callback, automations/logs/reports APIs, magic-link login, public legal pages, three daily crons.
2. **DM worker** (`worker/dm-worker.ts` -> `lib/queue/dm-worker.ts`): a long-running Node process, BullMQ consumer, comment poller and heartbeat. **It runs on the Oracle VM**, built into a 6 MB bundle by `scripts/bundle-dm-worker.ts`.

### 2.2 How we integrate (all through `packages/publisher/src/openreply-bridge.ts`)
- Shared Postgres, same `public` schema. We write `"Automation"` rows directly; we read `"InstagramAccount"`, `"DmLog"`, `"WebhookEvent"`, `"OperationalEvent"` for the dashboard (file 02 section 4).
- Shared Meta app: our env `META_APP_ID`/`META_APP_SECRET` become OpenReply's `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET` through `scripts/sync-openreply-env.ts`.
- Shared `META_WEBHOOK_VERIFY_TOKEN` (OpenReply reads it as `WEBHOOK_VERIFY_TOKEN`).
- The bridge column contract is the integration risk: OpenReply updates can change `"Automation"`. `npm run doctor` checks 21 columns.
- OpenReply's own `ENCRYPTION_KEY` is separate from ours.

### 2.3 Environment OpenReply needs
Generated into `vendor/openreply/.env` from the root env (never hand-edit): `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL` (6543), `REDIS_URL`, `RESEND_API_KEY`, `EMAIL_FROM` (or `EMAIL_SERVER`), `META_GRAPH_API_VERSION`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`. On Vercel `jqp-openreply-1` these are exactly the variables listed in file 05. The VM worker gets only `DATABASE_URL REDIS_URL ENCRYPTION_KEY INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET META_GRAPH_API_VERSION NEXTAUTH_URL` plus the two poll settings, so a stolen VM cannot forge dashboard sessions (`NEXTAUTH_SECRET`), call cron routes (`CRON_SECRET`), use the mail key, or sign webhooks.

### 2.4 Behaviour worth knowing
- Comment matching: `matchKeywords(commentText, keywords, wholeWordMatch)`; `matchAnyWord` fires on every comment.
- Idempotency and retries: file 01 section 6.
- **Polling safety net** exists because webhooks are best effort; see the 1-hour setting caveat in file 01.
- `requireFollow` (follow gating) exists in OpenReply but must stay off; its default prompt copy in the vendored worker says "star the repo on github" (do not use it).
- Inbound DMs (`messages` webhook) can also trigger automations that have `dmTriggerEnabled`; ours are created with it false.
- OpenReply keeps per-workspace monthly usage (`dmsSentThisPeriod`) and a `SKIPPED_PLAN_LIMIT` status from its SaaS billing code; in this deployment it is effectively unlimited (UNVERIFIED that no plan limit applies; `lib/billing/usage.ts`).
- Magic-link login mail goes through Resend in **test mode**, so it only reaches the owner's address; a second human cannot log in.
- **Exposure:** the site is public and registration is open (file 00 item 5).

### 2.5 Controlling it
| Want to | Do |
|---|---|
| Stop all DMs now | Dashboard System page, "Pause all DMs" (deactivates every automation); or on the VM `jqp stop` (comments then wait in Redis) |
| Stop one campaign | Automations page toggle off (deactivates the OpenReply automation first) |
| See what it is doing | Dashboard Activity and System pages; VM `jqp logs`; OpenReply's own dashboard (magic link) |
| Update OpenReply | Re-vendor into `vendor/openreply` only with the owner's approval; then run its migrations by hand, `npm run doctor`, rebuild the bundle, `deploy-dm-worker --restart` |

## 3. Supabase
- **Project** `jqp` (ref `rligoaiclwjwfbixnrry`), ap-south-1. Used as plain Postgres plus Storage. We never use Supabase Auth or the REST API from a browser; the `anon`/`authenticated` roles are locked out (file 02).
- **Access paths**: (a) pooled Postgres connection strings in env (session 5432 for us, transaction 6543 for OpenReply); (b) the service-role key `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_URL` for Storage (`packages/storage/src/client.ts`); (c) the Supabase web dashboard (SQL editor, where migrations were originally applied by hand); (d) the management API with a personal access token, used only by `npm run rotate-db-password` (the token should be deleted afterward).
- **Claude's Supabase connector** (`mcp__claude_ai_Supabase__*`): on 2026-10-03 it was found to belong to a **different account** (projects `Indradhanu`, `AUTONOMOUS_CRM`) and could not see `jqp`. Re-check with `list_projects` before using it; otherwise use the scripts.
- Free plan limits: 500 MB database, no automatic backups, session pooler about 15 clients, pausing after inactivity is possible on free projects (UNVERIFIED for this project; the traffic keeps it active).

## 4. Redis Cloud
Covered in file 02 section 7. Control: `npm run check-redis`; change with `npm run set-redis` (reads the new URL from the clipboard, proves it works, updates the root env, OpenReply env and Vercel with `-- --vercel`, then redeploy and update the VM worker env with `deploy-dm-worker --push-env --restart`). The Redis password once appeared in a chat transcript and **should be rotated** (file 00 item 3).

## 5. Vercel
Two live projects, both on the owner's Vercel account `reesicks-projects`, connected to the GitHub repo `reesick/jqp`: a push to `main` deploys both.

| Project | Root dir | URL | Notes |
|---|---|---|---|
| `jqp-web` | `apps/web` | https://jqp-web-tau.vercel.app | region `bom1`; build `vercel-build` |
| `jqp-openreply-1` | `vendor/openreply` | https://jqp-openreply-1.vercel.app | build command overridden to `npx prisma generate && npx next build` in the project settings; wired to Meta (webhook + OAuth) |
| `jqp-web-89h2` | `apps/web` | https://jqp-web-89h2-wheat.vercel.app | old duplicate, harmless, candidate for retirement |
| `jqp-openreply` | `vendor/openreply` | https://jqp-openreply-reesicks-projects.vercel.app | duplicate, **disconnected from GitHub on 2026-10-14** (it failed every deploy with a stale DB password); never reconnect |

Environment variable names per project and the deployment procedure are in file 05 section 2. Env values are **Sensitive** (write-only); change them with the helper scripts or `vercel env add`, then redeploy.

## 6. Oracle Cloud
Always Free tenancy; one VM `jqp-dm-worker` (shape `VM.Standard.E2.1.Micro`, AMD, 1/8 OCPU, 1 GB RAM, Ubuntu 24.04, 45 GB boot volume, public IPv4 130.210.51.252, Mumbai). Free allowance: up to 2 AMD micros, 200 GB storage, 10 TB outbound a month. **Idle VMs may be reclaimed** (CPU 95th percentile <20% and network <20% over 7 days); whether Pay-As-You-Go accounts are exempt is **unconfirmed**; the plan is to stay free and keep a GCP worker as backup (not built). A budget alert ($1) was recommended; whether it exists is **UNVERIFIED**. Full runbook: `docs/ORACLE-WORKER.md`; operations in file 05.

## 7. GitHub
Private repo `reesick/jqp`, remote over SSH (`git@github.com:reesick/jqp.git`), default branch `main`, 64+ commits. No GitHub CLI on the laptop. `.github/workflows/monitor.yml` calls the dashboard's cron endpoints: every 30 minutes `POST /api/cron/monitor`, daily 04:30 UTC `POST /api/cron/purge`, every 6 hours (05 minutes past) `POST /api/cron/digest`; it is **inert** until the Actions secret `MONITOR_TOKEN` (same value as Vercel's) and variable `MONITOR_URL` (`https://jqp-web-tau.vercel.app`) exist (**UNVERIFIED** whether they do). Free private-repo Actions minutes are 2,000 a month; the 30 minute cadence uses about 1,500. On a public repo GitHub disables scheduled workflows after 60 days without activity (n/a for a private repo, but a push or manual run re-enables).

## 8. Email: Brevo and Resend
| Service | Used by | Config | Notes |
|---|---|---|---|
| **Brevo** (SMTP relay `smtp-relay.brevo.com`, port 587 STARTTLS) | Dashboard alerts and digest (`packages/publisher/src/alerts.ts`, `digest.ts`) and the VM guard/status mail | `ALERT_SMTP_HOST/PORT/USER/PASS`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` on Vercel `jqp-web` (production) and in `/etc/jqp/guard.env` on the VM | TLS is required (`requireTLS`); credentials are never sent without it. The sender address must be verified in Brevo. If `ALERT_SMTP_HOST` is unset, the code falls back to Resend's HTTP API (`ALERT_RESEND_API_KEY`) |
| **Resend** | OpenReply magic-link login | `RESEND_API_KEY`, `EMAIL_FROM` on `jqp-openreply-1` | Test mode: delivers only to the owner's Resend address |

Test mail: `npm run test-email` (laptop), `jqp test-email` (VM). Status email now: `jqp report` (VM).

## 9. AWS Bedrock (optional, off)
`packages/ai` can draft captions (`npm run generate-caption`) when `AI_ENABLED=true`, requiring `AWS_REGION` and `BEDROCK_MODEL_ID` (credentials from env or a profile/role). The plan forbids putting it in the critical publishing path. The AWS variable names exist in Vercel, but this is not in use (**UNVERIFIED** that `AI_ENABLED` is false in production; the code works either way).

## 10. How to tell which external system is the problem
| Symptom | Likely system | First check |
|---|---|---|
| Dashboard 500 | Supabase pooler/URL | `curl .../api/health`; file 02 section 11 |
| Posts stay DISCOVERED after Publish | local publish worker not running | Is `npm run dev:worker` up? System "Posts in progress" |
| Campaign stuck `DM_SYNC_PENDING` | same worker, or OpenReply account not registered | `sync_error` on the campaign |
| Comments arrive, no DMs | DM worker down, Redis mismatch, or Meta not delivering (Advanced Access) | OpenReply `/api/health`; `jqp status`; `WebhookEvent` last time on System page |
| Webhook 401 in OpenReply events | App secret mismatch | `FACEBOOK_APP_SECRET`/`INSTAGRAM_APP_SECRET` on `jqp-openreply-1` |
| Publishing fails with auth error | Token expired/revoked or wrong account | `npm run connect-account --expect addaddy.ai --check` |
| No emails | Brevo creds/sender, or guard env missing on the VM | `npm run test-email`, `jqp test-email` |
| No 6-hourly status email | VM or its guard is down, or SMTP broken | `jqp status`, Oracle console |
| Everything slow from the laptop | Laptop network (graph.instagram.com took 14 s) | retry with curl before blaming a service |
