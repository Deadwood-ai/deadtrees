set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.get_deadwood_vector_tiles(z integer, x integer, y integer, label_id integer DEFAULT NULL, resolution integer DEFAULT 4096)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    bbox geometry;
    mvt bytea;
BEGIN
    -- Use the default 256-tile envelope (no scaling, but now we'll generate coordinates in a 4096 grid)
    bbox := ST_TileEnvelope(z, x, y);

    SELECT ST_AsMVT(tile_data, 'deadwood', resolution)
      INTO mvt
      FROM (
            SELECT 
                ST_AsMVTGeom(
                    ST_Transform(geometry, 3857),
                    bbox,
                    resolution,    -- now using 4096
                    0,             -- buffer (adjust if necessary)
                    true
                ) AS geom,
                id,
                label_id,
                properties
            FROM public.v2_deadwood_geometries
            WHERE (label_id IS NULL OR public.v2_deadwood_geometries.label_id = label_id)
            AND ST_Intersects(
                geometry, 
                ST_Transform(bbox, ST_SRID(geometry))
            )
      ) AS tile_data;

    RETURN encode(mvt, 'base64');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_deadwood_vector_tiles_debug(z integer, x integer, y integer, resolution integer DEFAULT 4096)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE
    bbox geometry;
    mvt bytea;
    feature_count integer;
    debug_info json;
BEGIN
    -- Log input parameters
    RAISE NOTICE 'Input: z=%, x=%, y=%, resolution=%', z, x, y, resolution;
    
    -- Compute the tile envelope
    bbox := ST_TileEnvelope(z, x, y);
    RAISE NOTICE 'Computed bbox: %', ST_AsText(bbox);
    
    -- Count features intersecting the (transformed) bbox
    SELECT count(*) INTO feature_count
    FROM public.v2_deadwood_geometries
    WHERE ST_Intersects(
            geometry,
            ST_Transform(bbox, ST_SRID(geometry))
          );
    RAISE NOTICE 'Feature count: %', feature_count;
    
    -- Generate the MVT tile
    SELECT ST_AsMVT(tile_data, 'deadwood', resolution)
      INTO mvt
      FROM (
            SELECT 
                ST_AsMVTGeom(
                    ST_Transform(geometry, 3857),
                    bbox,
                    resolution,
                    0,
                    true
                ) AS geom,
                id,
                label_id,
                properties
            FROM public.v2_deadwood_geometries
            WHERE ST_Intersects(
                    geometry, 
                    ST_Transform(bbox, ST_SRID(geometry))
                  )
      ) AS tile_data;
    
    IF mvt IS NULL THEN
      RAISE NOTICE 'MVT tile is NULL.';
    ELSE
      RAISE NOTICE 'MVT tile generated, length: % bytes', octet_length(mvt);
    END IF;
    
    -- Build and return debug information as JSON
    debug_info := json_build_object(
      'z', z,
      'x', x,
      'y', y,
      'resolution', resolution,
      'bbox', ST_AsText(bbox),
      'feature_count', feature_count,
      'mvt_generated', CASE WHEN mvt IS NOT NULL THEN true ELSE false END,
      'mvt_length', CASE WHEN mvt IS NOT NULL THEN octet_length(mvt) ELSE 0 END,
      'mvt_base64', CASE WHEN mvt IS NOT NULL THEN encode(mvt, 'base64') ELSE '' END
    );
    
    RETURN debug_info;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_deadwood_vector_tiles_debug_extended(z integer, x integer, y integer, resolution integer DEFAULT 4096)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE
    bbox geometry;
    bbox_transformed geometry;
    mvt bytea;
    feature_count integer;
    overall_extent geometry;
    data_srid integer;
    debug_info json;
    bbox_area numeric;
BEGIN
    -- Log input parameters
    RAISE NOTICE 'Input: z=%, x=%, y=%, resolution=%', z, x, y, resolution;
    
    -- Compute the tile envelope (always in EPSG:3857)
    bbox := ST_TileEnvelope(z, x, y);
    
    -- Get the SRID from the table (assumes all geometries use the same SRID)
    SELECT ST_SRID(geometry)
      INTO data_srid
      FROM public.v2_deadwood_geometries
      LIMIT 1;
      
    IF data_srid IS NULL THEN
      RAISE NOTICE 'No SRID found in table v2_deadwood_geometries';
      data_srid := 3857; -- fallback
    END IF;
    
    -- Transform the bbox to the data SRID
    bbox_transformed := ST_Transform(bbox, data_srid);
    
    -- Compute the area of the bbox (for reference)
    bbox_area := ST_Area(bbox);
    
    -- Get overall data extent for context
    SELECT ST_Extent(geometry)::geometry
      INTO overall_extent
      FROM public.v2_deadwood_geometries;
    
    -- Count features intersecting the transformed bbox
    SELECT count(*) INTO feature_count
    FROM public.v2_deadwood_geometries
    WHERE ST_Intersects(geometry, bbox_transformed);
    
    -- Generate the MVT tile using the standard process
    SELECT ST_AsMVT(tile_data, 'deadwood', resolution)
      INTO mvt
      FROM (
            SELECT 
                ST_AsMVTGeom(
                    ST_Transform(geometry, 3857),
                    bbox,
                    resolution,
                    0,
                    true
                ) AS geom,
                id,
                label_id,
                properties
            FROM public.v2_deadwood_geometries
            WHERE ST_Intersects(
                    geometry, 
                    ST_Transform(bbox, ST_SRID(geometry))
                  )
      ) AS tile_data;
    
    -- Build debug JSON object
    debug_info := json_build_object(
      'z', z,
      'x', x,
      'y', y,
      'resolution', resolution,
      'bbox_epsg3857', ST_AsText(bbox),
      'bbox_area', bbox_area,
      'data_srid', data_srid,
      'bbox_transformed', ST_AsText(bbox_transformed),
      'overall_extent', ST_AsText(overall_extent),
      'feature_count', feature_count,
      'mvt_generated', CASE WHEN mvt IS NOT NULL THEN true ELSE false END,
      'mvt_length', CASE WHEN mvt IS NOT NULL THEN octet_length(mvt) ELSE 0 END,
      'mvt_base64', CASE WHEN mvt IS NOT NULL THEN encode(mvt, 'base64') ELSE '' END
    );
    
    RETURN debug_info;
END;
$function$
;


