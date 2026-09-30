---
name: run-deadtrees-qa
description: Run DeadTrees manual QA with production read-only checks and a verified isolated local write environment.
---

# DeadTrees manual QA

Manual QA has two lanes: read-only checks against production and write-capable
journeys against a verified isolated local stack. Follow the root `AGENTS.md`,
[environment and access](../../../docs/agents/environment-and-access.md), the
[QA playbook index](../../../docs/qa/playbooks/README.md) and only the playbooks
needed for the requested journeys.

The runner is `scripts/qa/run-agent-qa.sh`; inspect `--help` before choosing its
filters. It prepares prompts and result files, not live agents. Use one worker
(`--parallel 1`) by default and execute its prompts in this task. Parallel agents
or a different browser need the task's authorization. The runner's model hint
does not change the current task's model.

Use the built-in Browser for UI actions and keep the journey visible. Discover
the active browser API from the runtime instead of copying old bootstrap
snippets. Where no built-in Browser exists (for example a Claude thread on the
processing server), use headless Playwright Chromium from
`frontend/node_modules/playwright` through `--agent-browser-surface playwright`
and say so in the report. If no browser surface is available, report that
journey as blocked rather than silently switching tools.

## Production lane

Use the [frontend browser regression playbook](../../../docs/playbooks/frontend-browser-regression.md).
Production checks are read-only for domain data: do not upload, audit, enqueue
downloads, publish, reset passwords or create data for later cleanup. Local-write
playbooks are never production probes. Analytics and issue searches may support a
finding but do not authorize issue changes or messages.

## Local write lane

Bootstrap, start, reset and validate the per-worktree stack with the commands in
the root `AGENTS.md`. Verify loopback URLs and the seeded identity before each
write-capable journey. Run the runner with `--agent-browser-surface browser` and
the relevant `--playbook`, `--persona` or `--mutation-level` filters, then read
the generated prompts and write their contracted result files. Keep browser
evidence focused and exclude secrets and personal data from artifacts.

Aggregate results with `scripts/qa/report.sh <run-dir>`. Stop the isolated
services started for this run with `scripts/qa/env.sh down`, including after a
setup or journey failure, and verify the cleanup.

## Local review lane

Local review of a change that affects the app runs the regression gate:

```bash
scripts/qa/review-regression.sh --keep-up --focus "<what the change adds or changes>"
```

It starts and validates the isolated stack, runs every local Playwright suite
(read and local-write) headless, and writes agent QA prompts to
`<run-dir>/agent-qa`. A failing suite blocks the review until it is fixed or
shown to be unrelated. Report every test the summary lists as flaky. On a busy
Docker host (the processing server) most flakes carry `net::ERR_NETWORK_CHANGED`
in their trace: Chromium drops in-flight requests when containers add or remove
network interfaces. A flake without that error needs a look. Then execute the generated prompt with the Playwright
surface: the playbooks for the areas the change touches, the whole set for
cross-cutting changes, and the feature focus for new behavior. A new
user-facing feature also needs a durable spec in `frontend/e2e-local/`, or its
own playbook in `docs/qa/playbooks/`, so later reviews cover it. Finish with
`scripts/qa/report.sh <run-dir>/agent-qa` and `scripts/qa/env.sh down`.

## Report

Report production and local coverage separately, with observed defects, evidence
paths, unavailable checks and cleanup status. Do not claim a full two-lane pass
when only selected playbooks or a dry run were completed.
