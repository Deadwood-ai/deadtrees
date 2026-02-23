set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.get_dataset_audit_with_emails(p_dataset_id integer)
 RETURNS TABLE(dataset_id integer, audit_date timestamp with time zone, is_georeferenced boolean, has_valid_acquisition_date boolean, acquisition_date_notes text, has_valid_phenology boolean, phenology_notes text, deadwood_quality text, deadwood_notes text, forest_cover_quality text, forest_cover_notes text, aoi_done boolean, has_cog_issue boolean, cog_issue_notes text, has_thumbnail_issue boolean, thumbnail_issue_notes text, audited_by uuid, notes text, has_major_issue boolean, final_assessment text, reviewed_at timestamp with time zone, reviewed_by uuid, audited_by_email text, uploaded_by_email text, reviewed_by_email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
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
		ru.email::text as reviewed_by_email
	from dataset_audit da
	left join auth.users au on da.audited_by = au.id
	left join v2_datasets d on da.dataset_id = d.id
	left join auth.users uu on d.user_id = uu.id
	left join auth.users ru on da.reviewed_by = ru.id
	where da.dataset_id = p_dataset_id::bigint;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_dataset_audits_with_emails()
 RETURNS TABLE(dataset_id integer, audit_date timestamp with time zone, is_georeferenced boolean, has_valid_acquisition_date boolean, acquisition_date_notes text, has_valid_phenology boolean, phenology_notes text, deadwood_quality text, deadwood_notes text, forest_cover_quality text, forest_cover_notes text, aoi_done boolean, has_cog_issue boolean, cog_issue_notes text, has_thumbnail_issue boolean, thumbnail_issue_notes text, audited_by uuid, notes text, has_major_issue boolean, final_assessment text, reviewed_at timestamp with time zone, reviewed_by uuid, audited_by_email text, uploaded_by_email text, reviewed_by_email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
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
		ru.email::text as reviewed_by_email
	from dataset_audit da
	left join auth.users au on da.audited_by = au.id
	left join v2_datasets d on da.dataset_id = d.id
	left join auth.users uu on d.user_id = uu.id
	left join auth.users ru on da.reviewed_by = ru.id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_dataset_contributors_with_emails()
 RETURNS TABLE(dataset_id integer, contributor_email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
	if not can_audit() then
		raise exception 'forbidden' using errcode = '42501';
	end if;

	return query
	select
		d.id::integer as dataset_id,
		u.email::text as contributor_email
	from v2_datasets d
	left join auth.users u on d.user_id = u.id;
end;
$function$
;

-- Explicitly restrict EXECUTE privileges (avoid anon surface area).
-- Authorization is enforced in-function via can_audit(); grants are defense-in-depth.
revoke execute on function public.get_dataset_audits_with_emails() from anon;
revoke execute on function public.get_dataset_contributors_with_emails() from anon;
revoke execute on function public.get_dataset_audit_with_emails(integer) from anon;
revoke execute on function public.get_user_emails(uuid[]) from anon;
revoke execute on function public.get_correction_contributors(bigint) from anon;

revoke all on function public.get_dataset_audits_with_emails() from public;
revoke all on function public.get_dataset_contributors_with_emails() from public;
revoke all on function public.get_dataset_audit_with_emails(integer) from public;
revoke all on function public.get_user_emails(uuid[]) from public;
revoke all on function public.get_correction_contributors(bigint) from public;

grant execute on function public.get_dataset_audits_with_emails() to authenticated;
grant execute on function public.get_dataset_contributors_with_emails() to authenticated;
grant execute on function public.get_dataset_audit_with_emails(integer) to authenticated;
grant execute on function public.get_user_emails(uuid[]) to authenticated;
grant execute on function public.get_correction_contributors(bigint) to authenticated;

grant execute on function public.get_dataset_audits_with_emails() to service_role;
grant execute on function public.get_dataset_contributors_with_emails() to service_role;
grant execute on function public.get_dataset_audit_with_emails(integer) to service_role;
grant execute on function public.get_user_emails(uuid[]) to service_role;
grant execute on function public.get_correction_contributors(bigint) to service_role;


