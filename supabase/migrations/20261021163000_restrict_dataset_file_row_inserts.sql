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

-- Rows created before this change are not covered by the new policies. Every writer
-- names the ortho <dataset id>_ortho.tif, so stop here if any row names another file,
-- and review those rows before the API and the processor keep trusting them.
do $$
begin
	if exists (
		select 1 from (
			select ortho_file_name, dataset_id from public.v2_orthos
			union all
			select ortho_file_name, dataset_id from public.v2_orthos_processed
		) o
		where o.ortho_file_name is distinct from o.dataset_id::text || '_ortho.tif'
	) then
		raise exception 'DT-1429: ortho file names must be <dataset id>_ortho.tif; review the rows from the DT-1429 audit query first';
	end if;
end
$$;

drop policy if exists "Enable insert for authenticated users only" on public.v2_datasets;
create policy "Users create their own datasets"
on public.v2_datasets for insert to authenticated
with check (user_id = (select auth.uid()));

-- Files stay on disk when a dataset row is deleted, and they are found by dataset id.
-- So users never choose or change a dataset id: their inserts always get a new one.
create or replace function public.v2_datasets_keep_ids()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	if tg_op = 'INSERT' then
		if current_user = 'authenticated' then
			new.id := nextval(pg_get_serial_sequence('public.v2_datasets', 'id'));
		end if;
	elsif new.id is distinct from old.id then
		raise exception 'Dataset ids cannot change';
	end if;
	return new;
end;
$$;

revoke execute on function public.v2_datasets_keep_ids() from public, anon, authenticated;

drop trigger if exists v2_datasets_keep_ids on public.v2_datasets;
create trigger v2_datasets_keep_ids
before insert or update of id on public.v2_datasets
for each row execute function public.v2_datasets_keep_ids();

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
