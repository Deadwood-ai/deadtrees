# Acquisition-date estimation (`doy_estimation_v1`)

A processing stage that predicts, for every dataset, a probability distribution
over the day of the flight year from the orthophoto itself and, where the
Sentinel pipeline has processed the site, the Sentinel-2 weekly series of the
flight year. The distribution feeds the audit (prefilled, never auto-saved) and
a suggested date on the dataset page.

The model is the research model `doy_estimation/deploy/v1` (report:
`side_projects/doy_estimation/report.pdf` in the sentinel-mortality repo).
Cross-validated on the database's own dates:

| model | used for | MAE | median | 80 % set coverage / width |
|---|---|---|---|---|
| S2 | datasets with S2 weeks in the flight year | 27.9 d | 17.0 d | 0.81 / 87 d |
| no-S2 | everything else | 40.9 d (47.1 d on non-S2 sites) | 26.9 d | 0.82 / 126 d |

## Pipeline

`upload -> ... -> aoi_v1 -> embeddings_v1 -> doy_estimation_v1`

- Reads the **stored COG** (`cogs/<cog_path>` on the storage server; the one
  from this run's cog stage if present) and the dataset's AOI (auditor AOI
  before the predicted one; whole-image AOIs count as none). It does not need
  the transient standardized ortho, so it is not in
  `TASKS_REQUIRING_STANDARDIZED_ORTHO` and can be queued on its own.
- Needs `metadata` (biome, for the per-biome calibration of the no-S2 model)
  and `cog`.
- 16 random 10 cm patches inside the AOI (seeded by dataset id) -> DINOv2
  ViT-B/14 embeddings -> 5-seed ensemble -> calibration. About 10 s per dataset
  on the GPU (a few seconds of S3 reads when S2 is used).
- S2 problems never fail the stage; they fall back to the no-S2 model and are
  recorded in `metadata.s2.status` (`ok`, `no_block`, `outside_archive`,
  `no_credentials`, `error`).

### Sentinel-2 block cubes

The Sentinel pipeline stores S2 in 30 km UTM blocks,
`s3://frct-sentinel2/sentinel-2-cubes/block_{epsg}_{minx}_{miny}.zarr` (zarr v3,
uint16 DN, 0 = nodata, weekly composites; southern blocks use 326xx zones with
negative northings). The block name follows from the coordinates, so neither the
world-index gpkg nor the Sentinel pipeline's database is needed: the stage tries
the site's UTM zone and both neighbours (the grid puts zone-edge sites into the
neighbouring zone), takes the first block containing the site whose `zarr.json`
exists on S3, and reads only the site window of the flight year +- 35 days.
Replayed over all 10,775 datasets against the pipeline's block table, the rule
picks exactly the grid's block for all 9,924 datasets in a finished block (and
finds S2 for 16 more in a neighbouring zone's block).

The model was trained on per-dataset cubes. On 29 sites with both, the block
crop gave the same distributions (median L1 0.027; predicted date shift median
0 d, p90 3 d, max 11 d; MAE 15.6 vs 15.8 d).

Config (processor env, see `.env.example`): `SENTINEL2_S3_ACCESS_KEY_ID`,
`SENTINEL2_S3_SECRET_ACCESS_KEY` (read-only keys). Without them every dataset
gets the no-S2 model.

### Model assets

`assets/models/doy_estimation_v1/` (360 MB): `manifest.json` (recipe,
calibration, cross-validated metrics, hashes), `{s2,nos2}_seed{0-4}.safetensors`
and the DINOv2 backbone `dinov2_vitb14_reg4.safetensors`. Built from the
research package by `scripts/package_doy_estimation_model.py` (no pickles in
the processor), downloaded by `make download-doy-model` from
`$(ASSETS_BASE_URL)/models/doy_estimation_v1.tar.gz`, and part of the processor
asset preflight.

## Storage

`v2_acquisition_date_estimates`, one row per dataset, replaced on rerun:
the 365-bin calibrated `probabilities`, `model_version`, `model_type`
(`s2` / `nos2`), the recorded date it was assessed against, predicted/mode
date, highest-density sets (`hdi`), `n_modes`, the mismatch assessment, the
suggestion, and `metadata` (S2 lookup, inputs, calibration, rule thresholds).
Readable like the dataset; written by the processor.

## Rules

Calibrated on out-of-fold predictions of the deployed recipes
(`n = 8,987` dated orthophotos).

- **Modes ("bumps")**: arcs of the 90 % highest-density set holding >= 10 %
  probability each. Evergreen tropics and spring/autumn confusions give two;
  then a far-away recorded date can still be right, so it is never flagged.
  (The stricter "80 % set is one arc" test would switch the check off for half
  of the tropics.)
- **Huge mismatch**: recorded date (for a month-only date: its best day)
  outside the 99 % set, >= 60 days from the predicted date, one mode.
  Flag rates: clean dates 0.9 % (S2) / 1.2 % (no-S2); audit-invalid dates
  7/17 (no-S2); 1-January placeholders 4/35 (S2) and 6/19 (no-S2).
- **Suggested date**: the predicted date (circular median) when the month is
  missing or on a huge mismatch.
- **Accept recommendation**: one mode and an 80 % set of <= 90 days. Those
  estimates have MAE 17.7 d (S2, 57 % of S2 datasets) / 20.8 d (no-S2, 22 %),
  80-83 % within 30 days.

## From suggestion to decision

Methods write-up with examples: section 8 of the research report
(`side_projects/doy_estimation/report.pdf` in the sentinel-mortality repo).

- **Predicted vs suggested date.** Every estimate has a predicted date (the
  circular median). A suggested date is the same value, but only offered as a
  replacement for the dataset's date when the month is missing or on a huge
  mismatch.
- **Suggestions** (`dataset_audit_suggestions`, generic for any source) prefill
  empty audit fields, tagged "suggested"; nothing is saved. This stage suggests
  `has_valid_acquisition_date` (false only on a huge mismatch),
  `accept_suggested_acquisition_date` (the recommendation, only with a
  suggestion) and `acquisition_date_notes`.
- **Decisions** (`acquisition_date_decisions`) are the outcome of the date
  check: date valid?, suggestion accepted/rejected, reported and resulting
  date, model version, evidence snapshot (distribution, ranges, offset). Saving
  the audit records the auditor's decision (trigger). With `DOY_AUTO_DECIDE=true`
  the processor records the prefill as an automatic decision when no person has
  decided; an automatic decision never replaces a person's.
- **Accepting** writes the suggested date to `v2_datasets` as a full day with
  `aquisition_date_source = 'model_suggestion'` and a pointer to the decision
  (`aquisition_date_decision_id`); the change is logged in
  `v2_dataset_edit_history`. The dataset page shows the date as
  "model-suggested" with the reported date and the evidence.
- **One active decision per dataset.** Older ones are deactivated, never
  overwritten, with date and reason: `new_decision` (re-audit),
  `estimate_contradicts` (a new estimate of the same date disagrees: decided
  fine but now a huge mismatch; decided wrong and kept but now no problem;
  month missing and an undecided suggestion), `date_edited` (hand edit),
  `cutoff` (operator). Deactivation clears the audit's date fields, so the form
  is prefilled again; `acquisition_date_review_queue` lists datasets without an
  active decision.
- **Existing audits** became `legacy_audit` decisions dated by their audit; they
  stay active unless the first estimate contradicts them.
- **Downstream readers** of `dataset_audit.has_valid_acquisition_date` see
  `null` for a reopened check; the active decision is the source of truth.

## Rerun for all datasets

```bash
python3 scripts/requeue_doy_estimation.py --dry-run          # counts per reason
python3 scripts/requeue_doy_estimation.py                    # missing / old model version / date changed
python3 scripts/requeue_doy_estimation.py --retry-s2         # + no-S2 estimates whose S2 may exist now
python3 scripts/requeue_doy_estimation.py --all              # everything with a COG
```

Queued at priority 1 (behind uploads), task `doy_estimation_v1` only. A rerun
replaces estimates and suggestions; decisions it contradicts are reopened, the
others stay. To re-check every decision made before a date (e.g. after a model
upgrade), run as service role before queueing:

```sql
select public.supersede_acquisition_date_decisions_before('2026-10-01');
```
