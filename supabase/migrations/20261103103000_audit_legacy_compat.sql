-- The saved audits move behind a view (DT-1481, part 2 of the audit base).
--
-- dataset_audit becomes dataset_audit_legacy, and a view named dataset_audit with the
-- same columns reads it, so every reader and the audit page keep working unchanged. The
-- view is a plain projection, so Postgres updates it automatically: the audit page's
-- inserts, updates and upserts reach the table, its triggers (the audit lease guard,
-- the date decision) fire as before and, because the view runs as the caller, its row
-- policies decide as before. The six views compiled against the table stay bound to
-- it and read the same rows; functions that name dataset_audit now read it through the
-- view. Later the view can be pointed at the audit tables without touching a reader.
--
-- audit.current_runs also gets its version guard: a pointer to a run of an inactive
-- version is not written. Only new and changed pointers are checked; existing ones,
-- activating a version and deleting pointers are untouched.
set local lock_timeout = '5s';

alter table public.dataset_audit rename to dataset_audit_legacy;

create view public.dataset_audit
with (security_invoker = true)
as
select * from public.dataset_audit_legacy;

comment on view public.dataset_audit is
	'The saved audits (DT-1481). Reads and writes reach dataset_audit_legacy; readers keep this name.';

-- the same privileges the table had; the table's row policies apply through the view.
-- The monitoring role keeps its ten-column grant on the table and reads it there: a
-- view that runs as the caller needs every column of the table, and notes stay closed.
grant select, insert, update, delete on public.dataset_audit to anon, authenticated, service_role;
grant select on public.dataset_audit to analyst;

-- A run of an inactive version never becomes the current run. Writers may point
-- unconditionally (the georef store function does): such a write is skipped, not
-- refused, so a check keeps storing its runs while its version waits for activation.
-- A benchmark run is still refused outright.
create or replace function internal.reject_benchmark_current_run()
returns trigger
language plpgsql set search_path = ''
as $$
declare
	v_queue text;
	v_active boolean;
begin
	select r.queue, v.is_active into v_queue, v_active
	from audit.runs r join audit.check_versions v on v.id = r.check_version_id
	where r.id = new.run_id;
	if v_queue = 'benchmark' then
		raise exception 'A benchmark run never becomes the current run' using errcode = '23514';
	end if;
	if not coalesce(v_active, false) then
		return null;  -- only a run of the active version counts
	end if;
	return new;
end;
$$;
