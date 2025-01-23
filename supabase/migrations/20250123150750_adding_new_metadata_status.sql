alter table "public"."v2_statuses" alter column "current_status" drop default;

alter type "public"."v2_status" rename to "v2_status__old_version_to_be_dropped";

create type "public"."v2_status" as enum ('idle', 'uploading', 'ortho_processing', 'cog_processing', 'thumbnail_processing', 'deadwood_segmentation', 'forest_cover_segmentation', 'audit_in_progress', 'metadata_processing');

alter table "public"."v2_statuses" alter column current_status type "public"."v2_status" using current_status::text::"public"."v2_status";

alter table "public"."v2_statuses" alter column "current_status" set default 'idle'::v2_status;

drop type "public"."v2_status__old_version_to_be_dropped";

alter table "public"."v2_orthos" drop column "ortho_processing";

alter table "public"."v2_statuses" add column "is_metadata_done" boolean not null default false;


