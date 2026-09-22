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

## Tablet flights and installed offline app

Use the isolated frontend build/preview for service-worker and installation
checks; keep its API, Supabase and storage URLs on the same validated local
stack. Test portrait and landscape, then repeat the important journeys in an
installed Android PWA. Browser viewport emulation alone does not establish
Android acceptance.

1. Open the flight list, select a flight, fit its footprint and inspect individual
   crowns. Open the flight panel, select a flight without moving the map, and
   independently show/hide several flights. Hiding a flight retains its selection;
   zoom keeps the panel open and frames the flight above the compact sheet or
   beside the landscape panel. Check name/date search, distance sorting, and the
   persistent scroll indicator with a long flight list.
2. Download one or two complete flights. The current package limits are 500 MiB
   and 3 km² combined full footprints. This does not clip a small area out of a
   larger source file. Basemap areas have their own separate cache status.
3. Wait for the complete-file ready state, go offline, close/reopen the app and
   verify the remembered flight is framed. Zoom and pan into native-resolution
   regions that were never viewed online, including the edges of the flight.
4. Save an observation offline, restart again, reconnect and verify exactly one
   database row with the original values. For an existing point, change its
   server revision before reconnecting: the local edit must remain queued as a
   conflict, without overwriting the newer server state.
5. Cancel a replacement download after bytes arrive and simulate a failed
   replacement. Previously completed files must remain usable; partial files
   must never be offered as ready. Removing flight imagery must preserve queued
   observations.

Record browser storage-persistence support separately from successful downloads.
Cold restart, storage pressure, GPS accuracy, thermal behavior and memory on a
physical field tablet remain device acceptance checks.

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
