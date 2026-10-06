-- Readable view of the queue rows a processor currently holds.
--
-- v2_queue.claimed_by stores the worker ID (host-<machine-id prefix>), which
-- says nothing to a person reading the Supabase table editor. This view names
-- the host and adds what an operator asks next: which dataset, which stage,
-- how long it waited and has been running, and the latest log line.
--
-- Worker IDs come from docs/playbooks/processor-hosts.md. When a processor
-- host is added, add its row below in a new migration and in that doc; until
-- then the view shows the raw worker ID as the processor name.

CREATE OR REPLACE VIEW public.v2_processor_claims
WITH (security_invoker = true) AS
SELECT
    coalesce(host.name, q.claimed_by) AS processor,
    q.dataset_id,
    d.file_name AS dataset,
    s.current_status AS stage,
    s.has_error,
    date_trunc('second', now() - q.claimed_at) AS running_for,
    q.claimed_at,
    date_trunc('second', q.claimed_at - q.created_at) AS waited_in_queue,
    q.created_at AS queued_at,
    q.priority,
    q.task_types,
    round(s.uploaded_input_bytes / 1048576.0) AS input_size_mb,
    last_log.created_at AS last_log_at,
    last_log.message AS last_log,
    last_log.backend_version,
    q.claimed_by AS worker_id,
    q.id AS queue_id,
    q.user_id
FROM public.v2_queue q
LEFT JOIN (
    VALUES
        ('host-f9760a054cb8', 'processing-server'),
        ('host-bb400fd18e59', 'helicon'),
        ('host-56916e6e7ab8', 'deepl1')
) AS host (worker_id, name) ON host.worker_id = q.claimed_by
LEFT JOIN public.v2_datasets d ON d.id = q.dataset_id
LEFT JOIN public.v2_statuses s ON s.dataset_id = q.dataset_id
LEFT JOIN LATERAL (
    SELECT l.created_at, left(l.message, 300) AS message, l.backend_version
    FROM public.v2_logs l
    WHERE l.dataset_id = q.dataset_id
      AND l.created_at >= q.claimed_at
    ORDER BY l.created_at DESC
    LIMIT 1
) AS last_log ON true
WHERE q.claimed_by IS NOT NULL
ORDER BY q.claimed_at;

COMMENT ON VIEW public.v2_processor_claims IS
    'Queue rows currently claimed by a processor, with the host name, dataset, stage, timings and latest log line.';

-- Operator view: no app role reads it. The dashboard, service_role and the
-- read-only analyst role do.
REVOKE ALL ON public.v2_processor_claims FROM anon, authenticated;
GRANT SELECT ON public.v2_processor_claims TO service_role;
GRANT SELECT ON public.v2_processor_claims TO analyst;
