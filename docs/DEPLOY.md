# Deploying

Four services, two providers — matches the plan's target architecture (`instagram_automation_updated_plan-1.md` §92), adapted for OpenReply per its own deployment guidance (its README/docs/setup.md's "Do Railway first" section, swapped to Render since that's this project's worker preference):

| Service | Provider | Source |
|---|---|---|
| Our dashboard + API | Vercel | `apps/web` |
| Our publish worker | Render | `apps/worker` (Docker) |
| OpenReply's dashboard | Vercel | `vendor/openreply` |
| OpenReply's DM worker | Render | `vendor/openreply` (Node) |

Database and storage: your one Supabase project. Our tables and OpenReply's Prisma tables both live in the same `public` schema (verified zero name collisions — ours are snake_case, theirs are PascalCase model names; see `packages/publisher/src/openreply-bridge.ts` for why an isolated schema was tried and reverted), plus `pgboss` for the queue. Redis: Upstash, OpenReply only.

Do this in order — later steps need URLs/values from earlier ones.

> **Already deployed?** `docs/LIVE.md` has the actual production URLs, the working database connection string, and the build/database gotchas that were hit the first time round. Read that before re-treading this guide.

## 1. Supabase (already done per docs/SETUP.md)

Run migrations from your machine, not from the deploy:

```bash
npm run migrate
```

There is one Supabase project, and local and production both point at it — so running this locally *is* applying it to production. A `_migrations_applied` ledger means reruns only execute new files, so it's safe to run any time.

Deliberately NOT wired into the Vercel build. With one shared database the schema is already current by the time you deploy, so a build-time migration would be redundant, and a workspace-resolution hiccup inside Vercel's build sandbox would fail the whole deploy for no benefit. Run it here, then deploy.

## 2. Our web app → Vercel

1. New Project → import this repo.
2. **Root Directory**: `apps/web`
3. Framework preset: Next.js (auto-detected)
4. Environment variables: every key from `.env.example` except the `MOCK_META*` ones (leave `MOCK_META=false`) — see that file's comments for where each value comes from.
5. Deploy. Note the assigned domain (`jqp-web-89h2-wheat.vercel.app`) — this becomes `APP_BASE_URL` and `META_OAUTH_REDIRECT_URI`'s base. Update those two env vars to the real domain and redeploy.
6. Update the Meta app's OAuth redirect URI (`docs/SETUP.md` §2 Step 4) to `https://jqp-web-89h2-wheat.vercel.app/api/meta/oauth/callback`.

## 3. Our worker → Render

Use the root `render.yaml` (Blueprint):

1. Render dashboard → New → Blueprint → point at this repo.
2. It defines `jqp-worker` (this section) and `openreply-worker` (next section) as two services from one file.
3. For `jqp-worker`, fill in every env var marked `sync: false` in `render.yaml` — same values as the Vercel deployment.
4. Deploy. Check the Render logs for `worker_ready` and confirm `/` on the assigned internal port returns `{"status":"ok"}` (Render's own health check does this automatically).

## 4. OpenReply's web app → Vercel (separate project)

1. New Project → import this repo again (a second Vercel project against the same repo).
2. **Root Directory**: `vendor/openreply`
3. It ships its own `vercel.json` — no changes needed there.
4. Environment variables: everything from `vendor/openreply/.env.example`, with production values:
   - `DATABASE_URL`: the **session pooler** string (`aws-0-<region>.pooler.supabase.com:5432`, user `postgres.<project-ref>`), NOT the direct `db.<ref>.supabase.co` host — that one is IPv6-only and unreachable from Vercel. See `docs/LIVE.md`.
   - `REDIS_URL`: Upstash
   - `RESEND_API_KEY`, `EMAIL_FROM`: from `docs/SETUP.md` §4
   - `NEXTAUTH_URL`: this Vercel project's own domain
   - `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, `CRON_SECRET`: generate fresh ones for production — do NOT reuse the local-dev values from `vendor/openreply/.env`
5. Deploy — the build runs `prisma generate` then `prisma migrate deploy` automatically (`vercel-build` script in `vendor/openreply/package.json`). If it fails with **P3005 "schema is not empty"**, the database has the tables but no `_prisma_migrations` ledger; baseline it once per `docs/LIVE.md` rather than retrying the deploy.
6. Update the Meta webhook callback URL (`docs/SETUP.md` §2 Step 5) to `https://jqp-openreply-1.vercel.app/api/webhook`.

## 5. OpenReply's worker → Render

Second service in the same `render.yaml`, `openreply-worker`:

1. Fill in its env vars in the Render dashboard (same values as step 4, `ENCRYPTION_KEY` must match exactly between OpenReply's web and worker — different from our own `ENCRYPTION_KEY`, which is a separate secret store).
2. Deploy. OpenReply's own `docs/setup.md` and `docs/stack.md` (in `vendor/openreply/`) have more detail on this process if anything here is unclear — they document the equivalent Railway deployment, which the Render blueprint mirrors service-for-service.

## 6. Go-live checklist

- [ ] `DATABASE_URL` set via a Render **Environment Group** shared by `jqp-worker` and `openreply-worker`, not pasted into each service's dashboard independently — a group means one update (e.g. rotating the DB password) propagates to both instead of silently drifting out of sync
- [ ] All four services deployed and healthy (`/api/health` on both web apps, Render's own health check on both workers)
- [ ] Meta app **published** (Live, not Development) — see `docs/SETUP.md` §2 Step 7
- [ ] `messaging_postbacks` webhook field subscribed, and **verified via the Graph API** rather than the console UI (the console has shown "Subscribed" while the API returned an empty array) — required for the button-gated DM flow; see `docs/COMPLIANCE.md`
- [ ] All five requested OAuth scopes justified in the App Review submission — `vendor/openreply/META_APP_REVIEW.md` documents only three, and requesting an unjustified scope is a straightforward rejection; see `docs/COMPLIANCE.md`
- [ ] Retention purge confirmed running (worker logs `purge_schedule_registered` at boot, `purge_completed` daily)
- [ ] OAuth redirect URI matches the real Vercel domain exactly
- [ ] Webhook callback URL points at OpenReply's real domain, subscribed to `comments`
- [ ] Test comment → DM round-trip works end to end on a real (non-tester) account, or App Review is in progress for Advanced Access
- [ ] `ENCRYPTION_KEY` values for both apps backed up somewhere outside git — losing either means reconnecting every stored Instagram token
- [ ] Re-verify the items in `docs/SETUP.md` §6 (Meta API versions, permissions, rate limits) against Meta's current docs — this build's knowledge has a cutoff
