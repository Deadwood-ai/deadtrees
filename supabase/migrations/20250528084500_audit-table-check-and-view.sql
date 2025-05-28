drop policy "Enable update for processor" on "public"."v2_statuses";

revoke delete on table "public"."database_stats" from "anon";

revoke insert on table "public"."database_stats" from "anon";

revoke references on table "public"."database_stats" from "anon";

revoke select on table "public"."database_stats" from "anon";

revoke trigger on table "public"."database_stats" from "anon";

revoke truncate on table "public"."database_stats" from "anon";

revoke update on table "public"."database_stats" from "anon";

revoke delete on table "public"."database_stats" from "authenticated";

revoke insert on table "public"."database_stats" from "authenticated";

revoke references on table "public"."database_stats" from "authenticated";

revoke select on table "public"."database_stats" from "authenticated";

revoke trigger on table "public"."database_stats" from "authenticated";

revoke truncate on table "public"."database_stats" from "authenticated";

revoke update on table "public"."database_stats" from "authenticated";

revoke delete on table "public"."database_stats" from "service_role";

revoke insert on table "public"."database_stats" from "service_role";

revoke references on table "public"."database_stats" from "service_role";

revoke select on table "public"."database_stats" from "service_role";

revoke trigger on table "public"."database_stats" from "service_role";

revoke truncate on table "public"."database_stats" from "service_role";

revoke update on table "public"."database_stats" from "service_role";

revoke delete on table "public"."deadtrees_logs" from "anon";

revoke insert on table "public"."deadtrees_logs" from "anon";

revoke references on table "public"."deadtrees_logs" from "anon";

revoke select on table "public"."deadtrees_logs" from "anon";

revoke trigger on table "public"."deadtrees_logs" from "anon";

revoke truncate on table "public"."deadtrees_logs" from "anon";

revoke update on table "public"."deadtrees_logs" from "anon";

revoke delete on table "public"."deadtrees_logs" from "authenticated";

revoke insert on table "public"."deadtrees_logs" from "authenticated";

revoke references on table "public"."deadtrees_logs" from "authenticated";

revoke select on table "public"."deadtrees_logs" from "authenticated";

revoke trigger on table "public"."deadtrees_logs" from "authenticated";

revoke truncate on table "public"."deadtrees_logs" from "authenticated";

revoke update on table "public"."deadtrees_logs" from "authenticated";

revoke delete on table "public"."deadtrees_logs" from "service_role";

revoke insert on table "public"."deadtrees_logs" from "service_role";

revoke references on table "public"."deadtrees_logs" from "service_role";

revoke select on table "public"."deadtrees_logs" from "service_role";

revoke trigger on table "public"."deadtrees_logs" from "service_role";

revoke truncate on table "public"."deadtrees_logs" from "service_role";

revoke update on table "public"."deadtrees_logs" from "service_role";

alter table "public"."database_stats" drop constraint "database_stats_pkey";

alter table "public"."deadtrees_logs" drop constraint "deadtrees_logs_pkey";

drop index if exists "public"."database_stats_pkey";

drop index if exists "public"."deadtrees_logs_pkey";

drop table "public"."database_stats";

drop table "public"."deadtrees_logs";

alter table "public"."dataset_audit" add column "has_major_issue" boolean;

alter table "public"."v2_statuses" add column "is_in_audit" boolean;

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.can_audit()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT EXISTS (
    SELECT 1 
    FROM privileged_users 
    WHERE user_id = auth.uid() 
    AND can_audit = true
  );
$function$
;

create or replace view "public"."dataset_audit_user_info" as  SELECT da.dataset_id,
    da.audit_date,
    da.is_georeferenced,
    da.has_valid_acquisition_date,
    da.acquisition_date_notes,
    da.has_valid_phenology,
    da.phenology_notes,
    da.deadwood_quality,
    da.deadwood_notes,
    da.forest_cover_quality,
    da.forest_cover_notes,
    da.aoi_done,
    da.has_cog_issue,
    da.cog_issue_notes,
    da.has_thumbnail_issue,
    da.thumbnail_issue_notes,
    da.audited_by,
    da.notes,
    da.has_major_issue,
    au.email AS audited_by_email,
    uu.email AS uploaded_by_email
   FROM (((dataset_audit da
     LEFT JOIN auth.users au ON ((da.audited_by = au.id)))
     LEFT JOIN v2_datasets d ON ((da.dataset_id = d.id)))
     LEFT JOIN auth.users uu ON ((d.user_id = uu.id)));


create policy "Enable update for processor"
on "public"."v2_statuses"
as permissive
for update
to public
using ((((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text) OR can_audit()))
with check ((((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text) OR can_audit()));



