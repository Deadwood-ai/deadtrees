-- Dataset sharing: named-user access grants, owner-controlled visibility, and one
-- visibility rule for every dataset row, child table, view and search helper.
--
-- Concepts kept separate:
--   * Visibility (v2_datasets.data_access): public | viewonly | private. Who can
--     find and view a dataset without a grant. Changed only through
--     set_dataset_visibility, which records the change.
--   * Owner (v2_datasets.user_id): the uploader. Always has full access and is
--     never stored as a grant, so existing datasets need no backfill.
--   * Grants (dataset_access_grants): one role per registered user and dataset,
--     optionally expiring, named as in 3Dtrees:
--       reader  view online; download only when can_download is set
--       editor  reader + download + edit descriptive details
--       admin   editor + manage the dataset's grants
--     Visibility, processing, archiving and deletion stay with the owner.
--     Grants never apply to archived datasets.
--   * Download kinds: 'dataset' (orthophoto bundles) and 'labels' (prediction and
--     label GeoPackages). View-only keeps its existing meaning: anyone signed in may
--     download its predictions, only the owner and download grants its orthophoto.
--   * Global privileges: can_view_all_private stays the operational read-all
--     override; can_manage_access is a new, default-off override for support.
--
-- Image files and exports are never served from a public directory listing: the API
-- checks the user_can_* functions below on every request and nginx sends the bytes.

begin;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create type public.dataset_access_role as enum ('reader', 'editor', 'admin');

alter table public.privileged_users
	add column can_manage_access boolean not null default false;

create table public.dataset_access_grants (
	id bigint generated always as identity primary key,
	dataset_id bigint not null references public.v2_datasets (id) on delete cascade,
	grantee_user_id uuid not null references auth.users (id) on delete cascade,
	role public.dataset_access_role not null default 'reader',
	can_download boolean not null default false,
	expires_at timestamptz,
	granted_by uuid references auth.users (id) on delete set null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint dataset_access_grants_one_role unique (dataset_id, grantee_user_id),
	constraint dataset_access_grants_editors_download check (role = 'reader' or can_download)
);

create index dataset_access_grants_grantee_idx
	on public.dataset_access_grants (grantee_user_id, dataset_id);

comment on table public.dataset_access_grants is
	'Named-user access to one dataset. The owner (v2_datasets.user_id) is never stored here. '
	'Change only through set_dataset_access / revoke_dataset_access.';

-- Append-only history of grant and visibility changes. No foreign key to the
-- dataset, so the history survives its deletion.
create table public.dataset_access_events (
	id bigint generated always as identity primary key,
	dataset_id bigint not null,
	actor_user_id uuid,
	subject_user_id uuid,
	action text not null check (action in ('granted', 'changed', 'revoked', 'visibility_changed')),
	old_role public.dataset_access_role,
	new_role public.dataset_access_role,
	old_can_download boolean,
	new_can_download boolean,
	old_expires_at timestamptz,
	new_expires_at timestamptz,
	old_visibility public.access,
	new_visibility public.access,
	created_at timestamptz not null default now()
);

create index dataset_access_events_dataset_idx
	on public.dataset_access_events (dataset_id, created_at desc);

alter table public.dataset_access_grants enable row level security;
alter table public.dataset_access_events enable row level security;

revoke all on table public.dataset_access_grants from public, anon, authenticated;
revoke all on table public.dataset_access_events from public, anon, authenticated;
grant select on table public.dataset_access_grants to authenticated;
grant select on table public.dataset_access_events to authenticated;
grant all on table public.dataset_access_grants to service_role;
grant all on table public.dataset_access_events to service_role;
grant select on table public.dataset_access_grants to analyst;
grant select on table public.dataset_access_events to analyst;
create policy analyst_select on public.dataset_access_grants for select to analyst using (true);
create policy analyst_select on public.dataset_access_events for select to analyst using (true);

-- ---------------------------------------------------------------------------
-- The rule, for a given user
-- ---------------------------------------------------------------------------

-- The user's active grant on a dataset that is not archived.
create function internal.active_grant(p_dataset_id bigint, p_user_id uuid)
returns table (role public.dataset_access_role, can_download boolean)
language sql stable security definer set search_path = ''
as $$
	select grant_row.role, grant_row.can_download
	from public.dataset_access_grants grant_row
	join public.v2_datasets dataset on dataset.id = grant_row.dataset_id
	where p_user_id is not null
		and grant_row.dataset_id = p_dataset_id
		and grant_row.grantee_user_id = p_user_id
		and (grant_row.expires_at is null or grant_row.expires_at > now())
		and not dataset.archived;
$$;

create function internal.user_privilege(p_user_id uuid, p_privilege text)
returns boolean
language sql stable security definer set search_path = ''
as $$
	select p_user_id is not null and coalesce((
		select case p_privilege
			when 'view_all_private' then privilege.can_view_all_private
			when 'manage_access' then privilege.can_manage_access
			else false
		end
		from public.privileged_users privilege
		where privilege.user_id = p_user_id
	), false);
$$;

-- What a user may do with one dataset. A dataset the user cannot view yields no row.
create function internal.dataset_capabilities(p_dataset_id bigint, p_user_id uuid)
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
		select dataset.*, grant_row.role, grant_row.can_download as grant_downloads, grant_row.expires_at
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

revoke all on function internal.active_grant(bigint, uuid) from public, anon, authenticated;
revoke all on function internal.user_privilege(uuid, text) from public, anon, authenticated;
revoke all on function internal.dataset_capabilities(bigint, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The rule, set-based, for row policies (evaluated once per query)
-- ---------------------------------------------------------------------------

-- Datasets the caller can see through an active grant.
create function internal.granted_dataset_ids()
returns setof bigint
language sql stable security definer set search_path = ''
as $$
	select grant_row.dataset_id
	from public.dataset_access_grants grant_row
	join public.v2_datasets dataset on dataset.id = grant_row.dataset_id
	where grant_row.grantee_user_id = (select auth.uid())
		and (grant_row.expires_at is null or grant_row.expires_at > now())
		and not dataset.archived;
$$;

-- Private datasets the caller may not see. Child tables hide exactly these rows,
-- so they follow the v2_datasets policy without a per-row lookup.
create function internal.hidden_private_dataset_ids()
returns setof bigint
language sql stable security definer set search_path = ''
as $$
	select dataset.id
	from public.v2_datasets dataset
	where dataset.data_access = 'private'
		and dataset.user_id is distinct from (select auth.uid())
		and not (select public.can_view_all_private_data())
		and not coalesce((select auth.jwt() ->> 'email') = 'processor@deadtrees.earth', false)
		and dataset.id not in (select internal.granted_dataset_ids());
$$;

revoke all on function internal.granted_dataset_ids() from public, anon, authenticated;
revoke all on function internal.hidden_private_dataset_ids() from public, anon, authenticated;
grant execute on function internal.granted_dataset_ids() to anon, authenticated, service_role;
grant execute on function internal.hidden_private_dataset_ids() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Checks for the app (caller-bound) and the API (service role, for a given user)
-- ---------------------------------------------------------------------------

create function public.can_download_dataset(p_dataset_id bigint, p_kind text)
returns boolean
language sql stable security definer set search_path = ''
as $$
	select coalesce((
		select case p_kind when 'dataset' then capability.can_download_dataset
			when 'labels' then capability.can_download_labels else false end
		from internal.dataset_capabilities(p_dataset_id, auth.uid()) capability
	), false);
$$;

create function public.user_can_view_dataset(p_dataset_id bigint, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
	select exists (select 1 from internal.dataset_capabilities(p_dataset_id, p_user_id));
$$;

-- One query for every dataset in a prepared export.
create function public.user_can_download_datasets(p_dataset_ids bigint[], p_kind text, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
	select p_user_id is not null
		and p_kind in ('dataset', 'labels')
		and coalesce(cardinality(p_dataset_ids) between 1 and 100, false)
		and not exists (
			select 1
			from unnest(p_dataset_ids) requested(dataset_id)
			where not coalesce((
				select case p_kind when 'dataset' then capability.can_download_dataset
					else capability.can_download_labels end
				from internal.dataset_capabilities(requested.dataset_id, p_user_id) capability
			), false)
		);
$$;

-- What the signed-in user may do with a dataset, for the UI. No row when it is not visible.
create function public.my_dataset_access(p_dataset_id bigint)
returns table (
	is_owner boolean,
	role public.dataset_access_role,
	expires_at timestamptz,
	can_view boolean,
	can_download boolean,
	can_download_labels boolean,
	can_edit_details boolean,
	can_manage_access boolean
)
language sql stable security definer set search_path = ''
as $$
	select capability.is_owner, capability.role, capability.expires_at, true,
		capability.can_download_dataset, capability.can_download_labels,
		capability.can_edit_details, capability.can_manage_access
	from internal.dataset_capabilities(p_dataset_id, auth.uid()) capability;
$$;

revoke all on function public.can_download_dataset(bigint, text) from public, anon, authenticated;
revoke all on function public.user_can_view_dataset(bigint, uuid) from public, anon, authenticated;
revoke all on function public.user_can_download_datasets(bigint[], text, uuid) from public, anon, authenticated;
revoke all on function public.my_dataset_access(bigint) from public, anon, authenticated;
grant execute on function public.can_download_dataset(bigint, text) to authenticated, service_role;
grant execute on function public.user_can_view_dataset(bigint, uuid) to service_role;
grant execute on function public.user_can_download_datasets(bigint[], text, uuid) to service_role;
grant execute on function public.my_dataset_access(bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- Grant administration (caller-bound; no direct table writes are granted)
-- ---------------------------------------------------------------------------

create function internal.caller_manages_access(p_dataset_id bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
	select coalesce((
		select capability.can_manage_access
		from internal.dataset_capabilities(p_dataset_id, auth.uid()) capability
	), false);
$$;
revoke all on function internal.caller_manages_access(bigint) from public, anon, authenticated;
grant execute on function internal.caller_manages_access(bigint) to authenticated;

create policy "Grantees read their own grants and admins read the roster"
on public.dataset_access_grants
for select
to authenticated
using (grantee_user_id = (select auth.uid()) or internal.caller_manages_access(dataset_id));

create policy "Admins read the dataset access history"
on public.dataset_access_events
for select
to authenticated
using (internal.caller_manages_access(dataset_id));

-- The owner plus every direct grant, with account emails, for people who manage access.
create function public.list_dataset_access(p_dataset_id bigint)
returns table (
	user_id uuid,
	email text,
	is_owner boolean,
	role public.dataset_access_role,
	can_download boolean,
	expires_at timestamptz,
	is_expired boolean,
	granted_at timestamptz,
	granted_by_email text
)
language plpgsql stable security definer set search_path = ''
as $$
begin
	if not internal.caller_manages_access(p_dataset_id) then
		raise exception 'Dataset not found' using errcode = 'P0002';
	end if;

	return query
	select owner_account.id, owner_account.email::text, true, null::public.dataset_access_role, true,
		null::timestamptz, false, dataset.created_at, null::text
	from public.v2_datasets dataset
	join auth.users owner_account on owner_account.id = dataset.user_id
	where dataset.id = p_dataset_id
	union all
	select grantee.id, grantee.email::text, false, grant_row.role, grant_row.can_download, grant_row.expires_at,
		grant_row.expires_at is not null and grant_row.expires_at <= now(),
		grant_row.created_at, granter.email::text
	from public.dataset_access_grants grant_row
	join auth.users grantee on grantee.id = grant_row.grantee_user_id
	left join auth.users granter on granter.id = grant_row.granted_by
	where grant_row.dataset_id = p_dataset_id
	order by 3 desc, 2;
end;
$$;

-- Add or change one registered user's access. Emails are resolved only after the
-- caller is authorized, so this is not an account directory.
create function public.set_dataset_access(
	p_dataset_id bigint,
	p_email text,
	p_role public.dataset_access_role default 'reader',
	p_can_download boolean default false,
	p_expires_at timestamptz default null
)
returns table (user_id uuid, email text, role public.dataset_access_role, can_download boolean, expires_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_email text := lower(btrim(coalesce(p_email, '')));
	v_can_download boolean := p_role <> 'reader' or coalesce(p_can_download, false);
	v_owner uuid;
	v_subject uuid;
	v_match_count integer;
	v_existing public.dataset_access_grants%rowtype;
begin
	if p_role is null then
		raise exception 'An access level is required' using errcode = '22023';
	end if;
	if p_expires_at is not null and p_expires_at <= now() then
		raise exception 'The expiry date must be in the future' using errcode = '22023';
	end if;

	select dataset.user_id into v_owner
	from public.v2_datasets dataset
	where dataset.id = p_dataset_id
	for update;

	-- Checked after the lock, so an admin revoked concurrently cannot keep granting.
	if v_actor is null or not internal.caller_manages_access(p_dataset_id) then
		raise exception 'Dataset not found' using errcode = 'P0002';
	end if;

	select count(*), min(account.id::text)::uuid
	into v_match_count, v_subject
	from auth.users account
	where lower(account.email) = v_email;
	if v_email = '' or v_match_count <> 1 then
		raise exception 'No registered DeadTrees account uses this email' using errcode = 'P0002',
			hint = 'registered_user_not_found';
	end if;
	if v_subject = v_owner then
		raise exception 'The owner already has full access' using errcode = '22023', hint = 'owner';
	end if;
	if v_subject = v_actor then
		raise exception 'You cannot change your own access' using errcode = '22023', hint = 'self';
	end if;

	select * into v_existing
	from public.dataset_access_grants grant_row
	where grant_row.dataset_id = p_dataset_id and grant_row.grantee_user_id = v_subject
	for update;

	if found then
		if v_existing.role is distinct from p_role
			or v_existing.can_download is distinct from v_can_download
			or v_existing.expires_at is distinct from p_expires_at then
			update public.dataset_access_grants grant_row
			set role = p_role, can_download = v_can_download, expires_at = p_expires_at,
				granted_by = v_actor, updated_at = now()
			where grant_row.id = v_existing.id;
			insert into public.dataset_access_events (
				dataset_id, actor_user_id, subject_user_id, action, old_role, new_role,
				old_can_download, new_can_download, old_expires_at, new_expires_at
			) values (
				p_dataset_id, v_actor, v_subject, 'changed', v_existing.role, p_role,
				v_existing.can_download, v_can_download, v_existing.expires_at, p_expires_at
			);
		end if;
	else
		insert into public.dataset_access_grants (dataset_id, grantee_user_id, role, can_download, expires_at, granted_by)
		values (p_dataset_id, v_subject, p_role, v_can_download, p_expires_at, v_actor);
		insert into public.dataset_access_events (
			dataset_id, actor_user_id, subject_user_id, action, new_role, new_can_download, new_expires_at
		) values (p_dataset_id, v_actor, v_subject, 'granted', p_role, v_can_download, p_expires_at);
	end if;

	return query select v_subject, v_email, p_role, v_can_download, p_expires_at;
end;
$$;

-- Remove a user's access. Admins may remove anyone; a grantee may leave.
create function public.revoke_dataset_access(p_dataset_id bigint, p_user_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_existing public.dataset_access_grants%rowtype;
begin
	-- The same dataset lock serializes grant edits and revocation.
	perform 1 from public.v2_datasets where id = p_dataset_id for update;
	if v_actor is null or not (internal.caller_manages_access(p_dataset_id) or p_user_id = v_actor) then
		raise exception 'Dataset not found' using errcode = 'P0002';
	end if;

	delete from public.dataset_access_grants grant_row
	where grant_row.dataset_id = p_dataset_id and grant_row.grantee_user_id = p_user_id
	returning * into v_existing;

	if not found then
		return false;
	end if;

	insert into public.dataset_access_events (
		dataset_id, actor_user_id, subject_user_id, action, old_role, old_can_download, old_expires_at
	) values (
		p_dataset_id, v_actor, p_user_id, 'revoked', v_existing.role, v_existing.can_download, v_existing.expires_at
	);
	return true;
end;
$$;

-- "Shared with me": active grants on datasets that are not archived.
create function public.list_datasets_shared_with_me()
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
	select dataset.id, grant_row.role, grant_row.can_download, grant_row.expires_at, grant_row.created_at,
		dataset.data_access, dataset.file_name
	from public.dataset_access_grants grant_row
	join public.v2_datasets dataset on dataset.id = grant_row.dataset_id
	where grant_row.grantee_user_id = auth.uid()
		and (grant_row.expires_at is null or grant_row.expires_at > now())
		and not dataset.archived
	order by grant_row.created_at desc;
$$;

revoke all on function public.list_dataset_access(bigint) from public, anon, authenticated;
revoke all on function public.set_dataset_access(bigint, text, public.dataset_access_role, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.revoke_dataset_access(bigint, uuid) from public, anon, authenticated;
revoke all on function public.list_datasets_shared_with_me() from public, anon, authenticated;
grant execute on function public.list_dataset_access(bigint) to authenticated;
grant execute on function public.set_dataset_access(bigint, text, public.dataset_access_role, boolean, timestamptz) to authenticated;
grant execute on function public.revoke_dataset_access(bigint, uuid) to authenticated;
grant execute on function public.list_datasets_shared_with_me() to authenticated;

-- ---------------------------------------------------------------------------
-- Visibility changes (owner or the platform access override) and detail edits
-- ---------------------------------------------------------------------------

-- Files never move: every file request is checked against the visibility at that moment.
create function public.set_dataset_visibility(p_dataset_id bigint, p_data_access public.access)
returns public.access
language plpgsql volatile security definer set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_dataset public.v2_datasets%rowtype;
begin
	select * into v_dataset from public.v2_datasets dataset where dataset.id = p_dataset_id for update;
	if v_actor is null or not found
		or not exists (select 1 from internal.dataset_capabilities(p_dataset_id, v_actor)) then
		raise exception 'Dataset not found' using errcode = 'P0002';
	end if;
	if v_dataset.user_id <> v_actor and not internal.user_privilege(v_actor, 'manage_access') then
		raise exception 'Only the dataset owner can change its visibility' using errcode = '42501';
	end if;
	if p_data_access is null then
		raise exception 'A visibility is required' using errcode = '22023';
	end if;
	if v_dataset.data_access is distinct from p_data_access then
		update public.v2_datasets dataset set data_access = p_data_access where dataset.id = p_dataset_id;
		insert into public.dataset_access_events (
			dataset_id, actor_user_id, action, old_visibility, new_visibility
		) values (p_dataset_id, v_actor, 'visibility_changed', v_dataset.data_access, p_data_access);
	end if;
	return v_dataset.data_access;
end;
$$;

revoke all on function public.set_dataset_visibility(bigint, public.access) from public, anon, authenticated;
grant execute on function public.set_dataset_visibility(bigint, public.access) to authenticated;

-- Direct data_access updates by app roles would bypass the history.
create function internal.require_visibility_function()
returns trigger
language plpgsql
as $$
begin
	if new.data_access is distinct from old.data_access and current_user in ('anon', 'authenticated') then
		raise exception 'Change dataset visibility with set_dataset_visibility' using errcode = '42501';
	end if;
	return new;
end;
$$;

create trigger require_visibility_function
before update of data_access on public.v2_datasets
for each row execute function internal.require_visibility_function();

-- Descriptive details, for the owner and editor/admin grants. Only these columns change.
create function public.update_dataset_details(p_dataset_id bigint, p_details jsonb)
returns public.v2_datasets
language plpgsql volatile security definer set search_path = ''
as $$
declare
	v_allowed constant text[] := array[
		'authors', 'aquisition_year', 'aquisition_month', 'aquisition_day',
		'platform', 'citation_doi', 'additional_information'
	];
	v_unknown text;
	v_dataset public.v2_datasets%rowtype;
begin
	if not coalesce((
		select capability.can_edit_details
		from internal.dataset_capabilities(p_dataset_id, auth.uid()) capability
	), false) then
		raise exception 'Dataset not found' using errcode = 'P0002';
	end if;
	select key into v_unknown from jsonb_object_keys(coalesce(p_details, '{}'::jsonb)) key
	where key <> all (v_allowed) limit 1;
	if v_unknown is not null then
		raise exception 'This field cannot be edited: %', v_unknown using errcode = '22023';
	end if;

	update public.v2_datasets dataset
	set
		authors = case when p_details ? 'authors'
			then array(select jsonb_array_elements_text(p_details -> 'authors')) else dataset.authors end,
		aquisition_year = case when p_details ? 'aquisition_year'
			then (p_details ->> 'aquisition_year')::smallint else dataset.aquisition_year end,
		aquisition_month = case when p_details ? 'aquisition_month'
			then (p_details ->> 'aquisition_month')::smallint else dataset.aquisition_month end,
		aquisition_day = case when p_details ? 'aquisition_day'
			then (p_details ->> 'aquisition_day')::smallint else dataset.aquisition_day end,
		platform = case when p_details ? 'platform'
			then (p_details ->> 'platform')::public."Platform" else dataset.platform end,
		citation_doi = case when p_details ? 'citation_doi'
			then p_details ->> 'citation_doi' else dataset.citation_doi end,
		additional_information = case when p_details ? 'additional_information'
			then p_details ->> 'additional_information' else dataset.additional_information end
	where dataset.id = p_dataset_id
	returning dataset.* into v_dataset;
	return v_dataset;
end;
$$;

revoke all on function public.update_dataset_details(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.update_dataset_details(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Static image URLs (/cogs/v1, /thumbnails/v1): current file of a public or view-only dataset
-- ---------------------------------------------------------------------------

create index if not exists v2_cogs_cog_path_idx on public.v2_cogs (cog_path);
create index if not exists v2_thumbnails_thumbnail_path_idx on public.v2_thumbnails (thumbnail_path);

create function public.is_public_dataset_file(p_kind text, p_path text)
returns boolean
language sql stable security definer set search_path = ''
as $$
	select exists (
		select 1
		from public.v2_datasets dataset
		where dataset.data_access in ('public', 'viewonly')
			and dataset.id in (
				select cog.dataset_id from public.v2_cogs cog where p_kind = 'cog' and cog.cog_path = p_path
				union all
				select thumbnail.dataset_id from public.v2_thumbnails thumbnail
				where p_kind = 'thumbnail' and thumbnail.thumbnail_path = p_path
			)
	);
$$;

revoke all on function public.is_public_dataset_file(text, text) from public, anon, authenticated;
grant execute on function public.is_public_dataset_file(text, text) to service_role;

commit;
