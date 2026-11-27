-- Prepare runs: a check's images without the models (DT-1627).
--
-- A run in the prepare queue goes through its check with no models: it stores the tiles and
-- images and no answers, costs no model calls and never counts as the dataset's result. It
-- gives the benchmarks their images for evaluating them outside the platform. A benchmark
-- tick (DT-1624) now queues a prepare run; a full run's images serve as well.
set local lock_timeout = '5s';

alter table audit.runs drop constraint runs_queue_check,
	add constraint runs_queue_check check (queue in ('upload', 'manual', 'backfill', 'prepare'));

-- The run that counts: the newest finished run of the active version, else of the newest
-- finished version. A prepare run holds no answers and never counts.
create or replace view audit.current_runs
with (security_invoker = true)
as
select distinct on (r.dataset_id, r.check_key)
	r.dataset_id, r.check_key, r.id as run_id, r.version_id, cr.id as rules_id, cr.config as rules,
	r.inputs, r.finished_at, v.is_active as is_active_version
from audit.runs r
join audit.check_versions v on v.id = r.version_id
left join audit.check_rules cr on cr.version_id = r.version_id and cr.is_active
where r.status = 'done' and r.queue <> 'prepare'
order by r.dataset_id, r.check_key, v.is_active desc, r.finished_at desc, r.id desc;

-- An open or finished run of the version stands in for a new one: any run for a prepare run
-- (a full run stores the images too), a full run for a full run.
create or replace function internal.queue_runs(p_check_key text, p_dataset_ids bigint[], p_queue text, p_again boolean)
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
				and (p_queue = 'prepare' or r.queue <> 'prepare')
				and (r.status in ('queued', 'running') or (r.status = 'done' and not p_again))
		);
	get diagnostics v_queued = row_count;
	return v_queued;
end;
$$;

create or replace function internal.queue_benchmark_evaluation()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
	if exists (select 1 from audit.check_versions v where v.check_key = 'dataset_evaluation' and v.is_active) then
		perform internal.queue_runs('dataset_evaluation', array[new.dataset_id], 'prepare', false);
	end if;
	return null;
end;
$$;
