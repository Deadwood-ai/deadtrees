-- Restore processor/authenticated write access to the label + geometry tables.
--
-- These tables already grant anon/authenticated SELECT, but their write access
-- (INSERT/UPDATE/DELETE) relied on Supabase's legacy default privileges, which
-- auto-granted data access to the API roles. Newer Supabase default privileges
-- grant the API roles only TRUNCATE/REFERENCES/TRIGGER, so on a clean
-- `supabase db reset` the processor (role: authenticated) hits
-- 42501 "permission denied for table v2_labels" when writing model predictions.
--
-- The matching RLS policies (INSERT "Allow authenticated users to create …",
-- UPDATE "… update their own …", DELETE "Enable delete for processor") already
-- exist; these GRANTs are the missing prerequisite. They are idempotent and
-- match the access the tables already had in older environments, so they are
-- safe to apply everywhere (no-op where the grant already exists).

grant insert, update, delete on table public.v2_labels to authenticated;
grant insert, update on table public.v2_deadwood_geometries to authenticated;
grant insert, update on table public.v2_forest_cover_geometries to authenticated;
