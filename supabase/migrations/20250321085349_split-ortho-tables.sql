drop view if exists "public"."v2_full_dataset_view";

create table "public"."v2_orthos_processed" (
    "dataset_id" bigint not null,
    "ortho_file_name" text not null,
    "version" integer not null,
    "created_at" timestamp with time zone not null default now(),
    "bbox" box2d,
    "sha256" text,
    "ortho_processing_runtime" double precision,
    "ortho_file_size" bigint not null,
    "ortho_info" jsonb
);


alter table "public"."v2_orthos_processed" enable row level security;

alter table "public"."v2_orthos" drop column "ortho_original_info";

alter table "public"."v2_orthos" drop column "ortho_processed";

alter table "public"."v2_orthos" drop column "ortho_processed_info";

alter table "public"."v2_orthos" drop column "ortho_processing_runtime";

alter table "public"."v2_orthos" add column "ortho_info" jsonb;

CREATE UNIQUE INDEX v2_orthos_processed_pkey ON public.v2_orthos_processed USING btree (dataset_id);

alter table "public"."v2_orthos_processed" add constraint "v2_orthos_processed_pkey" PRIMARY KEY using index "v2_orthos_processed_pkey";

alter table "public"."v2_orthos_processed" add constraint "v2_orthos_processed_dataset_id_fkey" FOREIGN KEY (dataset_id) REFERENCES v2_datasets(id) ON DELETE CASCADE not valid;

alter table "public"."v2_orthos_processed" validate constraint "v2_orthos_processed_dataset_id_fkey";

grant delete on table "public"."v2_orthos_processed" to "anon";

grant insert on table "public"."v2_orthos_processed" to "anon";

grant references on table "public"."v2_orthos_processed" to "anon";

grant select on table "public"."v2_orthos_processed" to "anon";

grant trigger on table "public"."v2_orthos_processed" to "anon";

grant truncate on table "public"."v2_orthos_processed" to "anon";

grant update on table "public"."v2_orthos_processed" to "anon";

grant delete on table "public"."v2_orthos_processed" to "authenticated";

grant insert on table "public"."v2_orthos_processed" to "authenticated";

grant references on table "public"."v2_orthos_processed" to "authenticated";

grant select on table "public"."v2_orthos_processed" to "authenticated";

grant trigger on table "public"."v2_orthos_processed" to "authenticated";

grant truncate on table "public"."v2_orthos_processed" to "authenticated";

grant update on table "public"."v2_orthos_processed" to "authenticated";

grant delete on table "public"."v2_orthos_processed" to "service_role";

grant insert on table "public"."v2_orthos_processed" to "service_role";

grant references on table "public"."v2_orthos_processed" to "service_role";

grant select on table "public"."v2_orthos_processed" to "service_role";

grant trigger on table "public"."v2_orthos_processed" to "service_role";

grant truncate on table "public"."v2_orthos_processed" to "service_role";

grant update on table "public"."v2_orthos_processed" to "service_role";

create policy "Enable insert for authenticated users only"
on "public"."v2_orthos_processed"
as permissive
for insert
to authenticated
with check (true);


create policy "Enable read access for all users"
on "public"."v2_orthos_processed"
as permissive
for select
to public
using (true);


create policy "Enable update for processor"
on "public"."v2_orthos_processed"
as permissive
for update
to public
using (((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text))
with check (((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text));



