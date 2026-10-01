# Remediation plan: what to fix, in what order, and what is not worth fixing

Merges four independent reviews and the incidents of this week: `docs/SECURITY-AUDIT.md`, `docs/SECURITY-AUDIT-2.md`, `docs/COMPLIANCE-AUDIT-2.md`, `docs/SYSTEM-AUDIT.md` (reliability, 17 findings, details and file references there). Two findings were re-verified by hand in the code (SA-01, SA-03).

**How "worth it" was judged.** This is one operator, one Instagram account, 100 to 200 DMs a day, a private repository. A flaw is worth fixing when it can (a) double-post or send DMs you think are stopped, (b) lose data, (c) fail silently, or (d) cost hours to repair after it happens, and the fix is cheap. Enterprise-grade hardening that protects against attackers who do not exist for a system this size is deferred, with the reason written down.

## Use this until SA-03 is fixed
**The campaign on/off switch does not stop DMs.** Disabling a campaign in the dashboard or through Claude never reaches OpenReply (`openreply-bridge.ts:83` returns early; the API only syncs enabled campaigns). To stop DMs now, use one of these:
1. Turn the automation off in **OpenReply's own dashboard**, or
2. Stop the DM worker (`Ctrl+C` in its terminal). Queued comments wait in Redis and are answered when it restarts, as long as it is within Meta's 7-day window.

## A. Fix now (cheap, and each one protects against a real loss)

| ID | Problem | Why it matters | Effort | Who |
|---|---|---|---|---|
| A1 | **Secrets that appeared in chat**: Supabase database password, Redis password, Brevo SMTP key, Supabase access token | Anyone with a transcript or shell history has live access | 20 min | you (`npm run set-database-url`, `set-redis`, `set-env`; delete the token in Supabase) |
| A2 | **Plaintext `.env.*bak*` files (14) and a folder other Windows accounts can read** | Every secret in one readable place | 5 min | you: delete the backups; `icacls D:\jqp /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" "SYSTEM:(OI)(CI)F"` |
| A3 | **The monitor and cloud retention are not scheduled** | No alert email can fire; personal data only purged when the laptop worker runs | 5 min | you: GitHub secret `MONITOR_TOKEN` + variable `MONITOR_URL`, run the workflow once |
| A4 | **SA-03: disabling a campaign does not stop DMs** | You may believe sending has stopped when it has not | 1 to 2 h | me |
| A5 | **SA-01: a post can publish twice** (publish, then record, with Retry reusing the post) | Duplicate public post | 3 to 4 h | me |
| A6 | **SA-02: `singletonKey` does nothing** (queue policy), so two jobs can run for one post | Same duplicate-post path | 2 h | me |
| A7 | **SA-05: bridge insert is not atomic**; a retry makes a second automation | Duplicate public replies under comments | 2 h | me |
| A8 | **SA-06: the publishing token expires in 60 days and nothing refreshes it** | Posting stops silently on one day | 2 to 3 h, after checking its expiry date | me |
| A9 | **SA-07: Retry reuses dead containers** | A failed post fails identically every time | 1 to 2 h (do with A5) | me |
| A10 | **First live campaign sends a direct DM with no "automated" line** | Spam reports; Meta's policy expects disclosure | 10 min | you approve new copy, or turn on two-step |
| A11 | **OpenReply cron secret** (`CRON_SECRET` unset means `Bearer undefined` passes) | Anyone can trigger token refresh and snapshot jobs | 2 min | you, on `jqp-openreply-1` |
| A12 | **Dashboard password length is not enforced** | A short password is guessable at scale | 2 min | you: 32+ random characters |

**Total:** about 30 minutes of your time and about one day of mine. This list removes every path found that can double-post, send DMs you think are stopped, or fail without warning.

## B. Fix before scaling past about 200 DMs a day, or before moving workers to a VM

| ID | Problem | Verdict reasoning | Effort |
|---|---|---|---|
| B1 | **Redis is unencrypted** (`redis://`); job payloads hold commenter names and text, and the password can queue forged DMs | Realistic only on a hostile network. Required before the worker leaves the house | 1 to 3 h plus a TLS plan |
| B2 | **Viral-burst pacing**: up to about 750 identical DMs in 4 to 8 minutes, public replies unpaced | The one thing that can get the account flagged. Patches vendored code, needs your approval | 3 to 5 h |
| B3 | **Public replies are one identical string** | Cheap to improve in our own bridge (reply variations); also reduces spam-pattern risk | 2 h |
| B4 | **No per-person erasure path**; the data-deletion page names no contact | Meta's terms expect one. Required before App Review or multi-account | 4 to 8 h |
| B5 | **Connection budget** (SA-11): worker, web and MCP can each take up to 8 of about 15 | Caused a real outage. Convention only; add a startup check and per-process caps | 2 h |
| B6 | **Job expiry 300 s and `QUEUE_CONCURRENCY` ineffective** (SA-08) | Fine at one post a day; breaks with parallel posts | 2 h |
| B7 | **Catch-up window 72 h vs Meta's 7 days** (SA-09) | Raise `COMMENT_POLL_LOOKBACK_HOURS` when you start after an outage | 5 min |
| B8 | **MCP hardening**: set `POSTS_ROOT`; put live tools on "ask"; `confirm: true` is model-supplied | Cheap, and the real defence against a prompt-injected action | 30 min |
| B9 | **Ingest `folderPath` unrestricted** on the web route | Only matters if someone else gets your login | 1 h |
| B10 | **Monitor coverage**: no checks for the publish worker, stuck posts, failed syncs, webhook silence, publish-token expiry | Turns "silent" into "emailed" | 3 to 4 h |
| B11 | **`scrubText` lets emails and @handles into the event log** | Privacy hygiene; small fix | 1 h |
| B12 | **No automated backups** | `npm run backup` exists; schedule it (Task Scheduler) or buy Supabase Pro | 30 min |

## C. Accept or defer, with reasons

| Item | Why it can wait |
|---|---|
| Content-Security-Policy header | Moderate effort, needs preview testing; low risk for a login-protected single-user dashboard |
| Database TLS certificate verification | Needs the Supabase CA pinned; the path is inside one cloud provider; low realistic risk |
| Superuser database role | Splitting roles is real work; the blast radius needs a first breach to matter |
| `sharp` and `nodemailer` advisories | Not reachable with attacker-controlled input here; `sharp` fix is a breaking upgrade in the publish path |
| Shared-secret login, no 2FA | Acceptable for one operator once the password is long; revisit for multi-user |
| STOP / opt-out keyword handling | No explicit Meta requirement found; add if complaints appear |
| Redis keeps the last 1000 completed jobs | Folded into B1/B2; matters when Redis is shared or TLS is absent |
| Key rotation for stored tokens | No scenario yet; add before multi-account |
| Docs contradiction (migrations on deploy) | Already corrected in `LIVE.md`; `DEPLOY.md` still says the old thing, fix when touching docs |

## Suggested order

1. **Today, you:** A1, A2, A3, A11, A12 (about 30 minutes). Decide A10.
2. **Next, me, with review:** A4 first (it is a safety switch), then A5, A6, A9 together (publish path), then A7, A8. Each with tests and the same independent review as before.
3. **Before any VM or second account:** B1, B2, B3, B5, B8, B10, B12.
4. **When convenient:** the rest of B. Nothing in C needs a date.

Verification after each item: `npm run doctor`, `npm run smoke`, and the checklist in `docs/CLAUDE-CONTENT-GUIDE.md` section 5.
