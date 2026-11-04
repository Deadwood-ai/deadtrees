-- "Shared with me" also lists the private PRIWA flights a member can read through
-- project sharing, so the dataset page's link finds their row. These rows follow
-- internal.dataset_capabilities: reader, no end date, no download unless the
-- account may see all private data, and an active named grant takes precedence.
-- A flight has no grant date, so its upload date places it in the list. A member
-- who contributes flights also "reads" their own, and those are not shared with them.

begin;

set local lock_timeout = '5s';

create or replace function public.list_datasets_shared_with_me()
returns table (
	dataset_id bigint,
	role public.dataset_access_role,
	can_download boolean,
	expires_at timestamptz,
	granted_at timestamptz,
	data_access public.access,
	file_name text
)
language sql stable security definer set search_path = ''
as $$
	with active_grant as (
		select grant_row.*
		from public.dataset_access_grants grant_row
		where grant_row.grantee_user_id = auth.uid()
			and (grant_row.expires_at is null or grant_row.expires_at > now())
	)
	select dataset.id, grant_row.role, grant_row.can_download, grant_row.expires_at, grant_row.created_at,
		dataset.data_access, dataset.file_name
	from active_grant grant_row
	join public.v2_datasets dataset on dataset.id = grant_row.dataset_id
	where not dataset.archived
	union all
	select dataset.id, 'reader'::public.dataset_access_role, internal.user_privilege(auth.uid(), 'view_all_private'),
		null::timestamptz, dataset.created_at, dataset.data_access, dataset.file_name
	from public.v2_datasets dataset
	where dataset.id in (select internal.priwa_shared_dataset_ids(auth.uid()))
		and dataset.user_id is distinct from auth.uid()
		and dataset.id not in (select active_grant.dataset_id from active_grant)
	order by 5 desc;
$$;

commit;
