# DIST-ANN correction (DT-1570, 17 November 2026)

The v8 viewer export selected `all/da_by` (DIST-ALERT) instead of the evaluated
annual product `all/da_ann_by` (DIST-ANN). This caused false missing-coverage
results, including `Landslides_Australia_2024`. Renaming the card alone is not a
fix: the saved prediction masks and confusion counts must be replaced together.

The converter branch `fix/dist-ann-dt-1570` in
`disturbance_benchmark_visuals` now selects `da_ann_by`, records its source key,
and never falls back to `da_by`. Its `refresh_saved_products.py` creates a
separate export and preserves the other products, imagery, polygons and Planet
quality checks. Upstream rasters and workbooks are unchanged.

## Verified results

- Annual product coverage: 60 of 114 sites, previously 16; 44 gains, no losses.
- Australia: TP 4,262,012; FP 2,442,988; FN 629,309; TN 4,008,826.
- Australia: precision 0.63564683, recall 0.87134171, F1 0.73506278.
- Full export audit: 557 evaluations match workbook counts; no missing assets.
- 18,731 local files verified by size and SHA-256 against the new manifest.
- 173 changed/new export files, 18,558 unchanged, none removed.
- 15 converter tests and 24 frontend benchmark tests pass; frontend lint passes
  with ignored local preview scripts excluded.
- Chrome local preview confirms the annual mask, label, and rounded scores
  (63.6%, 87.1%, 0.74) at the reported site.

Full Windows build remains blocked by the existing AccountJourney.ts /
accountJourney.ts case collision and Profile import. The full regression gate
cannot initialize its local Supabase migrations link; ast-grep also fails on a
missing cached CLI module. These checks are not claimed as passing.

## Prepared artifacts and publication

Corrected full run on Pylos: `/home/teja/dist-ann-20261117/run`.
Local preview data: `frontend/public/disturbance-benchmark/data-v8-dist-ann-20261117`.
Local preview: `http://127.0.0.1:5187/.local/preview.html?site=Landslides_Australia_2024`.

The delta `/home/teja/dist-ann-20261117/dist-ann-delta.tar.gz` applies only to
the export from `pylos-2026-11-14-v8-planet-qc`; copy that parent to a fresh
directory before overlaying the delta. Its SHA-256 is
`df09677efbfd8c92338ae7825a089086c0b365703752f379eae711b93ab39c51`.
The full run contains the replacement manifest, metrics and audit evidence.
Publication must regenerate the WebP build with a fresh build ID and ingest
the corrected catalogue, site JSON and masks together. Do not reuse an old
WebP build or relabel the old DIST-ALERT payload.

This fix is locally verified; it has not been deployed to production.
