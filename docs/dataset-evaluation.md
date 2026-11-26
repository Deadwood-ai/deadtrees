# Dataset evaluation check

The first step of the automated audit (DT-1483, parent DT-1470) and the only check with
a decision: per dataset ok (`ok`), exclude (`major`) or unsure (a person decides). There
is no "keep, fix" any more. It also reports COG and
thumbnail issues and records the image facts the audit needs. It
plugs into the audit framework like every check ([audit-checks.md](audit-checks.md)):
one `audit.runs` row per dataset, one dataset-level `audit.assessments` row per model and
rule, layer `image`.

Code: `processor/src/dataset_evaluation_v1/`; the audit worker runs it through
`handler.py` (`worker.HANDLERS['dataset_evaluation']`, see the audit worker section of
[audit-checks.md](audit-checks.md)). Migration:
`supabase/migrations/20261110160000_dataset_evaluation_check.sql`.

## What it looks at

The orthophoto alone. The area of interest is a check of its own and the predictions
are judged by the prediction quality check, so neither plays a part here (version 2,
DT-1538; version 1 judged inside the AOI and drew its edge on the overview).

The code is the version (now v3, the Audit Review rule): the handler refuses a run that
was queued for an earlier version (the run fails with that reason), so an old version's
results never hold the new version's answers. An operator activates a version before
the worker judges with it.

Read from the stored COG at run time (`utils/stored_inputs.local_cog`, so private
datasets work):

| Image | Size | Purpose |
|---|---|---|
| Overview | at most 2048 px, about 30 cm/px | the whole flight; no-data black |
| 4 crops | CLIP tiles (51.2 m windows on the 10 cm UTM grid of `v2_tile_embeddings`) at 5 cm, 1024 px, or native when coarser | sharpness and artifacts; picked by a seeded k-means spread of the tiles over the data, so a rerun judges the same crops and prediction quality can reuse them. A dataset without tiles gets 1024 px native windows inside the data instead |
| Thumbnail | the stored 256 px website thumbnail | thumbnail issues |

Footprint padding without a mask (solid white or black connected to the image edge) is
no-data, as in `utils/nodata.py`. The images the models judged are stored on the storage
server under `audit/dataset_evaluation/<dataset>/<ortho sha256[:16]>/` and recorded in
`audit.images` (kinds `overview`, `raw` for crops, `thumbnail`); crops are `audit.crops`
rows in the `evaluation` set, keyed by their grid window, so a tile another check
already stored only joins the set (native fallback crops are off the grid). The worker
reads the tile windows as the processor account, which already sees the tiles of every
dataset whose embeddings are done; a run is ready only then.

Crops and images are stored per ortho. An ortho a version 1 run judged inside its AOI
holds that run's crops and overview too, so the run records what it judged:
`evidence.judged` holds its crop ids and image files.

## Assessments per run

| Assessor | Kind | Verdict |
|---|---|---|
| `luna-medium/v1`, `haiku-5.5/v1` | model | the model's call: keep `ok`, fix `minor`, exclude `major`, unsure `unsure`; `major_likelihood` = its exclude likelihood |
| `dataset-evaluation-rule/v3` | rule | the dataset verdict (below) and the output `{"cog_issue": bool, "thumbnail_issue": bool}`: the one rule row of a run |
| `empty_cog/v1` | rule | instead of all rows above when under 0.5% of the overview is valid data: `major`, flag `broken_ortho`, no issues in the output; no model is asked |

The dataset rule folds in the band check, which is not an assessment row: its result is
in the run's `evidence.rules` and in the verdict's `why`. `band_check/v1` reads wrong
bands from the upload's raster profile (`v2_orthos.ortho_info`) and the COG band
statistics: one or two colour bands or identical bands `major`; red or purple dominance
(near-infrared or mis-decoded multispectral) is a guess capped below `major`, so it is
`unsure`. The duplicate rule of versions 1 and 2 is gone (duplicates cannot be
uploaded); old rows keep it as history.

Model `modes` carry a 0-100 likelihood for `blurry`, `not_rgb`, `no_trees`,
`broken_ortho`, `too_dark`, `artifacts` (exclude reasons) and `cog_issue`,
`thumbnail_issue`, `reprocess` (issues of a kept dataset). `details` hold the reason, sharpness,
lighting, leaf state (a hint only), image type, scene, land cover and a one-sentence
summary, from the fixed lists in `vocabulary.py`; `raw` holds the reply, token usage and
seconds. The run's `evidence` holds the resolution, valid share, footprint, crop
settings, the two folded-in rules and the overview hash; `inputs` the ortho sha256 the
run judged, read again at run time. A new or changed AOI or prediction does not make a
new run.

The dataset rule (v3) follows one model, the deciding model of the version's
`rule_config.decider` (Haiku); Luna's answer is stored and shown next to it, not counted.
Which model decides will follow from the benchmarks.

1. a `major` band check (not an RGB photo) excludes;
2. otherwise Haiku's verdict: `ok`, `major` (with its reason) or `unsure` (a person
   looks); its "fix" counts as keep, and a `reprocess` flag never changes the verdict;
3. without a Haiku answer the dataset goes to a person (`unsure`).

The COG and thumbnail issues are the rule row's `output`, each set when Haiku puts it at
50+, whatever the verdict (rule v2 named its flags in `details.fix_flags`, only for
`minor`, which now reads as ok). A new rule version is recomputed from the stored model answers without
model calls (`recompute`, a rule-only run).

The evaluation decision (`audit.evaluation_decisions`, `docs/audit-checks.md`) is the
latest native reviewer answer, else a legacy ok, else the current rule row when it
decides, else a legacy exclusion; `unsure` is no decision and asks a person (`review_required` contains
`evaluation`) until a reviewer answers on the current evidence. Exclude is the only
reason a dataset leaves the public surface.

## Store

`handle(ctx)` uploads the judged images with the worker's `put_image`, named by their
content inside the ortho's folder (a later run on the same ortho never overwrites a
file an earlier run's rows point at), then calls
`audit.store_dataset_evaluation(run_id, result)`, which writes the crops, images and
assessments (with their `output`) in one transaction; a bad row rolls everything back. The worker then finishes the run with the returned evidence, coverage
and cost and points the dataset at it when the version is active. A run is ready once
the COG, thumbnail and CLIP tiles exist (`ready`); its `inputs` are the ortho sha256.
The function runs with the caller's rights, so only the audit worker writes. The rule
thresholds are read from the version's `config` (`rule_config`), so a registered version
runs with the numbers it was registered with.

## Models

The judges are the audit worker's subscription backends (`audit_worker.models`), named
in the version's `CONFIG['models']`: `luna-medium` through the Codex login (gpt-6-luna,
medium effort) and `haiku-5.5` through `claude -p`. Each call runs without tools and
gets the six images inline. A malformed reply is asked once more; login and usage-limit
errors reach the worker, which pauses instead of failing the run. Cost records seconds
and calls per model; subscription calls report no tokens or dollars.

## Gold set and labeling

`scripts/dataset_evaluation/` builds the benchmark:

1. `gold_set.py` selects about 250 audited datasets read-only (analyst login): 125
   exclusions with a visual reason, stratified by the reason in their notes (blurry 35,
   no trees 25, artifacts 18, not RGB 15, broken ortho 12, too dark 8, other 12), and 125
   kept ones (85 `no_issues` by platform and year, 40 `fixable_issues` as hard
   negatives). At most 3 per uploader per stratum first. The split is
   `audit.benchmark_split`.
2. `render_gold.py` renders the model images with the check's own code, under a memory
   cap. Public and view-only COGs come from data2 over HTTPS, private ones from local
   copies only.
3. `label_server.py` serves the labeling page on 127.0.0.1 (SSH tunnel): overview, four
   crops and the thumbnail; keys `1`-`4` for keep, keep but fix, exclude, unsure; `q`-`p`
   for exclude reasons, `a s d` for fix flags; `Enter` saves. Labels are kept in
   SQLite with every revision. The old audit and model answers stay hidden until
   switched on.

```bash
set -a; . ~/.config/deadtrees/monitor.env; set +a
venv/bin/python scripts/dataset_evaluation/gold_set.py --out .local/dataset-evaluation/gold-set.json
systemd-run --user --scope -p MemoryMax=6G venv/bin/python scripts/dataset_evaluation/render_gold.py --root .local/dataset-evaluation
venv/bin/python scripts/dataset_evaluation/label_server.py --root .local/dataset-evaluation
```

The picked datasets are the open `dataset-evaluation-gold` benchmark; labels are person
rows given on its Benchmark tab. `gold_set.py` read the legacy audits (now read-only
history) once, for the reasons in their notes.
