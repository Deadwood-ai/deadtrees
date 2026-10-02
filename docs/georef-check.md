# Georeferencing check (`georef_check_v1`)

The processor measures how far an orthophoto is placed from where satellite
imagery shows the same ground, and prefills the audit's georeferencing item
(`dataset_audit.is_georeferenced`, Good means under 15 m). It works like the
acquisition-date check (`docs/doy-estimation.md`): the stage only proposes;
nothing counts as an audit until an auditor saves.

## What runs

1. **Drone image.** The stored COG is read through its overviews onto an
   EPSG:3857 grid of at most 1,400 px per side. Offsets are measured only on
   valid data inside the dataset's AOI (the auditor's AOI first, else the
   predicted one). When the first matching pass leaves the call uncertain, one
   retry hides everything outside the AOI from the matcher; it counts only if
   it decides. Tuned on 100 audited datasets: masking every first pass lost 6
   decisions, and the retry added 2 without new wrong calls.
2. **References.** Every provider in the registry
   (`processor/src/georef_check_v1/providers.json`) whose coverage contains the
   site is rendered onto the same grid, as XYZ/WMTS tiles or a single WMS or
   ArcGIS export of the extent:
   - Esri World Imagery (current), worldwide
   - up to two older dated Esri Wayback captures: the one closest to the
     flight date, then the oldest (the newest is what World Imagery shows)
   - 56 keyless official or open services in 26 countries: every German
     state's DOP, SWISSIMAGE, basemap.at, IGN, PNOA, PDOK, ČÚZK, Geoportal PL,
     Flanders, Wallonia, Luxembourg, Estonia, Slovakia, Slovenia, Croatia,
     Portugal, five Italian regions plus the national 2012 ortho, USGS NAIP,
     NOAA, MassGIS, NYS, Ontario, Calgary, Queensland, NSW, ACT, Western
     Australia, GSI (JP), NLSC (TW), Brasília, INEGI (MX), Uruguay, IGN (AR),
     NGI (ZA) and Cape Town
   - 13 more keyless services marked `restricted`: they need no sign-up, but
     their terms are unclear or restrict automated use (each entry's
     `licence` says how). Used by decision of 2026-10-02; set
     `GEOREF_SKIP_RESTRICTED_PROVIDERS=true` to leave them out. Sweden,
     Greece, Lithuania, Moldova, Tasmania (non-commercial), Victoria (licence
     fee), King County, Santa Clara, Quebec, British Columbia (1995–2004),
     Georgia, Bing aerial and Yandex (EPSG:3395 tiles) worldwide; plus Esri
     Clarity (in the Esri group) and Portugal 2018, both unrestricted
   - MapTiler, Mapbox, Azure Maps and LINZ (NZ) when their keys are set
     (`MAPTILER_API_KEY`, `MAPBOX_ACCESS_TOKEN`, `AZURE_MAPS_KEY`,
     `LINZ_API_KEY`)

   Each provider is its own evidence group unless it serves the same imagery as
   another (Wayback and Clarity with Esri). Only services with an open licence for
   automated use are listed unmarked; Google's satellite tiles are refused to EEA
   accounts (Map Tiles API EEA terms) and its terms forbid analysing the
   imagery, so Google is not used. `scripts/check_georef_providers.py` renders
   every provider at its check site; run it when adding one and now and then,
   because public services move (several URLs carry a year).
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

   Otherwise it is `qualified`. When references were fetched, nothing matches
   at all, and the footprint centre lies within ~110 m of the equator or the
   prime meridian, a coordinate was lost: Poor (`gross`).

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

- Provider check: `python3 scripts/check_georef_providers.py` (all keyless
  providers render real imagery as of 2026-10-02).
- Rollout: new uploads queue the stage only once every processor host runs it
  (`UPLOAD_TASK_TYPES` and the upload modal's step list). Stage the model asset
  on each host before the release that adds the stage reaches it.

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
