-- Email suggestions in the share dialog, as in 3Dtrees (search_resource_access_users_v1).
--
-- People who manage a dataset's access can look up registered accounts by part of
-- their email. Like 3Dtrees this searches every account, so it is an account
-- directory for dataset admins; three characters, twenty results and sixty searches
-- a minute per user keep it from being a bulk export.

-- The foreign key briefly locks auth.users; fail fast instead of queueing sign-ups.
set local lock_timeout = '5s';

create schema if not exists internal;

create table internal.account_search_usage (
	user_id uuid primary key references auth.users (id) on delete cascade,
	window_started_at timestamptz not null default now(),
	search_count integer not null default 1
);
revoke all on table internal.account_search_usage from public, anon, authenticated;

create function public.search_dataset_share_accounts(p_dataset_id bigint, p_query text)
returns table (email text)
language plpgsql volatile security definer set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_query text := lower(btrim(coalesce(p_query, '')));
	v_search_count integer;
begin
	if v_actor is null or not internal.caller_manages_access(p_dataset_id) then
		raise exception 'Dataset not found' using errcode = 'P0002';
	end if;
	if char_length(v_query) < 3 then
		return;
	end if;

	insert into internal.account_search_usage as usage (user_id)
	values (v_actor)
	on conflict (user_id) do update
	set window_started_at = case when usage.window_started_at <= now() - interval '1 minute'
			then now() else usage.window_started_at end,
		search_count = case when usage.window_started_at <= now() - interval '1 minute'
			then 1 else usage.search_count + 1 end
	returning usage.search_count into v_search_count;
	if v_search_count > 60 then
		raise exception 'Too many searches. Please wait a minute.' using errcode = '54000', hint = 'rate_limited';
	end if;

	-- The caller and the owner cannot be given access, so they are never suggested.
	return query
	select account.email::text
	from auth.users account
	where account.email is not null
		and position(v_query in lower(account.email)) > 0
		and account.id <> v_actor
		and account.id <> (select dataset.user_id from public.v2_datasets dataset where dataset.id = p_dataset_id)
	order by starts_with(lower(account.email), v_query) desc, lower(account.email)
	limit 20;
end;
$$;

revoke all on function public.search_dataset_share_accounts(bigint, text) from public, anon, authenticated;
grant execute on function public.search_dataset_share_accounts(bigint, text) to authenticated;
