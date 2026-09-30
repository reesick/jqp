# Driving jqp from Claude Code

A small MCP server (`apps/mcp`) lets Claude Code operate this system: check health, register a post folder, publish it, and set up a comment-to-DM campaign. It calls the same code as the dashboard, so the same rules apply.

## Setup (one time)

1. Fix the local database login first (`docs/MORNING-CHECKLIST.md`, step 3). The server reads `DATABASE_URL` from the root `.env`. Until it works, only `preview_dm` and a degraded `system_health` function.
2. Open this folder in Claude Code. The repository contains `.mcp.json`, so Claude Code offers the `jqp` server and asks you to approve it. Approve.
3. Check it: ask "check jqp system health".

Test the wiring without Claude Code: `npm run mcp:selftest`.

To register it somewhere else instead, run `claude mcp add jqp -- node --import tsx <full path>\apps\mcp\src\index.ts`.

## What Claude can do

| Tool | What it does | Safety |
|---|---|---|
| `system_health` | Database, OpenReply, Redis queue, DM worker, delivery rate, send limit, token, failed posts | read-only |
| `list_posts`, `get_post` | Posts and their status, caption, and campaign | read-only |
| `list_campaigns` | Every DM campaign and whether it synced | read-only |
| `recent_problems` | Failed posts and recorded errors, no personal data | read-only |
| `preview_dm` | Shows the cleaned text and warns about length or missing "this is automated" wording | read-only |
| `ingest_post_folder` | Registers a local folder as a post (does not publish) | safe to repeat; limited to `POSTS_ROOT` if you set it |
| `configure_campaign` | Creates or updates the DM automation for a post | `confirm: true` required if it goes live immediately |
| `publish_post` | Queues the post to Instagram | `confirm: true` required |
| `retry_post` | Retries a failed post | `confirm: true` required |

Publishing and live DMs need an explicit `confirm: true`. Claude is instructed to ask you first.

## Message cleaning

Instagram shows DM text exactly as sent. Anything written in Markdown would arrive with the symbols visible. Every campaign write (dashboard, API and these tools) removes `**bold**`, `_italic_`, backticks, headings, `[text](url)` links (kept as "text url"), literal `\n` (turned into a real line break), and spaced `--` (turned into an en dash). URLs, `{placeholders}` and plain text are left alone. `preview_dm` shows the result before anything is saved.

## Example prompts

- "Check system health and tell me what needs attention."
- "Ingest `D:\posts\summer-drop` and show me the caption it found."
- "Set up a two-step campaign on that post: keywords LINK and GUIDE, opening message that says it's automated with a button 'Send it', then the DM with https://example.com/guide. Preview the copy first, leave it disabled."
- "Publish it." (Claude should ask you to confirm before it does.)

## Requirements and limits

- **The local publish worker must be running** (`npm run dev:worker`) for a queued post to go out, and it must be able to reach the database.
- **The server runs on your computer.** Ingest reads folders on your disk, which is also why the publish worker cannot run in the cloud.
- **One Instagram account** for now. Publishing uses `META_LONG_LIVED_ACCESS_TOKEN` from `.env`.
- Set `POSTS_ROOT=D:\posts` in `.env` to restrict which folders Claude can ingest.
