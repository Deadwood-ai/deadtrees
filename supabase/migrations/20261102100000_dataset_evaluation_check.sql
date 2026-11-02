-- Dataset evaluation check v1 (DT-1483): perceptual hashes for the duplicate rule,
-- the duplicate lookup, and one store function so a run's crops, images, assessments
-- and current-run pointer land together or not at all. See docs/dataset-evaluation.md.
--
-- Both functions run with the caller's rights: the audit worker's existing grants
-- and policies on the audit tables decide what it may write.
set local lock_timeout = '5s';

-- One perceptual hash of the overview per ortho version and hash method. The
-- duplicate rule compares a new upload's hash against these.
create table audit.image_hashes (
	dataset_id bigint not null references public.v2_datasets (id) on delete cascade,
	ortho_sha256 text not null check (ortho_sha256 ~ '^[0-9a-f]{64}$'),
	method text not null check (method ~ '^[a-z0-9][a-z0-9._-]*$'),  -- e.g. 'phash-dct64-v1'
	hash bigint not null,
	run_id bigint references audit.runs (id) on delete set null,
	created_at timestamptz not null default now(),
	primary key (dataset_id, ortho_sha256, method)
);
create index image_hashes_method_idx on audit.image_hashes (method);

alter table audit.image_hashes enable row level security;
revoke all on audit.image_hashes from public, anon, authenticated;
grant select, insert on audit.image_hashes to authenticated;
grant all on audit.image_hashes to service_role;
grant select on audit.image_hashes to analyst;
create policy "Auditors and the audit worker read" on audit.image_hashes
	for select to authenticated using (internal.can_read_audit_checks());
create policy analyst_select on audit.image_hashes for select to analyst using (true);
create policy "Audit worker stores image hashes" on audit.image_hashes
	for insert to authenticated with check (internal.is_audit_worker());

-- Other datasets that may hold the same data as p_dataset_id, strongest match first:
--   same_file        identical ortho file (v2_orthos.sha256)
--   same_image       overview hash within p_max_hamming bits, footprints overlapping
--   same_flight_day  same uploader and acquisition day, footprints overlapping
-- overlap is the shared bounding-box area over the smaller box. Flags only: nothing
-- is hidden or excluded because of a match.
create function audit.duplicate_candidates(
	p_dataset_id bigint,
	p_hash bigint,
	p_method text default 'phash-dct64-v1',
	p_max_hamming integer default 10,
	p_min_overlap real default 0.5
)
returns table (dataset_id bigint, kind text, hamming integer, overlap real)
language sql stable set search_path = ''
as $$
	with me as (
		select o.sha256, o.bbox::public.geometry as g, d.user_id,
			d.aquisition_year as y, d.aquisition_month as m, d.aquisition_day as dd
		from public.v2_orthos o
		join public.v2_datasets d on d.id = o.dataset_id
		where o.dataset_id = p_dataset_id
	), other as (
		select o.dataset_id,
			o.sha256 = me.sha256 as same_file,
			bit_count((p_hash # h.hash)::bit(64))::integer as hamming,
			(public.st_area(public.st_intersection(o.bbox::public.geometry, me.g))
				/ nullif(least(public.st_area(o.bbox::public.geometry), public.st_area(me.g)), 0))::real as overlap,
			d.user_id = me.user_id and d.aquisition_day is not null
				and (d.aquisition_year, d.aquisition_month, d.aquisition_day) = (me.y, me.m, me.dd) as same_day
		from me
		join public.v2_orthos o on o.dataset_id <> p_dataset_id
			and (o.sha256 = me.sha256 or o.bbox::public.geometry operator(public.&&) me.g)
		join public.v2_datasets d on d.id = o.dataset_id
		left join audit.image_hashes h on h.dataset_id = o.dataset_id and h.ortho_sha256 = o.sha256
			and h.method = p_method
	), matched as (
		select dataset_id,
			case
				when same_file then 'same_file'
				when hamming <= p_max_hamming and overlap >= p_min_overlap then 'same_image'
				else 'same_flight_day'
			end as kind,
			hamming,
			overlap
		from other
		where same_file
			or (overlap >= p_min_overlap and (hamming <= p_max_hamming or same_day))
	)
	select dataset_id, kind, hamming, overlap
	from matched
	order by kind = 'same_flight_day', kind = 'same_image', hamming nulls last, dataset_id;
$$;
revoke all on function audit.duplicate_candidates(bigint, bigint, text, integer, real) from public, anon;
grant execute on function audit.duplicate_candidates(bigint, bigint, text, integer, real)
	to authenticated, service_role, analyst;

-- Store a finished dataset evaluation run. p_result (built by the worker,
-- processor/src/dataset_evaluation_v1/check.py store_payload):
--   ortho_sha256, inputs, evidence, coverage, cost
--   crops        [{pixel_window ([x0, y0, x1, y1] on the 10 cm CLIP grid, or null),
--                 geometry (GeoJSON, EPSG:4326), mpp, size_px, selection}]
--   images       [{kind, crop_index (1-based into crops, null for the overview and
--                 thumbnail), storage_path, content_type, width, height, mpp, bytes, sha256}]
--   assessments  [{assessor_kind, model, prompt_version, verdict, major_likelihood,
--                 modes, details, raw}], dataset level, layer image
--   phash        {method, value}
-- The run must be a queued or running dataset_evaluation run that calls the models.
-- It becomes done and, outside the benchmark queue, the dataset's current run.
create function audit.store_dataset_evaluation(p_run_id bigint, p_result jsonb)
returns void
language plpgsql set search_path = ''
as $$
declare
	v_run audit.runs;
	v_sha text := p_result ->> 'ortho_sha256';
	v_crop_ids bigint[] := '{}';
	v_crop jsonb;
	v_id bigint;
begin
	select * into v_run from audit.runs where id = p_run_id for update;
	if not found then
		raise exception 'Run % does not exist or is not visible', p_run_id using errcode = 'P0002';
	end if;
	if v_run.check_key <> 'dataset_evaluation' or v_run.source_run_id is not null then
		raise exception 'Run % is not a dataset evaluation run that calls the models', p_run_id using errcode = '22023';
	end if;
	if v_run.status not in ('queued', 'running') then
		raise exception 'Run % is already %', p_run_id, v_run.status using errcode = '55000';
	end if;

	-- Crops are per ortho: a rerun on the same ortho finds its crops again. A crop on the
	-- 10 cm CLIP grid is keyed by its window, so a crop another check already stored
	-- (prediction quality) joins the evaluation set instead of being duplicated.
	for v_crop in select value from jsonb_array_elements(coalesce(p_result -> 'crops', '[]'::jsonb)) loop
		if jsonb_typeof(v_crop -> 'pixel_window') = 'array' then
			insert into audit.crops (dataset_id, ortho_sha256, crop_sets, pixel_x0, pixel_y0, pixel_x1, pixel_y1,
				geometry, mpp, size_px, selection)
			values (
				v_run.dataset_id, v_sha, array['evaluation'],
				(v_crop -> 'pixel_window' ->> 0)::integer, (v_crop -> 'pixel_window' ->> 1)::integer,
				(v_crop -> 'pixel_window' ->> 2)::integer, (v_crop -> 'pixel_window' ->> 3)::integer,
				public.st_setsrid(public.st_geomfromgeojson(v_crop ->> 'geometry'), 4326),
				(v_crop ->> 'mpp')::real, (v_crop ->> 'size_px')::integer,
				jsonb_build_object('evaluation', v_crop -> 'selection')
			)
			on conflict (dataset_id, ortho_sha256, pixel_x0, pixel_y0, pixel_x1, pixel_y1)
			do update set
				crop_sets = (select array_agg(distinct s order by s) from unnest(audit.crops.crop_sets || excluded.crop_sets) s),
				selection = excluded.selection || audit.crops.selection
			returning id into v_id;
		else
			insert into audit.crops (dataset_id, ortho_sha256, crop_sets, geometry, mpp, size_px, selection)
			values (
				v_run.dataset_id, v_sha, array['evaluation'],
				public.st_setsrid(public.st_geomfromgeojson(v_crop ->> 'geometry'), 4326),
				(v_crop ->> 'mpp')::real, (v_crop ->> 'size_px')::integer,
				jsonb_build_object('evaluation', v_crop -> 'selection')
			)
			on conflict (dataset_id, ortho_sha256, md5(geometry::text)) where pixel_x0 is null
			do update set
				crop_sets = (select array_agg(distinct s order by s) from unnest(audit.crops.crop_sets || excluded.crop_sets) s),
				selection = excluded.selection || audit.crops.selection
			returning id into v_id;
		end if;
		v_crop_ids := v_crop_ids || v_id;
	end loop;

	insert into audit.images (dataset_id, ortho_sha256, crop_id, kind, storage_path, content_type, width, height, mpp, bytes, sha256)
	select v_run.dataset_id, v_sha, v_crop_ids[(i ->> 'crop_index')::integer], i ->> 'kind', i ->> 'storage_path',
		i ->> 'content_type', (i ->> 'width')::integer, (i ->> 'height')::integer, (i ->> 'mpp')::real,
		(i ->> 'bytes')::integer, i ->> 'sha256'
	from jsonb_array_elements(coalesce(p_result -> 'images', '[]'::jsonb)) i
	on conflict do nothing;

	insert into audit.assessments (check_key, dataset_id, run_id, layer, assessor_kind, model, prompt_version,
		verdict, major_likelihood, modes, details, raw)
	select 'dataset_evaluation', v_run.dataset_id, p_run_id, 'image', (a ->> 'assessor_kind')::audit.assessor_kind,
		a ->> 'model', a ->> 'prompt_version', (a ->> 'verdict')::audit.verdict, (a ->> 'major_likelihood')::real,
		coalesce(a -> 'modes', '{}'::jsonb), coalesce(a -> 'details', '{}'::jsonb), nullif(a -> 'raw', 'null'::jsonb)
	from jsonb_array_elements(p_result -> 'assessments') a;

	if p_result ? 'phash' then
		insert into audit.image_hashes (dataset_id, ortho_sha256, method, hash, run_id)
		values (v_run.dataset_id, v_sha, p_result -> 'phash' ->> 'method', (p_result -> 'phash' ->> 'value')::bigint, p_run_id)
		on conflict do nothing;
	end if;

	update audit.runs set
		status = 'done',
		inputs = coalesce(p_result -> 'inputs', inputs),
		evidence = coalesce(p_result -> 'evidence', evidence),
		coverage = coalesce(p_result -> 'coverage', coverage),
		cost = coalesce(p_result -> 'cost', cost),
		error = null,
		started_at = coalesce(started_at, now()),
		finished_at = now()
	where id = p_run_id;

	if v_run.queue <> 'benchmark' then
		insert into audit.current_runs (dataset_id, check_key, run_id)
		values (v_run.dataset_id, 'dataset_evaluation', p_run_id)
		on conflict (dataset_id, check_key) do update set run_id = excluded.run_id, updated_at = now();
	end if;
end;
$$;
revoke all on function audit.store_dataset_evaluation(bigint, jsonb) from public, anon;
grant execute on function audit.store_dataset_evaluation(bigint, jsonb) to authenticated, service_role;

-- The evaluation crops are CLIP tiles. Tile rows are otherwise readable only for
-- search-ready public datasets, so the worker could not place crops on private or
-- unfinished ones. It already reads those datasets' COGs; now also their tile rows.
create policy "Audit worker reads tile windows" on public.v2_tile_embeddings
	for select to authenticated using (internal.is_audit_worker());
