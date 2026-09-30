# Morning checklist

What is left that only the account owner can do, in order of importance. Everything in code that could be done safely without you has been done; these need your logins or a decision.

After each step, `npm run doctor` tells you whether it worked. `npm run smoke` checks the deployed site from outside.

## Blocking: nothing sends DMs or posts until these are fixed

### 1. Replace the dead Redis (DMs are down)
Upstash database `joint-civet-121910` no longer exists (its hostname does not resolve). OpenReply cannot queue a single DM without Redis.

1. Sign in at console.upstash.com (try each login: Google, GitHub, email) and look for that database. If it is gone on every account, create a new Redis database. Choose the region closest to Mumbai.
2. **Use a paid plan for this workload.** The free tier allows 500K commands per month. BullMQ polls Redis even when idle, and the review estimated 0.6 to 1.5M per month before any traffic. Pay-as-you-go is $0.2 per 100K commands; the $10 fixed plan is the predictable option. (Estimate, not measured: watch the Upstash usage graph for a week.)
3. Copy the `rediss://…` connection URL and set it everywhere the old one was used:
   - `vendor/openreply/.env` → `REDIS_URL`
   - root `.env` → `OPENREPLY_REDIS_URL`
   - Vercel project `jqp-openreply-1` → `REDIS_URL` (Production), then redeploy
   - Vercel project `jqp-web` → `OPENREPLY_REDIS_URL` (kept for consistency)
   - the DM worker host (Render or the Oracle VM) → `REDIS_URL`, then restart it
4. Run `npm run check-redis` (prints only host/port, never the password).

### 2. Meta says "API access blocked" (posting is blocked)
Every call to `graph.instagram.com` with the publishing token returns error code 200, "API access blocked", on every API version, including the token refresh call. Because refresh fails too, this points at the Meta **app**, not just the token.

1. Open developers.facebook.com → your app. Look for a red banner, an Alerts or Notifications item, a "Restricted" app status, or a message under Settings → Advanced.
2. Confirm the app is in the state you expect (Development or Live), that the **Instagram API with Instagram Login** product is still added, and that your Instagram account still has a role on the app.
3. If there is no restriction, generate a fresh token through the app's Instagram login flow and put it in `META_LONG_LIVED_ACCESS_TOKEN` (root `.env` and Vercel `jqp-web`).
4. Run `npm run doctor`. The Meta section should turn green.

I could not determine the exact cause from here. Do not guess; the dashboard banner will say.

### 3. Database password is stale on your machine
`npm run doctor` fails to log in to the database from this computer: "password authentication failed". Vercel works, so its copy is right and the local copies are old.

1. Supabase dashboard → Project Settings → Database → copy the **session pooler** connection string (port 5432; user looks like `postgres.<project-ref>`).
2. Put it in root `.env` → `DATABASE_URL` and `vendor/openreply/.env` → `DATABASE_URL`.
3. Also update `DATABASE_URL` on the DM worker host, and `jqp-openreply-1` on Vercel if you reset the password recently.

This breaks the local publish worker, the MCP server for Claude Code, and `npm run doctor` until fixed.

### 4. Connect the Instagram account inside OpenReply
Campaigns are copied into OpenReply's database, and that needs an Instagram account connected **in OpenReply's own dashboard** (separate from the jqp dashboard's Connect button). `npm run doctor` reports if none exists. Its redirect URI is `/api/instagram/callback` on the OpenReply domain; add it in the Meta app settings first.

After connecting, subscribe the account to webhooks for `comments` and `messaging_postbacks` (postbacks must be added through the API; see `docs/ADD-ACCOUNT.md`).

## Do next

### 5. Apply migration 0008 (monitoring tables and DM indexes)
Supabase dashboard → SQL Editor → paste `supabase/migrations/0008_system_events.sql` → Run. The code works without it (it skips recording), but the System page loses its error history and alert state until it is applied. (Migration 0007, closing the media bucket listing, is already applied and verified.)

### 6. Turn on alerts
1. Generate a token: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
2. Vercel `jqp-web` environment: `MONITOR_TOKEN` (that token), `ALERT_EMAIL_TO` (your email), `ALERT_RESEND_API_KEY`, `ALERT_EMAIL_FROM` (a sender on a domain verified in Resend). Redeploy.
3. GitHub repo → Settings → Secrets and variables → Actions: secret `MONITOR_TOKEN` (same value), variable `MONITOR_URL` = `https://jqp-web-tau.vercel.app`.
4. Actions tab → "monitor" → Run workflow once. The System page (Ctrl+K → "System") should show fresh checks.

This also runs the data-retention purge daily from the cloud, so it no longer depends on your PC being on.

### 7. Security hygiene
- Set a dedicated random `CRON_SECRET` on Vercel `jqp-openreply-1`. Without it, OpenReply's cron routes accept `Bearer undefined`.
- Rotate `DASHBOARD_SHARED_SECRET` to 32+ random characters (you will be logged out once).
- Retire the duplicate Vercel projects `jqp-web-89h2` and `jqp-openreply` once nothing points at them. Meta's webhook and redirect URIs must point at the ones you keep.

### 8. Plug it into Claude Code
See `docs/CLAUDE-CODE.md`. The short version: open this folder in Claude Code, approve the `jqp` server when asked, and say "check system health".

## Known gaps (not fixed, by decision or because they need a bigger change)

From `docs/DATA-PROTECTION.md`, the items that matter before scaling past a few hundred DMs a day:
- **No per-person erasure path.** OpenReply's `/data-deletion` page is informational only. Meta's terms expect a clearly marked way to request deletion. A SQL procedure is outlined in the document; a real endpoint is not built.
- **Bursts can lose comments.** The rate limiter is a fixed window; after 3 requeues a comment is marked skipped and never answered.
- **No opt-out handling** was found in OpenReply.
- **Publishing still uses one token from an env var**, and nothing refreshes it every 60 days. Multi-account needs the pipeline to read `ig_accounts`.
- **`sharp` has two high advisories**; fixing it is a breaking upgrade in the publish path.
- **CSP header** is not shipped (needs testing on a preview).
