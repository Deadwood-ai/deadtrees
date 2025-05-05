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
    -- Use the default 256-tile envelope
    bbox := ST_TileEnvelope(z, x, y);
    
    -- Dynamic simplification tolerance based on zoom level
    -- For SRID 4326, these values represent degrees
    tolerance := CASE 
        WHEN z < 8 THEN 0.01    -- ~1km at equator
        WHEN z < 10 THEN 0.005  -- ~500m at equator
        WHEN z < 12 THEN 0.001  -- ~100m at equator
        WHEN z < 14 THEN 0.0002 -- ~20m at equator
        ELSE 0.0
    END;
    
    -- Minimum area threshold based on zoom level
    -- For SRID 4326, areas are in square degrees
    -- Approximate equivalents: 0.0001 sq deg ≈ 1 sq km at equator
    min_area := CASE
        WHEN z < 8 THEN 0.0001     -- ~1 sq km
        WHEN z < 10 THEN 0.00001   -- ~0.1 sq km
        WHEN z < 12 THEN 0.000001  -- ~0.01 sq km
        WHEN z < 14 THEN 0.0000001 -- ~0.001 sq km
        ELSE 0                     -- Include all geometries at high zoom
    END;
    
    SELECT ST_AsMVT(tile_data, 'deadwood', resolution)
      INTO mvt
      FROM (
            SELECT 
                ST_AsMVTGeom(
                    ST_Transform(
                        -- Apply simplification before transformation
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
            -- Filter by geometry area with appropriate thresholds for SRID 4326
            AND (z >= 14 OR ST_Area(geometry) >= min_area)
      ) AS tile_data
      WHERE tile_data.geom IS NOT NULL;

    RETURN encode(mvt, 'base64');
END;$function$
;


