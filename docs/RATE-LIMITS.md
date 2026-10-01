# Meta rate limits: what applies, what the system does, what it does not

Source for all figures: [Meta rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting) and [Content Publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing), read 2026-10-01. Meta changes these; re-read before relying on a number.

## The limits that matter

| Limit | Figure | Applies to |
|---|---|---|
| Application-level | calls per hour = 200 × number of users. Header `X-App-Usage` reports `call_count`, `total_time`, `total_cputime` as percentages | every Graph call from the app |
| Instagram business use case | calls per 24 h = 4800 × impressions. Header `X-Business-Use-Case-Usage` adds `estimated_time_to_regain_access` (minutes). Error code **80002** when limited | Instagram API calls per account |
| Publishing | 100 API-published posts per rolling 24 h; a carousel counts as one. One part of Meta's page also mentions a carousel figure of 50, which the page does not explain, so treat 50 as the safe ceiling | `content_publishing_limit` |
| Messaging (Send API) | 100 calls per second for text and links, 10 per second for audio and video, per account | DM sending |
| Private replies | 750 per hour per account, one reply per comment, within 7 days of the comment (see `docs/COMPLIANCE.md`) | comment-to-DM |

Meta's guidance when a limit is hit: **stop making calls and wait for the time the header gives you.**

## What this means at your volume

At 100 to 200 DMs a day you average a DM every 7 to 15 minutes. That is nowhere near 750 an hour or 100 calls a second, and a few posts a day is far below the publishing cap. **Raw rate limits are not your realistic risk.** The realistic risks are:

- a burst after a viral post (hundreds of comments in minutes),
- Meta temporarily blocking an account that sends many near-identical messages quickly (anti-spam, separate from rate limits),
- an expired or revoked token.

## What the code does about it

| Situation | Behaviour |
|---|---|
| Publishing call returns 80002, 4, 17, 32, 613, 429 or 5xx | Treated as a temporary rate limit, never as a permanent failure. (Before 2026-10-01 code 80002 was classified as permanent and would have marked a throttled post FAILED for good.) |
| Meta says how long to wait | The wait comes from `estimated_time_to_regain_access` or `Retry-After`. Waits up to 20 s are slept in place; longer waits are handed back to the queue so a worker slot is not pinned. |
| Publish job keeps failing temporarily | Up to 8 retries with exponential backoff from 60 s: roughly 1, 2, 4, 8, 16, 32, 64, 128 minutes, about four hours in total. After that the job stops and the post can be retried by hand. |
| Usage reaches 75% of any limit | A warning is recorded (`meta_usage_high`), at most once per 10 minutes. Being throttled records an error (`meta_throttled`) with the minutes remaining. Both appear on the System page and in alert emails. |
| Deferred by a throttle | `publish_rate_limited` is recorded on each deferral. |
| DM send approaches 750 per hour | The System page's "Hourly send limit" turns amber at 70% and red at 90%. |

Tests: `packages/meta/src/usage.test.ts`, `packages/meta/src/errors.test.ts`.

## What it does not do (known gaps)

1. **OpenReply (the DM sender) is not changed by any of the above.** It is vendored and unmodified. Its limiter is a fixed one-hour window of 750 sends; after 3 requeues a comment is marked skipped and never answered. At your volume this will not trigger, but a very large burst could lose comments. Mitigation if it ever matters: raise it with OpenReply upstream, or throttle at the source by not running many campaigns on one viral post.
2. **No read of `content_publishing_limit` before publishing.** The 100-per-day cap is far above your use, so a pre-check was not added. If you start publishing dozens of posts a day, add one.
3. **No post scheduler.** Posts publish when you ask. A future `publishAt` would be simple to add (the queue supports delayed jobs), but the local worker must be running at that time, because the images live on your computer. Not built, by decision.
4. **Meta's usage headers are only seen on our own calls** (publishing, OAuth, token refresh). DM sends happen inside OpenReply and report nothing back to us.

## If Meta throttles you

1. The System page shows **Meta is throttling this account; access returns in about N min**, and the alert email says the same.
2. Do nothing. Publish jobs retry on their own. Do not click Retry repeatedly: every attempt during a throttle counts and can extend it.
3. If it happens more than once a week, look at what is generating the calls (a loop, a stuck job) with `npm run doctor` and the System page's recent problems.
