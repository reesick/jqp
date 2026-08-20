-- Opening DM with a tappable button (two-step reveal).
--
-- Instead of one DM containing the link, the commenter first gets a short
-- message with a button; the link is only sent after they tap it. OpenReply
-- already implements the whole flow (lib/queue/dm-worker.ts processComment ->
-- template_type "button" with a postback payload "reveal:<automationId>", then
-- processPostback sends dmMessage as a normal DM). These three columns are the
-- staging side of Automation.openingDmEnabled / openingDmMessage /
-- openingDmButtonLabel, pushed across by packages/publisher/src/openreply-bridge.ts.
--
-- Why this shape is also better for compliance: the button tap is a genuine
-- user-initiated interaction, which is what legitimately opens Meta's messaging
-- window for the second message. The one-shot DM relies on the private-reply
-- allowance alone.
--
-- Requires the `messaging_postbacks` webhook field to be subscribed in the Meta
-- app console — without it the tap produces no webhook at all and the reveal
-- silently never fires. See docs/COMPLIANCE.md.

alter table campaigns
  add column if not exists opening_dm_enabled boolean not null default false,
  add column if not exists opening_dm_message text,
  add column if not exists opening_dm_button_label text;
