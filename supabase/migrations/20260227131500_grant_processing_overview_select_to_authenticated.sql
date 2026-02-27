-- Allow frontend (authenticated users) to read processing overview.
-- Access is still constrained by app-level auditor checks.
GRANT SELECT ON public.v2_processing_overview TO authenticated;
GRANT SELECT ON public.v2_processing_overview TO service_role;
