# Production readiness

Everything that must be true before this system runs on real traffic, and the commands to re-verify each claim later. Written to be auditable — if a line here says something is safe, there's a command next to it that proves it.

Companion docs: `docs/DEPLOY.md` (how to deploy), `docs/COMPLIANCE.md` (Meta platform rules), `docs/SETUP.md` (first-time setup).

---

## 1. Database access — CRITICAL, done

Supabase grants `ALL` on every `public` table to `anon` and `authenticated` by default. Those roles answer to the publishable/anon key, which is designed to be shipped in a browser.

`0002_rls.sql` protected our 7 snake_case tables. OpenReply's 16 PascalCase tables arrived later via Prisma into the same schema and were never covered — so with only the anon key it was possible to read **and write** `Session.sessionToken`, `VerificationToken.token`, `User.email`, `InstagramAccount.accessToken`, `DmLog` commenter PII, `WebhookEvent.payload`, and `Automation.dmMessage`.

Fixed by `supabase/migrations/0006_lockdown_public_api_roles.sql`: revoke all privileges, enable + force RLS with zero policies, revoke schema `USAGE`, and `ALTER DEFAULT PRIVILEGES` so tables created by future Prisma deploys stay locked.

- [x] Applied (`npm run migrate`)
- [x] Verified: anon returns `42501` on read and write for every table
- [x] Verified: a newly created table receives no anon/authenticated grant

**Re-verify any time** — every line must return `42501`, not `[]` (an empty array would mean RLS without revoke, which is weaker):

```bash
cd /d/jqp && URL=$(grep '^SUPABASE_URL=' .env | cut -d= -f2) && ANON=$(grep '^SUPABASE_ANON_KEY=' .env | cut -d= -f2) && for t in Session VerificationToken User DmLog InstagramAccount posts; do echo -n "$t => "; curl -s "${URL}/rest/v1/${t}?select=*&limit=1" -H "apikey: ${ANON}" -H "Authorization: Bearer ${ANON}" --max-time 15 | head -c 60; echo; done
```

> **Landmine:** both apps connect as the `postgres` superuser, which is why forced RLS doesn't break them. If `DATABASE_URL` is ever pointed at a non-superuser role, deny-all RLS means *total* denial and everything stops. Grant that role `BYPASSRLS`, or write explicit policies, **before** switching.

## 2. Secrets

- [x] `.env` and `vendor/openreply/.env` are gitignored and have **never** been committed — verified with `git log --all --full-history -- .env`
- [x] No `NEXT_PUBLIC_*` variable exists; no Supabase key reaches a client bundle
- [x] Instagram tokens encrypted at rest (AES-256-GCM, fresh IV per encrypt, auth tag enforced)
- [x] OpenReply sessions and verification tokens cleared after being exposed during the security audit
- [ ] **Generate fresh production values** for `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, `CRON_SECRET`, `DASHBOARD_SHARED_SECRET` — do not reuse local dev values
- [ ] Back up `ENCRYPTION_KEY` somewhere outside git. Losing it means re-connecting every Instagram account, since stored tokens become undecryptable
- [ ] Use a Render **Environment Group** for `DATABASE_URL` so both workers share one value instead of two hand-pasted copies that can drift

Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 3. Application security

| Item | Status |
|---|---|
| Dashboard auth (shared secret, httpOnly + secure + sameSite cookie, constant-time compare) | done |
| Middleware covers all routes except `/login`, `/api/auth/login`, `/api/health` | done |
| `/api/health` returns liveness only — no DB error, no env values | done |
| OAuth `state` CSRF protection | done |
| Login rate limiting (8 failures / 15 min / IP) | done |
| Open redirect on login `next` param | done — validates resolved origin |
| Log redaction of token/secret/password/cookie/session keys | done |
| API errors return a correlation id in production, detail to logs | done |
| SQL injection | not possible — postgres.js tagged templates throughout, no `sql.unsafe` |

**Known and accepted:** the session cookie is a static hash of the shared secret — same value every session, no revocation short of rotating the secret. Acceptable for a single-operator dashboard; revisit if this ever gains users. `POST /api/posts` takes an arbitrary local filesystem path (authenticated only) — fine for a self-hosted operator tool, not fine if the dashboard is ever shared.

## 4. Storage

- [x] Objects are purged from the bucket once a post reaches `PUBLISHED` (Instagram holds its own copy); `post_media` rows are kept for audit
- [x] Bucket must stay public — Meta fetches the image by URL at publish time

The residual exposure is the window between upload and publish, plus any post that fails before publishing. Paths are deterministic (`{campaignId}/{sequence}-{name}`), so treat anything in the bucket as world-readable. If that ever matters more, `getSignedMediaUrl` in `packages/storage/src/upload.ts` is the private-bucket path — unused today.

## 5. Data retention

- [x] Raw webhook payloads deleted after `RAW_PAYLOAD_RETENTION_DAYS` (default 30)
- [x] Commenter name and comment text nulled after `PII_RETENTION_DAYS` (default 90); rows kept so dashboard counts stay stable
- [x] Runs daily at 04:00 UTC from `apps/worker`

```bash
cd /d/jqp && npx tsx --env-file=.env scripts/purge-dry-run.ts
```

## 6. Meta configuration

See `docs/COMPLIANCE.md` for the full rules. Before going live:

- [ ] App in **Published/Live** state (Development mode delivers no webhooks)
- [x] `messaging_postbacks` subscribed at the **account** level — required for the button flow, and separate from the console's app-level toggles
- [x] `messaging_seen` deliberately NOT subscribed (keeps OpenReply's "send anyway if read" fallback dormant)
- [ ] Callback URL points at the production domain, not a tunnel
- [ ] All **five** requested OAuth scopes justified in App Review — `META_APP_REVIEW.md` documents only three
- [ ] Opening-DM copy discloses the experience is automated

```bash
cd /d/jqp && curl -s "https://graph.instagram.com/v26.0/$(grep '^META_IG_USER_ID=' .env | cut -d= -f2)/subscribed_apps?access_token=$(grep '^META_LONG_LIVED_ACCESS_TOKEN=' .env | cut -d= -f2)"
```

## 7. Deploy

Four services — see `docs/DEPLOY.md` for step-by-step.

| Service | Platform | Root |
|---|---|---|
| Dashboard | Vercel | `apps/web` |
| Publish worker | Render (Docker) | `apps/worker` |
| OpenReply dashboard | Vercel (separate project) | `vendor/openreply` |
| OpenReply DM worker | Render | `vendor/openreply` |

- [ ] `apps/web` deployed — migrations run automatically via its `vercel-build` script
- [ ] `APP_BASE_URL` and `META_OAUTH_REDIRECT_URI` updated to the real domain, then redeployed
- [ ] OAuth redirect URI updated in the Meta console to match exactly
- [ ] OpenReply deployed — **this removes the cloudflared tunnel**, which broke webhook delivery twice during development and is the single most fragile piece of the local setup
- [ ] Webhook callback URL repointed at OpenReply's Vercel domain
- [ ] Both workers healthy (Render health check; worker logs `worker_ready` and `purge_schedule_registered`)

## 8. Monitoring

| Signal | Where | Means |
|---|---|---|
| Token expiry / refresh failure | Settings page banner | Act on it — OpenReply's refresh cron fails silently and nothing else will tell you |
| Failed posts / failed DMs | Overview "Needs attention" tile | — |
| `purge_completed` | Worker logs, daily | Retention is running |
| New `WebhookEvent` rows | Database | **The** webhook health signal. DMs arriving is NOT proof — OpenReply's 5-minute comment poller masks a dead webhook, and that fallback cannot deliver button taps |

## 9. Open items

- **Dedup is per-comment, not per-person.** Someone commenting the keyword on three posts gets three DMs. Main remaining spam-report vector. Fixing it means modifying vendored OpenReply code.
- **Rate-limit constant unverified.** OpenReply enforces 750 sends/hour/account citing "Meta's documented cap"; that number could not be confirmed against current Meta docs. Mechanism is sound, constant may be stale.
- **`instagram_business_manage_insights`** is requested by OpenReply's OAuth but unused by our flow — drop it or justify it in App Review.

## 10. Pre-flight

```bash
cd /d/jqp && npm run typecheck --workspaces && npx vitest run && npm run migrate
```

Then, on the deployed system: publish a post, comment the keyword, confirm the button DM arrives, tap it, confirm the link arrives, and check `DmLog` for a row with `commentText = "(button tap)"` — that value is only ever written by the postback handler, so it's the unambiguous proof the full path works.
