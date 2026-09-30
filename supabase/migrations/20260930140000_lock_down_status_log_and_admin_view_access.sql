-- Status rows, processing logs and admin read models were open to every role.
--
-- * v2_statuses: any signed-in user could insert a status row for any dataset,
--   and nothing kept one row per dataset.
-- * v2_logs: anyone, without a login, could read every log line (private
--   dataset ids, file names, errors, user ids); any signed-in user could write
--   log lines for any dataset, which the factory metrics treat as evidence.
-- * v_export_polygon_candidates (every prediction polygon, evaluated with the
--   view owner's rights) was readable without a login.
-- * The remaining older SECURITY DEFINER functions had no pinned search_path.

-- Statuses ---------------------------------------------------------------------

-- Production holds exactly one row per dataset; keep it that way.
alter table public.v2_statuses
	add constraint v2_statuses_dataset_id_key unique (dataset_id);

revoke insert, update, delete, truncate on table public.v2_statuses from anon;

-- The processor, the dataset owner (upload) and auditors (reference-patch
-- session locks) create status rows.
drop policy if exists "Enable insert for authenticated users only" on public.v2_statuses;
create policy "Owners, auditors and the processor create status rows"
on public.v2_statuses for insert to authenticated
with check (
	(select auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
	or (select public.can_audit())
	or exists (
		select 1 from public.v2_datasets d
		where d.id = dataset_id and d.user_id = (select auth.uid())
	)
);

-- Queue inserts are already limited to owners and privileged users.
revoke insert, update, delete, truncate on table public.v2_queue from anon;

-- Logs ---------------------------------------------------------------------------

revoke insert, update, delete, truncate on table public.v2_logs from anon;
revoke update, truncate on table public.v2_logs from authenticated;

-- Readers: the processor (Linear failure issues), operators, and users for their
-- own rows (the API's daily download limit counts the caller's own lines).
drop policy if exists "Enable read access for all users" on public.v2_logs;
revoke select on table public.v2_logs from anon;
create policy "Processor, operators and owners read logs"
on public.v2_logs for select to authenticated
using (
	(select auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
	or (select public.can_operate())
	or user_id = (select auth.uid())
);

-- Writers: backend services only, with the service role (shared/logging.py).
-- The factory treats these lines as evidence, so API clients cannot insert.
drop policy if exists "Enable insert for authenticated users only" on public.v2_logs;
revoke insert on table public.v2_logs from authenticated;

-- Admin read models ---------------------------------------------------------------

-- Read only by the direct-database export script.
revoke all on table public.v_export_polygon_candidates from anon, authenticated;

-- Older definer functions ---------------------------------------------------------

alter function public.update_flag_status(bigint, text, text) set search_path = public, pg_temp;
alter function public.log_dataset_changes() set search_path = public, pg_temp;
alter function public.can_view_all_private_data() set search_path = public, pg_temp;

-- update_flag_status requires an auditor; log_dataset_changes is a trigger.
-- can_view_all_private_data stays executable by anon: RLS policies call it.
revoke all on function public.update_flag_status(bigint, text, text) from public, anon;
grant execute on function public.update_flag_status(bigint, text, text) to authenticated;
revoke all on function public.log_dataset_changes() from public, anon, authenticated;
