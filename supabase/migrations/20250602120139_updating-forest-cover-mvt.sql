alter table "public"."v2_forest_cover_geometries" add column "area_m2" double precision;

CREATE INDEX idx_forest_cover_area_m2 ON public.v2_forest_cover_geometries USING btree (area_m2);

CREATE INDEX idx_forest_cover_label_id ON public.v2_forest_cover_geometries USING btree (label_id);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.get_forest_cover_vector_tiles_perf(z integer, x integer, y integer, filter_label_id integer, resolution integer DEFAULT 4096)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    mvt bytea;
BEGIN
    WITH
    bbox AS (
        SELECT ST_TileEnvelope(z, x, y) AS bbox_3857
    ),
    settings AS (
        SELECT
            -- Adjusted min_area thresholds for larger forest cover polygons
            CASE WHEN z < 6 THEN 1000000   -- 100 hectares for very low zoom
                 WHEN z < 8 THEN 500000    -- 50 hectares
                 WHEN z < 10 THEN 100000   -- 10 hectares  
                 WHEN z < 12 THEN 50000    -- 5 hectares
                 WHEN z < 14 THEN 10000    -- 1 hectare
                 ELSE 0 END AS min_area
    )
    SELECT ST_AsMVT(tile_data, 'forest_cover', resolution)
    INTO mvt
    FROM (
        SELECT
            ST_AsMVTGeom(
                ST_Transform(
                    g.geometry,
                    3857
                ),
                b.bbox_3857,
                resolution,
                128,  -- Smaller buffer for larger forest polygons
                true
            ) AS geom,
            g.id,
            g.label_id,
            g.properties
        FROM
            public.v2_forest_cover_geometries g,
            bbox b,
            settings s
        WHERE
            g.label_id = filter_label_id
            AND g.area_m2 >= s.min_area
            AND g.geometry && ST_Transform(b.bbox_3857, ST_SRID(g.geometry))
            AND ST_Intersects(
                g.geometry,
                ST_Transform(b.bbox_3857, ST_SRID(g.geometry))
            )
        LIMIT 50000  -- Lower limit since forest polygons are larger
    ) AS tile_data
    WHERE tile_data.geom IS NOT NULL;

    RETURN encode(mvt, 'base64');
END;
$function$
;

CREATE TRIGGER trg_forest_cover_update_area_m2 BEFORE INSERT OR UPDATE OF geometry ON public.v2_forest_cover_geometries FOR EACH ROW EXECUTE FUNCTION update_area_m2();


