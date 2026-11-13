# Disturbance benchmark v8 / v11 handoff (DT-1556)

This release uses the new reference polygons and time series in
`5-Graph/Results_plots_v11`, with saved evaluations in
`6-Validation/tmp_residuals_0.25_all_NO_mask_v8_multithr`. Both folders are under
`/mnt/gsdata/projects/deadtrees/disturbances/`; the repeated `projects/deadtrees`
in the supplied message was a path typo. There are 114 matching sites. The extra
`_backup_env11_missing_years` evaluation folder is excluded.

The selected products remain DTE `dtbil10_fc_dw_comb_by` and TCD `tcbil10_by`,
both bilinear at 10%, alongside the existing seven comparison products. Use
evaluation group `all` and the preceding-year OR flight-year (`b+y`) window.
Thresholds are retained from the previous release, not retuned on the new labels.

## NAS package

```text
\\unfnrd02.public.ads.uni-freiburg.de\unfnrd02\projects\deadtrees\disturbances\11-Webviewer_visuals\runs\pylos-2026-11-13-v8
```

Start with `HANDOFF.md` in that directory. The package includes:

- `export/` and `viewer-export.tar.gz`: site JSON, JPEG imagery, transparent PNG
  predictions and the refreshed reference polygons/masks.
- `viewer-metrics.csv`: precision, recall, F1, IoU, accuracy, specificity,
  balanced accuracy and MCC for every site/product slot. Available evaluations
  have original-raster confusion counts verified against the saved workbook.
- `all-variant-metrics.csv`: separately labelled workbook-derived scores for
  every supplied variant and evaluation group.
- `time-series/`: JSON copies of supplied aggregate and per-polygon observations,
  retained outside the served payload.
- `asset-manifest.json`, `site-sizes.csv`, `handoff-audit.json`,
  `v8-source-audit.json`, `overlay-sampling-audit.json`, `web-build-audit.json`
  and `archive-audit.json`: integrity, source, geometry, metrics and size evidence.
- Conversion code bundle, input fingerprints, acquisition metadata snapshot,
  dependency versions and execution logs.

Only `export/` is the raw web payload. Keep the reports, metadata, source code
and metric tables outside the served directory and outside Git.

The raw export contains 114 sites in 45 countries, 18,687 files and
1,130,597,264 bytes (1,130.60 decimal MB). All 513 available product evaluations
have verified original-raster counts. The separate workbook-variant table has
95,417 rows. The payload audit found no missing asset references or errors.

## Polygon and time-series changes

Display references now use v11 `shapes/tcl` and `shapes/sdt`, clipped to the
drone footprint. Scores use each product's paired v8 prediction/reference rasters
on their original grid, before clipping or display resampling. The two references
can differ in spatial support; source paths and grids remain recorded.

Sentinel charts use the supplied aggregate workbook. Per-polygon group rows no
longer replace an aggregate observation for the same date. The group records
remain available in `time-series/` for separate analysis. Excel error cells such
as `#NUM!` remain missing chart observations; raw report records retain them.

Planet GCC uses the supplied aggregate monthly/quarterly workbooks for this
polygon release, rather than recomputing a mean over the full drone footprint.
Quarterly image names have a leading `planet_` that is absent from the workbook
names; matching accounts for that prefix. Missing workbook observations remain
null. Cloud percentages are preserved without applying an additional filter.
Monthly and quarterly composite periods can overlap. The viewer's methods text
reports this source basis while remaining compatible with earlier exports.

Missing product coverage remains unavailable. Undefined score denominators
remain null; F1 is `2TP/(2TP+FP+FN)`, including zero for missed positives with no
detections. The previous acquisition metadata snapshot and its date warnings are
retained because this update supplied polygons/evaluations, not new flight dates.

## Ingestion after review

The prepared WebP build is under
`11-Webviewer_visuals/builds/pylos-2026-11-13-v8`. Use the existing publisher and
the [internal deployment guide](disturbance-benchmark-internal.md):

```bash
RUN=/mnt/gsdata/projects/deadtrees/disturbances/11-Webviewer_visuals/runs/pylos-2026-11-13-v8
PY=~/.local/share/deadtrees/benchmark-venv/bin/python
export BENCHMARK_BUILDS_ROOT=/mnt/gsdata/projects/deadtrees/disturbances/11-Webviewer_visuals/builds
$PY scripts/disturbance_benchmark_publish.py build "$RUN"
$PY scripts/disturbance_benchmark_publish.py publish "$RUN" --dry-run
# After review and approval for the production update:
$PY scripts/disturbance_benchmark_publish.py publish "$RUN"
```

The publisher reuses the prepared build, stages a new version and switches
`current`, retaining the earlier version for rollback. Existing core-team access
control remains required. This PR does not deploy production.

## Validation scope

Five converter tests pass, including aggregate/per-polygon workbook separation,
original-grid counting, nodata and display resampling. The current frontend's
benchmark tests, lint and full production build pass on Linux with Node 24.15.0.
The repository's ast-grep gate passes.

Full isolated backend/auth regression could not run on Windows: bootstrap lacks
`make`, and the QA setup encounters an existing migration-directory link error.
Local viewer inspection uses the current benchmark components and local assets;
it does not establish production authorization coverage. Full payload audit
results and exact sizes are recorded in the NAS handoff.
