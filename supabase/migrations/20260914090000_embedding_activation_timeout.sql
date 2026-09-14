-- Large embedding generations exceed the normal authenticated RPC budget (8s).
-- Inserts are batched, but publication must activate all rows, retire the previous
-- generation and rebuild AOI membership in one transaction. Keep that atomicity
-- and allow this processor-only RPC a bounded budget below the client's 120s limit.
-- PostgREST >=12.2 hoists this function setting before executing the RPC; merely
-- calling SET LOCAL inside the function would not extend an already-running timer.
ALTER FUNCTION public.activate_tile_embeddings(bigint, bigint, integer)
  SET statement_timeout = '90s';

NOTIFY pgrst, 'reload schema';
