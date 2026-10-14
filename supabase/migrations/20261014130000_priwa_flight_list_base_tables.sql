-- The PRIWA flight list read v2_full_dataset_view_public and then kept the few
-- project flights. That view evaluates the private-visibility rule and its joins
-- over every dataset, and since project sharing joined that rule (DT-1358) the
-- list ran past the 8 s statement timeout for every member (DT-1395).
-- One helper now selects the project's flights from base tables first and applies
-- the same rules as the view only to those rows: not archived, not excluded
-- completely by an audit, and private ones only when the caller may view them.

begin;

set local lock_timeout = '5s';

-- Drone flights of the project's contributing members that the caller may see,
-- with a finished COG.
create function internal.priwa_project_flight_ids(p_project_id uuid)
returns setof bigint
language sql stable security definer set search_path = ''
as $$
	select dataset.id
	from public.v2_datasets dataset
	join public.priwa_project_memberships uploader
		on uploader.project_id = p_project_id
		and uploader.user_id = dataset.user_id
		and uploader.contributes_flights
	join public.v2_statuses status on status.dataset_id = dataset.id and status.is_cog_done
	join public.v2_cogs cog on cog.dataset_id = dataset.id and cog.cog_path is not null
	where dataset.platform = 'drone'
		and not dataset.archived
		and not exists (
			select 1 from public.dataset_audit audit
			where audit.dataset_id = dataset.id
				and audit.final_assessment = 'exclude_completely'
		)
		and (
			dataset.data_access <> 'private'
			or dataset.user_id = (select auth.uid())
			or (select public.can_view_all_private_data())
			or dataset.id in (select internal.granted_dataset_ids())
		);
$$;

revoke all on function internal.priwa_project_flight_ids(uuid) from public, anon, authenticated;

create or replace function public.priwa_project_latest_flight_mosaics(
	p_project_id uuid,
	p_limit integer,
	p_offset integer
)
returns table (
	id text,
	project_id uuid,
	label text,
	cog_url text,
	bbox text,
	capture_date date,
	created_at timestamp with time zone,
	authors text[],
	additional_information text,
	flight_type text
)
language sql
stable
security definer
set search_path = public
as $$
	select
		dataset.id::text as id,
		p_project_id as project_id,
		coalesce(nullif(dataset.file_name, ''), 'Dataset ' || dataset.id::text) as label,
		cog.cog_path as cog_url,
		ortho.bbox::text as bbox,
		case
			when dataset.aquisition_year between 1981 and 2098
				and dataset.aquisition_month between 1 and 12
				and dataset.aquisition_day between 1 and 31
				and dataset.aquisition_day <= extract(
					day from (
						date_trunc(
							'month',
							make_date(
								dataset.aquisition_year::integer,
								dataset.aquisition_month::integer,
								1
							)
						) + interval '1 month - 1 day'
					)
				)
			then make_date(
				dataset.aquisition_year::integer,
				dataset.aquisition_month::integer,
				dataset.aquisition_day::integer
			)
			else null
		end as capture_date,
		dataset.created_at,
		dataset.authors,
		dataset.additional_information,
		project_flight.flight_type
	from public.v2_datasets dataset
	join public.v2_cogs cog on cog.dataset_id = dataset.id
	left join public.v2_orthos ortho on ortho.dataset_id = dataset.id
	left join public.priwa_project_flights project_flight
		on project_flight.project_id = p_project_id
		and project_flight.dataset_id = dataset.id
	where exists (
			select 1
			from public.priwa_project_memberships requester_membership
			where requester_membership.project_id = p_project_id
				and requester_membership.user_id = (select auth.uid())
		)
		and dataset.id in (select internal.priwa_project_flight_ids(p_project_id))
	order by
		capture_date desc nulls last,
		dataset.created_at desc,
		dataset.id desc
	limit least(greatest(coalesce(p_limit, 100), 1), 100)
	offset greatest(coalesce(p_offset, 0), 0);
$$;

-- The older two-argument form returns the same rows without the classification.
create or replace function public.priwa_project_latest_flight_mosaics(
	p_project_id uuid,
	p_limit integer default 50
)
returns table (
	id text,
	project_id uuid,
	label text,
	cog_url text,
	bbox text,
	capture_date date,
	created_at timestamp with time zone,
	authors text[],
	additional_information text
)
language sql
stable
security definer
set search_path = public
as $$
	select mosaic.id, mosaic.project_id, mosaic.label, mosaic.cog_url, mosaic.bbox,
		mosaic.capture_date, mosaic.created_at, mosaic.authors, mosaic.additional_information
	from public.priwa_project_latest_flight_mosaics(p_project_id, p_limit, 0) mosaic;
$$;

create or replace function internal.priwa_is_eligible_project_flight(p_project_id uuid, p_dataset_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select public.priwa_is_project_member(p_project_id)
		and p_dataset_id in (select internal.priwa_project_flight_ids(p_project_id));
$$;

commit;
