# DeadTrees Data Factory

This document defines the user-facing product model for DeadTrees. It should be
the shared basis for product decisions, analytics, and regression tests.

DeadTrees exists to collect high-quality forest drone imagery, process it into
deadwood and forest-cover segmentation, turn the best outputs into trusted
reference/benchmark data, and use that data for satellite-scale forest mortality
products.

![DeadTrees Data Factory](deadtrees-data-factory.png)

## Framework

Use the DeadTrees Data Factory as the operating model:

- **Input**: potential contributors, data users, reviewers, partners, and raw
  forest data.
- **Output**: processed, trusted, reusable forest data products and the people
  who can act on them.
- **Throughput**: the weekly rate at which these outcomes happen.
- **Constraint**: the weakest step in the system right now.

The useful question is not "which features exist?" but:

> Where does the DeadTrees factory currently lose valuable data, trust, reuse,
> or contributor momentum?

Background sources:

- [How to Systematically Prioritize and Tackle the Riskiest Assumptions in Your Business Model](https://www.leanfoundry.com/articles/how-to-systematically-prioritize-and-tackle-the-riskiest-assumptions-in-your-business-model)
- [Traction is the Goal. Everything Else is Distraction.](https://www.leanfoundry.com/articles/traction-is-the-goal-everything-else-is-distraction)
- [What's Your Company's Bottleneck?](https://www.lean.org/the-lean-post/articles/whats-your-companys-bottleneck/)

## Product Roles

### Priority Role: Data Contributor

The priority role for the current phase is the data contributor: someone with
access to forests who can upload raw drone imagery or pre-processed GeoTIFF
orthophotos.

Their expected value:

- AI-derived deadwood, standing deadwood, and forest-cover segmentation.
- A processed dataset they can inspect, download, reuse, and cite.
- A path to improve labels/corrections.
- Attribution and optional publication through DOI/FreiDATA.

This role matters most because new high-quality drone data is the scarce input
for reference datasets, benchmark datasets, model improvement, and satellite
upscaling.

### Other Important Roles

- **Reference / benchmark data reuser**: mainly ML users who need drone-derived
  reference datasets, benchmark data, model outputs, and releases.
- **Satellite data user**: mainly ecological or applied researchers who need
  large-scale satellite-derived layers for analysis.
- **Core team / expert reviewer**: audits datasets, resolves flags and edits,
  maintains trusted reference data, and keeps the factory running.
- **General explorer**: browses the site, archive, maps, or releases without yet
  contributing or downloading.

## North Star

Candidate north-star metric:

> Weekly trusted forest-data outcomes.

This is not one raw count. It should be reported as a small metric stack:

| Layer | Measures | Why it matters |
| --- | --- | --- |
| Input | New qualified drone ZIP and GeoTIFF submissions; unique contributors; countries, regions, biomes, acquisition periods. | Shows whether the platform is growing the raw data base. |
| Processing | Successful processing rate; processing lead time; failure rate; time-to-notify; time-to-fix. | Shows whether submissions become usable outputs fast enough. |
| Trust | Audited datasets; corrected labels; validated reference patches; release-ready benchmark assets. | Shows whether outputs are reliable enough for reuse and model training. |
| Impact | Downloads; release artifact access; publications/DOIs; repeat users; future satellite dataset downloads. | Shows whether the created data is actually used. |

Contributor processing target: results should ideally be available within one
hour, with two hours as an initial healthy-experience reference for typical
GeoTIFF submissions. Workflow and input size matter; raw-image photogrammetry
and larger inputs need separately calibrated expectations. These are soft
operational warnings, never cancellation deadlines.

## Factory Steps

| Step | Product meaning | Primary actions | Existing events |
| --- | --- | --- | --- |
| Acquisition | A potential contributor or user discovers that DeadTrees is relevant. | Visit homepage, browse archive, open releases, search/filter map, sign up/contact. | `$pageview`, `landing_cta_clicked`, `faq_opened`, `newsletter_signup_submitted`, `dataset_archive_viewed`, `dataset_search_used`, `dataset_filter_applied`, `dataset_map_interacted`. |
| Activation | First clear value moment. | Contributor has processing completed and then views the processed segmentation result for the first time. Data-reuser activation is less clear and should be validated with analytics before prioritizing. | `dataset_opened`, `processing_result_viewed`, `sign_up_started`, `sign_up_completed`, `sign_in_completed`, `upload_started`, `upload_completed`. |
| Retention / value | User comes back to do work. | Download, edit, save corrections, report issue, inspect own datasets, audit, review corrections, use reference editor. | `dataset_download_started`, `dataset_download_completed`, `edit_started`, `edit_saved`, `flag_submitted`, `audit_queue_viewed`, `audit_started`, `audit_completed`, `correction_review_started`, `correction_approved`, `correction_reverted`, `reference_patch_editor_opened`. |
| Impact capture | The platform creates durable scientific value. | Publish datasets, validate reference patches, create releases, generate satellite inputs/outputs, cite or reuse data. | `publish_started`, `publish_submitted`, `publish_completed`, `publish_failed`, `dataset_download_completed`, `audit_completed`, `correction_approved`. |
| Referral / community | Existing value brings in new contributors or users. | Contributor attribution, DOI/citation, shared releases, partner outreach, newsletter/contact. | `newsletter_signup_submitted`, `email_link_clicked` is planned in the current event map. |

## Core User Actions

### Contributor Actions

- Open upload path from homepage, archive, or profile.
- Sign up or sign in.
- Select raw drone ZIP or GeoTIFF orthophoto.
- Add required metadata: platform, license, spectral properties, acquisition
  date, authors, DOI/reference, access mode, optional labels.
- Upload through chunked upload.
- Queue processing:
  `odm_processing` for raw images, then `geotiff`, `cog`, `thumbnail`,
  `metadata`, `deadwood_v1`, `treecover_v1`,
  `deadwood_treecover_combined_v2`.
- View processing status.
- Open processed result and inspect orthophoto, deadwood, standing deadwood,
  forest cover, metadata, and quality state.
- Download outputs.
- Improve predictions through correction/labeling tools.
- Publish eligible datasets with authors/ORCID metadata.

### Data Reuse Actions

- Find data through archive, map, search, filters, or releases.
- Inspect provenance, DOI/reference, author, location, biome, acquisition date,
  audit state, and model citations.
- View orthophoto and prediction layers.
- Download full dataset, labels-only GeoPackage, or release artifact.
- Report an orthomosaic or prediction issue.
- Use benchmark/reference releases for ML workflows.
- Use satellite layers or future satellite downloads for ecological analysis.

### Core Team Actions

- Review audit queues by status, biome, country, contributor, auditor, flags,
  acquisition period, season, processing stage, and user.
- Audit georeferencing, acquisition date, phenology, COG, thumbnail, AOI,
  prediction quality, and final assessment.
- Resolve user flags and submitted corrections.
- Place and validate reference patches.
- Monitor processing queues, stuck stages, failures, and logs.

## Dataset Factory

The data factory depends on dataset throughput:

![DeadTrees dataset factory](deadtrees-dataset-factory.png)

Flow: upload intent -> drone ZIP or GeoTIFF + metadata -> processing queue ->
ODM/GeoTIFF/metadata -> COG + thumbnail -> AI predictions -> contributor
inspection/download/editing -> audit/corrections -> reference or benchmark
export -> release/publication -> satellite products.

Likely bottleneck areas:

- Upload intent lost before upload starts.
- Uploads fail or take too long.
- Processing fails, gets stuck, or leaves users uninformed.
- Contributors cannot easily inspect, reuse, edit, or publish processed results.
- Audit/correction/reference review backlog delays trust.
- Downloads/releases are unclear or slow.
- Satellite data exists as a map but not yet as a clear downloadable product.

## Analytics Gaps

Keep the current AARRR event names in
[`docs/analytics/aarrr-framework.md`](aarrr-framework.md). Add events only when
they diagnose a bottleneck or anchor a regression test.

Highest-value missing events:

| Event | Purpose |
| --- | --- |
| `upload_modal_opened` | Measures upload intent before upload start. |
| `upload_validation_failed` | Finds blockers in file type, size, metadata, or GeoTIFF/ZIP validation. |
| `processing_queued` | Confirms upload became backend work. |
| `processing_completed` | Measures conversion from submission to usable output. |
| `processing_failed` | Measures product-level failure rate. |
| `processing_failure_notified` | Measures whether failed contributors are kept informed. |
| `processing_failure_resolved` | Measures time-to-fix. |
| `owner_processing_result_viewed` | Measures contributor activation after processing. |
| `dataset_layer_toggled` | Shows whether users inspect orthophoto, deadwood, forest cover, AOI, or metadata only. |
| `download_restricted` | Measures view-only/private access friction. |
| `label_improvement_started` / `label_improvement_saved` | Measures edited and improved datasets. |
| `audit_saved_and_next` | Measures reviewer throughput. |
| `flag_status_updated` | Measures closing the loop on user-reported issues. |
| `reference_patch_validated` | Measures trusted reference-data creation. |
| `release_opened` / `release_artifact_clicked` | Measures benchmark/reference reuse. |
| `satellite_map_opened` / `satellite_layer_toggled` | Separates satellite-data users from drone/reference users. |
| `satellite_dataset_downloaded` | Future event once satellite downloads exist. |

## Test Backbone

Each base product action should have at least one durable test or smoke check.

| Area | Minimum coverage |
| --- | --- |
| Discovery | Homepage, dataset archive, search/filter/map, release index. |
| Contribution | Auth routes, upload modal validation, raw ZIP vs GeoTIFF handling, processing queue request. |
| Processing visibility | Profile processing status, failed/stuck states, user-facing notification path. |
| Result inspection | Dataset details, COG map, layer controls, metadata, audit state, satellite map. |
| Reuse | Download preparing/completed/failed states, labels-only download, view-only restrictions, release artifact links. |
| Improvement | Issue reporting, correction editor start/save, correction approval/revert. |
| Trust | Audit queue filters, audit lock, audit save, reference patch validation/export readiness. |
| Publication | Dataset selection, author/ORCID validation, publication submission state. |

## Current Decisions

1. **Weekly headline metric**: use a composite, not a single count. The current
   scorecard should include qualified submissions, successful processing,
   processing lead time, failures/time-to-fix, audited or trusted assets,
   downloads, publications, validated reference patches, and release usage. This
   is the wider product scorecard; the operational Factory overview prioritizes
   processing throughput, end-to-end waiting and failure recovery.
2. **Healthy processing lead time**: target one hour from completed upload to
   processed result for typical GeoTIFF submissions, with two hours as a soft
   healthy-experience reference. Calibrate by workflow/size before extending
   this expectation to raw-image photogrammetry or larger inputs.
3. **Contributor activation**: processing is completed and the contributor
   views the processed segmentation result for the first time.
4. **Data-reuser activation**: unresolved. At this stage, contributor outcomes
   are more important. Downloads and release usage should still be measured,
   but analytics should separate contributor downloads from non-contributor
   reuse before treating data reuse as a primary activation metric.
5. **Satellite-user activation**: acceptable for now as satellite map/layer
   usage. This should be revisited once satellite data becomes a clearer
   downloadable product.
6. **Audits**: internal operating process for now. Audit state may be visible to
   users, but audits are not yet the main user-facing product promise.
7. **Private and view-only datasets**: count as successful contributions when
   they provide usable model-training/reference value. They should not be
   discounted just because public reuse is restricted.
8. **Referral loop**: unresolved. Contributor attribution, DOI/citation,
   releases, partner outreach, and newsletter/contact are candidates, but the
   actual loop is not yet clear.

## Operational Factory workspace

The read-only `/factory` workspace separates daily operations from Dataset
Audit. Access requires the explicit `privileged_users.can_operate` capability;
existing auditors are not automatically promoted. This capability exposes
operational metadata across datasets, including owner email and private or
archived records, through gated RPCs. It does not grant imagery access, audit
writes or processing controls. Grant it only to trusted internal operators.

The overview puts processing operations first: complete usable results, elapsed
upload-to-result time, waiting contributors, failure recovery, and successful
input volume. Daily (28 days) and weekly (12 weeks) event-time charts show
throughput, not unequal-age upload cohort conversion. Each period links to the
same server-side event population in the explorer. Current operations remain a
separate strip; claims and database signals do not establish worker liveness.

### Measurement contract

- `factory_submissions` starts observing registrations after the migration's
  recorded epoch. A status transition to upload complete records server time and
  the original file byte count supplied by the upload API. It is after file
  storage/validation, not the last network byte. No legacy upload times are guessed.
- First readiness is immutable and follows the established whole-pipeline status
  contract: upload; ODM for ZIP; ortho, metadata, COG and thumbnail; combined or
  both legacy predictions; required AOI; idle and no error. It does not prove
  scientific quality or probe every output URL. Existing imagery authorization
  remains in force. Later reruns and enrichment never create another first result.
- Useful input throughput sums original uploaded bytes once at first readiness,
  displayed as GiB (1,073,741,824 bytes). Missing sizes stay unknown. Existing
  output sizes in MB and ZIP extracted-image totals are not substitutes.
- Latency p50/p90 is completed-upload to first readiness, including queueing,
  processing and recovery. Samples are completed submissions; the waiting count,
  affected contributors and oldest wait show the unresolved population alongside.
  Summary values cover all tracked submissions, while charts use event periods.
- A failure episode opens when an error is persisted, stays open across retry/error
  clearing, and closes only at full readiness. Internal retries without a persisted
  error are not fabricated user failures. A later regression can create another
  episode; charts count episodes, while drill-downs list distinct datasets.
- The documented 1-hour ideal/2-hour healthy target is a soft operational
  reference. The initial overdue warning applies only to measured GeoTIFF inputs
  below 1 GiB; this size cutoff is an explicit initial scope, not a learned duration
  model. ZIP and larger-input targets need calibration. No warning cancels work.
- Historical recorded outcomes deduplicate notification recipients by queue task
  and event type before time filtering. Recording depends on notification settings,
  so this is recorded activity, not complete execution or submission success.
  Embedding task mix is descriptive, not a durable rerun/enrichment intent label.
- Pre-instrumentation measured chart periods are unknown, not zero. Current or
  partly observed periods are marked partial. History includes archived datasets;
  hard deletion removes associated measurements. No production backfill is included.

Historical queue wait, execution time and stage efficiency remain unmeasured:
queue rows are removed and output/runtime records are upserted. Current claim age
is distinct from upload-to-result lead time. Notification sent state does not prove
delivery/reading, and download grants do not prove completed transfers. Audit,
publication and report evidence remains available through investigation/activity.

The explorer filters and paginates the complete dataset collection server-side.
Operators can investigate status, current queue records, output metadata, recent
logs, notifications, publications, reports and correction records. Batch
selection supports copying IDs and timestamped context for an agent task;
it carries no instruction or authorization to mutate platform state. Future
operational controls need their own authorization and execution design.

## Connected journey and observed activation

The Factory overview connects current dataset stocks to the contributor journey:
completed upload, processing, technical result, observed owner visit, repeat
contribution, and the branch through audit records to publication. AARRR supplies
the user-outcome lens. Scientific impact is an explicit adaptation of the revenue
stage; publications, reuse, referrals and financial revenue remain separate facts.
An audit record is not a quality pass, and published data is not proven reuse.

`factory_journey` provides global weekly flows and first-upload contributor
cohorts independently of the processing charts' workflow and input-size filters.
Its current pipeline counts use the same filters as the dataset explorer, exclude
archived datasets, overlap, and must not be divided into funnel conversion rates.
Weekly upload and first-result milestones count datasets; publications count
publication records. History includes archived datasets.

Owner result observations begin prospectively at `activation_started_at`.
The normal dataset details page calls `factory_record_result_view` only with
existing optional analytics consent and prediction output flags. The server
verifies the authenticated owner and complete readiness and records the first
visit once, with a server timestamp. Operator inspection of somebody else's
dataset cannot activate that contributor. This is an observed visit to a result
page, not evidence that map assets loaded or that the contributor understood them.
The private observation table is accessible only through scoped functions; deletion
of its dataset or user cascades the observation.

Observed seven-day activation is the first submission's owner visit within seven
days of that contributor's first completed upload. Its denominator includes only
elapsed seven-day windows that started after observation became available.
Missing consent or blocked telemetry makes this a lower bound, never a reliable
abandonment rate. Thirty-day repeat contribution requires another distinct
completed upload within thirty days; reruns do not count. Only elapsed thirty-day
windows enter its denominator. Contributors with known legacy uploaded datasets
are excluded from first-upload cohorts. Deleted history limits first-ever claims.
No eligible contributors produces an unavailable rate, not zero percent.

Referral attribution, completed external reuse and revenue are unavailable in this
read model. Existing analytics event names alone do not establish coverage or a
verified metric. Local QA seeds deliberately supply synthetic historical owners
and observations; deployment never reconstructs that history.

## Operator overview and attention order

The overview prioritizes current problems, waiting work and running claims.
Product-journey and contributor-cohort history are secondary to operational
investigation. It does not infer a proven system constraint from the largest
backlog or the oldest timestamp: queue, claim, failure and report clocks differ.

`factory_attention_records` owns the priority reason and its recorded timestamp.
`factory_operations` and `factory_datasets` share that definition. The explorer
accepts `sort=attention`; ordinary browsing remains newest first. Priority order:
confirmed error without an active claim, uncertain status, overdue qualifying
first-result wait, delivery problem, open report, then silent claim. Within each
reason, known oldest timestamps sort first, unknown ages last, with dataset ID
as a stable tie-breaker. Each dataset gets one primary reason while its other
status, delivery and report facts remain visible.

Failure age comes from an open measured failure episode; legacy error flags do
not establish a failure start. Uncertain age is the last status update. Overdue
age starts at measured upload completion and applies only to GeoTIFF inputs
under 1 GiB exceeding the two-hour end-to-end reference. Delivery age starts at
the oldest problem notification record, not an inferred failure transition.
Report age starts at the oldest unresolved report. Silent means no database
signal for an hour; it neither proves a stuck worker nor outranks known errors.

Waiting summaries use these same unarchived dataset populations as explorer
filters. They report oldest queue entry, oldest claim, oldest known open failure,
oldest problematic notification and oldest open report, with explicitly labelled
clocks. Groups overlap. No worker heartbeat, per-stage residence time, capacity
or queue-versus-execution history is reconstructed from mutable current state.

## Query cost and scale validation

Factory RPCs remain operator-gated. The performance migration makes private
filter SQL inlineable, applies metric predicates as set operations, and loads
rich metadata only for the selected page. Readiness is a pure inline expression;
adding a function `SET` clause would reintroduce per-row execution. Page hydration
uses a bounded lateral lookup so the planner cannot expand a 50-row page into a
full-population metadata join. Dataset pages use custom plans because an ID batch,
a substring search and a platform-wide attention sort have very different shapes.

Activity counts use narrow source counts. Each indexed source contributes at most
`offset + limit` candidates before the merged page is sorted. The indexes preserve
the existing timestamp/kind/text-ID tie ordering. Trend events are reduced to
buckets once; contributor retention joins uploads by contributor instead of
rescanning the whole materialized population once per contributor. Interactive
RPCs disable JIT locally, avoiding compilation pauses when estimated cost rises.
These settings do not change database-wide configuration or underlying RLS.

Dataset detail histories return the newest 200 records per section, with exact
`record_totals` and an explicit UI notice for truncated sections. Logs and geometry
corrections retain their existing 200-record limit and separate total fields.
Older records remain in the database for agent investigation. No geometry payloads
or raw imagery are included.

Run `scripts/qa/benchmark-factory.sh 10000` (or `50000`) after bootstrapping the
isolated stack. The runner accepts only the generated worktree-local DB endpoint,
adds synthetic users/datasets/logs/notifications in one transaction, gathers plans
and buffer counts, then rolls back. It is a manual scale check, not a production
probe or a timing-sensitive CI gate. Inserts can advance sequences and `ANALYZE`
can change local planner statistics; use only the disposable isolated QA database.

Local PostgreSQL measurements on 2026-09-22 used 10 logs and 2 notification records
per added dataset. At 10,000 datasets the original default list exceeded 45 seconds;
attention listing took 10.1 seconds. After query restructuring, measured list and
attention reads were approximately 35–38 ms, operations 40 ms, ID lookup 10 ms, and
activity 60 ms. At 50,000 datasets / 500,000 logs / 100,000 notifications, reads in
the final expanded run were 9–1,623 ms, including offset-9,000 pages, substring search,
metric filters and contributor cohorts. These are local database execution times,
not production or network latency guarantees. Permission and semantic tests run
separately; plan regressions avoid machine-dependent wall-clock assertions.

Exact totals, global aggregates, substring searches and deep offset pagination
still grow with the relevant population. This is not constant-cost analytics at
arbitrary scale. Rebenchmark against realistic cardinality/skew and concurrency
before rollout; use cursor pagination and maintained aggregate tables if measured
cost exceeds the operational budget as history grows. The browser caches reads
for 15–60 seconds and does not continuously poll; collapsed journey history is
requested only when opened.

API and database deploy independently. If PostgREST has not loaded the new input-byte column yet, upload completion retries without that optional measurement; the size remains unknown. Other schema and permission failures still propagate. Contributor cohorts display the last 26 UTC calendar weeks. Factory contributor search terms are redacted from analytics URLs.
