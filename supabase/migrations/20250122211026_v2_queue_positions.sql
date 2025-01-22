drop policy "Enable insert for authenticated users only" on "public"."v2_queue_positions";

drop policy "Enable read access for all users" on "public"."v2_queue_positions";

drop policy "Enable update for processor" on "public"."v2_queue_positions";

revoke delete on table "public"."v2_queue_positions" from "anon";

revoke insert on table "public"."v2_queue_positions" from "anon";

revoke references on table "public"."v2_queue_positions" from "anon";

revoke select on table "public"."v2_queue_positions" from "anon";

revoke trigger on table "public"."v2_queue_positions" from "anon";

revoke truncate on table "public"."v2_queue_positions" from "anon";

revoke update on table "public"."v2_queue_positions" from "anon";

revoke delete on table "public"."v2_queue_positions" from "authenticated";

revoke insert on table "public"."v2_queue_positions" from "authenticated";

revoke references on table "public"."v2_queue_positions" from "authenticated";

revoke select on table "public"."v2_queue_positions" from "authenticated";

revoke trigger on table "public"."v2_queue_positions" from "authenticated";

revoke truncate on table "public"."v2_queue_positions" from "authenticated";

revoke update on table "public"."v2_queue_positions" from "authenticated";

revoke delete on table "public"."v2_queue_positions" from "service_role";

revoke insert on table "public"."v2_queue_positions" from "service_role";

revoke references on table "public"."v2_queue_positions" from "service_role";

revoke select on table "public"."v2_queue_positions" from "service_role";

revoke trigger on table "public"."v2_queue_positions" from "service_role";

revoke truncate on table "public"."v2_queue_positions" from "service_role";

revoke update on table "public"."v2_queue_positions" from "service_role";

alter table "public"."v2_queue_positions" drop constraint "v2_queue_positions_id_fkey";

alter table "public"."v2_queue_positions" drop constraint "v2_queue_positions_pkey";

drop index if exists "public"."v2_queue_positions_pkey";

drop table "public"."v2_queue_positions";

create or replace view "public"."v2_queue_positions" as  WITH positions AS (
         SELECT row_number() OVER (ORDER BY v2_queue.priority DESC, v2_queue.created_at) AS current_position,
            v2_queue.id,
            v2_queue.dataset_id,
            v2_queue.user_id,
            v2_queue.build_args,
            v2_queue.created_at,
            v2_queue.is_processing,
            v2_queue.priority,
            v2_queue.task_types
           FROM v2_queue
          WHERE (NOT v2_queue.is_processing)
          ORDER BY v2_queue.priority DESC, v2_queue.created_at
        ), avg_time AS (
         SELECT avg(dev_cogs.runtime) AS avg
           FROM dev_cogs
        )
 SELECT (avg_time.avg * (positions.current_position)::double precision) AS estimated_time,
    positions.current_position,
    positions.id,
    positions.dataset_id,
    positions.user_id,
    positions.build_args,
    positions.created_at,
    positions.is_processing,
    positions.priority,
    positions.task_types,
    avg_time.avg
   FROM positions,
    avg_time;



