# Daily Two-Lane Agent QA

Use this workflow for broad, exploratory regression checks that complement unit
and E2E tests. It deliberately separates real deployment evidence from all
write-capable journeys.

## Boundary

| Lane | Target | Allowed | Forbidden |
| --- | --- | --- | --- |
| Production read-only | `https://deadtrees.earth` | Navigation, queries, client-only controls, sign-in/out, cancelled forms, monitoring reads | Domain-data creation, edits, uploads, jobs, audits, reports, password resets, subscriptions, PRIWA writes, cleanup writes |
| Local write | Per-worktree app, Supabase, API, storage, and Mailpit | All seeded user journeys and destructive experimentation | Any production endpoint or credential |

“Read-only production” describes application state. Authentication may create
and revoke a session, but the lane must not change domain data. Never test a
production mutation and then delete it: cleanup can fail, triggers and analytics
remain, and side effects may already have escaped.

## Run

```bash
bash scripts/setup-worktree.sh --skip-assets

RUN_DIR=".local/qa-runs/daily-$(date -u '+%Y%m%dT%H%M%SZ')"
scripts/qa/run-daily-qa.sh prepare --visible-browser --run-dir "$RUN_DIR"

# An agent executes these generated packages with the built-in Browser:
#   $RUN_DIR/production-readonly.prompt.md
#   $RUN_DIR/local-write/worker-*.prompt.md
# Each result is written beside its prompt.

scripts/qa/run-daily-qa.sh test-local --run-dir "$RUN_DIR"
scripts/qa/run-daily-qa.sh finish --run-dir "$RUN_DIR"
```

`prepare` starts, resets, and validates the isolated stack before it creates
write-capable prompts. `test-local` runs the contributor, auditor, and PRIWA
write suites sequentially and keeps bounded logs. `finish` always aggregates
the report and stops the local environment.

`--visible-browser` marks both generated manual lanes as operator-visible. The
agent uses the bundled in-app Browser directly, brings it to the foreground
before the first route, and keeps it visible through navigation, form entry,
and cancellation. The user can watch the current URL and interactions in the
Browser panel while terminal tests run separately. Omit the flag for unattended
recurring runs.

`prepare` cannot launch a Codex agent from the shell. It starts and validates
the local environment and generates the two Browser prompt packages. After it
finishes, ask the current Codex task to execute the printed production and local
prompt paths. Browser movement begins when Codex executes those prompts, not
while the shell is preparing them.

Live viewing does not weaken the lane boundary: production remains read-only,
and all write-capable actions still target only the isolated local stack.

## Browser-Only Skill Mode

For a Codex run where every UI interaction must use the bundled Browser, prepare
with:

```bash
scripts/qa/run-daily-qa.sh prepare --browser-only --run-dir "$RUN_DIR"
```

`--browser-only` implies visible Browser execution and one manual worker. It
marks the Playwright write suites as skipped, removes Browser Use/Chrome/
terminal-Playwright fallbacks from generated worker prompts, and reserves shell
commands for setup, reset, isolation validation, non-browser diagnostics,
reporting, and teardown. Execute all generated playbooks through the in-app
Browser before calling `finish`.

Do not call `test-local` for a browser-only run; the coordinator rejects that
combination so another browser engine cannot be introduced accidentally.

For package-only validation:

```bash
scripts/qa/run-daily-qa.sh prepare --dry-run --run-dir .local/qa-runs/daily-dry-run
```

## Evidence And Scheduling

Every run has a top-level `manifest.json` and `report.md`, separate production
and local result files, deterministic E2E logs, and isolation validation output.
These artifacts are intentionally local and may be retained by an external
scheduler.

A recurring Codex task can run this workflow daily. The recurring task should
execute the generated Browser prompts, record monitoring observations, finish
the run even after failures, and create or reopen tracker issues only when that
separate external write is explicitly authorized. Shell cron alone can run the
deterministic tests, but it cannot replace the agent exploration step.

## Stop Conditions

- The production origin is not exactly `https://deadtrees.earth`.
- A production step would submit a domain mutation.
- Any local app, API, database, or Supabase URL is not loopback.
- Test identity cannot be verified after authentication.
- Credentials or personal data would enter an artifact.
- A run cannot be safely torn down; stop new writes and recover the isolated
  environment before continuing.
