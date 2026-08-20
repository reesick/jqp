# Meta / Instagram compliance

What this system does, which Meta rules govern it, and where each rule is enforced in code. Written so it can be handed to an app reviewer, and so nobody has to re-derive Meta's rules from memory.

**Verify before every App Review submission.** The rules below were checked against Meta's live documentation in August 2026. Meta changes these; the citations are where to re-check, not a permanent guarantee.

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
| **24-hour** messaging window after a user-initiated interaction | [Messenger/IG Messaging policy](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview/) | The reveal DM is sent in direct response to a button tap, so it is inside the window by construction |
| `human_agent` tag extends the window to 7 days | same | **Not used.** We send nothing outside the window, so we don't need it |
| Automated experiences must **disclose** they're automated at the start of a conversation | [Instagram automated-experience guidance](https://help.instagram.com/) | Default opening-DM copy discloses it; `campaign-form.tsx` warns if the operator removes it |
| Button template: 640-char text, 20-char button title, max 3 buttons | `vendor/openreply/lib/meta/client.ts` (truncates to exactly these) | Capped at the input in `campaign-form.tsx` and again in `openreply-bridge.ts`, so nothing is silently cut at send time |
| Inbound webhooks must be signature-verified | Meta webhooks | `vendor/openreply/lib/meta/webhook.ts` — HMAC-SHA256, `timingSafeEqual`, 401 on mismatch |
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
curl -s "https://graph.instagram.com/v26.0/${META_IG_USER_ID}/subscribed_apps?access_token=${META_LONG_LIVED_ACCESS_TOKEN}"
```

```json
{"data":[{"id":"...","subscribed_fields":["comments","messages","messaging_postbacks"]}]}
```

Do **not** use `GET /v26.0/{app-id}/subscriptions` with an app token to check this. Because we authenticate through Instagram Login, the app-level subscription lives under the Instagram app rather than the Facebook app, and that endpoint returns `{"data":[]}` against the Facebook app ID even when webhooks are working perfectly. It looks like a broken subscription and isn't one.

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

**This number is unverified.** OpenReply's comment cites "Meta's documented cap," but the only figure confirmable in current Meta docs is 100 calls/sec per account, which is specific to *Live* comment private replies. The limiter mechanism is sound; the constant may be stale. Re-check against current docs before scaling volume.

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
- [ ] Rate-limit constant re-checked against current Meta docs
- [ ] Every rule in the table above re-verified against live docs — they change
