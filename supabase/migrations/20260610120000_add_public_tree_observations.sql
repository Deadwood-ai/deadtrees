create table if not exists "public"."public_tree_observations" (
  "id" uuid primary key default gen_random_uuid(),
  "geom" geometry(Point, 4326) not null,
  "condition" text not null,
  "tree_type_group" text not null,
  "tree_type_text" text,
  "comment" text,
  "client_id" text,
  "created_at" timestamptz not null default now(),
  constraint "public_tree_observations_condition_check"
    check ("condition" in ('alive', 'declining', 'dead', 'not_sure')),
  constraint "public_tree_observations_tree_type_group_check"
    check ("tree_type_group" in ('conifer', 'broadleaf', 'palm_or_other', 'not_sure')),
  constraint "public_tree_observations_tree_type_text_length_check"
    check ("tree_type_text" is null or char_length("tree_type_text") <= 80),
  constraint "public_tree_observations_comment_length_check"
    check ("comment" is null or char_length("comment") <= 200),
  constraint "public_tree_observations_client_id_length_check"
    check ("client_id" is null or char_length("client_id") <= 64),
  constraint "public_tree_observations_geom_point_check"
    check (
      ST_SRID("geom") = 4326
      and GeometryType("geom") = 'POINT'
      and ST_X("geom") between -180 and 180
      and ST_Y("geom") between -90 and 90
    )
);

create index if not exists "public_tree_observations_geom_idx"
  on "public"."public_tree_observations"
  using gist ("geom");

create index if not exists "public_tree_observations_created_at_idx"
  on "public"."public_tree_observations" ("created_at" desc);

alter table "public"."public_tree_observations" enable row level security;

revoke all on table "public"."public_tree_observations" from anon, authenticated;

grant select (
  "id",
  "geom",
  "condition",
  "tree_type_group",
  "tree_type_text",
  "comment",
  "created_at"
) on table "public"."public_tree_observations" to anon, authenticated;
grant insert ("geom", "condition", "tree_type_group", "tree_type_text", "comment", "client_id")
  on table "public"."public_tree_observations"
  to anon, authenticated;

drop policy if exists "Anyone can read public tree observations"
  on "public"."public_tree_observations";
create policy "Anyone can read public tree observations"
  on "public"."public_tree_observations"
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Anonymous users can add constrained public tree observations"
  on "public"."public_tree_observations";
create policy "Anonymous users can add constrained public tree observations"
  on "public"."public_tree_observations"
  for insert
  to anon, authenticated
  with check (
    "condition" in ('alive', 'declining', 'dead', 'not_sure')
    and "tree_type_group" in ('conifer', 'broadleaf', 'palm_or_other', 'not_sure')
    and ("tree_type_text" is null or char_length("tree_type_text") <= 80)
    and ("comment" is null or char_length("comment") <= 200)
    and ("client_id" is null or char_length("client_id") <= 64)
    and ST_SRID("geom") = 4326
    and GeometryType("geom") = 'POINT'
    and ST_X("geom") between -180 and 180
    and ST_Y("geom") between -90 and 90
  );

comment on table "public"."public_tree_observations" is
  'Anonymous public field observations shown as unverified public contributions on the DeadTrees map. Disable insert policy to close submissions.';
