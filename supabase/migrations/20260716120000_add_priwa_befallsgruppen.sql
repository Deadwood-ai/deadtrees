create table "public"."priwa_befallsgruppen" (
    "id" uuid not null default gen_random_uuid(),
    "project_id" uuid not null,
    "name" text not null,
    "origin" text not null default 'manual',
    "confidence" double precision,
    "suggestion_reason" text,
    "algorithm_version" text,
    "created_by" uuid not null,
    "updated_by" uuid not null,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    constraint "priwa_befallsgruppen_name_check"
        check (nullif(btrim(name), '') is not null),
    constraint "priwa_befallsgruppen_origin_check"
        check (origin in ('suggestion', 'manual')),
    constraint "priwa_befallsgruppen_confidence_check"
        check (confidence is null or (confidence >= 0 and confidence <= 1)),
    constraint "priwa_befallsgruppen_pkey" primary key ("id"),
    constraint "priwa_befallsgruppen_project_id_fkey"
        foreign key ("project_id") references "public"."priwa_projects"("id")
        on update cascade on delete cascade,
    constraint "priwa_befallsgruppen_created_by_fkey"
        foreign key ("created_by") references "auth"."users"("id")
        on update cascade,
    constraint "priwa_befallsgruppen_updated_by_fkey"
        foreign key ("updated_by") references "auth"."users"("id")
        on update cascade
);

create table "public"."priwa_befallsgruppe_members" (
    "group_id" uuid not null,
    "tree_id" uuid not null,
    "source" text not null default 'manual',
    "created_by" uuid not null,
    "created_at" timestamp with time zone not null default now(),
    constraint "priwa_befallsgruppe_members_pkey"
        primary key ("group_id", "tree_id"),
    constraint "priwa_befallsgruppe_members_tree_key"
        unique ("tree_id"),
    constraint "priwa_befallsgruppe_members_source_check"
        check (source in ('suggestion', 'manual')),
    constraint "priwa_befallsgruppe_members_group_id_fkey"
        foreign key ("group_id") references "public"."priwa_befallsgruppen"("id")
        on update cascade on delete cascade,
    constraint "priwa_befallsgruppe_members_tree_id_fkey"
        foreign key ("tree_id") references "public"."priwa_kaeferbaeume"("id")
        on update cascade on delete cascade,
    constraint "priwa_befallsgruppe_members_created_by_fkey"
        foreign key ("created_by") references "auth"."users"("id")
        on update cascade
);

create table "public"."priwa_befallsgruppe_flights" (
    "group_id" uuid not null,
    "dataset_id" bigint not null,
    "source" text not null default 'manual',
    "created_by" uuid not null,
    "created_at" timestamp with time zone not null default now(),
    constraint "priwa_befallsgruppe_flights_pkey"
        primary key ("group_id", "dataset_id"),
    constraint "priwa_befallsgruppe_flights_source_check"
        check (source in ('suggestion', 'manual')),
    constraint "priwa_befallsgruppe_flights_group_id_fkey"
        foreign key ("group_id") references "public"."priwa_befallsgruppen"("id")
        on update cascade on delete cascade,
    constraint "priwa_befallsgruppe_flights_dataset_id_fkey"
        foreign key ("dataset_id") references "public"."v2_datasets"("id")
        on update cascade on delete cascade,
    constraint "priwa_befallsgruppe_flights_created_by_fkey"
        foreign key ("created_by") references "auth"."users"("id")
        on update cascade
);

create index "priwa_befallsgruppen_project_idx"
    on "public"."priwa_befallsgruppen" ("project_id", "updated_at" desc);
create index "priwa_befallsgruppen_created_by_idx"
    on "public"."priwa_befallsgruppen" ("created_by");
create index "priwa_befallsgruppen_updated_by_idx"
    on "public"."priwa_befallsgruppen" ("updated_by");
create index "priwa_befallsgruppe_members_created_by_idx"
    on "public"."priwa_befallsgruppe_members" ("created_by");
create index "priwa_befallsgruppe_flights_dataset_idx"
    on "public"."priwa_befallsgruppe_flights" ("dataset_id");
create index "priwa_befallsgruppe_flights_created_by_idx"
    on "public"."priwa_befallsgruppe_flights" ("created_by");

alter table "public"."priwa_befallsgruppen" enable row level security;
alter table "public"."priwa_befallsgruppe_members" enable row level security;
alter table "public"."priwa_befallsgruppe_flights" enable row level security;

create or replace function public.priwa_set_befallsgruppe_actor_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    current_actor uuid := (select auth.uid());
begin
    if TG_OP = 'INSERT' then
        if current_actor is not null then
            NEW.created_by = coalesce(NEW.created_by, current_actor);
            NEW.updated_by = coalesce(NEW.updated_by, current_actor);
        end if;
        NEW.created_at = now();
        NEW.updated_at = NEW.created_at;
        return NEW;
    end if;

    NEW.id = OLD.id;
    NEW.project_id = OLD.project_id;
    NEW.created_at = OLD.created_at;
    NEW.created_by = OLD.created_by;
    NEW.updated_at = now();
    if current_actor is not null then
        NEW.updated_by = current_actor;
    end if;
    return NEW;
end;
$$;

create trigger priwa_befallsgruppen_set_actor_fields
before insert or update on public.priwa_befallsgruppen
for each row execute function public.priwa_set_befallsgruppe_actor_fields();

create or replace function public.priwa_require_nonempty_befallsgruppe()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    checked_group_id uuid;
begin
    if TG_TABLE_NAME = 'priwa_befallsgruppen' then
        checked_group_id := NEW.id;
    elsif TG_OP = 'DELETE' then
        checked_group_id := OLD.group_id;
    else
        checked_group_id := NEW.group_id;
    end if;

    if exists (
        select 1
        from public.priwa_befallsgruppen groups
        where groups.id = checked_group_id
    ) and not exists (
        select 1
        from public.priwa_befallsgruppe_members members
        where members.group_id = checked_group_id
    ) then
        raise exception 'A Befallsgruppe requires at least one tree';
    end if;

    return null;
end;
$$;

create constraint trigger priwa_befallsgruppen_require_member
after insert or update on public.priwa_befallsgruppen
deferrable initially deferred
for each row execute function public.priwa_require_nonempty_befallsgruppe();

create constraint trigger priwa_befallsgruppe_members_preserve_nonempty_group
after insert or delete on public.priwa_befallsgruppe_members
deferrable initially deferred
for each row execute function public.priwa_require_nonempty_befallsgruppe();

create policy "PRIWA members can read Befallsgruppen"
on "public"."priwa_befallsgruppen"
for select
to authenticated
using (public.priwa_is_project_member(project_id));

create policy "PRIWA members can create Befallsgruppen"
on "public"."priwa_befallsgruppen"
for insert
to authenticated
with check (
    public.priwa_is_project_member(project_id)
    and created_by = (select auth.uid())
    and updated_by = (select auth.uid())
);

create policy "PRIWA members can update Befallsgruppen"
on "public"."priwa_befallsgruppen"
for update
to authenticated
using (public.priwa_is_project_member(project_id))
with check (
    public.priwa_is_project_member(project_id)
    and updated_by = (select auth.uid())
);

create policy "PRIWA members can delete Befallsgruppen"
on "public"."priwa_befallsgruppen"
for delete
to authenticated
using (public.priwa_is_project_member(project_id));

create policy "PRIWA members can read Befallsgruppe members"
on "public"."priwa_befallsgruppe_members"
for select
to authenticated
using (
    exists (
        select 1
        from public.priwa_befallsgruppen groups
        where groups.id = group_id
          and public.priwa_is_project_member(groups.project_id)
    )
);

create policy "PRIWA members can create Befallsgruppe members"
on "public"."priwa_befallsgruppe_members"
for insert
to authenticated
with check (
    created_by = (select auth.uid())
    and exists (
        select 1
        from public.priwa_befallsgruppen groups
        join public.priwa_kaeferbaeume trees
          on trees.id = tree_id
         and trees.project_id = groups.project_id
         and trees.deleted_at is null
        where groups.id = group_id
          and public.priwa_is_project_member(groups.project_id)
    )
);

create policy "PRIWA members can delete Befallsgruppe members"
on "public"."priwa_befallsgruppe_members"
for delete
to authenticated
using (
    exists (
        select 1
        from public.priwa_befallsgruppen groups
        where groups.id = group_id
          and public.priwa_is_project_member(groups.project_id)
    )
);

create policy "PRIWA members can read Befallsgruppe flights"
on "public"."priwa_befallsgruppe_flights"
for select
to authenticated
using (
    exists (
        select 1
        from public.priwa_befallsgruppen groups
        where groups.id = group_id
          and public.priwa_is_project_member(groups.project_id)
    )
);

create policy "PRIWA members can create Befallsgruppe flights"
on "public"."priwa_befallsgruppe_flights"
for insert
to authenticated
with check (
    created_by = (select auth.uid())
    and exists (
        select 1
        from public.priwa_befallsgruppen groups
        where groups.id = group_id
          and public.priwa_is_project_member(groups.project_id)
          and exists (
              select 1
              from public.priwa_project_latest_flight_mosaics(
                  groups.project_id,
                  100
              ) mosaics
              where mosaics.id = dataset_id::text
          )
    )
);

create policy "PRIWA members can delete Befallsgruppe flights"
on "public"."priwa_befallsgruppe_flights"
for delete
to authenticated
using (
    exists (
        select 1
        from public.priwa_befallsgruppen groups
        where groups.id = group_id
          and public.priwa_is_project_member(groups.project_id)
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

    if cardinality(normalized_dataset_ids) > 0 and (
        select count(*)
        from public.priwa_project_latest_flight_mosaics(p_project_id, 100) mosaics
        where mosaics.id ~ '^[0-9]+$'
          and mosaics.id::bigint = any(normalized_dataset_ids)
    ) <> cardinality(normalized_dataset_ids) then
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

grant select, insert, update, delete
on table "public"."priwa_befallsgruppen" to "authenticated";
grant select, insert, delete
on table "public"."priwa_befallsgruppe_members" to "authenticated";
grant select, insert, delete
on table "public"."priwa_befallsgruppe_flights" to "authenticated";

grant all on table "public"."priwa_befallsgruppen" to "service_role";
grant all on table "public"."priwa_befallsgruppe_members" to "service_role";
grant all on table "public"."priwa_befallsgruppe_flights" to "service_role";

revoke all on function public.priwa_set_befallsgruppe_actor_fields() from public;
revoke all on function public.priwa_require_nonempty_befallsgruppe() from public;
revoke all on function public.priwa_save_befallsgruppe(
    uuid, text, uuid[], bigint[], uuid, text, double precision, text, text
) from public;
revoke all on function public.priwa_save_befallsgruppe(
    uuid, text, uuid[], bigint[], uuid, text, double precision, text, text
) from anon;

grant execute on function public.priwa_save_befallsgruppe(
    uuid, text, uuid[], bigint[], uuid, text, double precision, text, text
) to authenticated;
grant execute on function public.priwa_save_befallsgruppe(
    uuid, text, uuid[], bigint[], uuid, text, double precision, text, text
) to service_role;

comment on table public.priwa_befallsgruppen
is 'User-confirmed PRIWA infestation groups. Automatic clusters remain suggestions until saved.';
comment on function public.priwa_save_befallsgruppe(
    uuid, text, uuid[], bigint[], uuid, text, double precision, text, text
)
is 'Atomically creates or edits a PRIWA infestation group, moves selected trees, and replaces explicit flight links.';
