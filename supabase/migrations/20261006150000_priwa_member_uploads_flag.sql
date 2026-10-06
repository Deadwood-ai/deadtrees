-- Project members such as core-team reviewers must not turn every upload they
-- ever made into a PRIWA review item. Members contribute flights unless this
-- flag is switched off for them.

-- Fail fast instead of queueing PRIWA reads behind the table lock.
set local lock_timeout = '5s';

alter table "public"."priwa_project_memberships"
    add column "contributes_flights" boolean not null default true;

comment on column "public"."priwa_project_memberships"."contributes_flights"
is 'Whether this member''s drone uploads are PRIWA flight candidates. Off for reviewers whose uploads belong to other work.';

create or replace function internal.priwa_is_eligible_project_flight(
    p_project_id uuid,
    p_dataset_id bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select
        public.priwa_is_project_member(p_project_id)
        and exists (
            select 1
            from public.v2_full_dataset_view_public dataset
            join public.priwa_project_memberships uploader_membership
              on uploader_membership.project_id = p_project_id
             and uploader_membership.user_id = dataset.user_id
             and uploader_membership.contributes_flights
            where dataset.id = p_dataset_id
              and dataset.platform::text = 'drone'
              and dataset.is_cog_done is true
              and dataset.cog_path is not null
        );
$$;

revoke all on function internal.priwa_is_eligible_project_flight(uuid, bigint) from public;
revoke all on function internal.priwa_is_eligible_project_flight(uuid, bigint) from anon;
grant execute on function internal.priwa_is_eligible_project_flight(uuid, bigint)
to authenticated, service_role;

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
        dataset.cog_path as cog_url,
        dataset.bbox::text as bbox,
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
    from public.v2_full_dataset_view_public dataset
    left join public.priwa_project_flights project_flight
      on project_flight.project_id = p_project_id
     and project_flight.dataset_id = dataset.id
    where exists (
            select 1
            from public.priwa_project_memberships requester_membership
            where requester_membership.project_id = p_project_id
              and requester_membership.user_id = (select auth.uid())
        )
      and exists (
            select 1
            from public.priwa_project_memberships uploader_membership
            where uploader_membership.project_id = p_project_id
              and uploader_membership.user_id = dataset.user_id
              and uploader_membership.contributes_flights
        )
      and dataset.platform::text = 'drone'
      and dataset.is_cog_done is true
      and dataset.cog_path is not null
    order by
        capture_date desc nulls last,
        dataset.created_at desc,
        dataset.id desc
    limit least(greatest(coalesce(p_limit, 100), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.priwa_project_latest_flight_mosaics(uuid, integer, integer)
is 'Returns a paginated list of eligible PRIWA project COGs with their editable flight classification.';

revoke all on function public.priwa_project_latest_flight_mosaics(uuid, integer, integer) from public;
revoke all on function public.priwa_project_latest_flight_mosaics(uuid, integer, integer) from anon;
grant execute on function public.priwa_project_latest_flight_mosaics(uuid, integer, integer) to authenticated;
grant execute on function public.priwa_project_latest_flight_mosaics(uuid, integer, integer) to service_role;
