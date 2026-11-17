-- Operators take a crop or a dataset out of the open benchmark version again (DT-1488), the
-- mirror of audit.add_benchmark_target. See docs/audit-checks.md, Benchmarks.
--
-- A frozen version never changes (the member guard refuses), so only the check's open version
-- loses the target. A crop id removes that crop; a null crop id removes the dataset's own row
-- and, in a crop benchmark, every crop of the dataset. Removing what is not there removes
-- nothing. The labels stay in audit.assessments, so adding the target again brings them back;
-- the crop keeps its 'benchmark' crop set, which earlier versions may still use. Returns the
-- member rows it removed. Operators only.
set local lock_timeout = '5s';

create function audit.remove_benchmark_target(p_check_key text, p_dataset_id bigint, p_crop_id bigint default null)
returns setof audit.benchmark_members
language plpgsql security definer set search_path = ''
as $$
declare
	v_benchmark bigint;
begin
	if not public.can_operate() then
		raise exception 'Only operators remove benchmark targets' using errcode = '42501';
	end if;
	-- held until commit, so the version cannot be frozen under the delete
	select id into v_benchmark from audit.benchmarks
	where check_key = p_check_key and frozen_at is null
	for share;
	if v_benchmark is null then
		raise exception 'Check % has no open benchmark version', p_check_key using errcode = 'P0002';
	end if;
	return query
	delete from audit.benchmark_members
	where benchmark_id = v_benchmark
	  and dataset_id = p_dataset_id
	  and (p_crop_id is null or crop_id = p_crop_id)
	returning *;
end;
$$;

revoke all on function audit.remove_benchmark_target(text, bigint, bigint) from public, anon;
grant execute on function audit.remove_benchmark_target(text, bigint, bigint) to authenticated, service_role;
