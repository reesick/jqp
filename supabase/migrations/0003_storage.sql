-- ====================================================================
-- jqp — 0003_storage.sql
-- Storage bucket for post media + access policies.
--
-- Design decision (plan section 18, "Option A — Public media URL"):
-- Meta's servers must be able to GET the image_url unauthenticated
-- when creating a container — there is no mechanism for Meta to send
-- credentials on that fetch. A private bucket + signed URL would also
-- work, but signed URLs expire, and if a retry or a slow container
-- poll happens to run past that expiry the publish fails for a reason
-- that has nothing to do with Instagram. For V1, a dedicated
-- public-read bucket with NO write access for anon/authenticated is
-- the simpler, more reliable choice. It holds nothing sensitive —
-- these are the same images about to be posted publicly to Instagram.
--
-- Run this AFTER 0001_init.sql and 0002_rls.sql.
-- ====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'instagram-media',
  'instagram-media',
  true,
  26214400, -- 25 MB, comfortably above Meta's stated per-image limit
  array['image/jpeg', 'image/png']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public read: anyone (including Meta's fetcher, unauthenticated) can
-- GET an object in this bucket. This is the whole point of the bucket.
drop policy if exists "instagram-media public read" on storage.objects;
create policy "instagram-media public read"
  on storage.objects for select
  using (bucket_id = 'instagram-media');

-- Writes are service_role only. anon/authenticated get no insert,
-- update, or delete policy on this bucket, so the app's server code
-- (using the service_role key, which bypasses RLS) is the only writer.
-- No policies are created here for insert/update/delete on purpose —
-- absence of a policy denies the action for anon/authenticated.
