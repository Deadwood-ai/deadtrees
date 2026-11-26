# Auditor Check Review

```yaml
id: auditor-check-review
persona: auditor
fixture_packs:
  - qa-auditor
browser: browser
parallel_safe: false
mutation_level: local-write
routes:
  - /dataset-audit?tab=pending
  - /dataset-audit/91090
```

## Purpose

Verify the Audit Review page (DT-1486): the seven steps in order, each check's map mode,
answers stored as person rows in `audit.assessments`, the stored images the checks
judged, the evaluation decision (OK or Exclude) and the list tabs.

## Preconditions

- The isolated stack is up, reset and validated; `.local/supabase/current.env` is sourced.
- Seed dataset 91090 with check results (the QA reset removes it again):
  `python3 scripts/qa/seed-audit-checks.py` (needs `assets/test_data/test-data.tif`
  or a GeoTIFF path as the argument).
- Sign in as `qa-auditor-local@example.com`.

## Steps

1. Open `/dataset-audit?tab=pending`; the seeded dataset is listed with "Review required"
   for the dataset evaluation and georeferencing (not for the prediction layers).
2. Open `/dataset-audit/91090?section=georef`. The map shows the reference under the
   drone image with match lines; the panel switches reference and opacity. Answer
   Passed or Not passed.
3. Open `1. Dataset evaluation`: the COG and thumbnail facts with the COG issue flagged,
   "The evaluation could not decide", and the decision OK or Exclude (no Fix).
4. Open `5. Phenology`: the probability and, where the site has a curve, the phenology
   indicator bar with the acquisition date.
5. Open `7. Deadwood prediction`: the crop review opens on the crop the judges disagree
   on; answer it with 4 (Ambiguous) and see the counts list it apart.
6. Pick OK, add a note and save.

## Expected Observations

- Steps read: 1 Dataset evaluation, 2 Area of interest, 3 Georeferencing, 4 Acquisition
  date ("Not run yet" without an estimate), 5 Phenology, 6 Tree cover prediction,
  7 Deadwood prediction.
- Each answer is a new `audit.assessments` row with `assessor_kind = 'person'` and the
  current `run_id`; the evaluation answer has verdict `ok` or `major`.
- Crop answers carry `crop_id` and the layer, stored at once; Ambiguous is verdict
  `ambiguous`.
- Images load through `/api/v1/audit/images/files/<ticket>/...`.
- `audit.dataset_results` for the dataset reflects the answers: the evaluation decision
  `ok` and its source `reviewer`, and the answered checks leave `review_required`.

## Failure Signals

- A section's map mode leaves layers behind after closing it, or the drone opacity
  stays changed.
- An answer is stored without a run, or on the wrong layer or crop.
- Images are requested from a static path or fail for an auditor.

## Evidence To Capture

- URL of the section opened.
- Screenshots of the georef, evaluation and prediction map modes.
- Focused DB rows from `audit.assessments` and `audit.dataset_results` for the dataset.
