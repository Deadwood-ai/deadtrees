drop function if exists "public"."copy_and_clip_reference_geometries"(p_patch_id bigint, p_dataset_id bigint, p_user_id uuid, p_buffer_meters double precision);

drop function if exists "public"."get_clipped_geometries_for_patch"(p_label_id bigint, p_geometry_table text, p_bbox_minx double precision, p_bbox_miny double precision, p_bbox_maxx double precision, p_bbox_maxy double precision, p_buffer_m double precision);

CREATE UNIQUE INDEX idx_labels_unique_reference_patch ON public.v2_labels USING btree (dataset_id, label_data, reference_patch_id) WHERE ((reference_patch_id IS NOT NULL) AND (is_active = true));

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.copy_predictions_to_reference_patch(p_patch_id bigint, p_dataset_id bigint, p_bbox_minx double precision, p_bbox_miny double precision, p_bbox_maxx double precision, p_bbox_maxy double precision)
 RETURNS TABLE(deadwood_count bigint, forest_cover_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  bbox_geom geometry;
  bbox_box2d box2d;
  ref_deadwood_label_id bigint;
  ref_forest_label_id bigint;
  model_deadwood_label_id bigint;
  model_forest_label_id bigint;
  dw_count bigint := 0;
  fc_count bigint := 0;
  current_user_id uuid;
BEGIN
  -- Get current user ID
  current_user_id := auth.uid();
  
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'User must be authenticated';
  END IF;

  -- Temporarily disable RLS for bulk insert performance
  SET LOCAL row_security = off;

  -- Create bbox with buffer
  bbox_geom := ST_Transform(
    ST_MakeEnvelope(
      p_bbox_minx - 2, p_bbox_miny - 2,
      p_bbox_maxx + 2, p_bbox_maxy + 2,
      3857
    ),
    4326
  );
  bbox_box2d := bbox_geom::box2d;
  
  -- Get model prediction labels
  SELECT id INTO model_deadwood_label_id
  FROM v2_labels
  WHERE dataset_id = p_dataset_id 
    AND label_data = 'deadwood'
    AND label_source = 'model_prediction';
    
  SELECT id INTO model_forest_label_id
  FROM v2_labels
  WHERE dataset_id = p_dataset_id 
    AND label_data = 'forest_cover'
    AND label_source = 'model_prediction';

  -- Get or create deadwood reference label
  SELECT id INTO ref_deadwood_label_id
  FROM v2_labels
  WHERE dataset_id = p_dataset_id
    AND label_data = 'deadwood'
    AND reference_patch_id = p_patch_id;
    
  IF ref_deadwood_label_id IS NULL THEN
    INSERT INTO v2_labels (
      dataset_id, 
      label_data, 
      label_source, 
      label_type,
      is_active, 
      reference_patch_id, 
      user_id
    )
    VALUES (
      p_dataset_id, 
      'deadwood', 
      'reference_patch', 
      'semantic_segmentation',
      true, 
      p_patch_id, 
      current_user_id
    )
    RETURNING id INTO ref_deadwood_label_id;
  ELSE
    UPDATE v2_labels 
    SET is_active = true, updated_at = now()
    WHERE id = ref_deadwood_label_id;
  END IF;
  
  -- Get or create forest cover reference label
  SELECT id INTO ref_forest_label_id
  FROM v2_labels
  WHERE dataset_id = p_dataset_id
    AND label_data = 'forest_cover'
    AND reference_patch_id = p_patch_id;
    
  IF ref_forest_label_id IS NULL THEN
    INSERT INTO v2_labels (
      dataset_id, 
      label_data, 
      label_source, 
      label_type,
      is_active, 
      reference_patch_id, 
      user_id
    )
    VALUES (
      p_dataset_id, 
      'forest_cover', 
      'reference_patch', 
      'semantic_segmentation',
      true, 
      p_patch_id, 
      current_user_id
    )
    RETURNING id INTO ref_forest_label_id;
  ELSE
    UPDATE v2_labels 
    SET is_active = true, updated_at = now()
    WHERE id = ref_forest_label_id;
  END IF;
  
  -- DEADWOOD: Bulk copy with optimization
  IF model_deadwood_label_id IS NOT NULL THEN
    INSERT INTO reference_patch_deadwood_geometries (label_id, patch_id, geometry, area_m2)
    SELECT 
      ref_deadwood_label_id,
      p_patch_id,
      ST_AsGeoJSON(clipped)::jsonb,
      ST_Area(ST_Transform(clipped, 3857))
    FROM (
      SELECT 
        ST_ClipByBox2D(
          ST_SimplifyPreserveTopology(
            CASE WHEN ST_IsValid(geometry) THEN geometry ELSE ST_MakeValid(geometry) END,
            0.02
          ),
          bbox_box2d
        ) as clipped
      FROM v2_deadwood_geometries
      WHERE label_id = model_deadwood_label_id
        AND ST_Intersects(geometry, bbox_geom)
    ) sub
    WHERE NOT ST_IsEmpty(clipped);
    
    GET DIAGNOSTICS dw_count = ROW_COUNT;
  END IF;
  
  -- FOREST COVER: Bulk copy with optimization
  IF model_forest_label_id IS NOT NULL THEN
    INSERT INTO reference_patch_forest_cover_geometries (label_id, patch_id, geometry, area_m2)
    SELECT 
      ref_forest_label_id,
      p_patch_id,
      ST_AsGeoJSON(clipped)::jsonb,
      ST_Area(ST_Transform(clipped, 3857))
    FROM (
      SELECT 
        ST_ClipByBox2D(
          ST_SimplifyPreserveTopology(
            CASE WHEN ST_IsValid(geometry) THEN geometry ELSE ST_MakeValid(geometry) END,
            0.02
          ),
          bbox_box2d
        ) as clipped
      FROM v2_forest_cover_geometries
      WHERE label_id = model_forest_label_id
        AND ST_Intersects(geometry, bbox_geom)
    ) sub
    WHERE NOT ST_IsEmpty(clipped);
    
    GET DIAGNOSTICS fc_count = ROW_COUNT;
  END IF;
  
  -- Update patch with reference label IDs
  UPDATE reference_patches
  SET 
    reference_deadwood_label_id = ref_deadwood_label_id,
    reference_forest_cover_label_id = ref_forest_label_id
  WHERE id = p_patch_id;
  
  RETURN QUERY SELECT dw_count, fc_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_clipped_geometries_batch(p_label_id bigint, p_geometry_table text, p_bbox_minx double precision, p_bbox_miny double precision, p_bbox_maxx double precision, p_bbox_maxy double precision, p_buffer_m double precision DEFAULT 2.0, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(geometry jsonb, total_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  bbox_geom GEOMETRY;
  bbox_box2d BOX2D;
  total_intersecting bigint;
BEGIN
  -- Create bbox geometry in EPSG:3857 with buffer
  bbox_geom := ST_MakeEnvelope(
    p_bbox_minx - p_buffer_m,
    p_bbox_miny - p_buffer_m,
    p_bbox_maxx + p_buffer_m,
    p_bbox_maxy + p_buffer_m,
    3857
  );

  -- Transform to EPSG:4326 for comparison
  bbox_geom := ST_Transform(bbox_geom, 4326);

  -- Create BOX2D for faster clipping
  bbox_box2d := bbox_geom::box2d;

  -- Get total count (only on first batch)
  IF p_offset = 0 THEN
    EXECUTE format(
      'SELECT COUNT(*) FROM %I
       WHERE label_id = $1
       AND ST_Intersects(geometry, $2)',
      p_geometry_table
    ) INTO total_intersecting USING p_label_id, bbox_geom;
  ELSE
    total_intersecting := 0; -- Don't recount on subsequent batches
  END IF;

  -- Process geometries with optimizations
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
        -- Use ST_ClipByBox2D for rectangular patches (3x faster)
        ST_ClipByBox2D(
          -- Only validate if invalid (conditional)
          CASE
            WHEN ST_IsValid(geometry) THEN geometry
            ELSE ST_MakeValid(geometry)
          END,
          $4
        ) as clipped_geom
      FROM %I
      WHERE label_id = $1
      AND ST_Intersects(geometry, $2)
      ORDER BY id  -- Stable ordering for pagination
      LIMIT $6
      OFFSET $7
    ) sub
    WHERE NOT ST_IsEmpty(clipped_geom)
    AND ST_GeometryType(clipped_geom) IN (''ST_Polygon'', ''ST_MultiPolygon'', ''ST_GeometryCollection'')',
    p_geometry_table
  ) USING
    p_label_id,           -- $1
    bbox_geom,            -- $2
    bbox_geom,            -- $3 (for ST_Intersects in subquery)
    bbox_box2d,           -- $4 (for ST_ClipByBox2D)
    total_intersecting,   -- $5
    p_limit,              -- $6
    p_offset;             -- $7
END;
$function$
;

CREATE OR REPLACE FUNCTION public.save_reference_geometries(p_patch_id bigint, p_dataset_id bigint, p_user_id uuid, p_layer_type text, p_geometries jsonb)
 RETURNS TABLE(label_id bigint, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_existing_label_id bigint;
  v_existing_version integer;
  v_existing_parent_id bigint;
  v_new_label_id bigint;
  v_new_version integer;
  v_table_name text;
  v_patch_column_name text;
  v_geometry jsonb;
  v_label_data "LabelData";  -- Explicitly typed as enum
BEGIN
  -- Cast text to LabelData enum
  v_label_data := p_layer_type::"LabelData";

  -- Determine table name based on layer type
  IF p_layer_type = 'deadwood' THEN
    v_table_name := 'reference_patch_deadwood_geometries';
    v_patch_column_name := 'reference_deadwood_label_id';
  ELSE
    v_table_name := 'reference_patch_forest_cover_geometries';
    v_patch_column_name := 'reference_forest_cover_label_id';
  END IF;

  -- Lock the patch row to prevent concurrent updates
  PERFORM rp.id FROM reference_patches rp WHERE rp.id = p_patch_id FOR UPDATE;

  -- Find existing active label with explicit column references
  SELECT 
    lbl.id,
    lbl.version,
    lbl.parent_label_id
  INTO 
    v_existing_label_id,
    v_existing_version,
    v_existing_parent_id
  FROM v2_labels lbl
  WHERE lbl.reference_patch_id = p_patch_id
    AND lbl.label_data = v_label_data  -- Use enum variable
    AND lbl.is_active = true
  FOR UPDATE;

  IF FOUND THEN
    -- Deactivate existing label
    UPDATE v2_labels
    SET is_active = false
    WHERE id = v_existing_label_id;

    -- Create new version
    v_new_version := v_existing_version + 1;
    
    INSERT INTO v2_labels (
      dataset_id,
      user_id,
      label_data,
      label_type,
      label_source,
      reference_patch_id,
      version,
      parent_label_id,
      is_active
    ) VALUES (
      p_dataset_id,
      p_user_id,
      v_label_data,  -- Use enum variable
      'semantic_segmentation',
      'reference_patch',
      p_patch_id,
      v_new_version,
      v_existing_label_id,
      true
    )
    RETURNING id INTO v_new_label_id;
  ELSE
    -- Create first version
    v_new_version := 1;
    
    INSERT INTO v2_labels (
      dataset_id,
      user_id,
      label_data,
      label_type,
      label_source,
      reference_patch_id,
      version,
      parent_label_id,
      is_active
    ) VALUES (
      p_dataset_id,
      p_user_id,
      v_label_data,  -- Use enum variable
      'semantic_segmentation',
      'reference_patch',
      p_patch_id,
      v_new_version,
      NULL,
      true
    )
    RETURNING id INTO v_new_label_id;
  END IF;

  -- Insert geometries
  -- Geometry column is JSONB, so just insert the JSONB directly!
  FOR v_geometry IN SELECT * FROM jsonb_array_elements(p_geometries)
  LOOP
    EXECUTE format(
      'INSERT INTO %I (label_id, patch_id, geometry, properties)
       VALUES ($1, $2, $3, $4)',
      v_table_name
    ) USING v_new_label_id, p_patch_id, v_geometry, '{}'::jsonb;
  END LOOP;

  -- Update patch reference
  EXECUTE format(
    'UPDATE reference_patches SET %I = $1 WHERE id = $2',
    v_patch_column_name
  ) USING v_new_label_id, p_patch_id;

  -- Return results
  RETURN QUERY SELECT v_new_label_id, v_new_version;
END;
$function$
;


