-- A dataset ticked into the dataset evaluation benchmark gets a dataset evaluation run (DT-1624).
--
-- A benchmark is a tick on a review, and B in the Audit Review can tick a dataset that was never
-- evaluated: it then has no stored images to evaluate the benchmark with, here or elsewhere.
-- The tick now queues a run of the active version, as audit.queue_runs would, unless one is
-- open or done. Benchmark tiles need nothing: every one comes from a run that stored its images.
set local lock_timeout = '5s';

-- audit.queue_runs without the operator check, for the database's own callers.
create function internal.queue_runs(p_check_key text, p_dataset_ids bigint[], p_queue text, p_again boolean)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
	v_version_id bigint;
	v_queued integer;
begin
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
revoke all on function internal.queue_runs(text, bigint[], text, boolean) from public, anon, authenticated;

create or replace function audit.queue_runs(
	p_check_key text, p_dataset_ids bigint[], p_queue text default 'manual', p_again boolean default false
)
returns integer
language plpgsql security definer set search_path = ''
as $$
begin
	perform internal.require_audit_operator('queue audit runs');
	return internal.queue_runs(p_check_key, p_dataset_ids, p_queue, p_again);
end;
$$;

-- With no active version there is nothing to queue, and the label is stored all the same.
create function internal.queue_benchmark_evaluation()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
	if exists (select 1 from audit.check_versions v where v.check_key = 'dataset_evaluation' and v.is_active) then
		perform internal.queue_runs('dataset_evaluation', array[new.dataset_id], 'manual', false);
	end if;
	return null;
end;
$$;
revoke all on function internal.queue_benchmark_evaluation() from public, anon, authenticated;

-- Reviews are only inserted; taking a dataset out clears the tick, putting it back inserts a review.
create trigger queue_benchmark_evaluation
	after insert on audit.dataset_human_reviews
	for each row when (new.in_benchmark and new.check_key = 'dataset_evaluation')
	execute function internal.queue_benchmark_evaluation();
