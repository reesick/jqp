# Running it locally

Three stages, in order: mock Meta (no external accounts needed beyond Supabase), then real Supabase end-to-end, then real webhooks via a tunnel. Each stage is strictly more real than the last — don't skip to stage 3 before stage 1 works.

## Prerequisites

- Node 20+ (this repo was built and tested on Node 22.13.1)
- A Supabase project with `supabase/migrations/*.sql` applied (`docs/SETUP.md` §1)
- `npm install` at the repo root

## 0. Environment

There is **one** `.env` file to fill in, at the repo root — including the values OpenReply needs, even though it's a separate app with its own `vendor/openreply/.env`. That second file is *generated*, not hand-written (see the last step below).

```bash
cp .env.example .env
```

Fill in every value — `npm run check-env` tells you exactly what's missing and why. At minimum for stage 1 you need real Supabase values (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`) and can leave `MOCK_META=true`; the Meta-specific values just need to be *present* (any non-empty string satisfies the schema) since no real Meta call happens in mock mode.

```bash
npm run check-env
```

Whenever you fill in or change an `OPENREPLY_*` value (or a shared `META_*` one), regenerate OpenReply's own env file from it:

```bash
npm run sync-openreply-env
```

This writes `vendor/openreply/.env` from the root `.env` — `DATABASE_URL` is passed through as-is (same `public` schema as our own tables, verified collision-free), and the shared Meta values get mapped to OpenReply's own variable names. Don't hand-edit `vendor/openreply/.env`; it's regenerated, not maintained.

## 1. Stage 1 — mock Meta, real Supabase

This proves the entire publishing pipeline (folder → validate → upload → containers → carousel → publish → DB state) without touching real Instagram.

```bash
npm run migrate          # applies supabase/migrations/*.sql — safe to re-run
npm run mock-meta         # terminal 1 — fake Graph API on :8787
npm run dev:worker        # terminal 2 — our publish-post/sync-campaign worker
npm run dev:web           # terminal 3 — dashboard on :3000
```

Open `http://localhost:3000` → log in with `DASHBOARD_SHARED_SECRET` → Posts → **Ingest folder**, pointing at the sample:

```
D:\jqp\posts\POST_001
```

Click **Publish**. Watch the worker's logs step through `VALIDATING → UPLOADING → CREATING_CHILDREN → WAITING_FOR_CHILDREN → CREATING_CAROUSEL → WAITING_FOR_CAROUSEL → PUBLISHING → PUBLISHED`. The post detail page shows the same timeline. `instagram_media_id` will be a `media_..._<n>` string from the mock server, not a real Instagram ID.

Note: image uploads still go to your **real** Supabase Storage bucket — only the Meta side is faked. If a container comes back `ERROR` immediately, check that the `instagram-media` bucket's public-read policy applied correctly (`supabase/migrations/0003_storage.sql`).

`posts/POST_001` ships with 3 placeholder JPEGs + a caption, so this exercises the carousel path (children → carousel container → publish) by default. Delete `2.jpg` and `3.jpg` first if you want to see the single-image path instead.

Also try:
- Killing `npm run dev:worker` mid-publish and restarting it — the post resumes from its last persisted status instead of restarting (this is the crash-resumability the state machine is built around)
- The Campaigns page: create a campaign for the published post, enable it — this enqueues a `sync-campaign-to-openreply` job, which will fail cleanly (visible in the campaign's sync status) until OpenReply is running too (stage 2)

### Optional — AI captions

Off by default (`AI_ENABLED=false`). If you set it to `true` and fill in `AWS_REGION`/`BEDROCK_MODEL_ID` (and either `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or a local AWS profile/IAM role), you can generate `caption.md` instead of writing it by hand:

```bash
npm run generate-caption -- "D:\jqp\posts\POST_002" "a cozy neighborhood coffee shop, morning light, latte art"
```

This is a standalone pre-step — it writes the file and exits. The pipeline itself never calls Bedrock; ingest the folder afterward exactly as in stage 1.

## 2. Stage 2 — OpenReply, real Supabase + real Upstash

Needs the accounts from `docs/SETUP.md` §3–4 (Upstash Redis, Resend). Fill their values into the root `.env`'s `OPENREPLY_*` keys, then:

```bash
npm run sync-openreply-env
cd vendor/openreply
npm run db:generate                          # generates the Prisma client
npm run db:migrate                            # applies OpenReply's Prisma migrations into `public`
npm run dev -- -p 3100                        # terminal 4 — OpenReply's own dashboard, port 3100 (not 3000, avoids colliding with our web app)
npx tsx --env-file=.env worker/dm-worker.ts   # terminal 5 — OpenReply's own DM-send worker
```

Note the worker command: plain `npm run worker` (`tsx worker/dm-worker.ts`) does **not** load `.env` on its own — `tsx` doesn't auto-load env files, and unlike the Next.js dev server (which has its own built-in `.env` loading), this is a standalone script. Without `--env-file=.env`, it fails immediately with `DATABASE_URL environment variable is required`. Confirmed by testing, not assumed.

Open `http://localhost:3100` → sign in via the magic-link email (Resend) → **Settings → Connect Instagram** → this exercises the real Meta OAuth flow, so it needs the Meta app from `docs/SETUP.md` §2 fully configured, including the tester-account step.

Once connected, re-enable the campaign from stage 1 (or create a new one) — the sync job should now succeed and you'll see a matching `Automation` row in OpenReply's own dashboard.

Check `http://localhost:3100/api/health` any time — it reports OpenReply's own DB/Redis/worker health.

## 3. Stage 3 — real webhooks via a tunnel

Meta can't reach `localhost`. Use a tunnel to give OpenReply's webhook route a public HTTPS URL:

```bash
# no account needed
npx cloudflared tunnel --url http://localhost:3100
```

Copy the printed `https://*.trycloudflare.com` URL and use it as the webhook Callback URL in Meta's console (`docs/SETUP.md` §2 Step 5), pointing at `{tunnel-url}/api/webhook`. Update `NEXTAUTH_URL` in `vendor/openreply/.env` to the tunnel URL too while testing this way (OpenReply signs some URLs it generates, like tracked links, using `NEXTAUTH_URL`).

Comment on the published post from a **different** Instagram account (OpenReply ignores your own comments on purpose) with your campaign's trigger keyword. Watch:
- `WebhookEvent` (OpenReply, Postgres) — did the delivery arrive?
- OpenReply's worker logs — did it queue and process the comment?
- `DmLog` — did the private reply send?

If nothing happens, check OpenReply's `/api/health` first — most silent failures are the worker not running or not reaching Redis.

### Without a tunnel

You can still test the webhook handler logic directly with a signed synthetic payload:

```bash
npm run simulate-webhook -- --media-id <real-or-mock-media-id> --account-id <your-ig-user-id> --comment "INFO"
```

This posts a correctly-signed fake comment event straight to `http://localhost:3100/api/webhook` (see `scripts/simulate-webhook.ts`) — useful for checking the keyword-match → queue → send path without needing an actual Instagram comment or a tunnel.

## Common issues

- **"password authentication failed"** from the worker: `DATABASE_URL` is wrong or the password has special characters that need URL-encoding.
- **Container stuck IN_PROGRESS forever** (real Meta, not mock): normal for the first ~10-30s; the pipeline polls up to 30 times with backoff before giving up.
- **`STORAGE_PREFLIGHT_UNREACHABLE`**: the uploaded image's public URL isn't actually reachable — re-check `supabase/migrations/0003_storage.sql` was applied and the bucket is public.
- **OpenReply worker says `DATABASE_URL environment variable is required` and exits immediately**: you ran `npm run worker` directly instead of `npx tsx --env-file=.env worker/dm-worker.ts` — see the note in Stage 2 above.
- **`AdapterError` / `The table \`public.User\` does not exist`** during magic-link sign-in: means `vendor/openreply/.env`'s `DATABASE_URL` got a `?schema=` or `search_path` override added back in somehow. It must be the plain connection string, no schema override — OpenReply's tables live in `public`, same as ours (see `packages/publisher/src/openreply-bridge.ts` for the full explanation of why). Re-run `npm run sync-openreply-env` to regenerate it correctly.
