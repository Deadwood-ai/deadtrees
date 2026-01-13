set check_function_bodies = off;

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
  v_label_data "LabelData";
BEGIN
  v_label_data := p_layer_type::"LabelData";

  IF p_layer_type = 'deadwood' THEN
    v_table_name := 'reference_patch_deadwood_geometries';
    v_patch_column_name := 'reference_deadwood_label_id';
  ELSE
    v_table_name := 'reference_patch_forest_cover_geometries';
    v_patch_column_name := 'reference_forest_cover_label_id';
  END IF;

  PERFORM rp.id FROM reference_patches rp WHERE rp.id = p_patch_id FOR UPDATE;

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
    AND lbl.label_data = v_label_data
    AND lbl.is_active = true
  FOR UPDATE;

  IF FOUND THEN
    UPDATE v2_labels
    SET is_active = false
    WHERE id = v_existing_label_id;

    v_new_version := v_existing_version + 1;
    
    INSERT INTO v2_labels (
      dataset_id, user_id, label_data, label_type, label_source,
      reference_patch_id, version, parent_label_id, is_active
    ) VALUES (
      p_dataset_id, p_user_id, v_label_data, 'semantic_segmentation',
      'reference_patch', p_patch_id, v_new_version, v_existing_label_id, true
    )
    RETURNING id INTO v_new_label_id;
  ELSE
    v_new_version := 1;
    
    INSERT INTO v2_labels (
      dataset_id, user_id, label_data, label_type, label_source,
      reference_patch_id, version, parent_label_id, is_active
    ) VALUES (
      p_dataset_id, p_user_id, v_label_data, 'semantic_segmentation',
      'reference_patch', p_patch_id, v_new_version, NULL, true
    )
    RETURNING id INTO v_new_label_id;
  END IF;

  FOR v_geometry IN SELECT * FROM jsonb_array_elements(p_geometries)
  LOOP
    EXECUTE format(
      'INSERT INTO %I (label_id, patch_id, geometry, properties)
       VALUES ($1, $2, $3, $4)',
      v_table_name
    ) USING v_new_label_id, p_patch_id, v_geometry, '{}'::jsonb;
  END LOOP;

  -- FIX: Update patch reference AND updated_at timestamp
  EXECUTE format(
    'UPDATE reference_patches SET %I = $1, updated_at = NOW() WHERE id = $2',
    v_patch_column_name
  ) USING v_new_label_id, p_patch_id;

  RETURN QUERY SELECT v_new_label_id, v_new_version;
END;
$function$
;


