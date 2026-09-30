-- Replacing (v1) prediction stages publish a complete staged upload and delete
-- the superseded labels of the same model in one transaction. Until this commits
-- the previous result stays live; other models' labels are never touched.
-- Corrections reference labels without ON DELETE CASCADE, so replacing a
-- corrected label fails and rolls back instead of discarding audit edits.
create function public.replace_model_prediction_label(
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
begin
  -- Checks the processor identity, completeness and staleness, and holds the
  -- per-dataset/layer publication lock until this transaction ends.
  perform public.publish_model_prediction_label(p_label_id, p_expected_geometry_count);
  select * into strict prediction from public.v2_labels where id = p_label_id;

  -- A retried request whose result was superseded must not delete the newer one.
  if not prediction.is_active then
    return to_jsonb(prediction);
  end if;

  -- Same model (top-level key/value match), plus legacy unconfigured predictions,
  -- which the replacing stages have always owned.
  delete from public.v2_labels l
  where l.dataset_id = prediction.dataset_id
    and l.label_data = prediction.label_data
    and l.label_source = 'model_prediction'
    and l.id <> p_label_id
    and (
      l.model_config is null or l.model_config = '{}'::jsonb
      or not exists (
        select 1 from jsonb_each(prediction.model_config) kv
        where coalesce(l.model_config -> kv.key, 'null'::jsonb) <> kv.value
      )
    );

  update public.v2_labels
  set version = 1, parent_label_id = null
  where id = p_label_id
  returning * into prediction;
  return to_jsonb(prediction);
end;
$$;

revoke all on function public.replace_model_prediction_label(bigint, bigint) from public, anon;
grant execute on function public.replace_model_prediction_label(bigint, bigint) to authenticated;
