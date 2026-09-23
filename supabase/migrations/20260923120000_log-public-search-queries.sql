-- Record open-vocabulary search queries from every caller, anonymous included.
--
-- 20260711130000_add-search-query-log.sql deliberately kept this table
-- auditor-only, because the browser was the writer: logging public queries from
-- the client would have meant granting INSERT to "anon", and the anon key ships
-- in every page load, so anyone could have written unbounded forged rows.
--
-- The write therefore moves server-side instead. POST /search/embed sits on the
-- path of every AI search, already validates and caps the query text, and is
-- already rate limited per client IP; it now records the query with the service
-- role. The browser loses its write path to this table entirely.
BEGIN;

-- Only the API's service role inserts from here on.
drop policy if exists "Auditors can log their successful search query" on "public"."v2_search_queries";
revoke insert on table "public"."v2_search_queries" from "authenticated";
revoke usage, select on sequence "public"."v2_search_queries_id_seq" from "authenticated";

-- auth.uid() is NULL for the service role. The API passes the user id it
-- verified from the caller's bearer token, or NULL for anonymous visitors.
alter table "public"."v2_search_queries" alter column "user_id" drop default;

-- user_id is also nulled when a user is deleted (the log outlives the account),
-- so on its own it cannot tell an anonymous search from an orphaned one.
-- Every existing row was written by an authenticated auditor, hence default false.
alter table "public"."v2_search_queries"
  add column "is_anonymous" boolean not null default false;

COMMIT;
