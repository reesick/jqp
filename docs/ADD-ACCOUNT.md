# Adding an Instagram account

How to plug this system into an Instagram account, what to verify, and what is honestly single-account today. Read section 10 before planning a second or third account.

Everything here was checked against the code in this repository on 2026-10-01. Meta's console labels and policies change; items that depend on Meta's current behavior are marked **(verify in Meta docs)**. Rules and scope justifications live in `docs/COMPLIANCE.md`.

---

## 1. Instagram account requirements

- The account must be an Instagram **professional account** (Business or Creator), not personal. Convert in the Instagram app: Settings, Account type.
- You need its login to accept the tester invite (section 3).
- For the comment trigger, comments must be on posts published to this account. The bridge ties an automation to a specific `instagram_media_id`, which the publisher records when the post goes live.
- Use the **Instagram-scoped user ID** (the `user_id` returned by the token exchange, or `GET https://graph.instagram.com/me?fields=user_id,username`). It is not a Facebook Page ID.

## 2. Meta developer app

One Meta app serves both halves (our publisher and OpenReply).

1. developers.facebook.com, Create App, type **Business**.
2. Use case: **Manage messaging and content on Instagram**. Do not pick "Authenticate with Facebook Login": it breaks the OAuth code in `packages/meta/src/oauth.ts` (`META_API_BASE` is `https://graph.instagram.com`).
3. Add the **Instagram API with Instagram Login** product.
4. Collect, from the Instagram product's API setup page: Instagram App ID, Instagram App Secret. From App settings, Basic: the Facebook App Secret. Mapping to env vars is in section 5.

## 3. Roles and testers (Development mode)

While the app is in Development mode only people with a role on the app can use it.

1. Meta side: App roles, Roles, Instagram testers: add the exact Instagram username and send the invite.
2. Instagram side: log in as that account, Settings and activity, Apps and websites, Tester invites: accept.

Skipping this gives "Insufficient Developer Role" on the consent screen. To test the comment-to-DM path you also need a **second** Instagram account with a role on the app to write the comment, because OpenReply ignores the connected account's own comments.

## 4. Scopes and why

Two OAuth flows exist, each requesting its own list.

| Scope | Requested by | Why |
|---|---|---|
| `instagram_business_basic` | both | Identify the professional account |
| `instagram_business_content_publish` | our dashboard OAuth (`apps/web/app/api/meta/oauth/start/route.ts`) | Publish carousels |
| `instagram_business_manage_comments` | both | Read comments (the trigger) and send private replies |
| `instagram_business_manage_messages` | both | Send DMs and receive the button postback |
| `instagram_business_manage_insights` | OpenReply only (`vendor/openreply/lib/meta/oauth.ts`) | Only for OpenReply's analytics pages, which this project does not use. Droppable or must be justified in App Review |

Our flow requests four scopes; OpenReply's requests a different four; the union is the five in `docs/COMPLIANCE.md`. Note that `docs/SETUP.md` Step 6 lists only the first four.

## 5. URLs to configure in Meta

Register all of these in the Meta app (Instagram product, Set up Instagram business login, Business login settings). No trailing slashes.

| Item | Value |
|---|---|
| OAuth redirect URI, dashboard | `https://jqp-web-tau.vercel.app/api/meta/oauth/callback` (equals `META_OAUTH_REDIRECT_URI`) |
| OAuth redirect URI, **OpenReply** | `https://jqp-openreply-1.vercel.app/api/instagram/callback` (OpenReply builds it as `NEXTAUTH_URL` + `/api/instagram/callback`, see `vendor/openreply/app/api/instagram/connect/route.ts`) |
| Webhook callback URL | `https://jqp-openreply-1.vercel.app/api/webhook` |
| Webhook verify token | the value of `META_WEBHOOK_VERIFY_TOKEN` (OpenReply reads it as `WEBHOOK_VERIFY_TOKEN`) |
| Privacy / Terms / Data deletion URLs | OpenReply ships `/privacy`, `/terms`, `/data-deletion` pages on its own domain |

The dashboard does **not** serve a webhook; there is no webhook route in `apps/web`. Webhooks go to OpenReply only.

Older docs only mention the dashboard redirect URI. Without the OpenReply one, "Connect Instagram" inside OpenReply fails with a redirect mismatch.

### Webhook fields

Per `docs/COMPLIANCE.md`:

| Field | Subscribe? |
|---|---|
| `comments` | Yes, required |
| `messaging_postbacks` | Yes, required for the button flow (without it the tap does nothing and nothing errors) |
| `messages` | Optional. OpenReply's connect step subscribes it automatically (`subscribeInstagramAccountToWebhooks` sends `comments` and `messages`) |
| `messaging_seen` | **No, deliberately off.** Keeps OpenReply's "send anyway if the DM was read" fallback dormant |

OpenReply's connect step does not subscribe `messaging_postbacks`. Add it with the account-level API (this call needs a valid token for the account; it is shown with placeholders):

```bash
curl -s -X POST "https://graph.instagram.com/${META_GRAPH_VERSION}/${IG_USER_ID}/subscribed_apps" \
  -H "Authorization: Bearer ${IG_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"subscribed_fields":["comments","messages","messaging_postbacks"]}'
```

Whether a repeated POST replaces or merges the field list is **(verify in Meta docs)**; always list every field you want and then confirm with the check in section 7. `${META_GRAPH_VERSION}` is `v25.0` in `.env.example`; `docs/COMPLIANCE.md` and `docs/PRODUCTION.md` examples use `v26.0`. Use whichever your deployment sets and check Meta's changelog.

## 6. Environment variables: what goes where

Names come from `.env.example`, `packages/core/src/env.ts` (required by `loadEnv`) and `scripts/sync-openreply-env.ts`. Values live in `.env` at the repo root; never paste them into chats.

### 6.1 Dashboard: Vercel project `jqp-web`, and the local publish worker

Both call `loadEnv()`, so both need every **required** variable, even ones they do not use.

| Variable | Notes |
|---|---|
| `APP_BASE_URL` | `https://jqp-web-tau.vercel.app` on Vercel |
| `DASHBOARD_SHARED_SECRET` | Dashboard login |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Storage + server access |
| `DATABASE_URL` | Session pooler, port 5432 |
| `SUPABASE_STORAGE_BUCKET` | Defaults to `instagram-media` |
| `META_APP_ID`, `META_APP_SECRET` | Instagram App ID / secret |
| `META_GRAPH_VERSION`, `META_API_BASE` | e.g. `v25.0`, `https://graph.instagram.com` |
| `META_IG_USER_ID` | **Required by the schema** (see section 10) |
| `META_OAUTH_REDIRECT_URI` | The dashboard callback above |
| `META_WEBHOOK_VERIFY_TOKEN` | Required by the schema; same value OpenReply uses |
| `ENCRYPTION_KEY` | 64 hex chars; encrypts `ig_accounts` tokens |
| `BRIDGE_SHARED_SECRET` | Required by the schema |
| `OPENREPLY_DASHBOARD_URL` | `https://jqp-openreply-1.vercel.app` |
| `META_LONG_LIVED_ACCESS_TOKEN` | **The token publishing actually uses today.** Optional in the schema, but the **local publish worker needs it** or posts fail with "No Instagram account connected". Not needed by the Vercel dashboard for anything it does today (unverified beyond reading the code) |
| `RAW_PAYLOAD_RETENTION_DAYS`, `PII_RETENTION_DAYS`, `QUEUE_CONCURRENCY`, `DB_POOL_MAX` | Optional with defaults |

### 6.2 OpenReply: Vercel project `jqp-openreply-1`, and the DM worker host

| Variable (OpenReply's name) | Root `.env` source |
|---|---|
| `NEXTAUTH_URL` | OpenReply's own public URL (Vercel). Wrong value silently breaks magic-link login |
| `NEXTAUTH_SECRET`, `CRON_SECRET` | `OPENREPLY_NEXTAUTH_SECRET`, `OPENREPLY_CRON_SECRET` |
| `ENCRYPTION_KEY` | `OPENREPLY_ENCRYPTION_KEY`. A different value from ours; **must be identical on the web project and the DM worker** |
| `DATABASE_URL` | Same session pooler string |
| `REDIS_URL` | `OPENREPLY_REDIS_URL` (Upstash `rediss://`). Identical on web and worker |
| `RESEND_API_KEY`, `EMAIL_FROM` (or `EMAIL_SERVER`) | `OPENREPLY_RESEND_API_KEY`, `OPENREPLY_EMAIL_FROM` / `OPENREPLY_EMAIL_SERVER` |
| `META_GRAPH_API_VERSION` | `META_GRAPH_VERSION` |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | `META_APP_ID`, `META_APP_SECRET` |
| `FACEBOOK_APP_SECRET` | `OPENREPLY_FACEBOOK_APP_SECRET`, falling back to `META_APP_SECRET` |
| `WEBHOOK_VERIFY_TOKEN` | `META_WEBHOOK_VERIFY_TOKEN` |

`npm run sync-openreply-env` produces this file locally. On Vercel and on the worker host, set the same values in the provider's settings or copy the generated file (`docs/ORACLE-WORKER.md`). Whether the DM worker strictly needs every variable above is unverified; giving it the full file is the safe choice.

## 7. Connecting the account

Two connections, and they are independent today.

### 7.1 OpenReply connection (required for comment-to-DM)

1. Open https://jqp-openreply-1.vercel.app, sign in by magic link.
2. Settings, **Connect Instagram**, approve the consent screen.
3. OpenReply stores the encrypted token in its `InstagramAccount` table and subscribes the account to `comments` and `messages`.
4. Add `messaging_postbacks` (section 5) and verify.

The bridge (`resolveOpenReplyAccount` in `packages/publisher/src/openreply-bridge.ts`) looks up `InstagramAccount` by the Instagram user ID. If that row is missing, campaign sync fails with `OPENREPLY_ACCOUNT_NOT_CONNECTED`.

### 7.2 Publishing credentials

Bootstrap path (what is effectively used now): set `META_IG_USER_ID` and `META_LONG_LIVED_ACCESS_TOKEN` in the env of the machine running `apps/worker`. `resolveAccountForPost` (`packages/publisher/src/repository.ts`) uses them whenever a post has no `ig_account_id`.

Dashboard OAuth path: Settings, **Connect Instagram** (`/api/meta/oauth/start`) sends you through Instagram consent, then `/api/meta/oauth/callback` exchanges the code, upgrades to a long-lived token, and saves it encrypted in `ig_accounts` (shows under "Instagram accounts" on Settings). **Caveat found while writing this guide:** nothing in the codebase ever sets `posts.ig_account_id` (no code writes that column; it is only read), so the publish pipeline does not currently use the `ig_accounts` token. Connecting via the dashboard records the account and its expiry but does not change which token publishes. Treat the env-var token as authoritative until that is wired up (section 10).

Getting a long-lived token for the bootstrap variable: run the dashboard OAuth flow, or use the Instagram API setup page's token generator in the Meta console **(verify in Meta docs)**. Long-lived tokens last about 60 days and can be refreshed; nothing in this repo refreshes the bootstrap token on a schedule, so put the renewal date in a calendar.

## 8. Verification

Replace placeholders; do not paste real tokens into shared places.

**Dashboard health** (DB liveness only):

```bash
curl -s https://jqp-web-tau.vercel.app/api/health
```

Expect `{"success":true,"db":"ok",...}`.

**OpenReply health** (database, redis, queue, worker heartbeat; a 503 with `worker.healthy:false` just means the DM worker is not running):

```bash
curl -s --max-time 20 https://jqp-openreply-1.vercel.app/api/health
```

If it hangs, see the Redis note in `docs/LIVE.md` and the README runbook.

**Webhook verification handshake** (placeholder token):

```bash
curl -s -w " HTTP:%{http_code}\n" "https://jqp-openreply-1.vercel.app/api/webhook?hub.mode=subscribe&hub.verify_token=<YOUR_VERIFY_TOKEN>&hub.challenge=OK"
```

Expect `OK HTTP:200` when the token matches. A wrong token must not echo the challenge.

**Subscribed fields** (authoritative; the console UI has shown "Subscribed" when the API returned nothing):

```bash
curl -s "https://graph.instagram.com/${META_GRAPH_VERSION}/${IG_USER_ID}/subscribed_apps" -H "Authorization: Bearer ${IG_ACCESS_TOKEN}"
```

Expect `subscribed_fields` to contain `comments` and `messaging_postbacks` and **not** `messaging_seen`. Do not use `GET /{app-id}/subscriptions` against the Facebook app; it returns an empty list even when things work (`docs/COMPLIANCE.md`).

**Signed fake comment** against local OpenReply: `npm run simulate-webhook -- --media-id <id> --account-id <ig-user-id> --comment "INFO"`.

**End to end**: publish a post from the local worker, enable a campaign, wait for `DM_SYNCED`, comment the keyword from a tester account, confirm the button DM, tap it, confirm the link arrives (`docs/PRODUCTION.md` section 10).

### Pre-flight checklist (copy, paste, tick)

```
[ ] Instagram account is Business/Creator
[ ] Meta app type Business, use case "Manage messaging and content on Instagram", product "Instagram API with Instagram Login"
[ ] Account added as Instagram tester AND invite accepted (Development mode)
[ ] A second tester account exists to write test comments
[ ] Redirect URI registered: https://jqp-web-tau.vercel.app/api/meta/oauth/callback
[ ] Redirect URI registered: https://jqp-openreply-1.vercel.app/api/instagram/callback
[ ] Webhook callback https://jqp-openreply-1.vercel.app/api/webhook saved and verified in Meta
[ ] Verify token in Meta == META_WEBHOOK_VERIFY_TOKEN == OpenReply WEBHOOK_VERIFY_TOKEN
[ ] Account connected in OpenReply (Settings, Connect Instagram)
[ ] subscribed_apps shows comments + messaging_postbacks, NOT messaging_seen (checked via API)
[ ] META_IG_USER_ID and META_LONG_LIVED_ACCESS_TOKEN set on the machine running apps/worker
[ ] jqp-web env: APP_BASE_URL, META_OAUTH_REDIRECT_URI, OPENREPLY_DASHBOARD_URL on the tau domain
[ ] DATABASE_URL is the session pooler (:5432) everywhere
[ ] OpenReply ENCRYPTION_KEY and REDIS_URL identical on web and DM worker
[ ] /api/health ok on both web apps; OpenReply worker.healthy true
[ ] DM worker running on its host (docs/ORACLE-WORKER.md)
[ ] Local publish worker can start (npm run dev:worker) and logs worker_ready
[ ] Opening-DM copy discloses it is automated
[ ] Token expiry date noted in a calendar (about 60 days)
```

## 9. Going live: App Review

Real (non-tester) users and real webhook delivery need the app **Live**, and using the permissions for accounts without a role on the app needs **Advanced Access** via App Review.

1. Privacy policy, Terms and data-deletion URLs set in the app (OpenReply's pages), then Publish the app (Live mode). In Development mode only the console Test button delivers webhook events (`vendor/openreply/docs/setup.md`).
2. Submit each permission you use with a screencast and written justification. `vendor/openreply/META_APP_REVIEW.md` covers three scopes; you must also justify `instagram_business_content_publish` and either `instagram_business_manage_insights` or drop it (`docs/COMPLIANCE.md`).
3. Complete Business Verification if Meta asks **(verify in Meta docs)**.
4. Re-check the rules in `docs/COMPLIANCE.md` against live docs before submitting; they change.
5. After approval, run the verification section again on a non-tester account.

For your own single account, Standard Access (Live mode, with yourself as a role holder) is enough; App Review is only required to serve other people's accounts.

## 10. Current limitations for multiple accounts

Honest state as read from the code on 2026-10-01. The data model has a seam for many accounts; the running system is single-account.

| Area | Today | Evidence |
|---|---|---|
| Environment | `META_IG_USER_ID` is **required** by the env schema, so the app will not boot without exactly one default account ID | `packages/core/src/env.ts` |
| Publish token | Single env token (`META_LONG_LIVED_ACCESS_TOKEN`) is used for every post. `posts.ig_account_id` exists and `resolveAccountForPost` would honor it, but nothing ever sets it, so there is no per-post account choice | `repository.ts`, `supabase/migrations/0001_init.sql` |
| Dashboard OAuth | Can store multiple rows in `ig_accounts` (`on conflict (ig_user_id)`), so connecting account B does not overwrite A, but they are not used for publishing | `upsertIgAccount` |
| Dashboard UI | No account switcher; Posts, Campaigns and Activity are not filtered by account. Settings lists all `ig_accounts` | `apps/web/app` |
| Ingest | Folder to post has no account field | `ingestPostFolder` |
| Comment-to-DM | The bridge resolves the account via `resolveIgUserIdForPost`, which falls back to `META_IG_USER_ID`. Campaigns for account B would be created against account A's `InstagramAccount` unless `posts.ig_account_id` is set | `openreply-bridge.ts` |
| OpenReply | Supports several `InstagramAccount` rows per workspace and automations are per account, but each account must be connected through OpenReply's own login flow and each needs its own webhook subscription (`subscribed_apps`) | `vendor/openreply` |
| Token health banner | Reads OpenReply's accounts (all of them) | `packages/publisher/src/stats.ts` |
| Publishing host | Local worker only, because post folders are on your disk. Does not scale by adding accounts; it is one operator machine | `docs/LIVE.md` |
| Rate limits | OpenReply's 750 sends/hour/account constant is unverified | `docs/COMPLIANCE.md` |
| Dashboard auth | One shared secret, no per-user or per-account permissions | `apps/web/middleware.ts` |
| Env-only constants | Retention, Graph version and app credentials are global, which is correct for one Meta app | |

### Recommended path to scale

1. **Make the account explicit.** When ingesting, choose an `ig_accounts` row and write `posts.ig_account_id`. The resolver and the bridge already honor that column, so this is the smallest change that unlocks per-account tokens.
2. **Relax `META_IG_USER_ID`** to optional (a default/bootstrap only) in `packages/core/src/env.ts`, and stop relying on `META_LONG_LIVED_ACCESS_TOKEN` once accounts are in `ig_accounts`.
3. **Refresh tokens** for `ig_accounts` on a schedule (a pg-boss job in `apps/worker`; the `refreshLongLivedToken` helper exists in `packages/meta/src/oauth.ts` but nothing calls it).
4. **Add an account dimension to the UI**: a switcher, filters on Posts, Campaigns and Activity, and per-account token banners.
5. **Connect each account in OpenReply** and subscribe each to `comments` and `messaging_postbacks`.
6. Reconfirm the OpenReply rate limit per account and the per-person (not per-comment) dedup limitation before multiplying traffic.
7. **Meta side:** add each new account as a tester while in Development mode; once Live with Advanced Access, any professional account can authorize.
8. Keep publishing local until folders move to a shared location (for example uploading media at ingest time instead of reading `folder_path` at publish time); that would also allow a hosted publish worker.

These are design recommendations, not implemented features. The changes in steps 1 to 4 are application code and were deliberately not made as part of this documentation pass.
