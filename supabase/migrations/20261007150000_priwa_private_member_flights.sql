-- PRIWA partners keep their drone flights inside the project instead of
-- publishing them. A private drone flight uploaded by a member who contributes
-- flights is readable by every member of that project, like a reader grant
-- without download. Memberships are written by the service role only, so this
-- adds no self-service path to private data. Members whose flight contribution
-- is off (reviewers, staff) share nothing through it.

begin;

set local lock_timeout = '5s';

-- Private PRIWA flights a user can read through project membership.
create function internal.priwa_shared_dataset_ids(p_user_id uuid)
returns setof bigint
language sql stable security definer set search_path = ''
as $$
	select dataset.id
	from public.v2_datasets dataset
	join public.priwa_project_memberships uploader
		on uploader.user_id = dataset.user_id
		and uploader.contributes_flights
	join public.priwa_project_memberships reader
		on reader.project_id = uploader.project_id
		and reader.user_id = p_user_id
	where p_user_id is not null
		and dataset.data_access = 'private'
		and dataset.platform = 'drone'
		and not dataset.archived
		-- Uploads carry no project, so an uploader contributing to several
		-- projects shares with none of them rather than with all.
		and not exists (
			select 1 from public.priwa_project_memberships other
			where other.user_id = uploader.user_id
				and other.contributes_flights
				and other.project_id <> uploader.project_id
		);
$$;

revoke all on function internal.priwa_shared_dataset_ids(uuid) from public, anon, authenticated;

-- The set-based rule behind every row policy and dataset view now includes
-- project sharing, so PRIWA lists, footprints, COG rows and labels follow.
create or replace function internal.granted_dataset_ids()
returns setof bigint
language sql stable security definer set search_path = ''
as $$
	select grant_row.dataset_id
	from public.dataset_access_grants grant_row
	join public.v2_datasets dataset on dataset.id = grant_row.dataset_id
	where grant_row.grantee_user_id = (select auth.uid())
		and (grant_row.expires_at is null or grant_row.expires_at > now())
		and not dataset.archived
	union
	select internal.priwa_shared_dataset_ids((select auth.uid()));
$$;

-- The per-dataset rule (signed file tickets, the dataset page) treats project
-- sharing as a reader role unless an explicit grant says more.
create or replace function internal.dataset_capabilities(p_dataset_id bigint, p_user_id uuid)
returns table (
	is_owner boolean,
	role public.dataset_access_role,
	expires_at timestamptz,
	can_download_dataset boolean,
	can_download_labels boolean,
	can_edit_details boolean,
	can_manage_access boolean
)
language sql stable security definer set search_path = ''
as $$
	with dataset as (
		select d.id, d.user_id, d.data_access, d.archived,
			p_user_id is not null and d.user_id = p_user_id as is_owner,
			internal.user_privilege(p_user_id, 'view_all_private') as sees_all
		from public.v2_datasets d
		where d.id = p_dataset_id
	), access as (
		select dataset.*,
			coalesce(
				grant_row.role,
				case when dataset.id in (select internal.priwa_shared_dataset_ids(p_user_id))
					then 'reader'::public.dataset_access_role end
			) as role,
			grant_row.can_download as grant_downloads,
			grant_row.expires_at
		from dataset
		left join public.dataset_access_grants grant_row
			on grant_row.dataset_id = dataset.id
			and grant_row.grantee_user_id = p_user_id
			and (grant_row.expires_at is null or grant_row.expires_at > now())
			and not dataset.archived
	)
	select
		access.is_owner,
		access.role,
		access.expires_at,
		p_user_id is not null and (
			access.data_access = 'public' or access.is_owner or access.sees_all or coalesce(access.grant_downloads, false)
		),
		p_user_id is not null and (
			access.data_access in ('public', 'viewonly') or access.is_owner or access.sees_all
			or coalesce(access.grant_downloads, false)
		),
		access.is_owner or access.role in ('editor', 'admin'),
		access.is_owner or access.role = 'admin' or internal.user_privilege(p_user_id, 'manage_access')
	from access
	where access.data_access <> 'private' or access.is_owner or access.sees_all or access.role is not null;
$$;

commit;
