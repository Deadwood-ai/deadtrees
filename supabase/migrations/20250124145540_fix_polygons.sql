alter table "public"."v2_deadwood_geometries" alter column "geometry" set data type geometry(Polygon,4326) using "geometry"::geometry(Polygon,4326);

alter table "public"."v2_forest_cover_geometries" alter column "geometry" set data type geometry(Polygon,4326) using "geometry"::geometry(Polygon,4326);


