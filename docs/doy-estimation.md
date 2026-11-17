# Acquisition-date estimation (`doy_estimation_v1` stage, model `doy_estimation_v2`)

A processing stage that predicts, for every dataset, a probability distribution
over the day of the flight year from the orthophoto itself and, where the
Sentinel pipeline has processed the site, the Sentinel-2 weekly series of the
flight year. In the Audit Review the model is called **AerialStamp**: it reports whether
the recorded date should be replaced and by which date; it never changes the dataset.

Cite: Mosig, C., Montero Loaiza, D., Mahecha, M., Vajna-Jehle, J., Kattenborn, T. (2026).
AerialStamp: estimating the acquisition date of aerial orthophotos. EarthArXiv,
https://eartharxiv.org/repository/view/15721/. Code: github.com/cmosig/aerialstamp.

The stage is still called `doy_estimation_v1`; the model it runs is versioned
separately by its asset directory, and every estimate records that version in
`model_version`.

The deployed model `doy_estimation_v2` is the platform build of the AerialStamp
paper model: the paper's recipe, refit on all public and private dated
orthophotos with a Sentinel-2 series (8,825).
Its image-only model is the processor's `nos2` model type. Spatial block
cross-validation of the same recipe on 8,777 clean dates:

| model | used for | MAE | block-weighted MAE | median | 80 % set coverage / width |
|---|---|---|---|---|---|
| S2 | datasets with S2 weeks in the flight year | 31.5 d | 33.3 d | 18.5 d | 0.81 / 96 d |
| no-S2 (image only) | everything else | 40.3 d | 42.4 d | 25.9 d | 0.82 / 126 d |

These numbers are not comparable one to one with v1's (S2: MAE 27.9 d on S2
sites; no-S2: 40.9 d): v2 is evaluated with spatial blocks and on a different
date set. Two changes matter for the processor:

- The site facts "S2 weeks available" and "match features available" (static
  columns 7 and 8) leaked the label into v1 and are zeroed in v2. The converted
  configs list them as `static_masked`, and the model zeroes them itself.
- Both models use one calibration (T = 2, no smoothing); v1's per-biome
  calibration of the no-S2 model is gone, so `inputs.calibration.biome` is
  null for v2 estimates.

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

`assets/models/doy_estimation_v2/` (360 MB): `manifest.json` (recipe,
calibration, cross-validated metrics, hashes), `{s2,nos2}_seed{0-4}.safetensors`
and the DINOv2 backbone `dinov2_vitb14_reg4.safetensors` (the same file as in
v1). Built from the AerialStamp weights by
`scripts/package_doy_estimation_model.py ... --version doy_estimation_v2
--backbone <v1 backbone>` (no pickles in the processor) and part of the
processor asset preflight.

The archive `doy_estimation_v2.tar.gz` is a public asset (`ASSETS_BASE_URL`,
`/data/assets/models/` on the storage server), fetched by
`make download-processor-assets` or `make download-doy-model`. The weights
hold no imagery: date heads on DINOv2 embeddings of 16 patches per
orthophoto. Stage the model on every processor host before a release that
needs it, as [`processor-hosts.md`](playbooks/processor-hosts.md#prs-that-add-or-change-a-required-asset) describes.

v1 (`doy_estimation_v1`, public archive) is no longer required. The loader still
reads it, so a rollback is a revert plus the v1 directory on each host.

## Storage

`v2_acquisition_date_estimates`, one row per dataset, replaced on rerun:
the 365-bin calibrated `probabilities`, `model_version`, `model_type`
(`s2` / `nos2`), the recorded date it was assessed against, predicted/mode
date, highest-density sets (`hdi`), `n_modes`, the mismatch assessment, the
suggestion, and `metadata` (S2 lookup, inputs, calibration, rule thresholds).
Readable like the dataset; written by the processor.

## Rules

Thresholds calibrated on out-of-fold predictions of the v1 recipes
(`n = 8,987` dated orthophotos); the AerialStamp paper uses the same rule, so
v2 keeps them. The flag rates and accuracies quoted below are v1's.

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

## Audit Review output

`audit.acquisition_date_output_v1(v2_acquisition_date_estimates)` turns the stored
estimate into the Audit Review's output (`audit.dataset_outcomes`,
`docs/audit-checks.md`), computed when it is read:

- **Confident**: one mode and an 80 % range of at most 90 days (the accept
  recommendation above).
- **Reason**: `mismatch` (a huge mismatch), `missing_month` (only a year recorded) or
  `missing_day` (only a month recorded, and the predicted date falls in it).
- **Replace**: a reason and a confident estimate; the new date is the predicted date.
- Also reported: the predicted date, the 80 % range in days, the modes, the model
  version and when it was estimated.

A reviewer may override replace yes or no with a note (an `audit.dataset_human_reviews`
row, check `acquisition_date`, with `date_replace`); the newest answer wins, and the
suggested date of the dataset page includes it. The answer records the advice it was
given on (replace or keep): it keeps counting after a rerun as long as the advice is the
same, and only an estimate whose advice flips asks for a date review again. Nothing
writes `v2_datasets`: the stage stores the estimate only, without audit rows, suggestions
or decisions. The earlier `acquisition_date_decisions` stay as read-only history, and a
dataset whose date was replaced by an accepted suggestion keeps
`aquisition_date_source = 'model_suggestion'` until its date is edited by hand.

## Existing datasets: out-of-fold estimates

`doy_estimation_v2` learned from the recorded dates of 8,825 datasets of the
2026-10-08 snapshot. Its estimate for one of them is in-sample: pulled toward
the recorded date, with too narrow a set, so it hides exactly the wrong dates
the audit should see (of 107 recorded dates the fold models find implausible,
the deployed model flags 35). The datasets that existed at the switch to v2
were therefore run once, outside the queue: every dataset of the snapshot with
the cross-validation fold model that held it out, everything else with the
deployed model. Same code, inputs, model version (`doy_estimation_v2`) and
calibration as the stage; the fold is recorded in `metadata.oof`
(`{"fold": k, "package": ..., "snapshot": "2026-10-08"}`, `fold: null` for the
deployed model). The fold models were used for this run only; new datasets and
every later rerun use the deployed model.

`scripts/import_doy_estimates.py <bundle>` writes such a run the way the stage
writes its own rows (estimate upsert with the supersede trigger, suggestions,
status flag, clears), only for rows that still describe their dataset (not
archived, same recorded date, no newer estimate). The default is a dry run with
the analyst login that reports the counts and the decisions the trigger would
reopen; `--rehearse` writes and rolls back, `--execute` commits in batches. It
is a production write: run it only with approval, as
[approved-production-writes.md](playbooks/approved-production-writes.md)
describes.

A plain `requeue_doy_estimation.py` leaves these rows alone (current model
version). `--all`, or a changed recorded date, replaces them with an in-sample
estimate of the deployed model.

## Rerun for all datasets

```bash
python3 scripts/requeue_doy_estimation.py --dry-run          # counts per reason
python3 scripts/requeue_doy_estimation.py                    # missing / older model version (v1) / date changed
python3 scripts/requeue_doy_estimation.py --retry-s2         # + no-S2 estimates whose S2 may exist now
python3 scripts/requeue_doy_estimation.py --all              # everything with a COG
```

Queued at priority 1 (behind uploads), task `doy_estimation_v1` only. A rerun
replaces the estimate, and with it the Audit Review output at once; no VLM check runs.
