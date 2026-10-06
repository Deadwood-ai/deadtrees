-- Block uploads of a file that is already on the platform.
--
-- The upload fingerprint is shared.hash.get_file_identifier: SHA-256 over the
-- file size and the first and last 10 MB. The API stores it for the uploaded
-- file (GeoTIFF or raw-image ZIP) in v2_datasets.upload_fingerprint; the
-- processor has always stored the same value for the archived orthomosaic in
-- v2_orthos.sha256. A new upload is a duplicate when either column of a
-- non-archived dataset holds its fingerprint, whoever owns that dataset.
BEGIN;

alter table public.v2_datasets add column upload_fingerprint text;

create index v2_datasets_upload_fingerprint_idx on public.v2_datasets (upload_fingerprint)
	where upload_fingerprint is not null;
create index v2_orthos_sha256_idx on public.v2_orthos (sha256);

-- The one owner of the duplicate rule, used by the API, the CLI and the upload
-- dialog. It sees every dataset so that private datasets block too, but it names
-- the existing dataset only to callers who may see it: for a hidden dataset the
-- caller learns that the file exists and nothing else.
create function public.find_duplicate_upload(p_fingerprint text)
returns table (dataset_id bigint, is_own boolean)
language sql stable security definer set search_path = ''
as $$
	select
		case when candidate.is_visible then candidate.id end,
		candidate.is_own
	from (
		select
			dataset.id,
			dataset.created_at,
			dataset.user_id is not distinct from (select auth.uid()) as is_own,
			dataset.id not in (select internal.hidden_private_dataset_ids()) as is_visible
		from public.v2_datasets dataset
		where not dataset.archived
			and dataset.id in (
				select fingerprinted.id from public.v2_datasets fingerprinted
				where fingerprinted.upload_fingerprint = p_fingerprint
				union all
				select ortho.dataset_id from public.v2_orthos ortho
				where ortho.sha256 = p_fingerprint
			)
	) candidate
	order by candidate.is_own desc, candidate.is_visible desc, candidate.created_at, candidate.id
	limit 1;
$$;

revoke all on function public.find_duplicate_upload(text) from public, anon;
grant execute on function public.find_duplicate_upload(text) to authenticated, service_role;

notify pgrst, 'reload schema';

COMMIT;
