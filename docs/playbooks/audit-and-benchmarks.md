# Audit and benchmarks: how they work and what we plan

Start here if you review datasets in the audit, label a benchmark, or work on an audit
check as an agent. This page explains the whole loop in plain words and links to the
reference docs for the details. Plan and parent issue: DT-1470. Benchmark loop: DT-1488.

## The idea in one paragraph

Every dataset must be checked before its predictions feed the maps and the satellite
products. People used to fill in an audit form for each dataset by hand. Now automated
checks report what they measured (an offset, a date to replace, how many crops of a
layer are wrong) on the **Audit Review** page, and a person looks only where a check
asks for it. Only the dataset evaluation decides something: OK or exclude. Two of the
checks use vision models ("judges") that look at images of the dataset. A judge is only
useful if we know how often it is right, so each judged check has a **benchmark**: a fixed
set of crops or datasets with answers people gave blind. A change to a check is scored on
its benchmark before it goes live. Trust is earned per check: everything starts as a
suggestion that a person reviews, and a check may later decide on its own once its
benchmark scores and the review results show it is reliable.

```text
new upload or batch ──> checks run ──> pending reviews ──> a person answers
                                                         │
                                 B copies a good case ───┴──> benchmark (gold answers)
                                                                     │
          new check version <── scored on the benchmark first <─────┘
```

## Words we use

| Word | Meaning |
|---|---|
| Check | One automated question about a dataset, e.g. georeferencing or prediction quality |
| Check version | A fixed prompt, drawing, rule and settings. Any change makes a new version |
| Run | One version applied to one dataset. Every run is kept; one per dataset and check is "current" |
| Judge | A vision model that answers a check: Luna (`gpt-6-luna`, medium effort) and Claude Haiku 5.5. For now Haiku's answer decides and Luna's is shown next to it; the benchmarks will show which model to use |
| Rule | Code that turns the judges' answers into a result, e.g. the dataset evaluation's decision or a crop's call |
| Output | What a check reports per dataset, e.g. georeferencing `needs_review` at 1.5 m, or deadwood 3 of 18 crops major |
| Verdict | Only on the dataset evaluation and on crops: `ok`, `minor` (on a crop: small errors; on the evaluation only in old rows, read as OK), `major` (exclude, or the layer is wrong), `unsure` (a person decides), `ambiguous` (a person's crop answer: no one can reliably tell) |
| Crop | A 51.2 m square on the CLIP tile grid, shown at 5 cm per pixel (1024 px) |
| Pending audit reviews | The datasets a check asks a person about: the Audit Review's second tab |
| Benchmark | A fixed set of crops or datasets with blind human answers ("gold") that judges are scored against |
| Dev and holdout | The two parts of a benchmark. Tune on dev; decide on holdout only. A dataset's side is fixed by a hash of its id |
| Operator | An auditor who may change check settings and add to benchmarks |

## The checks

They run in this order. The review page shows them as steps.

| Check | What it reports | Runs where | Reference |
|---|---|---|---|
| Dataset evaluation | The only decision: OK or exclude, plus COG and thumbnail issues. Judges look at a 2048 px overview, four crops and the thumbnail; a band check runs as a rule | Audit worker | [dataset-evaluation.md](../dataset-evaluation.md) |
| Area of interest | Whether an AOI exists, when it was made, by whom (prediction, manual, correction) and with which model | GPU processors (`aoi_v1`) | |
| Georeferencing | The status (estimated, no reference, needs review, passed, not passed) and the offset in metres; passed means within 15 m | GPU processors (`georef_check_v1`) | [georef-check.md](../georef-check.md) |
| Acquisition date | AerialStamp: replace the recorded date or not, and the new date; it never changes the dataset | GPU processors (`doy_estimation_v1`) | [doy-estimation.md](../doy-estimation.md) |
| Phenology | The probability of peak greenness on the recorded date | metadata stage | |
| Prediction quality | Per layer (deadwood, tree cover): how many judged crops are ok, have minor or major errors. Judges see each crop raw and with the prediction drawn on it, and name failure modes such as "dead trees missed" or "trees missed" | Audit worker | [prediction-quality.md](../prediction-quality.md) |

A dataset is hidden from the public only when its evaluation decision is exclude.
Predictions are never hidden because of the audit; on the dataset page the deadwood layer
starts switched off when the phenology probability is below 0.5, with a red mark on the layer
that says why. The dataset page shows what the audit found to anyone who can see the dataset,
once no review is required (`public.get_dataset_audit_summary`): the georeferencing offset
below the phenology, and in a panel marked experimental each prediction's quality (the share
of sample crops it gets wrong) with the deciding model's reasoning. The audit
map opens with both predictions off, so the image itself is judged first.

Conventions for prediction quality that every reviewer and prompt follows: lying wood is
never deadwood; season and phenology are not prediction errors; partly dead crowns count
under "dead trees missed"; an error is substantial at about 20% of the layer in the crop.

### The audit worker

The two judged checks run in one process on the processing server, the audit worker
(`processor/src/audit_worker`, service `deadtrees-audit-worker`). It uses subscription
logins rather than API keys, so it lives where those logins are. It runs one dataset at a
time: new uploads first, then manual batches, then the backfill. A dataset evaluation run
asks each judge once; a prediction quality run asks both judges about each of 14 to 46
crops, about 45 calls per dataset in all.
Measured in the pilot: the evaluation takes about 1 to 2 minutes per dataset, the
prediction check about 6 minutes (slowest tenth over 15). When a login expires or a usage
limit is hit, the worker pauses and the platform monitor reports it; no run is lost. Its
commands and safety rules are in [audit-checks.md](../audit-checks.md#audit-worker).

## The review (for reviewers)

Open the Audit Review. **All audits** lists every dataset, **Pending audit reviews** the
ones a check asks about, **Benchmark** the open benchmark's datasets. A check asks for a
person when:

- the dataset evaluation's rule is unsure;
- processing finished and there is no AOI;
- georeferencing needs review (references qualified but none decides, or they conflict).

The prediction layers never ask: their quality will be reviewed on a stratified random
sample of crops, which is not built yet. You can still answer their crops.

A review on the current evidence settles it; a new ortho or prediction asks again. The
acquisition date never asks, but you may override its replacement with a note.

Each dataset has 7 steps:

1. Dataset evaluation (COG and thumbnail, then the decision: OK or Exclude)
2. Area of interest
3. Georeferencing (Passed within 15 m, or Not passed)
4. Acquisition date (AerialStamp)
5. Phenology (the probability and the phenology indicator bar)
6. Tree cover prediction
7. Deadwood prediction

Your answer is stored as your own row next to the models' rows; nothing overwrites
anything, and the latest reviewer answer counts. A reviewer's evaluation decision
replaces the check's and an imported legacy one. A legacy exclusion only holds until the
evaluation decides, because many old exclusions were for reasons the evaluation does not
count. Blind answers, where the models stay hidden until you answer, are only given
in the Benchmark tab.

| Key | Where | Does |
|---|---|---|
| Enter | any step | take the suggestion as your answer and go on |
| Shift+Enter | any step | go back one step |
| Ctrl+S | anywhere | save the audit |
| ← → | crop view (steps 6, 7) | previous or next crop; flagged crops come first |
| Tab | crop view | next crop you have not answered |
| Y / N / U | crop view | yes, no or unsure for the highlighted problem (↑ ↓ move between problems) |
| 1 / 2 / 3 / 4 | crop view | the layer is OK, has minor errors, has major errors, is ambiguous (no one can reliably tell: shrub or tree, an unusual dieback) |
| Space | crop view | the layer is OK, and save |
| C | crop view | can't tell from this crop |
| T, V | crop view | switch raw and prediction; side by side |
| - and + | crop view | weaker or stronger prediction overlay |
| A | crop view | all crops instead of only the flagged ones |
| M | crop view | show the crop on the map |
| B | step 1 and crop view, operators | add this dataset to the dataset evaluation benchmark, or this crop to its layer's benchmark (deadwood or tree cover), with your answer as its label |

Add a clear, instructive case to its benchmark: the dataset evaluation's from step 1 (the
toggle under the decision, or **B**), a crop to its layer's benchmark from that layer's crop
view (**B**). It joins with your answer as its first label: the decision on the page, or your
answer on the crop, saved first if you had not saved it. Pick one the models got wrong, or
a typical example of a reason. It does not change the review.

**Known issue (16 Nov 2026):** on crops that are fully forest, the judges often claim
"trees missed" although the tree cover is fine, because the old drawing shows no edge
there. Trust your eyes over the models on those crops until the fix (below) is live.

## Pending audit reviews

The pending list is a stream, not a fixed set. Datasets join it when their checks have
run:

- **Batches.** The pilot ran 100 datasets on 11 and 12 Nov 2026. The next 100 (the newest
  fully processed datasets without an audit) were queued on 16 Nov 2026. Each batch first
  gets the georeferencing and date checks on the processors at low priority, then the
  dataset evaluation and the prediction check in the audit worker.
- **New uploads.** Once a version of a judged check is active, the audit worker gives
  every newly processed dataset a run of it. The date estimate runs as an upload stage.
  The georeferencing check does not run on uploads yet and is queued explicitly.
- **The backfill.** Later, every historical dataset is run through the checks. The old
  audits' decisions (exclude, or no issues) are imported as history and count until a
  reviewer answers; everything else in them stays in the read-only legacy list.

Check versions still carry a mode (`review_all`, `review_uncertain`, `auto_apply`), but it
no longer decides what needs a person; the rules above do.

## Benchmarks (the gold answer keys)

A benchmark answers one question: how good is a check version, measured against people?
It is a list of targets (crops or whole datasets), each with the label people gave it. On
the **Benchmark** tab of the audit an operator labels new random tiles (drawn by dataset
first, so every dataset is equally likely) or datasets one at a time, blind: the models show once the target has a label, and the target joins
the benchmark with it. A target is never in a benchmark without a label. Each target has one
label, the latest answer whoever gave it: a new answer replaces it, and the tab's table says
who labeled it and when. Answers are stored per target,
so they survive new benchmark versions.

Rules:

- One benchmark holds crops or datasets, never both. Prediction quality has one benchmark
  per layer (deadwood, tree cover): a crop is labeled and scored for each layer apart. Each
  benchmark has at most one open version, where new targets go; a frozen version never
  changes, and a bigger set is a new version.
- About 1 in 5 datasets is held out by a fixed hash, and all crops of a dataset share its
  side. Tuning looks at dev only; the go or no-go for a change uses holdout only.
- Benchmark runs use their own queue. They never become a dataset's current result and
  never touch the review list.
- The old audits are not gold: auditors disagreed a lot (some excluded under 1% of their
  datasets, others over 40%). Their decisions are imported only so exclusions hold.

### The benchmarks we have

| Benchmark | Targets | Built from | State on 16 Nov 2026 |
|---|---|---|---|
| Prediction quality, `pq-deadwood-gold` and `pq-forest-cover-gold` | Crops, one benchmark per layer | Crops Janusch graded during the first prediction study (DT-1272), `pq-gold-dt1272` | `pq-gold-dt1272` v1 frozen with 197 crops; v2 open with 172 (86 dev, 86 holdout), after 25 early test crops at the wrong scale were removed. With the Audit Review, v2 is frozen and its crops open both layer benchmarks as v1 |
| Dataset evaluation, `dataset-evaluation-gold` | Whole datasets: OK or exclude (old labels may say keep, fix) | 125 past exclusions spread by reason (blurry 35, no trees 25, artifacts 18, not RGB 15, broken ortho 12, too dark 8, other 12) and 125 kept (85 without issues, 40 fixable, the hard cases) | v1 open with 250 (207 dev, 43 holdout); not labeled yet |

The past audit decisions only make sure every reason is represented; the labels people give
in the Benchmark tab are the truth. The tab shows stored images: the gold crops carry their
own, and a dataset target shows the overview and crops a dataset evaluation run stored, so
it needs one such run before it can be labeled.

Targets for prediction quality (DT-1272): at the dataset level, catch at least 90% of bad
layers and wrongly exclude at most 20% of good ones. The judges reach a crop-level AUC of
about 0.93 averaged; at the last measurement the dataset rule for deadwood was still below
target.

### How a change goes live

Every change to a judged check follows the same loop. Fix A is the current example.

1. **Spot a pattern in review.** In the pilot, the judges called "trees missed" on many
   fully forested crops. The cause was the drawing: forest that fills the crop showed only
   a faint tint with no edge.
2. **Build a new version.** A changed prompt, drawing, rule or setting is a new check
   version (here prediction quality v2: forest outlined along the crop border, a stronger
   fill, and each layer's share of the crop in the prompt; branch
   `fix/forest-overlay-dt-1560`). The old version stays.
3. **Score old against new on the benchmark.** Run both on the gold targets and compare.
   Tune on dev; decide on holdout.
4. **Ship.** A PR with tests and the scores, merged on Janusch's "ship".
5. **Activate.** An operator makes the new version active. New uploads then get it.
6. **Rerun, with his go.** Rerunning datasets that already have a result is a production
   rerun and needs Janusch's go, with the count and the expected model calls. Runs queued
   for the old version should fail with a clear "wrong version" error instead of being
   judged with the new code. The dataset evaluation already does this; fix A adds the same
   guard to prediction quality.

A new rule alone (new thresholds, a new way to combine judges) needs no model calls: it is
recomputed from the stored answers.

## Not the same: the disturbance benchmark

The **satellite disturbance benchmark** (Releases, core team; v8 prepared in DT-1556) is a
separate thing. It scores satellite products of tree cover and deadwood change against
reference polygons over time, shown in its own viewer. It has nothing to do with the audit
judges. Its docs are in `docs/releases/disturbance-benchmark-*.md`.

## State on 17 Nov 2026 and what comes next

- The Audit Review (one PR): checks report outputs, the dataset evaluation is the only
  decision and the only reason to hide a dataset, the legacy audits are read-only
  history, and the duplicate check is gone.
- The review page with all 7 steps, the crop view with the prediction slider and the
  Benchmark tab are live.
- The audit worker is paused until fix A is live, so the new 100 are not judged with the
  old drawing. Georeferencing and date checks for them run on the processors.
- Fix A is being scored old against new on the 172 gold crops; its PR follows.
- COG streaming (DT-1561): both judged checks read the image straight from the stored COG
  instead of copying the whole file, and store a run's images over one connection. This
  saves about a minute per prediction run.
- Next, in this order:
  1. Make the review workflow and page practical. Reviewers' feedback on what is slow or
     confusing comes first; everything on the page can change.
  2. Audit 100 to 200 datasets, and add the hard cases to the benchmarks with B.
  3. Improve the prompts of prediction quality and dataset evaluation, scored on the
     benchmarks.
- Also open: a rerun of tree cover on the pilot datasets after fix A (needs Janusch's go),
  labeling the 250 evaluation datasets, and reviewer-placed extra crops.

Update this section when one of these changes.

## For agents

- Production is read-only for you. Read audit tables as `team_analyst`
  ([analyst-database-access.md](analyst-database-access.md)).
- These need Janusch's own words in the thread: starting or stopping the worker,
  activating a version, queueing runs or a backfill, any rerun, adding to or removing from
  a benchmark outside the page, and every message to a reviewer. He usually runs the
  command himself; give it to him in one code block.
- Read-only status: `systemctl --user is-active deadtrees-audit-worker`,
  `~/.local/state/deadtrees-audit-worker/status.json`, `python -m
  processor.src.audit_worker status`.
- Never publish non-public dataset ids in the repo (it is public). A benchmark seeded from
  a list therefore goes in through the page or a reviewed SQL script Janusch runs, not
  through a migration.
- Every job on the processing server runs under a memory cap of at most 10 GB, because
  production ODM runs there too.
- Judges may see private datasets; only auditors see the models' answers.

## Read next

- [audit-checks.md](../audit-checks.md): tables, verdicts and outputs, `audit.dataset_results`,
  the exclusion, the worker, the review page and the benchmark mechanics.
- [dataset-evaluation.md](../dataset-evaluation.md) and
  [prediction-quality.md](../prediction-quality.md): what each judged check sees and its
  rule.
- `docs/qa/playbooks/auditor-check-review.md`: local QA of the review page.
