-- Correction, reference-patch and publication writes trusted the caller.
--
-- The correction and reference RPCs are SECURITY DEFINER and took the acting
-- user from a parameter. `p_user_id != auth.uid()` is NULL for anonymous
-- callers, so anyone with the public anon key could delete, approve or revert
-- prediction polygons and have them recorded as an auditor's work. The
-- publication tables had write policies open to every role.
--
-- The RPC signatures are unchanged so the deployed frontend keeps working: the
-- user parameters must now equal auth.uid(), and every decision uses auth.uid().

-- Prediction corrections -----------------------------------------------------

create or replace function public.save_prediction_corrections(
	p_dataset_id bigint,
	p_label_id bigint,
	p_user_id uuid,
	p_layer_type text,
	p_session_id uuid,
	p_deletions bigint[],
	p_deletion_timestamps timestamp with time zone[],
	p_additions jsonb
)
returns table(success boolean, message text, conflict_ids bigint[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
	v_uid uuid := auth.uid();
	v_is_auditor boolean;
	v_table_name text;
	v_conflict_ids bigint[] := '{}';
	v_deletion_id bigint;
	v_expected_ts timestamptz;
	v_actual_ts timestamptz;
	v_geometry jsonb;
	v_new_id bigint;
	v_original_id bigint;
	v_in_label boolean;
	i integer;
begin
	if v_uid is null or p_user_id is distinct from v_uid then
		raise exception 'Cannot save corrections for another user' using errcode = '42501';
	end if;
	-- Auditor edits are auto-approved.
	v_is_auditor := public.can_audit();

	-- Only model predictions the caller can see are correctable (same visibility
	-- as the v2_labels read policy); owner rights would otherwise be bypassed.
	if not exists (
		select 1
		from v2_labels l
		join v2_datasets d on d.id = l.dataset_id
		where l.id = p_label_id
			and l.label_source = 'model_prediction'
			and (
				v_is_auditor
				or d.user_id = v_uid
				or public.can_view_all_private_data()
				or (
					d.data_access <> 'private'
					and not d.archived
					and not internal.is_dataset_excluded_from_public_surface(d.id)
				)
			)
	) then
		raise exception 'Label % is not a visible model prediction', p_label_id using errcode = '42501';
	end if;

	if p_layer_type not in ('deadwood', 'forest_cover') then
		return query select false, 'Invalid layer_type'::text, null::bigint[];
		return;
	end if;
	v_table_name := case when p_layer_type = 'deadwood' then 'v2_deadwood_geometries' else 'v2_forest_cover_geometries' end;

	-- Deletions use optimistic locking. A geometry that does not exist in this
	-- label is reported as a conflict, so callers cannot reach other labels.
	if p_deletions is not null and array_length(p_deletions, 1) > 0 then
		for i in 1..array_length(p_deletions, 1) loop
			v_deletion_id := p_deletions[i];
			v_expected_ts := p_deletion_timestamps[i];

			v_actual_ts := null;
			execute format('select updated_at from %I where id = $1 and label_id = $2', v_table_name)
				into v_actual_ts using v_deletion_id, p_label_id;

			if v_actual_ts is null or v_actual_ts is distinct from v_expected_ts then
				v_conflict_ids := array_append(v_conflict_ids, v_deletion_id);
				continue;
			end if;

			if exists (
				select 1 from v2_geometry_corrections
				where geometry_id = v_deletion_id
					and layer_type = p_layer_type
					and operation = 'add'
					and review_status = 'pending'
					and user_id != v_uid
			) then
				return query select false, 'Cannot modify another user''s pending correction'::text, array[v_deletion_id];
				return;
			end if;

			execute format('update %I set is_deleted = true where id = $1', v_table_name) using v_deletion_id;

			insert into v2_geometry_corrections
				(geometry_id, layer_type, label_id, dataset_id, operation, user_id, session_id, review_status, reviewed_by, reviewed_at)
			values (
				v_deletion_id, p_layer_type, p_label_id, p_dataset_id, 'delete', v_uid, p_session_id,
				case when v_is_auditor then 'approved' else 'pending' end,
				case when v_is_auditor then v_uid end,
				case when v_is_auditor then now() end
			);
		end loop;
	end if;

	if array_length(v_conflict_ids, 1) > 0 then
		return query select false, 'Conflict detected - some geometries were modified by another user'::text, v_conflict_ids;
		return;
	end if;

	if p_additions is not null and jsonb_array_length(p_additions) > 0 then
		for v_geometry in select * from jsonb_array_elements(p_additions) loop
			v_original_id := (v_geometry->>'original_geometry_id')::bigint;

			if v_original_id is not null then
				-- A modify replaces a geometry of the same label.
				execute format('select exists (select 1 from %I where id = $1 and label_id = $2)', v_table_name)
					into v_in_label using v_original_id, p_label_id;
				if not v_in_label then
					raise exception 'Geometry % does not belong to label %', v_original_id, p_label_id
						using errcode = '42501';
				end if;
			end if;

			execute format(
				'insert into %I (label_id, geometry) values ($1, ST_GeomFromGeoJSON($2)) returning id',
				v_table_name
			) into v_new_id using p_label_id, v_geometry->>'geometry';

			insert into v2_geometry_corrections
				(geometry_id, layer_type, label_id, dataset_id, operation, original_geometry_id, user_id, session_id, review_status, reviewed_by, reviewed_at)
			values (
				v_new_id, p_layer_type, p_label_id, p_dataset_id,
				case when v_original_id is not null then 'modify' else 'add' end,
				v_original_id, v_uid, p_session_id,
				case when v_is_auditor then 'approved' else 'pending' end,
				case when v_is_auditor then v_uid end,
				case when v_is_auditor then now() end
			);

			-- Hide the original immediately so old and new are never both visible.
			if v_original_id is not null then
				execute format('update %I set is_deleted = true where id = $1', v_table_name) using v_original_id;
			end if;
		end loop;
	end if;

	return query select true, 'Success'::text, null::bigint[];
end;
$$;

create or replace function public.approve_correction(p_correction_id bigint, p_reviewer_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
	v_uid uuid := auth.uid();
	v_correction record;
begin
	if v_uid is null or p_reviewer_id is distinct from v_uid or not public.can_audit() then
		raise exception 'User is not authorized to approve corrections' using errcode = '42501';
	end if;

	select * into v_correction
	from v2_geometry_corrections
	where id = p_correction_id and review_status = 'pending';
	if not found then
		return false;
	end if;

	update v2_geometry_corrections
	set review_status = 'approved', reviewed_by = v_uid, reviewed_at = now()
	where id = p_correction_id;

	-- A modify hides the geometry it replaced.
	if v_correction.operation = 'modify' and v_correction.original_geometry_id is not null then
		if v_correction.layer_type = 'deadwood' then
			update v2_deadwood_geometries set is_deleted = true
			where id = v_correction.original_geometry_id and label_id = v_correction.label_id;
		elsif v_correction.layer_type = 'forest_cover' then
			update v2_forest_cover_geometries set is_deleted = true
			where id = v_correction.original_geometry_id and label_id = v_correction.label_id;
		end if;
	end if;

	return true;
end;
$$;

create or replace function public.revert_correction(p_correction_id bigint, p_reviewer_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
	v_uid uuid := auth.uid();
	v_correction record;
	v_table_name text;
begin
	if v_uid is null or p_reviewer_id is distinct from v_uid or not public.can_audit() then
		raise exception 'User is not authorized to revert corrections' using errcode = '42501';
	end if;

	select * into v_correction from v2_geometry_corrections where id = p_correction_id;
	if not found then
		return false;
	end if;
	if v_correction.review_status != 'pending' then
		raise exception 'Can only revert pending corrections';
	end if;

	v_table_name := case when v_correction.layer_type = 'deadwood' then 'v2_deadwood_geometries' else 'v2_forest_cover_geometries' end;

	-- Only geometries of the correction's own label are touched.
	case v_correction.operation
		when 'delete' then
			execute format('update %I set is_deleted = false where id = $1 and label_id = $2', v_table_name)
				using v_correction.geometry_id, v_correction.label_id;
		when 'add' then
			execute format('delete from %I where id = $1 and label_id = $2', v_table_name)
				using v_correction.geometry_id, v_correction.label_id;
		when 'modify' then
			execute format('delete from %I where id = $1 and label_id = $2', v_table_name)
				using v_correction.geometry_id, v_correction.label_id;
			if v_correction.original_geometry_id is not null then
				execute format('update %I set is_deleted = false where id = $1 and label_id = $2', v_table_name)
					using v_correction.original_geometry_id, v_correction.label_id;
			end if;
	end case;

	-- Kept as rejected for the audit trail.
	update v2_geometry_corrections
	set review_status = 'rejected', reviewed_by = v_uid, reviewed_at = now()
	where id = p_correction_id;

	return true;
end;
$$;

create or replace function public.get_pending_correction_locations(p_dataset_id bigint)
returns table(
	correction_id bigint, geometry_id bigint, layer_type text, operation text,
	centroid_lon double precision, centroid_lat double precision,
	min_lon double precision, min_lat double precision, max_lon double precision, max_lat double precision
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
	if not (
		public.can_audit()
		or exists (select 1 from v2_datasets d where d.id = p_dataset_id and d.user_id = auth.uid())
	) then
		raise exception 'Audit permission or dataset ownership required' using errcode = '42501';
	end if;

	return query
	select
		c.id,
		c.geometry_id,
		c.layer_type,
		c.operation,
		ST_X(ST_Centroid(g.geometry)),
		ST_Y(ST_Centroid(g.geometry)),
		ST_XMin(g.geometry),
		ST_YMin(g.geometry),
		ST_XMax(g.geometry),
		ST_YMax(g.geometry)
	from v2_geometry_corrections c
	left join lateral (
		select dg.geometry from v2_deadwood_geometries dg where c.layer_type = 'deadwood' and dg.id = c.geometry_id
		union all
		select fg.geometry from v2_forest_cover_geometries fg where c.layer_type = 'forest_cover' and fg.id = c.geometry_id
	) g on true
	where c.dataset_id = p_dataset_id
		and c.review_status = 'pending'
	order by c.created_at desc;
end;
$$;

-- Corrections are written only through the RPCs above.
drop policy if exists "Authenticated insert corrections" on public.v2_geometry_corrections;
revoke insert, update, delete, truncate on table public.v2_geometry_corrections from anon, authenticated;

-- Reference patches (auditor-only, like their table policies) ------------------

create or replace function public.save_reference_geometries(
	p_patch_id bigint,
	p_dataset_id bigint,
	p_user_id uuid,
	p_layer_type text,
	p_geometries jsonb
)
returns table(label_id bigint, version integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
	v_uid uuid := auth.uid();
	v_existing_label_id bigint;
	v_existing_version integer;
	v_new_label_id bigint;
	v_new_version integer;
	v_table_name text;
	v_patch_column_name text;
	v_geometry jsonb;
	v_label_data "LabelData" := p_layer_type::"LabelData";
begin
	if v_uid is null or p_user_id is distinct from v_uid or not public.can_audit() then
		raise exception 'Audit permission required' using errcode = '42501';
	end if;

	if p_layer_type = 'deadwood' then
		v_table_name := 'reference_patch_deadwood_geometries';
		v_patch_column_name := 'reference_deadwood_label_id';
	else
		v_table_name := 'reference_patch_forest_cover_geometries';
		v_patch_column_name := 'reference_forest_cover_label_id';
	end if;

	perform 1 from reference_patches rp where rp.id = p_patch_id and rp.dataset_id = p_dataset_id for update;
	if not found then
		raise exception 'Reference patch % does not belong to dataset %', p_patch_id, p_dataset_id
			using errcode = '42501';
	end if;

	select lbl.id, lbl.version
	into v_existing_label_id, v_existing_version
	from v2_labels lbl
	where lbl.reference_patch_id = p_patch_id
		and lbl.label_data = v_label_data
		and lbl.is_active = true
	for update;

	if found then
		update v2_labels set is_active = false where id = v_existing_label_id;
		v_new_version := v_existing_version + 1;
	else
		v_new_version := 1;
	end if;

	insert into v2_labels (
		dataset_id, user_id, label_data, label_type, label_source,
		reference_patch_id, version, parent_label_id, is_active
	) values (
		p_dataset_id, v_uid, v_label_data, 'semantic_segmentation',
		'reference_patch', p_patch_id, v_new_version, v_existing_label_id, true
	)
	returning id into v_new_label_id;

	for v_geometry in select * from jsonb_array_elements(p_geometries) loop
		execute format(
			'insert into %I (label_id, patch_id, geometry, properties) values ($1, $2, $3, $4)',
			v_table_name
		) using v_new_label_id, p_patch_id, v_geometry, '{}'::jsonb;
	end loop;

	execute format(
		'update reference_patches set %I = $1, updated_at = now() where id = $2',
		v_patch_column_name
	) using v_new_label_id, p_patch_id;

	return query select v_new_label_id, v_new_version;
end;
$$;

create or replace function public.get_clipped_geometries_batch(
	p_label_id bigint,
	p_geometry_table text,
	p_bbox_minx double precision,
	p_bbox_miny double precision,
	p_bbox_maxx double precision,
	p_bbox_maxy double precision,
	p_epsg_code integer,
	p_buffer_m double precision default 2.0,
	p_limit integer default 50,
	p_offset integer default 0
)
returns table(geometry jsonb, total_count bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
	bbox_geom geometry;
	bbox_box2d box2d;
	total_intersecting bigint;
begin
	-- Reads bypass the label visibility policies, so only auditors may clip.
	if not public.can_audit() then
		raise exception 'Audit permission required' using errcode = '42501';
	end if;
	if p_geometry_table not in ('v2_deadwood_geometries', 'v2_forest_cover_geometries') then
		raise exception 'Invalid geometry table %', p_geometry_table using errcode = '22023';
	end if;

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
	bbox_box2d := bbox_geom::box2d;

	-- The total is only needed with the first batch.
	if p_offset = 0 then
		execute format(
			'select count(*) from %I where label_id = $1 and geometry && $2 and ST_Intersects(geometry, $2)',
			p_geometry_table
		) into total_intersecting using p_label_id, bbox_geom;
	else
		total_intersecting := 0;
	end if;

	-- Only invalid geometries are repaired; valid ones are clipped as stored.
	return query execute format(
		'select
			ST_AsGeoJSON(
				case
					when ST_GeometryType(clipped_geom) = ''ST_GeometryCollection''
					then ST_CollectionExtract(clipped_geom, 3)
					else clipped_geom
				end
			)::jsonb as geometry,
			$5 as total_count
		from (
			select ST_ClipByBox2D(
				case when ST_IsValid(geometry) then geometry else ST_MakeValid(geometry) end,
				$4
			) as clipped_geom
			from %I
			where label_id = $1
				and geometry && $2
				and ST_Intersects(geometry, $2)
			order by id
			limit $6
			offset $7
		) sub
		where not ST_IsEmpty(clipped_geom)
			and ST_GeometryType(clipped_geom) in (''ST_Polygon'', ''ST_MultiPolygon'', ''ST_GeometryCollection'')',
		p_geometry_table
	) using p_label_id, bbox_geom, bbox_geom, bbox_box2d, total_intersecting, p_limit, p_offset;
end;
$$;

-- Unused definer helper that turns row security off; keep it for maintenance only.
revoke all on function public.copy_predictions_to_reference_patch(bigint, bigint, double precision, double precision, double precision, double precision)
	from public, anon, authenticated;

-- None of these RPCs is meaningful without a signed-in user.
revoke all on function public.save_prediction_corrections(bigint, bigint, uuid, text, uuid, bigint[], timestamp with time zone[], jsonb) from public, anon;
revoke all on function public.approve_correction(bigint, uuid) from public, anon;
revoke all on function public.revert_correction(bigint, uuid) from public, anon;
revoke all on function public.get_pending_correction_locations(bigint) from public, anon;
revoke all on function public.save_reference_geometries(bigint, bigint, uuid, text, jsonb) from public, anon;
revoke all on function public.get_clipped_geometries_batch(bigint, text, double precision, double precision, double precision, double precision, integer, double precision, integer, integer) from public, anon;
grant execute on function public.save_prediction_corrections(bigint, bigint, uuid, text, uuid, bigint[], timestamp with time zone[], jsonb) to authenticated;
grant execute on function public.approve_correction(bigint, uuid) to authenticated;
grant execute on function public.revert_correction(bigint, uuid) to authenticated;
grant execute on function public.get_pending_correction_locations(bigint) to authenticated;
grant execute on function public.save_reference_geometries(bigint, bigint, uuid, text, jsonb) to authenticated;
grant execute on function public.get_clipped_geometries_batch(bigint, text, double precision, double precision, double precision, double precision, integer, double precision, integer, integer) to authenticated;

-- Publications ------------------------------------------------------------------
-- Everyone may read publications. A signed-in user creates their own pending
-- publication, its authors and its dataset links (PublicationModal). DOI, status
-- and FreiDATA fields are written only by the service role (freidata/).

drop policy if exists "Enable all for authenticated users only" on public.data_publication;
drop policy if exists "Enable all for authenticated users only" on public.user_info;
drop policy if exists "Enable all for authenticated users only" on public.jt_data_publication_datasets;
drop policy if exists "Enable all for authenticated users only" on public.jt_data_publication_user_info;

revoke insert, update, delete, truncate on table
	public.data_publication, public.user_info,
	public.jt_data_publication_datasets, public.jt_data_publication_user_info
	from anon;
revoke update, delete, truncate on table
	public.data_publication, public.user_info,
	public.jt_data_publication_datasets, public.jt_data_publication_user_info
	from authenticated;

create policy "Owners create pending publications"
on public.data_publication for insert to authenticated
with check (
	user_id = (select auth.uid())
	and status = 'pending'
	and doi is null
	and published_at is null
	and freidata_record_id is null
	and notified_at is null
);

-- PublicationModal writes the publication, authors and links in separate
-- requests. Its owner may remove a publication that is still pending (links
-- cascade) and their own author records, so a failed submission can be undone.
grant delete on table public.data_publication, public.user_info to authenticated;

create policy "Owners delete pending publications"
on public.data_publication for delete to authenticated
using (user_id = (select auth.uid()) and status = 'pending');

create policy "Users delete their own author records"
on public.user_info for delete to authenticated
using ("user" = (select auth.uid()));

create policy "Users create their own author records"
on public.user_info for insert to authenticated
with check ("user" = (select auth.uid()));

create policy "Owners link their own authors"
on public.jt_data_publication_user_info for insert to authenticated
with check (
	exists (select 1 from public.data_publication p where p.id = publication_id and p.user_id = (select auth.uid()))
	and exists (select 1 from public.user_info u where u.id = user_info_id and u."user" = (select auth.uid()))
);

create policy "Owners link their own datasets"
on public.jt_data_publication_datasets for insert to authenticated
with check (
	exists (select 1 from public.data_publication p where p.id = publication_id and p.user_id = (select auth.uid()))
	and exists (select 1 from public.v2_datasets d where d.id = dataset_id and d.user_id = (select auth.uid()))
);
