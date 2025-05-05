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
BEGIN
    bbox := ST_TileEnvelope(z, x, y);

    -- Dynamic simplification tolerance
    tolerance := CASE 
        WHEN z < 8 THEN 200.0
        WHEN z < 10 THEN 100.0
        WHEN z < 12 THEN 50.0
        WHEN z < 14 THEN 10.0
        ELSE 0.0
    END;

    -- Minimum area in square meters (since we use 3857 for area calculation)
    min_area := CASE
        WHEN z < 8 THEN 10000    -- 1 hectare
        WHEN z < 10 THEN 1000    -- 0.1 hectare
        WHEN z < 12 THEN 100     -- 100 m²
        WHEN z < 14 THEN 10      -- 10 m²
        ELSE 0
    END;

    SELECT ST_AsMVT(tile_data, 'deadwood', resolution)
      INTO mvt
      FROM (
            SELECT 
                ST_AsMVTGeom(
                    ST_Transform(
                        CASE WHEN tolerance > 0 
                            THEN ST_Simplify(geometry, tolerance, true) 
                            ELSE geometry 
                        END,
                        3857
                    ),
                    bbox,
                    resolution,
                    256,
                    true
                ) AS geom,
                id,
                label_id,
                properties
            FROM public.v2_deadwood_geometries
            WHERE (filter_label_id IS NULL OR label_id = filter_label_id)
            AND ST_Intersects(
                geometry, 
                ST_Transform(bbox, ST_SRID(geometry))
            )
            -- Filter by area in square meters (after transforming to 3857)
            AND (z >= 14 OR ST_Area(ST_Transform(geometry, 3857)) >= min_area)
      ) AS tile_data
      WHERE tile_data.geom IS NOT NULL;

    RETURN encode(mvt, 'base64');
END;$function$
;


