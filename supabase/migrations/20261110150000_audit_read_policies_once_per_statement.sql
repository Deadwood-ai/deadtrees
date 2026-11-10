-- Auditors' reads of the audit schema timed out (DT-1532): the read policies called
-- internal.can_read_audit_checks() for every row, about 35,000 assessment rows per
-- statement, so audit.disagreements and wide reads of audit.latest_assessments ran
-- into the 8 s statement timeout. Wrapped in a scalar subquery the planner evaluates
-- the function once per statement. The rule itself is unchanged: the same function,
-- the same roles, no row gains or loses access.
--
-- The three FOR ALL policies of the worker and operators also apply to reads, so
-- their USING side gets the same form; their WITH CHECK side stays as it is.

set local lock_timeout = '5s';

do $$
declare
	p record;
begin
	for p in
		select tablename, policyname, qual
		from pg_policies
		where schemaname = 'audit'
			and cmd in ('SELECT', 'ALL')
			and qual in ('internal.can_read_audit_checks()', 'internal.is_audit_worker()', 'can_operate()', 'public.can_operate()')
		order by tablename, policyname
	loop
		execute format(
			'alter policy %I on audit.%I using ((select %s))',
			p.policyname, p.tablename,
			case p.qual when 'can_operate()' then 'public.can_operate()' else p.qual end
		);
	end loop;
end
$$;
