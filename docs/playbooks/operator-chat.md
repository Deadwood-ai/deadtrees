# Operator Chat

Use this playbook for the DeadTrees main operator thread: monitoring,
prioritisation, and handoff. The operator thread stays read-only by default and
does not implement fixes directly.

## Contract

- Run from `main`.
- Start every refresh with `git fetch origin --prune`, then
  `git status --branch`.
- If the tree is clean and behind `origin/main`, pull with `git pull --ff-only`.
- If the tree is dirty, do not pull or overwrite local changes until the changed
  files are understood.
- Prefer read-only checks. Do not mutate production, post messages, commit,
  push, or open PRs unless the user explicitly asks. Update existing Linear
  issues only when the user asks or the project's instructions allow it.
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
- [`operator-data-coverage.md`](operator-data-coverage.md) for monitoring grants,
  FreiDATA scheduler checks, and product workflow activity beyond processing.
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

### Monitoring Boundary

A platform monitor runs the micro-check unattended, every 30 minutes in
working hours and every two hours otherwise; see
[Unattended Platform Monitor](#unattended-platform-monitor). Other
agent operator threads are not continuous monitors.
Treat this playbook as the procedure for a manual refresh, a scheduled wake-up,
or an explicitly delegated check, and do not assume any other thread is running
in the background.

For backups, use two independent signals:

- freshness checks from `scripts/operator_status.py` when an operator check runs;
- backup-server email alerts from Gmail/Zulip intake when a scheduled check,
  weekly review, or incident follow-up runs.

If backup freshness has not been checked in the current operator window, report it
as skipped or stale evidence instead of inferring health from a previous agent
thread.

### Manual Status Refresh

Start a manual operator refresh with the repo-local compact status script:

```bash
python3 scripts/operator_status.py --write-state --format markdown
```

The script is the cheap infrastructure spine for the operator chat. It checks
repo state, API health, optional database aggregates, optional host/storage
probes, optional backup freshness, and writes ignored compact state to:

- `.local/operator/operator-state.json`
- `.local/operator/operator-latest.md`

Production-only checks are opt-in through local environment variables so the
tracked script contains no credentials:

- `DEADTREES_OPERATOR_DATABASE_URL` for the `psql` summary. Use the
  purpose-specific monitor login, or the analyst URI where no monitor login is
  provisioned (the platform monitor does this).
- `DEADTREES_OPERATOR_PROCESSING_HOST` for the existing primary processing host
  disk/container probe.
- `DEADTREES_OPERATOR_PROCESSING_HOSTS` for additional labeled processor targets,
  using comma-separated `label=ssh-target` entries. Keep real aliases in local
  configuration; repeated targets are probed once.
- `DEADTREES_OPERATOR_STORAGE_HOST` for storage host disk probes.
- `DEADTREES_OPERATOR_BACKUP_HOST` plus either `DEADTREES_OPERATOR_BACKUP_PATH`
  or `DEADTREES_OPERATOR_BACKUP_COMMAND` for backup freshness.
  On the Freiburg network/VPN, prefer:

  ```bash
  DEADTREES_OPERATOR_BACKUP_HOST=remote-backup@dtbackup \
    python3 scripts/operator_status.py --write-state --format markdown
  ```

After reading the script output, use connector checks for the surfaces that
cannot be reliably accessed by repo-local tooling: PostHog, Linear, Gmail, and
Zulip. Keep those checks delta-first and inspect detail only after a concrete
signal appears.

For product/factory status, run the data-factory scorecard after the platform
snapshot. It reads `DEADTREES_ANALYST_DATABASE_URL` and runs its SQL in one
read-only transaction that first verifies analyst membership and read-only mode,
so it uses only surfaces analyst access grants (no download-grant `extra`, no
JWT-scoped API views):

```bash
python3 scripts/data_factory_scorecard.py --write-state --format markdown
```

`operator_status.py` still reads `DEADTREES_OPERATOR_DATABASE_URL`. The analyst
URI may fill that slot too, as the platform monitor does. Never print either value.

For routine production SQL, use the verified transaction in
[trusted analyst access](analyst-database-access.md#routine-production-reads).
Run the aggregates in [platform status](platform-status-check.md#database-queries)
and [operator data coverage](operator-data-coverage.md#freidata-aggregates)
inside that transaction.

To inspect the scorecard SQL without connecting:

```bash
python3 scripts/data_factory_scorecard.py --print-sql
```

PostHog remains a connector-side add-on for frontend pain and funnel signals.
Print the compact PostHog SQL templates with:

```bash
python3 scripts/data_factory_scorecard.py --posthog-sql
```

### Manual Micro-Check

Use this for cheap, token-efficient monitoring. Report only deltas and
exceptions unless the user asks for detail.

1. Repo state: branch, dirty files, local/remote divergence.
2. API health: public OpenAPI route or health endpoint.
3. Database anomaly summary: aggregate dataset/status/queue/log counts.
4. Worker/server heartbeat: latest processing activity, queue age, disk pressure,
   stuck non-idle work, and exact container state/PID on every configured processor
   host. Missing host evidence remains a coverage gap.
5. Storage and backup freshness when local host probes are configured.
6. PostHog: exact counts for verified events in the check window, plus cheap
   frustration indicators such as exceptions, rage clicks, dead clicks, and
   route-level drop-off deltas.
7. Linear: recent platform issues, stale urgent triage, repeated anomaly
   fingerprints, and active blockers.
8. Gmail/Zulip: urgent delta only, using bounded search or monitored unread
   checks.

Do not inspect PostHog recordings in the operator chat by default. The operator
chat should identify candidate recording IDs or frustration clusters. Start a
worker thread for recording review only when a concrete frontend pain signal is
visible.

#### Unattended Platform Monitor

A systemd user timer on the processing server runs
`scripts/platform_monitor/monitor_tick.py` on a Europe/Berlin schedule: every
30 minutes in working hours (06:00-18:00, at `:07` and `:37`) and every two
hours at `:07` otherwise. Linear is the source of truth for platform state. The
monitor records findings and tells the coordinator about changes; it never
fixes anything. The unit templates and the host wrapper are in
`scripts/platform_monitor/systemd/`.

The wrapper runs the monitor from a detached `~/dev/deadtrees-monitor` clone at
`origin/main` with the Python of `~/dev/deadtrees/venv`
(`DEADTREES_MONITOR_CHECKOUT` and `DEADTREES_MONITOR_PYTHON` override both). It
writes the status snapshot to `~/dev/deadtrees/.local/operator/state.json` and
`latest.md` (the scorecard to `scorecard-state.json` and `scorecard-latest.md`),
not to the `operator-*` defaults of a manual run.

Each tick:

1. Collects read-only facts at no token cost: `scripts/operator_status.py`
   (API, database, every processor host in `DEADTREES_OPERATOR_PROCESSING_HOSTS`,
   storage, backups), `scripts/data_factory_scorecard.py`, and
   `scripts/platform_monitor/host_facts.py` (production deploy health, kernel OOM
   kills in the prod processor's cgroup, the local GPU, worker liveness from the
   queue, the public frontend).
2. Turns them into fingerprinted findings (`dt-status/<surface>/<key>`) in
   `scripts/platform_monitor/findings.py`, which owns the rules: container not
   running, restarts, OOM, disks above 85 percent (helicon `/` above 97 percent
   is red), stale backups, deploy pause, refusal, dirty checkout or a drain
   older than 12 hours, a processor that has trailed main for more than 12
   hours, a worker silent for over 3 hours (yellow instead of red while the
   processing server's ODM container for that dataset still runs), a failed GPU
   check and frontend errors. A failed probe, a frontend error or a disk over the line counts only
   on two runs in a row and clears after two quiet runs. A check that cannot run is a coverage gap, never green.
3. Runs a read-only model call (`claude-haiku-5-5`) for what
   needs Janusch in Linear, Gmail and Zulip (Zulip is read by the script) and
   for new PostHog frontend errors in project 13440, which it selects first because the
   connector's active project is shared. Its window advances only when Linear,
   Gmail and Zulip were all read; PostHog errors are tracked separately by ID.
4. Files the delta (new, changed, cleared) and new or spiking PostHog errors in
   Linear with a second model call: one 🤖 Triage issue per fingerprint, then
   comments on it. PostHog errors share one issue per ISO week. The baseline advances only after filing succeeded, so a
   failed tick retries.
5. Writes the digest to `~/.local/state/deadtrees-monitor/digest-latest.md`
   (two days under `digests/`) and one line per tick to `ticks.jsonl`. When
   something changed or failed (a filed or cleared finding, an inbox item for
   Janusch, a new coverage gap, a failed tick), it also writes the digest as a
   note to `outbox/`.

The model calls use the processing server's own Claude login
(`~/.claude/.credentials.json`). When it expires, the journal shows `OAuth session
expired`, the inbox read and Linear filing stop, and the digest only shows a
`[gap]` line while the verdict stays as it was (28 Oct 2026, 05:07-09:07 UTC).
Only Janusch can sign in again (`claude` on the host); the next tick then
catches up, because the inbox window and the baseline advance only after
success.

A relay session in the Deadtrees project, running on the processing server,
waits for notes in `~/.local/state/deadtrees-monitor/outbox/` (for example a
background shell loop that ends when a `*.md` file appears, re-armed every two
hours). It forwards each note, oldest first, with `send_message` to `@parent`,
which always reaches the current coordinator, then deletes it. A quiet tick
writes no note, so the relay wakes only for changes.

A model result counts only when the session's own tool calls prove the reads
or writes; a call that stops early gets up to four attempts in total (efforts
low, low, high, high). The tick runs `claude -p` with `MCP_CONNECTION_NONBLOCKING=false`
so the claude.ai connectors are loaded first, parses stdout only, and prices
Haiku 5.5 from its list price because Claude Code overstates it.

Setup rules:

- The wrapper runs the scripts from a clean, detached worktree of `origin/main`
  that each tick refreshes first. Never run them from a developer checkout that
  may be dirty or behind.
- Keep the DB login in a protected local env file (mode 600) outside the repo,
  holding the analyst role in both `DEADTREES_ANALYST_DATABASE_URL` and
  `DEADTREES_OPERATOR_DATABASE_URL`. Non-secret settings (SSH aliases, the
  shadow model) go in a second local env file. Never print or copy the login.
- Read the production checkout, never write to it.
- For a comparison, `DEADTREES_MONITOR_SHADOW_MODEL` and
  `DEADTREES_MONITOR_SHADOW_UNTIL` rerun the inbox call read-only on a second
  model in the first tick of each hour and log both results to `shadow.jsonl`.
- `monitor_tick.py --dry-run` makes only the read-only call and writes no state
  and no Linear change.

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

- `.local/operator/operator-state.json`
- `.local/operator/operator-latest.md`

Store only:

- last check time and window
- last seen Gmail and Zulip IDs/cursors
- relevant Linear issue IDs
- PostHog event-count baselines
- compact infrastructure snapshot from `scripts/operator_status.py`
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

Keep these read-only unless the user or the project's instructions allow Linear updates.

- Triage issues older than the threshold used in the report.
- Urgent or high-priority issues without owner, next action, or recent update.
- Repeated bot fingerprints without a consolidated RCA or owner.
- `Todo` or `Backlog` buckets that are too large or stale to guide work.
- `In Progress` issues with no activity for 7 days, or without an assignee
  (see the [claim rule](../agents/rules.md#linear)).
- `In Review` issues without an open PR.
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

For Zulip, prefer monitored unread checks for scheduled deltas. Add a
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
