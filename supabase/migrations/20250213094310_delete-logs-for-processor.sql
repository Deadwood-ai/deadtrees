create policy "Enable delete for processor"
on "public"."v2_logs"
as permissive
for delete
to public
using (((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text));


create policy "Enable update for users based on email"
on "public"."v2_logs"
as permissive
for update
to public
using (((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text))
with check (((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text));



