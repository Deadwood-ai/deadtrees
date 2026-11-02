-- Only runs of the active georef version move audit.current_runs (DT-1485), as in the
-- audit worker: a version that is not active shadow-runs. The version the checks so far
-- ran on, georef-rules-v1_romav2.0.1, becomes the active one (Janusch, 2026-11-02), so its
-- 154 current runs stay in audit.review_queue in review_all.

set local lock_timeout = '5s';

-- One audit run and its model assessment for a stored check; the current-run pointer
-- moves only for the active version.
create or replace function internal.store_georef_audit_run(p_dataset_id bigint, p_queue text)
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
	-- only the active version's results count (docs/audit-checks.md); other versions shadow-run
	if (select is_active from audit.check_versions where id = v_version_id) then
		insert into audit.current_runs (dataset_id, check_key, run_id)
		values (p_dataset_id, 'georef', v_run_id)
		on conflict (dataset_id, check_key) do update set run_id = excluded.run_id, updated_at = now();
	end if;
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

update audit.check_versions
set is_active = true
where check_key = 'georef' and version = 'georef-rules-v1_romav2.0.1'
	and not exists (select 1 from audit.check_versions where check_key = 'georef' and is_active);
