-- Restore processor/authenticated write access to the label + geometry tables.
--
-- These tables already grant anon/authenticated SELECT, but their write access
-- (INSERT/UPDATE/DELETE) relied on Supabase's legacy default privileges, which
-- auto-granted data access to the API roles. Newer Supabase default privileges
-- grant the API roles only TRUNCATE/REFERENCES/TRIGGER, so on a clean
-- `supabase db reset` the processor (role: authenticated) hits
-- 42501 "permission denied for table v2_labels" when writing model predictions.
--
-- Tighten the matching write policies before restoring the GRANTs so users can
-- only write labels for datasets they own, datasets they may audit, or processor
-- automation.

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
      or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
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
      or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
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
      or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
    )
  );

drop policy if exists "Enable delete for processor" on public.v2_labels;
drop policy if exists "Allow users to delete their own labels" on public.v2_labels;
create policy "Allow users to delete their own labels"
  on public.v2_labels
  for delete
  to authenticated
  using (
    (
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
    or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
  );

drop policy if exists "Allow authenticated users to create label geometries" on public.v2_deadwood_geometries;
drop policy if exists "Allow authenticated users to create deadwood geometries" on public.v2_deadwood_geometries;
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
        and (
          d.user_id = auth.uid()
          or can_audit()
          or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
        )
    )
  );

drop policy if exists "Allow users to update their own label geometries" on public.v2_deadwood_geometries;
drop policy if exists "Allow users to update their own deadwood geometries" on public.v2_deadwood_geometries;
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
        and (
          d.user_id = auth.uid()
          or can_audit()
          or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
        )
    )
  )
  with check (
    exists (
      select 1
      from public.v2_labels l
      join public.v2_datasets d on d.id = l.dataset_id
      where l.id = label_id
        and l.user_id = auth.uid()
        and (
          d.user_id = auth.uid()
          or can_audit()
          or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
        )
    )
  );

drop policy if exists "Allow authenticated users to create label geometries" on public.v2_forest_cover_geometries;
drop policy if exists "Allow authenticated users to create forest cover geometries" on public.v2_forest_cover_geometries;
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
        and (
          d.user_id = auth.uid()
          or can_audit()
          or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
        )
    )
  );

drop policy if exists "Allow users to update their own label geometries" on public.v2_forest_cover_geometries;
drop policy if exists "Allow users to update their own forest cover geometries" on public.v2_forest_cover_geometries;
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
        and (
          d.user_id = auth.uid()
          or can_audit()
          or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
        )
    )
  )
  with check (
    exists (
      select 1
      from public.v2_labels l
      join public.v2_datasets d on d.id = l.dataset_id
      where l.id = label_id
        and l.user_id = auth.uid()
        and (
          d.user_id = auth.uid()
          or can_audit()
          or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
        )
    )
  );

grant insert, update, delete on table public.v2_labels to authenticated;
grant insert, update on table public.v2_deadwood_geometries to authenticated;
grant insert, update on table public.v2_forest_cover_geometries to authenticated;
grant usage, select on sequence public.v2_labels_id_seq to authenticated;
grant usage, select on sequence public.v2_deadwood_geometries_id_seq to authenticated;
grant usage, select on sequence public.v2_forest_cover_geometries_id_seq to authenticated;
