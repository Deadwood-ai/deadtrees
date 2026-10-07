-- A COG path names the static /cogs/v1 URL of a dataset's full-resolution
-- orthophoto. When every visitor could list all paths, one request plus a loop
-- fetched the whole public archive. Only callers who need paths in bulk keep
-- reading COG rows directly: the processor, auditors and staff who may view all
-- private data, PRIWA project members, and owners or grantees of a dataset.
-- Everyone else asks the API for one dataset's path at a time
-- (GET /datasets/{id}/files/cog), which caps distinct datasets per account or IP.
-- Views join v2_cogs as the caller, so their cog columns read null for others.

begin;

create function internal.can_read_all_cog_paths()
returns boolean
language sql stable security definer set search_path = ''
as $$
	select coalesce((select auth.jwt() ->> 'email') = 'processor@deadtrees.earth', false)
		or exists (
			select 1
			from public.privileged_users privileged
			where privileged.user_id = (select auth.uid())
				and (privileged.can_audit or privileged.can_view_all_private or privileged.can_operate)
		);
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
grant select, insert, delete on table public.cog_path_requests to service_role;

commit;
