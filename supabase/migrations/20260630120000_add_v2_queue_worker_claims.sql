BEGIN;

ALTER TABLE public.v2_queue
    ADD COLUMN IF NOT EXISTS claimed_by text,
    ADD COLUMN IF NOT EXISTS claimed_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS v2_queue_waiting_priority_idx
    ON public.v2_queue (priority DESC, created_at)
    WHERE is_processing = false;

CREATE INDEX IF NOT EXISTS v2_queue_active_owner_idx
    ON public.v2_queue (claimed_by, created_at)
    WHERE is_processing = true;

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
        v2_queue.claimed_by,
        v2_queue.claimed_at,
        v2_queue.priority,
        v2_queue.task_types
    FROM public.v2_queue
    WHERE NOT v2_queue.is_processing
    ORDER BY v2_queue.priority DESC, v2_queue.created_at
),
avg_time AS (
    SELECT avg(v2_cogs.cog_processing_runtime) AS avg
    FROM public.v2_cogs
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
    avg_time.avg,
    positions.claimed_by,
    positions.claimed_at
FROM positions, avg_time;

ALTER VIEW public.v2_queue_positions SET (security_invoker = true);

GRANT SELECT ON public.v2_queue_positions TO anon;
GRANT SELECT ON public.v2_queue_positions TO authenticated;
GRANT SELECT ON public.v2_queue_positions TO service_role;

COMMIT;
