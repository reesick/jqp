# jqp

Instagram carousel publishing plus comment-to-DM automation, official Meta APIs only. Read `README.md` for architecture and `docs/MORNING-CHECKLIST.md` for current state.

## Ground rules
- This is a **production** system. Do not publish, enable a campaign, or change live data unless the user asked for that specific action. The `jqp` MCP tools require `confirm: true` for exactly these.
- Never read, print or commit `.env` files or any secret. A hook blocks reading them; ask the user for a value instead.
- `vendor/openreply` is vendored and must stay unmodified. Anything it needs is done through `packages/publisher/src/openreply-bridge.ts`.
- Pushing to `main` deploys the dashboard to Vercel. Run `npm run build:packages`, `npm run typecheck`, `npx vitest run` and `npm run build:web` first.

## Layout
`packages/*` shared libraries, `apps/web` dashboard (Next.js), `apps/worker` local publish worker, `apps/mcp` Claude Code server, `vendor/openreply` the DM engine, `supabase/migrations` SQL (applied by hand in the Supabase SQL editor), `scripts/` operational tools.

## Useful commands
`npm run doctor` (inside check), `npm run smoke` (live site check), `npm run check-redis`, `npm run mcp:selftest`.

## Conventions
- DM copy is plain text. `normalizeMessageText` (packages/publisher) strips Markdown and escaped newlines on every campaign write.
- Nothing personal goes in `system_events`; `recordEvent` scrubs messages and metadata.
- Match the surrounding code's style and comment density.
