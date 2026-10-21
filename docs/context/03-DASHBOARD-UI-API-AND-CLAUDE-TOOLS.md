# 03. Dashboard, UI, HTTP API and the Claude Code tools

Everything a person or an agent touches directly: the Next.js dashboard (`apps/web`), its design system, every HTTP route and its protection, the OpenReply admin UI that sits beside it, and the Claude Code MCP server (`apps/mcp`). Read from the source on 2026-10-21; route behaviour was confirmed in code, the live pages with `npm run smoke`.

## 1. What the dashboard is

- Next.js **15.5** App Router, React, TypeScript, deployed as Vercel project **`jqp-web`** at `https://jqp-web-tau.vercel.app`, root directory `apps/web`, function region **`bom1`** (Mumbai, next to the database, set in `apps/web/vercel.json`). A duplicate project `jqp-web-89h2` exists and is harmless; ignore it.
- It is the operator console for one person. It does **not** publish anything itself: "Publish" only enqueues a pg-boss job in Postgres; the local publish worker does the work (file 01). Pages are server components that read through `@jqp/publisher` (all SQL is in `packages/publisher/src/repository.ts` and friends); there is no client-side data fetching library.
- `next.config.ts` loads the root `.env` (`loadRootDotenv`) for local dev/build, turns off the image optimizer (it would be an unauthenticated route that bypasses middleware), hides `X-Powered-By`, and sets headers `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` with camera, microphone and geolocation off. No CSP yet (deferred).
- Local: `npm run dev:web` (port 3000). With `MOCK_META=true` and `npm run mock-meta` it runs against a fake Graph API (`docs/LOCAL.md`).

## 2. Pages

All pages are `force-dynamic`. Times use `Asia/Kolkata` (IST). The sidebar (`components/sidebar.tsx`) has six items; **labels were renamed but the URLs kept their old names**:

| Nav label | Route | What it does |
|---|---|---|
| Home | `/` | "Morning cockpit". Greeting by IST hour; one status line ("Everything is running normally" or "N things need your attention"); **Needs attention** (failed posts with a Retry button, failed DMs link, token problem link) only when something is wrong; Latest post; Automations (enabled campaigns with sync badge and DMs sent last 7 days / total); Recent activity timeline of matched comments |
| Posts | `/posts` | List of posts with status badges; the **Ingest folder** form (works only on a locally running dashboard: the Vercel function cannot read the laptop's disk); empty state "No posts yet" |
| (detail) | `/posts/[id]` | Status timeline, error text, **post preview** (slides strip and caption), **Publish** button (only for DISCOVERED; shows a browser confirm "Publish this post to your Instagram account?") and **Retry** (only for failed posts; a second confirm asks you to check the profile when the failure carries `confirmNotLive`) |
| Automations | `/campaigns` | Create/edit the comment-to-DM campaign for a post (`campaign-form.tsx`), toggle enabled (optimistic UI, `campaign-toggle.tsx`), live DM preview beside the form (`dm-preview.tsx`, calls `POST /api/campaigns/preview`). Fields: post, trigger keywords (comma separated; empty means any word), match mode, "Send an opening DM with a button first" toggle (opening message, button label default "Send the link"), link DM, destination URL (https), public reply toggle + text, Enabled toggle ("only enabled + published campaigns sync to OpenReply") |
| Activity | `/dm-activity` | Full DM log from OpenReply's `DmLog` with status filters (`?status=FAILED` etc.); empty state "No issues detected." |
| Settings | `/settings` | Token-expiry banner; connected Instagram accounts (username, id, token expiry, active) from `ig_accounts`; **Connect Instagram** (starts OAuth); link to OpenReply's own dashboard; `/api/health` link |
| System | `/system` | Overall "All N checks passing / N need attention"; **Emergency stop: Pause all DMs** (confirm dialog); Services list (every check with Healthy/Warning/Down); DMs last 24 hours; 7-day table with volume bars; top failure reasons; queue counts; recent recorded errors and OpenReply errors; last webhook time |
| (public) | `/login` | Shared-secret form. The only unauthenticated page besides `/api/health` |

The Home page never shows raw logs or zero-count KPI tiles by design (`DESIGN.md` sections 13 and 38).

### Keyboard and palette
`Ctrl+K` (or `Cmd+K`) opens a Raycast-style command palette (`components/command-palette.tsx`). Shortcuts `G` then `H` Home, `P` Posts, `A` Automations, `Y` Activity, `S` Settings, `X` System; `/` focuses search; arrows, Enter, Esc, Tab work as expected. Actions: Ingest folder, View failed posts, View failed DMs. A mobile bottom nav replaces the sidebar on small screens.

### Components (`apps/web/app/components`)
`action-button` (POST/PATCH with confirm, toast, spinner, optimistic refresh, the `confirmNotLive` re-confirm flow), `campaign-form`, `campaign-toggle`, `command-palette`, `dm-preview`, `empty-state`, `icons` (lucide subset), `ingest-form`, `instagram-glyph`, `logo-mark`, `sidebar`, `spinner`, `status-badge`, `toast` (provider + `useToast`; undo/retry actions), `toggle`. Loading skeletons: `(dashboard)/loading.tsx`, `system/loading.tsx`. Error boundary `app/error.tsx`. `app/icon.tsx` draws the favicon. Shared per-request memoised stats: `app/lib/data.ts` (`getStats = cache(getDashboardStats)`) so the sidebar and the page share one set of queries.

## 3. Design system

Source of truth: `DESIGN.md` (Linear-inspired: dark, dense, quiet, keyboard-first, "show me what matters now") and the tokens in `apps/web/app/globals.css`. Legacy `--color-*` names are kept as aliases so older classes still work.

| Token | Value | Note |
|---|---|---|
| `--bg` / `--surface` / `--surface-raised` / `--surface-hover` / `--surface-active` | #0a0a0a / #111111 / #151515 / #191919 / #202020 | |
| `--border` / `--border-subtle` | #262626 / #1c1c1c | |
| `--text-primary` / `--text-secondary` | #f5f5f5 / #a1a1a1 | |
| `--text-muted` | **#8a8a8a** (DESIGN.md says #666, which fails 4.5:1 on #111; changed for accessibility) | |
| `--accent` (+ soft) | #8b5cf6 (violet, primary interaction/selected) | used sparingly |
| `--success` / `--warning` / `--error` / `--info` | #4ade80 / #fbbf24 / #f87171 / #60a5fa | status colour is secondary to icon+text |
| Radius | 6 buttons/inputs, 8 panels, 10 modal/media | no 20px soft cards |
| Spacing | 4px base (4, 8, 12, 16, 24, 32, 48) | |
| Fonts | Inter (UI), JetBrains Mono (ids, times, logs) via `next/font` variables `--font-inter`, `--font-jetbrains-mono` | |
| Sidebar | 220px | |

Rules worth keeping: neutral for 90%+ of the UI; never colour a whole card by status; skeletons not spinners; optimistic actions with rollback; toasts under two lines; empty states are useful not decorative ("✓ No issues detected"); errors say what happened, why, and what to do.

The status emails use a different palette on purpose (cream `#FEFAE8`, black header `#141414`, red button `#D9070B`, status tones green `#177a3c`, amber `#a15c00`, red `#b3140f`) because they render in light email clients.

**Not built** from DESIGN.md: Calendar page, scheduling (no post scheduler exists), drag-and-drop rescheduling, a collapsed-sidebar mode.

## 4. Authentication and request protection

| Layer | Behaviour | File |
|---|---|---|
| Login | `POST /api/auth/login` (form post). Compares SHA-256 of the submitted secret to SHA-256 of `DASHBOARD_SHARED_SECRET` with a constant-time compare. Per-IP failed-attempt limiter (8 per 15 minutes, in memory per serverless instance, so it resets on cold start) plus a fixed 500 ms delay on every failure. Redirect target `next` is validated by resolving it and comparing origins (blocks `/\evil.com` style open redirects) | `app/api/auth/login/route.ts` |
| Session | Cookie **`jqp_session`**: HttpOnly, `Secure` in production, SameSite=Lax, 7 days. The value is `v1.<expiry>.<HMAC-SHA256 of expiry with the secret>`, not the secret and not a hash of it. Rotating `DASHBOARD_SHARED_SECRET` invalidates every session. Logout: `POST /api/auth/logout` | `packages/core/src/edge-safe.ts` |
| Middleware | `apps/web/middleware.ts` on the Edge. Public: `/login`, `/api/auth/login`, `/api/health`, and anything under `/api/cron/` (**which skips the cookie check; every route there must authenticate itself**). Everything else needs a valid session: pages redirect to `/login?next=...`, `/api/*` returns 401. Non-GET requests with `Sec-Fetch-Site` other than same-origin/none get 403 (cross-site POST blocking). Sets `x-pathname` for the sidebar | `apps/web/middleware.ts` |
| Cron endpoints | `Authorization: Bearer <token>`, constant-time compare, refuse with **503 when the token is unset or shorter than 24 characters**, 401 on a wrong token. `requireMonitorToken` checks `MONITOR_TOKEN`; `digest-data` checks its own `VM_REPORT_TOKEN` | `app/api/_lib/cron-auth.ts`, `app/api/cron/digest-data/route.ts` |
| Errors | `apiError()` returns a generic message plus a `correlationId` in production, logs the real error under that id, and writes a `system_events` row for 5xx. Never returns driver errors (they contain DB host/role) | `app/api/_lib/api-error.ts` |
| OAuth CSRF | `state` random value in a 10 minute HttpOnly cookie, required on callback | `api/meta/oauth/*`, `_lib/oauth-state.ts` |
| Password strength | System page check "Dashboard password": warn if shorter than 32 chars | `system.ts` |

The dashboard password in use is 32+ characters (the `doctor` check "dashboard password is strong" passes). `POST /api/posts` accepts a **filesystem path** (authenticated only): do not give the dashboard to anyone you would not give disk read access.

## 5. HTTP API (all JSON `{ success, data | error }`)

| Method + path | Auth | Behaviour |
|---|---|---|
| `GET /api/health` | public | `{ success, db: "ok" | "error", ts }`, DB only |
| `POST /api/auth/login`, `POST /api/auth/logout` | public / session | See section 4 |
| `GET /api/posts` | session | List posts |
| `POST /api/posts` `{ folderPath }` | session | `ingestPostFolder`. Only works where that path exists (a local dashboard) |
| `GET /api/posts/[id]` | session | `{ post, media }` |
| `POST /api/posts/[id]/publish` | session | 409 unless status is DISCOVERED; enqueues `publish-post`; returns `{ jobId, alreadyQueued }` (null id = double-click throttled, still fine) |
| `POST /api/posts/[id]/retry` `{ confirmNotLive? }` | session | 409 unless FAILED/VALIDATION_FAILED; `resetPostForRetry` refuses (409) when the post already has a media id or the failure said it may be live, unless `confirmNotLive: true`; then enqueues with `retry: true` |
| `GET /api/campaigns`, `POST /api/campaigns`, `GET/PATCH /api/campaigns/[id]` | session | Create/update through `upsertCampaign` (cleans all text, deactivates the OpenReply automation first when switching off). When a campaign is enabled on an already PUBLISHED post it enqueues `sync-campaign-to-openreply`. POST rejects an opening DM missing its message or button label; PATCH rejects an empty `dmMessage` and carries the opening-DM fields over unchanged (PATCH cannot edit them) |
| `POST /api/campaigns/preview` | session | Read-only: returns the cleaned `opening`, `button`, `dm`, `publicReply` and warnings (length limits 640 / 20 / 1000, "does not say it is automated", missing link). Same cleaning as every write |
| `POST /api/system/pause` `{ confirm: true }` | session | **Emergency stop.** Switches every enabled campaign off through the normal off path (OpenReply automation deactivated first), nothing deleted; reports `{ paused }` or partial failure with the failed ids |
| `GET /api/meta/oauth/start`, `GET /api/meta/oauth/callback` | session | Instagram Login OAuth. Scopes requested: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_messages`. Callback exchanges the code, upgrades to a long-lived token (60 days), resolves the account and stores it **encrypted** in `ig_accounts`. Redirect URI must equal `META_OAUTH_REDIRECT_URI` (`https://jqp-web-tau.vercel.app/api/meta/oauth/callback`) |
| `POST /api/cron/monitor` | `MONITOR_TOKEN` | `runMonitor()`: snapshot, transition alerts, state in `alert_state` |
| `POST /api/cron/purge` | `MONITOR_TOKEN` | `purgeExpiredData()` + `purgeOldEvents()`, records a `retention_run_completed` event |
| `POST /api/cron/digest` | `MONITOR_TOKEN` | `sendHealthDigest()` (the dashboard-originated 6-hourly summary email; 502 if mail is not configured). **Now redundant with the VM's combined email** (file 00 open item 4) |
| `POST /api/cron/digest-data` | `VM_REPORT_TOKEN` | The system section as data (`level`, `headline`, `passing`, `total`, `lines`, `rowsHtml`, `dashboardUrl`, `generatedAt`) for the VM's combined email. Returns only counts, check names and scrubbed messages. Added 2026-10-14 |

A note on "publish": the HTTP API cannot publish by itself; with the worker off, a clicked Publish waits as a job and the post stays `DISCOVERED` (see `docs/PUBLISHING.md`).

## 6. OpenReply's own admin UI (separate app, same Meta app)

`https://jqp-openreply-1.vercel.app` (Next.js 16, Auth.js). It has its own login (magic link by email via Resend, Nodemailer optional), workspaces, automations, DM logs, follower reports, templates, public pages (`/privacy`, `/terms`, `/data-deletion`, `/meta-review`), and the API routes Meta and the worker use (`/api/webhook`, `/api/health`, `/api/instagram/*`, `/api/cron/*`). The dashboard links to it from Settings. Protected prefixes (cookie-presence redirect in `proxy.ts`): `/dashboard`, `/automations`, `/logs`, `/settings`. **Security note:** sign-up is open (anyone can request a magic link) and the site is public, which is the top open security finding (file 00, item 5). Its Vercel crons (`vendor/openreply/vercel.json`): `/api/cron/refresh-tokens` 05:00 UTC, `/api/cron/attach-next-reel` 06:00 UTC, `/api/cron/snapshot-followers` 07:00 UTC; they check `CRON_SECRET`.

## 7. The Claude Code integration (`apps/mcp`)

An MCP server named **`jqp`** (stdio), registered for this project in `.mcp.json` (`node --import tsx apps/mcp/src/index.ts`). It talks to the same database and queue as the dashboard and runs on the owner's laptop. It is **currently disabled**: `D:\jqp\.claude\settings.local.json` contains `{"disabledMcpjsonServers": ["jqp"]}` (read 2026-10-21). To use the tools the owner must re-enable it (remove that entry or approve the server when Claude Code prompts), which is their call because the tools can publish. Test: `npm run mcp:selftest`. Safety rules (header of `index.ts`): any action that publishes or goes live needs an explicit `confirm: true`; ingest is limited to `POSTS_ROOT` when that env var is set.

| Tool | Kind | What it does |
|---|---|---|
| `system_health` | read | Same snapshot as the System page: services with state, DM last 24 h, DMs this hour, top failure reasons, failed posts. Call first when anything seems wrong |
| `list_posts`, `get_post` | read | Posts newest first; one post with caption, status, error and its campaign |
| `list_campaigns` | read | Every campaign with keywords, enabled and sync state |
| `recent_problems` | read | Failed posts and recorded errors from the last 7 days (no personal data) |
| `preview_dm` | read | Cleans a message the way every write does and warns about limits (button 20, opening 640, message 1000) and the missing "automated" line |
| `ingest_post_folder` `{ folderPath }` | write, idempotent | Registers a folder as DISCOVERED; never publishes |
| `configure_campaign` | write | Creates/updates a post's campaign. Needs `confirm: true` only when `enabled: true` is set on an already PUBLISHED post (it would start real DMs immediately). Supports `twoStep { openingMessage, buttonLabel }`, `dmMessage`, `destinationUrl`, `publicReply`, `keywords`, `matchMode` |
| `publish_post` `{ postId, confirm }` | live | Queues a DISCOVERED post. Posts publicly. Requires `confirm: true` and the local publish worker running |
| `retry_post` `{ postId, confirm, confirmNotLive? }` | live | Resets a failed post and queues it; refuses if the post may already be live unless `confirmNotLive` after the human looked at the profile |

The content workflow Claude should follow (naming, caption voice, two-step DM, the checklist after every change) is `docs/CLAUDE-CONTENT-GUIDE.md`. The staging helper `scripts/stage-post-kit.ts` turns a content-team delivery folder (`POST-F/05_FINAL/index.json` + `post.json` per post) into `posts/<id>/` plus a DISCOVERED post and an **OFF** campaign; `scripts/build-preview.ts` builds an offline `preview.html` with rule checks. Three posts were staged this way and sit untracked in `posts/` (`01_dot-and-key`, `02_nutella`, `03_hydro-flask`); none is published as far as the repo shows (**UNVERIFIED**: check the Posts page).

### Launch review (built, not wired)
`packages/publisher/src/launch-review.ts` implements a go/no-go review of one post and its campaign (slide count, caption length and hashtags, keywords, link, opening-DM disclosure, copy style, public-reply risk, account token days left, OpenReply registration and webhook subscription, worker up, queue backlog, hourly rate, other enabled campaigns, plus three "check by hand" Meta items). `evaluateLaunchReview` is a pure function and `getLaunchReview(postId)` reads the real state; there is **no unit test** for it, and `scripts/build-preview.ts` has its own separate, similar checks rather than importing it. **Nothing in the dashboard, API or MCP calls `getLaunchReview` yet.** It is meant to be the gate for any future automatic launch (only proceed on `ready`, or `warnings` that a person accepted, never on `blocked`).

## 8. Running and changing the dashboard

| Task | Do |
|---|---|
| Local dev | `npm run build:packages` once, then `npm run dev:web` (reads the root `.env`; points at production Supabase unless you changed it) |
| Typecheck / build | `npm run typecheck`, `npm run build:web` (packages must be built first) |
| Deploy | Push to `main`. Vercel builds `apps/web` with `vercel-build` from its `package.json`. Env changes need a redeploy |
| Add a page | `apps/web/app/(dashboard)/<route>/page.tsx` (server component), add it to `NAV_ROUTES` in `(dashboard)/layout.tsx` and the sidebar and palette lists |
| Add an API route | Under `app/api/...`. Under `/api/cron/` it must call a token guard. Route files may export **only HTTP handlers** (exporting a constant breaks `next build`; shared constants go in `app/api/_lib/`) |
| Copy rules | Text shown to commenters follows `docs/CLAUDE-CONTENT-GUIDE.md`; default new-campaign DM copy has no em dash or emoji |
