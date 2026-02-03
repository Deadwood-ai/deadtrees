-- RLS hardening and public-safe views (DT-197 / DT-164)

-- Enable RLS for public-facing tables
alter table "public"."newsletter" enable row level security;
alter table "public"."collaborators" enable row level security;

-- Remove duplicate newsletter emails (case-insensitive) before adding unique index
delete from "public"."newsletter" n
using "public"."newsletter" dup
where n.id > dup.id
  and lower(n.email) = lower(dup.email);

-- Enforce unique emails (case-insensitive)
create unique index if not exists "newsletter_email_unique_idx"
  on "public"."newsletter" (lower(email));

-- Newsletter policies: public insert only, service role full access
drop policy if exists "Newsletter public insert" on "public"."newsletter";
drop policy if exists "Newsletter service role all" on "public"."newsletter";

create policy "Newsletter public insert"
on "public"."newsletter"
as permissive
for insert
to public
with check (true);

create policy "Newsletter service role all"
on "public"."newsletter"
as permissive
for all
to service_role
using (true)
with check (true);

-- Collaborators: service role only (frontend no longer uses this table)
drop policy if exists "Collaborators service role all" on "public"."collaborators";

create policy "Collaborators service role all"
on "public"."collaborators"
as permissive
for all
to service_role
using (true)
with check (true);

-- Dataset audit access: auditors + processor only
drop policy if exists "Allow all for processor" on "public"."dataset_audit";
drop policy if exists "Dataset audit select for auditors" on "public"."dataset_audit";
drop policy if exists "Dataset audit write for auditors" on "public"."dataset_audit";

create policy "Dataset audit select for auditors"
on "public"."dataset_audit"
as permissive
for select
to public
using (
  can_audit()
  or (auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text
);

create policy "Dataset audit write for auditors"
on "public"."dataset_audit"
as permissive
for all
to public
using (
  can_audit()
  or (auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text
)
with check (
  can_audit()
  or (auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text
);

-- Restrict audit view to auditors only (emails exposed there)
drop view if exists "public"."dataset_audit_user_info";
create or replace view "public"."dataset_audit_user_info" as
select
  da.dataset_id,
  da.audit_date,
  da.is_georeferenced,
  da.has_valid_acquisition_date,
  da.acquisition_date_notes,
  da.has_valid_phenology,
  da.phenology_notes,
  da.deadwood_quality,
  da.deadwood_notes,
  da.forest_cover_quality,
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
  au.email as audited_by_email,
  uu.email as uploaded_by_email,
  ru.email as reviewed_by_email
from dataset_audit da
left join auth.users au on da.audited_by = au.id
left join v2_datasets d on da.dataset_id = d.id
left join auth.users uu on d.user_id = uu.id
left join auth.users ru on da.reviewed_by = ru.id
where (
  can_audit()
  or (auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text
);

grant select on table "public"."dataset_audit_user_info" to "authenticated";
grant select on table "public"."dataset_audit_user_info" to "service_role";

-- Restrict contributor emails to auditors only
drop view if exists "public"."dataset_contributor_info";
create or replace view "public"."dataset_contributor_info" as
select
  d.id as dataset_id,
  u.email as contributor_email
from v2_datasets d
left join auth.users u on d.user_id = u.id
where (
  can_audit()
  or (auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text
);

grant select on table "public"."dataset_contributor_info" to "authenticated";
grant select on table "public"."dataset_contributor_info" to "service_role";

-- Public dataset view: remove email exposure, keep audit summary fields
drop view if exists "public"."v2_full_dataset_view_public";

create or replace view "public"."v2_full_dataset_view_public" as
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
  base.is_audited,
  base.has_error,
  base.error_message,
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
  audit_data.final_assessment,
  audit_data.deadwood_quality,
  audit_data.forest_cover_quality,
  audit_data.has_major_issue,
  audit_data.audit_date,
  audit_data.has_valid_phenology,
  audit_data.has_valid_acquisition_date,
  case
    when audit_data.deadwood_quality in ('great', 'sentinel_ok') then true
    else false
  end as show_deadwood_predictions,
  case
    when audit_data.forest_cover_quality in ('great', 'sentinel_ok') then true
    else false
  end as show_forest_cover_predictions
from v2_full_dataset_view base
left join (
  select
    da.dataset_id,
    da.final_assessment,
    da.deadwood_quality::text,
    da.forest_cover_quality::text,
    da.has_major_issue,
    da.audit_date,
    da.has_valid_phenology,
    da.has_valid_acquisition_date
  from dataset_audit da
) audit_data on audit_data.dataset_id = base.id
where (
  (audit_data.final_assessment is null)
  or (audit_data.final_assessment <> 'exclude_completely'::text)
)
and base.archived = false;

grant select on table "public"."v2_full_dataset_view_public" to "anon";
grant select on table "public"."v2_full_dataset_view_public" to "authenticated";
grant select on table "public"."v2_full_dataset_view_public" to "service_role";
