-- Migration: Fix views that were accidentally dropped by CASCADE
--
-- The cleanup migration (20260122100001) dropped dev_cogs with CASCADE,
-- which cascaded to v2_queue_positions because it incorrectly depended on dev_cogs.
--
-- This migration recreates the dropped views with correct dependencies:
-- - v2_queue_positions now uses v2_cogs instead of dev_cogs

BEGIN;

-- ============================================================
-- Recreate v2_queue_positions view
-- ============================================================
-- Original view used dev_cogs.runtime, but v2_cogs uses cog_processing_runtime

CREATE OR REPLACE VIEW public.v2_queue_positions AS
WITH positions AS (
    SELECT 
        row_number() OVER (ORDER BY v2_queue.priority DESC, v2_queue.created_at) AS current_position,
        v2_queue.id,
        v2_queue.dataset_id,
        v2_queue.user_id,
        v2_queue.build_args,
        v2_queue.created_at,
        v2_queue.is_processing,
        v2_queue.priority,
        v2_queue.task_types
    FROM v2_queue
    WHERE NOT v2_queue.is_processing
    ORDER BY v2_queue.priority DESC, v2_queue.created_at
), 
avg_time AS (
    SELECT avg(v2_cogs.cog_processing_runtime) AS avg
    FROM v2_cogs
)
SELECT 
    (avg_time.avg * (positions.current_position)::double precision) AS estimated_time,
    positions.current_position,
    positions.id,
    positions.dataset_id,
    positions.user_id,
    positions.build_args,
    positions.created_at,
    positions.is_processing,
    positions.priority,
    positions.task_types,
    avg_time.avg
FROM positions, avg_time;

-- Grant permissions (matching original)
GRANT SELECT ON public.v2_queue_positions TO anon;
GRANT SELECT ON public.v2_queue_positions TO authenticated;
GRANT SELECT ON public.v2_queue_positions TO service_role;

COMMIT;
