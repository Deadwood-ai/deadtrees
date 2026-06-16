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
