create table v2_model_preferences (
  id serial primary key,
  label_data text not null unique,
  model_config jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on v2_model_preferences using gin(model_config);

insert into v2_model_preferences (label_data, model_config)
values
  (
    'deadwood',
    '{"module":"deadwood_treecover_combined_v2","checkpoint_name":"mitb3_seed200_ckpt_epoch_6_best_macro_f1.safetensors"}'::jsonb
  ),
  (
    'forest_cover',
    '{"module":"deadwood_treecover_combined_v2","checkpoint_name":"mitb3_seed200_ckpt_epoch_6_best_macro_f1.safetensors"}'::jsonb
  )
on conflict (label_data) do update
set model_config = excluded.model_config,
    updated_at = now();

-- Only admins/service role can modify preferences; authenticated users can read.
alter table v2_model_preferences enable row level security;

create policy "Authenticated users can read model preferences"
  on v2_model_preferences for select
  to authenticated
  using (true);
