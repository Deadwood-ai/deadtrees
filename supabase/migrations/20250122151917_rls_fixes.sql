create policy "Enable delete for owners and processor"
on "public"."v2_datasets"
as permissive
for delete
to public
using (((auth.uid() = user_id) OR ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)));


create policy "Enable insert for authenticated users only"
on "public"."v2_datasets"
as permissive
for insert
to authenticated
with check (true);


create policy "Enable read access for all users"
on "public"."v2_datasets"
as permissive
for select
to public
using (true);


create policy "Enable update for users based on email"
on "public"."v2_datasets"
as permissive
for update
to public
using (((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text))
with check (((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text));



