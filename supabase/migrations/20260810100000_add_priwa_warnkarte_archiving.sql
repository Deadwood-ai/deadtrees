create table public.priwa_warnkarte_archive_events (
    id bigint generated always as identity primary key,
    project_id uuid not null references public.priwa_projects(id) on update cascade on delete cascade,
    version_id uuid not null,
    action text not null,
    acted_by uuid not null references auth.users(id) on update cascade,
    acted_at timestamp with time zone not null default now(),
    constraint priwa_warnkarte_archive_events_version_project_fkey
        foreign key (version_id, project_id)
        references public.priwa_warnkarte_versions(id, project_id)
        on delete cascade,
    constraint priwa_warnkarte_archive_events_action_check
        check (action in ('archive', 'restore'))
);

create index priwa_warnkarte_archive_events_version_acted_idx
    on public.priwa_warnkarte_archive_events (version_id, acted_at desc, id desc);
create index priwa_warnkarte_archive_events_project_acted_idx
    on public.priwa_warnkarte_archive_events (project_id, acted_at desc, id desc);
create index priwa_warnkarte_archive_events_acted_by_idx
    on public.priwa_warnkarte_archive_events (acted_by);

alter table public.priwa_warnkarte_archive_events enable row level security;

create policy "PRIWA admins can read Warnkarte archive events"
on public.priwa_warnkarte_archive_events
for select to authenticated
using ((select public.priwa_is_project_admin(project_id)));

grant select on public.priwa_warnkarte_archive_events to authenticated;
grant all on public.priwa_warnkarte_archive_events to service_role;
grant usage, select on sequence public.priwa_warnkarte_archive_events_id_seq to service_role;

create or replace view public.priwa_warnkarte_archive_states
with (security_invoker = true)
as
select distinct on (event.version_id)
    event.project_id,
    event.version_id,
    event.action = 'archive' as is_archived
from public.priwa_warnkarte_archive_events event
order by event.version_id, event.acted_at desc, event.id desc;

grant select on public.priwa_warnkarte_archive_states to authenticated, service_role;

create or replace function internal.priwa_archive_warnkarte(p_version_id uuid)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    actor uuid := (select auth.uid());
    version_project_id uuid;
    current_version_id uuid;
    latest_event_id bigint;
    latest_action text;
begin
    select version.project_id
    into version_project_id
    from public.priwa_warnkarte_versions version
    where version.id = p_version_id;

    if version_project_id is null then
        raise exception 'Warnkarte version not found' using errcode = 'P0002';
    end if;

    if actor is null or not public.priwa_is_project_admin(version_project_id) then
        raise exception 'PRIWA project admin access is required' using errcode = '42501';
    end if;

    perform 1
    from public.priwa_projects project
    where project.id = version_project_id
    for update;

    select publication.version_id
    into current_version_id
    from public.priwa_warnkarte_publications publication
    where publication.project_id = version_project_id
    order by publication.published_at desc, publication.id desc
    limit 1;

    if current_version_id = p_version_id then
        raise exception 'Warnkarte current version cannot be archived' using errcode = '55000';
    end if;

    select event.id, event.action
    into latest_event_id, latest_action
    from public.priwa_warnkarte_archive_events event
    where event.version_id = p_version_id
    order by event.acted_at desc, event.id desc
    limit 1;

    if latest_action = 'archive' then
        return latest_event_id;
    end if;

    insert into public.priwa_warnkarte_archive_events (
        project_id,
        version_id,
        action,
        acted_by
    ) values (
        version_project_id,
        p_version_id,
        'archive',
        actor
    ) returning id into latest_event_id;

    return latest_event_id;
end;
$$;

create or replace function public.priwa_archive_warnkarte(p_version_id uuid)
returns bigint
language sql
volatile
set search_path = ''
as $$
    select internal.priwa_archive_warnkarte(p_version_id);
$$;

create or replace function internal.priwa_restore_warnkarte(p_version_id uuid)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    actor uuid := (select auth.uid());
    version_project_id uuid;
    latest_event_id bigint;
    latest_action text;
begin
    select version.project_id
    into version_project_id
    from public.priwa_warnkarte_versions version
    where version.id = p_version_id;

    if version_project_id is null then
        raise exception 'Warnkarte version not found' using errcode = 'P0002';
    end if;

    if actor is null or not public.priwa_is_project_admin(version_project_id) then
        raise exception 'PRIWA project admin access is required' using errcode = '42501';
    end if;

    perform 1
    from public.priwa_projects project
    where project.id = version_project_id
    for update;

    select event.id, event.action
    into latest_event_id, latest_action
    from public.priwa_warnkarte_archive_events event
    where event.version_id = p_version_id
    order by event.acted_at desc, event.id desc
    limit 1;

    if latest_action is distinct from 'archive' then
        return coalesce(latest_event_id, 0);
    end if;

    insert into public.priwa_warnkarte_archive_events (
        project_id,
        version_id,
        action,
        acted_by
    ) values (
        version_project_id,
        p_version_id,
        'restore',
        actor
    ) returning id into latest_event_id;

    return latest_event_id;
end;
$$;

create or replace function public.priwa_restore_warnkarte(p_version_id uuid)
returns bigint
language sql
volatile
set search_path = ''
as $$
    select internal.priwa_restore_warnkarte(p_version_id);
$$;

create or replace function internal.priwa_publish_warnkarte(p_version_id uuid)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    actor uuid := (select auth.uid());
    version_project_id uuid;
    latest_archive_action text;
    publication_id bigint;
begin
    select version.project_id
    into version_project_id
    from public.priwa_warnkarte_versions version
    where version.id = p_version_id;

    if version_project_id is null then
        raise exception 'Warnkarte version not found' using errcode = 'P0002';
    end if;

    if actor is null or not public.priwa_is_project_admin(version_project_id) then
        raise exception 'PRIWA project admin access is required' using errcode = '42501';
    end if;

    perform 1
    from public.priwa_projects project
    where project.id = version_project_id
    for update;

    select event.action
    into latest_archive_action
    from public.priwa_warnkarte_archive_events event
    where event.version_id = p_version_id
    order by event.acted_at desc, event.id desc
    limit 1;

    if latest_archive_action = 'archive' then
        raise exception 'Warnkarte archived version cannot be published' using errcode = '55000';
    end if;

    insert into public.priwa_warnkarte_publications (
        project_id,
        version_id,
        published_by
    ) values (
        version_project_id,
        p_version_id,
        actor
    ) returning id into publication_id;

    return publication_id;
end;
$$;

create or replace function internal.priwa_warnkarte_version_overlay(
    p_project_id uuid,
    p_version_id uuid
)
returns table (payload jsonb)
language sql
stable
security definer
set search_path = ''
as $$
    select jsonb_build_object(
        'version_id', version.id,
        'source_date', version.source_date,
        'type', 'FeatureCollection',
        'features', jsonb_agg(
            jsonb_build_object(
                'type', 'Feature',
                'geometry', public.st_asgeojson(polygon.geom)::jsonb,
                'properties', jsonb_build_object('probability', polygon.probability)
            )
            order by polygon.source_fid
        )
    )
    from public.priwa_warnkarte_versions version
    join public.priwa_warnkarte_polygons polygon on polygon.version_id = version.id
    where version.id = p_version_id
      and version.project_id = p_project_id
      and public.priwa_is_project_admin(p_project_id)
      and not exists (
          select 1
          from public.priwa_warnkarte_archive_states archive_state
          where archive_state.version_id = version.id
            and archive_state.is_archived
      )
    group by version.id, version.source_date;
$$;

revoke all on function internal.priwa_archive_warnkarte(uuid) from public, anon;
revoke all on function internal.priwa_restore_warnkarte(uuid) from public, anon;
grant execute on function internal.priwa_archive_warnkarte(uuid) to authenticated, service_role;
grant execute on function internal.priwa_restore_warnkarte(uuid) to authenticated, service_role;

revoke all on function public.priwa_archive_warnkarte(uuid) from public, anon;
revoke all on function public.priwa_restore_warnkarte(uuid) from public, anon;
grant execute on function public.priwa_archive_warnkarte(uuid) to authenticated, service_role;
grant execute on function public.priwa_restore_warnkarte(uuid) to authenticated, service_role;

comment on table public.priwa_warnkarte_archive_events
is 'Append-only admin archive and restore history for PRIWA Warnkarte versions.';
comment on view public.priwa_warnkarte_archive_states
is 'Latest archive state per PRIWA Warnkarte version, visible only through underlying admin RLS.';
