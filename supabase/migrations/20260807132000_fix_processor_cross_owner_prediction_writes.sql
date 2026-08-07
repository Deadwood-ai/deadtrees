-- Processor predictions are owned by the dataset contributor, not by the
-- processor auth user. Keep contributor/auditor ownership checks separate from
-- the processor automation path so cross-owner prediction writes are allowed
-- without broadening normal authenticated-user access.

drop policy if exists "Allow authenticated users to create labels" on public.v2_labels;
create policy "Allow authenticated users to create labels"
  on public.v2_labels
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and (
      exists (
        select 1
        from public.v2_datasets d
        where d.id = dataset_id
          and d.user_id = auth.uid()
      )
      or can_audit()
    )
  );

drop policy if exists "Allow users to update their own labels" on public.v2_labels;
create policy "Allow users to update their own labels"
  on public.v2_labels
  for update
  to authenticated
  using (
    auth.uid() = user_id
    and (
      exists (
        select 1
        from public.v2_datasets d
        where d.id = dataset_id
          and d.user_id = auth.uid()
      )
      or can_audit()
    )
  )
  with check (
    auth.uid() = user_id
    and (
      exists (
        select 1
        from public.v2_datasets d
        where d.id = dataset_id
          and d.user_id = auth.uid()
      )
      or can_audit()
    )
  );

drop policy if exists "Allow users to delete their own labels" on public.v2_labels;
create policy "Allow users to delete their own labels"
  on public.v2_labels
  for delete
  to authenticated
  using (
    auth.uid() = user_id
    and (
      exists (
        select 1
        from public.v2_datasets d
        where d.id = dataset_id
          and d.user_id = auth.uid()
      )
      or can_audit()
    )
  );

drop policy if exists "Processor manages labels" on public.v2_labels;
create policy "Processor manages labels"
  on public.v2_labels
  for all
  to authenticated
  using (
    label_source = 'model_prediction'
    and (auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
  )
  with check (
    label_source = 'model_prediction'
    and (auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
  );

drop policy if exists "Allow authenticated users to create deadwood geometries"
  on public.v2_deadwood_geometries;
create policy "Allow authenticated users to create deadwood geometries"
  on public.v2_deadwood_geometries
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.v2_labels l
      join public.v2_datasets d on d.id = l.dataset_id
      where l.id = label_id
        and l.user_id = auth.uid()
        and (d.user_id = auth.uid() or can_audit())
    )
  );

drop policy if exists "Allow users to update their own deadwood geometries"
  on public.v2_deadwood_geometries;
create policy "Allow users to update their own deadwood geometries"
  on public.v2_deadwood_geometries
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.v2_labels l
      join public.v2_datasets d on d.id = l.dataset_id
      where l.id = label_id
        and l.user_id = auth.uid()
        and (d.user_id = auth.uid() or can_audit())
    )
  )
  with check (
    exists (
      select 1
      from public.v2_labels l
      join public.v2_datasets d on d.id = l.dataset_id
      where l.id = label_id
        and l.user_id = auth.uid()
        and (d.user_id = auth.uid() or can_audit())
    )
  );

drop policy if exists "Processor manages deadwood geometries"
  on public.v2_deadwood_geometries;
create policy "Processor manages deadwood geometries"
  on public.v2_deadwood_geometries
  for all
  to authenticated
  using (
    (auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
    and exists (
      select 1
      from public.v2_labels l
      where l.id = label_id
        and l.label_source = 'model_prediction'
    )
  )
  with check (
    (auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
    and exists (
      select 1
      from public.v2_labels l
      where l.id = label_id
        and l.label_source = 'model_prediction'
    )
  );

drop policy if exists "Allow authenticated users to create forest cover geometries"
  on public.v2_forest_cover_geometries;
create policy "Allow authenticated users to create forest cover geometries"
  on public.v2_forest_cover_geometries
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.v2_labels l
      join public.v2_datasets d on d.id = l.dataset_id
      where l.id = label_id
        and l.user_id = auth.uid()
        and (d.user_id = auth.uid() or can_audit())
    )
  );

drop policy if exists "Allow users to update their own forest cover geometries"
  on public.v2_forest_cover_geometries;
create policy "Allow users to update their own forest cover geometries"
  on public.v2_forest_cover_geometries
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.v2_labels l
      join public.v2_datasets d on d.id = l.dataset_id
      where l.id = label_id
        and l.user_id = auth.uid()
        and (d.user_id = auth.uid() or can_audit())
    )
  )
  with check (
    exists (
      select 1
      from public.v2_labels l
      join public.v2_datasets d on d.id = l.dataset_id
      where l.id = label_id
        and l.user_id = auth.uid()
        and (d.user_id = auth.uid() or can_audit())
    )
  );

drop policy if exists "Processor manages forest cover geometries"
  on public.v2_forest_cover_geometries;
create policy "Processor manages forest cover geometries"
  on public.v2_forest_cover_geometries
  for all
  to authenticated
  using (
    (auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
    and exists (
      select 1
      from public.v2_labels l
      where l.id = label_id
        and l.label_source = 'model_prediction'
    )
  )
  with check (
    (auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
    and exists (
      select 1
      from public.v2_labels l
      where l.id = label_id
        and l.label_source = 'model_prediction'
    )
  );

-- Rolling-deploy compatibility: old processors omit source and rely on the
-- trigger to identify their AOIs as machine predictions.
create or replace function public.normalize_legacy_processor_aoi_source()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.source = 'manual'
    and (auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
  then
    new.source := 'ml_prediction';
  end if;

  return new;
end;
$$;

drop policy if exists "Allow authenticated users to create AOIs" on public.v2_aois;
create policy "Allow authenticated users to create AOIs"
  on public.v2_aois
  for insert
  to authenticated
  with check (
    source in ('manual', 'manual_correction')
    and auth.uid() = user_id
    and (
      exists (
        select 1
        from public.v2_datasets d
        where d.id = dataset_id
          and d.user_id = auth.uid()
      )
      or can_audit()
    )
  );

drop policy if exists "Allow processor and owners to delete AOIs" on public.v2_aois;
drop policy if exists "Allow users to delete their own AOIs" on public.v2_aois;
create policy "Allow users to delete their own AOIs"
  on public.v2_aois
  for delete
  to authenticated
  using (
    source in ('manual', 'manual_correction')
    and auth.uid() = user_id
    and (
      exists (
        select 1
        from public.v2_datasets d
        where d.id = dataset_id
          and d.user_id = auth.uid()
      )
      or can_audit()
    )
  );

drop policy if exists "Processor manages prediction AOIs" on public.v2_aois;
create policy "Processor manages prediction AOIs"
  on public.v2_aois
  for all
  to authenticated
  using (
    source = 'ml_prediction'
    and (auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
  )
  with check (
    source = 'ml_prediction'
    and (auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
  );
