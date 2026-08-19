-- ====================================================================
-- jqp — 0002_rls.sql
-- Row Level Security: default-deny for `anon` and `authenticated`.
--
-- Design decision: this application has NO browser-side Supabase
-- client. The Next.js dashboard (apps/web) and the worker
-- (apps/worker) both talk to Postgres exclusively with the
-- service_role key on the server, which bypasses RLS entirely.
-- Nothing in this system ever ships SUPABASE_ANON_KEY to a browser
-- or uses it to query these tables. RLS here exists as a defense-in-
-- depth backstop: if a key were ever leaked or a client accidentally
-- misconfigured, these policies mean it still can't read or write
-- anything (no policies = no access once RLS is enabled).
--
-- Run this AFTER 0001_init.sql.
-- ====================================================================

alter table ig_accounts    enable row level security;
alter table posts          enable row level security;
alter table post_media     enable row level security;
alter table campaigns      enable row level security;
alter table webhook_events enable row level security;
alter table comment_events enable row level security;
alter table dm_logs        enable row level security;

-- Force RLS even for the table owner (belt-and-suspenders; service_role
-- still bypasses RLS entirely regardless of this setting — it's the
-- anon/authenticated roles this protects against).
alter table ig_accounts    force row level security;
alter table posts          force row level security;
alter table post_media     force row level security;
alter table campaigns      force row level security;
alter table webhook_events force row level security;
alter table comment_events force row level security;
alter table dm_logs        force row level security;

-- No policies are created for `anon` or `authenticated`. With RLS
-- enabled and zero policies, every query from those roles returns
-- zero rows / is rejected. service_role is exempt from RLS by
-- Supabase design and is the only role this app uses server-side.
--
-- If you later add a Supabase Auth-based multi-user dashboard, add
-- explicit `create policy ... for select using (...)` statements
-- scoped to the authenticated user at that point — do not widen
-- access by disabling RLS.
