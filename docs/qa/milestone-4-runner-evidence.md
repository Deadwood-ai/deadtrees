# Milestone 4: Runner Evidence

Date: 2026-06-16

## Scope

This evidence records the first local QA runner for
`docs/qa/local-agent-qa-plan.md`.

## Implemented Artifacts

- `scripts/qa/run-agent-qa.sh`
- `scripts/qa/report.sh`

The runner prepares local QA execution artifacts. It does not launch Codex
subagents from the shell. It generates worker prompts that the main Codex
operator can hand to subagents.

## Runner Responsibilities Covered

- Loads the isolated env from `DEADTREES_ISOLATED_ENV_FILE` or
  `.local/supabase/current.env`.
- Runs `scripts/qa/lint-playbooks.sh`.
- For non-dry runs, verifies required tools, seeds the requested fixture
  profile, and checks readiness for:
  - Supabase Auth
  - local API
  - frontend
- Selects all playbooks or one or more `--playbook` IDs.
- Filters playbooks by persona, browser, mutation level, or fixture pack.
- Splits playbooks across `--parallel` workers.
- Writes:
  - `manifest.json`
  - `env-summary.json`
  - `worker-XX.prompt.md`
  - `worker-XX.result.md`
  - worker artifact directories
- `report.md`
- Aggregates worker result files back into `report.md`.

## Dry Run Check

```bash
scripts/qa/run-agent-qa.sh --profile qa-full --parallel 4 --dry-run
```

Generated run directory:

```text
.local/qa-runs/20260616T201008Z
```

Manifest summary:

```text
profile=qa-full
dry_run=true
playbook_count=12
worker_count=4
```

The runner split all 12 playbooks across 4 worker prompts.

## Non-Dry Smoke

With the isolated stack and frontend running:

```bash
scripts/qa/run-agent-qa.sh \
  --profile qa-full \
  --parallel 2 \
  --playbook public-home-discovery
```

Generated run directory:

```text
.local/qa-runs/20260616T201051Z
```

The non-dry run:

- reseeded `qa-full`,
- passed `scripts/qa/check-fixtures.sql`,
- verified frontend/API/Supabase readiness,
- generated one worker prompt for `public-home-discovery`.

Environment summary:

```text
frontend=http://127.0.0.1:57073
api=http://localhost:57080/api/v1
supabase=http://127.0.0.1:57021
mailpit=http://127.0.0.1:57024
compose_project=deadtrees-test-7f37
compose_network=deadwood_network_7f37
```

## Remaining Runner Work

- Add browser-tool comparison output.
- Add direct callable subagent orchestration only if the Codex surface exposes a
  stable tool for it.

## Full Parallel Package Check

```bash
scripts/qa/run-agent-qa.sh \
  --profile qa-full \
  --parallel 4 \
  --run-dir .local/qa-runs/parallel-pilot-001
```

Generated a non-dry run package with all 12 playbooks split across 4 workers.
The run reseeded `qa-full`, passed fixture verification, checked Supabase/API/
frontend readiness, and wrote a pending report to:

```text
.local/qa-runs/parallel-pilot-001/report.md
```

## Filter And Report Checks

```bash
scripts/qa/run-agent-qa.sh \
  --profile qa-full \
  --parallel 3 \
  --dry-run \
  --mutation-level read-only \
  --run-dir .local/qa-runs/validation-readonly
```

Generated 5 read-only playbooks across 3 workers.

```bash
scripts/qa/run-agent-qa.sh \
  --profile qa-full \
  --parallel 2 \
  --dry-run \
  --persona auditor \
  --run-dir .local/qa-runs/validation-auditor
```

Generated 4 auditor-related playbooks across 2 workers.

```bash
scripts/qa/report.sh .local/qa-runs/validation-readonly
```

Regenerated `report.md` with a status summary and pending playbook statuses.
