-- Reference-patch validation and its propagation to parent patches in one transaction.
--
-- The editor used to write a patch, read its siblings and write the parent and
-- grandparent in separate requests without checking their errors. A failed or
-- racing request left a validated child under a stale parent, and exports and
-- factory metrics count validated patches from these flags.
--
-- SECURITY INVOKER: the reference_patches policies still decide who may write
-- (auditors only). The function adds no privilege.

create or replace function public.set_reference_patch_validation(
	p_patch_id bigint,
	p_layers text[],
	p_value boolean
)
returns public.reference_patches
language plpgsql
security invoker
set search_path = ''
as $$
declare
	v_id bigint := p_patch_id;
	v_parent_id bigint;
	v_ancestors bigint[] := '{}';
	v_depth integer := 0;
	v_patch public.reference_patches;
begin
	if p_layers is null or cardinality(p_layers) = 0
		or not (p_layers <@ array['deadwood', 'forest_cover']) then
		raise exception 'Layers must be deadwood and/or forest_cover' using errcode = '22023';
	end if;

	-- Lock the patch and its ancestors, always child first, so concurrent
	-- validations of sibling patches recompute their shared parent one at a time.
	while v_id is not null loop
		select rp.parent_tile_id into v_parent_id
		from public.reference_patches rp
		where rp.id = v_id
		for update;
		if not found then
			raise exception 'Reference patch % not found', v_id using errcode = '42501';
		end if;
		if v_id <> p_patch_id then
			v_ancestors := v_ancestors || v_id;
		end if;
		v_depth := v_depth + 1;
		if v_depth > 10 then
			raise exception 'Reference patch hierarchy of % is too deep', p_patch_id using errcode = '22023';
		end if;
		v_id := v_parent_id;
	end loop;

	update public.reference_patches rp
	set
		deadwood_validated = case when 'deadwood' = any(p_layers) then p_value else rp.deadwood_validated end,
		forest_cover_validated = case when 'forest_cover' = any(p_layers) then p_value else rp.forest_cover_validated end,
		updated_at = now()
	where rp.id = p_patch_id
	returning rp.* into v_patch;
	if not found then
		raise exception 'Reference patch % is not writable', p_patch_id using errcode = '42501';
	end if;

	-- A parent is validated once every child is: good only when all children are
	-- good, bad when any child is bad, and unvalidated while any child is.
	foreach v_id in array v_ancestors loop
		update public.reference_patches parent
		set
			deadwood_validated = case when 'deadwood' = any(p_layers) then children.deadwood else parent.deadwood_validated end,
			forest_cover_validated = case when 'forest_cover' = any(p_layers) then children.forest_cover else parent.forest_cover_validated end,
			updated_at = now()
		from (
			select
				case when bool_or(child.deadwood_validated is null) then null else bool_and(child.deadwood_validated) end as deadwood,
				case when bool_or(child.forest_cover_validated is null) then null else bool_and(child.forest_cover_validated) end as forest_cover
			from public.reference_patches child
			where child.parent_tile_id = v_id
		) children
		where parent.id = v_id;
		if not found then
			raise exception 'Reference patch % is not writable', v_id using errcode = '42501';
		end if;
	end loop;

	return v_patch;
end;
$$;

revoke all on function public.set_reference_patch_validation(bigint, text[], boolean) from public, anon;
grant execute on function public.set_reference_patch_validation(bigint, text[], boolean) to authenticated;
