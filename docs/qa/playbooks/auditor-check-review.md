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
  - /dataset-audit?tab=to-review
  - /dataset-audit/91090
```

## Purpose

Verify the audit page as oversight of the automated checks (DT-1486): the sections
in order, each check's map mode, answers stored as person rows in
`audit.assessments`, the stored images the checks judged, the derived decision and
the check queue tabs.

## Preconditions

- The isolated stack is up, reset and validated; `.local/supabase/current.env` is sourced.
- Seed dataset 91090 with check results (the QA reset removes it again):
  `python3 scripts/qa/seed-audit-checks.py` (needs `assets/test_data/test-data.tif`
  or a GeoTIFF path as the argument).
- Sign in as `qa-auditor-local@example.com`.

## Steps

1. Open `/dataset-audit?tab=to-review`; the seeded dataset lists one row per check
   result with its automated result and reason. Open `Disagreements`.
2. Open `/dataset-audit/91090?section=georef`. The map shows the Bing reference under
   the drone image with match lines; the panel switches reference and opacity.
3. Before answering, other reviewers' and the models' answers are hidden. Mark the
   check wrong with a reason and a note; the answer, the models and the other
   reviewer's answer appear, and the read-only saved audit field follows the answer.
4. Open `1. Dataset evaluation`: agree; the four crops show on the map and
   "Show what the model saw" loads the overview, then a crop's image after a click.
5. Open `6. Prediction quality`: step through crops with n / p, answer a crop, and
   switch the model image between raw, deadwood and forest.
6. Confirm the derived decision, add a note and save.

## Expected Observations

- Sections read: user reports, 1 Dataset evaluation, 2 AOI, 3 Georeferencing,
  4 Acquisition date ("Not run yet" without an estimate), 5 Phenology (manual),
  6 Prediction quality.
- Each answer is a new `audit.assessments` row with `assessor_kind = 'person'`, the
  current `run_id` and, for "Check wrong", `reason_code` and `reason_text`.
- Crop answers carry `crop_id` and the layer.
- Images load through `/api/v1/audit/images/files/<ticket>/...`.
- An answer sends one request and the page does not reload its checks.
- After a reload without saving, the saved audit fields of answered checks still show the answers.
- `dataset_audit` holds the confirmed final assessment and the fields the answers set.

## Failure Signals

- A section's map mode leaves layers behind after closing it, or the drone opacity
  stays changed.
- Answers of others are visible before answering without "Show now".
- An answer is stored without a run, or on the wrong layer or crop.
- Images are requested from a static path or fail for an auditor.

## Evidence To Capture

- URL of the section opened.
- Screenshots of the georef, evaluation and prediction map modes.
- Focused DB rows from `audit.assessments` and `dataset_audit` for the dataset.
