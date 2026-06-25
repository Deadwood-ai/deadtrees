create table "public"."priwa_project_mosaics" (
    "id" uuid not null default gen_random_uuid(),
    "project_id" uuid not null,
    "label" text not null,
    "cog_url" text not null,
    "capture_date" date,
    "sort_order" integer not null default 0,
    "is_active" boolean not null default true,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    constraint "priwa_project_mosaics_label_not_blank" check (btrim(label) <> ''),
    constraint "priwa_project_mosaics_cog_url_not_blank" check (btrim(cog_url) <> '')
);

alter table "public"."priwa_project_mosaics" enable row level security;

create unique index priwa_project_mosaics_pkey
on public.priwa_project_mosaics using btree (id);

create index priwa_project_mosaics_active_project_idx
on public.priwa_project_mosaics using btree (project_id, sort_order, capture_date desc, created_at desc)
where is_active = true;

alter table "public"."priwa_project_mosaics"
add constraint "priwa_project_mosaics_pkey" primary key using index "priwa_project_mosaics_pkey";

alter table "public"."priwa_project_mosaics"
add constraint "priwa_project_mosaics_project_id_fkey"
foreign key (project_id) references public.priwa_projects(id) on update cascade on delete cascade not valid;

alter table "public"."priwa_project_mosaics"
validate constraint "priwa_project_mosaics_project_id_fkey";

create or replace function public.priwa_set_project_mosaic_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    NEW.updated_at = now();
    return NEW;
end;
$$;

create trigger priwa_project_mosaics_set_updated_at
before update on public.priwa_project_mosaics
for each row execute function public.priwa_set_project_mosaic_updated_at();

grant select on table "public"."priwa_project_mosaics" to "authenticated";
grant all on table "public"."priwa_project_mosaics" to "service_role";
revoke all on function public.priwa_set_project_mosaic_updated_at() from public;
grant execute on function public.priwa_set_project_mosaic_updated_at() to "service_role";

create policy "PRIWA members can read active project mosaics"
on "public"."priwa_project_mosaics"
as permissive
for select
to authenticated
using (
    is_active
    and public.priwa_is_project_member(project_id)
);
