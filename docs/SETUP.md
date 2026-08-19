# Setup

Everything you need to do once, outside this repo, before anything can run for real: Supabase, the Meta developer app, Upstash Redis, and Resend. Read it in order — the Meta app is the slow part, budget an afternoon for it the first time (this is also what OpenReply's own setup guide says, and it's accurate).

This project uses **one Meta app for both halves**: our own publishing module (Module 2) and OpenReply's comment-to-DM engine (Module 3). Both use the **Instagram API with Instagram Login** — not Facebook Login for Business. That choice was made because OpenReply requires it; see `packages/meta/src/oauth.ts` for why our own OAuth code follows the same flow.

---

## 1. Supabase

You said you already have a Supabase project — this section is just the schema setup.

1. Open your project's **SQL Editor** in the Supabase dashboard.
2. Paste and run, **in this exact order**:
   - `supabase/migrations/0001_init.sql` — our tables (posts, post_media, campaigns, webhook_events, comment_events, dm_logs, ig_accounts)
   - `supabase/migrations/0002_rls.sql` — RLS default-deny (service_role only)
   - `supabase/migrations/0003_storage.sql` — the `instagram-media` public bucket
   - `supabase/migrations/0004_openreply_schema.sql` — a no-op safety net (an earlier isolated-schema approach was tried and reverted; OpenReply's tables live in `public` alongside ours — see `packages/publisher/src/openreply-bridge.ts`)
3. Alternatively, once `DATABASE_URL` is in your `.env`, run `npm run migrate` — it applies all four files for you (see `scripts/migrate.ts`). Safe to re-run.
4. Collect these values from **Settings → API** and **Settings → Database**:
   - Project URL → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`
   - `anon` key → `SUPABASE_ANON_KEY` (kept for completeness, not used for privileged writes)
   - Connection string (direct, port 5432 — not the transaction pooler) → `DATABASE_URL`

Why the direct connection and not the pooler: pg-boss (our job queue) holds session-level state (advisory locks, LISTEN/NOTIFY) that transaction-mode pooling breaks. See the comment in `.env.example` above `DATABASE_URL`.

---

## 2. The Meta app

### Step 1 — Create the app

Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) → Create App.

- Type: **Business**
- When asked for a use case, choose **Manage messaging and content on Instagram**. Do **not** choose "Authenticate with Facebook Login" — that's the other flow, and it breaks the OAuth code in this repo.

### Step 2 — Collect the three secrets

Everything goes into the root `.env` — there's only one file to edit (see `docs/LOCAL.md` §0). `npm run sync-openreply-env` copies the relevant values into `vendor/openreply/.env` for you afterward.

| Value | Where | Goes into (root `.env`) |
|---|---|---|
| Instagram App ID | Instagram product → API setup with Instagram Login | `META_APP_ID` (mapped to OpenReply's `INSTAGRAM_APP_ID`) |
| Instagram App Secret | same page, click Show | `META_APP_SECRET` (mapped to OpenReply's `INSTAGRAM_APP_SECRET`) |
| Facebook App Secret | App settings → Basic → App secret, click Show | `OPENREPLY_FACEBOOK_APP_SECRET` — only if it differs from the Instagram App Secret above; leave blank to reuse `META_APP_SECRET` (OpenReply checks webhook signatures against both secrets since Meta's signing key for this isn't consistently documented) |

### Step 3 — Add yourself as an Instagram tester

Required even for your own account, in development mode.

1. **Meta side**: App dashboard → App roles → Roles → Instagram testers → add your exact Instagram username → send invite.
2. **Instagram side**: open the Instagram app as that account → Settings and activity → Apps and websites → Tester invites → accept.

Skip this and you'll get "Insufficient Developer Role" on the login screen.

### Step 4 — Register the OAuth redirect

Instagram product → Set up Instagram business login → Business login settings → OAuth redirect URIs. Add, exactly, no trailing slash:

```
{APP_BASE_URL}/api/meta/oauth/callback
```

Locally this is `http://localhost:3000/api/meta/oauth/callback`. In production, your real Vercel domain.

### Step 5 — Configure the webhook

The webhook callback points at **OpenReply**, not our own app — comment-to-DM is entirely its territory now.

- Callback URL: `{OPENREPLY_URL}/api/webhook` (locally: `http://localhost:3100/api/webhook`, via the cloudflared tunnel described in `docs/LOCAL.md` — Meta cannot reach plain `localhost`)
- Verify token: the root `.env`'s `META_WEBHOOK_VERIFY_TOKEN` (mapped to OpenReply's `WEBHOOK_VERIFY_TOKEN` by `npm run sync-openreply-env`)
- Subscribe to the **comments** field
- Click Test → Send to My Server to confirm delivery (a row should appear in OpenReply's `WebhookEvent` table)

### Step 6 — Permissions requested

Both apps request the same permission set:

```
instagram_business_basic
instagram_business_content_publish
instagram_business_manage_comments
instagram_business_manage_messages
```

### Step 7 — Publish the app

Real webhook events only deliver once the app is Live, not Development. Publish item in the sidebar → set privacy policy / terms / data-deletion URLs (OpenReply ships these pages on its own domain, see its README) → Publish.

Publishing still only covers **Standard Access** — accounts with a role on the app (admins, developers, testers). Anyone else needs App Review for Advanced Access. See `vendor/openreply/META_APP_REVIEW.md` if you plan to go beyond your own accounts.

---

## 3. Upstash Redis (for OpenReply's BullMQ queue)

1. Create a free account at [console.upstash.com](https://console.upstash.com/redis).
2. New Database → any region close to wherever you'll host the worker.
3. Copy the connection string in **ioredis** format (`rediss://...`, TLS) → `OPENREPLY_REDIS_URL` in the root `.env`.

Not needed anywhere in our own app — only OpenReply uses Redis.

---

## 4. Resend (for OpenReply's login)

OpenReply's dashboard login is email magic-links only.

1. Create a free account at [resend.com](https://resend.com).
2. Verify a sending domain (or use a subdomain you control).
3. Create an API key → `OPENREPLY_RESEND_API_KEY` in the root `.env`.
4. Set `OPENREPLY_EMAIL_FROM` to an address on the verified domain.

Alternative: set `OPENREPLY_EMAIL_SERVER` instead to use your own SMTP server.

Then run `npm run sync-openreply-env` to push these into `vendor/openreply/.env`.

---

## 5. Instagram account requirements

Must be a **Business or Creator** account, not personal. Convert via the Instagram app: Settings → Account type.

---

## 6. Re-verify before production

Meta changes API versions, permissions, and login flows on its own schedule — this build's knowledge has a cutoff and OpenReply's repo may have moved on since it was cloned. Before going live, re-check against Meta's current developer docs:

- Current Graph API version (this build used `v25.0`, taken from OpenReply's own `.env.example` at clone time — re-verify)
- Current Instagram Login flow and scopes
- Current publishing permissions and rate limits
- Current webhook field subscriptions
- Current private-reply/messaging permissions and the 24-hour messaging window
- Current professional-account requirements
- Current app-review requirements for Advanced Access

Meta's documentation is authoritative. Everything in this repo — including OpenReply's own docs — is a reference, not the source of truth.
