-- Audit functions on the answer tables (DT-1606, docs/audit-checks.md):
--   finish_run               the audit worker stores a run's tiles, images and judgements
--                            and marks it done, all or nothing (the processor account or
--                            the service role)
--   activate_version         operators switch a check version on (with its rules)
--   activate_rules           operators switch a version's rule set on; every result of
--                            the version is worked out again at once
--   draw_target              operators draw the next random benchmark target
--   remove_benchmark_target  operators take a target out of a benchmark (the tick goes,
--                            the review stays)
-- A benchmark label itself is a plain insert into the human review tables with
-- in_benchmark, which their policies allow operators only.
set local lock_timeout = '5s';

-- Operators, or the service role (scripts and the worker).
create function internal.require_audit_operator(p_what text)
returns void
language plpgsql stable set search_path = ''
as $$
begin
	if not public.can_operate() and current_setting('role', true) is distinct from 'service_role'
		and (select auth.jwt() ->> 'role') is distinct from 'service_role' then
		raise exception 'Only operators %', p_what using errcode = '42501';
	end if;
end;
$$;
revoke all on function internal.require_audit_operator(text) from public, anon;
grant execute on function internal.require_audit_operator(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The worker finishes a run
-- ---------------------------------------------------------------------------

-- p_result (arrays optional):
--   inputs              what the run judged (ortho_sha256, aoi, label_ids per layer); kept
--                       when absent
--   evidence            the run's evidence, coverage and cost (the dataset evaluation's
--                       band_check {likelihood} and empty)
--   tiles               [{pixel_window: [x0, y0, x1, y1] on the 10 cm CLIP grid or null,
--                         geometry (GeoJSON, EPSG:4326), mpp, size_px}]; an existing tile
--                       (same window and footprint, off the grid the same footprint) is
--                       reused
--   images              [{tile_index (1-based into tiles, null for the overview and
--                         thumbnail), prediction_label_id (overlays), kind, storage_path,
--                         content_type, width, height, mpp, bytes, sha256}]
--   dataset_judgements  [{judge, verdict, likelihood, cog_issue, thumbnail_issue,
--                         exclude_reason, summary, raw}]
--   tile_judgements     [{tile_index, layer, judge, verdict, likelihood, problems, summary,
--                         raw}]; raw keeps the model's error sentences as raw.errors
-- The run must be queued or running. Owner-run: the worker has no direct writes on the
-- tiles, images and judgements.
create function audit.finish_run(p_run_id bigint, p_result jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
	v_run audit.runs;
	v_tile jsonb;
	v_window jsonb;
	v_id bigint;
	v_tile_ids bigint[] := '{}';
begin
	if not internal.is_audit_worker() and current_setting('role', true) is distinct from 'service_role'
		and (select auth.jwt() ->> 'role') is distinct from 'service_role' then
		raise exception 'Only the audit worker finishes runs' using errcode = '42501';
	end if;
	select * into v_run from audit.runs where id = p_run_id for update;
	if not found then
		raise exception 'Run % does not exist', p_run_id using errcode = 'P0002';
	end if;
	if v_run.status not in ('queued', 'running') then
		raise exception 'Run % is already %', p_run_id, v_run.status using errcode = '55000';
	end if;

	-- a tile is its window and footprint (off the grid, its footprint alone): a rerun on an
	-- ortho that did not move finds its tiles again, a moved ortho gives new tiles
	for v_tile in select value from jsonb_array_elements(coalesce(p_result -> 'tiles', '[]'::jsonb)) loop
		v_window := case when jsonb_typeof(v_tile -> 'pixel_window') = 'array' then v_tile -> 'pixel_window' end;
		insert into audit.tiles (dataset_id, pixel_x0, pixel_y0, pixel_x1, pixel_y1, geometry, mpp, size_px)
		values (
			v_run.dataset_id,
			(v_window ->> 0)::integer, (v_window ->> 1)::integer, (v_window ->> 2)::integer, (v_window ->> 3)::integer,
			public.st_setsrid(public.st_geomfromgeojson(v_tile ->> 'geometry'), 4326),
			(v_tile ->> 'mpp')::real, (v_tile ->> 'size_px')::integer
		)
		on conflict (dataset_id, pixel_x0, pixel_y0, pixel_x1, pixel_y1, md5(geometry::text))
		do update set dataset_id = excluded.dataset_id
		returning id into v_id;
		v_tile_ids := v_tile_ids || v_id;
	end loop;

	if exists (
		select 1 from jsonb_array_elements(coalesce(p_result -> 'images', '[]'::jsonb)) i
		where i ? 'tile_index' and jsonb_typeof(i -> 'tile_index') <> 'null'
			and (i ->> 'tile_index')::integer not between 1 and cardinality(v_tile_ids)
		union all
		select 1 from jsonb_array_elements(coalesce(p_result -> 'tile_judgements', '[]'::jsonb)) j
		where coalesce((j ->> 'tile_index')::integer, 0) not between 1 and cardinality(v_tile_ids)
	) then
		raise exception 'Run %: a tile_index is not in tiles', p_run_id using errcode = '22023';
	end if;

	insert into audit.images (run_id, dataset_id, tile_id, prediction_label_id, kind, storage_path, content_type,
		width, height, mpp, bytes, sha256)
	select p_run_id, v_run.dataset_id, v_tile_ids[(i ->> 'tile_index')::integer], (i ->> 'prediction_label_id')::bigint,
		i ->> 'kind', i ->> 'storage_path', i ->> 'content_type', (i ->> 'width')::integer, (i ->> 'height')::integer,
		(i ->> 'mpp')::real, (i ->> 'bytes')::integer, i ->> 'sha256'
	from jsonb_array_elements(coalesce(p_result -> 'images', '[]'::jsonb)) i;

	insert into audit.dataset_vlm_judgements (run_id, dataset_id, judge, verdict, likelihood, cog_issue, thumbnail_issue,
		exclude_reason, summary, raw)
	select p_run_id, v_run.dataset_id, j ->> 'judge', (j ->> 'verdict')::audit.verdict, (j ->> 'likelihood')::real,
		(j ->> 'cog_issue')::boolean, (j ->> 'thumbnail_issue')::boolean, j ->> 'exclude_reason', j ->> 'summary',
		coalesce(nullif(j -> 'raw', 'null'::jsonb), '{}'::jsonb)
	from jsonb_array_elements(coalesce(p_result -> 'dataset_judgements', '[]'::jsonb)) j;

	insert into audit.tile_vlm_judgements (run_id, dataset_id, tile_id, layer, judge, verdict, likelihood, problems,
		summary, raw)
	select p_run_id, v_run.dataset_id, v_tile_ids[(j ->> 'tile_index')::integer], j ->> 'layer', j ->> 'judge',
		(j ->> 'verdict')::audit.verdict, (j ->> 'likelihood')::real,
		coalesce(nullif(j -> 'problems', 'null'::jsonb), '{}'::jsonb), j ->> 'summary',
		coalesce(nullif(j -> 'raw', 'null'::jsonb), '{}'::jsonb)
	from jsonb_array_elements(coalesce(p_result -> 'tile_judgements', '[]'::jsonb)) j;

	update audit.runs
	set status = 'done',
		started_at = coalesce(started_at, now()),
		finished_at = now(),
		error = null,
		inputs = coalesce(nullif(p_result -> 'inputs', 'null'::jsonb), inputs),
		evidence = coalesce(nullif(p_result -> 'evidence', 'null'::jsonb), '{}'::jsonb)
	where id = p_run_id;
end;
$$;
revoke all on function audit.finish_run(bigint, jsonb) from public, anon;
grant execute on function audit.finish_run(bigint, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Operators switch versions and rules
-- ---------------------------------------------------------------------------

-- A version is switched on together with its rules: it needs an active rule set. Its
-- datasets keep their last result until their rerun finishes (audit.current_runs).
drop function audit.activate_version(bigint, boolean);
create function audit.activate_version(p_version_id bigint)
returns audit.check_versions
language plpgsql security definer set search_path = ''
as $$
declare
	v_version audit.check_versions;
begin
	perform internal.require_audit_operator('activate check versions');
	select * into v_version from audit.check_versions where id = p_version_id for update;
	if not found then
		raise exception 'Check version % does not exist', p_version_id using errcode = 'P0002';
	end if;
	if not exists (select 1 from audit.check_rules where version_id = p_version_id and is_active) then
		raise exception 'Check version % has no active rules; switch its rules on first', p_version_id
			using errcode = '55000';
	end if;
	update audit.check_versions set is_active = false
	where check_key = v_version.check_key and is_active and id <> p_version_id;
	update audit.check_versions set is_active = true, activated_at = now()
	where id = p_version_id and not is_active;
	select * into v_version from audit.check_versions where id = p_version_id;
	return v_version;
end;
$$;
revoke all on function audit.activate_version(bigint) from public, anon;
grant execute on function audit.activate_version(bigint) to authenticated, service_role;

create function audit.activate_rules(p_rules_id bigint)
returns audit.check_rules
language plpgsql security definer set search_path = ''
as $$
declare
	v_rules audit.check_rules;
begin
	perform internal.require_audit_operator('activate check rules');
	select * into v_rules from audit.check_rules where id = p_rules_id for update;
	if not found then
		raise exception 'Check rules % do not exist', p_rules_id using errcode = 'P0002';
	end if;
	update audit.check_rules set is_active = false
	where version_id = v_rules.version_id and is_active and id <> p_rules_id;
	update audit.check_rules set is_active = true, activated_at = now()
	where id = p_rules_id and not is_active;
	select * into v_rules from audit.check_rules where id = p_rules_id;
	return v_rules;
end;
$$;
revoke all on function audit.activate_rules(bigint) from public, anon;
grant execute on function audit.activate_rules(bigint) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Benchmarks: the in_benchmark tick on a person's review
-- ---------------------------------------------------------------------------

-- The next random target of a benchmark ('dataset_evaluation', 'deadwood' or
-- 'forest_cover') that is not ticked yet and not in p_skipped (dataset ids for the dataset
-- benchmark, tile ids for the tile benchmarks). The dataset benchmark draws among datasets
-- with a current dataset evaluation run; a tile benchmark draws a random dataset first (not
-- excluded, with a current prediction quality run), then a random tile of that run with a
-- call on the layer. No row when nothing is left.
create function audit.draw_target(p_benchmark text, p_skipped bigint[] default '{}')
returns table (dataset_id bigint, tile_id bigint)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
	v_dataset bigint;
	v_skipped bigint[] := coalesce(p_skipped, '{}');
begin
	if not public.can_operate() then
		raise exception 'Only operators draw benchmark targets' using errcode = '42501';
	end if;
	if p_benchmark = 'dataset_evaluation' then
		return query
		select c.dataset_id, null::bigint
		from audit.current_runs c
		where c.check_key = 'dataset_evaluation' and c.dataset_id <> all (v_skipped)
			and not exists (
				select 1 from audit.dataset_human_reviews h
				where h.dataset_id = c.dataset_id and h.check_key = 'dataset_evaluation' and h.in_benchmark
			)
		order by random()
		limit 1;
		return;
	end if;
	if p_benchmark is distinct from 'deadwood' and p_benchmark is distinct from 'forest_cover' then
		raise exception 'Unknown benchmark %', p_benchmark using errcode = '22023';
	end if;
	for v_dataset in
		select c.dataset_id
		from audit.current_runs c
		where c.check_key = 'prediction_quality'
			and c.dataset_id not in (select audit.excluded_dataset_ids())
		order by random()
	loop
		return query
		select t.dataset_id, t.tile_id
		from audit.tile_calls t
		where t.dataset_id = v_dataset and t.layer = p_benchmark and t.verdict is not null
			and t.tile_id <> all (v_skipped)
			and not exists (
				select 1 from audit.tile_human_reviews h
				where h.tile_id = t.tile_id and h.layer = t.layer and h.in_benchmark
			)
		order by random()
		limit 1;
		if found then
			return;
		end if;
	end loop;
end;
$$;
revoke all on function audit.draw_target(text, bigint[]) from public, anon;
grant execute on function audit.draw_target(text, bigint[]) to authenticated, service_role;

-- Takes a target out of a benchmark: the tick goes from its reviews (a dataset's dataset
-- evaluation reviews, or a tile's reviews on the layer), the reviews stay. Returns how many
-- reviews lost the tick.
create function audit.remove_benchmark_target(p_benchmark text, p_dataset_id bigint, p_tile_id bigint default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
	v_count integer;
begin
	if not public.can_operate() then
		raise exception 'Only operators remove benchmark targets' using errcode = '42501';
	end if;
	if p_benchmark = 'dataset_evaluation' then
		update audit.dataset_human_reviews set in_benchmark = false
		where dataset_id = p_dataset_id and check_key = 'dataset_evaluation' and in_benchmark;
	elsif p_benchmark in ('deadwood', 'forest_cover') and p_tile_id is not null then
		update audit.tile_human_reviews set in_benchmark = false
		where dataset_id = p_dataset_id and tile_id = p_tile_id and layer = p_benchmark and in_benchmark;
	else
		raise exception 'Unknown benchmark target %/%/%', p_benchmark, p_dataset_id, p_tile_id using errcode = '22023';
	end if;
	get diagnostics v_count = row_count;
	return v_count;
end;
$$;
revoke all on function audit.remove_benchmark_target(text, bigint, bigint) from public, anon;
grant execute on function audit.remove_benchmark_target(text, bigint, bigint) to authenticated, service_role;

notify pgrst, 'reload schema';
