# Auditor Queue Triage

```yaml
id: auditor-queue-triage
persona: auditor
fixture_packs:
  - qa-auditor
browser: browser
parallel_safe: false
mutation_level: local-write
routes:
  - /dataset-audit
```

## Purpose

Verify the auditor can inspect queue tabs, distinguish pending/completed and
processing states, and acknowledge the seeded flag queue state.

## Preconditions

- `qa-full` fixtures are seeded.
- Sign in as `qa-auditor-local@example.com`.
- Dataset `91001` has an open flag.
- Dataset `91002` has completed audit data.
- Dataset `91004` has incomplete/error-like processing status.

## Steps

1. Sign in as auditor.
2. Navigate to `/dataset-audit`.
3. Verify the audit workspace renders.
4. Inspect queue tabs or filters for pending, completed, flagged, and processing data.
5. Locate dataset `91001` or `qa-public-complete.tif`.
6. Verify the open flag is visible or reachable.
7. Locate dataset `91002` in completed/audited state.
8. Locate dataset `91004` in processing/error-like state.
9. If the UI exposes flag acknowledge action, perform it and verify local DB side effect.

## Expected Observations

- Auditor can triage multiple dataset states from seeded data.
- Queue tabs/filters do not mix completed, pending, and processing states
  incoherently.
- Any mutation remains local and is visible in `dataset_flags` or history tables.

## Failure Signals

- Seeded datasets are absent from the auditor queue.
- Completed audit data appears as unaudited without explanation.
- Processing/error state appears as ready-to-audit complete data.
- Flag mutation fails or writes no local history.

## Evidence To Capture

- Queue tab names and counts if visible.
- Locator state for dataset IDs `91001`, `91002`, and `91004`.
- DB assertion if flag state is changed.
- Console errors related to audit queries/RPCs.

