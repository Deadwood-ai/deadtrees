# Automated audit checks

The audit is moving from form filling to oversight of automated checks (DT-1470).
Every check stores what it looked at and every answer, people's and models'.
Dataset verdicts are derived from those rows by versioned rules, so thresholds
and model combinations can change without new model calls. Schema:
`supabase/migrations/20261029103000_audit_checks_base.sql`.

## Model

```text
audit_checks -> audit_check_versions -> audit_check_runs -> evidence -> audit_assessments
                                              |
                                     audit_current_runs (one per dataset and check)
```

| Table | One row per | Written by |
|---|---|---|
| `audit_checks` | check (`dataset_evaluation`, `georef`, `acquisition_date`, `prediction_quality`) | migrations |
| `audit_check_versions` | check version, with `mode`, `is_active` and free-form `config` | worker registers; operators switch mode and active version |
| `audit_check_runs` | run of a version on a dataset; every run is kept | worker |
| `audit_current_runs` | dataset and check: the run whose results count | worker |
| `audit_crops` | window of one ortho version (by `ortho_sha256`) on the 10 cm CLIP grid, in one or more crop sets | worker; only `crop_sets` and `selection` grow |
| `audit_images` | stored image a check judged: raw crop per ortho, overlay per prediction label, overview and thumbnail per ortho | worker |
| `audit_assessments` | assessor, target (crop or dataset) and layer; append-only | worker (model and rule rows), auditors (their own person rows) |
| `audit_benchmark_pins` | dataset whose dev/holdout split was frozen earlier | service role (imports) |

Modes per version: `review_all` (default for every new version), `review_uncertain`,
`auto_apply`. Only an operator (`can_operate`) changes the mode or the active version,
and only one version per check is active. A changed prompt, rule or config is a new
version.

## Assessments

- `assessor_kind`: `person` (`assessor_user_id`), `model` or `rule` (`model` and
  `prompt_version`, e.g. `luna-medium`/`v4`, `band_check`/`v1`; `run_id` required).
- `layer`: `image` (m0 gate on a crop, dataset evaluation on a dataset), `deadwood`,
  `forest_cover`, `georef`, `acquisition_date`, `phenology`.
- `verdict`, one vocabulary for every check:

  | Verdict | Meaning |
  |---|---|
  | `ok` | passes: keep, georef good, date valid, layer fine, crop assessable |
  | `minor` | passes with a problem: keep but fix or reprocess, layer error below 20% |
  | `major` | fails: exclude, georef poor, date mismatch, 20%+ of the layer wrong, crop not assessable |
  | `unsure` | could not decide; goes to a person |

- `modes`: failure modes and flags by key, named by the check. Every key names an
  error, so a high likelihood always means a problem. People store tags
  (`{"m1_dead_missed": true}`); models and rules store
  `{"m1_dead_missed": {"likelihood": 80, "area_pct": 12}}`.
- `label_id`: the prediction judged. No foreign key: after a prediction rerun the row
  is stale and stays as history.
- `reason_code` and `reason_text`: why a person marks a check wrong (the check's fixed
  choices plus text). `details`: the check's parsed answer. `raw`: the model reply.
- Rows are never updated. A correction is a new row; `audit_latest_assessments` shows
  the latest row per target, layer and assessor. `audit_disagreements` lists targets
  where people disagree with each other or with a model or rule in the current run.

## How a check plugs in

1. Register a version (the worker inserts it as `review_all`, inactive).
2. Per dataset, create a run, store its crops, images and run `evidence`, add one
   assessment per model or rule, and point `audit_current_runs` at the run. A check may
   do this in its own `SECURITY DEFINER` store function guarded by
   `internal.is_audit_worker()`.
3. Derive the dataset verdict in the check's own versioned SQL rule and write it to
   `dataset_audit_suggestions` with source `audit:<check>/<version>`.

A worker that cannot reach a model (expired login) leaves its runs `queued`; it never
fails them for that reason.

## Access

Auditors, operators, the audit worker (the processor account) and the analyst role
read everything. Dataset owners and the public see nothing, so model results stay
with auditors. `audit_benchmark_split(dataset_id)` returns `dev` or `holdout`: a pin
if one exists, else a fixed hash of the id (1 in 5 held out). The hash rule must never
change.

## Not yet

`dataset_audit` stays the saved human audit. Renaming it to `dataset_audit_legacy`
behind a compatible view follows in a separate migration once the old audits are
imported as person rows (DT-1487): six views are compiled against the table and the
audit page writes it through the lease trigger.
