# Dataset-level exclusion benchmark

Small, hand-labeled benchmark for the per-dataset exclusion decision: exclude a
prediction layer when roughly more than 20% of the dataset area has unacceptable
predictions, keep it otherwise. Exclusion recall matters most. Offline and
read-only: no production writes, no inference in these scripts.

## Why hand labels

Historical audit grades are candidate labels, not truth. Auditors differ widely
(one rated about 20% of datasets bad for deadwood, others about 3%). The blind
hand labels are the benchmark truth; their agreement with the old grade measures
how far the remaining audits can be trusted.

## Steps

```sh
# Analyst credential only in the consuming process (docs/playbooks/analyst-database-access.md)
PY=<venv with psycopg, numpy, rasterio, shapely, pyproj, Pillow>
$PY scripts/qa/exclusion-benchmark/select_benchmark.py \
  --exposed .local/exclusion-benchmark/exposed-dataset-ids.txt \
  --output .local/exclusion-benchmark/selection.json
$PY scripts/qa/exclusion-benchmark/render_benchmark.py \
  --selection .local/exclusion-benchmark/selection.json --output .local/exclusion-benchmark --workers 6
python3 scripts/qa/exclusion-benchmark/label_server.py --root .local/exclusion-benchmark --port 8771
```

Open through an SSH tunnel: `ssh -N -L 8771:127.0.0.1:8771 processing-server`,
then `http://127.0.0.1:8771/`.

**Selection.** Public, unarchived datasets audited by a person, whose preferred
deadwood and forest predictions both predate the audit, excluding every dataset
used in earlier experiments, at least 10 km apart. Audited-bad datasets are
chosen greedily for failure modes not yet covered (tagged from auditor notes)
plus distance in the mean tile-embedding space; half of the keep set are the
nearest-looking good datasets (hard negatives), half are diverse. Auditor IDs
are pseudonymised.

**Evidence.** Per dataset: an overview (up to 2048 px), a 3×3 grid over the AOI
cut from one 3072 px read, and four native-resolution 1024 px crops spread over
the AOI. Pixels outside the AOI are darkened. The same evidence is used for the
model run, so human and model see the same views.

**Labeling page.** Blind: it receives no audit grade, auditor or selection
role, and datasets appear in a hashed order. Per layer: keep, exclude or unsure,
the affected area band and failure modes; plus imagery issues and a note. Saves
go to `labels.sqlite3` with revision checks and an append-only history. Keys:
1/2/3 deadwood, 4/5/6 forest, d/f layers, o outline, arrows views, n/p datasets.

Browser write tests must use a copy of the root with its own `labels.sqlite3`.
Run `python -m unittest test_benchmark` from this folder.
