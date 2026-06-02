alter table "public"."map_flags"
  add column "model_version" text default 'v1';

update "public"."map_flags"
  set "model_version" = 'v1'
  where "model_version" is null;
