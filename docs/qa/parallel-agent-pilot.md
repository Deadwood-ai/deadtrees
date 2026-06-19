# Parallel Agent Pilot Guide

This guide describes how to execute a generated DeadTrees local QA run with
multiple Codex agents.

The runner does not currently launch agents itself. It prepares deterministic
worker prompt files, result stubs, and artifact directories. The operator or a
Codex multi-agent tool then starts one agent per worker prompt and aggregates
the completed result files.

## Prerequisites

- Isolated Supabase stack is running.
- Local API/nginx and Mailpit are running.
- Frontend is running with the isolated env.
- `qa-full` can be seeded locally.

Typical setup:

```bash
scripts/dev/isolated-supabase.sh start
set -a
source "$(scripts/dev/isolated-supabase.sh env)"
set +a
venv/bin/deadtrees dev start --services=api-test,nginx,mailpit
npm --prefix frontend run dev:local
```

## Generate A Run

```bash
scripts/qa/run-agent-qa.sh \
  --profile qa-full \
  --parallel 4 \
  --run-dir .local/qa-runs/parallel-pilot-001
```

This creates:

```text
.local/qa-runs/parallel-pilot-001/
  manifest.json
  env-summary.json
  worker-01.prompt.md
  worker-01.result.md
  worker-01/
  worker-02.prompt.md
  worker-02.result.md
  worker-02/
  worker-03.prompt.md
  worker-03.result.md
  worker-03/
  worker-04.prompt.md
  worker-04.result.md
  worker-04/
  report.md
```

## Execute Workers

Start one agent per prompt file. Give each agent only its prompt file plus the
normal repo context.

Recommended assignment:

| Agent | Prompt |
| --- | --- |
| Agent 1 | `.local/qa-runs/parallel-pilot-001/worker-01.prompt.md` |
| Agent 2 | `.local/qa-runs/parallel-pilot-001/worker-02.prompt.md` |
| Agent 3 | `.local/qa-runs/parallel-pilot-001/worker-03.prompt.md` |
| Agent 4 | `.local/qa-runs/parallel-pilot-001/worker-04.prompt.md` |

Each worker must write its final status into the matching
`worker-XX.result.md` file and store raw artifacts only under its
`worker-XX/` directory.

## Aggregate Results

After workers finish:

```bash
scripts/qa/report.sh .local/qa-runs/parallel-pilot-001
```

The report summarizes:

- pass/fail/blocked/needs-human-review counts,
- status per worker result file,
- status per playbook,
- next actions.

## Current Limitation

The runner itself does not call Codex subagents. This keeps the run package
portable across Codex surfaces and makes the worker prompts reviewable before
execution.

When a stable subagent launch tool is exposed, wire it into
`scripts/qa/run-agent-qa.sh` as an optional mode that consumes the existing
`manifest.json` and worker prompt files. Keep prompt-file execution as the
fallback because it works across Codex surfaces.

## Chrome QA Agent Lane

For the standard engineering workflow, prefer a single Chrome QA worker using
`gpt-5.5` with low reasoning while repo-native tests run in parallel. Generate
that worker prompt with the Chrome browser surface and the realistic fixture
pack:

```bash
scripts/qa/run-agent-qa.sh \
  --profile qa-realistic \
  --parallel 1 \
  --agent-browser-surface chrome \
  --agent-model "gpt-5.5 low" \
  --focus "Current feature under test: <short feature/risk summary>" \
  --run-dir .local/qa-runs/chrome-feature-qa-001
```

Launch one sub-agent from `worker-01.prompt.md`, explicitly selecting
`gpt-5.5` with low reasoning and the Chrome plugin. The prompt intentionally
contains the exact Chrome bootstrap path and upload filechooser recipe. Treat
silent fallback to terminal Playwright, standalone Chromium, or the in-app
Browser as a QA-runner failure.

Recommended feature workflow:

1. Start the local isolated stack and seed `qa-realistic`.
2. Start the repo-native checks for the changed surface, for example
   `npm --prefix frontend run test:e2e:local`.
3. In parallel, run the Chrome QA worker from the generated prompt.
4. Aggregate results with `scripts/qa/report.sh <run-dir>`.
5. Classify concurrency issues separately from product failures: shared auth,
   audit locks, DB row mutation, port contention, browser-profile state, and
   production URL leakage.

The local E2E suite can complete quickly enough that the Chrome QA worker may
not observe sustained overlap. When the goal is to prove concurrency rather
than just exercise both lanes in the same run, use a longer native test target
or record explicit start/finish timestamps for both commands in the run
artifact.

Use Chrome same-profile multi-tab checks for read-only journeys. Keep
local-write playbooks serial unless their resource locks are disjoint and the
prompt explicitly allows the mutation.
