-- Let requeue_dataset_processing accept the georeferencing check stage
-- (georef_check_v1) and reset its done flag on a failed dataset's rerun.
-- Unchanged otherwise from 20260930160200_requeue_dataset_processing_rpc.sql.
set local lock_timeout = '5s';

create or replace function public.requeue_dataset_processing(
	p_dataset_id bigint,
	p_task_types text[],
	p_priority integer default 2
)
returns public.v2_queue
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
	v_uid uuid := auth.uid();
	-- Keep in sync with shared.models.TaskTypeEnum (canonical names only; the API
	-- maps legacy aliases before calling). api/tests/db/test_requeue_dataset_processing.py pins it.
	v_known_task_types constant text[] := array[
		'odm_processing', 'geotiff', 'metadata', 'cog', 'thumbnail', 'deadwood_v1', 'treecover_v1',
		'deadwood_treecover_combined_v2', 'aoi_v1', 'embeddings_v1', 'doy_estimation_v1', 'georef_check_v1'
	];
	v_dataset public.v2_datasets;
	v_can_view_all boolean := public.can_view_all_private_data();
	v_status_count integer;
	v_status public.v2_statuses;
	v_requires_aoi boolean := 'aoi_v1' = any(p_task_types);
	v_task public.v2_queue;
begin
	if v_uid is null then
		raise exception 'Sign-in required to process a dataset.' using errcode = '42501';
	end if;
	if coalesce(cardinality(p_task_types), 0) = 0 then
		raise exception 'At least one task type must be specified' using errcode = '22023';
	end if;
	if exists (select 1 from unnest(p_task_types) t where t is null or t <> all(v_known_task_types)) then
		raise exception 'Invalid task type in %', p_task_types using errcode = '22023';
	end if;
	if p_priority is null or p_priority not between 1 and 5 then
		raise exception 'Priority must be between 1 and 5, got %', p_priority using errcode = '22023';
	end if;

	-- The dataset row always exists (status rows may not), so it serializes
	-- concurrent requeues of one dataset.
	select * into v_dataset from public.v2_datasets where id = p_dataset_id for no key update;
	-- Same visibility as the v2_datasets read policy: hidden datasets are "not found".
	if not found or not (v_dataset.data_access <> 'private'::access or v_dataset.user_id = v_uid or v_can_view_all) then
		raise exception 'Dataset <ID=%> not found.', p_dataset_id using errcode = 'P0002';
	end if;
	if v_dataset.user_id <> v_uid and not v_can_view_all then
		raise exception 'Only the dataset owner or a privileged user can process it.' using errcode = '42501';
	end if;

	-- A worker claims a waiting row with a conditional update; holding the row
	-- locks makes that claim either commit before this check or find the row gone.
	perform 1 from public.v2_queue where dataset_id = p_dataset_id for update;
	if exists (
		select 1 from public.v2_queue
		where dataset_id = p_dataset_id and (is_processing or claimed_by is not null)
	) then
		raise exception 'Dataset % is currently being processed. Please stop the active processing container (or wait for completion), then retry.', p_dataset_id
			using errcode = '55006';
	end if;

	select count(*) into v_status_count
	from (select 1 from public.v2_statuses where dataset_id = p_dataset_id for update) locked;
	if v_status_count > 1 then
		raise exception 'Dataset % has % status rows; expected at most one.', p_dataset_id, v_status_count;
	end if;
	select * into v_status from public.v2_statuses where dataset_id = p_dataset_id;

	if v_status_count = 1 then
		if v_status.current_status <> 'idle' and not v_status.has_error then
			raise exception 'Dataset % is currently being processed. Please wait for processing to complete, then retry.', p_dataset_id
				using errcode = '55006';
		end if;

		-- A failed dataset restarts from idle, and every requested stage is redone.
		if v_status.has_error then
			update public.v2_statuses set
				has_error = false,
				error_message = null,
				error_stage = null,
				current_status = 'idle',
				is_odm_done = is_odm_done and not ('odm_processing' = any(p_task_types)),
				is_ortho_done = is_ortho_done and not ('geotiff' = any(p_task_types)),
				is_metadata_done = is_metadata_done and not ('metadata' = any(p_task_types)),
				is_cog_done = is_cog_done and not ('cog' = any(p_task_types)),
				is_thumbnail_done = is_thumbnail_done and not ('thumbnail' = any(p_task_types)),
				is_deadwood_done = is_deadwood_done and not ('deadwood_v1' = any(p_task_types)),
				is_forest_cover_done = is_forest_cover_done and not ('treecover_v1' = any(p_task_types)),
				is_combined_model_done = is_combined_model_done and not ('deadwood_treecover_combined_v2' = any(p_task_types)),
				is_aoi_done = is_aoi_done and not ('aoi_v1' = any(p_task_types)),
				is_embeddings_done = is_embeddings_done and not ('embeddings_v1' = any(p_task_types)),
				is_doy_estimation_done = is_doy_estimation_done and not ('doy_estimation_v1' = any(p_task_types)),
				is_georef_check_done = is_georef_check_done and not ('georef_check_v1' = any(p_task_types))
			where dataset_id = p_dataset_id;
		end if;

		-- A partial rerun must not drop an outstanding AOI requirement.
		update public.v2_statuses
		set is_aoi_required = is_aoi_required or v_requires_aoi
		where dataset_id = p_dataset_id;
	elsif v_requires_aoi then
		insert into public.v2_statuses (dataset_id, is_aoi_required) values (p_dataset_id, true);
	end if;

	delete from public.v2_queue where dataset_id = p_dataset_id;

	insert into public.v2_queue (dataset_id, user_id, task_types, priority, is_processing)
	values (p_dataset_id, v_uid, p_task_types, p_priority, false)
	returning * into v_task;
	return v_task;
end;
$$;

