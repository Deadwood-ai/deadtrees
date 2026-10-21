-- Dataset rows and their file rows could be inserted by any signed-in user.
--
-- "Enable insert for authenticated users only" was WITH CHECK (true) on
-- v2_datasets, v2_orthos, v2_orthos_processed, v2_metadata and v2_raw_images. A
-- user could create a dataset in someone else's name, or give their own dataset an
-- ortho row whose file name points at another file. The download bundle and the
-- processor read that file name, so a download of the user's own dataset returned
-- another dataset's private ortho or a file outside the archive folder (DT-1429).
--
-- Who writes these rows:
-- * v2_datasets: the API on upload, with the uploader's token.
-- * v2_raw_images: the API on a raw-image upload, with the uploader's token, at
--   <raw images folder>/<dataset id>.zip.
-- * v2_orthos, v2_orthos_processed, v2_metadata: the processor only.

begin;

set local lock_timeout = '5s';

drop policy if exists "Enable insert for authenticated users only" on public.v2_datasets;
create policy "Users create their own datasets"
on public.v2_datasets for insert to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists "Enable insert for authenticated users only" on public.v2_raw_images;
create policy "Owners and the processor create raw image rows"
on public.v2_raw_images for insert to authenticated
with check (
	(select auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
	or (
		-- The uploaded zip is always stored as <dataset id>.zip in the raw images folder.
		raw_images_path ~ ('/raw_images/' || dataset_id::text || '\.zip$')
		and position('..' in raw_images_path) = 0
		and exists (
			select 1 from public.v2_datasets d
			where d.id = dataset_id and d.user_id = (select auth.uid())
		)
	)
);

drop policy if exists "Enable insert for authenticated users only" on public.v2_orthos;
create policy "The processor creates ortho rows"
on public.v2_orthos for insert to authenticated
with check ((select auth.jwt() ->> 'email') = 'processor@deadtrees.earth');

drop policy if exists "Enable insert for authenticated users only" on public.v2_orthos_processed;
create policy "The processor creates processed ortho rows"
on public.v2_orthos_processed for insert to authenticated
with check ((select auth.jwt() ->> 'email') = 'processor@deadtrees.earth');

drop policy if exists "Enable insert for authenticated users only" on public.v2_metadata;
create policy "The processor creates metadata rows"
on public.v2_metadata for insert to authenticated
with check ((select auth.jwt() ->> 'email') = 'processor@deadtrees.earth');

-- No policy lets anonymous callers write these tables; drop the unused grants too.
revoke insert, update, delete, truncate on table
	public.v2_datasets,
	public.v2_raw_images,
	public.v2_orthos,
	public.v2_orthos_processed,
	public.v2_metadata
from anon;

commit;
