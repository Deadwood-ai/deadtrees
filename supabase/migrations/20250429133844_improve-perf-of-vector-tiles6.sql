set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.get_deadwood_vector_tiles_perf(z integer, x integer, y integer, filter_label_id integer DEFAULT NULL::integer, resolution integer DEFAULT 4096)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    bbox geometry;
    mvt bytea;
    tolerance float;
    min_area float;
    row_limit integer;
BEGIN
    -- Compute the tile envelope in 3857
    bbox := ST_TileEnvelope(z, x, y);

    -- Set simplification tolerance and area threshold based on zoom
    tolerance := CASE
        WHEN z < 8 THEN 100.0
        WHEN z < 10 THEN 50.0
        WHEN z < 12 THEN 10.0
        WHEN z < 14 THEN 2.0
        ELSE 0.0
    END;

    min_area := CASE
        WHEN z < 8 THEN 100000   -- 100,000 m²
        WHEN z < 10 THEN 10000   -- 10,000 m²
        WHEN z < 12 THEN 1000    -- 1,000 m²
        WHEN z < 14 THEN 100     -- 100 m²
        ELSE 0
    END;

    row_limit := CASE
        WHEN z < 8 THEN 1000
        WHEN z < 10 THEN 5000
        ELSE 100000
    END;

    SELECT ST_AsMVT(tile_data, 'deadwood', resolution)
    INTO mvt
    FROM (
        SELECT
            ST_AsMVTGeom(
                ST_Transform(
                    CASE
                        WHEN tolerance > 0 THEN ST_Simplify(geometry, tolerance, true)
                        ELSE geometry
                    END,
                    3857
                ),
                bbox,
                resolution,
                256,  -- buffer
                true
            ) AS geom,
            id,
            label_id,
            properties
        FROM public.v2_deadwood_geometries
        WHERE (filter_label_id IS NULL OR label_id = filter_label_id)
          AND area_m2 >= min_area
          AND ST_Intersects(
                geometry,
                ST_Transform(bbox, ST_SRID(geometry))
              )
        ORDER BY area_m2 DESC
        LIMIT row_limit
    ) AS tile_data
    WHERE tile_data.geom IS NOT NULL;

    RETURN encode(mvt, 'base64');
END;
$function$
;


