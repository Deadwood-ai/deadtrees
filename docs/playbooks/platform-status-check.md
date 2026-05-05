# Platform Status Check

Use this playbook for daily or ad-hoc DeadTrees status checks. It is safe to
track and intentionally contains no credentials.

## Operating Mode

- Start cheap and aggregate first, then drill down only on anomalies.
- Use the last 24 hours by default unless the user specifies another window.
- Use UTC for database/server queries and write the final summary in Berlin time
  unless the audience needs UTC.
- Do not paste secrets, bearer tokens, database URLs, or passwords into the report.
- For access paths, use local-only `docs/ops/local-access.md` and
  `.codex/local-access.md` when present.

## Surfaces

Check the surfaces relevant to the question:

- production database or Postgres/Supabase MCP
- processing queue, `v2_statuses`, `v2_logs`, and recent failures
- storage/API server health and public API contract
- processing server/container heartbeat when host access is needed
- frontend smoke behavior when user-visible symptoms are possible
- PostHog traffic, exceptions, uploads, downloads, and audit events
- Zulip reports and automation summaries when relevant
- reference exports and backups for data freshness incidents

## Fast Preflight

1. Confirm local access files exist if host or MCP access is needed:

   ```bash
   test -f .codex/config.toml
   test -f .codex/local-access.md
   test -d docs/ops
   ```

2. Verify database identity with a tiny read-only query:

   ```sql
   select current_database() as db, now() as server_time;
   ```

3. Smoke the public API:

   ```bash
   curl -fsS https://data2.deadtrees.earth/api/v1/openapi.json | jq '.openapi'
   ```

4. If host checks are needed and approved, use compact SSH probes:

   ```bash
   ssh -o BatchMode=yes -o ConnectTimeout=5 storage-server 'hostname'
   ssh -o BatchMode=yes -o ConnectTimeout=5 processing-server 'hostname'
   ```

## Database Queries

Prefer aggregate counts before row-level inspection:

```sql
select
	count(*) filter (where created_at >= now() - interval '24 hours') as datasets_created_24h,
	count(*) filter (where updated_at >= now() - interval '24 hours' and has_error) as statuses_error_24h,
	count(*) filter (where current_status <> 'idle') as non_idle_now
from v2_statuses;
```

```sql
select processing_status, count(*)
from v2_queue
group by processing_status
order by count(*) desc;
```

```sql
select level, count(*)
from v2_logs
where created_at >= now() - interval '24 hours'
group by level
order by count(*) desc;
```

Then inspect specific fingerprints only when counts look wrong.

## Host Checks

Use compact one-shot commands and keep output capped:

```bash
docker inspect deadtrees-processor-1 \
  --format 'StartedAt={{.State.StartedAt}} RestartCount={{.RestartCount}} OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}'
df -h / /data
tail -n 80 /data/logs/reference_export.log
tail -n 80 /data/logs/api_container.log
```

If processing-server SSH is blocked, use database logs as primary evidence and
state that host-level corroboration was unavailable.

## Final Report

Include:

- overall status: green, yellow, or red
- window checked with concrete dates/times
- upload/processing throughput counts
- failures and stuck queues with dataset IDs where useful
- API/storage/frontend/PostHog/Zulip/export/backups status as checked
- skipped or blocked surfaces
- confidence and one improvement for the next check

Use `green` only when all checked surfaces look normal. Use `yellow` for warnings,
stale jobs, missing signals, or server-side concerns. Use `red` for outages,
blocked processing, stale user-facing exports, critical storage pressure, or
multi-user impact.
