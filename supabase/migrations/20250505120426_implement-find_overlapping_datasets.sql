set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.find_overlapping_datasets(input_dataset_id integer, overlap_threshold double precision DEFAULT 0.5)
 RETURNS TABLE(dataset_id integer, overlap_ratio double precision)
 LANGUAGE sql
AS $function$
  WITH input_data AS (
    SELECT 
      dataset_id,
      bbox,
      ST_Area(ST_SetSRID(bbox::geometry, 4326)) AS input_area
    FROM 
      v2_orthos
    WHERE 
      dataset_id = input_dataset_id
  ),
  intersections AS (
    SELECT 
      o.dataset_id,
      o.bbox,
      ST_Area(ST_SetSRID(ST_Intersection(i.bbox::geometry, o.bbox::geometry), 4326)) AS intersection_area,
      ST_Area(ST_SetSRID(o.bbox::geometry, 4326)) AS other_area,
      i.input_area
    FROM 
      v2_orthos o
    CROSS JOIN
      input_data i
    WHERE 
      o.dataset_id != i.dataset_id
      AND o.bbox IS NOT NULL
      AND ST_Intersects(i.bbox::geometry, o.bbox::geometry)
  )
  SELECT 
    i.dataset_id,
    ROUND(
      LEAST(
        i.intersection_area / i.input_area,
        i.intersection_area / i.other_area
      )::numeric, 
      4
    ) AS overlap_ratio
  FROM 
    intersections i
  WHERE
    (i.intersection_area / i.input_area) >= overlap_threshold
    AND (i.intersection_area / i.other_area) >= overlap_threshold
  ORDER BY
    overlap_ratio DESC;
$function$
;


