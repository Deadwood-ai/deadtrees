alter table "public"."priwa_kaeferbaeume"
add column "gruene_nadeln_am_boden" text not null default 'nein';

alter table "public"."priwa_kaeferbaeume"
add constraint "priwa_kaeferbaeume_gruene_nadeln_am_boden_check"
check ("gruene_nadeln_am_boden" in ('ja', 'nein')) not valid;

alter table "public"."priwa_kaeferbaeume"
validate constraint "priwa_kaeferbaeume_gruene_nadeln_am_boden_check";
