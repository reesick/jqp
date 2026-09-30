-- Durable, privacy-safe record of what the system did and what went wrong.
--
-- Why this exists: runtime logs on Vercel are short-lived and the publish worker
-- logs to a local terminal, so a failure at 3am was gone by morning. These two
-- tables survive that, and power the /system page and the email alerts.
--
-- PRIVACY RULE: nothing personal goes in here. No commenter names, comment text,
-- Instagram usernames, tokens or secrets. `message` is a short technical
-- description and `meta` holds counters and opaque ids only. The writer
-- (packages/publisher/src/events.ts) also scrubs both as a second line of defence.

create table if not exists system_events (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  level          text not null check (level in ('info', 'warn', 'error')),
  source         text not null,           -- publish | dm-sync | api | auth | monitor | retention
  code           text not null,           -- stable machine code, e.g. post_publish_failed
  message        text not null,
  correlation_id text,
  meta           jsonb not null default '{}'::jsonb
);

create index if not exists idx_system_events_created_at on system_events (created_at desc);
create index if not exists idx_system_events_level_created on system_events (level, created_at desc);
create index if not exists idx_system_events_code_created on system_events (code, created_at desc);

-- One row per monitored condition, so an alert fires when a check STARTS failing
-- (and once more when it recovers), instead of emailing on every poll.
create table if not exists alert_state (
  key              text primary key,
  status           text not null check (status in ('ok', 'failing')),
  since            timestamptz not null default now(),
  last_notified_at timestamptz,
  detail           text not null default ''
);

-- Same lockdown as 0006: the anon/authenticated API roles must never see these.
revoke all on system_events from anon, authenticated;
revoke all on alert_state from anon, authenticated;
alter table system_events enable row level security;
alter table system_events force row level security;
alter table alert_state enable row level security;
alter table alert_state force row level security;

-- Indexes the dashboard's DM queries need at 500-1000 DMs/day. OpenReply's
-- DmLog only indexes workspaceId, so status/recency aggregates scan the table.
-- Guarded: a fresh install without OpenReply migrated must not fail here.
do $$
begin
  if to_regclass('public."DmLog"') is not null then
    create index if not exists idx_dmlog_created_at on "DmLog" ("createdAt" desc);
    create index if not exists idx_dmlog_status_created on "DmLog" (status, "createdAt" desc);
  end if;
  if to_regclass('public."WebhookEvent"') is not null then
    create index if not exists idx_webhookevent_created_at on "WebhookEvent" ("createdAt" desc);
  end if;
end $$;
