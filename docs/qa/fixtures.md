# Local QA Fixtures

These fixtures are local-only and are seeded by:

```bash
set -a
source "$(scripts/dev/isolated-supabase.sh env)"
set +a
scripts/qa/seed.sh qa-full
```

The seed runner refuses non-local `SUPABASE_DB_URL` values.

For a production-derived local pack with real public COGs, thumbnails,
geometries, corrections, flags, and one error-state dataset, first generate the
ignored pack files:

```bash
scripts/qa/pull-realistic-fixtures.py
scripts/qa/seed.sh qa-realistic
```

`qa-realistic` applies `qa-base` first, then overlays sanitized rows in the
920xx range. Production access is read-only. Generated SQL, manifest, COGs,
thumbnails, and archive copies stay under `.local/`.

## Personas

All seeded users use the local-only password:

```text
DeadTreesQA-Local-1!
```

| Persona | Email | User ID | Purpose |
| --- | --- | --- | --- |
| contributor | `qa-contributor-local@example.com` | `00000000-0000-4000-8000-00000000a001` | Owns seeded datasets and can upload private data |
| auditor | `qa-auditor-local@example.com` | `00000000-0000-4000-8000-00000000a002` | Can audit and view private data |
| viewer | `qa-viewer-local@example.com` | `00000000-0000-4000-8000-00000000a003` | Normal authenticated user without privileges |

The contributor also has the seeded `qa-priwa-project` membership and is the
default PRIWA field user for local QA playbooks.

## Dataset IDs

| Dataset ID | File | Access | State | Purpose |
| --- | --- | --- | --- | --- |
| `91001` | `qa-public-complete.tif` | public | complete, unaudited, flagged | public discovery, detail, flag/audit queue |
| `91002` | `qa-public-audited.tif` | public | complete and audited | audited/public detail and audit-history checks |
| `91003` | `qa-private-contributor.tif` | private | contributor-owned | permission and contributor profile checks |
| `91004` | `qa-processing-error.tif` | public | incomplete/error-like processing state | failed/stuck processing UI checks |

## Current Pack Coverage

`qa-base` and `qa-full` currently seed the same foundation:

- Auth users and identities
- Privilege rows for contributor/auditor/viewer
- Four datasets
- Status rows
- Orthophoto metadata
- COG/thumbnail rows for complete public datasets
- Metadata rows
- One completed audit
- One open dataset flag

Future fixture packs should add narrower data for labels/corrections, PRIWA,
publications, downloads, and negative/empty states.

`qa-realistic` adds sanitized production-derived rows in the 920xx range:

| Local ID | Source | Purpose |
| --- | --- | --- |
| `92001`+ | Public production samples | Real COG/thumbnail rendering, dense map layers, corrections, audit rows, flags, and processing-error coverage |

The exact source mapping is written to `.local/qa-packs/realistic/manifest.json`
when the pack is generated.

## Factory workspace

`scripts/qa/seed.sh qa-factory` adds synthetic operational records in the
93001–93120 range and `qa-operator-local@example.com` (user ID ending `a004`,
same local-only password above). This account has `can_operate` without audit
or blanket private-imagery permissions. The existing auditor has no Factory
permission. The pack includes an older claimed job, queue rows, failures,
uncertain status, a failed notification, an open report and a publication.
Readiness flags in these synthetic rows do not imply real output files exist.

Use `/factory` for the overview, dataset filters, individual investigation,
activity and cross-page selection. Copy IDs/context prepares a factual handoff;
it does not execute operations. `api/tests/db/test_factory.py` checks the
server permission boundary and the complete dataset population.

The Factory seed also creates explicitly synthetic ten-week measurement coverage,
first-upload/first-result milestones, known and unknown original input sizes,
ZIP/GeoTIFF workflows, recovered and unresolved failures, and recorded task
outcomes. It writes historical dates only through the local seed runner; it is
not a production backfill procedure. These fixtures support weekly/daily charts,
size/workflow filters, exact event-period drill-downs and unknown/partial periods.

The journey preview adds twelve synthetic contributor identities (addresses under
`example.invalid`), first owner-result observations and repeat-upload cohorts.
These exercise elapsed and incomplete windows and consent-observation gaps;
they do not represent real contributor activation or historical analytics.
