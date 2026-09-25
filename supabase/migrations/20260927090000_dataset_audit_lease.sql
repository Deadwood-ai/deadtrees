-- Audit locks are leases owned by one auditor. They expire on the server unless
-- the open audit page renews them, so a closed tab or crashed browser cannot keep
-- a dataset "in audit". Server time decides expiry; no client clock is trusted.
--
-- v2_statuses.is_in_audit is legacy: nothing writes it any more and readers use
-- public.is_dataset_in_audit(). Existing true values are left untouched.
create table public.dataset_audit_locks (
    dataset_id bigint primary key references public.v2_datasets(id) on delete cascade,
    holder_id uuid not null references auth.users(id) on delete cascade,
    -- One open audit page; lets a page release only the lease it claimed.
    lease_id uuid not null,
    acquired_at timestamptz not null default now(),
    expires_at timestamptz not null
);
comment on table public.dataset_audit_locks is
    'Auditor lease per dataset. Active while expires_at > now(); written only through claim/release RPCs.';
comment on column public.v2_statuses.is_in_audit is
    'Legacy audit flag, no longer maintained. Use public.is_dataset_in_audit(dataset_id).';

alter table public.dataset_audit_locks enable row level security;
revoke all on table public.dataset_audit_locks from public, anon, authenticated;

create function public.is_dataset_in_audit(p_dataset_id bigint)
returns boolean language sql stable security definer set search_path = '' as $$
    select exists (
        select 1 from public.dataset_audit_locks
        where dataset_id = p_dataset_id and expires_at > now()
    )
$$;
revoke all on function public.is_dataset_in_audit(bigint) from public, anon;
grant execute on function public.is_dataset_in_audit(bigint) to authenticated;

-- Serializes lease changes with audit writes for one dataset: guarded writes hold
-- the lock shared until they commit, claim/release hold it exclusively. A lease
-- handover therefore commits strictly before or strictly after any audit write.
-- One 64-bit key per dataset keeps every bigint id inside the audit-lease namespace.
create function public.lock_dataset_audit_lease(p_dataset_id bigint, p_exclusive boolean)
returns void language plpgsql volatile set search_path = '' as $$
declare
    v_key bigint := pg_catalog.hashtextextended('dataset_audit_lease:' || p_dataset_id, 0);
begin
    if p_exclusive then
        perform pg_catalog.pg_advisory_xact_lock(v_key);
    else
        perform pg_catalog.pg_advisory_xact_lock_shared(v_key);
    end if;
end;
$$;
revoke all on function public.lock_dataset_audit_lease(bigint, boolean) from public, anon, authenticated;

-- A live lease belongs to one open audit page (lease_id). Only that page renews
-- it. A free or expired lease can be claimed by any auditor. The holder may
-- explicitly take over their own live lease from a new page (for example after
-- a browser crash); the old page then loses write access immediately.
create function public.claim_dataset_audit_lock(p_dataset_id bigint, p_lease_id uuid, p_take_over boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
    v_uid uuid := auth.uid();
    v_lock public.dataset_audit_locks;
begin
    if v_uid is null or not public.can_audit() then
        raise exception 'Audit permission required' using errcode = '42501';
    end if;
    perform public.lock_dataset_audit_lease(p_dataset_id, true);

    insert into public.dataset_audit_locks as l (dataset_id, holder_id, lease_id, acquired_at, expires_at)
    values (p_dataset_id, v_uid, p_lease_id, now(), now() + interval '10 minutes')
    on conflict (dataset_id) do update
        set holder_id = excluded.holder_id,
            lease_id = excluded.lease_id,
            acquired_at = case when l.lease_id = excluded.lease_id and l.expires_at > now()
                then l.acquired_at else now() end,
            expires_at = excluded.expires_at
        where l.expires_at <= now()
            or (l.holder_id = excluded.holder_id and (l.lease_id = excluded.lease_id or p_take_over))
    returning * into v_lock;

    if found then
        return jsonb_build_object('acquired', true, 'expires_at', v_lock.expires_at);
    end if;

    select * into v_lock from public.dataset_audit_locks where dataset_id = p_dataset_id;
    return jsonb_build_object(
        'acquired', false,
        'held_by_you', v_lock.holder_id = v_uid,
        'holder_email', (select email from auth.users where id = v_lock.holder_id),
        'retry_after_seconds', greatest(0, ceil(extract(epoch from v_lock.expires_at - now())))::integer
    );
end;
$$;
revoke all on function public.claim_dataset_audit_lock(bigint, uuid, boolean) from public, anon;
grant execute on function public.claim_dataset_audit_lock(bigint, uuid, boolean) to authenticated;

-- Releases only the caller's own lease from the page that claimed it.
create function public.release_dataset_audit_lock(p_dataset_id bigint, p_lease_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
    perform public.lock_dataset_audit_lease(p_dataset_id, true);
    delete from public.dataset_audit_locks
    where dataset_id = p_dataset_id and holder_id = auth.uid() and lease_id = p_lease_id;
end;
$$;
revoke all on function public.release_dataset_audit_lock(bigint, uuid) from public, anon;
grant execute on function public.release_dataset_audit_lock(bigint, uuid) to authenticated;

-- Audit pages send their lease id with every audit write (x-audit-lease header).
-- While a live lease exists, an auditor's insert, update or delete is accepted
-- only from that exact page, so a stale page, a second tab or a request without
-- the header cannot change or remove the audit or its manual AOI. Writes by
-- non-auditors (owner label uploads, the processor) and service-role maintenance
-- are not audit edits and are left to their existing policies.
create function public.guard_dataset_audit_lease()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
    v_row record := case when tg_op = 'DELETE' then old else new end;
    v_header text := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-audit-lease';
    v_lease uuid;
begin
    if auth.uid() is null or not public.can_audit() then
        return v_row;
    end if;
    -- Moving a row to another dataset would bypass the lease on the one it leaves.
    if tg_op = 'UPDATE' and new.dataset_id is distinct from old.dataset_id then
        raise exception 'An audit record cannot be moved to another dataset'
            using errcode = '42501';
    end if;
    if v_header ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_lease := v_header::uuid;
    end if;
    perform public.lock_dataset_audit_lease(v_row.dataset_id, false);
    if exists (
        select 1 from public.dataset_audit_locks
        where dataset_id = v_row.dataset_id and expires_at > now()
            and (holder_id is distinct from auth.uid() or lease_id is distinct from v_lease)
    ) then
        raise exception 'Dataset % is locked by another audit page', v_row.dataset_id
            using errcode = '55006';
    end if;
    return v_row;
end;
$$;
revoke all on function public.guard_dataset_audit_lease() from public, anon, authenticated;
create trigger guard_dataset_audit_lease before insert or update or delete on public.dataset_audit
for each row execute function public.guard_dataset_audit_lease();
-- Same-timing triggers fire in name order: this name sorts after
-- normalize_legacy_processor_aoi_source, so processor rows inserted without a
-- source are already ml_prediction here. Prediction AOIs are not audit edits.
create trigger validate_aoi_audit_lease before insert or update on public.v2_aois
for each row when (new.source is distinct from 'ml_prediction')
execute function public.guard_dataset_audit_lease();
create trigger validate_aoi_audit_lease_delete before delete on public.v2_aois
for each row when (old.source is distinct from 'ml_prediction')
execute function public.guard_dataset_audit_lease();

-- Flag reviews and prediction corrections are audit edits too. Guarding the rows
-- they write covers update_flag_status, save_prediction_corrections,
-- approve_correction and revert_correction; each rolls back as a whole when
-- rejected. Reporting a flag (insert) is not an audit edit.
create trigger validate_flag_audit_lease before update on public.dataset_flags
for each row execute function public.guard_dataset_audit_lease();

-- save_prediction_corrections takes the dataset id from the caller. A correction
-- must record its label's dataset, or it could dodge the lease of that dataset.
create function public.enforce_correction_label_dataset()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if new.dataset_id is distinct from (select dataset_id from public.v2_labels where id = new.label_id) then
        raise exception 'A correction must belong to the dataset of its label'
            using errcode = '23514';
    end if;
    return new;
end;
$$;
revoke all on function public.enforce_correction_label_dataset() from public, anon, authenticated;
create trigger enforce_correction_label_dataset before insert or update of dataset_id, label_id
on public.v2_geometry_corrections
for each row execute function public.enforce_correction_label_dataset();
-- Sorts after enforce_correction_label_dataset, so it checks the verified dataset.
create trigger validate_correction_audit_lease before insert or update on public.v2_geometry_corrections
for each row execute function public.guard_dataset_audit_lease();

-- Contributors see "Review in progress" only while an auditor holds a live lease.
create or replace view public.v2_full_dataset_view_owner
with (security_invoker = true, security_barrier = true) as
select
    base.id,
    base.user_id,
    base.created_at,
    base.file_name,
    base.license,
    base.platform,
    base.project_id,
    base.authors,
    base.aquisition_year,
    base.aquisition_month,
    base.aquisition_day,
    base.additional_information,
    base.data_access,
    base.citation_doi,
    base.archived,
    base.ortho_file_name,
    base.ortho_file_size,
    base.bbox,
    base.sha256,
    base.current_status,
    base.is_upload_done,
    base.is_ortho_done,
    base.is_cog_done,
    base.is_thumbnail_done,
    base.is_deadwood_done,
    base.is_forest_cover_done,
    base.is_metadata_done,
    base.is_odm_done,
    base.has_error,
    base.cog_file_name,
    base.cog_path,
    base.cog_file_size,
    base.thumbnail_file_name,
    base.thumbnail_path,
    base.admin_level_1,
    base.admin_level_2,
    base.admin_level_3,
    base.biome_name,
    base.has_labels,
    base.has_deadwood_prediction,
    base.freidata_doi,
    base.has_ml_tiles,
    base.ml_tiles_completed_at,
    base.pending_corrections_count,
    base.approved_corrections_count,
    base.rejected_corrections_count,
    base.total_corrections_count,
    base.is_combined_model_done,
    base.is_aoi_done,
    base.is_aoi_required,
    base.phenology_probability,
    review.details is not null as is_audited,
    (review.details ->> 'final_assessment') as final_assessment,
    (review.details ->> 'deadwood_quality') as deadwood_quality,
    (review.details ->> 'forest_cover_quality') as forest_cover_quality,
    (review.details ->> 'has_major_issue')::boolean as has_major_issue,
    (review.details ->> 'audit_date')::timestamptz as audit_date,
    (review.details ->> 'has_valid_phenology')::boolean as has_valid_phenology,
    (review.details ->> 'has_valid_acquisition_date')::boolean as has_valid_acquisition_date,
    coalesce(review.details ->> 'deadwood_quality' in ('great', 'sentinel_ok'), false) as show_deadwood_predictions,
    coalesce(review.details ->> 'forest_cover_quality' in ('great', 'sentinel_ok'), false) as show_forest_cover_predictions,
    status.error_stage,
    exists (
        select 1 from public.v2_labels l
        where l.dataset_id = base.id and l.label_source = 'model_prediction'
        and l.label_data = 'forest_cover'
    ) as has_forest_cover_prediction,
    public.is_dataset_in_audit(base.id) as is_in_audit,
    (review.details ->> 'has_cog_issue')::boolean as has_cog_issue,
    (review.details ->> 'has_thumbnail_issue')::boolean as has_thumbnail_issue,
    (review.details ->> 'is_georeferenced')::boolean as is_georeferenced
from public.v2_full_dataset_view base
left join public.v2_statuses status on status.dataset_id = base.id
left join lateral public.get_dataset_status_details(base.id) review(details) on true
where base.user_id = auth.uid();
