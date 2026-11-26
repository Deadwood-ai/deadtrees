# Automated audit checks

The audit is oversight of automated checks (DT-1470), on the **Audit Review** page.
Every check stores what it looked at and every answer, people's and models'. Checks
report output values (an offset, a date replacement, crop counts), not dataset
verdicts; downstream users interpret them. Only the dataset evaluation keeps a verdict:
ok or exclude (unsure sends it to a person). Outputs are derived from the stored rows by versioned rules, so
thresholds and model combinations can change without new model calls. Everything lives
in the `audit` schema: `supabase/migrations/20261029103000_audit_checks_base.sql`, and
for the Audit Review `20261117140000_audit_review_outputs.sql` to
`20261117140300_detach_legacy_audit_writes.sql`. Checks built on it:
[dataset evaluation](dataset-evaluation.md), [prediction quality](prediction-quality.md),
[georeferencing](georef-check.md), [acquisition date](doy-estimation.md).
For the whole loop in plain words (review, benchmarks, how a change goes live), start with
[the audit and benchmarks playbook](playbooks/audit-and-benchmarks.md).

## Model

```text
audit.checks -> audit.check_versions -> audit.runs -> evidence -> audit.assessments
                                              |
                                     audit.current_runs (one per dataset and check)
```

| Table | One row per | Written by |
|---|---|---|
| `audit.checks` | check (`dataset_evaluation`, `georef`, `acquisition_date`, `prediction_quality`) | migrations |
| `audit.check_versions` | check version, with `mode`, `is_active` and free-form `config` | worker registers; operators switch mode and active version |
| `audit.runs` | run of a version on a dataset; every run is kept; queue `upload`, `backfill`, `manual` or `benchmark` | worker |
| `audit.current_runs` | dataset and check: the run whose results count | worker |
| `audit.crops` | area of one ortho version (by `ortho_sha256`): a window on the 10 cm CLIP grid, or a footprint only for crops made off the grid (DT-1272 gold); in one or more crop sets | worker; only `crop_sets` and `selection` grow |
| `audit.images` | stored image a check judged: raw crop per ortho, overlay per prediction label, overview and thumbnail per ortho | worker |
| `audit.assessments` | assessor, target (crop or dataset) and layer; append-only | worker (model and rule rows), auditors (their own person rows), migrations (imported legacy decisions) |
| `audit.benchmarks` | named, versioned set of targets for one check (and for prediction quality one layer); frozen once final | operators |
| `audit.benchmark_members` | crop or dataset in a benchmark, with its `dev` or `holdout` split | operators, until frozen |
| `audit.benchmark_scores` | scoring of a check version on a frozen benchmark; append-only | worker, operators |

Only an operator (`can_operate`) changes the active version, and only one version per
check is active. A changed prompt, rule or config is a new version.
`audit.activate_version(version_id, inherit_mode)` switches the active version in one
call. Versions still carry a mode (`review_all`, `review_uncertain`, `auto_apply`), but
since the Audit Review it decides nothing: what needs a person follows from the check
outputs alone (below).

## Assessments

- `assessor_kind`: `person` (`assessor_user_id`), `model` or `rule` (`model` and
  `prompt_version`, e.g. `luna-medium`/`v4`, `band_check`/`v1`; `run_id` required).
- `layer`: `image` (m0 gate on a crop, dataset evaluation on a dataset), `deadwood`,
  `forest_cover`, `georef`, `acquisition_date`, `phenology`.
- `verdict`, required for the dataset evaluation and on every crop, otherwise optional:

  | Verdict | Dataset evaluation | Crop |
  |---|---|---|
  | `ok` | ok | the layer is fine; the crop is assessable (m0 gate) |
  | `minor` | ok (the "keep, fix" of rule v2 and earlier answers; no longer written by the rule or the page) | the layer has errors below about 20% |
  | `major` | exclude | 20%+ of the layer wrong; the crop is not assessable |
  | `unsure` | the rule could not decide: a person reviews (rule rows only) | the model could not decide |
  | `ambiguous` | not allowed | an answer on a prediction layer, by a person or a model: no one can reliably tell what is right (the shrub to tree transition, an unusual dieback); it counts for neither side |

- `output`: what a check or a reviewer reports, an object or null. The dataset
  evaluation's rule writes `{"cog_issue": bool, "thumbnail_issue": bool}` (rule v3;
  v2 rows name them in `details.fix_flags`), and a reviewer's evaluation answer may
  carry the same. A reviewer answers georeferencing with `{"status": "passed" |
  "not_passed"}` and overrides the date replacement with `{"replace": bool}`, which needs
  a note in `reason_text`.
- `modes`: failure modes and flags by key, named by the check. Every key names an
  error, so a high likelihood always means a problem. People store tags
  (`{"m1_dead_missed": true}`); models and rules store
  `{"m1_dead_missed": {"likelihood": 80, "area_pct": 12}}`.
- `label_id`: the prediction judged. No foreign key: after a prediction rerun the row
  is stale and stays as history.
- `reason_code` and `reason_text`: why a person marks a check wrong (the check's fixed
  choices plus text). `details`: the check's parsed answer. `raw`: the model reply.
- `imported_from`: set (by the service role only) on person rows copied from an older
  record that is not benchmark truth. Since the Audit Review the only imported rows are
  the legacy evaluation decisions, `legacy_audit` (below); they may lack an auditor.
  Benchmarks and agreement metrics use `imported_from is null`.
- Rows are never updated. A correction is a new row; `audit.latest_assessments` shows
  the latest row per target, layer and assessor. `audit.current_assessments` holds the
  model and rule rows that count now (the current run's, plus the model rows of the run a
  rule-only run recomputes from).

## Audit Review results

`audit.dataset_results` (security invoker; auditors, operators, the worker and the
analyst role read it) has one row per `v2_datasets` row, in any processing stage. Its
columns are what the Audit Review page lists and filters:

| Columns | Output |
|---|---|
| `dataset_id`, `current_status`, `is_processing_done` | processing: done means idle, no error, COG and predictions done |
| `evaluation_decision` (`ok`, `exclude`), `evaluation_source` (`reviewer`, `legacy`, `check`) | the evaluation decision (`audit.evaluation_decisions`): the latest native reviewer row, else a legacy ok, else the current run's rule rows when they decide (worst verdict), else a legacy exclusion. A legacy exclusion holds only until the evaluation decides: the earlier audits excluded for reasons the evaluation does not count (season, georeferencing), so many were false |
| `cog_issue`, `thumbnail_issue` | the deciding reviewer's output where it has them, else the current rule rows |
| `aoi_exists`, `aoi_created_at`, `aoi_source`, `aoi_model_version` | the AOI the checks work in: a reviewer's before the predicted one, newest first |
| `georef_status`, `georef_offset_m`, `georef_source` | `audit.georef_output_v1(v2_georef_checks)`: `estimated` (deciding references agree; offset = their median p90), `not_passed` (a lost coordinate), `no_reference`, `needs_review` (references qualified but none decides, or they conflict; offset = the best supported qualified reference's p90). A reviewer's `passed` or `not_passed` replaces the status |
| `date_replace`, `date_new`, `date_predicted`, `date_hdi80_days`, `date_model_version`, `date_estimated_at`, `date_source` | `audit.acquisition_date_output_v1(v2_acquisition_date_estimates)` (AerialStamp): replace when the estimate is confident (one mode, 80% range at most 90 days) and the recorded date is a mismatch, has only a year, or only a month the prediction falls in; the new date is the predicted date. The latest native reviewer override wins. Nothing changes `v2_datasets` |
| `phenology_probability` | the probability of peak greenness on the recorded date |
| `deadwood_*`, `forest_cover_*` (`total`, `major`, `minor`, `ok`) | crop calls of the current prediction quality run: the deciding model's verdict (`rule_config.decider`, Haiku) where it could assess the crop; an ambiguous crop counts for no side |
| `review_required` | in step order: `evaluation` (the rule is unsure), `aoi` (processing done, no AOI), `georef` (needs review), each until a reviewer answers on the current evidence; `date` (AerialStamp dated the dataset again after a reviewer's override, which then no longer counts). The prediction layers never need review: their quality is to be reviewed on a stratified random sample of crops (not built yet). An audit has one review: the latest reviewer answer counts, and the page shows what it set, by whom and when. |
| `last_reviewed_at`, `in_benchmark`, `checks_run` | the latest native reviewer row; member of an open benchmark (the dataset or one of its crops); the checks with a current run |

"On the current evidence" means on the current run, the run it recomputes from, or a run
that judged the same non-empty `inputs` (ortho sha256, prediction labels): a prompt
change or a rule-only recomputation keeps a review, a new ortho or prediction reopens
it. The page stores the run it reviewed on every answer.

### Exclusion

A dataset leaves the public surface only when its evaluation decision is `exclude`.
`audit.is_dataset_excluded(dataset_id)` and `audit.excluded_dataset_ids()` (owner-run,
narrow, indexed by `assessments_evaluation_idx`) are the one source;
`internal.is_dataset_excluded_from_public_surface`,
`internal.public_surface_excluded_dataset_ids` and `internal.search_visible_dataset_ids`
call them, so the public dataset view, the archive, search, labels and AOIs, the
correction RPCs and PRIWA flights follow. Predictions are never hidden because of the
audit. The dataset views expose `audit_decision` (and `is_audited`) through
`internal.audit_decisions()`: audit readers see every decision, owners their own, the
public none. The export view (`v_export_polygon_candidates.audit_decision`), the factory
and the north star read the decision; "audited ok" is `ok`.

## Benchmarks

A benchmark fixes which targets a check is scored on; truth stays in
`audit.assessments` (native person rows, `imported_from is null`).

1. An operator creates a benchmark (e.g. `pq-gold-dt1272` v1) and adds members. A
   member's split defaults to `audit.benchmark_split(dataset_id)`, a fixed hash of the
   id with 1 in 5 held out; a set frozen earlier (the DT-1272 gold split) gives its own.
   All members from one dataset share one split.
2. Freezing (`frozen_at`) makes the members and the benchmark final; a bigger set is a
   new version. Only a deleted dataset or crop still takes its members along. A
   benchmark names the `layer` it scores: prediction quality has one benchmark per layer
   (`deadwood`, `forest_cover`), the dataset evaluation none (null). Each check and layer
   has at most one open (unfrozen) version, where new targets go:
   `audit.add_benchmark_target(check_key, dataset_id, crop_id, layer)` (operators;
   `crop_id` null adds the whole dataset) adds one, on the side its dataset already has
   in a benchmark of the check (any layer), else the hash. A benchmark holds crops or datasets, not
   both; a crop also joins the `benchmark` crop set. Truth is keyed by target, so a new
   version on the same crops keeps every answer given on them, and an operator's
   review-page answer on an added target is already its first label. On the Audit Review
   page each check's benchmark is added to where its answer is given, and the target joins
   with that answer as its label: the dataset from the evaluation step (B; the decision on
   the page is stored first), a crop to its layer's benchmark from the crop review of that
   layer's step (B; your answer on the crop is saved first). A target is in a benchmark
   only with its label. On the audit page's Benchmark tab operators label new random
   targets one at a time, blind (the models show once the target has a label): a random
   tile not in the benchmark yet, drawn by dataset first (stratified: every dataset equally
   likely), from the crops the check's current run judged on datasets the audit does not
   exclude, or a random dataset with a current dataset evaluation run. Each joins the
   benchmark once its label is stored, and the next one is drawn. "Review
   existing labels" and a table per benchmark (dataset, tile, label, who labeled it and
   when, split) show the labels. A target has one label, not one per labeler: the latest
   person row per layer, whoever gave it, so a new answer replaces it. Members added
   earlier without a label (the 250 picked datasets of `dataset-evaluation-gold` v1) are
   neither shown nor scored. A label carries the check's current run
   when that run judged the target, because `audit.latest_assessments` keeps one row per
   person and target across runs: a label without it would hide the same person's review
   of that run. Gold crops no run judged get no run. A layer's benchmark reads that
   layer's rows and "can't tell" (layer `image`). `pq-gold-dt1272` v2 (v1's 197 crops with
   their frozen splits, migration `20261113150000_open_benchmark_versions.sql`; 168 after
   the off-scale test views and the crops of excluded datasets left on 16 Nov 2026) was
   the one crop benchmark for both layers; `20261117140400_benchmarks_per_layer.sql`
   freezes it and opens `pq-deadwood-gold` v1 and `pq-forest-cover-gold` v1 with its crops
   and sides. Also open: `dataset-evaluation-gold` v1 (the 250 picked datasets of
   `scripts/dataset_evaluation/gold_set.py`).
   `audit.remove_benchmark_target(check_key, dataset_id, crop_id, layer)` takes a target out of
   the open version again (operators; `crop_id` null removes the dataset with all its
   crops; removing what is not there removes nothing). The labels stay, so adding the
   target back restores it. On the Benchmark tab operators remove with Remove (Del)
   after a confirm step, with Undo while the page is open. Crops whose dataset's
   decision is exclude (`audit.dataset_results.evaluation_decision`: a reviewer's, else
   the check's) leave the crop benchmarks while the decision stands: they are not shown
   and not scored, their labels stay, and they return when the decision changes. The
   dataset evaluation benchmark labels exclusion itself, blind.
3. A candidate version runs on the members in the `benchmark` queue. Benchmark runs
   stay out of the production queues and cost caps and never become the current run.
4. The check's scorer compares the candidate's rows with the truth rows and records
   the result in `audit.benchmark_scores` (split, metrics such as n, AUC, catch rate,
   false exclude rate, the runs used, scorer and version). Tuning uses `dev`;
   promotion uses `holdout` only.

## How a check plugs in

1. Register a version (the worker inserts it as `review_all`, inactive).
2. Per dataset, create a run, store its crops, images and run `evidence`, add one
   assessment per model or rule, and point `audit.current_runs` at the run. A check may
   do this in its own `SECURITY DEFINER` store function guarded by
   `internal.is_audit_worker()`.
3. A check with a dataset decision (only the dataset evaluation) stores it as a
   dataset-level `rule` row in the same run (`model` = rule name, `prompt_version` =
   rule version, `output` = what it reports beside the verdict). Its thresholds live in
   the version's `config`. Other checks store model rows only (prediction quality per
   crop, georeferencing one per dataset); their outputs are computed in SQL by a
   versioned function or from the crop rows (`audit.dataset_results`), so a new rule is
   a new function or config, not a rerun.
4. What needs a person follows from the outputs (`review_required`, above), never from
   the version's mode. A native person answer on the current evidence settles it.
   People's answers never count as automated results (`audit.current_assessments` holds
   model and rule rows only). Runs record the judged identity in `inputs` (ortho sha256,
   prediction label ids, crop settings) and nothing that changes between identical runs.

A new rule version needs no model calls: a rule-only run (`source_run_id` = the run
whose model rows it uses) stores only the new rule rows and becomes current (the
dataset evaluation's rule v3 recompute does this). `audit.current_assessments` then
combines the rule-only run's rows with the source run's model rows; the old rule rows
stay as history. People's answers stay valid, because they judge the dataset, not the
rule. Model rows are redone only when the prompt, the
model, the prediction or the ortho changes.

A worker that cannot reach a model (expired login) leaves its runs `queued`; it never
fails them for that reason.

## Access

Auditors, operators, the audit worker (the processor account) and the analyst role
read everything. Dataset owners and the public see nothing, so model results stay
with auditors. Operators define benchmarks; the worker and operators record scores.
The hash rule in `audit.benchmark_split` must never change.

A policy that applies to reads calls its access function inside a scalar subquery,
`using ((select internal.can_read_audit_checks()))`, so it runs once per statement.
A bare call runs per row and took the views over the assessments past the statement
timeout (DT-1532); a test keeps every read policy of the schema in that form.

## Audit worker

`processor/src/audit_worker` runs the checks on the processing server, as one process
under Janusch's account, so the model calls use his subscription logins: Claude
models through `claude -p`, OpenAI models (Luna, Sol) through the Codex login's
app-server. Both were probed with a synthetic image on 2026-11-02. Every call runs in an
empty temporary folder with no project instructions, settings, plugins or tools: the
images travel inline in the request, so a model cannot read files of the account.

- A check plugs in with a handler module listed in `worker.HANDLERS`: `VERSION` and
  `CONFIG` (registered once, inactive), `handle(ctx)` (writes the run's crops, images
  and model and rule rows), optional `recompute(ctx)` for rule-only runs
  (no judges), optional `ready(status)` (default: COG and predictions done) and optional
  `inputs(client, dataset_id)` (the evidence a run judges: ortho sha256, prediction label
  ids). The login a run starts with lasts 20 to 60 minutes: a handler whose model calls
  can take that long calls `ctx.refresh()` before its writes, and the worker renews it
  again before it writes the run's end state. `CONFIG['models']` names the judges, e.g.
  `{"haiku-5.5": {"transport": "claude", "model": "claude-haiku-5-5"},
  "luna-medium": {"transport": "codex", "model": "gpt-6-luna", "effort": "medium"}}`.
- Queues: new uploads first, then manual runs, then the backfill. Benchmark runs only in a
  `--benchmark` session. Every five minutes, datasets that finished processing get an
  upload run of each active version unless a run of that version already judged the
  same inputs, so rerun predictions get a new run. The worker keeps how far it has looked
  (`discovered-until` next to the status file), so datasets finished while it was down are
  found after a restart. Benchmark runs never stand in for
  production runs. The backfill is queued explicitly with `enqueue` (`--force` reruns).
- A finished run becomes current only when its version is the active one. The database
  enforces this: a pointer to a run of an inactive version is skipped, not refused, so a
  check may point unconditionally while its version waits for activation; a benchmark run
  is refused. Pointers set before this guard, activating a version and deleting pointers
  are not affected. A run replaces a
  missing pointer or one at another version's run (promotion), and within its version
  only an older run. The write lands only if the pointer is still the one read. A sweep
  applies the same rule to every done run of each active version, with no age limit,
  which repairs a pointer that did not land and carries out a promotion.
- At start the worker puts runs left `running` by a stopped worker back in the queue
  (there is one worker), or fails them after their last attempt.
- Calls are paced per login (`models.paced`): one call at a time on the Codex login,
  because two image turns at once ran into "429 Too Many Requests" in the pilot
  (DT-1536), and a rate-limited call waits 30, 60 and 120 seconds and is asked again.
- An expired login, a usage limit, or a rate limit that outlasts those waits puts the run
  back without spending an attempt and pauses the worker. The pause shows in its status file
  (`~/.local/state/deadtrees-audit-worker/status.json`), and the platform monitor turns
  it into a finding, as it does for a worker that stops writing that file. Other errors
  are retried up to three times, then the run fails with its error.
- The worker refuses to start without a memory cap of at most 10 GB, because production
  ODM runs on this host.

```bash
python -m processor.src.audit_worker probe            # logins only, no model call
systemd-run --user --scope -p MemoryMax=10G -- python -m processor.src.audit_worker run
python -m processor.src.audit_worker enqueue --check prediction_quality --queue backfill --file ids.txt
python -m processor.src.audit_worker status
```

Starting the worker for real, and any backfill, needs approval.

## API exposure

The app reaches these tables through PostgREST, which serves only the schemas it is
configured for. Locally and in CI, `supabase/config.toml` lists `audit` under
`api.schemas`. Clients name the schema, e.g. `client.schema('audit').table('runs')`
(supabase-py and supabase-js).

Production (self-hosted Supabase on data2) still needs `audit` added to the PostgREST
setting before the audit worker or the review page goes live. That is a production
config change and needs explicit approval. On data2, in the Supabase Docker
directory:

```bash
cp .env .env.bak-$(date -u +%Y%m%dT%H%M%SZ)
grep '^PGRST_DB_SCHEMAS=' .env   # expected: public,storage,graphql_public
sed -i '/^PGRST_DB_SCHEMAS=/ s/$/,audit/' .env
docker compose up -d rest
```

To check it, request `/rest/v1/checks` with the header `Accept-Profile: audit` as an
auditor; it lists the four checks. To roll back, restore the backup and run the same
`docker compose up -d rest`.

The review page's images need one change to the host nginx on data2
(`/apps/deadtrees/nginx/conf/storage-server.conf`, not this repository; see
`docs/playbooks/dataset-access-rollout.md`): add `audit/images/files/` to the ticket
location `^/api/v1/(datasets/[0-9]+/files/|exports/|disturbance-benchmark/files/)` so
signed image links stay out of the access log, then `nginx -t` and reload. The images
work without it through `/api/v1/`; only the log hygiene is missing.

## Audit Review page

The list (`/dataset-audit`) reads `audit.dataset_results`. Its Audit Review tabs: **All
audits** (every dataset, with filters on its columns), **Pending audit reviews**
(`review_required` not empty) and **Benchmark** (`in_benchmark`). Apart from them, under
**Other**: **Edits & flags** (user reports and suggested prediction edits, each dataset on
its own page `/dataset-audit/<id>/edits-flags`; not part of the audit and not guarded by
the review lease), **Segmentation Benchmark** (reference patches) and the **Legacy Manual
Audits**, a read-only history list (through `get_dataset_audits_with_emails`). The detail page
(`/dataset-audit/<id>`, `frontend/src/components/DatasetAudit/`) shows the checks as
steps: 1 Dataset evaluation (COG and thumbnail, then the decision OK or Exclude), 2 AOI, 3
Georeferencing, 4 Acquisition date (AerialStamp), 5 Phenology (the probability and the
phenology indicator bar), 6 Tree cover, 7 Deadwood. Save writes only `audit.assessments`
person rows, each on the current run (`run_id`). Crop answers (OK, Minor, Major or
Ambiguous per layer, keys 1 to 4) are stored at once and carry `crop_id`; a prediction
layer has no answer of its own. The review lease (`dataset_audit_locks`) guards the
page's map edits (the AOI).

Crops and images are stored per ortho and shared by every run on it, so the page lists
the crops the current run names in `evidence.judged.crop_ids` and shows the run's own
image file where `evidence.judged.images` names one.

- Images come from `POST /api/v1/audit/images/access`, a signed link prefix for
  auditors (`can_audit`); files are served from the data directory's `audit/` folder
  through nginx and never statically. The route shares
  `api/src/access/core_team_files.py` with the disturbance benchmark files.
- Operators add a dataset (evaluation step) or crop (crop review) to its check's open
  benchmark with their answer as its label, and remove it (`audit.add_benchmark_target`,
  `audit.remove_benchmark_target`).

Local QA: `scripts/qa/seed-audit-checks.py` seeds one dataset with all three checks
(`docs/qa/playbooks/auditor-check-review.md`). Where the `audit` schema is not exposed
(API exposure above), the page says the results can't be read.

## Imported legacy decisions

The saved manual audits come in once, as evaluation decisions only (migration
`20261117140000_audit_review_outputs.sql`): `exclude_completely` as `major`, `no_issues`
and `ready` as `ok`, as person rows marked `imported_from = 'legacy_audit'`, by the
audit's auditor (which may be unknown) and dated by the audit. `fixable_issues` and all
other fields stay in the history only. A legacy ok outranks the evaluation; a legacy
exclusion only holds until the evaluation decides (`audit.evaluation_decisions`). The earlier per-field import
(`imported_from = 'dataset_audit'`, `scripts/audit_import.py`) is gone. The DT-1272
gold crops and the dataset evaluation gold set were imported into their benchmarks
before.

## The saved audits

The saved manual audits live in `dataset_audit_legacy`; `dataset_audit` is a view over
it (migration `20261103103000_audit_legacy_compat.sql`). Since the Audit Review they are
read-only history: no role but the database owner writes them, no trigger runs on them,
the monitoring role no longer reads them, and only the legacy list page's RPCs
(`get_dataset_audits_with_emails`, `get_dataset_audit_with_emails`) and the analyst role
read them. The old date decisions (`acquisition_date_decisions`) are history too, and
`dataset_audit_suggestions` and `public.audit_review_queue` are gone.
