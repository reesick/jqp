# Meta / Instagram compliance

What this system does, which Meta rules govern it, and where each rule is enforced in code. Written so it can be handed to an app reviewer, and so nobody has to re-derive Meta's rules from memory.

**Verify before every App Review submission.** The rules below were first checked against Meta's live documentation in August 2026 and re-checked on **2026-10-01** (see [Changes since last verification](#changes-since-last-verification)). Meta changes these; the citations are where to re-check, not a permanent guarantee.

**Method note.** "Verified" below means the figure was read from a developers.facebook.com page on 2026-10-01 via an automated page fetch that returns a summary of the page, not the raw page. Anything from a third-party blog is labelled as such and is not relied on. Where a page did not state something, this document says so rather than filling the gap from memory.

---

## What the system does

1. We publish carousels to an Instagram professional account we own (`apps/worker` → Content Publishing API).
2. When someone comments a configured keyword on one of those posts, they get a DM.
3. With the two-step flow enabled (the default we recommend), that first DM is a short message with a button. The link is only sent after the person taps it.

Step 3 is worth understanding as a compliance property, not just a UX choice: the button tap is a genuine user-initiated interaction, which is what legitimately opens Meta's messaging window for the second message. The one-shot alternative leans entirely on the private-reply allowance.

## The rules, and where we satisfy them

| Rule | Source | Where enforced |
|---|---|---|
| A private reply may be sent within **7 days** of the comment | [Private Replies](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/private-replies) | OpenReply's send path; comments older than this fail at the API and are logged `FAILED` |
| **Only one** private reply per comment | same | `DmLog @@unique([automationId, commentId])` + `SKIPPED_DEDUP` in `vendor/openreply/lib/queue/dm-worker.ts` |
| After a private reply, **follow-up messages are allowed only if the recipient responds, and within 24 hours of that response** | [Private Replies](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/private-replies) | The reveal DM is sent only after the button tap (a response), so it is inside the window by construction. A private reply sent after the 7-day limit, or a link sent with no tap, is a violation |
| **24-hour** messaging window after a user message to the business | [Instagram Messaging API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api), [Messenger Platform policy](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview/) | Same as above |
| `human_agent` tag: a human may respond within **7 days** | Messenger Platform policy (the Instagram API page mentions the tag but gives no duration) | **Not used.** We send nothing outside the window, so we don't need it. Do not use it for automated sends: the policy describes it for manual, human responses |
| Automated experiences must **disclose** they're automated "at the beginning of any conversation or message thread, after a significant lapse of time, or when a chat moves from human interaction to automated experience" (called out for California and German users) | [Messenger Platform policy](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview/) (verified 2026-10-01; the earlier citation, the generic help.instagram.com root, was not a usable source) | Default opening-DM copy discloses it; `campaign-form.tsx` warns if the operator removes it. Note the "after a significant lapse of time" clause: the reveal DM after a long gap should re-state it if the gap is large |
| Button template: 640-char text, 20-char button title, max 3 buttons | `vendor/openreply/lib/meta/client.ts` (truncates to exactly these) | Capped at the input in `campaign-form.tsx` and again in `openreply-bridge.ts`, so nothing is silently cut at send time |
| Inbound webhooks must be signature-verified (`X-Hub-Signature-256`, SHA256 of the raw payload with the **app secret** from App settings > Basic, also for Instagram Login) | [Instagram webhooks](https://developers.facebook.com/docs/instagram-platform/webhooks) | `vendor/openreply/lib/meta/webhook.ts` — HMAC-SHA256, `timingSafeEqual`, 401 on mismatch |
| Data deletion route must exist | [Data Deletion Callback](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/) | Satisfied by the instructions URL at `/data-deletion`. Meta accepts **either** a callback endpoint or an instructions URL; we use the latter |

## Webhook fields

| Field | Subscribed | Why |
|---|---|---|
| `comments` | **Required** | The keyword trigger. Nothing works without it |
| `messaging_postbacks` | **Required for the button flow** | Delivers the button tap. Without it the button renders, the user taps, and nothing happens — no webhook, no error, no reveal |
| `messages` | Optional | Only needed for OpenReply's Inbox and its DM-keyword trigger, neither of which we use |
| `messaging_seen` | **Deliberately off** | OpenReply has a fallback that sends the link to anyone who *reads* the opening DM without tapping (`app/api/webhook/route.ts`). Leaving this unsubscribed keeps that dormant, so the link only ever goes out on an explicit tap. This is a deliberate compliance choice — do not enable it casually |

Verify what is actually subscribed with the API, not the console UI — the console has shown "Subscribed" when it wasn't. Use the **account-level** endpoint:

```bash
curl -s "https://graph.instagram.com/${META_GRAPH_VERSION}/${META_IG_USER_ID}/subscribed_apps?access_token=${META_LONG_LIVED_ACCESS_TOKEN}"
```

```json
{"data":[{"id":"...","subscribed_fields":["comments","messages","messaging_postbacks"]}]}
```

Do **not** use `GET /${META_GRAPH_VERSION}/{app-id}/subscriptions` with an app token to check this. Because we authenticate through Instagram Login, the app-level subscription lives under the Instagram app rather than the Facebook app, and that endpoint returns `{"data":[]}` against the Facebook app ID even when webhooks are working perfectly. It looks like a broken subscription and isn't one.

## Permissions requested

| Scope | Requested by | Justification |
|---|---|---|
| `instagram_business_basic` | both apps | Identify the connected professional account |
| `instagram_business_manage_comments` | both apps | Read comments (the trigger) and send private replies |
| `instagram_business_manage_messages` | both apps | Send the DM and receive the button postback |
| `instagram_business_content_publish` | ours | Publish carousels — the entire publishing half of this product |
| `instagram_business_manage_insights` | OpenReply's OAuth | **Only** used by OpenReply's analytics pages, which we don't use. Droppable if we never enable those |

`vendor/openreply/META_APP_REVIEW.md` documents only the first three. Requesting a scope you haven't justified is a straightforward review rejection, so both extras must be covered in the submission or removed. See the note appended to that file.

## Data retention

Implemented in `packages/publisher/src/retention.ts`, scheduled daily at 04:00 UTC by `apps/worker`.

| Data | Treatment | Default | Env |
|---|---|---|---|
| Raw Meta webhook payloads (`WebhookEvent`, `webhook_events`) | Deleted | 30 days | `RAW_PAYLOAD_RETENTION_DAYS` |
| Commenter name + comment text (`DmLog`, `comment_events`) | Nulled in place, row kept | 90 days | `PII_RETENTION_DAYS` |

Logs are anonymised rather than deleted so historical dashboard counts stay stable. `commenterId` is retained deliberately — it's an opaque Meta-scoped identifier and it is the dedup key the send path depends on.

Inspect before trusting:
```bash
npx tsx --env-file=.env scripts/purge-dry-run.ts
```

## Rate limiting

OpenReply enforces **750 sends/hour per Instagram account** (`lib/utils/rate-limiter.ts` — Redis fixed window, atomic Lua reserve, requeues up to 3× before marking `SKIPPED_RATE_LIMIT`).

**Verified 2026-10-01 (this corrects the August note that called the number unverified).** Meta's [Instagram Platform rate limits](https://developers.facebook.com/docs/instagram-platform/overview) and [Graph API rate-limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting) pages state, for the Private Replies API: **750 calls per hour per Instagram professional account** for private replies to comments on posts and reels, and 100 calls/second for Instagram Live comments. Other documented limits: Send API 100 calls/sec (text, links, reactions, stickers) and 10 calls/sec for audio/video messages; Conversations API 2 calls/sec. General Business Use Case limit: 4800 x impressions calls per 24 hours.

Caveats: (1) 750/hour applies to the **private reply** call only. The button-tap reveal DM is a normal Send API call (100/sec) and should not consume the same budget. `dm-worker.ts` calls `reserveDMSlot` once per comment-triggered send; whether the postback reveal path is also counted was not audited here. (2) The limiter is a fixed window while Meta does not state its window type, so bursts at a window edge can exceed 750 in any rolling hour; keep headroom (see "Code changes recommended"). (3) Meta does not document a separate per-day DM cap on these pages; blog posts quoting other caps are not relied on.

## Known limitations

**Dedup is per-comment, not per-person.** `SKIPPED_DEDUP` only fires when another campaign already consumed the single private reply allowed for that specific comment. One person commenting the keyword on three different posts receives three DMs. This is the main remaining spam-report vector. Fixing it properly means modifying vendored OpenReply code; until then, avoid running the same keyword across many simultaneous campaigns.

**Token refresh fails silently at source.** OpenReply's daily cron logs an `OperationalEvent` and returns 200 — no retry, no account disable. We surface it instead: `getTokenHealth()` in `packages/publisher/src/stats.ts` drives a warning banner on Settings. Act on that banner; nothing else will.

## Pre-submission checklist

- [ ] `messaging_postbacks` subscribed **and confirmed via the API**, not just the console
- [ ] `messaging_seen` NOT subscribed
- [ ] All five requested scopes justified in the App Review submission, or the unused ones removed
- [ ] Opening-DM copy discloses the experience is automated
- [ ] Privacy policy, terms, and data-deletion URLs reachable on the live domain
- [ ] `scripts/purge-dry-run.ts` reviewed, and the retention job confirmed running in worker logs
- [x] Rate-limit constant re-checked against current Meta docs (750/hour private replies confirmed 2026-10-01; re-check again at submission)
- [ ] App is in **Live** mode and the IG account is public (required for `comments` webhooks); Advanced Access requested for `comments`
- [ ] Every requested `instagram_business_*` permission has a working test API call logged before submitting (Meta asks for at least one successful call per permission)
- [ ] Reviewer instructions include test credentials and explain the two-step (tap-to-reveal) flow
- [ ] Long-lived token refresh confirmed working (token health banner green; token younger than 60 days, refreshed at least once after 24h of age)
- [ ] `META_GRAPH_VERSION` is consistent across `.env`, `render.yaml`, and docs (see "Code changes recommended")
- [ ] If AI-generated images are published, `is_ai_generated` is set (see Changes since last verification)
- [ ] Every rule in the table above re-verified against live docs — they change

## Changes since last verification

Re-verified **2026-10-01** against developers.facebook.com. Status tags: VERIFIED = read from an official Meta page; NOT FOUND = the official page did not state it; UNVERIFIED = no official source reached.

**Graph API versions (VERIFIED, [versions page](https://developers.facebook.com/docs/graph-api/changelog/versions))**

| Version | Released | Expires |
|---|---|---|
| v26.0 | 2026-07-29 | TBD (latest) |
| v25.0 | 2026-02-18 | 2028-07-29 |
| v24.0 | 2025-10-08 | 2028-02-18 |
| v23.0 | 2025-05-29 | 2027-10-08 |

- v25.0 is still valid and does not sunset until 2028-07-29. No forced migration. Moving to v26.0 is optional; the v26.0 breaking-changes list ([changelog](https://developers.facebook.com/docs/graph-api/changelog/version26.0)) concerns Commerce, Marketing, Pages and Rights Manager APIs and nothing we call. Not tested against our code, so do it on a branch.
- **Repo inconsistency (was in this doc):** the curl examples here and in `docs/PRODUCTION.md` used `v26.0` while `.env.example`, `render.yaml` and code default to `v25.0`; `docs/RENDER-FREE.md` uses `v26.0`. Both versions exist, so nothing is broken, but pick one. Examples here now use `${META_GRAPH_VERSION}`.
- **2026-10-27 (VERIFIED, same changelog):** on all supported versions, Graph API drops the `pretty` and `debug` params (ignored), errors on `date_format`, errors on `GET /?ids=...`, ignores `If-None-Match`. We found no use of these in `packages/meta` (grep of version strings only; a full search for `pretty`/`debug`/`date_format` in requests was not done).

**Instagram Platform changelog since the August check ([changelog](https://developers.facebook.com/docs/instagram-platform/changelog), VERIFIED)**
- 2026-06-22: Content Publishing API `is_ai_generated` parameter (AI info label). For carousels set it only on the carousel container, not children. This predates the August check but the doc did not mention it. Optional, but if the operator publishes AI-generated imagery, use it (it is self-disclosure; Meta does not state on these pages that it is mandatory, so whether it becomes a requirement is UNVERIFIED).
- 2026-05-06: multi-image sending in Instagram Direct out of beta. 2026-03-13: Direct Send supports images via attachment IDs. Not used by us.
- 2026-04-22: "Paid partnership" label at publish time; like/unlike media and comments API. Not used.
- No changelog entry found for changes to private replies, the messaging window, webhook signatures, or scopes since August. The [out-of-cycle changes page](https://developers.facebook.com/docs/graph-api/changelog/out-of-cycle-changes) had no 2026 entries when fetched.

**Rules re-checked (VERIFIED, unchanged):**
- Carousel: up to **10** items; a carousel counts as **one** post; limit is **100 API-published posts per moving 24 hours**; check with `GET /{ig-id}/content_publishing_limit`. JPEG only for images (MPO/JPS unsupported); image URLs must be publicly reachable at publish time. ([Content publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing))
- Private reply: within **7 days** of the comment; **one** message per comment; for Live, only during the broadcast. Follow-ups only if the recipient responds, within 24h of the response.
- Long-lived token: **60 days**. Refresh requires the token to be at least 24 hours old, not yet expired, and `instagram_business_basic` granted; an expired token cannot be refreshed and the user must re-authorize. ([Business login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login)) The authorization code is valid 1 hour and single-use.
- Webhooks: `X-Hub-Signature-256` with the app secret; failed deliveries are retried for up to ~36 hours, so handlers must be idempotent; app must be Live; `comments` needs Advanced Access; the IG account must be public. Meta also documents optional mTLS (client cert CN `client.webhooks.fbclientcerts.com`); we do not use it. ([Webhooks](https://developers.facebook.com/docs/instagram-platform/webhooks))
- Permissions: all `instagram_business_*` permissions need Advanced Access via App Review when used for accounts you don't own/have a role on; Meta asks for step-by-step reviewer instructions, test credentials and at least one successful API call. ([Instagram App Review](https://developers.facebook.com/docs/instagram-platform/app-review)) For accounts where the operator has an app role, Standard Access works without review (per Meta's general App Review page: unapproved permissions work for users with app roles).

**Corrections to the August version**
1. The 750/hour constant is real, but scoped to private replies only (see Rate limiting).
2. The `human_agent` 7-day duration is documented on the Messenger Platform policy page, not on the Instagram API page.
3. The automated-experience citation pointed at a help-centre root; replaced with the Messenger Platform policy text.
4. The curl examples pinned `v26.0` inconsistently with the code.

**Could NOT verify (be honest with the reviewer; check manually)**
- The current text of the Meta Platform Terms and Developer Policies (not fetched; no change is claimed either way).
- Business Verification: the pages reached did not say whether it is required for our case. Historically it is needed for Advanced Access for apps serving other businesses; treat as possibly required and check the App Dashboard's App Review > Requirements panel.
- Whether Meta currently requires an annual Data Use Checkup for this app type (not stated on pages reached).
- Any new AI-labelling or bot-disclosure rule beyond the existing "disclose automation" policy and the optional `is_ai_generated` parameter.
- Short-lived token lifetime (not stated on the page reached; commonly 1 hour per other Meta docs, not confirmed here).
- The Data Deletion Callback page was not re-fetched; the "callback or instructions URL" statement is from August.

## Code changes recommended

Nothing below was changed by this update; these are items the docs above imply.

| File | What |
|---|---|
| `.env.example` (line ~102-104), `render.yaml` (lines ~53, ~117), `docs/RENDER-FREE.md` (lines ~45, ~97), `docs/SETUP.md`, `docs/TASKS.md` | Decide one Graph API version. v25.0 is valid until 2028-07-29; v26.0 is latest. Make all files agree. The `.env.example` comment that v25.0 is "a fresher signal than training data" is stale now that v26.0 exists. `docs/PRODUCTION.md` line ~86 still hardcodes `v26.0` in its curl |
| `vendor/openreply/lib/utils/rate-limiter.ts` (do not edit vendored code casually) | 750/hour is correct for private replies, but the fixed window can allow bursts over 750 in a rolling hour; consider a lower ceiling (for example 600-700) via config, and confirm the postback reveal send is not counted against it |
| `packages/publisher` (publish path) | Check `GET /{ig-id}/content_publishing_limit` before enqueuing and surface remaining quota (100 per 24h); confirm carousel creation rejects more than 10 children and non-JPEG images before calling Meta |
| `packages/meta/src/client.ts` + publish container creation | Optionally expose `is_ai_generated` on the carousel container (not children) for AI-generated posts |
| `apps/web/app/api/meta/oauth/start/route.ts` (line 31) | Requests 4 scopes (no `manage_insights`), while OpenReply's OAuth requests 5; confirm which app/route the production account actually uses, and keep the App Review justification list identical to what is requested |
| Token refresh (`packages/publisher/src/stats.ts` health + refresh job) | Ensure refresh runs well before day 60 and only after the token is 24h old; an expired token cannot be refreshed, so alert at about 50 days, not at expiry |
| `vendor/openreply` opening-DM copy / `campaign-form.tsx` | Keep the automation disclosure; consider repeating it in the reveal DM when the gap between opening DM and tap is large |
| Webhook handler | Confirm idempotency on duplicate deliveries (Meta retries for ~36h); `DmLog @@unique([automationId, commentId])` already covers DMs, but check `webhook_events` insert handles duplicate payloads without error |
