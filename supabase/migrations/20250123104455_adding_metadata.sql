create table "public"."v2_metadata" (
    "dataset_id" bigint not null,
    "metadata" jsonb not null,
    "version" integer not null,
    "created_at" timestamp with time zone not null default now(),
    "processing_runtime" double precision
);


alter table "public"."v2_metadata" enable row level security;

CREATE UNIQUE INDEX v2_metadata_pkey ON public.v2_metadata USING btree (dataset_id);

alter table "public"."v2_metadata" add constraint "v2_metadata_pkey" PRIMARY KEY using index "v2_metadata_pkey";

alter table "public"."v2_metadata" add constraint "v2_metadata_dataset_id_fkey" FOREIGN KEY (dataset_id) REFERENCES v2_datasets(id) ON DELETE CASCADE not valid;

alter table "public"."v2_metadata" validate constraint "v2_metadata_dataset_id_fkey";

grant delete on table "public"."v2_metadata" to "anon";

grant insert on table "public"."v2_metadata" to "anon";

grant references on table "public"."v2_metadata" to "anon";

grant select on table "public"."v2_metadata" to "anon";

grant trigger on table "public"."v2_metadata" to "anon";

grant truncate on table "public"."v2_metadata" to "anon";

grant update on table "public"."v2_metadata" to "anon";

grant delete on table "public"."v2_metadata" to "authenticated";

grant insert on table "public"."v2_metadata" to "authenticated";

grant references on table "public"."v2_metadata" to "authenticated";

grant select on table "public"."v2_metadata" to "authenticated";

grant trigger on table "public"."v2_metadata" to "authenticated";

grant truncate on table "public"."v2_metadata" to "authenticated";

grant update on table "public"."v2_metadata" to "authenticated";

grant delete on table "public"."v2_metadata" to "service_role";

grant insert on table "public"."v2_metadata" to "service_role";

grant references on table "public"."v2_metadata" to "service_role";

grant select on table "public"."v2_metadata" to "service_role";

grant trigger on table "public"."v2_metadata" to "service_role";

grant truncate on table "public"."v2_metadata" to "service_role";

grant update on table "public"."v2_metadata" to "service_role";

create policy "Enable insert for authenticated users only"
on "public"."v2_metadata"
as permissive
for insert
to authenticated
with check (true);


create policy "Enable read access for all users"
on "public"."v2_metadata"
as permissive
for select
to public
using (true);


create policy "Enable update for users based on email"
on "public"."v2_metadata"
as permissive
for update
to public
using (((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text))
with check (((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text));



