# Dataset evaluation check

The first step of the automated audit (DT-1483, parent DT-1470). Per dataset it decides
keep, keep but fix, exclude or unsure, and records the image facts the audit needs. It
plugs into the audit framework like every check ([audit-checks.md](audit-checks.md)):
one `audit.runs` row per dataset, one dataset-level `audit.assessments` row per model and
rule, layer `image`.

Code: `processor/src/dataset_evaluation_v1/`, entry point
`processor/src/process_dataset_evaluation.py` (`run_dataset_evaluation`), migration
`supabase/migrations/20261102100000_dataset_evaluation_check.sql`.

## What it looks at

Read from the stored COG at run time (`utils/stored_inputs.local_cog`, so private
datasets work):

| Image | Size | Purpose |
|---|---|---|
| Overview | at most 2048 px, about 30 cm/px | the whole flight; no-data black, the AOI edge in magenta |
| 4 crops | 1024 px at native resolution | sharpness and artifacts; inside the data, centred by a seeded k-means split of the AOI (else the data), so a rerun judges the same crops |
| Thumbnail | the stored 256 px website thumbnail | thumbnail issues |

Footprint padding without a mask (solid white or black connected to the image edge) is
no-data, as in `utils/nodata.py`. The images the models judged are stored on the storage
server under `audit/dataset_evaluation/<dataset>/<ortho sha256[:16]>/` and recorded in
`audit.images` (kinds `overview`, `raw` for crops, `thumbnail`); crops are `audit.crops`
rows in the `evaluation` set, off the CLIP grid.

## Assessments per run

| Assessor | Kind | Verdict |
|---|---|---|
| `luna-medium/v1`, `haiku-5.5/v1` | model | the model's call: keep `ok`, fix `minor`, exclude `major`, unsure `unsure`; `major_likelihood` = its exclude likelihood |
| `band_check/v1` | rule | wrong bands from the upload's raster profile (`v2_orthos.ortho_info`) and the COG band statistics: one or two colour bands or identical bands `major`; red or purple dominance (near-infrared or mis-decoded multispectral) `unsure` |
| `duplicates/v1` | rule | `unsure` when another dataset has the same file, a near-identical overview (64-bit DCT hash within 10 bits) or the same uploader and day, each with 50%+ footprint overlap; never excludes |
| `dataset-evaluation-rule/v1` | rule | the dataset verdict (below) |

Model `modes` carry a 0-100 likelihood for `blurry`, `not_rgb`, `no_trees`,
`broken_ortho`, `too_dark`, `artifacts` (exclude reasons) and `cog_issue`,
`thumbnail_issue`, `reprocess` (fix flags). `details` hold the reason, sharpness,
lighting, leaf state (a hint only), image type, scene, land cover and a one-sentence
summary, from the fixed lists in `vocabulary.py`; `raw` holds the reply, token usage and
seconds. The run's `evidence` holds the resolution, valid share, footprint and the
overview hash; `inputs` the ortho sha256, AOI key and crop settings.

The dataset rule averages the two models' exclude likelihoods:

1. a `major` band check excludes;
2. a model `unsure`, or models 50+ points apart, goes to a person (`unsure`);
3. a mean of 60+ excludes, with the reason of the surer model;
4. a band or duplicate flag goes to a person;
5. any model `fix`, or a fix flag averaging 50+, keeps the dataset but marks it `minor`;
6. otherwise `ok`.

`audit.review_queue` reads the rule rows. The version starts in `review_all`. Nothing
is written to `dataset_audit` or `dataset_audit_suggestions` yet.

## Store and duplicates

`audit.store_dataset_evaluation(run_id, result)` stores a queued or running run in one
transaction: crops, images, assessments, the overview hash (`audit.image_hashes`), the
run's evidence and cost, status `done`, and the current-run pointer (not for benchmark
runs). A bad row rolls everything back. `audit.duplicate_candidates(dataset_id, hash)`
lists possible duplicates for the duplicate rule. Both run with the caller's rights, so
only the audit worker writes.

## Models

`models.py` puts every model behind one call: prompt plus named JPEGs in, reply text and
usage out. `HaikuCLI` runs `claude -p --model claude-haiku-5-5` with only the Read tool;
`LunaResponses` uses the OpenAI Responses API with `~/.config/deadtrees/openai.env`
(`DATASET_EVALUATION_OPENAI_KEY_FILE` overrides it). An expired login or missing key raises
`ModelUnavailable` (the worker keeps the run queued); capacity errors wait and retry; a
malformed reply is asked once more. One run is two parallel calls, about 11 s, about
10k input tokens for Luna and 16k for Haiku (7 turns).

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

The labels become person rows on the benchmark (`dataset-evaluation-gold` v1) once the
review page exists; until then the SQLite file is the record.
