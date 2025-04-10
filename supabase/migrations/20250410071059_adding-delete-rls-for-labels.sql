create policy "Enable delete for processor"
on "public"."v2_labels"
as permissive
for delete
to public
using (((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text));



