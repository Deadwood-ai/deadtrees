-- Sign-up deletes a new account again when its confirmation email could not be
-- sent, so a retry is an ordinary sign-up. The delete must not touch an account
-- that was confirmed or used in the meantime (another request may have sent a
-- working link), so it is one conditional statement instead of the admin API.

begin;

set local lock_timeout = '5s';

create function public.discard_unconfirmed_signup(p_user_id uuid)
returns boolean
language sql volatile security definer set search_path = ''
as $$
	with discarded as (
		delete from auth.users account
		where account.id = p_user_id
			and account.email_confirmed_at is null
			and account.last_sign_in_at is null
		returning account.id
	)
	select exists (select 1 from discarded);
$$;

revoke all on function public.discard_unconfirmed_signup(uuid) from public, anon, authenticated;
grant execute on function public.discard_unconfirmed_signup(uuid) to service_role;

commit;
