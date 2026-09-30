-- Publication requests are created in one transaction, and FreiDATA records when
-- an upload started.
--
-- PublicationModal used to insert the publication, each author, each author link
-- and each dataset link as separate requests. A failure part-way left a
-- publication with missing authors or datasets that freidata/ would still pick
-- up, and every retry added duplicate author rows.
--
-- SECURITY INVOKER: the insert policies from 20260930120000 still decide what the
-- caller may write (their own pending publication, their own author records,
-- links only to datasets they own). The function adds no privilege.

create or replace function public.create_data_publication(
	p_title text,
	p_description text,
	p_authors jsonb,
	p_dataset_ids bigint[]
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
	v_uid uuid := auth.uid();
	v_publication_id bigint;
	v_author jsonb;
	v_author_id bigint;
	v_dataset_ids bigint[];
	v_dataset_id bigint;
begin
	if v_uid is null then
		raise exception 'Sign in to create a publication' using errcode = '42501';
	end if;
	if p_authors is null or jsonb_typeof(p_authors) <> 'array' or jsonb_array_length(p_authors) = 0 then
		raise exception 'A publication needs at least one author' using errcode = '22023';
	end if;

	select array_agg(distinct d order by d) into v_dataset_ids from unnest(p_dataset_ids) d where d is not null;
	if v_dataset_ids is null then
		raise exception 'A publication needs at least one dataset' using errcode = '22023';
	end if;

	-- A dataset belongs to at most one publication that has no DOI yet (the lock
	-- the profile dataset table shows). Serialise concurrent requests per dataset.
	foreach v_dataset_id in array v_dataset_ids loop
		perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('create_data_publication'), v_dataset_id::integer);
	end loop;
	select l.dataset_id into v_dataset_id
	from public.jt_data_publication_datasets l
	join public.data_publication p on p.id = l.publication_id
	where l.dataset_id = any(v_dataset_ids) and p.doi is null
	limit 1;
	if found then
		raise exception 'Dataset % is already in a publication request', v_dataset_id using errcode = '23505';
	end if;

	insert into public.data_publication (title, description, user_id)
	values (p_title, p_description, v_uid)
	returning id into v_publication_id;

	for v_author in select value from jsonb_array_elements(p_authors) loop
		if coalesce(btrim(v_author->>'first_name'), '') = ''
			or coalesce(btrim(v_author->>'last_name'), '') = ''
			or coalesce(btrim(v_author->>'organisation'), '') = '' then
			raise exception 'Every author needs a first name, last name and organisation' using errcode = '22023';
		end if;

		insert into public.user_info ("user", first_name, last_name, organisation, orcid, title)
		values (
			v_uid,
			btrim(v_author->>'first_name'),
			btrim(v_author->>'last_name'),
			btrim(v_author->>'organisation'),
			nullif(btrim(v_author->>'orcid'), ''),
			nullif(btrim(v_author->>'title'), '')
		)
		returning id into v_author_id;

		insert into public.jt_data_publication_user_info (publication_id, user_info_id)
		values (v_publication_id, v_author_id);
	end loop;

	insert into public.jt_data_publication_datasets (publication_id, dataset_id)
	select v_publication_id, d from unnest(v_dataset_ids) d;

	return v_publication_id;
end;
$$;

revoke all on function public.create_data_publication(text, text, jsonb, bigint[]) from public, anon;
grant execute on function public.create_data_publication(text, text, jsonb, bigint[]) to authenticated;

-- freidata/ marks a publication 'uploading' while it works on it. The start time
-- lets the next cron run tell an interrupted upload from a running one.
alter table public.data_publication add column if not exists upload_started_at timestamp with time zone;
