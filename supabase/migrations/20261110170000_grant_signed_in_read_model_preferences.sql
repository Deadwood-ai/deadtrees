-- Signed-in users read the preferred prediction models: the policy
-- "Authenticated users can read model preferences" exists, but only anon was
-- ever granted the table in a migration. Production already has this grant;
-- a database built from the migrations did not, so the audit worker (signed in
-- as the processor) could not tell which prediction a dataset's check judges.
set local lock_timeout = '5s';

grant select on table public.v2_model_preferences to authenticated;
