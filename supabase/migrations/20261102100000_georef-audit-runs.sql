-- The georeferencing check writes into the audit check base (DT-1485, docs/audit-checks.md).
--
-- store_georef_check keeps writing v2_georef_checks (the audit page reads it until it
-- moves to the audit schema) and, in the same transaction, now also
--   - registers the check version (review_all, inactive) on first use: one version per
--     rules and matcher version, named '<rules_version>_<model_version>';
--   - stores a done run with the per-reference evidence and the judged ortho;
--   - points audit.current_runs at it;
--   - adds one dataset-level model assessment (layer georef): good = ok, poor = major,
--     uncertain = unsure. Georef has one model row per run, so it needs no dataset rule.
-- The is_georeferenced suggestion takes the source 'audit:georef/<version>'; the
-- suggestions of the checks made so far are renamed, and those checks are copied into
-- the audit tables as backfill runs.

set local lock_timeout = '5s';

drop function public.store_georef_check(jsonb, jsonb);

create function internal.georef_check_version(p_rules_version text, p_model_version text)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
	v_version text := p_rules_version || '_' || p_model_version;
	v_config jsonb := jsonb_build_object('rules_version', p_rules_version, 'model_version', p_model_version);
	v_id bigint;
begin
	insert into audit.check_versions (check_key, version, config)
	values ('georef', v_version, v_config)
	on conflict (check_key, version) do nothing;
	select id into strict v_id from audit.check_versions
	where check_key = 'georef' and version = v_version and config @> v_config;
	return v_id;
end;
$$;

-- One audit run, its current-run pointer and its model assessment for a stored check.
create function internal.store_georef_audit_run(p_dataset_id bigint, p_queue text)
returns text
language plpgsql
set search_path = ''
as $$
declare
	v_check public.v2_georef_checks;
	v_version_id bigint;
	v_run_id bigint;
begin
	select * into strict v_check from public.v2_georef_checks where dataset_id = p_dataset_id;
	v_version_id := internal.georef_check_version(v_check.rules_version, v_check.model_version);
	insert into audit.runs (check_key, check_version_id, dataset_id, queue, status, inputs, evidence, finished_at, started_at)
	values (
		'georef', v_version_id, p_dataset_id, p_queue, 'done',
		jsonb_strip_nulls(jsonb_build_object(
			'ortho_sha256', (select o.sha256 from public.v2_orthos o where o.dataset_id = p_dataset_id))),
		jsonb_build_object(
			'reference_evidence', v_check.reference_evidence,
			'reference_errors', v_check.reference_errors,
			'metadata', v_check.metadata),
		v_check.updated_at, v_check.updated_at
	)
	returning id into v_run_id;
	insert into audit.current_runs (dataset_id, check_key, run_id)
	values (p_dataset_id, 'georef', v_run_id)
	on conflict (dataset_id, check_key) do update set run_id = excluded.run_id, updated_at = now();
	insert into audit.assessments (check_key, dataset_id, run_id, layer, assessor_kind, model, prompt_version, verdict, details)
	values (
		'georef', p_dataset_id, v_run_id, 'georef', 'model', v_check.model_version, v_check.rules_version,
		case v_check.decision when 'good' then 'ok' when 'poor' then 'major' else 'unsure' end::audit.verdict,
		jsonb_strip_nulls(jsonb_build_object(
			'decision', v_check.decision,
			'evidence_level', v_check.evidence_level,
			'reason', v_check.reason,
			'p90_m', v_check.p90_m,
			'evidence_groups', v_check.evidence_groups,
			'support', v_check.support,
			'edge_support', v_check.edge_support,
			'used_aoi', v_check.used_aoi))
	);
	return 'audit:georef/' || v_check.rules_version || '_' || v_check.model_version;
end;
$$;

revoke all on function internal.georef_check_version(text, text) from public, anon, authenticated;
revoke all on function internal.store_georef_audit_run(bigint, text) from public, anon, authenticated;

create function public.store_georef_check(p_check jsonb, p_suggestion jsonb, p_queue text default 'upload')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_dataset bigint := (p_check ->> 'dataset_id')::bigint;
	v_source text;
begin
	if not internal.is_audit_worker() then
		raise exception 'Only the processor stores georeferencing checks' using errcode = '42501';
	end if;
	insert into public.v2_georef_checks
	-- the column defaults for keys the caller leaves out (populate_record would null them)
	select * from jsonb_populate_record(
		null::public.v2_georef_checks,
		'{"evidence_groups": 0, "support": 0, "edge_support": 0, "used_aoi": false, "reference_evidence": [], "reference_errors": {}, "metadata": {}}'::jsonb
			|| p_check || jsonb_build_object('created_at', now(), 'updated_at', now()))
	on conflict (dataset_id) do update set
		model_version = excluded.model_version,
		rules_version = excluded.rules_version,
		decision = excluded.decision,
		evidence_level = excluded.evidence_level,
		reason = excluded.reason,
		p90_m = excluded.p90_m,
		evidence_groups = excluded.evidence_groups,
		support = excluded.support,
		edge_support = excluded.edge_support,
		used_aoi = excluded.used_aoi,
		reference_evidence = excluded.reference_evidence,
		reference_errors = excluded.reference_errors,
		metadata = excluded.metadata,
		updated_at = excluded.updated_at;
	v_source := internal.store_georef_audit_run(v_dataset, p_queue);
	if p_suggestion is null or jsonb_typeof(p_suggestion) = 'null' then
		delete from public.dataset_audit_suggestions
		where dataset_id = v_dataset and field = 'is_georeferenced'
			and (source like 'audit:georef/%' or source = 'georef_check_v1');
	else
		insert into public.dataset_audit_suggestions (dataset_id, field, value, source, reason, details, updated_at)
		values (v_dataset, 'is_georeferenced', p_suggestion -> 'value', v_source, p_suggestion ->> 'reason',
				coalesce(p_suggestion -> 'details', '{}'::jsonb), now())
		on conflict (dataset_id, field) do update set
			value = excluded.value,
			source = excluded.source,
			reason = excluded.reason,
			details = excluded.details,
			updated_at = excluded.updated_at;
	end if;
end;
$$;
revoke all on function public.store_georef_check(jsonb, jsonb, text) from public, anon;
grant execute on function public.store_georef_check(jsonb, jsonb, text) to authenticated, service_role;

-- The checks made so far: one backfill run each, and their suggestions under the new source.
do $$
declare
	v_dataset bigint;
	v_source text;
begin
	for v_dataset in select dataset_id from public.v2_georef_checks order by dataset_id loop
		v_source := internal.store_georef_audit_run(v_dataset, 'backfill');
		update public.dataset_audit_suggestions
		set source = v_source
		where dataset_id = v_dataset and field = 'is_georeferenced' and source = 'georef_check_v1';
	end loop;
end;
$$;
