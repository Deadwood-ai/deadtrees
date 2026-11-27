-- Only the owner and audit readers learn why a dataset was excluded (DT-1628).
--
-- 20261126233000 (DT-1614) added evaluation_reason to the dataset audit summary for the owner's
-- status panel, assuming excluded datasets are off the public surface. They are not: every
-- non-private dataset stays readable, and get_dataset_audit_summary is granted to anon, so anyone
-- with a public dataset's ID could read its exclusion reason. The rest of the summary (decision,
-- georeferencing, date, prediction quality and the model's reasoning) is what the public dataset
-- page shows and stays as it is. evaluation_reason now reads null unless the caller owns the
-- dataset or can read audit checks (auditors, operators, the audit worker).
set local lock_timeout = '5s';

-- Owner-run, so anon can ask without being able to call internal.can_read_audit_checks itself.
create function internal.can_read_audit_reason(p_owner uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
	select auth.uid() is not null and (auth.uid() = p_owner or internal.can_read_audit_checks());
$$;
revoke all on function internal.can_read_audit_reason(uuid) from public;
grant execute on function internal.can_read_audit_reason(uuid) to anon, authenticated, service_role;

-- Caller-run: the dataset row is read under its own policies, so a dataset the caller cannot
-- see has no summary (null).
create or replace function public.get_dataset_audit_summary(p_dataset_id bigint)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
	select case
		when s is null or internal.can_read_audit_reason(d.user_id) then s
		else jsonb_set(s, '{evaluation_reason}', 'null'::jsonb)
	end
	from public.v2_datasets d
	cross join lateral internal.dataset_audit_summary(d.id) s
	where d.id = p_dataset_id;
$$;
revoke all on function public.get_dataset_audit_summary(bigint) from public;
grant execute on function public.get_dataset_audit_summary(bigint) to anon, authenticated, service_role;
