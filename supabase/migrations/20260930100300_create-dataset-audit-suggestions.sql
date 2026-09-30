-- Machine suggestions that prefill the audit form without completing the audit.
--
-- Any automated stage can propose a value for a dataset_audit form field
-- (field = the dataset_audit column / form field name). The audit page fills
-- empty fields from here and marks them as suggested; nothing becomes an audit
-- until an auditor saves the form. Suggestions never change a saved audit;
-- the date decision lifecycle (acquisition_date_decisions) decides when a
-- saved date check is deactivated and needs a new look. One suggestion per
-- field: a rerun (or another source) replaces it.
create table if not exists public.dataset_audit_suggestions (
  dataset_id bigint not null references public.v2_datasets (id) on delete cascade,
  field text not null check (field ~ '^[a-z][a-z0-9_]*$'),
  value jsonb not null,
  source text not null,            -- e.g. 'doy_estimation_v1'
  reason text,                     -- short machine-readable reason, e.g. 'mismatch'
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- when the suggested value last changed (a rerun that repeats the same value
  -- keeps it); a saved audit older than this may need a re-review
  changed_at timestamptz not null default now(),
  primary key (dataset_id, field)
);

create or replace function public.track_audit_suggestion_change()
returns trigger language plpgsql set search_path = '' as $$
begin
    if new.value is distinct from old.value then
        new.changed_at := now();
    else
        new.changed_at := old.changed_at;
    end if;
    return new;
end;
$$;
drop trigger if exists track_audit_suggestion_change on public.dataset_audit_suggestions;
create trigger track_audit_suggestion_change
before update on public.dataset_audit_suggestions
for each row execute function public.track_audit_suggestion_change();

grant select, insert, update, delete on table public.dataset_audit_suggestions to authenticated;
grant all on table public.dataset_audit_suggestions to service_role;

alter table public.dataset_audit_suggestions enable row level security;

drop policy if exists "Auditors and processor read audit suggestions" on public.dataset_audit_suggestions;
create policy "Auditors and processor read audit suggestions"
  on public.dataset_audit_suggestions
  for select
  to authenticated
  using (
    public.can_audit()
    or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
  );

drop policy if exists "Processor writes audit suggestions" on public.dataset_audit_suggestions;
create policy "Processor writes audit suggestions"
  on public.dataset_audit_suggestions
  for all
  to authenticated
  using ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
  with check ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text);

grant select on public.dataset_audit_suggestions to analyst;
drop policy if exists analyst_select on public.dataset_audit_suggestions;
create policy analyst_select on public.dataset_audit_suggestions for select to analyst using (true);
