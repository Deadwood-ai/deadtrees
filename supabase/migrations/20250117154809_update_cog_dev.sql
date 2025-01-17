alter table "public"."dev_cogs" add column "info" json;

alter table "public"."dev_cogs" alter column "resolution" drop not null;


