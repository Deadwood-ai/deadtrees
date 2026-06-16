# PRIWA Field Workflow

```yaml
id: priwa-field-workflow
persona: authenticated field user
fixture_packs:
  - qa-priwa
browser: browser
parallel_safe: false
mutation_level: local-write
routes:
  - /priwa-field
```

## Purpose

Verify the PRIWA field workflow can authenticate, load the field map, operate
offline, queue create/update/delete mutations, and sync them into local
Supabase.

## Preconditions

- `qa-full` fixtures are seeded.
- Current fixture foundation may not yet include `qa-priwa`; if project
  membership rows are missing, record this as `needs-human-review`.
- Use seeded or playbook-created local field user only.
- Browser context must support online/offline toggling.

## Steps

1. Sign in as the PRIWA field user.
2. Navigate to `/priwa-field`.
3. Verify `data-testid="priwa-field-map"` is visible.
4. Verify offline basemap/status controls are present.
5. Switch browser context offline.
6. Create a map-estimated point with a unique local run ID.
7. Verify pending sync state.
8. Switch browser context online.
9. Verify the point syncs into `priwa_kaeferbaeume`.
10. Repeat update and soft-delete for the point.

## Expected Observations

- Authenticated field user can access `/priwa-field`.
- Offline mutations remain queued while offline.
- Online transition syncs queued mutations.
- Local DB rows preserve actor fields and soft-delete metadata.

## Failure Signals

- Route denies an authorized field user.
- Offline state is not reflected in the UI.
- Pending mutation disappears without syncing.
- Delete physically removes a row where soft-delete is expected.

## Evidence To Capture

- Field map visibility state.
- Pending/synced text state.
- DB assertion for created, updated, and soft-deleted row.
- Console errors related to service worker/offline store only.

