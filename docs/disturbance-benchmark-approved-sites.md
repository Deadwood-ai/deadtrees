# Approved benchmark sites — 18 November 2026 (DT-1578)

Claudia Leal Medina requested that the viewer include only `ok` sites from
[study_areas](https://docs.google.com/spreadsheets/d/16F0uSG6qOaOK1WxJhPyxo55bwZvk8cBKlRkzBkR_dXY/edit?gid=0).
The selection is pinned in `approvedSiteSelection.json`; only trimmed,
case-insensitive `status == ok` was accepted, using `long_folder` as site ID.
Other columns containing `ok`, review comments or past export flags do not
override her selection. The sheet was read without edits.

The 198 populated status rows contain 104 `ok`, 10 `remove`, 15 `removed` and
69 `new`. The remaining status cells through row 1982 are empty. All 104 approved
IDs occur in the validated 114-site DIST-ANN export. The viewer now exposes
104 sites, 41 countries and 9 products. The same selected entries feed counters,
map, picker and deep-link resolution, so a withdrawn-site URL cannot select it.

Excluded from the existing export:

- Dieback_Canada_2023
- Dieback_Chile2_2024
- Dieback_China_2019
- Dieback_Czechia_2023
- Dieback_Mozambique_2019
- Dieback_Serbia_2024
- Dieback_USA_2024
- Fire_Germany2_2022
- Fire_Mexico_2025
- Logging_Germany2_2021

This is a temporary curator-approved selection, not a live Google Sheets
dependency. To revise it, read the sheet again, review the ID/status diff, and
replace the snapshot in a reviewed PR. New/unknown IDs are excluded until approved.
Do not infer removals from comments when the status remains `ok`.

## Handoff

This PR includes the DIST-ANN description correction from PR #871 and the new
site selection. Prefer this consolidated viewer PR; do not apply both as separate
release updates. Converter PR #3 and its prerequisite #2 are unchanged.

Use the already verified NAS run
`11-Webviewer_visuals/runs/pylos-2026-11-17-v8-dist-ann` and matching WebP build.
No raster conversion, asset re-ingestion or source deletion is needed for this
selection-only update. All retained imagery, masks, metrics and Planet QC remain
unchanged. The count is derived from selected available entries, never hard-coded.

Claudia also said sites were fixed, but her attached screenshot specifically
requested the count/selection change. Pylos/NAS was unreachable during this update;
no newly changed source rasters are claimed to have been retrieved or verified.
The unfinished bilinear/nearest comparison remains on DT-1571 and is not part
of this release. Production publication remains with the maintainer.
