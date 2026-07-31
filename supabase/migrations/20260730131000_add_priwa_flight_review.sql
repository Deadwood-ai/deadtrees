create table "public"."priwa_project_flights" (
    "project_id" uuid not null,
    "dataset_id" bigint not null,
    "flight_type" text not null,
    "reviewed_by" uuid not null,
    "reviewed_at" timestamp with time zone not null default now(),
    constraint "priwa_project_flights_pkey"
        primary key ("project_id", "dataset_id"),
    constraint "priwa_project_flights_project_id_fkey"
        foreign key ("project_id") references "public"."priwa_projects"("id")
        on update cascade on delete cascade,
    constraint "priwa_project_flights_dataset_id_fkey"
        foreign key ("dataset_id") references "public"."v2_datasets"("id")
        on update cascade on delete cascade,
    constraint "priwa_project_flights_reviewed_by_fkey"
        foreign key ("reviewed_by") references "auth"."users"("id")
        on update cascade,
    constraint "priwa_project_flights_type_check"
        check ("flight_type" in ('umfeldbefliegung', 'not_priwa'))
);

create index "priwa_project_flights_dataset_idx"
    on "public"."priwa_project_flights" ("dataset_id");
create index "priwa_project_flights_reviewed_by_idx"
    on "public"."priwa_project_flights" ("reviewed_by");

alter table "public"."priwa_project_flights" enable row level security;

create schema if not exists internal;

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

create or replace function internal.priwa_validate_project_flight()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
    current_actor uuid := (select auth.uid());
begin
    if current_actor is not null then
        if not public.priwa_is_project_member(NEW.project_id) then
            raise exception 'PRIWA project membership is required';
        end if;

        if not internal.priwa_is_eligible_project_flight(
            NEW.project_id,
            NEW.dataset_id
        ) then
            raise exception 'Flight is not an eligible PRIWA project COG';
        end if;

        if NEW.flight_type = 'not_priwa' and exists (
            select 1
            from public.priwa_befallsgruppe_flights group_flight
            join public.priwa_befallsgruppen groups
              on groups.id = group_flight.group_id
            where groups.project_id = NEW.project_id
              and group_flight.dataset_id = NEW.dataset_id
        ) then
            raise exception 'A flight assigned to a Befallsgruppe cannot be excluded';
        end if;

        NEW.reviewed_by = current_actor;
    end if;

    if TG_OP = 'UPDATE' then
        NEW.project_id = OLD.project_id;
        NEW.dataset_id = OLD.dataset_id;
    end if;
    NEW.reviewed_at = now();
    return NEW;
end;
$$;

create trigger priwa_project_flights_validate
before insert or update on public.priwa_project_flights
for each row execute function internal.priwa_validate_project_flight();

revoke all on function internal.priwa_validate_project_flight() from public;
revoke all on function internal.priwa_validate_project_flight() from anon;
revoke all on function internal.priwa_validate_project_flight() from authenticated;

create or replace function internal.priwa_reject_excluded_group_flight()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if exists (
        select 1
        from public.priwa_befallsgruppen groups
        join public.priwa_project_flights project_flight
          on project_flight.project_id = groups.project_id
         and project_flight.dataset_id = NEW.dataset_id
        where groups.id = NEW.group_id
          and project_flight.flight_type = 'not_priwa'
    ) then
        raise exception 'An excluded flight cannot be assigned to a Befallsgruppe';
    end if;
    return NEW;
end;
$$;

create trigger priwa_befallsgruppe_flights_reject_excluded
before insert or update on public.priwa_befallsgruppe_flights
for each row execute function internal.priwa_reject_excluded_group_flight();

revoke all on function internal.priwa_reject_excluded_group_flight() from public;
revoke all on function internal.priwa_reject_excluded_group_flight() from anon;
revoke all on function internal.priwa_reject_excluded_group_flight() from authenticated;

create or replace function internal.priwa_confirm_assigned_group_flight()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    group_project_id uuid;
    actor_id uuid;
begin
    select groups.project_id, coalesce((select auth.uid()), groups.created_by)
      into group_project_id, actor_id
      from public.priwa_befallsgruppen groups
     where groups.id = NEW.group_id;

    insert into public.priwa_project_flights (
        project_id,
        dataset_id,
        flight_type,
        reviewed_by
    )
    values (
        group_project_id,
        NEW.dataset_id,
        'umfeldbefliegung',
        actor_id
    )
    on conflict (project_id, dataset_id) do update
       set flight_type = excluded.flight_type,
           reviewed_by = excluded.reviewed_by,
           reviewed_at = now();

    return NEW;
end;
$$;

create trigger priwa_befallsgruppe_flights_confirm_flight
after insert or update on public.priwa_befallsgruppe_flights
for each row execute function internal.priwa_confirm_assigned_group_flight();

revoke all on function internal.priwa_confirm_assigned_group_flight() from public;
revoke all on function internal.priwa_confirm_assigned_group_flight() from anon;
revoke all on function internal.priwa_confirm_assigned_group_flight() from authenticated;

create or replace function internal.priwa_preserve_assigned_project_flight()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if exists (
        select 1
        from public.priwa_befallsgruppe_flights group_flight
        join public.priwa_befallsgruppen groups
          on groups.id = group_flight.group_id
        where groups.project_id = OLD.project_id
          and group_flight.dataset_id = OLD.dataset_id
    ) then
        raise exception 'A flight assigned to a Befallsgruppe cannot be reset';
    end if;
    return OLD;
end;
$$;

create trigger priwa_project_flights_preserve_assigned
before delete on public.priwa_project_flights
for each row execute function internal.priwa_preserve_assigned_project_flight();

revoke all on function internal.priwa_preserve_assigned_project_flight() from public;
revoke all on function internal.priwa_preserve_assigned_project_flight() from anon;
revoke all on function internal.priwa_preserve_assigned_project_flight() from authenticated;

insert into public.priwa_project_flights (
    project_id,
    dataset_id,
    flight_type,
    reviewed_by,
    reviewed_at
)
select distinct on (groups.project_id, group_flight.dataset_id)
    groups.project_id,
    group_flight.dataset_id,
    'umfeldbefliegung',
    group_flight.created_by,
    group_flight.created_at
from public.priwa_befallsgruppe_flights group_flight
join public.priwa_befallsgruppen groups
  on groups.id = group_flight.group_id
order by
    groups.project_id,
    group_flight.dataset_id,
    group_flight.created_at,
    group_flight.group_id;

do $$
begin
    if exists (
        select 1
        from public.priwa_befallsgruppe_flights group_flight
        join public.priwa_befallsgruppen groups
          on groups.id = group_flight.group_id
        left join public.priwa_project_flights project_flight
          on project_flight.project_id = groups.project_id
         and project_flight.dataset_id = group_flight.dataset_id
         and project_flight.flight_type = 'umfeldbefliegung'
        where project_flight.dataset_id is null
    ) then
        raise exception 'PRIWA flight classification backfill is incomplete';
    end if;
end;
$$;

grant select, insert, update, delete
on table "public"."priwa_project_flights" to "authenticated";
grant all on table "public"."priwa_project_flights" to "service_role";

create policy "PRIWA members can read project flight classifications"
on "public"."priwa_project_flights"
for select
to authenticated
using (public.priwa_is_project_member(project_id));

create policy "PRIWA members can create project flight classifications"
on "public"."priwa_project_flights"
for insert
to authenticated
with check (
    public.priwa_is_project_member(project_id)
    and reviewed_by = (select auth.uid())
);

create policy "PRIWA members can update project flight classifications"
on "public"."priwa_project_flights"
for update
to authenticated
using (public.priwa_is_project_member(project_id))
with check (
    public.priwa_is_project_member(project_id)
    and reviewed_by = (select auth.uid())
);

create policy "PRIWA members can delete project flight classifications"
on "public"."priwa_project_flights"
for delete
to authenticated
using (public.priwa_is_project_member(project_id));

create function public.priwa_project_latest_flight_mosaics(
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

drop policy "PRIWA members can create Befallsgruppe flights"
on public.priwa_befallsgruppe_flights;

create policy "PRIWA members can create Befallsgruppe flights"
on public.priwa_befallsgruppe_flights
for insert
to authenticated
with check (
    created_by = (select auth.uid())
    and exists (
        select 1
        from public.priwa_befallsgruppen groups
        where groups.id = group_id
          and public.priwa_is_project_member(groups.project_id)
          and internal.priwa_is_eligible_project_flight(
              groups.project_id,
              dataset_id
          )
    )
);

create or replace function public.priwa_save_befallsgruppe(
    p_project_id uuid,
    p_name text,
    p_tree_ids uuid[],
    p_dataset_ids bigint[] default '{}'::bigint[],
    p_group_id uuid default null,
    p_origin text default 'manual',
    p_confidence double precision default null,
    p_suggestion_reason text default null,
    p_algorithm_version text default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
    current_actor uuid := (select auth.uid());
    saved_group_id uuid := coalesce(p_group_id, gen_random_uuid());
    normalized_tree_ids uuid[] := array(
        select distinct tree_id
        from unnest(coalesce(p_tree_ids, '{}'::uuid[])) tree_id
    );
    normalized_dataset_ids bigint[] := array(
        select distinct dataset_id
        from unnest(coalesce(p_dataset_ids, '{}'::bigint[])) dataset_id
    );
    affected_group_ids uuid[];
begin
    if current_actor is null or not public.priwa_is_project_member(p_project_id) then
        raise exception 'PRIWA project membership is required';
    end if;

    if nullif(btrim(p_name), '') is null then
        raise exception 'A Befallsgruppe name is required';
    end if;

    if cardinality(normalized_tree_ids) = 0 then
        raise exception 'A Befallsgruppe requires at least one tree';
    end if;

    if p_origin not in ('suggestion', 'manual') then
        raise exception 'Invalid Befallsgruppe origin';
    end if;

    if p_confidence is not null and (p_confidence < 0 or p_confidence > 1) then
        raise exception 'Invalid Befallsgruppe confidence';
    end if;

    if p_group_id is not null and not exists (
        select 1
        from public.priwa_befallsgruppen groups
        where groups.id = p_group_id
          and groups.project_id = p_project_id
    ) then
        raise exception 'Befallsgruppe does not belong to the project';
    end if;

    if (
        select count(*)
        from public.priwa_kaeferbaeume trees
        where trees.id = any(normalized_tree_ids)
          and trees.project_id = p_project_id
          and trees.deleted_at is null
    ) <> cardinality(normalized_tree_ids) then
        raise exception 'Every selected tree must be active and belong to the project';
    end if;

    if exists (
        select 1
        from unnest(normalized_dataset_ids) dataset_id
        where not internal.priwa_is_eligible_project_flight(
            p_project_id,
            dataset_id
        )
    ) then
        raise exception 'Every selected flight must belong to the PRIWA project';
    end if;

    insert into public.priwa_befallsgruppen (
        id,
        project_id,
        name,
        origin,
        confidence,
        suggestion_reason,
        algorithm_version,
        created_by,
        updated_by
    )
    values (
        saved_group_id,
        p_project_id,
        btrim(p_name),
        p_origin,
        p_confidence,
        nullif(btrim(p_suggestion_reason), ''),
        nullif(btrim(p_algorithm_version), ''),
        current_actor,
        current_actor
    )
    on conflict (id) do update set
        name = excluded.name,
        origin = excluded.origin,
        confidence = excluded.confidence,
        suggestion_reason = excluded.suggestion_reason,
        algorithm_version = excluded.algorithm_version,
        updated_by = current_actor;

    select array_agg(distinct members.group_id)
    into affected_group_ids
    from public.priwa_befallsgruppe_members members
    where members.tree_id = any(normalized_tree_ids)
      and members.group_id <> saved_group_id;

    delete from public.priwa_befallsgruppe_members members
    where members.tree_id = any(normalized_tree_ids)
      and members.group_id <> saved_group_id;

    delete from public.priwa_befallsgruppe_members members
    where members.group_id = saved_group_id;

    delete from public.priwa_befallsgruppe_flights flights
    where flights.group_id = saved_group_id;

    insert into public.priwa_befallsgruppe_members (
        group_id,
        tree_id,
        source,
        created_by
    )
    select
        saved_group_id,
        tree_id,
        p_origin,
        current_actor
    from unnest(normalized_tree_ids) tree_id;

    insert into public.priwa_befallsgruppe_flights (
        group_id,
        dataset_id,
        source,
        created_by
    )
    select
        saved_group_id,
        dataset_id,
        p_origin,
        current_actor
    from unnest(normalized_dataset_ids) dataset_id;

    if affected_group_ids is not null then
        delete from public.priwa_befallsgruppen groups
        where groups.id = any(affected_group_ids)
          and not exists (
              select 1
              from public.priwa_befallsgruppe_members members
              where members.group_id = groups.id
          );
    end if;

    return saved_group_id;
end;
$$;

create or replace function public.priwa_add_flight_to_befallsgruppe(
    p_project_id uuid,
    p_group_id uuid,
    p_dataset_id bigint
)
returns void
language plpgsql
set search_path = ''
as $$
declare
    current_actor uuid := (select auth.uid());
begin
    if current_actor is null or not public.priwa_is_project_member(p_project_id) then
        raise exception 'PRIWA project membership is required';
    end if;

    if not exists (
        select 1
        from public.priwa_befallsgruppen groups
        where groups.id = p_group_id
          and groups.project_id = p_project_id
    ) then
        raise exception 'Befallsgruppe does not belong to the project';
    end if;

    if not internal.priwa_is_eligible_project_flight(
        p_project_id,
        p_dataset_id
    ) then
        raise exception 'Flight is not an eligible PRIWA project COG';
    end if;

    insert into public.priwa_befallsgruppe_flights (
        group_id,
        dataset_id,
        source,
        created_by
    )
    values (
        p_group_id,
        p_dataset_id,
        'manual',
        current_actor
    )
    on conflict (group_id, dataset_id) do nothing;
end;
$$;

revoke all on function public.priwa_add_flight_to_befallsgruppe(uuid, uuid, bigint) from public;
revoke all on function public.priwa_add_flight_to_befallsgruppe(uuid, uuid, bigint) from anon;
grant execute on function public.priwa_add_flight_to_befallsgruppe(uuid, uuid, bigint)
to authenticated, service_role;

create or replace function public.priwa_set_project_flight_type(
    p_project_id uuid,
    p_dataset_id bigint,
    p_flight_type text
)
returns text
language plpgsql
set search_path = ''
as $$
begin
    if not public.priwa_is_project_member(p_project_id) then
        raise exception 'PRIWA project membership is required';
    end if;

    if p_flight_type is null then
        delete from public.priwa_project_flights project_flight
        where project_flight.project_id = p_project_id
          and project_flight.dataset_id = p_dataset_id;
        return null;
    end if;

    if p_flight_type not in ('umfeldbefliegung', 'not_priwa') then
        raise exception 'Invalid PRIWA flight type';
    end if;

    insert into public.priwa_project_flights (
        project_id,
        dataset_id,
        flight_type,
        reviewed_by
    )
    values (
        p_project_id,
        p_dataset_id,
        p_flight_type,
        (select auth.uid())
    )
    on conflict (project_id, dataset_id) do update set
        flight_type = excluded.flight_type,
        reviewed_by = excluded.reviewed_by;

    return p_flight_type;
end;
$$;

revoke all on function public.priwa_set_project_flight_type(uuid, bigint, text) from public;
revoke all on function public.priwa_set_project_flight_type(uuid, bigint, text) from anon;
grant execute on function public.priwa_set_project_flight_type(uuid, bigint, text) to authenticated;
grant execute on function public.priwa_set_project_flight_type(uuid, bigint, text) to service_role;

comment on table public.priwa_project_flights
is 'Explicit user-reviewed classification of eligible project COGs as Umfeldbefliegung or not PRIWA-relevant.';
