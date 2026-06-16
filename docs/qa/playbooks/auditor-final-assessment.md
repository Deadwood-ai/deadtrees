# Auditor Final Assessment

```yaml
id: auditor-final-assessment
persona: auditor
fixture_packs:
  - qa-auditor
browser: browser
parallel_safe: false
mutation_level: local-write
routes:
  - /dataset-audit/91001
```

## Purpose

Verify an auditor can open a seeded unaudited dataset, fill the audit form, draw
or confirm AOI state where required, and persist final assessment locally.

## Preconditions

- `qa-full` fixtures are seeded.
- Sign in as `qa-auditor-local@example.com`.
- Dataset `91001` is complete and not yet audited.
- This playbook owns local mutations for `dataset_audit`, `v2_statuses`, and
  related audit side effects.

## Steps

1. Sign in as auditor.
2. Navigate to `/dataset-audit/91001`.
3. Verify the audit detail page and `data-testid="dataset-audit-map"` render.
4. Fill required audit fields: georeference, acquisition date, phenology,
   deadwood quality, forest cover quality, COG/thumbnail checks, and final assessment.
5. Draw an AOI if the UI requires it.
6. Save the audit.
7. Verify the UI reports a successful save.
8. Query local DB to confirm `dataset_audit` and status/audit fields changed.

## Expected Observations

- Audit form loads seeded dataset metadata and map controls.
- Required fields are visible and enforce validation.
- Save writes to local Supabase only.
- Persisted audit data matches selected final assessment values.

## Failure Signals

- Audit map never becomes visible.
- Form can save incomplete required data.
- Save appears successful but no DB row is written.
- Save writes to production or shared non-isolated Supabase.

## Evidence To Capture

- Current URL and dataset ID.
- Audit save response status.
- Focused DB assertion for dataset `91001`.
- One screenshot only if map/form layout prevents completion.

