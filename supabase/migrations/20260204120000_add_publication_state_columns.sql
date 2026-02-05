alter table public.data_publication
	add column if not exists status text default 'pending',
	add column if not exists freidata_record_id text,
	add column if not exists notified_at timestamp with time zone;
