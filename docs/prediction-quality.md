# Prediction quality check

The last step of the automated audit (DT-1484, parent DT-1470). Per dataset it judges the
deadwood and the forest cover prediction on tiles: each judge answers per tile and layer
OK, Minor, Major, Ambiguous or can't tell. It plugs into the audit framework like every
check ([audit-checks.md](audit-checks.md)): one `audit.runs` row per run, one
`audit.tile_vlm_judgements` row per judge, tile and layer. It stores no dataset verdict.

Code: `processor/src/prediction_quality_v1/`; the audit worker runs it through
`handler.py` (`worker.HANDLERS['prediction_quality']`).

## What it looks at

A tile is one CLIP tile (`v2_tile_embeddings`: 51.2 m on the 10 cm UTM grid, in the UTM
zone of the ortho's centre), rendered at 5 cm (1024 px) from the stored COG, so private
datasets work. Only tiles inside the AOI (90% of the tile) are judged; an AOI smaller
than a tile is judged on the tiles it touches, and a dataset without an AOI on all its
tiles. The predictions are the dataset's active labels of the preferred model
(`v2_model_preferences`), the newest per layer.

Two tile sets, picked from the predicted cover of every tile:

| Set | Tiles | Purpose |
|---|---|---|
| `exclude` | the 10 tiles with the most predicted deadwood and forest | where a bad prediction shows first |
| `training` | 1 per 2 ha, 10 to 40, stratified by predicted cover with area weights | an unbiased estimate of the share of bad tiles |

A tile in both sets is rendered and judged once. Per tile the judges see three images:
`raw`, `deadwood_overlay` and `forest_cover_overlay` (blue and gold fill with outline;
outside the AOI is darkened).

## Answers

Prompt `pq-v7` (version v2, render `overlay-v2`): per layer the judge lists the errors it
sees and gives a verdict, a major likelihood, per failure mode a likelihood and the
affected area, and a one-sentence summary for data users. A judge that cannot assess the
tile at all (`assessable: false`) is stored as `not_assessable` on both layers; `ambiguous`
means no one could reliably tell what is right (the shrub to tree transition, an unusual
dieback).

The failure modes: dead trees missed, deadwood on live vegetation, on non-vegetation, on
lying wood, deadwood artifacts; trees missed, forest on non-trees, gaps between crowns not
identified (`m9_fc_gaps_filled`), forest artifacts. Lying wood is never deadwood. Filled
gaps alone make the forest layer minor at most.

Version v2 (DT-1560): in v1 a forest prediction that filled the tile showed only a faint
gold tint with no edge, and the judges claimed most of the tile as trees missed. v2
outlines each layer along the tile border too, draws the forest with a stronger fill and a
3-pixel outline, and states each layer's measured share of the tile in the prompt.

## What a run stores

`handle(ctx)` reads the tiles, the AOI and every polygon of the two predictions (large
predictions hold a few hundred thousand polygons; `shared.pagination.iter_pages_by_creation`
reads them through the label's index), asks each judge per tile with four calls in
parallel, renews the login, uploads the images to the storage server under
`audit/prediction_quality/<dataset>/run-<run>/tile-<x0>-<y0>/`, and returns the run to the
worker, which stores it with one call, `audit.finish_run`: all or nothing, and the run is
done.

- `audit.tiles`: one row per pixel window and dataset, shared by every run and check that
  judged the window, so a person's tile review carries over to a rerun.
- `audit.images`: the run's three images per tile, the overlays with their
  `prediction_label_id`.
- `audit.tile_vlm_judgements`: per judge, tile and layer the verdict, `likelihood` (of a
  major error), `problems` (failure mode to likelihood and area), `summary`, and `raw`
  (the errors it listed and its own verdict).
- The run: `inputs` are the ortho sha256, the AOI key and the two label ids, read at run
  time. `evidence` holds each tile's sets, weight and predicted cover by pixel window,
  coverage (tiles, tiles per set), cost (seconds and calls per model), versions and failed
  calls.

A judge that fails on one tile is counted in `evidence.failed_calls` and the other judge's
answer stands; a judge that answers no tile at all fails the run, which is retried. Login
and usage-limit errors reach the worker, which pauses instead of failing the run.

## Calls and counts

The database works out one call per tile and layer of the run that counts
(`audit.tile_calls`): a person's tile review on the same prediction if there is one,
otherwise the deciding judge's verdict under the version's active rules (rules-v1
`{"decider": "haiku"}`; Luna is stored and shown, not counted). A `not_assessable` answer
gives no call, and an ambiguous tile counts for no side. `audit.dataset_outcomes` counts
the calls per layer (total, major, minor, ok). A layer never needs review on its own
dataset. New rules apply to every dataset at once, without model calls.

## Rerun

The worker queues a run when a dataset finishes processing and the latest run of the
active version judged other inputs (or there is none):

- a new ortho, AOI or prediction reruns the check. Tile reviews of the old prediction stop
  counting for the dataset's counts; benchmark labels keep their picture.
- a new version reruns every dataset once the operator queues the backfill; until a
  dataset's rerun finishes its last result keeps counting, read with its own version's
  rules.

A run is ready once the COG, the CLIP tiles and both predictions exist (`ready`). A
dataset without a prediction of the preferred model is left out of the queue.

## Benchmark runs without the worker

`scripts/qa/prediction-quality/run_check.py` runs the same check read-only (analyst
login, COG over HTTPS, the AOI and the preferred predictions picked as the worker picks
them) and keeps every answer in a local folder. It writes nothing to the database. Its
Haiku runs through the worker's backend; Luna through an API key instead of the Codex
login.
