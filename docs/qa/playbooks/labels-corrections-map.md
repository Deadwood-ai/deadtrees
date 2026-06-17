# Labels Corrections Map

```yaml
id: labels-corrections-map
persona: contributor/auditor
fixture_packs:
  - qa-labels
browser: browser
parallel_safe: false
mutation_level: local-write
routes:
  - /dataset-label/91001
  - /dataset-corrections/91001
```

## Purpose

Verify label editing and public correction flows can be exercised locally with a
map, layer controls, geometry creation/editing, and approval/revert paths.

## Preconditions

- `qa-full` fixtures are seeded.
- Current fixture foundation may not yet include `qa-labels`; if label geometry
  rows are missing, record this as `needs-human-review` and do not invent data
  manually during playbook execution.
- Use contributor for correction creation and auditor for approval/revert checks.

## Steps

1. Sign in as contributor.
2. Navigate to `/dataset-corrections/91001`.
3. Verify the corrections editor route loads or reports missing fixture state.
4. If available, create or edit a correction geometry.
5. Save the correction and verify local DB side effect.
6. Sign in as auditor.
7. Navigate to `/dataset-label/91001`.
8. Verify label editor/map/layer controls render.
9. Approve or revert a pending correction if the fixture exists.

## Expected Observations

- Map editor does not crash when loading seeded dataset `91001`.
- Geometry tools are discoverable and usable.
- Contributor-created corrections are not auto-approved unless policy says so.
- Auditor approval/revert changes local correction state.

## Failure Signals

- Route crashes due to missing labels with no empty state.
- Geometry save succeeds in UI but no local DB mutation appears.
- Contributor can perform auditor-only approval action.
- Map controls overlap or block required tools.

## Evidence To Capture

- Current URL and editor/map visibility state.
- DB assertion for correction row if mutation occurs.
- Permission result for contributor versus auditor.
- One clipped screenshot of the map tool area only if visual layout blocks use.
