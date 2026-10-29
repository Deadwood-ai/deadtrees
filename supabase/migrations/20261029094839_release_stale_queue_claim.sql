-- Release a queue claim whose processor stopped sending heartbeats (DT-1471).
-- A worker that dies without its shutdown handler (host offline, hard kill)
-- keeps its v2_queue claim, and requeue_dataset_processing refuses claimed rows.
-- This frees the claim and resets the status in one transaction, only when the
-- claiming worker has been silent for 15 minutes. The task keeps its task
-- types and priority and is picked up again by the next free worker.
--
-- Older processors write seen_at only between tasks, so a busy one looks
-- silent. Processors that beat every minute, also mid-task, write the same
-- time to continuous_seen_at. A claim is released only when the worker's last
-- heartbeat came from such a processor (both columns equal); a worker on an
-- older release, or rolled back to one, is never released.
set local lock_timeout = '5s';

alter table public.processor_heartbeats add column continuous_seen_at timestamptz;
comment on column public.processor_heartbeats.continuous_seen_at is
	'Set to seen_at by processors that send heartbeats while they process (DT-1471); release_stale_queue_claim requires it.';

create or replace function public.release_stale_queue_claim(p_dataset_id bigint)
returns public.v2_queue
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
	v_uid uuid := auth.uid();
	v_silent_for constant interval := interval '15 minutes';
	v_task public.v2_queue;
	v_worker text;
	v_seen_at timestamptz;
	v_continuous_seen_at timestamptz;
	v_claims integer;
begin
	if v_uid is null then
		raise exception 'Sign-in required to release a processor claim.' using errcode = '42501';
	end if;
	if not (public.can_view_all_private_data() or (auth.jwt() ->> 'email') = 'processor@deadtrees.earth') then
		raise exception 'Only the processor or a privileged user can release a processor claim.' using errcode = '42501';
	end if;

	-- Lock the claimed row so its worker cannot finish or release it meanwhile.
	select count(*) into v_claims
	from (select 1 from public.v2_queue where dataset_id = p_dataset_id and claimed_by is not null for update) locked;
	if v_claims = 0 then
		raise exception 'Dataset % has no claimed queue task.', p_dataset_id using errcode = 'P0002';
	end if;
	if v_claims > 1 then
		raise exception 'Dataset % has % claimed queue tasks; expected one.', p_dataset_id, v_claims;
	end if;
	select * into v_task from public.v2_queue where dataset_id = p_dataset_id and claimed_by is not null;

	v_worker := v_task.claimed_by;

	select seen_at, continuous_seen_at into v_seen_at, v_continuous_seen_at
	from public.processor_heartbeats where worker_id = v_worker;
	if v_seen_at is null or v_continuous_seen_at is distinct from v_seen_at then
		raise exception 'Worker % does not send heartbeats while processing, so its silence proves nothing; check the host before changing the claim.',
			v_worker
			using errcode = '55006';
	end if;
	if v_task.claimed_at > now() - v_silent_for or v_seen_at > now() - v_silent_for then
		raise exception 'Worker % last sent a heartbeat at %; a claim is released only after % of silence.',
			v_worker, v_seen_at, v_silent_for
			using errcode = '55006';
	end if;

	update public.v2_queue
	set is_processing = false, claimed_by = null, claimed_at = null
	where id = v_task.id
	returning * into v_task;

	-- A failed dataset keeps its error; the processor's normal path handles it.
	update public.v2_statuses
	set current_status = 'idle'
	where dataset_id = p_dataset_id and not has_error;

	insert into public.v2_logs (level, message, origin, user_id, dataset_id, category, extra)
	values (
		'WARNING',
		format('Released queue task %s from silent worker %s (last heartbeat %s)', v_task.id, v_worker, v_seen_at),
		'release_stale_queue_claim',
		v_uid,
		p_dataset_id,
		'process',
		jsonb_build_object('event', 'claim_released', 'queue_id', v_task.id, 'worker_id', v_worker, 'last_heartbeat_at', v_seen_at)
	);
	return v_task;
end;
$$;

revoke all on function public.release_stale_queue_claim(bigint) from public, anon;
grant execute on function public.release_stale_queue_claim(bigint) to authenticated;
