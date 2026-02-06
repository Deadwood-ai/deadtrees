alter table public.data_publication
	add column if not exists published_at timestamp with time zone;
