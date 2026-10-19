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
  `can_audit` for every file (the privilege is cached for 30 seconds per user) and hands it to nginx (`X-Accel-Redirect` to
  `/_protected_cacheable/`). Every failure is the same 404. Browsers may keep a file
  for the life of its link (`Cache-Control: private, max-age=3600`), so a user
  removed from the core team can still see already-loaded images for up to an hour.
- Grant or revoke access by changing `privileged_users.can_audit`.

## Data on the storage server

Each published run is a folder next to a `current` symlink, outside every static
nginx location:

```text
/data/releases/disturbance-benchmark/<run-id>/   one folder per published run
/data/releases/disturbance-benchmark/current     symlink to the active run
```

`DISTURBANCE_BENCHMARK_DIR` (default `releases/disturbance-benchmark/current`,
relative to `BASE_DIR`) names the served folder. The viewer requests
`catalog.json` and the `/data/<site>/...` paths written in it, relative to that
folder.

### Production nginx

Production nginx is the host config on data2
(`/apps/deadtrees/nginx/conf/storage-server.conf`), not this repository, so it
changes by hand like the [dataset access rollout](../playbooks/dataset-access-rollout.md):
keep a copy, edit, `nginx -t`, `systemctl reload nginx`. Copy from
`nginx/api-conf/storage-server.conf`:

1. Add `disturbance-benchmark/files/` to the ticket regex location
   `^/api/v1/(datasets/[0-9]+/files/|exports/|disturbance-benchmark/files/)`, so
   signed links stay out of the access log.
2. Add the internal `location ^~ /_protected_cacheable/` block (private one-hour
   caching, gzipped JSON). Without it every benchmark file returns 404.

## Publishing a new run

Claudia's conversion runs land on the lab NAS, which the processing server mounts
read-only at `/mnt/gsdata` (Kerberos keytab, renewed by the `nas-kinit` user
timer):

```text
/mnt/gsdata/projects/deadtrees/disturbances/11-Webviewer_visuals/runs/<run-id>/export
```

Conversion code: https://github.com/Deadwood-ai/disturbance_benchmark_visuals.
`scripts/disturbance_benchmark_publish.py` turns a run into the web build and
publishes it. Run it on the processing server with a Python that has Pillow:

```bash
python3 -m venv ~/.local/share/deadtrees/benchmark-venv
~/.local/share/deadtrees/benchmark-venv/bin/pip install pillow
```

```bash
PY=~/.local/share/deadtrees/benchmark-venv/bin/python
$PY scripts/disturbance_benchmark_publish.py build            # newest clean run
$PY scripts/disturbance_benchmark_publish.py publish --dry-run
$PY scripts/disturbance_benchmark_publish.py publish          # production write
$PY scripts/disturbance_benchmark_publish.py switch <run-id>  # rollback
$PY scripts/disturbance_benchmark_publish.py status
```

- **build** picks the newest run whose `handoff-audit.json` lists no missing
  references (or the run folder given), converts JPEGs to WebP (quality 80) and
  PNG masks to lossless WebP, writes a 640 px `.preview.webp` for images over
  100 KB (drone, Google, Esri) and adds it as `preview` / `dronePreview` in the
  JSON, rounds reference-polygon display coordinates to 5 decimals, rewrites the
  paths and fails if any referenced file is missing. Builds go to
  `~/data/disturbance-benchmark/builds/<run-id>`. Run `pylos-2026-10-15`:
  929 MB to 504 MB, about two minutes on 16 cores.
- **publish** uploads the build to `/data/releases/disturbance-benchmark/<run-id>`
  next to the earlier runs. Files identical to the
  current run are hard-linked, so a new run only costs its changed files. It then
  switches `current` and prints the rollback command. Old runs are not deleted.
- Publishing is a production write: run it only with approval for that run, then
  check the page as a core-team user (site switching, overlays, galleries, all
  context sources, time series).

### Upload access

The script uploads with rsync over SSH as `root@data2.deadtrees.earth` using the
processing server's existing storage key, `~/.ssh/processing-to-storage` (the one
the processors upload with). `BENCHMARK_REMOTE` and `BENCHMARK_SSH_KEY` override
the destination and key.

## Data limitations to keep visible

- 233 saved b+y overlays across 41 sites; 73 sites have no saved prediction. Keep
  those sites and their warnings; never show missing products or scores as zero.
- Predictions are the saved `*_by_pred_res.tif` (preceding year b or flight year
  y). DTE uses `dt_fc_dw_comb_by`. The frontend does not rethreshold anything.
- Precision, recall and F1 are NA. Flight IDs and dates follow Claudia's site sheet;
  keep source warnings such as the Brazil3 flight/prediction mismatch.
- Binary masks stay lossless (PNG in the export, lossless WebP on the web). RGB images are display imagery. Planet GCC is an RGB
  greenness proxy, not NDVI. Smoothing is display only.
- Keep the Planet, Google and Esri credits and the dataset licence links.
