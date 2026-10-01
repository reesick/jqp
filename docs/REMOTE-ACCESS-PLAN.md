# Plan: running jqp from outside the laptop

**Status: plan only. Nothing here has been built or changed.** Facts about Claude's features come from Anthropic's Claude Code documentation (linked); jqp-specific constraints come from the code.

## Goal

From your phone or any browser, ask Claude to check the system, set up a comment-to-DM campaign, queue a post, and watch for problems, without sitting at the laptop, and without making the system easier to abuse.

## What forces things to stay where they are today

| Component | Where it runs | Why |
|---|---|---|
| Publish worker | your laptop | It reads the post's images from a folder on your disk (`folder_path`). Cloud hosts fail with "file not found". |
| `ingest_post_folder` (MCP) | your laptop | Same reason: it registers a local folder. |
| DM worker (`npm run dm-worker`) | your laptop, for now | Not yet on an always-on host (`docs/ORACLE-WORKER.md`). |
| `jqp` MCP server | your laptop (stdio) | Claude Code starts it from `.mcp.json`. Currently **disabled** in `.claude/settings.local.json`; you must approve it to use it. |
| Dashboard, OpenReply, database, Redis | cloud | Reachable from anywhere. |

So "Claude can do it from anywhere" splits into: things that only need the cloud (health, campaigns, queueing), and things that need your disk (new posts).

## Three options

### Option 1. Remote Control: drive the laptop's Claude Code from your phone (available now, no build)
Anthropic's Remote Control connects the Claude mobile app or claude.ai/code to a Claude Code session running on your own computer ([docs](https://code.claude.com/docs/en/remote-control.md)).

- Start it on the laptop: `claude remote-control` (server mode), `claude --remote-control` (full session), or `/remote-control` inside a session.
- Your filesystem, configured **local MCP servers** (including `jqp`), and project settings stay available; the phone is just another window onto the same session.
- Needs: a Pro, Max, Team or Enterprise claude.ai login (not an API key), the laptop **on, awake and online**, and the session left running. It reconnects after a sleep or network drop.
- For jqp specifically, the laptop must also be running `npm run dm-worker` (to send DMs) and `npm run dev:worker` (to publish queued posts).

Good for: everything, including new posts from folders already on the laptop. Weakness: it is your laptop's uptime. Cloud sessions and routines **cannot** reach local MCP servers or files ([docs](https://code.claude.com/docs/en/claude-code-on-the-web.md)).

### Option 2. A hosted (remote) MCP server for the cloud-only tools
Claude supports MCP servers over HTTP with bearer-token or OAuth authentication, added with `claude mcp add --transport http <name> <url>` or as a connector in claude.ai ([docs](https://code.claude.com/docs/en/mcp.md)). A connector is the one kind of MCP that **routines** (scheduled cloud runs, minimum interval 1 hour) can use ([docs](https://code.claude.com/docs/en/routines.md)), so this is also the route to a scheduled health check that does not need the laptop.

What would move to a hosted endpoint (a route in the dashboard app, same code as today): `system_health`, `list_posts`, `get_post`, `list_campaigns`, `recent_problems`, `preview_dm`, `configure_campaign`, `retry_post`, and `publish_post` (it only queues a job). What cannot: `ingest_post_folder`.

Required controls (from the audits):
- Real authentication (OAuth or a long random bearer token), HTTPS only, and an on/off switch in config.
- **A human approval step for anything live.** The `confirm: true` argument is filled in by the model, so it prevents accidents, not attacks. Use Claude's per-tool permissions: put `publish_post`, `configure_campaign`, `retry_post` on **ask**, read-only tools on allow ([docs](https://code.claude.com/docs/en/permissions.md)). Never choose "always allow" for the live tools.
- An audit trail of every tool call (new table) and per-token rate limits.
- Treat text returned to the model (captions, error messages, comments) as untrusted: a comment could contain instructions.

Effort: about 1 to 2 days. Also gives you phone control without the laptop for everything except new posts.

### Option 3. Take the laptop out of the loop entirely
- Run the publish worker and DM worker on an always-on host (the Oracle free VM guide exists).
- Change posts so images come from the cloud: upload to Supabase Storage (or accept image URLs) and have the pipeline read from there instead of `folder_path`. This is the real fix for "publishing is local by construction".
- Add an `upload_post` tool (images + caption) to the hosted server, replacing `ingest_post_folder`.
- Put Redis behind TLS or a private network first (the audit's high finding), since the worker would then run on a server you do not watch.

Effort: about 2 to 4 days, and it touches the publish path, so it needs the same review as the earlier changes.

## Recommended sequence

| Phase | What | Needs |
|---|---|---|
| 0, now | Option 1. Approve the `jqp` server, set the live tools to "ask", start Remote Control, keep the laptop awake (power settings) and plugged in | you |
| 1 | Switch on the monitor and alert emails (`docs/MORNING-CHECKLIST.md`) so you are told when it breaks | GitHub secret and variable |
| 2 | Option 2: hosted MCP with auth, audit log, ask-rules; add a routine for a daily health report | build, review |
| 3 | Option 3: VM for both workers, cloud image upload, Redis TLS | build, review, your VM |
| 4 | Multi-account: the publish pipeline reads `ig_accounts` instead of one env token; token refresh job | build, review |

## Rules for any remote access

1. Live actions (publish, enable a campaign, change DM copy) always need your tap on the Claude prompt. Do not pre-approve them.
2. Do not run the DM worker from a laptop on public Wi-Fi while Redis is unencrypted.
3. Keep tokens out of chat and command lines: use `npm run set-env -- --prompt`-style input (not yet built) or the clipboard helpers.
4. A kill switch: setting `MCP_REMOTE_ENABLED=false` (to be added) or removing the connector must stop all remote control immediately.
5. Rotate the credentials that have appeared in chat before enabling any remote path (`docs/AUDIT-2026-10-01.md`).

## Decisions I need from you

1. Is Option 1 enough for now, or do you want Option 2 built next?
2. Do you want to go to full cloud (Option 3), and if so which host: the Oracle VM?
3. Roughly how many new posts per week will you create from your phone? If zero, Options 1 and 2 cover you and Option 3 can wait.
