# Operator Chat

Use this playbook for the DeadTrees main operator thread: monitoring,
prioritisation, and handoff. The operator thread stays read-only by default and
does not implement fixes directly.

## Contract

- Run from `main`.
- Start with `git status --branch`.
- If the tree is clean and behind `origin/main`, pull with `git pull --ff-only`.
- If the tree is dirty, do not pull or overwrite local changes until the changed
  files are understood.
- Prefer read-only checks. Do not mutate production, post messages, update
  Linear, commit, push, or open PRs unless the user explicitly asks.
- Create Linear issues or start worker threads only after a concrete signal:
  failing platform check, repeated anomaly, user request, security alert,
  stale project-management item, or missing owner for important work.
- Keep implementation work out of this thread. Start a fresh thread/worktree
  from a compact handoff when code or production changes are needed.

## Source Docs

Local source of truth:

- [`platform-status-check.md`](platform-status-check.md) for DB, API, storage,
  processing, backups, PostHog, and Zulip platform health.
- [`dataset-debugging.md`](dataset-debugging.md) for dataset-specific failures.
- [`../analytics/deadtrees-data-factory.md`](../analytics/deadtrees-data-factory.md)
  for the product operating model.
- [`../analytics/aarrr-framework.md`](../analytics/aarrr-framework.md) for the
  current PostHog event map and dashboard IDs.
- [`../create-linear-issue.md`](../create-linear-issue.md) and
  [`../agents/rules.md`](../agents/rules.md) for Linear conventions.

3Dtrees operator references may be useful when available, but are not tracked in
this repo at the time this playbook was added:

- `linear-triage-workflow.md`
- `upload-anomaly-linear-bot.md`

## Cadence

### Hourly Micro-Check

Use this for cheap, token-efficient monitoring. Report only deltas and
exceptions unless the user asks for detail.

1. Repo state: branch, dirty files, local/remote divergence.
2. API health: public OpenAPI route or health endpoint.
3. Deployed version: deployed SHA or container image tag when cheaply available.
4. Database anomaly summary: aggregate dataset/status/queue/log counts.
5. Worker heartbeat: latest processing activity, queue age, stuck non-idle work.
6. PostHog: exact counts for verified events in the check window.
7. Linear: recent platform issues, stale urgent triage, repeated anomaly
   fingerprints, and active blockers.
8. Gmail/Zulip: urgent delta only, using bounded search or monitored unread
   checks.

### Daily Full Check

Run the normal 24-36 hour platform status playbook from
[`platform-status-check.md`](platform-status-check.md). Add host disk/container,
backup/export freshness, and frontend smoke checks when symptoms or recent
changes make them relevant.

### Weekly Operator Review

Produce a broader operating review:

- data-factory throughput and current product constraint
- Linear drift and project priority alignment
- docs drift or missing runbook coverage
- recurring support themes from Gmail/Zulip/Linear
- candidate issues and candidate worker threads

## Token-Efficient State

Use local ignored state for cursors and compact summaries. Recommended paths:

- `.codex/private/operator-chat-state.json`
- `.codex/private/operator-latest.md`

Store only:

- last check time and window
- last seen Gmail and Zulip IDs/cursors
- relevant Linear issue IDs
- PostHog event-count baselines
- last verdict and top risks

Do not store secrets, raw logs, bearer tokens, database URLs, complete email
bodies, large PostHog payloads, or full message history.

## Data-Factory Health Model

Use [`../analytics/deadtrees-data-factory.md`](../analytics/deadtrees-data-factory.md)
as the product source of truth.

- Acquisition: homepage, map, archive, waitlist/contact, and sign-up intent.
- Activation: upload started/completed, processing completed, and the owner
  opens the processed result.
- Trust: metadata quality, processing reliability, viewer availability, audit
  state, and reference/correction progress.
- Impact: views, downloads, release/reuse signals, citation/publication signals,
  and partner follow-up.

Important caveat: current PostHog events are incomplete. Missing events are an
instrumentation gap until corroborated by DB/API/user-facing evidence; do not
treat missing analytics events alone as proof that the product is broken.

## Linear Drift Checks

Keep these read-only unless asked to update Linear.

- Triage issues older than the threshold used in the report.
- Urgent or high-priority issues without owner, next action, or recent update.
- Repeated bot fingerprints without a consolidated RCA or owner.
- `Todo` or `Backlog` buckets that are too large or stale to guide work.
- `In Progress` issues without recent activity.
- Merged PRs whose linked issues are not `Done`.
- Issues no longer aligned with the current data-factory bottleneck.

Before creating a new issue, search Linear for similar dataset IDs, error
fingerprints, user-visible symptoms, and Zulip/email context. Agent-created
issues start in `Triage`, stay unassigned unless the user decides otherwise, and
use labels such as `Bug`, `Improvement`, `Needs RCA`, and
`Needs User Notification` when appropriate.

## Gmail And Zulip Intake

Start count-first and inspect only likely actionable messages.

Suggested Gmail terms:

```text
3Dtrees OR 3dtrees.earth OR DeadTrees OR deadtrees.earth OR dataset OR upload OR Galaxy OR download OR access OR error OR bug OR processing
```

Use Gmail search filters such as:

```text
newer_than:7d -in:spam -in:trash -category:promotions -category:social
```

For Zulip, prefer monitored unread checks for hourly deltas. Add a
recent-history pass after downtime or when project context matters, because
unread-only checks can miss active project discussion.

Do not post to Zulip, send email, or mark messages read as a side effect unless
the user explicitly asks.

## Handoff Protocol

Every operator report should be compact:

- verdict: `green`, `yellow`, or `red`
- product constraint: the current weakest data-factory step
- top risks: no more than three
- candidate issues: with evidence and suggested labels
- candidate worker threads: with exact handoff context
- skipped or blocked surfaces

When starting a worker thread, pass only the minimum useful handoff:

- issue or signal URL/ID
- exact user-visible symptom
- relevant dataset IDs or fingerprints
- evidence checked and evidence still missing
- safe validation path
- production mutation boundary
