-- Prospective, notification-independent submission measurements. No historical
-- timestamps are inferred from mutable output records or current status flags.
begin;
create table public.factory_measurement_epoch (
  singleton boolean primary key default true check(singleton),
  started_at timestamptz not null default clock_timestamp()
);
insert into public.factory_measurement_epoch default values;
create table public.factory_submissions (
  dataset_id bigint primary key references public.v2_datasets(id) on delete cascade,
  uploaded_at timestamptz not null,
  workflow text not null check(workflow in ('geotiff','odm')),
  input_bytes bigint check(input_bytes>0),
  first_ready_at timestamptz,
  check(first_ready_at is null or first_ready_at>=uploaded_at)
);
create table public.factory_failure_episodes (
  id bigint generated always as identity primary key,
  dataset_id bigint not null references public.factory_submissions(dataset_id) on delete cascade,
  failed_at timestamptz not null default clock_timestamp(),
  recovered_at timestamptz,
  check(recovered_at is null or recovered_at>=failed_at)
);
create unique index factory_one_open_failure on public.factory_failure_episodes(dataset_id) where recovered_at is null;
create index factory_first_ready on public.factory_submissions(first_ready_at);
create index factory_uploaded on public.factory_submissions(uploaded_at);
create index factory_failure_time on public.factory_failure_episodes(failed_at);
create index factory_recovery_time on public.factory_failure_episodes(recovered_at);
alter table public.factory_measurement_epoch enable row level security;
alter table public.factory_submissions enable row level security;
alter table public.factory_failure_episodes enable row level security;
revoke all on public.factory_measurement_epoch,public.factory_submissions,public.factory_failure_episodes from public,anon,authenticated;

alter table public.v2_statuses add column uploaded_input_bytes bigint check(uploaded_input_bytes>0);
comment on column public.v2_statuses.uploaded_input_bytes is 'Original uploaded file bytes from the API filesystem stat; not output MB. Frozen in factory_submissions on first upload completion.';

create function public.factory_observe_status() returns trigger
language plpgsql security definer set search_path='' as $$
declare d public.v2_datasets; observed_at timestamptz := clock_timestamp();
begin
 select * into d from public.v2_datasets where id=new.dataset_id;
 -- Old datasets, including reuploads and reruns, cannot acquire invented first
 -- upload times. Coverage begins only for registrations after instrumentation.
 if d.created_at < (select started_at from public.factory_measurement_epoch) then return new; end if;
 if new.is_upload_done and (tg_op='INSERT' or not old.is_upload_done) then
   insert into public.factory_submissions(dataset_id,uploaded_at,workflow,input_bytes)
   values(new.dataset_id,observed_at,case when lower(d.file_name) like '%.zip' then 'odm' else 'geotiff' end,new.uploaded_input_bytes)
   on conflict(dataset_id) do nothing;
 end if;
 if not exists(select 1 from public.factory_submissions where dataset_id=new.dataset_id) then return new; end if;
 if new.has_error and (tg_op='INSERT' or not old.has_error) then
   insert into public.factory_failure_episodes(dataset_id,failed_at) values(new.dataset_id,observed_at)
   on conflict(dataset_id) where recovered_at is null do nothing;
 end if;
 if public.factory_status_ready(new,d.file_name) then
   update public.factory_submissions set first_ready_at=observed_at where dataset_id=new.dataset_id and first_ready_at is null;
   -- Clearing an error alone is not recovery: the whole readiness rule must pass.
   update public.factory_failure_episodes set recovered_at=observed_at where dataset_id=new.dataset_id and recovered_at is null;
 end if;
 return new;
end;
$$;
revoke all on function public.factory_observe_status() from public,anon,authenticated;
create trigger factory_observe_status after insert or update on public.v2_statuses
for each row execute function public.factory_observe_status();
commit;
