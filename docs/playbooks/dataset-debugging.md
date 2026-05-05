# Dataset Debugging Playbook

Use this when a dataset is stuck, failed, invisible, processing incorrectly, or
reported by a user. Keep the investigation read-only until the user authorizes a
specific mutation.

## First Principles

- Start from the dataset ID and the current user-visible symptom.
- Check existing Linear/Zulip context before creating new issues.
- Query aggregate status first, then inspect the specific dataset.
- Use production database access read-only unless the user explicitly approves a write.
- Do not requeue production work without explicit approval.

## Dataset Overview

```sql
select
	d.id,
	d.file_name,
	d.created_at,
	d.user_id,
	s.current_status,
	s.has_error,
	s.error_message,
	s.is_ortho_done,
	s.is_cog_done,
	s.is_thumbnail_done,
	s.is_metadata_done,
	s.is_deadwood_done,
	s.is_forest_cover_done
from v2_datasets d
left join v2_statuses s on s.dataset_id = d.id
where d.id = :dataset_id;
```

## Logs

```sql
select created_at, level, category, message
from v2_logs
where dataset_id = :dataset_id
order by created_at desc
limit 100;
```

Look for repeated fingerprints, not only the latest line. Common useful terms:

- `exit code 137`
- `No such image`
- `Chunk and warp failed`
- `IReadBlock failed`
- missing CRS or malformed GeoTIFF metadata

## Files

Confirm the expected storage records and sizes:

```sql
select dataset_id, ortho_file_name, ortho_file_size, ortho_info
from v2_orthos
where dataset_id = :dataset_id;

select dataset_id, cog_path
from v2_cogs
where dataset_id = :dataset_id;

select dataset_id, thumbnail_path
from v2_thumbnails
where dataset_id = :dataset_id;
```

Remember: ortho file size values are MB, not bytes.

## Reference Export Checks

For user reports about reference/training tile counts, stale public reference
downloads, or files under `/reference/{uuid}/{dataset_id}/...`, compare the
database patch set with the public export artifacts before changing data.

Count current validated patches in production:

```sql
select
	resolution_cm,
	count(*) as total,
	count(*) filter (where parent_tile_id is null) as roots,
	count(*) filter (where parent_tile_id is not null) as children,
	count(*) filter (where deadwood_validated is true) as deadwood_validated,
	count(*) filter (where forest_cover_validated is true) as forest_cover_validated,
	max(updated_at) as max_updated_at
from reference_patches
where dataset_id = :dataset_id
group by resolution_cm
order by resolution_cm desc;
```

Then compare against the public export directory listing:

```bash
curl -fsSL "https://data2.deadtrees.earth/reference/${REFERENCE_EXPORT_UUID}/${DATASET_ID}/metadata/" \
  | sed -n 's/.*href="\([^"]*_[0-9][0-9]*cm\.json\)".*/\1/p' \
  | sort
```

If the database count is correct but public files are higher, suspect stale
export artifacts rather than duplicate database rows. The reference exporter is
responsible for deleting generated patch files that no longer correspond to
current `reference_patches` rows; do not manually delete production files unless
the user explicitly approves that intervention.

## Queue

```sql
select *
from v2_queue
where dataset_id = :dataset_id
order by created_at desc;
```

If the queue is stuck globally, inspect counts before individual rows:

```sql
select processing_status, task_type, count(*)
from v2_queue
group by processing_status, task_type
order by count(*) desc;
```

## Upload-Specific Checks

For failures during upload or upload-triggered processing, check:

- chunk assembly and hash behavior
- dataset row creation in `v2_datasets`
- status row creation in `v2_statuses`
- ortho/raw-image records
- queue insertion and requested task types
- frontend auth/session refresh during long uploads
- API/storage errors in the browser network panel

## Similar Failures

```sql
select dataset_id, created_at, level, message
from v2_logs
where created_at >= now() - interval '7 days'
  and message ilike '%' || :fingerprint || '%'
order by created_at desc
limit 100;
```

## Requeue Rules

Only requeue after approval.

- Always include `geotiff` when rerunning downstream tasks that need the
  standardized local ortho.
- Avoid legacy replacement stages (`deadwood_v1`, `treecover_v1`) on datasets
  that may have audit edits or geometry corrections.
- Prefer API-based requeue with a processor token over direct production SQL.
- Record exactly which dataset IDs and task types were changed.

## Report Shape

Return:

- current dataset state
- likely failing stage
- primary evidence from DB/logs/files/host checks
- whether similar failures exist
- whether user-visible data is affected
- next safe action, clearly separating read-only checks from mutations
