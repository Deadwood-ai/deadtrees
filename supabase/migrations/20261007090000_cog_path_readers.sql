-- A COG path names the static /cogs/v1 URL of a dataset's full-resolution
-- orthophoto. When every visitor could list all paths, one request plus a loop
-- fetched the whole public archive. Only callers who need paths in bulk keep
-- reading COG rows directly: the processor, auditors and staff who may view all
-- private data, PRIWA project members, and owners or grantees of a dataset.
-- Everyone else asks the API for one dataset's path at a time
-- (GET /datasets/{id}/files/cog), which caps distinct datasets per account or IP.
-- Views join v2_cogs as the caller, so their cog columns read null for others.

begin;

-- Locks are taken in one order: v2_cogs (policy), then v2_queue_positions (view).
set local lock_timeout = '5s';

create function internal.can_read_all_cog_paths()
returns boolean
language sql stable security definer set search_path = ''
as $$
	select coalesce((select auth.jwt() ->> 'email') = 'processor@deadtrees.earth', false)
		or public.can_audit()
		or public.can_view_all_private_data()
		or public.can_operate();
$$;

create function internal.is_priwa_member()
returns boolean
language sql stable security definer set search_path = ''
as $$
	select exists (
		select 1 from public.priwa_project_memberships membership
		where membership.user_id = (select auth.uid())
	);
$$;

create function internal.own_or_granted_dataset_ids()
returns setof bigint
language sql stable security definer set search_path = ''
as $$
	select dataset.id from public.v2_datasets dataset
	where dataset.user_id = (select auth.uid())
	union
	select internal.granted_dataset_ids();
$$;

revoke all on function internal.can_read_all_cog_paths() from public, anon, authenticated;
revoke all on function internal.is_priwa_member() from public, anon, authenticated;
revoke all on function internal.own_or_granted_dataset_ids() from public, anon, authenticated;
grant execute on function internal.can_read_all_cog_paths() to anon, authenticated, service_role;
grant execute on function internal.is_priwa_member() to anon, authenticated, service_role;
grant execute on function internal.own_or_granted_dataset_ids() to anon, authenticated, service_role;

drop policy "Enable read access for all users" on public.v2_cogs;

create policy "Bulk COG path readers" on public.v2_cogs
as permissive for select to public
using (
	(select internal.can_read_all_cog_paths())
	or dataset_id in (select internal.own_or_granted_dataset_ids())
	or (
		(select internal.is_priwa_member())
		and dataset_id not in (select internal.hidden_private_dataset_ids())
	)
);

-- Queue estimates average every COG's runtime, not only the rows a caller may read.
create function internal.average_cog_processing_runtime()
returns double precision
language sql stable security definer set search_path = ''
as $$
	select avg(cog.cog_processing_runtime)::double precision from public.v2_cogs cog;
$$;

revoke all on function internal.average_cog_processing_runtime() from public, anon, authenticated;
grant execute on function internal.average_cog_processing_runtime() to anon, authenticated, service_role;

create or replace view public.v2_queue_positions with (security_invoker = true) as
with positions as (
	select row_number() over (order by v2_queue.priority desc, v2_queue.created_at) as current_position,
		v2_queue.id,
		v2_queue.dataset_id,
		v2_queue.user_id,
		v2_queue.build_args,
		v2_queue.created_at,
		v2_queue.is_processing,
		v2_queue.claimed_by,
		v2_queue.claimed_at,
		v2_queue.priority,
		v2_queue.task_types
	from public.v2_queue
	where not v2_queue.is_processing
	order by v2_queue.priority desc, v2_queue.created_at
), avg_time as (
	select internal.average_cog_processing_runtime() as avg
)
select avg_time.avg * positions.current_position::double precision as estimated_time,
	positions.current_position,
	positions.id,
	positions.dataset_id,
	positions.user_id,
	positions.build_args,
	positions.created_at,
	positions.is_processing,
	positions.priority,
	positions.task_types,
	avg_time.avg,
	positions.claimed_by,
	positions.claimed_at
from positions, avg_time;

-- Which datasets each account or network asked the API for a COG path, so the
-- API can cap distinct datasets per day. Only the API (service role) uses it.
create table public.cog_path_requests (
	id bigint generated always as identity primary key,
	created_at timestamp with time zone not null default now(),
	requester text not null,
	dataset_id bigint not null
);

comment on table public.cog_path_requests is
	'COG paths handed out by the API: requester is user:<id> or a keyed hash of the client IP.';

create index cog_path_requests_requester_created_idx
	on public.cog_path_requests (requester, created_at desc);

alter table public.cog_path_requests enable row level security;
revoke all on table public.cog_path_requests from public, anon, authenticated;
-- Claims go through claim_public_cog_path; the service role may inspect or clear rows.
grant select, delete on table public.cog_path_requests to service_role;

-- One call per map open: the path of a public or view-only dataset (the same rule
-- nginx applies to static COG URLs), claimed against the requester's daily cap.
-- No row: no servable COG. allowed = false: the cap is used up. Reopening a dataset
-- within the window is free. Each new claim also prunes a batch of expired rows.
create function public.claim_public_cog_path(p_dataset_id bigint, p_requester text, p_limit integer)
returns table (cog_path text, allowed boolean)
language plpgsql volatile security definer set search_path = ''
as $$
declare
	v_path text;
	v_window_start timestamp with time zone := now() - interval '1 day';
begin
	select cog.cog_path into v_path
	from public.v2_cogs cog
	join public.v2_datasets dataset on dataset.id = cog.dataset_id
	where cog.dataset_id = p_dataset_id and dataset.data_access in ('public', 'viewonly')
		and public.is_public_dataset_file('cog', cog.cog_path);
	if v_path is null then
		return;
	end if;

	-- Serialize claims per requester so parallel requests cannot exceed the cap.
	perform pg_advisory_xact_lock(hashtextextended('cog_path_requests:' || p_requester, 0));
	if exists (
		select 1 from public.cog_path_requests request
		where request.requester = p_requester and request.dataset_id = p_dataset_id
			and request.created_at > v_window_start
	) then
		return query select v_path, true;
		return;
	end if;
	if (
		select count(*) from public.cog_path_requests request
		where request.requester = p_requester and request.created_at > v_window_start
	) >= p_limit then
		return query select null::text, false;
		return;
	end if;

	insert into public.cog_path_requests (requester, dataset_id) values (p_requester, p_dataset_id);
	delete from public.cog_path_requests
	where id in (
		select request.id from public.cog_path_requests request
		where request.created_at <= v_window_start
		order by request.id
		limit 100
	);
	return query select v_path, true;
end;
$$;

revoke all on function public.claim_public_cog_path(bigint, text, integer) from public, anon, authenticated;
grant execute on function public.claim_public_cog_path(bigint, text, integer) to service_role;

commit;
