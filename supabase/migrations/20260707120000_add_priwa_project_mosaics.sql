create or replace function public.priwa_project_latest_flight_mosaics(
    p_project_id uuid,
    p_limit integer default 50
)
returns table (
    id text,
    project_id uuid,
    label text,
    cog_url text,
    capture_date date,
    created_at timestamp with time zone,
    authors text[],
    additional_information text
)
language sql
stable
-- Required to test uploader project membership; execution is still limited to
-- authenticated callers below and rows are restricted to public COG datasets.
security definer
set search_path = public
as $$
    select
        dataset.id::text as id,
        p_project_id as project_id,
        coalesce(nullif(dataset.file_name, ''), 'Dataset ' || dataset.id::text) as label,
        dataset.cog_path as cog_url,
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
        dataset.additional_information
    from public.v2_full_dataset_view_public dataset
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
        )
      and dataset.platform::text = 'drone'
      and dataset.is_cog_done is true
      and dataset.cog_path is not null
    order by
        capture_date desc nulls last,
        dataset.created_at desc,
        dataset.id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

comment on function public.priwa_project_latest_flight_mosaics(uuid, integer)
is 'Returns latest public COG drone datasets uploaded by members of a PRIWA project for authenticated members of that same project.';

revoke all on function public.priwa_project_latest_flight_mosaics(uuid, integer) from public;
revoke all on function public.priwa_project_latest_flight_mosaics(uuid, integer) from anon;
grant execute on function public.priwa_project_latest_flight_mosaics(uuid, integer) to authenticated;
grant execute on function public.priwa_project_latest_flight_mosaics(uuid, integer) to service_role;
