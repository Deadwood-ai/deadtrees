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
BEGIN
    -- Use the default 256-tile envelope
    bbox := ST_TileEnvelope(z, x, y);
    
    -- Calculate simplification tolerance based on zoom level
    -- More aggressive simplification at lower zoom levels
    tolerance := CASE 
        WHEN z < 10 THEN 100.0
        WHEN z < 12 THEN 50.0
        WHEN z < 14 THEN 10.0
        WHEN z < 16 THEN 1.0
        ELSE 0.0
    END;
    
    SELECT ST_AsMVT(tile_data, 'deadwood', resolution)
      INTO mvt
      FROM (
            SELECT 
                ST_AsMVTGeom(
                    -- Apply simplification before transformation to reduce computation
                    ST_Transform(
                        CASE 
                            WHEN tolerance > 0 THEN ST_Simplify(geometry, tolerance, true)
                            ELSE geometry
                        END,
                        3857
                    ),
                    bbox,
                    resolution,
                    256,  -- Reduced buffer size for better performance
                    true
                ) AS geom,
                id,
                label_id,
                properties
            FROM public.v2_deadwood_geometries
            WHERE (filter_label_id IS NULL OR public.v2_deadwood_geometries.label_id = filter_label_id)
            AND ST_Intersects(
                geometry, 
                ST_Transform(bbox, ST_SRID(geometry))
            )
            -- Add a limit for extremely low zoom levels to prevent timeout
            LIMIT CASE 
                WHEN z < 8 THEN 1000
                WHEN z < 10 THEN 5000
                ELSE 100000
            END
      ) AS tile_data
      WHERE tile_data.geom IS NOT NULL; -- Filter out NULL geometries

    RETURN encode(mvt, 'base64');
END;$function$
;


