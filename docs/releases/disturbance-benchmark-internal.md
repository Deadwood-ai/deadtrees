# Internal forest disturbance benchmark (DT-1410, DT-1411)

## What it is

`/releases/disturbance-benchmark` (optional `?site=<site-id>`) shows the forest
disturbance benchmark: 114 drone reference sites, saved satellite-product
predictions, Sentinel and Planet time series, and Planet, Google and Esri context
imagery. It is for the **core team only** and is not listed in the public releases
catalogue, sitemap or announcements.

The context imagery belongs to Planet, Google and Esri and may not be
redistributed. A public launch needs a separate imagery-rights review.

## Access

- The page opens for signed-in users with the `can_audit` privilege, using the same
  check as the other core-team features (`canUseCoreTeamAppFeature`). Everyone else
  is sent to `/releases`.
- `POST /api/v1/disturbance-benchmark/access` returns a one-hour signed link prefix
  (`/disturbance-benchmark/files/<ticket>`) to `can_audit` users only (401 without
  a session, 403 outside the core team). The page refreshes it before it expires.
- `GET /api/v1/disturbance-benchmark/files/<ticket>/<path>` rechecks the ticket and
  `can_audit` for every file and hands it to nginx (`X-Accel-Redirect` to
  `/_protected_cacheable/`). Every failure is the same 404. Browsers may keep a file
  for the life of its link (`Cache-Control: private, max-age=3600`), so a user
  removed from the core team can still see already-loaded images for up to an hour.
- Grant or revoke access by changing `privileged_users.can_audit`.

## Data on the storage server

The export lives outside every static nginx location:

```text
/data/releases/disturbance-benchmark/<run-id>/   one folder per export
/data/releases/disturbance-benchmark/current     symlink to the active folder
```

`DISTURBANCE_BENCHMARK_DIR` (default `releases/disturbance-benchmark/current`,
relative to `BASE_DIR`) names the served folder. The viewer requests
`catalog.json` and the `/data/<site>/...` paths written in it, relative to that
folder; keep the export's names and structure unchanged.

The source export is on the Freiburg NAS (only `export/` is web payload; the
reports beside it stay internal):

```text
\\unfnrd02.public.ads.uni-freiburg.de\unfnrd02\projects\deadtrees\disturbances\11-Webviewer_visuals\runs\pylos-2026-10-15\export
```

Run `pylos-2026-10-15`: 114 sites, 16,253 files, about 940 MB, zero missing
references (`handoff-audit.json`). Conversion code:
https://github.com/Deadwood-ai/disturbance_benchmark_visuals.

### Installing or replacing an export

Uploading to the storage server is a production write and needs explicit approval.

1. Copy the export into a new run folder next to `current`, e.g.
   `/data/releases/disturbance-benchmark/pylos-2026-10-15/`.
2. Check the file count and size against `handoff-audit.json`.
3. Point `current` at the new folder (`ln -sfn <run-id> current`). Keep the
   previous folder until the new one is checked, for rollback.
4. As a core-team user, open the page and check site switching, overlays, galleries,
   all three context sources and the time series. As a non-core user, check that
   the page redirects and that a copied file link returns 404.

## Data limitations to keep visible

- 233 saved b+y overlays across 41 sites; 73 sites have no saved prediction. Keep
  those sites and their warnings; never show missing products or scores as zero.
- Predictions are the saved `*_by_pred_res.tif` (preceding year b or flight year
  y). DTE uses `dt_fc_dw_comb_by`. The frontend does not rethreshold anything.
- Precision, recall and F1 are NA. Flight IDs and dates follow Claudia's site sheet;
  keep source warnings such as the Brazil3 flight/prediction mismatch.
- Binary masks stay lossless PNG. JPEGs are display imagery. Planet GCC is an RGB
  greenness proxy, not NDVI. Smoothing is display only.
- Keep the Planet, Google and Esri credits and the dataset licence links.
