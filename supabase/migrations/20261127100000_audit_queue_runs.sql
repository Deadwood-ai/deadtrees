-- Operators queue audit runs by hand (DT-1619).
--
-- While the model checks are tested, the audit worker queues nothing itself: it used to queue
-- every dataset whose status changed, which also queued reprocessed old datasets. An operator
-- queues the datasets to judge with audit.queue_runs; the worker works through them.
set local lock_timeout = '5s';

-- One queued run of the check's active version per dataset. A dataset that has an open run of
-- that version is left out, and so is one that has a finished run of it unless p_again.
-- Returns how many runs were queued.
create function audit.queue_runs(
	p_check_key text, p_dataset_ids bigint[], p_queue text default 'manual', p_again boolean default false
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
	v_version_id bigint;
	v_queued integer;
begin
	perform internal.require_audit_operator('queue audit runs');
	select v.id into v_version_id from audit.check_versions v where v.check_key = p_check_key and v.is_active;
	if v_version_id is null then
		raise exception 'Check % has no active version; switch one on first', p_check_key using errcode = '55000';
	end if;
	insert into audit.runs (check_key, version_id, dataset_id, queue)
	select p_check_key, v_version_id, d.id, p_queue
	from public.v2_datasets d
	where d.id = any (p_dataset_ids)
		and not exists (
			select 1 from audit.runs r
			where r.dataset_id = d.id and r.version_id = v_version_id
				and (r.status in ('queued', 'running') or (r.status = 'done' and not p_again))
		);
	get diagnostics v_queued = row_count;
	return v_queued;
end;
$$;
revoke all on function audit.queue_runs(text, bigint[], text, boolean) from public, anon;
grant execute on function audit.queue_runs(text, bigint[], text, boolean) to authenticated, service_role;
