-- A georeferencing review no longer depends on the ortho file (DT-1612).
--
-- A review counts while its evidence key matches the current one. For the georeferencing it
-- was the ortho's sha256, so every geotiff rerun (re-standardising the same image) made a
-- reviewer's passed / not passed stale and asked again. The answer is about where the dataset
-- lies, which a rerun keeps: its key is now the constant 'dataset', and the existing georef
-- reviews get it too, so none goes stale at this change. The dataset evaluation keeps the
-- ortho key; the acquisition date keeps the estimate's advice.
set local lock_timeout = '5s';

create or replace function internal.audit_evidence_key(p_dataset_id bigint, p_check_key text)
returns text
language sql stable security definer set search_path = ''
as $$
	select case p_check_key
		when 'acquisition_date' then (
			select case when (audit.acquisition_date_output_v1(e) ->> 'replace')::boolean then 'replace' else 'keep' end
			from public.v2_acquisition_date_estimates e
			where e.dataset_id = p_dataset_id)
		when 'georef' then 'dataset'
		else (select o.sha256 from public.v2_orthos o where o.dataset_id = p_dataset_id)
	end;
$$;

update audit.dataset_human_reviews set evidence_key = 'dataset' where check_key = 'georef';
