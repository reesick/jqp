# Security Audit - jqp (apps/web, packages/*, supabase, deps)

Date: 2026-10-01. Branch `perf-ux-hardening` (HEAD 54a6d73). Read-only audit; no code changed.
Scope: apps/web, packages/core|meta|publisher|storage, supabase/migrations, git hygiene, `npm audit`, headers. Vendored OpenReply only where it affects this deployment. `.env` files were not read.

Legend: **V** = verified by reading the cited code or running a command. **S** = suspected / depends on deployment config I could not observe.

## Summary table

| # | Sev | Status | Finding | Where |
|---|-----|--------|---------|-------|
| 1 | High | V | Next.js 15.5.23 has critical/high advisories (AVIF image-optimizer RCE, Windows RCE); fix available | root `npm audit`, `apps/web/package.json:19` |
| 2 | High | V | Session cookie is a static, unsalted `sha256(secret)`: password-equivalent, never rotates, cannot be revoked, offline-crackable | `login/route.ts:144`, `middleware.ts:30` |
| 3 | High | V (strength S) | No minimum length/entropy on `DASHBOARD_SHARED_SECRET`; login limiter is per-serverless-instance and in-memory | `core/src/env.ts:93`, `login/route.ts:63-81` |
| 4 | Medium | V | No security headers configured; `X-Powered-By: Next.js` exposed | `apps/web/next.config.ts:170-175` |
| 5 | Medium | V | Public bucket has a blanket SELECT policy on `storage.objects`: allows anon LIST/enumeration of unpublished draft images | `0003_storage.sql:34-37` |
| 6 | Medium | V | Ingest `folderPath` is unrestricted: authenticated user can point at any server directory; the local worker later uploads its images to the PUBLIC bucket | `api/posts/route.ts:119-125`, `scanner.ts:35-66` |
| 7 | Medium | V | OpenReply cron routes: non-constant-time compare, fall back to `NEXTAUTH_SECRET`, and accept `Bearer undefined` if both secrets are unset | `vendor/openreply/app/api/cron/*/route.ts:9-12` |
| 8 | Medium | V | OpenReply `/api/health` (public) returns raw DB/Redis error messages, queue counts, worker heartbeat | `vendor/openreply/app/api/health/route.ts:19-46` |
| 9 | Low | V | No CSRF token on state-changing routes; relies only on SameSite=Lax. Logout is CSRF-able (cookie clear) | `logout/route.ts`, all POST/PATCH routes |
| 10 | Low | V | `/api/health` is unauthenticated and runs a DB query per request (cost/DoS amplification; no data leak) | `api/health/route.ts:196-210` |
| 11 | Low | V | AES-GCM decrypt does not pin auth-tag length; no AAD binding to row; no key versioning | `core/src/crypto.ts:32-37` |
| 12 | Low | V | Webhook verify token compared with `!==`; no replay/timestamp defence (Meta does not sign a timestamp) | `meta/src/webhook.ts:320` |
| 13 | Low | V | Meta access token sent as URL query param (`access_token=`) on every Graph call | `meta/src/client.ts:70,101` |
| 14 | Low | V | Logger redacts by key name only; `*_key` (e.g. service role key) and values embedded in messages are not caught | `core/src/logger.ts:211-224` |
| 15 | Low | V | Infra identifiers committed: Supabase project ref and pooler host in docs | `docs/LIVE.md:25`, `docs/ORACLE-WORKER.md:135` |
| 16 | Low | V | `NODE_ENV` defaults to `development`: if unset, cookies lose `Secure` and `apiError` returns raw error text | `core/src/env.ts:91`, `login/route.ts:147`, `api-error.ts:251` |
| 17 | Low | V | Login limiter Map is unbounded (memory growth under many-IP flood) | `login/route.ts:65` |
| 18 | Info | V | Positive: origin-checked `next` redirect, hash-then-compare login, state-validated OAuth, RLS + grant revocation, AES-256-GCM random IV, no `.env` in git history, no hardcoded secrets | see "Verified good" |

Counts: Critical 0, High 3, Medium 5, Low 9, Info 1.

---

## Findings (detail)

### 1. High (V): vulnerable Next.js - `npm audit --omit=dev` (repo root)
Installed `next` is 15.5.23 (`node -p require('next/package.json').version`). `npm audit` reports: **critical** `next` (GHSA-2xp9-vwfh-vxw4 unauthenticated RCE in Image Optimization API when AVIF is used; GHSA-p293-qw3h-jr36 RCE on Windows-hosted servers), **high** `postcss` (XSS via `</style>`, arbitrary `.map` file read; build-time CSS tooling), **high** `sharp` (libvips/libheif CVEs, used by the image optimizer). Total 3 (1 critical, 2 high); all have `npm audit fix` paths (sharp via `--force`).
Reachability: Windows RCE is not reachable on Vercel (Linux). The image optimizer RCE needs AVIF enabled; `next.config.ts` does not set `images.formats`, so the default (webp) applies and this is probably not exploitable, but `/_next/image` is excluded from the middleware matcher (`middleware.ts:45`) and therefore unauthenticated. postcss/sharp issues are build-time or only reachable through the optimizer. Treat as "patch now, low live exploitability".
Fix: `npm i next@latest` in apps/web (and `npm audit fix`), rebuild, redeploy. Also consider `images: { unoptimized: true }` (the app uses no remote images) to remove the unauthenticated optimizer surface.

**vendor/openreply** (`npm audit --omit=dev`): 18 vulns (4 critical, 10 high, 4 moderate); same `next`/`postcss`/`sharp` set plus `nodemailer` (recipient-domain validation bypass, DoS, high) and `valibot` (moderate). Nodemailer is only reachable if OpenReply sends email (magic-link auth); not verified. Not modified per the rules; report to owner to bump OpenReply's `next`.

### 2. High (V): session cookie is a static password-equivalent
`login/route.ts:144` sets `jqp_session = sha256(DASHBOARD_SHARED_SECRET)`; `middleware.ts:30` compares the cookie to the same hash.
- The cookie value is constant for all sessions and all time. Anyone who obtains it (XSS, shared machine, proxy log, backup of browser profile) has permanent access until the secret is rotated; there is no server-side revocation and logout only deletes the client copy.
- Unsalted SHA-256 of the secret: a leaked cookie permits fast offline guessing of the secret (billions/s on a GPU). If the secret is short, the cookie leaks the secret itself.
- Max-Age is 30 days with no server-enforced expiry (`login/route.ts:149`).
Cookie flags otherwise good: HttpOnly true, SameSite=Lax, Secure in production, Path=/ (`login/route.ts:144-150`). Not `__Host-` prefixed (Low).
Minimal fix: make the token an HMAC with an embedded expiry, keyed by the secret, so it is time-limited and not reversible to a bare hash:
```ts
// login: const exp = Date.now() + 7*864e5; const sig = await hmacHex(secret, `v1.${exp}`); cookie = `v1.${exp}.${sig}`
// middleware: parse, reject if exp < Date.now(), timingSafeEqualString(sig, await hmacHex(secret, `v1.${exp}`))
async function hmacHex(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map(b => b.toString(16).padStart(2, "0")).join("");
}
```
Also reduce Max-Age to 7 days and rename cookie to `__Host-jqp_session` (Secure, Path=/, no Domain). Rotating `DASHBOARD_SHARED_SECRET` then invalidates all sessions.

### 3. High (V for the gaps; actual exploitability S): brute-force of the shared secret
- Login is the only credential: single shared secret, no username, no 2FA.
- A limiter exists (`login/route.ts:63-81`): 8 failures per IP per 15 min, in a module-level `Map`. On Vercel each serverless instance has its own Map and instances are recycled, so the effective allowance is 8 x (concurrent instances) per IP per window and it resets on every cold start. `x-forwarded-for` is set by the Vercel edge (not client-spoofable there), so per-IP keying is sound on Vercel, but a distributed attacker (botnet/proxy pool) faces essentially no limit: each IP gets fresh attempts.
- Quantified risk: with an ideal limiter (8 per 15 min per IP) an attacker with 1,000 IPs tries about 770k guesses/day. With the real leaky limiter and parallel cold instances assume 1 to 2 orders of magnitude more, say 10^7 to 10^8 guesses/day. A random 20+ char secret (>=120 bits) is unreachable regardless. A human-chosen 8-10 char secret or a dictionary word is realistically crackable. **The code enforces no minimum**: `DASHBOARD_SHARED_SECRET: nonEmpty(...)` only (`core/src/env.ts:93`).
- Timing: login compares `sha256(input)` to `sha256(secret)` with a constant-time loop (`login/route.ts:127`, `edge-safe.ts:68-75`); the middleware does the same on the cookie (`middleware.ts:30`). Not exploitable. Verified good.
- Fix (small, in order of value): (a) enforce `min(32)` on DASHBOARD_SHARED_SECRET in env.ts and set a 40-char random value (`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`); (b) add a fixed delay (e.g. `await new Promise(r => setTimeout(r, 500))`) on failures; (c) if durable limiting is wanted, use Vercel Firewall rate-limit rule on `POST /api/auth/login` (no code), or Upstash Redis (already provisioned for OpenReply). Whole-account lockout is NOT recommended (attacker could lock the owner out).

### 4. Medium (V): no security headers, `X-Powered-By` exposed
`apps/web/next.config.ts:170-175` sets only `transpilePackages`. No `poweredByHeader: false`, no `headers()`. Live observation (given): HSTS present (Vercel default), `X-Powered-By: Next.js` present. Missing: CSP, X-Frame-Options/frame-ancestors, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. Clickjacking of the publish/retry buttons is partly mitigated by SameSite=Lax (cookie not sent in cross-site iframes) but defence in depth is cheap.
Fix for next.config.ts:
```ts
const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: [...],
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        { key: "Content-Security-Policy", value: "default-src 'self'; img-src 'self' data: https://*.supabase.co; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" }
      ]
    }];
  }
};
```
(`'unsafe-inline'` scripts are required by default Next.js without nonce middleware; test in a preview before shipping the CSP. Image origin: confirm the Supabase storage host used for thumbnails.)

### 5. Medium (V): storage bucket SELECT policy permits enumeration
`0003_storage.sql:34-37` creates `for select using (bucket_id = 'instagram-media')` on `storage.objects`. A public bucket already serves objects by URL without any policy; this policy additionally lets any holder of the anon key call the Storage list API and enumerate every object, including draft images for posts not yet published (the file itself notes paths are deterministic `{campaignId}/{sequence}-{name}`, `storage/src/upload.ts:64-66`). The anon key is public-by-design and the project ref is in committed docs (finding 15). Mitigation already present: post-publish purge (`deletePostMedia`).
Fix (new migration `0007`): `drop policy if exists "instagram-media public read" on storage.objects;` (public-bucket GET by URL keeps working for Meta). Verify a known image URL still loads afterwards. Also consider random path prefixes (`crypto.randomUUID()`) so drafts are unguessable.

### 6. Medium (V): ingest accepts arbitrary `folderPath`
`api/posts/route.ts:119-125` passes the client string straight to `ingestPostFolder` -> `scanPostFolder` (`scanner.ts:35-66`): `readdir(folderPath)` and `readFile(<folder>/caption.md)` with no allow-list, no `resolve()` containment, no root check. Authenticated users (one shared secret) can (a) list any directory's filenames (returned via validator errors / stored as unexpectedFiles), (b) read any file literally named `caption.md` (content is stored in the DB and shown in the UI), (c) store any path in `posts.folder_path`. The local worker later reads `posts.folder_path` and uploads files matching `N.jpg|png` to the PUBLIC bucket and publishes them to Instagram (`pipeline.ts:26-36, 60`). An authenticated attacker (or whoever steals the session cookie) can therefore get any `1.jpg` on the operator's disk published publicly. Symlinks inside the folder are not `isFile()` on Dirent, so those are skipped (good). Impact is bounded by the file-name patterns, hence Medium rather than High; on Vercel itself the filesystem is ephemeral and holds only the deployment bundle.
Fix: add `POSTS_ROOT` env; in the route: `const abs = path.resolve(folderPath); const root = path.resolve(env.POSTS_ROOT); if (abs !== root && !abs.startsWith(root + path.sep)) return 400;` and apply the same check in the worker before reading `post.folder_path` (defence against DB-planted paths). Consider `fs.realpath` to defeat symlinked parents.

### 7. Medium (V, vendored): OpenReply cron auth
`vendor/openreply/app/api/cron/refresh-tokens/route.ts:9-12` (same in `attach-next-reel` line 22 and `snapshot-followers` line 19): `authHeader !== \`Bearer ${cronSecret}\`` with `cronSecret = CRON_SECRET || NEXTAUTH_SECRET`. (a) Not constant-time (low practical risk over the internet). (b) If both env vars are unset, `cronSecret` is `undefined` and `Authorization: Bearer undefined` authenticates, letting anyone trigger token refresh / follower snapshot (S: depends on whether `CRON_SECRET` or `NEXTAUTH_SECRET` is set on `jqp-openreply-1`; OpenReply's proxy looks at `authjs.*` cookies, so it may use `AUTH_SECRET` and leave `NEXTAUTH_SECRET` unset). (c) Falling back to the session-signing secret widens exposure of that secret (Vercel Cron sends it as a bearer token in logs/proxies).
Action for owner (no code change in vendor): set a dedicated random `CRON_SECRET` on the OpenReply Vercel project now; verify with `curl -i -H "Authorization: Bearer undefined" https://<openreply>/api/cron/refresh-tokens` (expect 401).
Webhook route (`vendor/openreply/app/api/webhook/route.ts:34-56`): signature is verified on the raw body with HMAC-SHA256 + `timingSafeEqual` (`lib/meta/webhook.ts`). Invalid-signature requests are written to the DB with a 200-char body preview (unauthenticated write amplification, Low). Dedupe relies on BullMQ `jobId` per comment id (replay of a valid signed payload is idempotent only while the job is retained).

### 8. Medium (V, vendored): OpenReply `/api/health` info leak
`vendor/openreply/app/api/health/route.ts:19-46`: unauthenticated, returns `error.message` from Prisma/ioredis (contains DB host/port/db/role, Redis host), queue job counts and worker heartbeat/age. Same class of leak that jqp's own health route was fixed for. Report to owner; fix would be to return only `ok/degraded` publicly.

### 9. Low (V): CSRF
No CSRF tokens. Protection is SameSite=Lax cookie (`login/route.ts:146`): modern browsers do not send it on cross-site POST/PATCH/fetch, so publish/retry/campaign routes are effectively protected. Residual: (a) routes parse JSON without checking `Content-Type`/`Origin` (`request.json()`), so if SameSite is ever weakened they are open; (b) logout CSRF: a cross-site form POST to `/api/auth/logout` hits middleware unauthenticated (Lax cookie not sent) and is redirected to login, so practically not exploitable; (c) OAuth start is a GET with a side effect only of setting a state cookie (harmless), and the callback is state-validated (see Verified good).
Fix (cheap, in middleware): for methods other than GET/HEAD/OPTIONS require `Origin` (or `Sec-Fetch-Site: same-origin`) to match `request.nextUrl.origin`, else 403.

### 10. Low (V): public health endpoint
`api/health/route.ts:196-210` returns only `{success, db, ts}` (leak fixed per its own comment; errors go to logs). Remaining: unauthenticated DB query per call with `DB_POOL_MAX` 5, so a flood can starve the pool for real users. Fix: cache the result for 10-15 s in module scope, or rate limit via Vercel Firewall.

### 11. Low (V): crypto details (`packages/core/src/crypto.ts`)
Good: AES-256-GCM, 96-bit random IV per call (`randomBytes(12)`, line 20), separate ciphertext/iv/tag columns, key validated as exactly 64 hex chars (`env.ts:78-80`), tamper detection via auth tag (decrypt throws on modification; covered by `crypto.test.ts`). Random 96-bit IV is safe up to about 2^32 encryptions per key; this app encrypts a handful of tokens.
Gaps: `createDecipheriv(ALGORITHM, key, iv)` without `{ authTagLength: 16 }` (line 33): Node accepts shorter tags (4-15 bytes) so a DB-write attacker can truncate the tag, weakening forgery resistance. No AAD, so ciphertext can be swapped between rows (needs DB write). No key-version column, so rotating `ENCRYPTION_KEY` requires re-encrypting or reconnecting accounts.
Fix: `createDecipheriv(ALGORITHM, getKey(), iv, { authTagLength: 16 })` and reject `authTag` of length != 16; optionally pass `ig_user_id` as AAD via `setAAD`.

### 12. Low (V): Meta webhook helpers in packages/meta (`webhook.ts`)
`verifyWebhookSignature` (lines 302-310): verifies `sha256=` HMAC over the raw body using `META_APP_SECRET`, constant-time compare, rejects missing/malformed header. Good. Caveat: nothing in this repo's web app calls it (the public webhook lives in OpenReply; grep shows only tests and `scripts/simulate-webhook.ts` reference these), so these helpers are effectively dead code in prod. `verifyWebhookChallenge` (line 320) compares `hub.verify_token` with `!==` (not constant-time; low value target). Replay: Meta does not sign a timestamp, so replay defence must be idempotency on comment id (present in OpenReply via jobId).

### 13. Low (V): token in URL
`meta/src/client.ts:70,101` builds `...?access_token=<token>` for every Graph call; `oauth.ts:58-59,74` does the same for exchange/refresh (Meta requires query params for those). The URL itself is never logged (retry log at line 105-110 logs `path` only; `attemptOnce` error messages carry `path`, not the URL). Residual risk is proxies/APM capturing outbound URLs and undici error strings. Graph API also accepts `Authorization: Bearer <token>` on graph.instagram.com for normal calls; switch `graphRequest` to a header to remove the token from URLs. `oauth.ts:47,64,80` throw `JSON.stringify(body)` of Meta's failure response (no token on failure paths; fine).

### 14. Low (V): logger redaction (`core/src/logger.ts`)
Redacts by key substring: token, secret, password, passwd, authorization, apikey, api_key, encryption_key, access_token, credential, cookie, session. Misses keys like `SUPABASE_SERVICE_ROLE_KEY` / `serviceKey` / `privateKey` and `DATABASE_URL`/`connectionString` (contains password), and secrets embedded inside string values (e.g. an error message containing a URL with `access_token=`). `login_failed` logs client IP (PII, acceptable). `newCorrelationId` uses `Math.random` (fine, not security-relevant).
Fix: add `"key"`, `"databaseurl"`, `"connectionstring"`, `"dsn"` to `REDACT_KEY_PATTERNS`, and run a `replace(/access_token=[^&\s"]+/g, "access_token=[redacted]")` on serialized output.

### 15. Low (V): identifiers in git
`docs/LIVE.md:25` and `docs/ORACLE-WORKER.md:135` contain the real Supabase pooler username (`postgres.<project-ref>`) and region host, with the password replaced by a placeholder (password not committed - verified by redacting before viewing). Not a secret, but it gives attackers the project ref needed to target the anon API and storage (finding 5). Consider replacing with `<PROJECT_REF>` if the repo is or may become public.

### 16. Low (V): NODE_ENV default
`env.ts:91` defaults `NODE_ENV` to `development`. On Vercel it is always `production`, so it is fine there; on the Oracle worker or any non-Vercel host running the web app without it set, cookies lose `Secure` and API errors leak driver messages. Fix: no default (require it) or treat "not development" as production for these checks.

### 17. Low (V): unbounded limiter map
`login/route.ts:65` never evicts expired keys except when the same IP returns. Flooding with many distinct `x-forwarded-for` values grows memory until the instance is recycled. Fix: prune on insert when `attempts.size > 1000`.

---

## Requested checklist results

- **middleware.ts**: runs on every path except `_next/static`, `_next/image`, `favicon.ico` (`:45`). Public: `/login`, `/api/auth/login`, `/api/health` (`:10`). Every other route handler in apps/web (posts, campaigns, publish, retry, meta/oauth, auth/logout) is therefore authenticated by the middleware (V, all 9 route files enumerated in `git ls-files`). There is no per-route auth check (defence in depth absent: if the matcher is ever edited, routes open). `x-pathname` header is overwritten by middleware so a client cannot spoof it (`:18`). Note `/icon` (app/icon.tsx) needs auth so the favicon is broken before login (cosmetic).
- **Open redirect**: `?next=` handled by `safeNext` (`login/route.ts:99-107`): resolves against the request URL and compares origin, so `//evil.com`, `/\evil.com`, `https://evil.com` return `/`. Verified good. Login page echoes `next` only into a hidden input (React-escaped, `login/page.tsx:16`). Middleware sets `next` from `pathname` only.
- **Cookie flags**: HttpOnly, SameSite=Lax, Secure (prod), Path=/, Max-Age 30 d (see #2). OAuth state cookie: HttpOnly, Lax, Secure (prod), 10 min (`oauth/start/route.ts:35-41`).
- **Meta OAuth**: `state` = 32 random bytes, stored in HttpOnly cookie, callback requires match with constant-time compare and clears the cookie on all exits (`callback/route.ts:76-79,51-56`). Both routes sit behind auth. Token exchange is server-side; long-lived token is AES-GCM encrypted before insert (`repository.ts:325-338`). Error details are logged, not placed in redirect URLs (`callback:95-99`). `redirect_uri` comes from env, not request. Verified good. Minor: the `connected=<username>` query param and `oauth_error` are reflected to Settings; ensure they are rendered as text (React default).
- **core/env.ts**: required: APP_BASE_URL, DASHBOARD_SHARED_SECRET (non-empty only), SUPABASE_URL, SERVICE_ROLE_KEY, DATABASE_URL, META_APP_ID/SECRET/GRAPH_VERSION/API_BASE/IG_USER_ID/OAUTH_REDIRECT_URI/WEBHOOK_VERIFY_TOKEN, ENCRYPTION_KEY (64 hex), BRIDGE_SHARED_SECRET (non-empty only). Defaults: NODE_ENV=development, MOCK_META=false, bucket `instagram-media`, `META_LONG_LIVED_ACCESS_TOKEN=""`. No entropy/length rules on any shared secret. `loadEnv()` is required by the login route, so a missing unrelated env var breaks login (availability, not security).
- **Service-role exposure**: only used server-side (`storage/src/client.ts:10`); no `NEXT_PUBLIC_*` variable exists in apps/web or packages (grep). Database access uses `DATABASE_URL` as `postgres` superuser (per 0006 comments), bypassing RLS by design.
- **Migrations**: 0002 enables + forces RLS with zero policies on the 7 jqp tables; 0006 revokes all table/sequence privileges from `anon`/`authenticated` on every `public` table (including OpenReply's Prisma tables), sets default privileges for future tables/functions/sequences, and revokes schema USAGE. Verified good. No SECURITY DEFINER functions or views found (grep of migrations). Caveat (documented there): pointing `DATABASE_URL` at a non-BYPASSRLS role breaks everything. Residual: storage policy (#5); default privileges cover only objects created by `postgres`.
- **SQL injection**: all queries in packages use postgres.js tagged templates (parameterised). The only `sql.unsafe` is `scripts/migrate.ts:61`, executing repo migration files (operator-run, not user input). No string-concatenated SQL found. Verified.
- **Secrets hygiene**: 317 tracked files (`git ls-files`). `.gitignore` covers `.env`, `.env.*` (except `.env.example`), `.vercel/`, `node_modules`, images. Git history (`git log --all --diff-filter=A --name-only`) shows only `.env.example` (root and vendor) ever added; no `.env`, `.pem`, or key files. Pattern scan of tracked files (AKIA, `sk_live/test`, JWT `eyJ...`, `EAA`/`IGAA` tokens, `postgres://user:pass@`, 64-hex strings) found no real secrets: hits were `.env.example` placeholders, test fixtures setting dummy `DATABASE_URL`, and docs with placeholder passwords (#15). `vendor/openreply/package-lock.json` hex hit is an integrity hash. Untracked-but-present local artefacts exist in vendor (`openreply-web.log`, `openreply-worker.log`): confirm they are gitignored there (`git ls-files` did not list them at root; not verified inside vendor).
- **Dependencies**: see #1.
- **Path traversal**: see #6.

## Verified good (Info)
- Login: hash-then-constant-time compare; `next` origin-validated; limiter exists; failures logged without the submitted secret.
- Health (jqp): no error detail, NODE_ENV or MOCK_META returned.
- `apiError` hides driver messages in production and returns a correlation id.
- OAuth CSRF state, token encryption at rest, RLS + grants lockdown, HMAC webhook verification (OpenReply) on raw body.

## Prioritized fix list (orchestrator-applicable)

1. **`apps/web/package.json` / lockfile**: bump `next` to latest patched 15.x/16.x; `npm audit fix`; rebuild (finding 1). Set `images.unoptimized: true` in next.config.ts.
2. **`apps/web/next.config.ts`**: add `poweredByHeader: false` and the `headers()` block from finding 4 (test CSP on a preview deploy first).
3. **`apps/web/app/api/auth/login/route.ts` + `middleware.ts`**: replace static `sha256(secret)` cookie with expiring HMAC token (finding 2); Max-Age 7 days; `__Host-` cookie name (update both files and logout's `cookies.delete` name together, and `COOKIE_NAME` in middleware).
4. **`packages/core/src/env.ts`** (orchestrator scope permitting) + owner action: enforce `DASHBOARD_SHARED_SECRET` min length 32 and rotate to a 40-char random value in Vercel; add 500 ms delay on failed login; prune limiter Map; add Vercel Firewall rate-limit on `/api/auth/login` (finding 3, 17).
5. **`apps/web/middleware.ts`**: add Origin/Sec-Fetch-Site check for non-GET requests (finding 9).
6. **`apps/web/app/api/posts/route.ts`** (+ worker): restrict `folderPath` to a `POSTS_ROOT` (finding 6).
7. **New migration `0007`**: drop the `instagram-media public read` SELECT policy; verify images still load (finding 5).
8. **`packages/core/src/crypto.ts`**: pin `authTagLength: 16` (finding 11). **`logger.ts`**: add `key`/`databaseurl` patterns (finding 14).
9. **Owner actions (not code here)**: set dedicated `CRON_SECRET` on the OpenReply Vercel project and test `Bearer undefined` -> 401; ask for OpenReply dependency upgrade and a minimal public `/api/health`; replace project ref in docs if repo may go public.
