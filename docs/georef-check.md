# Georeferencing check (`georef_check_v1`)

The processor measures how far an orthophoto is placed from where satellite
imagery shows the same ground, and prefills the audit's georeferencing item
(`dataset_audit.is_georeferenced`, Good means under 15 m). It works like the
acquisition-date check (`docs/doy-estimation.md`): the stage only proposes;
nothing counts as an audit until an auditor saves.

## What runs

1. **Drone image.** The stored COG is read through its overviews onto an
   EPSG:3857 grid of at most 1,400 px per side. Only valid data inside the
   dataset's AOI is used (the auditor's AOI first, else the predicted one), so
   artifacts outside the AOI are not matched.
2. **References.** Tiles covering the same extent are mosaicked onto the same
   grid:
   - Esri World Imagery (current)
   - up to two dated Esri Wayback captures: the one closest to the flight date
     and the newest
   - Google (Map Tiles API), MapTiler and Mapbox satellite when their keys are
     set
3. **Matching.** RoMa v2 (vendored in `processor/src/georef_check_v1/romav2`)
   matches the drone image with each reference.
4. **Evidence per reference.** A similarity transform is fitted with RANSAC to
   the confident matches. The geodesic move of each footprint pixel is the
   offset; p90 over the supported area is the reference's measurement. The
   reference *qualifies* when it has:
   - at least 100 inliers
   - at least 50% of the matches agreeing with the fit
   - inliers in at least 4 of 16 grid cells
   - at least two quadrant holdouts

   It *decides* when it also supports at least 30% of the AOI. A p90 that
   crosses 15 m under a holdout makes it unstable.
5. **Call.** The deciding references agree, so the dataset is Good or Poor, or
   they disagree or are unstable, so it is uncertain. The call is `strong` when
   all of these hold:
   - at least 2 independent reference groups decide (Esri and its Wayback
     captures count as one group)
   - at least 80% of the AOI is supported, and of its edges for a Good call
   - every p90 is at least 3 m away from 15 m

   Otherwise it is `qualified`. When nothing matches and the footprint sits on
   the equator or the prime meridian, the coordinates were lost: Poor (`gross`).

## What it stores

- `v2_georef_checks`, one row per dataset, replaced on rerun:
  - the decision and evidence level, with the median p90
  - for each reference: inliers, coverage, p90 and holdout p90s, its vote, and
    up to 200 matched point pairs in lon/lat
  - the keyless tile URL of each reference, for the audit viewer
  - provider errors
- A Good or Poor call becomes the `is_georeferenced` row in
  `dataset_audit_suggestions` (source `georef_check_v1`, reason = evidence
  level). An uncertain call removes it.

## How it reaches auditors

- The audit form prefills an empty georeferencing item with the suggestion,
  marked "suggested".
- When a newer suggestion disagrees with a saved audit, `audit_review_queue`
  lists the dataset, and it appears in the Re-review tab. Saving the audit
  again takes it off.
- The georeferencing card shows the measurement. *Show matching* opens a viewer
  with the drone image over the matched reference, an opacity slider, and the
  matched points coloured by offset.

## Operations

- Bulk (re)runs: `scripts/requeue_georef_check.py`. Use `--audited` for the
  backfill against existing audits. It selects datasets without a check or with
  other rules or another matcher.
- Model asset: `make download-georef-model` (`models/georef_check_v1`, built by
  `scripts/package_georef_check_model.py`).
- Runtime: about 10 s per dataset on a GPU with 2–4 references. Peak VRAM is
  several GB, because RoMa's local correlation runs without the fused CUDA
  kernel.
- Limits:
  - Closed canopy, tundra and dark images often give no confident matches, so
    the result is uncertain.
  - Land placed in the ocean is only caught when it sits on the equator or
    prime meridian.
  - Basemaps are references, not surveyed ground truth.
