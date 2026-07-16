-- Privilege assignments are authorization data. They may be read by the user
-- they describe, but only the processor/service role may create or mutate them.
-- The former unrestricted authenticated INSERT policy allowed self-promotion.

-- Merge any legacy duplicate rows before enforcing one assignment per user.
with merged as (
  select
    user_id,
    min(id) as keep_id,
    min(created_at) as created_at,
    bool_or(coalesce(can_upload_private, false)) as can_upload_private,
    bool_or(coalesce(can_audit, false)) as can_audit,
    bool_or(coalesce(can_view_all_private, false)) as can_view_all_private
  from public.privileged_users
  group by user_id
)
update public.privileged_users p
set
  created_at = m.created_at,
  can_upload_private = m.can_upload_private,
  can_audit = m.can_audit,
  can_view_all_private = m.can_view_all_private
from merged m
where p.id = m.keep_id;

delete from public.privileged_users duplicate
using public.privileged_users keeper
where duplicate.user_id = keeper.user_id
  and duplicate.id > keeper.id;

update public.privileged_users
set
  can_audit = coalesce(can_audit, false),
  can_view_all_private = coalesce(can_view_all_private, false);

alter table public.privileged_users alter column can_audit set default false;
alter table public.privileged_users alter column can_audit set not null;
alter table public.privileged_users alter column can_view_all_private set default false;
alter table public.privileged_users alter column can_view_all_private set not null;

create unique index privileged_users_user_id_key
  on public.privileged_users using btree (user_id);

drop policy if exists "Enable delete for users based on user id or processor"
  on public.privileged_users;
drop policy if exists "Enable insert for authenticated users only"
  on public.privileged_users;
drop policy if exists "Enable read access for all users based on user id or processor"
  on public.privileged_users;

revoke all on table public.privileged_users from anon;
revoke truncate, references, trigger on table public.privileged_users from authenticated;
grant select, insert, update, delete on table public.privileged_users to authenticated;

create policy "Users read their own privileges and processor reads all"
on public.privileged_users
as permissive
for select
to authenticated
using (
  auth.uid() = user_id
  or (auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
);

create policy "Processor inserts privilege assignments"
on public.privileged_users
as permissive
for insert
to authenticated
with check ((auth.jwt() ->> 'email') = 'processor@deadtrees.earth');

create policy "Processor updates privilege assignments"
on public.privileged_users
as permissive
for update
to authenticated
using ((auth.jwt() ->> 'email') = 'processor@deadtrees.earth')
with check ((auth.jwt() ->> 'email') = 'processor@deadtrees.earth');

create policy "Processor deletes privilege assignments"
on public.privileged_users
as permissive
for delete
to authenticated
using ((auth.jwt() ->> 'email') = 'processor@deadtrees.earth');
