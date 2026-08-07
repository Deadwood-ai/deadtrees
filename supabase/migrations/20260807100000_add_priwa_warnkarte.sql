create table public.priwa_warnkarte_versions (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.priwa_projects(id) on update cascade on delete cascade,
    source_date date not null,
    source_filename text not null,
    checksum_sha256 text not null,
    source_layer text not null,
    source_crs text not null,
    feature_count integer not null,
    imported_by uuid not null references auth.users(id) on update cascade,
    imported_at timestamp with time zone not null default now(),
    constraint priwa_warnkarte_versions_project_checksum_key unique (project_id, checksum_sha256),
    constraint priwa_warnkarte_versions_id_project_key unique (id, project_id),
    constraint priwa_warnkarte_versions_checksum_check
        check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    constraint priwa_warnkarte_versions_filename_check
        check (source_filename ~ '[0-9]{4}-[0-9]{2}-[0-9]{2}\.gpkg$'),
    constraint priwa_warnkarte_versions_filename_date_check
        check (right(source_filename, 15) = source_date::text || '.gpkg'),
    constraint priwa_warnkarte_versions_crs_check
        check (source_crs = 'EPSG:32632'),
    constraint priwa_warnkarte_versions_feature_count_check
        check (feature_count > 0)
);

create table public.priwa_warnkarte_polygons (
    id bigint generated always as identity primary key,
    version_id uuid not null references public.priwa_warnkarte_versions(id) on delete cascade,
    source_fid bigint not null,
    probability numeric(2,1) not null,
    geom geometry(Polygon, 4326) not null,
    constraint priwa_warnkarte_polygons_version_fid_key unique (version_id, source_fid),
    constraint priwa_warnkarte_polygons_probability_check
        check (probability between 0.0 and 1.0),
    constraint priwa_warnkarte_polygons_geom_check
        check (not st_isempty(geom) and st_isvalid(geom))
);

create table public.priwa_warnkarte_publications (
    id bigint generated always as identity primary key,
    project_id uuid not null references public.priwa_projects(id) on update cascade on delete cascade,
    version_id uuid not null,
    published_by uuid not null references auth.users(id) on update cascade,
    published_at timestamp with time zone not null default now(),
    constraint priwa_warnkarte_publications_version_project_fkey
        foreign key (version_id, project_id)
        references public.priwa_warnkarte_versions(id, project_id)
        on delete no action
        deferrable initially deferred
);

create index priwa_warnkarte_versions_project_imported_idx
    on public.priwa_warnkarte_versions (project_id, imported_at desc);
create index priwa_warnkarte_versions_imported_by_idx
    on public.priwa_warnkarte_versions (imported_by);
create index priwa_warnkarte_polygons_version_idx
    on public.priwa_warnkarte_polygons (version_id);
create index priwa_warnkarte_polygons_geom_idx
    on public.priwa_warnkarte_polygons using gist (geom);
create index priwa_warnkarte_publications_project_published_idx
    on public.priwa_warnkarte_publications (project_id, published_at desc, id desc);
create index priwa_warnkarte_publications_version_idx
    on public.priwa_warnkarte_publications (version_id);
create index priwa_warnkarte_publications_published_by_idx
    on public.priwa_warnkarte_publications (published_by);

alter table public.priwa_warnkarte_versions enable row level security;
alter table public.priwa_warnkarte_polygons enable row level security;
alter table public.priwa_warnkarte_publications enable row level security;

create or replace function public.priwa_is_project_admin(p_project_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
    select exists (
        select 1
        from public.priwa_project_memberships membership
        where membership.project_id = p_project_id
          and membership.user_id = (select auth.uid())
          and membership.role = 'admin'::public.priwa_project_role
    );
$$;

revoke all on function public.priwa_is_project_admin(uuid) from public, anon;
grant execute on function public.priwa_is_project_admin(uuid) to authenticated, service_role;

create policy "PRIWA admins can read Warnkarte versions"
on public.priwa_warnkarte_versions
for select to authenticated
using ((select public.priwa_is_project_admin(project_id)));

create policy "PRIWA admins can read Warnkarte polygons"
on public.priwa_warnkarte_polygons
for select to authenticated
using (
    exists (
        select 1
        from public.priwa_warnkarte_versions version
        where version.id = version_id
          and (select public.priwa_is_project_admin(version.project_id))
    )
);

create policy "PRIWA admins can read Warnkarte publications"
on public.priwa_warnkarte_publications
for select to authenticated
using ((select public.priwa_is_project_admin(project_id)));

grant select on public.priwa_warnkarte_versions to authenticated;
grant select on public.priwa_warnkarte_polygons to authenticated;
grant select on public.priwa_warnkarte_publications to authenticated;
grant all on public.priwa_warnkarte_versions to service_role;
grant all on public.priwa_warnkarte_polygons to service_role;
grant all on public.priwa_warnkarte_publications to service_role;
grant usage, select on sequence public.priwa_warnkarte_polygons_id_seq to service_role;
grant usage, select on sequence public.priwa_warnkarte_publications_id_seq to service_role;

create schema if not exists internal;

create or replace function internal.priwa_import_warnkarte(
    p_actor uuid,
    p_project_id uuid,
    p_source_filename text,
    p_checksum_sha256 text,
    p_source_date date,
    p_source_layer text,
    p_source_crs text,
    p_polygons jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    actor uuid := p_actor;
    imported_version_id uuid;
    expected_count integer;
    inserted_count integer;
begin
    if actor is null or not exists (
        select 1
        from public.priwa_project_memberships membership
        where membership.project_id = p_project_id
          and membership.user_id = actor
          and membership.role = 'admin'::public.priwa_project_role
    ) then
        raise exception 'PRIWA project admin access is required' using errcode = '42501';
    end if;

    if p_source_crs is distinct from 'EPSG:32632' then
        raise exception 'Warnkarte source CRS must be EPSG:32632' using errcode = '22023';
    end if;

    if jsonb_typeof(p_polygons) is distinct from 'array' or jsonb_array_length(p_polygons) = 0 then
        raise exception 'Warnkarte must contain at least one polygon' using errcode = '22023';
    end if;

    if exists (
        select 1
        from jsonb_array_elements(p_polygons) item
        cross join lateral (
            select round((item ->> 'probability')::numeric, 1) as normalized
        ) value
        where value.normalized < 0.0
           or value.normalized > 1.0
           or abs((item ->> 'probability')::numeric - value.normalized) > 0.000001
    ) then
        raise exception 'Warnkarte probability must be between 0.0 and 1.0 in 0.1 steps'
            using errcode = '22023';
    end if;

    expected_count := jsonb_array_length(p_polygons);

    insert into public.priwa_warnkarte_versions (
        project_id,
        source_date,
        source_filename,
        checksum_sha256,
        source_layer,
        source_crs,
        feature_count,
        imported_by
    ) values (
        p_project_id,
        p_source_date,
        p_source_filename,
        p_checksum_sha256,
        p_source_layer,
        p_source_crs,
        expected_count,
        actor
    ) returning id into imported_version_id;

    insert into public.priwa_warnkarte_polygons (
        version_id,
        source_fid,
        probability,
        geom
    )
    select
        imported_version_id,
        (item ->> 'fid')::bigint,
        round((item ->> 'probability')::numeric, 1)::numeric(2,1),
        public.st_transform(
            public.st_geomfromwkb(decode(item ->> 'wkb_hex', 'hex'), 32632),
            4326
        )::public.geometry(Polygon, 4326)
    from jsonb_array_elements(p_polygons) item;

    get diagnostics inserted_count = row_count;
    if inserted_count <> expected_count then
        raise exception 'Warnkarte polygon count mismatch' using errcode = '22023';
    end if;

    return imported_version_id;
end;
$$;

create or replace function public.priwa_import_warnkarte(
    p_actor uuid,
    p_project_id uuid,
    p_source_filename text,
    p_checksum_sha256 text,
    p_source_date date,
    p_source_layer text,
    p_source_crs text,
    p_polygons jsonb
)
returns uuid
language sql
volatile
set search_path = ''
as $$
    select internal.priwa_import_warnkarte(
        p_actor,
        p_project_id,
        p_source_filename,
        p_checksum_sha256,
        p_source_date,
        p_source_layer,
        p_source_crs,
        p_polygons
    );
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

create or replace function public.priwa_publish_warnkarte(p_version_id uuid)
returns bigint
language sql
volatile
set search_path = ''
as $$
    select internal.priwa_publish_warnkarte(p_version_id);
$$;

create or replace function internal.priwa_current_warnkarte(p_project_id uuid)
returns table (payload jsonb)
language sql
stable
security definer
set search_path = ''
as $$
    with current_publication as (
        select publication.version_id
        from public.priwa_warnkarte_publications publication
        where publication.project_id = p_project_id
          and public.priwa_is_project_member(p_project_id)
        order by publication.published_at desc, publication.id desc
        limit 1
    )
    select jsonb_build_object(
        'version_id', null,
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
    from current_publication publication
    join public.priwa_warnkarte_versions version on version.id = publication.version_id
    join public.priwa_warnkarte_polygons polygon on polygon.version_id = version.id
    group by version.id, version.source_date;
$$;

create or replace function public.priwa_current_warnkarte(p_project_id uuid)
returns table (payload jsonb)
language sql
stable
set search_path = ''
as $$
    select * from internal.priwa_current_warnkarte(p_project_id);
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
    group by version.id, version.source_date;
$$;

create or replace function public.priwa_warnkarte_version_overlay(
    p_project_id uuid,
    p_version_id uuid
)
returns table (payload jsonb)
language sql
stable
set search_path = ''
as $$
    select * from internal.priwa_warnkarte_version_overlay(p_project_id, p_version_id);
$$;

revoke all on function internal.priwa_import_warnkarte(uuid, uuid, text, text, date, text, text, jsonb) from public, anon, authenticated;
revoke all on function internal.priwa_publish_warnkarte(uuid) from public, anon;
revoke all on function internal.priwa_current_warnkarte(uuid) from public, anon;
revoke all on function internal.priwa_warnkarte_version_overlay(uuid, uuid) from public, anon;
grant execute on function internal.priwa_import_warnkarte(uuid, uuid, text, text, date, text, text, jsonb) to service_role;
grant execute on function internal.priwa_publish_warnkarte(uuid) to authenticated, service_role;
grant execute on function internal.priwa_current_warnkarte(uuid) to authenticated, service_role;
grant execute on function internal.priwa_warnkarte_version_overlay(uuid, uuid) to authenticated, service_role;

revoke all on function public.priwa_import_warnkarte(uuid, uuid, text, text, date, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.priwa_publish_warnkarte(uuid) from public, anon;
revoke all on function public.priwa_current_warnkarte(uuid) from public, anon;
revoke all on function public.priwa_warnkarte_version_overlay(uuid, uuid) from public, anon;
grant execute on function public.priwa_import_warnkarte(uuid, uuid, text, text, date, text, text, jsonb) to service_role;
grant execute on function public.priwa_publish_warnkarte(uuid) to authenticated, service_role;
grant execute on function public.priwa_current_warnkarte(uuid) to authenticated, service_role;
grant execute on function public.priwa_warnkarte_version_overlay(uuid, uuid) to authenticated, service_role;

comment on table public.priwa_warnkarte_versions
is 'Immutable admin-only provenance for validated PRIWA Warnkarte GeoPackage imports.';
comment on table public.priwa_warnkarte_polygons
is 'Normalized immutable EPSG:4326 polygons for PRIWA Warnkarte versions.';
comment on table public.priwa_warnkarte_publications
is 'Append-only publication history; the newest row per project selects the visible Warnkarte.';
comment on function public.priwa_current_warnkarte(uuid)
is 'Returns only the active Warnkarte date, geometry, and probability to project members.';
