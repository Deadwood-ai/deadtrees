-- Version 0 is an unpublished upload. Existing versions and active results are
-- untouched. Publication preserves feature IDs and correction references.
alter table public.v2_labels
  add constraint v2_labels_unpublished_inactive
  check (version <> 0 or not is_active);

create function public.publish_model_prediction_label(
  p_label_id bigint,
  p_expected_geometry_count bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  prediction public.v2_labels%rowtype;
  matching_ids bigint[];
  geometry_count bigint;
  next_version integer;
  previous_id bigint;
begin
  -- Same processor identity and table RLS as the existing prediction writer.
  if (auth.jwt() ->> 'email') is distinct from 'processor@deadtrees.earth' then
    raise insufficient_privilege using message = 'Processor authentication required';
  end if;

  select * into strict prediction from public.v2_labels where id = p_label_id;
  -- Serialize only publication for this dataset/layer, never the long upload.
  perform pg_advisory_xact_lock(hashtextextended(
    'prediction:' || prediction.dataset_id || ':' || prediction.label_data, 0
  ));
  select * into strict prediction from public.v2_labels where id = p_label_id for update;
  if prediction.label_source <> 'model_prediction'
     or jsonb_typeof(prediction.model_config) is distinct from 'object'
     or prediction.model_config = '{}'::jsonb then
    raise exception 'Expected a configured model prediction';
  end if;

  -- Retrying a committed request, even after a subsequent publication, must not
  -- increment its version or reactivate a superseded result.
  if prediction.version <> 0 then
    return to_jsonb(prediction);
  end if;

  if prediction.label_data = 'deadwood' then
    select count(*) into geometry_count from public.v2_deadwood_geometries where label_id = p_label_id;
  elsif prediction.label_data = 'forest_cover' then
    select count(*) into geometry_count from public.v2_forest_cover_geometries where label_id = p_label_id;
  else
    raise exception 'Unsupported prediction layer';
  end if;
  if p_expected_geometry_count is null or p_expected_geometry_count < 0
     or geometry_count <> p_expected_geometry_count then
    raise exception 'Prediction geometry count does not match the complete upload';
  end if;

  -- Preserve the writer's top-level key/value matching: extra metadata on an
  -- older label is allowed, but legacy null/empty configs are not replaced.
  select array_agg(l.id) into matching_ids
  from public.v2_labels l
  where l.dataset_id = prediction.dataset_id
    and l.label_data = prediction.label_data
    and l.label_source = 'model_prediction'
    and l.model_config is not null and l.model_config <> '{}'::jsonb
    and not exists (
      select 1 from jsonb_each(prediction.model_config) kv
      where coalesce(l.model_config -> kv.key, 'null'::jsonb) <> kv.value
    );

  if exists (
    select 1 from public.v2_labels
    where id = any(matching_ids) and id > p_label_id and version > 0
  ) then
    raise exception 'A newer prediction has already been published';
  end if;

  select coalesce(max(version), 0) + 1 into next_version
  from public.v2_labels where id = any(matching_ids);
  select id into previous_id from public.v2_labels
  where id = any(matching_ids) and is_active
  order by version desc, id desc limit 1;

  update public.v2_labels set is_active = false
  where id = any(matching_ids) and id <> p_label_id and is_active;
  update public.v2_labels
  set is_active = true, version = next_version, parent_label_id = previous_id
  where id = p_label_id
  returning * into prediction;
  return to_jsonb(prediction);
end;
$$;

revoke all on function public.publish_model_prediction_label(bigint, bigint) from public, anon;
grant execute on function public.publish_model_prediction_label(bigint, bigint) to authenticated;
