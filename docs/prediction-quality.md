# Prediction quality check

The last step of the automated audit (DT-1484, parent DT-1470). Per dataset it judges the
deadwood and the forest cover prediction on image crops and decides per layer: ok, major
errors or unsure. It plugs into the audit framework like every check
([audit-checks.md](audit-checks.md)): one `audit.runs` row per dataset, model rows per
crop and layer, one dataset-level rule row per layer.

Code: `processor/src/prediction_quality_v1/`; the audit worker runs it through
`handler.py` (`worker.HANDLERS['prediction_quality']`). It needs no migration: it writes
the base tables as the audit worker.

## What it looks at

A crop is one CLIP tile (`v2_tile_embeddings`: 51.2 m on the 10 cm UTM grid, in the UTM
zone of the ortho's centre), rendered at 5 cm (1024 px) from the stored COG, so private
datasets work. Only tiles inside the AOI
are judged; a dataset without an AOI is judged on all its tiles. The predictions are the
dataset's active labels of the preferred model (`v2_model_preferences`), the newest per
layer.

Two crop sets, picked from the predicted cover of every tile:

| Set | Crops | Purpose |
|---|---|---|
| `exclude` | the 10 tiles with the most predicted deadwood and forest | where the audit decides whether a layer is usable |
| `training` | 1 per 2 ha, 10 to 40, stratified by predicted cover with area weights | an unbiased estimate of the share of bad crops; reported only |

A tile in both sets is rendered and judged once. Per crop the judges see three images,
stored under `audit/prediction_quality/<dataset>/<ortho sha256[:16]>/crop-<id>/` and
recorded in `audit.images`: `raw`, `deadwood_overlay` and `forest_cover_overlay` (blue
and gold fill with outline; outside the AOI is darkened). Files are named by their
content, so a later run on the same ortho never replaces a file a row points at. An
image is stored once per crop and prediction: a later run uploads nothing that is
already there. When its image differs from the stored one (the AOI changed, so other
parts are darkened), the stored row stays what the review page shows and the run names
the files it judged in `evidence.images_not_shown`. Crops are `audit.crops` rows keyed
by the tile's pixel window: a tile the dataset evaluation already stored only gains the
new sets.

## Assessments per run

| Assessor | Kind | Target | Verdict |
|---|---|---|---|
| `luna-medium/pq-v5`, `haiku-5.5/pq-v5` | model | crop, layer `image` | `major` when the model cannot assess the crop (mode `m0_not_assessable`) |
| same | model | crop, layers `deadwood` and `forest_cover` | the model's `ok`, `minor` or `major`, its `major_likelihood`, and per failure mode a likelihood and the affected area |
| `pq-rule/pq-rule-v1` | rule | dataset, one row per layer | `major` when 2 or more exclude-set crops are major, else `ok`; `unsure` when no crop could be judged |

A crop counts as major when the judges' mean `major_likelihood` reaches the layer's cut
(deadwood 52, forest 69). The cuts and the crop count are read from the version's
`config` (`rule_config`), so a registered version runs with the numbers it was
registered with. The rule row's `details` hold the counts
(`major_crops`, `judged_crops`) and the weighted major share of the training set, which
the review page shows. `audit.review_queue` reads the rule rows. The version starts in
`review_all`. Nothing is written to `dataset_audit` yet.

The failure modes (prompt `pq-v5`): dead trees missed, deadwood on live vegetation, on
non-vegetation, on lying wood, deadwood artifacts; trees missed, forest on non-trees,
forest artifacts. Lying wood is never deadwood.

## Run

`handle(ctx)` reads the tiles, the AOI and every polygon of the two predictions (large
predictions hold a few hundred thousand polygons; `shared.pagination.iter_pages_by_creation`
reads them through the label's index), asks each judge per crop
with four calls in parallel, then stores the run (`store.write`): crops, then the image
files and their rows, then all assessments in one insert, so an attempt that fails
before that insert leaves nothing a retry would double. The worker finishes the run with the returned evidence
(the layer verdicts, versions, failed calls), coverage (tiles, crops per set) and cost
(seconds and calls per model), and records the run's `inputs`: the ortho sha256, the AOI
key and the two label ids. A new ortho, AOI or prediction therefore gets a new run.

A run is ready once the COG, the CLIP tiles and both predictions exist (`ready`). A
dataset without a prediction of the preferred model is left out of the queue. A judge
that fails on one crop is recorded in `evidence.failed_calls` and the other judge's
answer stands; a judge that answers no crop at all fails the run, which is retried,
because the cuts are calibrated on the judges' mean. Login and
usage-limit errors reach the worker, which pauses instead of failing the run.

## Benchmark runs without the worker

`scripts/qa/prediction-quality/run_check.py` runs the same check read-only (analyst
login, COG over HTTPS) and keeps the result in a local folder. It writes nothing to the
database.
