-- Grant API + processor access to v2_aois.
--
-- v2_aois was created in 20250201000002_label_tables.sql without explicit
-- GRANTs, relying on Supabase's legacy default privileges that auto-granted
-- data access to the API roles. Newer Supabase default privileges grant the
-- API roles only TRUNCATE/REFERENCES/TRIGGER, so on a clean `supabase db reset`
-- v2_aois ends up unreadable (anon/authenticated SELECT -> HTTP 403) and the
-- processor cannot write the auto-generated AOI. These statements are
-- idempotent (GRANT is a no-op if already present) and match the table's
-- existing RLS policies, so they are safe to apply in every environment.

grant select on table public.v2_aois to anon, authenticated;
grant insert, update, delete on table public.v2_aois to authenticated;
grant all on table public.v2_aois to service_role;
grant usage, select on sequence public.v2_aois_id_seq to authenticated, service_role;

drop policy if exists "Allow public read access to AOIs" on public.v2_aois;
create policy "Allow public read access to AOIs"
  on public.v2_aois
  for select
  to public
  using (
    exists (
      select 1
      from public.v2_datasets d
      where d.id = dataset_id
        and (
          d.data_access <> 'private'::access
          or auth.uid() = d.user_id
          or can_view_all_private_data()
          or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
        )
        and (
          d.archived = false
          or auth.uid() = d.user_id
        )
        and (
          auth.uid() = d.user_id
          or can_view_all_private_data()
          or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
          or not internal.is_dataset_excluded_from_public_surface(d.id)
        )
    )
  );

-- Tighten the original owner-only AOI write policies so authenticated users can
-- only write AOIs for datasets they own, datasets they may audit, or processor
-- automation. Without the dataset authorization check, any logged-in user could
-- insert a newer AOI row for any public dataset and shadow the displayed AOI.
drop policy if exists "Allow authenticated users to create AOIs" on public.v2_aois;
create policy "Allow authenticated users to create AOIs"
  on public.v2_aois
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

drop policy if exists "Allow users to update their own AOIs" on public.v2_aois;
create policy "Allow users to update their own AOIs"
  on public.v2_aois
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

-- The automatic AOI task (aoi_segmentation_v1) replaces its own previously
-- generated AOI on rerun. Without a DELETE policy, RLS silently drops the
-- delete (0 rows) and reruns would accumulate duplicate auto AOIs. Allow users
-- to delete their own AOIs (the processor owns the rows it writes).
drop policy if exists "Allow users to delete their own AOIs" on public.v2_aois;
create policy "Allow users to delete their own AOIs"
  on public.v2_aois
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
      or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
    )
  );
