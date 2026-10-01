-- Insert one very large label geometry with a longer statement budget.
--
-- Geometry chunks are inserted through PostgREST under the authenticated role's
-- 8s statement_timeout, and a timed-out batch is split down to single rows. One
-- polygon can still exceed that budget on its own: the combined model produced
-- a forest-cover polygon with ~4.8M vertices (28 MB) for a large ortho, and its
-- single-row insert was cancelled after hours of inference. This function inserts
-- one geometry for the caller, under the caller's RLS insert policies, with a
-- bounded budget below the client's 120s limit. PostgREST >=12.2 hoists the
-- function setting before executing the RPC (as for activate_tile_embeddings).

create function public.insert_large_label_geometry(
	p_label_id bigint,
	p_geometry text,
	p_properties jsonb default null
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
begin
	select label_data::text into v_label_data from public.v2_labels where id = p_label_id;
	if not found then
		raise exception 'Label % not found.', p_label_id using errcode = 'P0002';
	end if;

	if v_label_data = 'deadwood' then
		insert into public.v2_deadwood_geometries (label_id, geometry, properties)
		values (p_label_id, p_geometry::geometry, p_properties);
	elsif v_label_data = 'forest_cover' then
		insert into public.v2_forest_cover_geometries (label_id, geometry, properties)
		values (p_label_id, p_geometry::geometry, p_properties);
	else
		raise exception 'Label % has no geometry table for label_data %.', p_label_id, v_label_data
			using errcode = '22023';
	end if;
end;
$$;

comment on function public.insert_large_label_geometry(bigint, text, jsonb) is
	'Inserts one oversized label geometry (hex EWKB) under the caller''s RLS with a 90s statement budget.';

revoke all on function public.insert_large_label_geometry(bigint, text, jsonb) from public, anon;
grant execute on function public.insert_large_label_geometry(bigint, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
