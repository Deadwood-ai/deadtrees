# Automated audit checks

The audit is oversight of automated checks (DT-1470), on the **Audit Review** page.
The database stores answers only: what each model and each person said, about a whole
dataset or about one tile. Every result (which run counts, a tile's verdict, keep or
exclude, what still needs a person) is worked out in one view when it is read, so it is
never out of date. Everything lives in the `audit` schema; the model is built by
`supabase/migrations/20261126120000_audit_answers.sql` to
`20261126120400_detach_legacy_audit_writes.sql` (DT-1606) on top of the base
`20261029103000_audit_checks_base.sql`. Checks built on it:
[dataset evaluation](dataset-evaluation.md), [prediction quality](prediction-quality.md),
[georeferencing](georef-check.md), [acquisition date](doy-estimation.md).
For the whole loop in plain words (review, benchmarks, how a change goes live), start with
[the audit and benchmarks playbook](playbooks/audit-and-benchmarks.md).

## Tables

| Table | One row per | Written by |
|---|---|---|
| `checks` | check: `dataset_evaluation`, `prediction_quality`, `georef`, `acquisition_date` | migrations |
| `check_versions` | what a check asks: models, prompt, tile picking (`config`); one active per check | worker registers (switched off); operators switch on |
| `check_rules` | how a version's answers turn into results: the deciding judge (`decider`, a model name prefix) and thresholds; one active per version | worker registers (switched off); operators switch on |
| `runs` | one execution of a version on a dataset: `status` (`queued`, `running`, `done`, `failed`), `queue` (`upload`, `backfill`, `manual`), `inputs` (ortho sha256, AOI, prediction label ids), `evidence` (coverage, cost, check-specific evidence) | worker |
| `tiles` | square patch of the dataset's ortho on the 10 cm CLIP grid (`pixel_x0..y1`) with its footprint, or a footprint alone off the grid (the DT-1272 gold crops). Identified by window and footprint, no ortho fingerprint: a rerun on an ortho that did not move finds its tiles (and their reviews) again; a rewrite that moves the image gives new tiles | `finish_run` |
| `images` | picture a run cut and judged (`raw`, `deadwood_overlay`, `forest_cover_overlay`, `overview`, `thumbnail`), stored on the storage server under `audit/`; `run_id` null only for the gold crops' images | `finish_run` |
| `dataset_vlm_judgements` | a model's answer about a dataset in a run: `verdict`, `likelihood`, `cog_issue`, `thumbnail_issue`, `exclude_reason`, `summary`, `raw` | `finish_run`; never changed |
| `tile_vlm_judgements` | a model's answer about one tile and layer (`deadwood`, `forest_cover`) in a run: `verdict`, `likelihood`, `problems` (`{"m1_dead_missed": {"likelihood": 80, "area_pct": 12}}`), `summary`, `raw` (keeps the error sentences as `raw.errors`) | `finish_run`; never changed |
| `dataset_human_reviews` | a person's answer about a dataset for one check: `decision` and `exclude_reason`, `cog_issue`, `thumbnail_issue` (dataset evaluation); `georef_status` `passed`/`not_passed` (georef); `date_replace` (acquisition date); `note`; `in_benchmark` | auditors, insert only |
| `tile_human_reviews` | a person's answer about one tile and layer, on the prediction it showed (`prediction_label_id`): `verdict`, `problems` (`{"m1_dead_missed": true, "m2_dw_on_live_vegetation": "unsure"}`), `note`, `in_benchmark` | auditors, insert only |
| `legacy_decisions` | keep or exclude of the old manual audit (`no_issues` and `ready` keep, `exclude_completely` excludes; `fixable_issues` stays out) | the rewrite migration, once |

`verdict` is one vocabulary: `ok`, `minor`, `major`, `ambiguous` (no one can reliably tell
what is right, a tile answer only) and `not_assessable` (a model could not assess it, a
person cannot tell what the tile shows). A new answer is a new row; the newest counts.

`dataset_human_reviews.evidence_key` is set on insert, never by the client: the ortho's
sha256 for the dataset evaluation and georeferencing, the date estimate's advice
(`replace` or `keep`) for the acquisition date (`internal.audit_evidence_key`). A review
whose key differs from the dataset's current one is stale and no longer counts. A tile
review counts while the run judged the same prediction label.

## Views

| View | Per | What |
|---|---|---|
| `current_runs` | dataset and check | the run that counts and the rules to read it with: the latest done run of the active version; while a dataset waits for its rerun, its latest done run of an older version, read with that version's active rules |
| `tile_calls` | tile and layer of the current prediction quality run | the newest person's review on that tile, layer and prediction label; else the deciding judge's answer (`not_assessable` gives no call, `ambiguous` counts for no side) |
| `evaluation_calls` | dataset | the current dataset evaluation run under its rules: an empty COG (`evidence.empty`) and a band check at or over `band_major_at` exclude without a model; else the deciding judge (`judgement_id`): `ok` and `minor` keep, `major` excludes, anything else is unsure (decision null). Rules with `"call": "recorded"` (the migrated v1 and v2, whose mean-and-spread rule is not worked out again) read the call each run recorded in `evidence.rule` instead, until an operator switches on rules with a decider |
| `current_dataset_human_reviews` | dataset and check | the newest review and whether it is `stale` |
| `evaluation_decisions` | dataset | the keep or exclude that counts, first that exists: a non-stale review, the old audit's keep, the check's call, the old audit's exclude (an old exclusion holds only until the check decides). Columns `decision`, `source` (`reviewer`, `legacy`, `check`), `verdict`, `output`, `decided_at` |
| `dataset_outcomes` | dataset (any processing stage) | what the Audit Review and the dataset page show: the decision and its source, COG and thumbnail issues, the AOI, the georeferencing status (a non-stale review replaces the check's), the date (`date_replace`, `date_new`, a non-stale reviewer's answer included), phenology, Major/Minor/OK tile counts per layer, `in_benchmark`, and `review_required` |

`review_required`, in step order: `evaluation` (the check is unsure and no review
counts), `aoi` (processing done, no AOI), `georef` (`needs_review` and no review counts),
`date` (the date review is stale: the estimate's advice flipped since; a new estimate
with the same advice keeps it). The prediction layers never need review.

`audit.georef_output_v1(v2_georef_checks)` and
`audit.acquisition_date_output_v1(v2_acquisition_date_estimates)` turn the measured
checks into outputs; those checks keep their v2 tables and have no runs. Nothing in the
audit changes `v2_datasets`.

### Exclusion

A dataset leaves the public surface only when its evaluation decision is `exclude`.
`audit.is_dataset_excluded(dataset_id)` and `audit.excluded_dataset_ids()` (owner-run)
are the one source; `internal.is_dataset_excluded_from_public_surface`,
`internal.public_surface_excluded_dataset_ids` and `internal.search_visible_dataset_ids`
call them, so the public dataset view, the archive, search, labels and AOIs, the
correction RPCs and PRIWA flights follow. Predictions are never hidden because of the
audit. The dataset views expose `audit_decision` (`keep`, `exclude`) and `is_audited`
through `internal.audit_decisions()`: audit readers see every decision, owners their
own, the public none. The export view, the factory and the north star read the decision;
"audited ok" is `keep`. `public.get_dataset_audit_summary(dataset_id)` gives anyone who
can see the dataset its outcome and the deciding model's reasoning on the tiles it found
errors on.

## Versions, rules and reruns

- New rules (same models, same question): the worker or a script registers a rule set,
  an operator switches it on with `audit.activate_rules(rules_id)`, and every result of
  that version is worked out again at once from the stored answers.
- New version (other models or another question): the worker registers it with its rules;
  an operator switches its rules and then the version on (`audit.activate_version`
  refuses a version without active rules). Activation queues nothing: an operator queues
  the backfill, which needs approval. Each dataset keeps its last result until its rerun
  finishes.
- A new ortho or prediction is a new run of the check that judged it; dataset reviews
  stop counting with a new ortho, tile reviews with a new prediction label.

## Access

Auditors, operators, the audit worker (the processor account, `internal.is_audit_worker()`)
and the analyst role read everything; dataset owners and the public see nothing. Auditors
insert their own reviews (`reviewed_by` = themselves); a review with `in_benchmark` is an
operator's. Nobody updates or deletes a review. The worker inserts versions and rules
switched off and inserts and updates runs; it writes tiles, images and judgements only
through `audit.finish_run`. A policy that applies to reads calls its access function in a
scalar subquery, `using ((select internal.can_read_audit_checks()))`, so it runs once per
statement (DT-1532); a test keeps every policy of the schema in that form.

## Benchmarks

A benchmark is the `in_benchmark` tick on a person's review. The dataset evaluation
benchmark is the dataset evaluation reviews with the tick; the deadwood and tree cover
benchmarks are the tile reviews with the tick on that layer. There are no benchmark
tables, versions, freezing or split. The label shown is the newest review of the target,
whoever gave it.

- `audit.draw_target(benchmark, skipped)` (operators; `dataset_evaluation`, `deadwood` or
  `forest_cover`) draws the next random target not yet ticked and not in `skipped`: a
  dataset with a current dataset evaluation run, or a random dataset first (not excluded,
  with a current prediction quality run) and then a random tile of that run with a call
  on the layer. No row when nothing is left.
- Labeling is a plain insert into `dataset_human_reviews` or `tile_human_reviews` with
  `in_benchmark = true`. An operator's dataset label is also that dataset's review.
- `audit.remove_benchmark_target(benchmark, dataset_id, tile_id)` (operators) clears the
  tick on the target's reviews; the reviews stay. It returns how many lost the tick.

The rewrite ticked the newest review of every labeled member of the open benchmark
versions (the DT-1272 gold labels included); members without a label, such as the 250
picked datasets of `dataset-evaluation-gold`, were dropped.

## Audit worker

`processor/src/audit_worker` runs the model checks (dataset evaluation, prediction
quality) on the processing server, as one process under Janusch's account, so the model
calls use his subscription logins: Claude models through `claude -p`, OpenAI models
(Luna, Sol) through the Codex login's app-server. Every call runs in an empty temporary
folder with no project instructions, settings, plugins or tools: the images travel inline
in the request, so a model cannot read files of the account.

- A check plugs in with a handler module listed in `worker.HANDLERS`: its version and
  rules (registered once, switched off), `handle(ctx)` (judges the dataset and builds
  the `finish_run` payload), optional `ready(status)` and `inputs(client, dataset_id)`
  (what a run judges: ortho sha256, AOI, prediction label ids).
- The worker creates a run, marks it running, and on success calls
  `audit.finish_run(run_id, result)`, which stores the run's tiles, images and
  judgements and marks it done in one transaction:
  `{inputs, evidence, tiles: [{pixel_window | null, geometry, mpp, size_px}],
  images: [{tile_index | null, prediction_label_id, kind, storage_path, content_type,
  width, height, mpp, bytes, sha256}], dataset_judgements: [{judge, verdict, likelihood,
  cog_issue, thumbnail_issue, exclude_reason, summary, raw}], tile_judgements:
  [{tile_index, layer, judge, verdict, likelihood, problems, summary, raw}]}`. Image files
  are uploaded before the call. Which run counts is `audit.current_runs`: the worker
  points nothing.
- Queues: new uploads first, then manual runs, then the backfill. Every five minutes,
  datasets that finished processing get an upload run of each active version unless a run
  of that version already judged the same inputs. The backfill is queued explicitly with
  `enqueue` and needs approval.
- A worker that cannot reach a model (expired login, usage limit, a rate limit that
  outlasts its waits) puts the run back without spending an attempt and pauses; its status
  file (`~/.local/state/deadtrees-audit-worker/status.json`) shows it and the platform
  monitor reports it. Other errors are retried up to three times, then the run fails with
  its error. At start, runs left `running` by a stopped worker go back to the queue.
- Calls are paced per login (`models.paced`): one call at a time on the Codex login.
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

The list (`/dataset-audit`) reads `audit.dataset_outcomes`; the detail page
(`/dataset-audit/<id>`, `frontend/src/components/DatasetAudit/`) reads the current runs,
their images and judgements, `tile_calls` and `current_dataset_human_reviews`, and saves
reviews into the two human review tables. Images come from
`POST /api/v1/audit/images/access`, a signed link prefix for auditors (`can_audit`);
files are served from the data directory's `audit/` folder through nginx and never
statically. **Edits & flags** (user reports and suggested prediction edits) are not part
of the audit and not guarded by the review lease; the lease (`dataset_audit_locks`)
guards the page's map edits (the AOI).

Local QA: `scripts/qa/seed-audit-checks.py` seeds datasets with the checks
(`docs/qa/playbooks/auditor-check-review.md`).

## The saved audits

The saved manual audits live in `dataset_audit_legacy`; `dataset_audit` is a view over
it. They are read-only history: no role but the database owner writes them, no trigger
runs on them, and only the legacy list page's RPCs (`get_dataset_audits_with_emails`,
`get_dataset_audit_with_emails`) and the analyst role read them. Their keep or exclude was
copied once into `audit.legacy_decisions`. The old date decisions
(`acquisition_date_decisions`) are history too; `dataset_audit_suggestions` and
`public.audit_review_queue` are gone.
