-- Lock the `public` schema away from Supabase's browser-facing API roles.
--
-- WHY THIS EXISTS
-- ---------------
-- Supabase grants ALL privileges on every table in `public` to `anon` and
-- `authenticated` by default. Those roles are reachable by anyone holding the
-- publishable/anon key — a key whose entire design premise is that it is safe
-- to ship in a browser.
--
-- 0002_rls.sql enabled RLS on our own 7 snake_case tables, which closed the
-- hole for those. But OpenReply's ~16 PascalCase tables arrived later via
-- Prisma into the SAME `public` schema, and nothing ever enabled RLS on them.
-- Verified against the live database with only the anon key, this was readable
-- AND writable: Session.sessionToken (log in as the operator),
-- VerificationToken.token (magic-link bypass), User.email,
-- InstagramAccount.accessToken, DmLog commenter PII, WebhookEvent.payload,
-- and Automation.dmMessage — the last of which, if UPDATEd, would make the
-- connected Instagram account DM attacker-chosen content to real people.
--
-- Two independent layers below, because either one alone is a single mistake
-- away from failing open:
--   1. REVOKE the grants outright.
--   2. ENABLE + FORCE RLS with zero policies (deny-all).
--
-- IMPORTANT OPERATIONAL NOTE
-- --------------------------
-- Both apps connect as the `postgres` superuser (see DATABASE_URL). Superusers
-- bypass RLS and ignore grants, so this migration does NOT break them.
--
-- That is also a landmine: if DATABASE_URL is ever pointed at a NON-superuser
-- role, FORCE ROW LEVEL SECURITY with zero policies means total denial and the
-- entire system stops reading/writing. If you move to a restricted app role,
-- give it BYPASSRLS or write explicit policies for it FIRST.

-- 1. Strip existing privileges and turn on deny-all RLS, table by table.
--    Looped over pg_tables rather than named, so OpenReply's tables (and any
--    added since) are covered without this file needing to know about them.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('revoke all privileges on table public.%I from anon, authenticated', t.tablename);
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('alter table public.%I force row level security', t.tablename);
  end loop;
end $$;

-- 2. Sequences too — a writable sequence is a smaller problem than a writable
--    table, but there's no reason for these roles to hold anything here.
do $$
declare s record;
begin
  for s in select sequencename from pg_sequences where schemaname = 'public'
  loop
    execute format('revoke all privileges on sequence public.%I from anon, authenticated', s.sequencename);
  end loop;
end $$;

-- 3. The part that actually matters long-term.
--    OpenReply runs `prisma migrate deploy` on every Vercel deploy. Without
--    this, each new table it creates arrives with Supabase's default grants and
--    silently re-opens the hole. Default privileges are recorded per creating
--    role, and every migration path here runs as `postgres`.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

-- 4. Final backstop: without USAGE on the schema, these roles cannot resolve an
--    object name in `public` at all, regardless of any grant that later slips
--    through. Safe here because nothing in this stack uses the Supabase REST
--    API — the only Supabase client we run is for Storage, which lives in the
--    `storage` schema and authenticates with the service-role key.
--    If you ever DO want to use the REST API from a browser, this is the line
--    to reconsider first (and you'd then need real policies, not just grants).
revoke usage on schema public from anon, authenticated;
