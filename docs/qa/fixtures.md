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
