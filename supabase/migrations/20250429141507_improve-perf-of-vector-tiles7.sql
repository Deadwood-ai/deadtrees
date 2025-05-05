set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.get_deadwood_vector_tiles_perf1(z integer, x integer, y integer, filter_label_id integer, resolution integer DEFAULT 4096)
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
            CASE WHEN z < 8 THEN 100.0
                 WHEN z < 10 THEN 50.0
                 WHEN z < 12 THEN 10.0
                 WHEN z < 14 THEN 2.0
                 ELSE 0.0 END AS tolerance,
            CASE WHEN z < 8 THEN 100000
                 WHEN z < 10 THEN 10000
                 WHEN z < 12 THEN 1000
                 WHEN z < 14 THEN 100
                 ELSE 0 END AS min_area
    )
    SELECT ST_AsMVT(tile_data, 'deadwood', resolution)
    INTO mvt
    FROM (
        SELECT
            ST_AsMVTGeom(
                ST_Transform(
                    CASE
                        WHEN s.tolerance > 0 THEN ST_Simplify(g.geometry, s.tolerance, true)
                        ELSE g.geometry
                    END,
                    3857
                ),
                b.bbox_3857,
                resolution,
                256,
                true
            ) AS geom,
            g.id,
            g.label_id,
            g.properties
        FROM
            public.v2_deadwood_geometries g,
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
        ORDER BY g.area_m2 DESC
        LIMIT 100000
    ) AS tile_data
    WHERE tile_data.geom IS NOT NULL;

    RETURN encode(mvt, 'base64');
END;
$function$
;


