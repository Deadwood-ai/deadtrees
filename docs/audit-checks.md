# Automated audit checks

The audit is moving from form filling to oversight of automated checks (DT-1470).
Every check stores what it looked at and every answer, people's and models'.
Dataset verdicts are derived from those rows by versioned rules, so thresholds
and model combinations can change without new model calls. Everything lives in the
`audit` schema: `supabase/migrations/20261029103000_audit_checks_base.sql`. Checks built
on it: [dataset evaluation](dataset-evaluation.md), [prediction quality](prediction-quality.md).

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
| `audit.assessments` | assessor, target (crop or dataset) and layer; append-only | worker (model and rule rows), auditors (their own person rows) |
| `audit.benchmarks` | named, versioned set of targets for one check; frozen once final | operators |
| `audit.benchmark_members` | crop or dataset in a benchmark, with its `dev` or `holdout` split | operators, until frozen |
| `audit.benchmark_scores` | scoring of a check version on a frozen benchmark; append-only | worker, operators |

Modes per version: `review_all` (default for every new version), `review_uncertain`,
`auto_apply`. Only an operator (`can_operate`) changes the mode or the active version,
and only one version per check is active. A changed prompt, rule or config is a new
version. `audit.activate_version(version_id, inherit_mode)` switches the active version
in one call and can keep the mode of the version it replaces, so a change approved on
the benchmark does not send everything back to review.

## Assessments

- `assessor_kind`: `person` (`assessor_user_id`), `model` or `rule` (`model` and
  `prompt_version`, e.g. `luna-medium`/`v4`, `band_check`/`v1`; `run_id` required).
- `layer`: `image` (m0 gate on a crop, dataset evaluation on a dataset), `deadwood`,
  `forest_cover`, `georef`, `acquisition_date`, `phenology`.
- `verdict`, one vocabulary for every check:

  | Verdict | Meaning |
  |---|---|
  | `ok` | passes: keep, georef good, date valid, layer fine, crop assessable |
  | `minor` | passes with a problem: keep but fix or reprocess, layer error below 20% |
  | `major` | fails: exclude, georef poor, date mismatch, 20%+ of the layer wrong, crop not assessable |
  | `unsure` | could not decide; goes to a person |

- `modes`: failure modes and flags by key, named by the check. Every key names an
  error, so a high likelihood always means a problem. People store tags
  (`{"m1_dead_missed": true}`); models and rules store
  `{"m1_dead_missed": {"likelihood": 80, "area_pct": 12}}`.
- `label_id`: the prediction judged. No foreign key: after a prediction rerun the row
  is stale and stays as history.
- `reason_code` and `reason_text`: why a person marks a check wrong (the check's fixed
  choices plus text). `details`: the check's parsed answer. `raw`: the model reply.
- `imported_from`: set (by the service role only) on person rows copied from an
  older record that is not benchmark truth, e.g. `dataset_audit` for the audits made
  before the redo. These rows keep history and old decisions and serve as an opt-in
  weak label; benchmarks and agreement metrics use `imported_from is null`. Benchmark
  truth is the graded DT-1272 crops plus new reviews and adjudications.
- Rows are never updated. A correction is a new row; `audit.latest_assessments` shows
  the latest row per target, layer and assessor, where a native answer replaces the
  same person's imported one. `audit.disagreements` lists targets where people
  disagree with each other or with the check's call in the current run
  (`people_disagree`, `people_and_models_disagree`, native rows only), and where an
  imported answer differs from that call (`legacy_and_models_disagree`), so that
  dataset gets an early look. The call is read as `audit.review_queue` reads it: the
  target's rule rows where it has any, else its model rows, the worst verdict. An
  `unsure` call is no call, so a reviewer who confirms the verdict, or settles an
  unsure one, is not listed.

## Benchmarks

A benchmark fixes which targets a check is scored on; truth stays in
`audit.assessments` (native person rows, `imported_from is null`).

1. An operator creates a benchmark (e.g. `pq-gold-dt1272` v1) and adds members. A
   member's split defaults to `audit.benchmark_split(dataset_id)`, a fixed hash of the
   id with 1 in 5 held out; a set frozen earlier (the DT-1272 gold split) gives its own.
   All members from one dataset share one split.
2. Freezing (`frozen_at`) makes the members and the benchmark final; a bigger set is a
   new version. Only a deleted dataset or crop still takes its members along.
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
3. Derive the dataset verdict with the check's dataset rule, a small versioned function
   in the worker next to the benchmark scorer that tunes it. Its thresholds live in the
   version's `config`. It stores its result as a dataset-level `rule` row in the same
   run (`model` = rule name, `prompt_version` = rule version), e.g.
   `pq-dataset-rule/v1: deadwood major, 3 of 10 crops major`. Checks with one
   dataset-level model row per model (georef, date) need no rule. The verdict also
   goes to `dataset_audit_suggestions` with source `audit:<check>/<version>`.
4. `audit.review_queue` decides what needs a person, for every check alike: per
   dataset, check and layer it takes the current run's dataset-level rule rows (else
   its dataset-level model rows), counts the worst verdict, and applies the version's
   mode. `review_all` always needs review. `review_uncertain` needs review when a
   verdict is `unsure` or the assessors disagree. `auto_apply` sends only the
   spot-check sample (`config.spot_check_pct`, default 5). A native person answer on
   the dataset marks it reviewed when it was given on a run (`run_id`) that judged the
   same evidence: the same model run (a rule-only recomputation keeps the review) or a
   run with the same non-empty `inputs`, so a prompt change keeps it and a new ortho or
   prediction reopens it. The review page therefore always stores the run it reviewed.
   Answers without a run and imported old audits never mark a dataset reviewed.
   People's answers never count as automated results (`audit.current_assessments`
   holds model and rule rows only). The review page and the monitor read this view
   only.
   Runs record the judged identity in `inputs` (ortho sha256, prediction label ids,
   crop settings) and nothing that changes between identical runs.

A new rule version needs no model calls: a rule-only run (`source_run_id` = the run
whose model rows it uses) stores only the new rule rows and becomes current.
`audit.current_assessments` then combines the rule-only run's rows with the source run's
model rows; the old rule rows stay as history. People's answers stay valid, because
they judge the dataset, not the rule. Model rows are redone only when the prompt, the
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
  `CONFIG` (registered once as `review_all`, inactive), `handle(ctx)` (writes the run's
  crops, images and model and rule rows), optional `recompute(ctx)` for rule-only runs
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
- An expired login or a usage limit puts the run back without spending an attempt and
  pauses the worker. The pause shows in its status file
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

## Review page

The audit page (`/dataset-audit/<id>`, `frontend/src/components/DatasetAudit/checks/`)
shows the checks as sections in the sidebar: user reports, then 1 Dataset evaluation
(COG and thumbnail folded in), 2 AOI, 3 Georeferencing, 4 Acquisition date, 5 Phenology
(manual) and 6 Prediction quality. Opening a section puts the map into that check's
mode: the reference and match lines for georeferencing, the judged crops for the
dataset evaluation and prediction quality, and "Show what the model saw" loads the
stored images. Crops and images are stored
per ortho and shared by every run on it, so the page lists the crops the current run
names in `evidence.judged.crop_ids` and shows the run's own image file where
`evidence.judged.images` names one (a run of an earlier check version names none: the
page then takes the crops its rows name and its sets' crops of the ortho).

- A reviewer answers a check with Agree or Check wrong (the check's fixed reasons plus
  a note). Each answer is a new person row on the current run (`run_id`), so it marks
  the result reviewed in `audit.review_queue`; crop answers carry `crop_id`.
- Each reviewer answers on their own: a section under review needs you until you
  answered, whoever else did. Others' and the models' answers show after your answer
  (or "Show now").
- Once a reviewer has answered a check, the answer decides its `dataset_audit` field
  (georeferencing, date valid, the two prediction ratings): the form follows the
  answers and that field is read-only, so an answer and the saved audit cannot
  disagree. Without an answer on the current run the field stays editable. The dataset
  evaluation decides no field; its COG and thumbnail answers stay the reviewer's own.
  The derived decision at the top adds the sections up (evaluation exclude, any fix
  finding, else ready) and the reviewer confirms it or chooses another.
  `dataset_audit` is still what Save stores.
- The queue's To review tab lists every result under review that you have not
  answered; Disagreements reads `audit.disagreements`. Both read one server response
  (at most `max_rows`) and say so when the list is longer; the rows beyond it cannot
  be reached from the tab yet. Before the full backfill
  the "answered by me" filter and paging move into the database (DT-1486 follow-up),
  together with the view's own "reviewed on the same evidence" rule: the page counts
  an answer only on the current run, so a rule-only rerun asks again.
- Images come from `POST /api/v1/audit/images/access`, a signed link prefix for
  auditors (`can_audit`); files are served from the data directory's `audit/` folder
  through nginx and never statically. The route shares
  `api/src/access/core_team_files.py` with the disturbance benchmark files.
- What a check shows is declared once per section in `AUDIT_SECTIONS`
  (`frontend/src/utils/auditChecks.ts`): its layers, the verdicts a reviewer can give,
  the "Check wrong" reasons, its map (georeferencing matches or crops with their
  images) and whether reviewers answer per crop.

Local QA: `scripts/qa/seed-audit-checks.py` seeds one dataset with all three checks
(`docs/qa/playbooks/auditor-check-review.md`). Where the `audit` schema is not exposed
(API exposure above), the page says the results can't be read and the sections fall
back to the saved-audit fields.

## Importing earlier judgements

`scripts/audit_import.py` (dry run by default; `--execute` writes and needs approval):

- `audits`: saved `dataset_audit` rows become person rows marked
  `imported_from = 'dataset_audit'`, one per answered field: georef, acquisition date,
  deadwood and forest cover quality (great/sentinel_ok/bad as ok/minor/major, judged
  on the newest prediction made before the audit) and the final assessment as the
  dataset evaluation (no_issues ok, fixable_issues minor, exclude_completely major,
  COG/thumbnail/major issue flags as modes). Rows without an auditor are skipped.
  Phenology is not imported yet: `dataset_audit` keeps it until the phenology check
  exists. A second run adds nothing.
- `derive`: writes the crop manifest for the DT-1272 crops the database can place
  (earlier test crops from the COG window and geotransform, reference patch crops
  from the patch footprint).
- `gold`: the graded DT-1272 crops become the frozen benchmark `pq-gold-dt1272` v1:
  off-grid crops, their images (copied to the storage server first), the grader's
  person rows as truth and members with the frozen split (tune as dev, holdout as
  holdout; later batches follow their dataset, else the hash). Crops without a
  footprint in a manifest, or whose ortho was replaced after grading, are left out
  and listed. A window graded twice is one crop with both gradings; where the gradings differ the
  run stops and lists them, unless `--accept-later-answers` keeps both and lets the later
  one count.

## The saved audits

The saved human audits live in `dataset_audit_legacy`; `dataset_audit` is a view with the
same columns over it (migration `20261103103000_audit_legacy_compat.sql`). The view runs
as the caller and is updated automatically, so readers, the audit page's saves (insert,
update, upsert with RETURNING), the lease guard, the date decision trigger and the row
policies work as before. The six views compiled against the table stay bound to it and
read the same rows. The monitoring role reads its ten audit columns from
`dataset_audit_legacy`, because a caller-rights view needs every column of the table and
the notes stay closed to it. Later the view can read from the audit tables instead,
without touching a reader. Every historical dataset is re-run through the checks; the
old audits are imported as person rows marked `imported_from = 'dataset_audit'`
(DT-1487) and are not ground truth.
