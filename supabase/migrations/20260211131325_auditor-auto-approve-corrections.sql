set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.save_prediction_corrections(p_dataset_id bigint, p_label_id bigint, p_user_id uuid, p_layer_type text, p_session_id uuid, p_deletions bigint[], p_deletion_timestamps timestamp with time zone[], p_additions jsonb)
 RETURNS TABLE(success boolean, message text, conflict_ids bigint[])
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
	v_table_name TEXT;
	v_conflict_ids BIGINT[] := '{}';
	v_deletion_id BIGINT;
	v_expected_ts TIMESTAMPTZ;
	v_actual_ts TIMESTAMPTZ;
	v_geometry JSONB;
	v_new_id BIGINT;
	v_original_id BIGINT;
	v_is_pending_from_other BOOLEAN;
	v_is_auditor BOOLEAN := false;
	i INTEGER;
BEGIN
	-- SECURITY: Verify caller is the user they claim to be
	IF p_user_id != auth.uid() THEN
		RETURN QUERY SELECT false, 'Cannot save corrections for another user'::TEXT, NULL::BIGINT[];
		RETURN;
	END IF;

	-- Check whether caller is an auditor (auditor edits are auto-approved)
	SELECT EXISTS (
		SELECT 1
		FROM privileged_users
		WHERE user_id = p_user_id
		AND can_audit = true
	) INTO v_is_auditor;

	-- Validate layer type
	IF p_layer_type NOT IN ('deadwood', 'forest_cover') THEN
		RETURN QUERY SELECT false, 'Invalid layer_type'::TEXT, NULL::BIGINT[];
		RETURN;
	END IF;

	-- Determine table
	IF p_layer_type = 'deadwood' THEN
		v_table_name := 'v2_deadwood_geometries';
	ELSE
		v_table_name := 'v2_forest_cover_geometries';
	END IF;

	-- Process deletions with optimistic locking
	IF p_deletions IS NOT NULL AND array_length(p_deletions, 1) > 0 THEN
		FOR i IN 1..array_length(p_deletions, 1) LOOP
			v_deletion_id := p_deletions[i];
			v_expected_ts := p_deletion_timestamps[i];

			-- Check timestamp matches (optimistic lock)
			EXECUTE format('SELECT updated_at FROM %I WHERE id = $1', v_table_name)
				INTO v_actual_ts USING v_deletion_id;

			IF v_actual_ts IS NULL THEN
				-- Geometry doesn't exist
				v_conflict_ids := array_append(v_conflict_ids, v_deletion_id);
				CONTINUE;
			END IF;

			IF v_actual_ts != v_expected_ts THEN
				v_conflict_ids := array_append(v_conflict_ids, v_deletion_id);
				CONTINUE;
			END IF;

			-- Check if this is another user's pending correction (block editing)
			SELECT EXISTS (
				SELECT 1 FROM v2_geometry_corrections
				WHERE geometry_id = v_deletion_id
				AND layer_type = p_layer_type
				AND operation = 'add'
				AND review_status = 'pending'
				AND user_id != p_user_id
			) INTO v_is_pending_from_other;

			IF v_is_pending_from_other THEN
				RETURN QUERY SELECT false, 'Cannot modify another user''s pending correction'::TEXT, ARRAY[v_deletion_id];
				RETURN;
			END IF;

			-- Mark as deleted
			EXECUTE format('UPDATE %I SET is_deleted = true WHERE id = $1', v_table_name)
				USING v_deletion_id;

			-- Record in history
			INSERT INTO v2_geometry_corrections
				(geometry_id, layer_type, label_id, dataset_id, operation, user_id, session_id, review_status, reviewed_by, reviewed_at)
			VALUES
				(
					v_deletion_id,
					p_layer_type,
					p_label_id,
					p_dataset_id,
					'delete',
					p_user_id,
					p_session_id,
					CASE WHEN v_is_auditor THEN 'approved' ELSE 'pending' END,
					CASE WHEN v_is_auditor THEN p_user_id ELSE NULL END,
					CASE WHEN v_is_auditor THEN now() ELSE NULL END
				);
		END LOOP;
	END IF;

	-- If any conflicts, abort
	IF array_length(v_conflict_ids, 1) > 0 THEN
		RETURN QUERY SELECT false, 'Conflict detected - some geometries were modified by another user'::TEXT, v_conflict_ids;
		RETURN;
	END IF;

	-- Process additions
	IF p_additions IS NOT NULL AND jsonb_array_length(p_additions) > 0 THEN
		FOR v_geometry IN SELECT * FROM jsonb_array_elements(p_additions)
		LOOP
			-- Get original_geometry_id if this is a modify operation
			v_original_id := (v_geometry->>'original_geometry_id')::BIGINT;

			-- Insert new geometry
			EXECUTE format(
				'INSERT INTO %I (label_id, geometry) VALUES ($1, ST_GeomFromGeoJSON($2)) RETURNING id',
				v_table_name
			) INTO v_new_id USING p_label_id, v_geometry->>'geometry';

			-- Record in history
			INSERT INTO v2_geometry_corrections
				(geometry_id, layer_type, label_id, dataset_id, operation, original_geometry_id, user_id, session_id, review_status, reviewed_by, reviewed_at)
			VALUES
				(
					v_new_id,
					p_layer_type,
					p_label_id,
					p_dataset_id,
					CASE WHEN v_original_id IS NOT NULL THEN 'modify' ELSE 'add' END,
					v_original_id,
					p_user_id,
					p_session_id,
					CASE WHEN v_is_auditor THEN 'approved' ELSE 'pending' END,
					CASE WHEN v_is_auditor THEN p_user_id ELSE NULL END,
					CASE WHEN v_is_auditor THEN now() ELSE NULL END
				);

			-- For modify operations, immediately soft-delete the original geometry
			-- This prevents the "dual layer" issue where both old and new are visible
			IF v_original_id IS NOT NULL THEN
				EXECUTE format('UPDATE %I SET is_deleted = true WHERE id = $1', v_table_name)
					USING v_original_id;
			END IF;
		END LOOP;
	END IF;

	RETURN QUERY SELECT true, 'Success'::TEXT, NULL::BIGINT[];
END;
$function$
;


