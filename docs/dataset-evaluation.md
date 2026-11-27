# Dataset evaluation check

The first step of the automated audit (DT-1483, parent DT-1470) and the only check with
a decision: per dataset keep, exclude or unsure (a person decides). It also reports COG
and thumbnail issues. It plugs into the audit framework like every check
([audit-checks.md](audit-checks.md)): one `audit.runs` row per run, one
`audit.dataset_vlm_judgements` row per model.

Code: `processor/src/dataset_evaluation_v1/`; the audit worker runs it through
`handler.py` (`worker.HANDLERS['dataset_evaluation']`, see the audit worker section of
[audit-checks.md](audit-checks.md)).

## What it looks at

The orthophoto alone. The area of interest is a check of its own and the predictions
are judged by the prediction quality check, so neither plays a part here (version 2,
DT-1538; version 1 judged inside the AOI and drew its edge on the overview).

The code is the version (now v3): the handler refuses a run that was queued for an
earlier version (the run fails with that reason), so an old version's results never hold
the new version's answers. An operator activates a version, with its rules, before the
worker judges with it.

Read from the stored COG at run time (`utils/stored_inputs.local_cog`, so private
datasets work):

| Image | Size | Purpose |
|---|---|---|
| Overview | at most 2048 px, about 30 cm/px | the whole flight; no-data black |
| 4 tiles | CLIP tiles (51.2 m windows on the 10 cm UTM grid of `v2_tile_embeddings`) at 5 cm, 1024 px, or native when coarser | sharpness and artifacts; picked by a seeded k-means spread of the tiles over the data, so a rerun judges the same tiles. A dataset without CLIP tiles gets 1024 px native windows inside the data instead |
| Thumbnail | the stored 256 px website thumbnail | thumbnail issues |

Footprint padding without a mask (solid white or black connected to the image edge) is
no-data, as in `utils/nodata.py`. A run is ready once the COG, the thumbnail and the
CLIP tiles exist (`ready`).

## What a run stores

The handler uploads the images the models judged to the storage server under
`audit/dataset_evaluation/<dataset>/run-<run>/` (`overview.jpg`, `tile-<n>.jpg`,
`thumbnail.jpg`) and returns the run to the worker, which stores it with one call,
`audit.finish_run`: all or nothing, and the run is done.

- `audit.tiles`: the judged windows, keyed by their grid window (a tile prediction
  quality already stored is the same row; native fallback windows are off the grid).
- `audit.images`: the run's images, kinds `overview`, `raw` (a tile) and `thumbnail`.
- `audit.dataset_vlm_judgements`: one row per model. The verdict is the model's call
  (keep `ok`, fix `minor`, exclude `major`, can't tell `not_assessable`), `likelihood`
  its exclude likelihood, `exclude_reason` its reason, `cog_issue` and
  `thumbnail_issue` set when it puts them at 50 or more, and a one-sentence `summary`.
  `raw` holds the parsed answer: every flag's 0-100 likelihood (blurry, not_rgb,
  no_trees, broken_ortho, too_dark, artifacts, cog_issue, thumbnail_issue, reprocess),
  sharpness, lighting, leaf state (a hint only), image type, scene and land cover from
  the fixed lists in `vocabulary.py`, seconds and attempt.
- The run: `inputs` is the ortho sha256, read again at run time. `evidence` holds the
  resolution, valid share, footprint, tile settings, `empty` (under 0.5% of the overview
  is valid data: no model is asked), the band check, coverage and cost.

The band check (`bands.py`) reads wrong bands from the upload's raster profile
(`v2_orthos.ortho_info`) and the COG band statistics and stores a likelihood that the
image is not an RGB photo, with its findings: one or two colour bands or identical bands
95 or 90; red or purple dominance (near-infrared or mis-decoded multispectral) is a guess
capped at 85.

## Keep or exclude

The database works the decision out from the stored answers with the version's active
rules (`audit.check_rules`, rules-v1 `{"decider": "haiku", "band_major_at": 90}`), in
the view `audit.evaluation_calls`:

1. an empty COG excludes as `broken_ortho`;
2. a band check at `band_major_at` or more excludes as `not_rgb`;
3. otherwise the deciding model's verdict (the judge whose name starts with `decider`):
   `ok` or `minor` keeps, `major` excludes with its reason, `not_assessable` or no answer
   is unsure and asks a person.

The COG and thumbnail issues are the deciding model's, whatever the verdict. Luna's answer
is stored and shown next to Haiku's, not counted; which model decides will follow from the
benchmark. New rules apply to every dataset at once, without model calls.

The evaluation decision (`audit.evaluation_decisions`, `docs/audit-checks.md`) is a
person's review that still counts, else the old manual audit's keep, else this check's
call, else the old manual audit's exclude. Unsure is no decision and asks a person until
a reviewer answers. Exclude is the only reason a dataset leaves the public surface.

## Rerun

The worker queues a run when a dataset finishes processing and the latest run of the
active version judged another ortho (or there is none). A new ortho therefore reruns the
check, and every human review of the dataset stops counting, because it judged the old
image. A new AOI or prediction does not rerun it: the check looks at the ortho alone. A
new version reruns every dataset once the operator queues the backfill; until a dataset's
rerun finishes its last result keeps counting, read with its own version's rules.

## Models

The judges are the audit worker's subscription backends (`audit_worker.models`), named
in the version's `CONFIG['models']`: `luna-medium` through the Codex login (gpt-6-luna,
medium effort) and `haiku-5.5` through `claude -p`. Each call runs without tools and
gets the six images inline. A malformed reply is asked once more; login and usage-limit
errors reach the worker, which pauses instead of failing the run. Cost records seconds
and calls per model; subscription calls report no tokens or dollars.
