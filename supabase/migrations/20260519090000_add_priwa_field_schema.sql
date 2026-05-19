create type "public"."priwa_project_role" as enum ('field_user', 'coordinator', 'admin');

create type "public"."priwa_location_source" as enum ('qr_exact', 'gps_estimated', 'map_estimated');

create table "public"."priwa_projects" (
    "id" uuid not null default gen_random_uuid(),
    "slug" text not null,
    "name" text not null,
    "created_at" timestamp with time zone not null default now()
);

alter table "public"."priwa_projects" enable row level security;

create table "public"."priwa_project_memberships" (
    "project_id" uuid not null,
    "user_id" uuid not null,
    "role" priwa_project_role not null default 'field_user',
    "created_at" timestamp with time zone not null default now()
);

alter table "public"."priwa_project_memberships" enable row level security;

create table "public"."priwa_kaeferbaeume" (
    "id" uuid not null default gen_random_uuid(),
    "project_id" uuid not null,
    "geom" geometry(Point, 4326) not null,
    "location_source" priwa_location_source not null,
    "is_exact_location" boolean generated always as (location_source = 'qr_exact'::priwa_location_source) stored,
    "baumnr" text,
    "fund" text not null,
    "baumart" text not null,
    "bm" text not null,
    "bohrloch" text not null,
    "harz" text not null,
    "nadel" text not null,
    "rinde" text,
    "kv" text,
    "name" text not null,
    "datum" date not null,
    "kom" text,
    "raw_qr_value" text,
    "created_by" uuid not null,
    "updated_by" uuid not null,
    "deleted_by" uuid,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "deleted_at" timestamp with time zone,
    "client_updated_at" timestamp with time zone
);

alter table "public"."priwa_kaeferbaeume" enable row level security;

CREATE UNIQUE INDEX priwa_projects_pkey ON public.priwa_projects USING btree (id);
CREATE UNIQUE INDEX priwa_projects_slug_key ON public.priwa_projects USING btree (slug);
CREATE UNIQUE INDEX priwa_project_memberships_pkey ON public.priwa_project_memberships USING btree (project_id, user_id);
CREATE INDEX priwa_project_memberships_user_idx ON public.priwa_project_memberships USING btree (user_id, project_id);
CREATE UNIQUE INDEX priwa_kaeferbaeume_pkey ON public.priwa_kaeferbaeume USING btree (id);
CREATE INDEX priwa_kaeferbaeume_geom_idx ON public.priwa_kaeferbaeume USING gist (geom);
CREATE INDEX priwa_kaeferbaeume_project_idx ON public.priwa_kaeferbaeume USING btree (project_id);
CREATE INDEX priwa_kaeferbaeume_baumnr_idx ON public.priwa_kaeferbaeume USING btree (baumnr);
CREATE INDEX priwa_kaeferbaeume_active_project_idx ON public.priwa_kaeferbaeume USING btree (project_id, updated_at desc) WHERE deleted_at is null;

alter table "public"."priwa_projects" add constraint "priwa_projects_pkey" PRIMARY KEY using index "priwa_projects_pkey";
alter table "public"."priwa_projects" add constraint "priwa_projects_slug_key" UNIQUE using index "priwa_projects_slug_key";
alter table "public"."priwa_project_memberships" add constraint "priwa_project_memberships_pkey" PRIMARY KEY using index "priwa_project_memberships_pkey";
alter table "public"."priwa_kaeferbaeume" add constraint "priwa_kaeferbaeume_pkey" PRIMARY KEY using index "priwa_kaeferbaeume_pkey";

alter table "public"."priwa_project_memberships" add constraint "priwa_project_memberships_project_id_fkey" FOREIGN KEY (project_id) REFERENCES priwa_projects(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;
alter table "public"."priwa_project_memberships" validate constraint "priwa_project_memberships_project_id_fkey";

alter table "public"."priwa_project_memberships" add constraint "priwa_project_memberships_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;
alter table "public"."priwa_project_memberships" validate constraint "priwa_project_memberships_user_id_fkey";

alter table "public"."priwa_kaeferbaeume" add constraint "priwa_kaeferbaeume_project_id_fkey" FOREIGN KEY (project_id) REFERENCES priwa_projects(id) ON UPDATE CASCADE not valid;
alter table "public"."priwa_kaeferbaeume" validate constraint "priwa_kaeferbaeume_project_id_fkey";

alter table "public"."priwa_kaeferbaeume" add constraint "priwa_kaeferbaeume_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON UPDATE CASCADE not valid;
alter table "public"."priwa_kaeferbaeume" validate constraint "priwa_kaeferbaeume_created_by_fkey";

alter table "public"."priwa_kaeferbaeume" add constraint "priwa_kaeferbaeume_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON UPDATE CASCADE not valid;
alter table "public"."priwa_kaeferbaeume" validate constraint "priwa_kaeferbaeume_updated_by_fkey";

alter table "public"."priwa_kaeferbaeume" add constraint "priwa_kaeferbaeume_deleted_by_fkey" FOREIGN KEY (deleted_by) REFERENCES auth.users(id) ON UPDATE CASCADE not valid;
alter table "public"."priwa_kaeferbaeume" validate constraint "priwa_kaeferbaeume_deleted_by_fkey";

alter table "public"."priwa_kaeferbaeume" add constraint "priwa_kaeferbaeume_baumnr_required_for_estimated_location" CHECK (
    location_source = 'qr_exact'::priwa_location_source
    or nullif(btrim(baumnr), '') is not null
) not valid;
alter table "public"."priwa_kaeferbaeume" validate constraint "priwa_kaeferbaeume_baumnr_required_for_estimated_location";

alter table "public"."priwa_kaeferbaeume" add constraint "priwa_kaeferbaeume_soft_delete_actor_check" CHECK (
    (deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null)
) not valid;
alter table "public"."priwa_kaeferbaeume" validate constraint "priwa_kaeferbaeume_soft_delete_actor_check";

create or replace function public.priwa_is_project_member(p_project_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
    select exists (
        select 1
        from public.priwa_project_memberships membership
        where membership.project_id = p_project_id
          and membership.user_id = (select auth.uid())
    );
$$;

create or replace function public.priwa_set_kaeferbaum_actor_fields()
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
            if NEW.deleted_at is not null then
                NEW.deleted_by = coalesce(NEW.deleted_by, current_actor);
            end if;
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
        if OLD.deleted_at is null and NEW.deleted_at is not null then
            NEW.deleted_by = coalesce(NEW.deleted_by, current_actor);
        end if;
    end if;

    return NEW;
end;
$$;

CREATE TRIGGER priwa_kaeferbaeume_set_actor_fields
BEFORE INSERT OR UPDATE ON public.priwa_kaeferbaeume
FOR EACH ROW EXECUTE FUNCTION public.priwa_set_kaeferbaum_actor_fields();

grant select on table "public"."priwa_projects" to "authenticated";
grant select on table "public"."priwa_project_memberships" to "authenticated";
grant select, insert, update on table "public"."priwa_kaeferbaeume" to "authenticated";
grant all on table "public"."priwa_projects" to "service_role";
grant all on table "public"."priwa_project_memberships" to "service_role";
grant all on table "public"."priwa_kaeferbaeume" to "service_role";
revoke all on function public.priwa_is_project_member(uuid) from public;
revoke all on function public.priwa_set_kaeferbaum_actor_fields() from public;
grant execute on function public.priwa_is_project_member(uuid) to "authenticated";
grant execute on function public.priwa_is_project_member(uuid) to "service_role";

create policy "PRIWA members can read their projects"
on "public"."priwa_projects"
as permissive
for select
to authenticated
using (public.priwa_is_project_member(id));

create policy "PRIWA users can read own memberships"
on "public"."priwa_project_memberships"
as permissive
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "PRIWA members can read active kaeferbaeume"
on "public"."priwa_kaeferbaeume"
as permissive
for select
to authenticated
using (
    deleted_at is null
    and public.priwa_is_project_member(project_id)
);

create policy "PRIWA members can create kaeferbaeume"
on "public"."priwa_kaeferbaeume"
as permissive
for insert
to authenticated
with check (
    public.priwa_is_project_member(project_id)
    and created_by = (select auth.uid())
    and updated_by = (select auth.uid())
    and deleted_at is null
    and deleted_by is null
);

create policy "PRIWA members can update kaeferbaeume"
on "public"."priwa_kaeferbaeume"
as permissive
for update
to authenticated
using (
    deleted_at is null
    and public.priwa_is_project_member(project_id)
)
with check (
    public.priwa_is_project_member(project_id)
    and updated_by = (select auth.uid())
    and (
        (deleted_at is null and deleted_by is null)
        or (deleted_at is not null and deleted_by = (select auth.uid()))
    )
);
