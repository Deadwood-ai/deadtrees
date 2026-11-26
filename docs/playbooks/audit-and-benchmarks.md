# Audit and benchmarks: how they work and what we plan

Start here if you review datasets in the audit, label a benchmark, or work on an audit
check as an agent. This page explains the loop in plain words and links to the reference
docs for the details. Plan and parent issue: DT-1470. Data model: DT-1606.

## The idea in one paragraph

Every dataset must be checked before its predictions feed the maps and the satellite
products. Automated checks report what they measured (an offset, a date to replace, how
many tiles of a layer are wrong) on the **Audit Review** page, and a person looks only
where a check asks for it. Only the dataset evaluation decides something: keep (shown as
OK) or exclude. Two checks use vision models ("judges") that look at images of the
dataset. A judge is only useful if we know how often it is right, so each judged check has
a **benchmark**: tiles or datasets that people labeled blind.

## How it is stored

Everything lives in the `audit` schema. Only answers are stored; every result is a view,
worked out when it is read, so it is never out of date after a rerun or a new review.

- **Answers.** The models' answers: `dataset_vlm_judgements` (a whole dataset) and
  `tile_vlm_judgements` (one tile and layer). People's answers: `dataset_human_reviews`
  (one row per check answered: dataset evaluation, georeferencing, acquisition date) and
  `tile_human_reviews` (one tile and layer, on the prediction it showed). Answers are
  never changed; a new answer is a new row and the newest counts.
- **What was judged.** `check_versions` (what the models are asked), `check_rules` (how
  their answers become results, e.g. which judge decides), `runs`, `tiles` (squares on the
  embedding grid) and `images` (the pictures a run judged, on the storage server).
- **Results (views).** `current_runs` (the run that counts per dataset and check),
  `tile_calls` (per tile and layer: a person's review, else the deciding judge's answer),
  `evaluation_calls` (the dataset check's keep, exclude or unsure),
  `current_dataset_human_reviews` (the newest review per check, marked stale once the
  ortho or the date advice changed), `evaluation_decisions` (the decision that counts:
  a person's review, the old audit's keep, the check, the old audit's exclude) and
  `dataset_outcomes` (one row per dataset: every output, the counts and what needs a
  person).

A dataset is hidden from the public only when its evaluation decision is exclude.
Predictions are never hidden because of the audit. The dataset page shows what the audit
found to anyone who can see the dataset (`public.get_dataset_audit_summary`, read from
`dataset_outcomes`): the georeferencing offset, the suggested acquisition date (a
reviewer's correction included) and, once no review is required, each prediction's share
of wrong sample tiles with the deciding model's reasoning.

## The checks

They run in this order; the review page shows them as steps.

- **Dataset evaluation.** The only decision, plus COG and thumbnail issues. Judges look at
  an overview, four tiles and the thumbnail. [dataset-evaluation.md](../dataset-evaluation.md)
- **Area of interest.** Whether an AOI exists, when, by whom and with which model.
- **Georeferencing.** Estimated, no reference, needs review, passed or not passed, and the
  offset in metres; passed means within 15 m. [georef-check.md](../georef-check.md)
- **Acquisition date.** AerialStamp: keep the recorded date or replace it with the
  estimate. It never changes the dataset. [doy-estimation.md](../doy-estimation.md)
- **Phenology.** The probability of peak greenness on the recorded date.
- **Prediction quality.** Per layer (deadwood, tree cover): how many judged tiles are OK or
  have minor or major errors. [prediction-quality.md](../prediction-quality.md)

The judged checks run in the audit worker (`processor/src/audit_worker`), one dataset at
a time; its commands and safety rules are in [audit-checks.md](../audit-checks.md).

## The review (for reviewers)

Open the Audit Review. **All audits** lists every dataset, **Pending audit reviews** the
ones a check asks about, **Benchmark** the three benchmarks. A check asks for a person
when the dataset evaluation is unsure, processing finished without an AOI, the
georeferencing needs review, or the date estimate's advice flipped after a reviewer's
answer. The prediction layers never ask; you can still answer their tiles.

Each dataset has 7 steps: dataset evaluation, area of interest, georeferencing,
acquisition date, phenology, tree cover prediction, deadwood prediction. Save stores one
review per step you answered or changed. A tile answer in steps 6 and 7 is stored at once,
on the prediction the tile shows. A review counts while the evidence it was given on is
the same: a new ortho asks again, a new prediction makes the tile answers stop counting.

Keys: Enter next step (in the tile view: save and go on), Shift+Enter back, Ctrl+S save.
In the tile view: ← → tiles, Tab next tile without an answer, ↑ ↓ problem, Y N U yes,
no or unsure, 1 2 3 4 OK, minor, major, ambiguous (and save), T raw or prediction, V side by
side, - + prediction opacity, M map, B benchmark (operators).

## Benchmarks

A benchmark is a tick on a person's review (`in_benchmark`); there are no benchmark tables,
versions or splits. The three benchmarks:

- **Dataset evaluation:** `dataset_human_reviews` ticked, on the dataset evaluation.
- **Deadwood** and **Tree cover:** `tile_human_reviews` ticked, on that layer.

A target's label is its newest review, whoever gave it. Only operators add to a
benchmark:

- **Label new random** on the Benchmark tab draws one target at a time
  (`audit.draw_target`): a dataset with a current dataset evaluation run, or a tile of a
  random kept dataset with a call on the layer, never one that is ticked already. The
  models stay hidden until the target has a label. K or Skip draws another; skipped ones
  do not come back during the visit. The label is saved as a review with the tick, so it
  is also that dataset's or tile's review.
- **B** in the Audit Review stores your answer on the dataset (step 1) or the tile with the
  tick, or takes it out again.
- **Remove (Del)** in Review existing labels clears the tick (`audit.remove_benchmark_target`);
  the review stays. Undo stores the label again with the tick, while the page is open.

Tiles of a dataset whose decision is exclude leave the tile benchmarks while it stands;
their labels stay.

## How a change goes live

1. Spot a pattern in review.
2. Build a new check version (other models or another question) or new rules (another
   deciding judge, other thresholds). The old ones stay.
3. Score old against new on the benchmarks.
4. Ship through a PR, merged on Janusch's "ship".
5. An operator switches it on (`audit.activate_version`, `audit.activate_rules`). New
   rules apply to every dataset at once from the stored answers, with no model calls. A
   new version needs reruns: each dataset keeps its old result until its rerun finishes.
6. Reruns of datasets that already have a result need Janusch's go, with the count and the
   expected model calls.

## For agents

- Production is read-only for you. Read audit tables as `team_analyst`
  ([analyst-database-access.md](analyst-database-access.md)).
- These need Janusch's own words in the thread: starting or stopping the worker,
  activating a version or rules, queueing runs or a backfill, any rerun, changing a
  benchmark outside the page, and every message to a reviewer.
- Never publish non-public dataset ids in the repo (it is public).
- Judges may see private datasets; only auditors see the models' answers.

## Not the same: the disturbance benchmark

The satellite disturbance benchmark (Releases, core team) scores satellite change products
against reference polygons. It has nothing to do with the audit judges; see
`docs/releases/disturbance-benchmark-*.md`.

## Read next

- [audit-checks.md](../audit-checks.md): the tables, views and functions in detail.
- [dataset-evaluation.md](../dataset-evaluation.md) and
  [prediction-quality.md](../prediction-quality.md): what each judged check sees.
- `docs/qa/playbooks/auditor-check-review.md`: local QA of the review page.
