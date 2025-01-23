alter table "public"."v2_cogs" drop column "file_size";

alter table "public"."v2_cogs" add column "cog_file_size" bigint not null;

alter table "public"."v2_thumbnails" drop column "file_size";

alter table "public"."v2_thumbnails" add column "thumbnail_file_size" bigint not null;


