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

-- The automatic AOI task (aoi_segmentation_v1) replaces its own previously
-- generated AOI on rerun. Without a DELETE policy, RLS silently drops the
-- delete (0 rows) and reruns would accumulate duplicate auto AOIs. Allow users
-- to delete their own AOIs (the processor owns the rows it writes).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'v2_aois'
      and policyname = 'Allow users to delete their own AOIs'
  ) then
    create policy "Allow users to delete their own AOIs"
      on public.v2_aois
      for delete
      to authenticated
      using (auth.uid() = user_id);
  end if;
end $$;
