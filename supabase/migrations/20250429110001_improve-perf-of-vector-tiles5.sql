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
    
    -- Dynamic simplification tolerance based on zoom level (in degrees for SRID 4326)
    tolerance := CASE 
        WHEN z < 8 THEN 0.01    -- ~1km at equator
        WHEN z < 10 THEN 0.005  -- ~500m at equator
        WHEN z < 12 THEN 0.001  -- ~100m at equator
        WHEN z < 14 THEN 0.0001 -- ~10m at equator
        ELSE 0.0
    END;
    
    -- Minimum area threshold based on zoom level
    -- For SRID 4326, using ST_Area with geography type gives area in square meters
    min_area := CASE
        WHEN z < 8 THEN 100000   -- 100,000 sq meters (10 hectares)
        WHEN z < 10 THEN 10000   -- 10,000 sq meters (1 hectare)
        WHEN z < 12 THEN 1000    -- 1,000 sq meters
        WHEN z < 14 THEN 100     -- 100 sq meters
        ELSE 0                   -- Include all geometries at high zoom
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
            -- Filter by geometry area in square meters using geography type cast
            AND (z >= 14 OR ST_Area(geography(geometry)) >= min_area)
      ) AS tile_data
      WHERE tile_data.geom IS NOT NULL;

    RETURN encode(mvt, 'base64');
END;$function$
;


