-- Security hardening: address Supabase Security Advisor warnings
--
-- Group A: Revoke public access to admin-only monitoring views
--   These views join auth.users and are only needed via service_role (MCP/dashboard).
--   Resolves: auth_users_exposed + security_definer_view on v2_processing_overview, v2_processor_monitor
--
-- Group B+C: Set security_invoker=true on user-facing views
--   Makes views respect the caller's RLS policies instead of the view owner's.
--   Safe because all underlying tables have compatible RLS policies.
--   Resolves: security_definer_view on v2_queue_positions, v2_full_dataset_view,
--             v2_full_dataset_view_public, data_publication_full_info, v_dataset_flag_agg

-- Group A: Lock down admin monitoring views (service_role only)
REVOKE SELECT ON public.v2_processing_overview FROM anon, authenticated;
REVOKE SELECT ON public.v2_processor_monitor FROM anon, authenticated;

-- Group B: Set security_invoker on actively-used views
ALTER VIEW public.v2_queue_positions SET (security_invoker = true);
ALTER VIEW public.v2_full_dataset_view SET (security_invoker = true);
ALTER VIEW public.v2_full_dataset_view_public SET (security_invoker = true);
ALTER VIEW public.data_publication_full_info SET (security_invoker = true);

-- Group C: Set security_invoker on flag aggregation view (unused via PostgREST, but fix the lint)
ALTER VIEW public.v_dataset_flag_agg SET (security_invoker = true);
