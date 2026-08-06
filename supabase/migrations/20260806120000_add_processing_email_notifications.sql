begin;

drop policy "Enable insert for authenticated users only" on public.v2_queue;

create policy "Users can enqueue their own authorized processing requests"
on public.v2_queue
for insert
to authenticated
with check (
    (select auth.uid()) = user_id
    and exists (
        select 1
        from public.v2_datasets
        where v2_datasets.id = v2_queue.dataset_id
          and (
              v2_datasets.user_id = (select auth.uid())
              or public.can_view_all_private_data()
          )
    )
);

create table public.user_notification_preferences (
    user_id uuid primary key references auth.users(id) on delete cascade,
    processing_emails_enabled boolean not null default true,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now()
);

alter table public.user_notification_preferences enable row level security;

grant select, insert, update on table public.user_notification_preferences to authenticated;
grant all on table public.user_notification_preferences to service_role;
revoke all on table public.user_notification_preferences from anon;

create policy "Users can read their own notification preferences"
on public.user_notification_preferences
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their own notification preferences"
on public.user_notification_preferences
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own notification preferences"
on public.user_notification_preferences
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create table public.processing_notification_events (
    id uuid primary key default gen_random_uuid(),
    queue_task_id bigint not null,
    dataset_id bigint not null references public.v2_datasets(id) on delete cascade,
    event_type text not null check (event_type in ('processing_completed', 'processing_failed')),
    recipient_user_id uuid not null references auth.users(id) on delete cascade,
    recipient_email text,
    recipient_roles text[] not null default '{}'::text[],
    task_types text[] not null default '{}'::text[],
    status text not null default 'pending'
        check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
    delivery_attempts integer not null default 0 check (delivery_attempts >= 0),
    status_snapshot jsonb not null default '{}'::jsonb,
	    provider text,
	    provider_message_id text,
	    delivery_error text,
	    next_attempt_at timestamp with time zone,
	    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    sent_at timestamp with time zone,
    constraint processing_notification_events_run_recipient_key
        unique (queue_task_id, event_type, recipient_user_id)
);

alter table public.processing_notification_events enable row level security;

grant all on table public.processing_notification_events to service_role;
revoke all on table public.processing_notification_events from anon, authenticated;

create index processing_notification_events_dataset_created_idx
    on public.processing_notification_events (dataset_id, created_at desc);

create index processing_notification_events_status_updated_idx
	    on public.processing_notification_events (status, next_attempt_at, updated_at)
	    where status in ('pending', 'sending', 'failed');

commit;
