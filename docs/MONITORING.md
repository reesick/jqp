# Monitoring, alerts and what gets recorded

Built for roughly 500 DMs a day now and 1000 later. Nothing here stores personal data: no commenter names, no comment text, no tokens.

## What you can see

**System page** (sidebar → System, or Ctrl+K → "System", or `G` then `X`). One screen answering "is it working?":

| Section | Source | Turns amber or red when |
|---|---|---|
| Database | a timed `select 1` | unreachable, or slower than 1.5s |
| OpenReply | its `/api/health`, 6s timeout | no answer (usually Redis is down) |
| Message queue (Redis) | OpenReply health | not connected |
| DM queue | BullMQ counts | more than 200 waiting |
| DM worker | heartbeat | no heartbeat in 2 minutes |
| DM delivery (24h) | DM log | failure rate 10% or more (red at 50%), with at least 10 attempts |
| Hourly send limit | DM log | 70% (amber) or 90% (red) of the 750 per hour limit |
| Instagram connection | token expiry | 7 days left (amber), 3 days or a failed refresh (red) |
| Publishing | posts table | any failed post |

Below that: DMs sent, failed and skipped in the last 24 hours, the top reasons DMs failed, a 7 day table, recent recorded errors, and when the last webhook from Meta arrived.

**Activity page** has the full DM log with filters.

## Where errors are recorded

Table `system_events` (migration `0008_system_events.sql`). Written by:
- API errors (HTTP 500s) in the dashboard
- publish failures and validation failures in the pipeline
- the monitor itself, when a check starts failing or recovers
- the retention job

Events older than `SYSTEM_EVENT_RETENTION_DAYS` (default 90) are deleted by the daily purge. Every message is scrubbed before it is stored: URLs and connection strings are replaced, long opaque strings (tokens, keys) are redacted, and metadata keys that could hold personal content are dropped. The scrubbing is unit tested.

## Alerts

`POST /api/cron/monitor` runs all checks and sends one email when a check **starts** failing, one when it **recovers**, and a reminder every 6 hours while it stays broken. It does not email on every run.

It needs a scheduler. The repository includes `.github/workflows/monitor.yml` (every 10 minutes, plus a daily retention purge at 04:30 UTC). Setup is in `docs/MORNING-CHECKLIST.md`, step 6.

| Variable | Where | Purpose |
|---|---|---|
| `MONITOR_TOKEN` | Vercel + GitHub secret | bearer token for `/api/cron/*`; the endpoints refuse everything without it |
| `ALERT_EMAIL_TO` | Vercel | recipient(s), comma separated |
| `ALERT_SMTP_HOST`, `ALERT_SMTP_PORT`, `ALERT_SMTP_USER`, `ALERT_SMTP_PASS` | Vercel | SMTP sender (Brevo: `smtp-relay.brevo.com`, 587, SMTP login and key). Used in preference to Resend when `ALERT_SMTP_HOST` is set |
| `ALERT_EMAIL_FROM` | Vercel | sender address; must be verified with your mail provider |
| `ALERT_RESEND_API_KEY` | Vercel | alternative to SMTP; falls back to the OpenReply Resend values if set |
| `SYSTEM_EVENT_RETENTION_DAYS` | Vercel | how long events are kept |

If you would rather not use GitHub Actions, any pinger that can send a POST with an `Authorization: Bearer` header works (for example a cron job on the Oracle VM).

## Checking from the command line

- `npm run doctor`: inside view. Schema, migrations, Meta token and webhook subscription, the OpenReply account, storage, Redis, the bridge's column contract.
- `npm run smoke`: outside view of the deployed site. Logs in for real, loads every page, tests the webhook and the security controls.
- `npm run test-email`: sends one test email through the alert path and reports whether the mail server accepted it.
- `npm run set-env`: set variables locally and on Vercel without printing them (`--var`, `--copy`, `--generate`, `--clipboard`).
- `npm run check-redis`: host, port, TLS and PING for the DM queue (never prints the password).

## Scale notes (500 to 1000 DMs a day)

- Average load is under one DM a minute. Bursts are the risk: OpenReply's limiter is a fixed window and gives up on a comment after 3 requeues, so a spike after a viral post can leave comments unanswered. Watch "Hourly send limit" and the "skipped" count.
- Redis: BullMQ polls even when idle, so the Upstash free tier will not hold. See `docs/MORNING-CHECKLIST.md`, step 1.
- Indexes for the dashboard's DM queries are in migration 0008.
- Retention now runs from the cloud (`/api/cron/purge`), so personal data is cleaned up even when your PC is off.
- Compliance detail and the open gaps are in `docs/DATA-PROTECTION.md` and `docs/COMPLIANCE.md`.
