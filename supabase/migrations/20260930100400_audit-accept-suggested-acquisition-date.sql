-- Accepting a suggested acquisition date in the audit makes it the dataset's date.
--
-- accept_suggested_acquisition_date: the auditor's decision on the model's
-- suggested date (null = no suggestion or not decided). Setting it to true
-- copies v2_acquisition_date_estimates.suggested_date into v2_datasets in the
-- same transaction as the audit save (so it passes the same audit-lease guard)
-- and keeps the replaced date in original_acquisition_date. Setting it back
-- restores the original date if the dataset still carries the applied one.
-- The v2_datasets update is logged by log_dataset_changes() under the auditor.
alter table public.dataset_audit
  add column if not exists accept_suggested_acquisition_date boolean,
  add column if not exists original_acquisition_date jsonb,
  add column if not exists applied_acquisition_date jsonb;

create or replace function public.sync_accepted_acquisition_date()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
    v_est record;
    v_ds record;
begin
    if new.accept_suggested_acquisition_date is true
        and (tg_op = 'INSERT' or old.accept_suggested_acquisition_date is distinct from true) then
        select e.suggested_date, e.model_version, e.model_type, e.suggestion_reason,
               e.recorded_year, e.recorded_month, e.recorded_day
        into v_est
        from public.v2_acquisition_date_estimates e
        where e.dataset_id = new.dataset_id;
        if v_est.suggested_date is null then
            raise exception 'Dataset % has no suggested acquisition date', new.dataset_id
                using errcode = '23514';
        end if;
        select d.aquisition_year, d.aquisition_month, d.aquisition_day
        into v_ds
        from public.v2_datasets d
        where d.id = new.dataset_id
        for update;
        -- the suggestion is only valid for the date it was assessed against
        if (v_ds.aquisition_year, v_ds.aquisition_month, v_ds.aquisition_day)
            is distinct from (v_est.recorded_year, v_est.recorded_month, v_est.recorded_day) then
            raise exception 'The acquisition date of dataset % changed since the suggestion was made; rerun doy_estimation_v1', new.dataset_id
                using errcode = '40001';
        end if;
        new.original_acquisition_date := jsonb_build_object(
            'year', v_ds.aquisition_year, 'month', v_ds.aquisition_month, 'day', v_ds.aquisition_day);
        new.applied_acquisition_date := jsonb_build_object(
            'year', extract(year from v_est.suggested_date)::int,
            'month', extract(month from v_est.suggested_date)::int,
            'day', extract(day from v_est.suggested_date)::int,
            'model_version', v_est.model_version,
            'model_type', v_est.model_type,
            'reason', v_est.suggestion_reason);
        update public.v2_datasets
        set aquisition_year = extract(year from v_est.suggested_date)::smallint,
            aquisition_month = extract(month from v_est.suggested_date)::smallint,
            aquisition_day = extract(day from v_est.suggested_date)::smallint
        where id = new.dataset_id;
    elsif tg_op = 'UPDATE'
        and old.accept_suggested_acquisition_date is true
        and new.accept_suggested_acquisition_date is not true
        and old.original_acquisition_date is not null then
        update public.v2_datasets
        set aquisition_year = (old.original_acquisition_date ->> 'year')::smallint,
            aquisition_month = (old.original_acquisition_date ->> 'month')::smallint,
            aquisition_day = (old.original_acquisition_date ->> 'day')::smallint
        where id = new.dataset_id
            and aquisition_year = (old.applied_acquisition_date ->> 'year')::smallint
            and aquisition_month = (old.applied_acquisition_date ->> 'month')::smallint
            and aquisition_day = (old.applied_acquisition_date ->> 'day')::smallint;
        new.original_acquisition_date := null;
        new.applied_acquisition_date := null;
    end if;
    return new;
end;
$$;
revoke all on function public.sync_accepted_acquisition_date() from public, anon, authenticated;

-- Sorts after guard_dataset_audit_lease: a write rejected by the lease never
-- touches v2_datasets (and would roll back with it anyway).
drop trigger if exists sync_accepted_acquisition_date on public.dataset_audit;
create trigger sync_accepted_acquisition_date
before insert or update of accept_suggested_acquisition_date on public.dataset_audit
for each row execute function public.sync_accepted_acquisition_date();

-- Saved audits a current machine suggestion disagrees with (for re-review
-- after a model rerun). Fields the auditor left empty and free-text fields
-- are not compared.
create or replace view public.dataset_audit_suggestion_conflicts
with (security_invoker = true) as
select
    s.dataset_id,
    s.field,
    s.value as suggested_value,
    to_jsonb(a) -> s.field as audited_value,
    s.source,
    s.reason,
    s.updated_at as suggested_at,
    a.audit_date,
    s.updated_at > a.audit_date as suggested_after_audit
from public.dataset_audit_suggestions s
join public.dataset_audit a on a.dataset_id = s.dataset_id
where s.field not like '%notes'
    and jsonb_typeof(to_jsonb(a) -> s.field) is distinct from 'null'
    and (to_jsonb(a) -> s.field) is distinct from s.value;

grant select on public.dataset_audit_suggestion_conflicts to authenticated, service_role;

-- The audit page loads a saved audit through this RPC. It must return the new
-- columns, or the form would treat a saved "keep reported date" as empty and
-- prefill the machine suggestion over it. The return type changes, so recreate.
drop function if exists public.get_dataset_audit_with_emails(integer);
create function public.get_dataset_audit_with_emails(p_dataset_id integer)
 returns table(dataset_id integer, audit_date timestamp with time zone, is_georeferenced boolean, has_valid_acquisition_date boolean, acquisition_date_notes text, has_valid_phenology boolean, phenology_notes text, deadwood_quality text, deadwood_notes text, forest_cover_quality text, forest_cover_notes text, aoi_done boolean, has_cog_issue boolean, cog_issue_notes text, has_thumbnail_issue boolean, thumbnail_issue_notes text, audited_by uuid, notes text, has_major_issue boolean, final_assessment text, reviewed_at timestamp with time zone, reviewed_by uuid, audited_by_email text, uploaded_by_email text, reviewed_by_email text, accept_suggested_acquisition_date boolean, original_acquisition_date jsonb, applied_acquisition_date jsonb)
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
begin
	if not can_audit() then
		raise exception 'forbidden' using errcode = '42501';
	end if;

	return query
	select
		da.dataset_id::integer,
		da.audit_date,
		da.is_georeferenced,
		da.has_valid_acquisition_date,
		da.acquisition_date_notes,
		da.has_valid_phenology,
		da.phenology_notes,
		da.deadwood_quality::text,
		da.deadwood_notes,
		da.forest_cover_quality::text,
		da.forest_cover_notes,
		da.aoi_done,
		da.has_cog_issue,
		da.cog_issue_notes,
		da.has_thumbnail_issue,
		da.thumbnail_issue_notes,
		da.audited_by,
		da.notes,
		da.has_major_issue,
		da.final_assessment,
		da.reviewed_at,
		da.reviewed_by,
		au.email::text as audited_by_email,
		uu.email::text as uploaded_by_email,
		ru.email::text as reviewed_by_email,
		da.accept_suggested_acquisition_date,
		da.original_acquisition_date,
		da.applied_acquisition_date
	from dataset_audit da
	left join auth.users au on da.audited_by = au.id
	left join v2_datasets d on da.dataset_id = d.id
	left join auth.users uu on d.user_id = uu.id
	left join auth.users ru on da.reviewed_by = ru.id
	where da.dataset_id = p_dataset_id::bigint;
end;
$function$;
revoke all on function public.get_dataset_audit_with_emails(integer) from public, anon;
grant execute on function public.get_dataset_audit_with_emails(integer) to authenticated, service_role;
