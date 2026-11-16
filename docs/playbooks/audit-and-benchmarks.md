# Audit and benchmarks: how they work and what we plan

Start here if you review datasets in the audit, label a benchmark, or work on an audit
check as an agent. This page explains the whole loop in plain words and links to the
reference docs for the details. Plan and parent issue: DT-1470. Benchmark loop: DT-1488.

## The idea in one paragraph

Every dataset must be checked before its predictions feed the maps and the satellite
products. People used to fill in an audit form for each dataset by hand. Now automated
checks fill in every answer first, and a person confirms or corrects them. Two of the
checks use vision models ("judges") that look at images of the dataset. A judge is only
useful if we know how often it is right, so each judged check has a **benchmark**: a fixed
set of crops or datasets with answers people gave blind. A change to a check is scored on
its benchmark before it goes live. Trust is earned per check: everything starts as a
suggestion that a person reviews, and a check may later decide on its own once its
benchmark scores and the review results show it is reliable.

```text
new upload or batch ──> checks run ──> review list ──> a person confirms or corrects
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
| Judge | A vision model that answers a check: Luna (`gpt-6-luna`, medium effort) and Claude Haiku 5.5. Their answers are averaged |
| Rule | Code that turns the judges' crop answers into one dataset verdict, e.g. "2 or more of 10 crops major" |
| Verdict | `ok`, `minor` (keep, but fix), `major` (exclude, or the layer is wrong), `unsure` (a person decides) |
| Crop | A 51.2 m square on the CLIP tile grid, shown at 5 cm per pixel (1024 px) |
| Review list | The datasets waiting for a person: the audit's **To review** tab |
| Benchmark | A fixed set of crops or datasets with blind human answers ("gold") that judges are scored against |
| Dev and holdout | The two parts of a benchmark. Tune on dev; decide on holdout only. A dataset's side is fixed by a hash of its id |
| Operator | An auditor who may change check settings and add to benchmarks |

## The checks

They run in this order. The review page shows them as steps.

| Check | What it decides | Runs where | Reference |
|---|---|---|---|
| Dataset evaluation | Keep, keep but fix, or exclude the whole image, with a reason (blurry, no trees, artifacts, not RGB, broken ortho, too dark, other), plus COG, thumbnail and reprocess flags. Judges look at a 2048 px overview, four crops and the thumbnail. A band check and a duplicate check run as rules | Audit worker | [dataset-evaluation.md](../dataset-evaluation.md) |
| Georeferencing | How far the image is shifted against satellite and official imagery; Good means under 15 m | GPU processors (`georef_check_v1`) | [georef-check.md](../georef-check.md) |
| Acquisition date | A probability curve for the flight day; the date shows as "Uncertain" when the reported date is outside the 80% range | GPU processors (`doy_estimation_v1`) | [doy-estimation.md](../doy-estimation.md) |
| Prediction quality | Per layer (deadwood, tree cover): ok, or major errors. Judges see each crop raw and with the prediction drawn on it, and name failure modes such as "dead trees missed" or "trees missed" | Audit worker | [prediction-quality.md](../prediction-quality.md) |

Area of interest and phenology have no automated check yet; the reviewer answers them by
hand. Phenology is being built separately.

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

Open the audit, tab **To review**. It lists the datasets where checks are waiting for you,
complete ones first. Each dataset has 7 steps:

1. Dataset evaluation
2. Area of interest
3. Georeferencing
4. Acquisition date
5. Phenology
6. Deadwood prediction
7. Tree cover prediction

Every step is prefilled with what the checks suggest, so mostly you confirm or correct.
Your answer is stored as your own row next to the models' rows; nothing overwrites
anything. Other people's and the models' answers show after you answer, so your first look
stays independent ("Show now" reveals them earlier).

| Key | Where | Does |
|---|---|---|
| Enter | any step | take the suggestion as your answer and go on |
| Shift+Enter | any step | go back one step |
| Ctrl+S | anywhere | save the audit |
| ← → | crop view (steps 6, 7) | previous or next crop; flagged crops come first |
| Tab | crop view | next crop you have not answered |
| Y / N / U | crop view | yes, no or unsure for the highlighted problem (↑ ↓ move between problems) |
| 1 / 2 / 3 | crop view | the layer is OK, has minor errors, has major errors |
| Space, Shift+Space | crop view | layer OK; the whole crop is fine |
| C | crop view | can't tell from this crop |
| T, V | crop view | switch raw and prediction; side by side |
| - and + | crop view | weaker or stronger prediction overlay |
| A | crop view | all crops instead of only the flagged ones |
| M | crop view | show the crop on the map |
| B | step 1 and crop view, operators | copy this dataset or crop into the open benchmark |

At the top, the page adds the steps up to a decision (exclude, fix or ready). Confirm it or
pick another, then save. When you disagree with a check, say why with its fixed reasons; a
disagreement is the most useful thing you can give the checks.

Press **B** on a clear, instructive case: one the models got wrong, or a typical example
of a reason. B copies the dataset or crop into the benchmark; it never moves anything
there on its own, and it does not change the review.

**Known issue (16 Nov 2026):** on crops that are fully forest, the judges often claim
"trees missed" although the tree cover is fine, because the old drawing shows no edge
there. Trust your eyes over the models on those crops until the fix (below) is live.

## The review list

The review list is a stream, not a fixed set. Datasets join it when their checks have run:

- **Batches.** The pilot ran 100 datasets on 11 and 12 Nov 2026. The next 100 (the newest
  fully processed datasets without an audit) were queued on 16 Nov 2026. Each batch first
  gets the georeferencing and date checks on the processors at low priority, then the
  dataset evaluation and the prediction check in the audit worker.
- **New uploads.** Once a check version is active, every newly processed dataset gets a
  run of it automatically.
- **The backfill.** Later, every historical dataset is run through the checks. Old audits
  are imported as history, marked as imported, and are not treated as truth.

Each check version has a mode: `review_all` (every result goes to a person; every new
version starts here), `review_uncertain` (only unsure or disagreeing results) and
`auto_apply` (only a 5% spot check). Moving a check to a less strict mode is Janusch's
decision, based on its benchmark score and on how often reviewers corrected it.

The **Disagreements** tab lists datasets where people disagree with each other or with the
checks. Those go to adjudication.

## Benchmarks (the gold answer keys)

A benchmark answers one question: how good is a check version, measured against people?
It is a fixed list of targets (crops or whole datasets). The truth is the answers people
gave on those targets in the **Benchmark** tab of the audit, blind: you see the models'
and others' answers only after your own. Answers are stored per target, so they survive
new benchmark versions.

Rules:

- One benchmark holds crops or datasets, never both. Each check has at most one open
  version, where new targets go; a frozen version never changes, and a bigger set is a new
  version.
- About 1 in 5 datasets is held out by a fixed hash, and all crops of a dataset share its
  side. Tuning looks at dev only; the go or no-go for a change uses holdout only.
- Benchmark runs use their own queue. They never become a dataset's current result and
  never touch the review list.
- The old audits are not gold: auditors disagreed a lot (some excluded under 1% of their
  datasets, others over 40%).

### The two benchmarks we have

| Benchmark | Targets | Built from | State on 16 Nov 2026 |
|---|---|---|---|
| Prediction quality, `pq-gold-dt1272` | Crops, judged per layer | Crops Janusch graded during the first prediction study (DT-1272) | v1 frozen with 197 crops. v2 open with 172 (86 dev, 86 holdout), after 25 early test crops at the wrong scale were removed |
| Dataset evaluation, `dataset-evaluation-gold` | Whole datasets: keep, fix or exclude | 125 past exclusions spread by reason (blurry 35, no trees 25, artifacts 18, not RGB 15, broken ortho 12, too dark 8, other 12) and 125 kept (85 without issues, 40 fixable, the hard cases) | v1 open with 250 (207 dev, 43 holdout); not labeled yet |

The past audit decisions only make sure every reason is represented; the labels people give
in the Benchmark tab are the truth. The tab shows the images a run of the check stored, so
a target needs one run before it can be labeled.

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
   for the old version fail with a clear "wrong version" error instead of being judged
   with the new drawing.

A new rule alone (new thresholds, a new way to combine judges) needs no model calls: it is
recomputed from the stored answers.

## Not the same: the disturbance benchmark

The **satellite disturbance benchmark** (Releases, core team; v8 prepared in DT-1556) is a
separate thing. It scores satellite products of tree cover and deadwood change against
reference polygons over time, shown in its own viewer. It has nothing to do with the audit
judges. Its docs are in `docs/releases/disturbance-benchmark-*.md`.

## State on 16 Nov 2026 and what comes next

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

- [audit-checks.md](../audit-checks.md): tables, verdicts, modes, the worker, the review
  page and the benchmark mechanics.
- [dataset-evaluation.md](../dataset-evaluation.md) and
  [prediction-quality.md](../prediction-quality.md): what each judged check sees and its
  rule.
- `docs/qa/playbooks/auditor-check-review.md`: local QA of the review page.
