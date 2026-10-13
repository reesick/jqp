# Meta compliance check, 2026-10-13 (with sources)

For the new account @addaddy.ai. Gathered by an independent research pass that read Meta's own pages on 2026-10-13. Quotes come from a page-reading tool that returns extracts, so they are short and some are fragments: open the link before relying on a quote in an App Review submission. Anything it could not find is marked UNVERIFIED. Earlier documents (`COMPLIANCE.md`, `COMPLIANCE-AUDIT-2.md`, `ADD-ACCOUNT.md`) are superseded where they disagree with this one.

## The finding that decides launch scope

**Meta says Advanced Access is required to receive comment webhooks, and Development mode delivers no webhooks.**

| Rule | Source | Quote |
|---|---|---|
| Comment webhooks need Advanced Access | [Instagram webhooks](https://developers.facebook.com/docs/instagram-platform/webhooks) | "Advanced Access is required to receive `comments` and `live_comments` webhook notifications." |
| The app must be Live | same | "Your app must be set to **Live** in the App Dashboard for Meta to send webhook notifications." |
| Development mode is role holders only | [App modes](https://developers.facebook.com/documentation/development/build-and-test/app-modes.md) | "Apps in Development mode can only request permissions from role users" |
| What Advanced Access needs | [Instagram platform overview](https://developers.facebook.com/docs/instagram-platform/overview) | "This access level requires App Review and Business Verification." |
| Standard Access for your own account | same | "If your app only serves your Instagram professional account or an account you manage, Standard Access is all your app needs." |

Meta's pages conflict: the overview says Standard Access is enough for your own account, and the webhooks page says Advanced Access is required for comment webhooks. **Not found anywhere:** a Meta sentence saying whether comment webhooks from commenters with no role on the app arrive in Live mode on Standard Access. That is UNVERIFIED and can only be settled by a test (below).

What this means in practice:
- Today, only people with a role on the app (you, your testers) can reliably trigger the comment-to-DM flow. Real followers need Advanced Access: App Review plus Business Verification (plus a Data Use Checkup).
- The 5-minute poller still reads comments through the Graph API, so it may find some comments even without webhooks. It is a fallback with a small budget on a new account: Meta's limit is "Calls within 24 hours = 4800 * Number of Impressions" ([rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting)), and Meta says "We strongly recommend using webhooks to prevent rate limiting" ([comment moderation](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/comment-moderation)).
- **The decisive test** (do before announcing a keyword): app in Live mode, @addaddy.ai public, a personal account with NO role on the app comments the keyword. Check that the webhook arrives, the opening DM arrives and the button tap reveals the link. If a step fails, start App Review.

## Rules the system must follow (verified)

| Topic | Rule | Source | Our status |
|---|---|---|---|
| Private reply window | "Your app can send this private reply within 7 days of the creation time of the comment" | [Private replies](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/private-replies) | Compliant (72 hour poll, queue retries) |
| One per comment | "Only one message can be sent to the commenter" | same | Compliant (unique key per automation and comment) |
| Follow-up | "Follow-up messages can only be sent if the recipient responds, and must be sent within 24 hours of the response" | same | Compliant if the follow-up delay is under 24 hours. Whether a button tap counts as "responds" is UNVERIFIED |
| Private reply rate | "Your app can make 750 calls per hour per Instagram professional account for private replies to comments on Instagram posts and reels." | [Overview](https://developers.facebook.com/docs/instagram-platform/overview) | 750 IS documented (this corrects `COMPLIANCE-AUDIT-2.md`). The limiter uses it with no headroom, see gaps |
| Throttle error | Error 80002, header `X-Business-Use-Case-Usage` with `estimated_time_to_regain_access` | [Rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting) | Handled |
| Publishing | "Instagram accounts are limited to 100 API-published posts within a 24-hour moving period. Carousels count as a single post." (the same page also says 50) | [Content publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing) | Compliant at our volume |
| Container expiry | EXPIRED: "The container was not published within 24 hours and has expired." | same | Handled (fails fast, Retry builds a new one) |
| Image format | "JPEG is the only image format supported." Aspect ratio 4:5 to 1.91:1, 8 MB maximum | same, and [media reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media) | Compliant (validator converts and checks) |
| Automation disclosure | "automated chat experiences must disclose that a person is interacting with an automated service" (conditional: required "when required by applicable law", recommended otherwise) | [Overview](https://developers.facebook.com/docs/instagram-platform/overview/), [Messenger policy](https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy) | Compliant only if the first DM says it is automated. Keep the line in every campaign |
| Consent to message | DP 5.2.a: "Don't contact people in Messenger or Instagram Messaging unless you ... have obtained legally sufficient consent, permission, and/or opt-in"; 5.2.b needs an opt-out | [Developer Policies](https://developers.facebook.com/devpolicy/) | Whether a comment counts as opt-in is UNVERIFIED. There is no STOP handling |
| Data deletion | "Update or delete Platform Data promptly after receiving a request from us or the User to do so" | [Platform Terms](https://developers.facebook.com/terms/) section 3.d.i | GAP: no per-person erase path |
| Retention | Delete "When retaining the Platform Data is no longer necessary for a legitimate business purpose" (Meta sets no fixed number of days) | same | Our 30 and 90 days are self-set, do not say Meta mandates them |
| Going Live | Privacy policy URL, data deletion URL or callback, app icon (and category, DPO contact for the EU) | [Create an app](https://developers.facebook.com/documentation/pages-api/create-an-app) | The pages exist; setting them in the dashboard is UNVERIFIED |
| Graph version | v25.0 is valid to 2028-07-29; v26.0 is current | [Versions](https://developers.facebook.com/docs/graph-api/changelog/versions) | Compliant |
| Webhook retries | "we will retry immediately, then try a few more times with decreasing frequency over the next 36 hours." | webhooks page | Dedup handles repeats |

## Gaps and what is done about them

| # | Gap | Fix | State |
|---|---|---|---|
| 1 | Advanced Access for real followers | Live-mode test, then App Review and Business Verification (`vendor/openreply/META_APP_REVIEW.md` has draft wording) | Owner action; task G0 |
| 2 | Repo docs claim Standard Access is enough | Corrected in `ADD-ACCOUNT.md` and `LAUNCH-TASKS.md` | Done |
| 3 | First DM must say it is automated | Put one plain line in every campaign's first message (direct-DM campaigns too) | Content task E2 |
| 4 | Default follow-prompt copy in the vendored worker says "star the repo on github" | Do not use `requireFollow`. Also: Meta says "A user who only commented doesn't grant consent" for the profile API, so a comment-time follow check cannot work, and follow gating is an engagement-gating risk | Keep `requireFollow` off |
| 5 | Identical public replies on every comment | Several reply variants (5 to 8). Spam standard: "posting repetitive content"; [Spam](https://transparency.meta.com/policies/community-standards/spam/) | Open |
| 6 | One person commenting on several posts gets several DMs; the reveal resends on every tap | Cap per person per day | Open |
| 7 | No erasure path or contact on the deletion page | Erase script and a named contact | Open (retention gaps closed in this commit: operational events, link clicks, comment events without a name) |
| 8 | Rate limiter has no headroom (750 fixed window) | Lower the cap to about 600 (a vendored constant) | Open, needs approval to touch vendor |
| 9 | Button template as the private reply, button title limit 20 on Instagram | UNVERIFIED in Meta's docs; it worked in earlier flows | Test once |

## Not covered by Meta's docs (UNVERIFIED)
Whether engagement-bait rules apply to "comment a keyword" on Instagram; Instagram Community Guidelines wording on repetitive comments (the Help Center pages could not be read); whether a deauthorize callback is required for Instagram Login; the `instagram_business_manage_insights` access requirement (drop that scope from the OAuth request unless you use it).
