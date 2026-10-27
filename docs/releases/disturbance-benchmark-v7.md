# Disturbance benchmark v7 handoff (DT-1451)

This update uses `tmp_residuals_0.25_all_NO_mask_v7_multithr`, evaluation group
`all`, and the preceding-year OR flight-year (`b+y`) window. DTE is
`dtbil10_fc_dw_comb_by`; TCD is `tcbil10_by`. Both use the supplied **bilinear,
10% threshold** classification. The `0.25` in the parent directory name does
not describe these selected variants. Other products keep their existing `by`
keys and fixed display order. No source TIFF or workbook is modified.

## NAS payload

Windows:

```text
\\unfnrd02.public.ads.uni-freiburg.de\unfnrd02\projects\deadtrees\disturbances\11-Webviewer_visuals\runs\pylos-2026-10-26-v7
```

Linux:

```text
/mnt/gsdata/projects/deadtrees/disturbances/11-Webviewer_visuals/runs/pylos-2026-10-26-v7
```

Only `export/` is the web payload. It contains the catalogue, per-site JSON,
JPEG imagery and lossless transparent PNG masks. Preserve its directory structure
and `/data/` references. Keep metric tables, manifests, code bundles, metadata
snapshots and logs outside the served directory and outside Git.

The completed export contains **114 sites in 45 countries**, **16,641 files**
and **948.35 MB** (948,347,329 bytes, decimal units). The audit found no missing
references or errors. There are **513 available, raster-verified product
evaluations** among the 1,026 site/product slots; unavailable products remain
explicitly unavailable. The separate all-variant table contains **93,674 rows**.
Per-site sizes are recorded in `site-sizes.csv`.

The same NAS root also provides a WebP build under
`11-Webviewer_visuals/builds/pylos-2026-10-26-v7`. The commands below select that
build root, allowing the publisher to reuse the prepared build. The raw
`viewer-export.tar.gz` archive contains `export/` and has a companion SHA-256 file.

## Scores and verification

Every available viewer product has TP, FP, FN and TN recomputed from its original
paired `pred_res` / `ref_rast` grids, on jointly valid finite binary pixels.
Dimensions, CRS and transform must match. Counts must agree exactly with the
saved workbook; a mismatch fails conversion for that site. No score is calculated
from a PNG, JPEG or clipped display grid.

- `viewer-metrics.csv`: original-raster-verified scores for the nine viewer products.
- `all-variant-metrics.csv`: scores recomputed from saved workbook counts for all
  supplied settings in `all`, `i_all`, and `r_all`. These additional variants are
  explicitly workbook-derived, not independently raster-verified.
- `handoff-audit.json`: completed-site, image, reference and metric checks.
- `asset-manifest.json`: payload file sizes and SHA-256 hashes.
- `site-sizes.csv`: per-site payload bytes and decimal MB.
- `dte-variant-comparison.json` and `dte-variant-site-metrics.csv`: threshold comparison.

Scores include precision, recall, F1, IoU, accuracy, specificity, balanced accuracy
and MCC. Undefined denominators stay null/NA. F1 uses `2TP/(2TP+FP+FN)` directly:
a covered product with no detections but positive reference pixels has F1=0,
recall=0 and undefined precision. This intentionally differs from the workbook's
`F1_score` formula where it propagates undefined precision to F1. Source confusion
counts remain unchanged. Missing coverage is never replaced by zero.

The display reference still uses the v10 drone polygons. Product-specific v7
reference rasters determine the scores; the grids, source paths and comparisons
are retained in each product's metadata. Existing acquisition-date warnings,
including Brazil3, remain visible. A successful conversion does not resolve those
scientific limitations.

## Why bilinear 10% for DTE

On the same 106 sites with available evaluations for the new variants:

| Setting | Mean site F1 | Pooled F1 |
| --- | ---: | ---: |
| Nearest 10% | 0.433092 | 0.588943 |
| Bilinear 10% | 0.433023 | 0.597610 |
| Nearest 15% | 0.416361 | 0.597592 |
| Bilinear 15% | 0.415632 | 0.604365 |

The 10% variants perform best when sites are weighted equally. Interpolation
differs by less than 0.0001 mean F1 at 10%; bilinear 15% wins pooled pixel F1.
Teja selected bilinear 10% for DTE and 10% for TCD. This is a comparison on the
benchmark itself, not an independent validation of a tuned threshold. Eight of
114 sites lack these DTE evaluations and are excluded, not assigned zero.
Legacy DTE variants have only 101 sites; the JSON also records a 101-site matched
comparison including them.

## Ingest after review

Use the existing publisher from the latest deadtrees checkout on the processing
server, following [the internal benchmark deployment guide](disturbance-benchmark-internal.md).
Pass this run explicitly; avoid selecting an unrelated newer run automatically.

```bash
RUN=/mnt/gsdata/projects/deadtrees/disturbances/11-Webviewer_visuals/runs/pylos-2026-10-26-v7
PY=~/.local/share/deadtrees/benchmark-venv/bin/python
export BENCHMARK_BUILDS_ROOT=/mnt/gsdata/projects/deadtrees/disturbances/11-Webviewer_visuals/builds
$PY scripts/disturbance_benchmark_publish.py build "$RUN"
$PY scripts/disturbance_benchmark_publish.py publish "$RUN" --dry-run
# After approval for this production update:
$PY scripts/disturbance_benchmark_publish.py publish "$RUN"
```

The publisher converts RGB to WebP and masks to lossless WebP, preserves metric
JSON, adds previews and checks referenced files. It stages a version and switches
`current`, retaining the earlier version for rollback. Do not copy assets into
the public frontend build. Existing core-team authorization remains required.
This PR does not publish or change access permissions.

Converter implementation is maintained in `Deadwood-ai/disturbance_benchmark_visuals`.
The run records the conversion commit, source fingerprints, acquisition snapshot
checksum and Python dependency versions. The NAS also retains a Git code bundle
for reproduction.

## Code validation

The converter's four Python tests and the frontend's 22 benchmark tests pass.
Frontend lint, ast-grep 0.42.2 and the full Linux production build pass. An
independent check of 38,912 sampled overlay pixels across 19 evaluations found
zero mismatches with the original prediction rasters. Representative drone,
reference, DTE and Esri overlays were also inspected in the local viewer.

Windows production compilation encounters the existing `AccountJourney.tsx` /
`accountJourney.ts` case collision; the same source builds on Linux. Full isolated
backend/auth QA could not run: Windows lacks `make`, the worktree environment is
not bootstrapped, and Docker is stopped. The local preview exercises the current
benchmark components against local files; it does not validate production access
control. Production deployment remains a separate reviewed operation.
