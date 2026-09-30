-- Stop anonymous enumeration of the media bucket.
--
-- A public bucket already serves objects by URL without any SELECT policy, so
-- Meta can still fetch the images. The policy dropped here additionally let
-- anyone holding the (public) anon key call the Storage list API and see every
-- object, including draft images for posts not yet published.
--
-- After applying: confirm a known image URL still loads.
drop policy if exists "instagram-media public read" on storage.objects;
