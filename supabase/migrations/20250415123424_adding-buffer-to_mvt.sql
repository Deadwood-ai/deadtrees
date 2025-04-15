set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.get_deadwood_vector_tiles(z integer, x integer, y integer, filter_label_id integer DEFAULT NULL::integer, resolution integer DEFAULT 4096)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$DECLARE
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
                    512,             -- buffer (adjust if necessary)
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
      ) AS tile_data;

    RETURN encode(mvt, 'base64');
END;$function$
;


