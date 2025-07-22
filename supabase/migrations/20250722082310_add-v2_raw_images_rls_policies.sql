create policy "Enable insert for authenticated users only"
on "public"."v2_raw_images"
as permissive
for insert
to authenticated
with check (true);

create policy "Enable read access for all users"
on "public"."v2_raw_images"
as permissive
for select
to public
using (true);

create policy "Enable update for processor"
on "public"."v2_raw_images"
as permissive
for update
to public
using (((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text))
with check (((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)); 