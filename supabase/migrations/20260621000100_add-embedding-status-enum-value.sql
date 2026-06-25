-- Add the 'embedding_processing' value to the v2_status enum.
--
-- The processor sets current_status = 'embedding_processing' while the
-- embeddings_v1 task runs. StatusEnum already includes it on the Python side;
-- this adds the matching Postgres enum value so update_status no longer fails
-- with 22P02 "invalid input value for enum v2_status".
alter type public.v2_status
  add value if not exists 'embedding_processing';
