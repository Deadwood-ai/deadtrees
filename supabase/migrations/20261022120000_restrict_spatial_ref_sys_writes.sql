-- Signed-out and signed-in users may read coordinate systems but never change them (DT-1441).
begin;

set local lock_timeout = '5s';

revoke insert, update, delete, truncate, references, trigger on public.spatial_ref_sys from anon, authenticated;

do $$
begin
	if has_table_privilege('anon', 'public.spatial_ref_sys', 'INSERT, UPDATE, DELETE, TRUNCATE')
		or has_table_privilege('authenticated', 'public.spatial_ref_sys', 'INSERT, UPDATE, DELETE, TRUNCATE') then
		raise exception 'DT-1441: anon or authenticated can still change public.spatial_ref_sys; revoke as the table owner';
	end if;
end $$;

commit;
