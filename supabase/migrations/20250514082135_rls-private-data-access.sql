drop policy "Enable read access for all users" on "public"."v2_datasets";

create policy "Enable read access for all users"
on "public"."v2_datasets"
as permissive
for select
to public
using (((data_access <> 'private'::access) OR (auth.uid() = user_id) OR ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)));



