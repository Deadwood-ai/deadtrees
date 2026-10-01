-- Insert one very large prediction geometry with a longer statement budget.
--
-- Geometry chunks are inserted through PostgREST under the authenticated role's
-- 8s statement_timeout, and a timed-out batch is split down to single rows. One
-- polygon can still exceed that budget on its own: the combined model produced
-- a forest-cover polygon with ~4.8M vertices (28 MB) for a large ortho, and its
-- single-row insert was cancelled after hours of inference. This function inserts
-- one geometry into a staged (version 0) model-prediction label for the
-- processor only, under its RLS insert policies, with a bounded budget below the
-- client's 120s limit. PostgREST >=12.2 hoists the function setting before
-- executing the RPC (as for activate_tile_embeddings).
--
-- p_expected_existing_count makes a retried call idempotent: a call whose first
-- response was lost after it committed sees one more row and inserts nothing.

create function public.insert_large_label_geometry(
	p_label_id bigint,
	p_geometry text,
	p_properties jsonb,
	p_expected_existing_count bigint
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '90s'
as $$
declare
	v_label_data text;
	v_existing bigint;
begin
	if (auth.jwt() ->> 'email') is distinct from 'processor@deadtrees.earth' then
		raise exception 'Only the processor may insert large prediction geometries.' using errcode = '42501';
	end if;

	select label_data::text into v_label_data
	from public.v2_labels
	where id = p_label_id and label_source = 'model_prediction' and version = 0
	for update;
	if not found then
		raise exception 'Staged prediction label % not found.', p_label_id using errcode = 'P0002';
	end if;

	if v_label_data = 'deadwood' then
		select count(*) into v_existing from public.v2_deadwood_geometries where label_id = p_label_id;
		if v_existing = p_expected_existing_count + 1 then
			return;
		end if;
		if v_existing <> p_expected_existing_count then
			raise exception 'Label % has % geometries, expected %.', p_label_id, v_existing, p_expected_existing_count
				using errcode = '40001';
		end if;
		insert into public.v2_deadwood_geometries (label_id, geometry, properties)
		values (p_label_id, p_geometry::geometry, p_properties);
	elsif v_label_data = 'forest_cover' then
		select count(*) into v_existing from public.v2_forest_cover_geometries where label_id = p_label_id;
		if v_existing = p_expected_existing_count + 1 then
			return;
		end if;
		if v_existing <> p_expected_existing_count then
			raise exception 'Label % has % geometries, expected %.', p_label_id, v_existing, p_expected_existing_count
				using errcode = '40001';
		end if;
		insert into public.v2_forest_cover_geometries (label_id, geometry, properties)
		values (p_label_id, p_geometry::geometry, p_properties);
	else
		raise exception 'Label % has no geometry table for label_data %.', p_label_id, v_label_data
			using errcode = '22023';
	end if;
end;
$$;

comment on function public.insert_large_label_geometry(bigint, text, jsonb, bigint) is
	'Processor only: inserts one oversized geometry (hex EWKB) into a staged prediction label with a 90s statement budget.';

revoke all on function public.insert_large_label_geometry(bigint, text, jsonb, bigint) from public, anon;
grant execute on function public.insert_large_label_geometry(bigint, text, jsonb, bigint) to authenticated;

notify pgrst, 'reload schema';
