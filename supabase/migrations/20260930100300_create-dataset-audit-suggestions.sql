-- Machine suggestions that prefill the audit form without completing the audit.
--
-- Any automated stage can propose a value for a dataset_audit form field
-- (field = the dataset_audit column / form field name). The audit page fills
-- empty fields from here and marks them as suggested; nothing becomes an audit
-- until an auditor saves the form. Saved audits are never changed by a
-- suggestion; dataset_audit_suggestion_conflicts lists audits a newer
-- suggestion disagrees with, for re-review. One suggestion per field: a
-- rerun (or another source) replaces it.
create table if not exists public.dataset_audit_suggestions (
  dataset_id bigint not null references public.v2_datasets (id) on delete cascade,
  field text not null check (field ~ '^[a-z][a-z0-9_]*$'),
  value jsonb not null,
  source text not null,            -- e.g. 'doy_estimation_v1'
  reason text,                     -- short machine-readable reason, e.g. 'mismatch'
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (dataset_id, field)
);

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
