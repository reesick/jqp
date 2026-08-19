-- ====================================================================
-- jqp — 0001_init.sql
-- Core schema: enums, tables, constraints, indexes, updated_at triggers.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste this file's
-- contents -> Run. No Supabase CLI required. Safe to re-run: enum
-- creation is guarded, tables use IF NOT EXISTS.
--
-- Run 0002_rls.sql and 0003_storage.sql after this one.
-- ====================================================================

create extension if not exists "pgcrypto";

-- --------------------------------------------------------------------
-- ENUMS
-- --------------------------------------------------------------------

do $$ begin
  create type post_status as enum (
    'DISCOVERED',
    'VALIDATING',
    'VALIDATION_FAILED',
    'UPLOADING',
    'CREATING_CHILDREN',
    'WAITING_FOR_CHILDREN',
    'CREATING_CAROUSEL',
    'WAITING_FOR_CAROUSEL',
    'PUBLISHING',
    'PUBLISHED',
    'FAILED'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type container_status as enum (
    'PENDING',
    'IN_PROGRESS',
    'FINISHED',
    'ERROR',
    'EXPIRED',
    'PUBLISHED'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type campaign_sync_status as enum (
    'DM_SYNC_PENDING',
    'DM_SYNCING',
    'DM_SYNCED',
    'DM_SYNC_FAILED'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type dm_status as enum (
    'PENDING',
    'QUEUED',
    'SENT',
    'FAILED'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type match_mode as enum (
    'WHOLE_WORD',
    'PARTIAL',
    'EXACT'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type comment_event_status as enum (
    'PENDING',
    'MATCHED',
    'NO_MATCH',
    'CAMPAIGN_DISABLED',
    'CAMPAIGN_MISSING',
    'SELF_COMMENT',
    'ALREADY_PROCESSED',
    'QUEUED',
    'DM_SENT',
    'DM_FAILED'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type webhook_event_status as enum (
    'RECEIVED',
    'VALIDATED',
    'ENQUEUED',
    'PROCESSED',
    'ERROR',
    'INVALID_SIGNATURE'
  );
exception when duplicate_object then null; end $$;

-- --------------------------------------------------------------------
-- updated_at trigger helper
-- --------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- --------------------------------------------------------------------
-- ig_accounts — connected Instagram Business/Creator accounts.
-- Access tokens are stored encrypted (AES-256-GCM, see
-- packages/core/src/crypto.ts). This app never writes a plaintext
-- token to the database.
-- --------------------------------------------------------------------

create table if not exists ig_accounts (
  id uuid primary key default gen_random_uuid(),
  ig_user_id text not null unique,
  username text,
  page_id text,
  access_token_encrypted text,
  access_token_iv text,
  access_token_tag text,
  token_expires_at timestamptz,
  connected_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_ig_accounts_updated_at on ig_accounts;
create trigger trg_ig_accounts_updated_at
  before update on ig_accounts
  for each row execute function set_updated_at();

-- --------------------------------------------------------------------
-- posts — one row per content folder (POST_001, ...). This is the
-- publishing state machine's system of record (plan section 19).
-- campaign_id is the folder name and the bridge key used everywhere
-- in the UI; it is NOT the same row as `campaigns` (that table is the
-- DM-side configuration, linked 1:1 once the post is published).
-- --------------------------------------------------------------------

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  campaign_id text not null unique,
  folder_name text not null,
  -- Absolute filesystem path to the content folder, captured at ingestion.
  -- The pipeline re-scans this path on every invocation (resume-safe,
  -- plan section 66), so it must stay valid for the post's lifetime —
  -- content folders are user-managed and can live anywhere on disk,
  -- not necessarily inside this repo.
  folder_path text not null,
  ig_account_id uuid references ig_accounts(id),
  caption text not null default '',
  media_type text not null default 'CAROUSEL' check (media_type in ('IMAGE', 'CAROUSEL')),
  status post_status not null default 'DISCOVERED',
  instagram_media_id text unique,
  carousel_container_id text,
  published_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_posts_updated_at on posts;
create trigger trg_posts_updated_at
  before update on posts
  for each row execute function set_updated_at();

create index if not exists idx_posts_status on posts (status);
create index if not exists idx_posts_created_at on posts (created_at desc);
create index if not exists idx_posts_instagram_media_id on posts (instagram_media_id);

-- --------------------------------------------------------------------
-- post_media — one row per image in a post folder (plan section 20).
-- sequence enforces the numeric 1..10 ordering the scanner extracts
-- from filenames (1.jpg, 2.jpg, ... 10.jpg — never string-sorted).
-- --------------------------------------------------------------------

create table if not exists post_media (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  sequence int not null check (sequence between 1 and 10),
  original_filename text not null,
  storage_path text not null,
  public_url text,
  media_type text not null default 'IMAGE',
  child_container_id text,
  container_status container_status not null default 'PENDING',
  created_at timestamptz not null default now(),
  unique (post_id, sequence)
);

create index if not exists idx_post_media_post_id on post_media (post_id);

-- --------------------------------------------------------------------
-- campaigns — DM configuration STAGED against a post, bridged to
-- OpenReply's Automation table once published (plan sections 21,
-- 33-38). The user can configure keywords/dm_message/destination_url
-- here any time after a post is DISCOVERED — instagram_media_id is
-- nullable and stays null until the post actually reaches PUBLISHED.
-- The sync-campaign-to-openreply job (packages/publisher's bridge,
-- T12) only pushes a row into OpenReply once instagram_media_id is
-- populated and enabled=true — never before (plan section 35: never
-- activate a DM campaign before publishing succeeds).
-- --------------------------------------------------------------------

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null unique references posts(id) on delete cascade,
  instagram_media_id text unique,
  trigger_keywords text[] not null default '{}',
  match_mode match_mode not null default 'WHOLE_WORD',
  dm_message text not null default '',
  destination_url text,
  public_reply_enabled boolean not null default false,
  public_reply_message text,
  enabled boolean not null default false,
  sync_status campaign_sync_status not null default 'DM_SYNC_PENDING',
  sync_error text,
  -- id of the row this campaign was pushed to in OpenReply's "Automation" table.
  -- Lets the bridge job UPDATE the existing Automation on re-sync
  -- (e.g. the user edits keywords after the first sync) instead of
  -- creating a duplicate every retry.
  openreply_automation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_campaigns_updated_at on campaigns;
create trigger trg_campaigns_updated_at
  before update on campaigns
  for each row execute function set_updated_at();

create index if not exists idx_campaigns_instagram_media_id on campaigns (instagram_media_id);
create index if not exists idx_campaigns_enabled on campaigns (enabled);
create index if not exists idx_campaigns_sync_status on campaigns (sync_status);

-- --------------------------------------------------------------------
-- webhook_events — raw audit trail of every inbound Meta webhook
-- delivery (plan section 22). Never rely on application logs alone
-- for tracing a webhook through to its DM outcome.
-- --------------------------------------------------------------------

create table if not exists webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'meta',
  event_type text,
  external_event_id text,
  payload jsonb not null,
  status webhook_event_status not null default 'RECEIVED',
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_webhook_events_received_at on webhook_events (received_at desc);
create index if not exists idx_webhook_events_status on webhook_events (status);

-- --------------------------------------------------------------------
-- comment_events — one row per Instagram comment the webhook has
-- ever seen. comment_id UNIQUE is the actual idempotency guarantee
-- from plan sections 49 and 67: a duplicate webhook delivery for the
-- same comment cannot result in a second DM, because the second
-- insert simply fails the unique constraint before anything is queued.
-- --------------------------------------------------------------------

create table if not exists comment_events (
  id uuid primary key default gen_random_uuid(),
  webhook_event_id uuid references webhook_events(id) on delete set null,
  comment_id text not null unique,
  media_id text not null,
  commenter_ig_id text,
  commenter_username text,
  comment_text text,
  campaign_id uuid references campaigns(id),
  matched boolean not null default false,
  match_keyword text,
  status comment_event_status not null default 'PENDING',
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_comment_events_media_id on comment_events (media_id);
create index if not exists idx_comment_events_campaign_id on comment_events (campaign_id);
create index if not exists idx_comment_events_created_at on comment_events (created_at desc);
create index if not exists idx_comment_events_status on comment_events (status);

-- --------------------------------------------------------------------
-- dm_logs — outcome of every private-reply attempt (plan: "DM logs"
-- under OpenReply's feature list, section 30).
-- --------------------------------------------------------------------

create table if not exists dm_logs (
  id uuid primary key default gen_random_uuid(),
  comment_event_id uuid unique references comment_events(id) on delete cascade,
  campaign_id uuid references campaigns(id),
  recipient_ig_id text,
  message_sent text,
  status dm_status not null default 'PENDING',
  meta_message_id text,
  error_message text,
  attempt_count int not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_dm_logs_updated_at on dm_logs;
create trigger trg_dm_logs_updated_at
  before update on dm_logs
  for each row execute function set_updated_at();

create index if not exists idx_dm_logs_status on dm_logs (status);
create index if not exists idx_dm_logs_campaign_id on dm_logs (campaign_id);
