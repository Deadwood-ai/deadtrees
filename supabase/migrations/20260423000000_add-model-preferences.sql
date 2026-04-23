create table v2_model_preferences (
  id serial primary key,
  label_data text not null unique,
  model_config jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on v2_model_preferences using gin(model_config);

-- Only admins/service role can modify preferences; authenticated users can read.
alter table v2_model_preferences enable row level security;

create policy "Authenticated users can read model preferences"
  on v2_model_preferences for select
  to authenticated
  using (true);
