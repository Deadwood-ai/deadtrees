drop function if exists "public"."get_clipped_geometries_batch"(p_label_id bigint, p_geometry_table text, p_bbox_minx double precision, p_bbox_miny double precision, p_bbox_maxx double precision, p_bbox_maxy double precision, p_buffer_m double precision, p_limit integer, p_offset integer);

drop function if exists "public"."get_clipped_geometries_batch"(p_label_id bigint, p_geometry_table text, p_bbox_minx double precision, p_bbox_miny double precision, p_bbox_maxx double precision, p_bbox_maxy double precision, p_utm_zone text, p_buffer_m double precision, p_limit integer, p_offset integer);

drop function if exists "public"."get_clipped_geometries_batch"(p_label_id bigint, p_geometry_table text, p_bbox_minx double precision, p_bbox_miny double precision, p_bbox_maxx double precision, p_bbox_maxy double precision, p_epsg_code integer, p_buffer_m double precision, p_limit integer, p_offset integer);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.get_clipped_geometries_batch(p_label_id bigint, p_geometry_table text, p_bbox_minx double precision, p_bbox_miny double precision, p_bbox_maxx double precision, p_bbox_maxy double precision, p_epsg_code integer, p_buffer_m double precision DEFAULT 2.0, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(geometry jsonb, total_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  bbox_geom GEOMETRY;
  bbox_box2d BOX2D;
  total_intersecting bigint;
BEGIN
  -- Create bbox geometry in UTM with buffer using provided EPSG code
  bbox_geom := ST_Transform(
    ST_MakeEnvelope(
      p_bbox_minx - p_buffer_m,
      p_bbox_miny - p_buffer_m,
      p_bbox_maxx + p_buffer_m,
      p_bbox_maxy + p_buffer_m,
      p_epsg_code
    ),
    4326
  );

  -- Create BOX2D for faster clipping
  bbox_box2d := bbox_geom::box2d;

  -- Get total count (only on first batch)
  IF p_offset = 0 THEN
    EXECUTE format(
      'SELECT COUNT(*) FROM %I
       WHERE label_id = $1
       AND geometry && $2
       AND ST_Intersects(geometry, $2)',
      p_geometry_table
    ) INTO total_intersecting USING p_label_id, bbox_geom;
  ELSE
    total_intersecting := 0;
  END IF;

  -- KEY FIX: Only validate invalid geometries, leave valid ones untouched
  RETURN QUERY EXECUTE format(
    'SELECT
      ST_AsGeoJSON(
        CASE
          WHEN ST_GeometryType(clipped_geom) = ''ST_GeometryCollection''
          THEN ST_CollectionExtract(clipped_geom, 3)
          ELSE clipped_geom
        END
      )::jsonb as geometry,
      $5 as total_count
    FROM (
      SELECT
        ST_ClipByBox2D(
          CASE 
            WHEN ST_IsValid(geometry) THEN geometry
            ELSE ST_MakeValid(geometry)
          END,
          $4
        ) as clipped_geom
      FROM %I
      WHERE label_id = $1
      AND geometry && $2  -- Spatial index (fast!)
      AND ST_Intersects(geometry, $2)  -- Precise intersection on raw geometry
      ORDER BY id
      LIMIT $6
      OFFSET $7
    ) sub
    WHERE NOT ST_IsEmpty(clipped_geom)
    AND ST_GeometryType(clipped_geom) IN (''ST_Polygon'', ''ST_MultiPolygon'', ''ST_GeometryCollection'')',
    p_geometry_table
  ) USING
    p_label_id,
    bbox_geom,
    bbox_geom,
    bbox_box2d,
    total_intersecting,
    p_limit,
    p_offset;
END;
$function$
;


