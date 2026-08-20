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

## 1. Supabase (already done per docs/SETUP.md)

Migrations run automatically on every deploy of our web app (Vercel's `vercel-build` script runs `npm run migrate` before `next build` — see step 2), tracked in a `_migrations_applied` ledger so reruns only apply new files. You can still run `npm run migrate` manually any time to check/apply outside a deploy.

## 2. Our web app → Vercel

1. New Project → import this repo.
2. **Root Directory**: `apps/web`
3. Framework preset: Next.js (auto-detected)
4. Environment variables: every key from `.env.example` except the `MOCK_META*` ones (leave `MOCK_META=false`) — see that file's comments for where each value comes from.
5. Deploy. Note the assigned domain (`your-app.vercel.app`) — this becomes `APP_BASE_URL` and `META_OAUTH_REDIRECT_URI`'s base. Update those two env vars to the real domain and redeploy.
6. Update the Meta app's OAuth redirect URI (`docs/SETUP.md` §2 Step 4) to `https://your-app.vercel.app/api/meta/oauth/callback`.

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
   - `DATABASE_URL`: the same Supabase connection string as our own app — see the pooler guidance in the root `.env.example` (session-mode only, never the transaction pooler)
   - `REDIS_URL`: Upstash
   - `RESEND_API_KEY`, `EMAIL_FROM`: from `docs/SETUP.md` §4
   - `NEXTAUTH_URL`: this Vercel project's own domain
   - `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, `CRON_SECRET`: generate fresh ones for production — do NOT reuse the local-dev values from `vendor/openreply/.env`
5. Deploy — the build runs `prisma generate` then `prisma migrate deploy` automatically (`vercel-build` script in `vendor/openreply/package.json`).
6. Update the Meta webhook callback URL (`docs/SETUP.md` §2 Step 5) to `https://{this-domain}/api/webhook`.

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
