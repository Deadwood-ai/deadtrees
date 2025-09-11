create sequence "public"."dataset_flag_status_history_id_seq";

create sequence "public"."dataset_flags_id_seq";

create table "public"."dataset_flag_status_history" (
    "id" bigint not null default nextval('dataset_flag_status_history_id_seq'::regclass),
    "flag_id" bigint not null,
    "old_status" text,
    "new_status" text,
    "changed_by" uuid not null,
    "note" text,
    "changed_at" timestamp with time zone not null default now()
);


alter table "public"."dataset_flag_status_history" enable row level security;

create table "public"."dataset_flags" (
    "id" bigint not null default nextval('dataset_flags_id_seq'::regclass),
    "dataset_id" bigint not null,
    "created_by" uuid not null,
    "is_ortho_mosaic_issue" boolean not null default false,
    "is_prediction_issue" boolean not null default false,
    "description" text not null,
    "status" text not null default 'open'::text,
    "auditor_comment" text,
    "resolved_by" uuid,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
);


alter table "public"."dataset_flags" enable row level security;

alter sequence "public"."dataset_flag_status_history_id_seq" owned by "public"."dataset_flag_status_history"."id";

alter sequence "public"."dataset_flags_id_seq" owned by "public"."dataset_flags"."id";

CREATE UNIQUE INDEX dataset_flag_status_history_pkey ON public.dataset_flag_status_history USING btree (id);

CREATE UNIQUE INDEX dataset_flags_pkey ON public.dataset_flags USING btree (id);

CREATE INDEX idx_dataset_flags_created_by ON public.dataset_flags USING btree (created_by);

CREATE INDEX idx_dataset_flags_dataset ON public.dataset_flags USING btree (dataset_id);

CREATE INDEX idx_dataset_flags_dataset_id ON public.dataset_flags USING btree (dataset_id);

CREATE INDEX idx_dataset_flags_status_dataset ON public.dataset_flags USING btree (status, dataset_id);

CREATE INDEX idx_dataset_flags_status_dataset_id ON public.dataset_flags USING btree (status, dataset_id);

CREATE INDEX idx_flag_history_changed_at_desc ON public.dataset_flag_status_history USING btree (changed_at DESC);

CREATE INDEX idx_flag_history_flag ON public.dataset_flag_status_history USING btree (flag_id);

CREATE INDEX idx_flag_history_flag_id ON public.dataset_flag_status_history USING btree (flag_id);

alter table "public"."dataset_flag_status_history" add constraint "dataset_flag_status_history_pkey" PRIMARY KEY using index "dataset_flag_status_history_pkey";

alter table "public"."dataset_flags" add constraint "dataset_flags_pkey" PRIMARY KEY using index "dataset_flags_pkey";

alter table "public"."dataset_flag_status_history" add constraint "dataset_flag_status_history_changed_by_fkey" FOREIGN KEY (changed_by) REFERENCES auth.users(id) not valid;

alter table "public"."dataset_flag_status_history" validate constraint "dataset_flag_status_history_changed_by_fkey";

alter table "public"."dataset_flag_status_history" add constraint "dataset_flag_status_history_flag_id_fkey" FOREIGN KEY (flag_id) REFERENCES dataset_flags(id) ON DELETE CASCADE not valid;

alter table "public"."dataset_flag_status_history" validate constraint "dataset_flag_status_history_flag_id_fkey";

alter table "public"."dataset_flags" add constraint "dataset_flags_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) not valid;

alter table "public"."dataset_flags" validate constraint "dataset_flags_created_by_fkey";

alter table "public"."dataset_flags" add constraint "dataset_flags_dataset_id_fkey" FOREIGN KEY (dataset_id) REFERENCES v2_datasets(id) ON DELETE CASCADE not valid;

alter table "public"."dataset_flags" validate constraint "dataset_flags_dataset_id_fkey";

alter table "public"."dataset_flags" add constraint "dataset_flags_resolved_by_fkey" FOREIGN KEY (resolved_by) REFERENCES auth.users(id) not valid;

alter table "public"."dataset_flags" validate constraint "dataset_flags_resolved_by_fkey";

alter table "public"."dataset_flags" add constraint "dataset_flags_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'resolved'::text]))) not valid;

alter table "public"."dataset_flags" validate constraint "dataset_flags_status_check";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.get_user_emails(p_user_ids uuid[])
 RETURNS TABLE(user_id uuid, email text)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select u.id as user_id, u.email
  from auth.users u
  where u.id = any(p_user_ids)
    and exists (
      select 1 from public.privileged_users pu
      where pu.user_id = auth.uid() and coalesce(pu.can_audit, false)
    );
$function$
;

CREATE OR REPLACE FUNCTION public.update_flag_status(p_flag_id bigint, p_new_status text, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_old_status text;
  v_is_auditor boolean;
begin
  select exists(
    select 1 from public.privileged_users pu
    where pu.user_id = auth.uid() and coalesce(pu.can_audit, false)
  ) into v_is_auditor;

  if not v_is_auditor then
    raise exception 'not_authorized';
  end if;

  if p_new_status not in ('open','acknowledged','resolved') then
    raise exception 'invalid_status';
  end if;

  -- If you want to make the resolution note optional, comment out this block:
  -- if p_new_status = 'resolved' and (p_note is null or length(trim(p_note)) = 0) then
  --   raise exception 'resolution_note_required';
  -- end if;

  select status into v_old_status from public.dataset_flags where id = p_flag_id for update;
  if v_old_status is null then raise exception 'flag_not_found'; end if;

  update public.dataset_flags
     set status = p_new_status,
         auditor_comment = p_note,
         resolved_by = case when p_new_status = 'resolved' then auth.uid() else resolved_by end,
         updated_at = now()
   where id = p_flag_id;

  insert into public.dataset_flag_status_history(flag_id, old_status, new_status, changed_by, note, changed_at)
  values (p_flag_id, v_old_status, p_new_status, auth.uid(), p_note, now());
end;
$function$
;

create or replace view "public"."v_dataset_flag_agg" as  WITH base AS (
         SELECT dataset_flags.dataset_id,
            dataset_flags.status,
            dataset_flags.auditor_comment,
            dataset_flags.updated_at,
            dataset_flags.created_at
           FROM dataset_flags
          WHERE (dataset_flags.status = ANY (ARRAY['open'::text, 'acknowledged'::text]))
        ), agg AS (
         SELECT b.dataset_id,
            sum(
                CASE
                    WHEN (b.status = 'open'::text) THEN 1
                    ELSE 0
                END) AS open_count,
            sum(
                CASE
                    WHEN (b.status = 'acknowledged'::text) THEN 1
                    ELSE 0
                END) AS acknowledged_count,
                CASE
                    WHEN (sum(
                    CASE
                        WHEN (b.status = 'open'::text) THEN 1
                        ELSE 0
                    END) > 0) THEN 'open'::text
                    WHEN (sum(
                    CASE
                        WHEN (b.status = 'acknowledged'::text) THEN 1
                        ELSE 0
                    END) > 0) THEN 'acknowledged'::text
                    ELSE 'resolved'::text
                END AS latest_status,
            ( SELECT b2.auditor_comment
                   FROM base b2
                  WHERE (b2.dataset_id = b.dataset_id)
                  ORDER BY COALESCE(b2.updated_at, b2.created_at) DESC
                 LIMIT 1) AS latest_note
           FROM base b
          GROUP BY b.dataset_id
        )
 SELECT agg.dataset_id,
    agg.open_count,
    agg.acknowledged_count,
    agg.latest_status,
    agg.latest_note
   FROM agg;


grant delete on table "public"."dataset_flag_status_history" to "anon";

grant insert on table "public"."dataset_flag_status_history" to "anon";

grant references on table "public"."dataset_flag_status_history" to "anon";

grant select on table "public"."dataset_flag_status_history" to "anon";

grant trigger on table "public"."dataset_flag_status_history" to "anon";

grant truncate on table "public"."dataset_flag_status_history" to "anon";

grant update on table "public"."dataset_flag_status_history" to "anon";

grant delete on table "public"."dataset_flag_status_history" to "authenticated";

grant insert on table "public"."dataset_flag_status_history" to "authenticated";

grant references on table "public"."dataset_flag_status_history" to "authenticated";

grant select on table "public"."dataset_flag_status_history" to "authenticated";

grant trigger on table "public"."dataset_flag_status_history" to "authenticated";

grant truncate on table "public"."dataset_flag_status_history" to "authenticated";

grant update on table "public"."dataset_flag_status_history" to "authenticated";

grant delete on table "public"."dataset_flag_status_history" to "service_role";

grant insert on table "public"."dataset_flag_status_history" to "service_role";

grant references on table "public"."dataset_flag_status_history" to "service_role";

grant select on table "public"."dataset_flag_status_history" to "service_role";

grant trigger on table "public"."dataset_flag_status_history" to "service_role";

grant truncate on table "public"."dataset_flag_status_history" to "service_role";

grant update on table "public"."dataset_flag_status_history" to "service_role";

grant delete on table "public"."dataset_flags" to "anon";

grant insert on table "public"."dataset_flags" to "anon";

grant references on table "public"."dataset_flags" to "anon";

grant select on table "public"."dataset_flags" to "anon";

grant trigger on table "public"."dataset_flags" to "anon";

grant truncate on table "public"."dataset_flags" to "anon";

grant update on table "public"."dataset_flags" to "anon";

grant delete on table "public"."dataset_flags" to "authenticated";

grant insert on table "public"."dataset_flags" to "authenticated";

grant references on table "public"."dataset_flags" to "authenticated";

grant select on table "public"."dataset_flags" to "authenticated";

grant trigger on table "public"."dataset_flags" to "authenticated";

grant truncate on table "public"."dataset_flags" to "authenticated";

grant update on table "public"."dataset_flags" to "authenticated";

grant delete on table "public"."dataset_flags" to "service_role";

grant insert on table "public"."dataset_flags" to "service_role";

grant references on table "public"."dataset_flags" to "service_role";

grant select on table "public"."dataset_flags" to "service_role";

grant trigger on table "public"."dataset_flags" to "service_role";

grant truncate on table "public"."dataset_flags" to "service_role";

grant update on table "public"."dataset_flags" to "service_role";

create policy "dataset_flag_history_insert"
on "public"."dataset_flag_status_history"
as permissive
for insert
to public
with check ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))));


create policy "dataset_flag_history_select"
on "public"."dataset_flag_status_history"
as permissive
for select
to public
using ((EXISTS ( SELECT 1
   FROM dataset_flags f
  WHERE ((f.id = dataset_flag_status_history.flag_id) AND ((f.created_by = auth.uid()) OR (EXISTS ( SELECT 1
           FROM privileged_users pu
          WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))))))));


create policy "flags_hist_insert"
on "public"."dataset_flag_status_history"
as permissive
for insert
to public
with check ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))));


create policy "flags_hist_select"
on "public"."dataset_flag_status_history"
as permissive
for select
to public
using ((EXISTS ( SELECT 1
   FROM dataset_flags f
  WHERE ((f.id = dataset_flag_status_history.flag_id) AND ((f.created_by = auth.uid()) OR (EXISTS ( SELECT 1
           FROM privileged_users pu
          WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))))))));


create policy "dataset_flags_insert"
on "public"."dataset_flags"
as permissive
for insert
to public
with check ((created_by = auth.uid()));


create policy "dataset_flags_select"
on "public"."dataset_flags"
as permissive
for select
to public
using (((created_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false))))));


create policy "dataset_flags_update"
on "public"."dataset_flags"
as permissive
for update
to public
using ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))));


create policy "flags_insert"
on "public"."dataset_flags"
as permissive
for insert
to public
with check ((created_by = auth.uid()));


create policy "flags_select"
on "public"."dataset_flags"
as permissive
for select
to public
using (((created_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false))))));


create policy "flags_update"
on "public"."dataset_flags"
as permissive
for update
to public
using ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))))
with check ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))));



