# Milestone 6: Parallel Agent Pilot Evidence

Date: 2026-06-16

## Scope

This evidence records the first full parallel QA run package for
`docs/qa/local-agent-qa-plan.md`.

## Implemented Artifact

- `docs/qa/parallel-agent-pilot.md`

## Parallel Run Package

With the isolated Supabase stack, local API/nginx, Mailpit, and frontend
running, generated a non-dry parallel run:

```bash
scripts/qa/run-agent-qa.sh \
  --profile qa-full \
  --parallel 4 \
  --run-dir .local/qa-runs/parallel-pilot-001
```

The run:

- reseeded `qa-full`,
- passed `scripts/qa/check-fixtures.sql`,
- verified Supabase Auth, local API, and frontend readiness,
- split all 12 playbooks across 4 worker prompts,
- generated worker result stubs and artifact directories,
- generated `.local/qa-runs/parallel-pilot-001/report.md`.

Report summary before worker execution:

```text
profile=qa-full
dry_run=false
playbooks=12
workers=4
pending=12
```

## Worker Distribution

| Worker | Playbooks |
| --- | --- |
| `worker-01` | `auditor-access-guards`, `contributor-profile-datasets`, `priwa-field-workflow` |
| `worker-02` | `auditor-final-assessment`, `contributor-upload-process`, `public-archive-detail-download` |
| `worker-03` | `auditor-queue-triage`, `labels-corrections-map`, `public-home-discovery` |
| `worker-04` | `auth-shell`, `negative-empty-error-states`, `public-releases-publications` |

## Subagent Execution Status

Executed the four generated worker prompts with Codex worker agents against the
same isolated local stack.

Aggregated report:

```text
.local/qa-runs/parallel-pilot-001/report.md
```

Final status summary:

```text
pass=3
fail=2
blocked=2
needs-human-review=5
pending=0
```

Playbook statuses:

| Playbook | Status |
| --- | --- |
| `auditor-access-guards` | `pass` |
| `contributor-profile-datasets` | `pass` |
| `public-home-discovery` | `pass` |
| `auth-shell` | `fail` |
| `negative-empty-error-states` | `fail` |
| `auditor-final-assessment` | `blocked` |
| `contributor-upload-process` | `blocked` |
| `auditor-queue-triage` | `needs-human-review` |
| `labels-corrections-map` | `needs-human-review` |
| `priwa-field-workflow` | `needs-human-review` |
| `public-archive-detail-download` | `needs-human-review` |
| `public-releases-publications` | `needs-human-review` |

## Findings

- Password reset in the isolated stack did not deliver mail to Mailpit.
- Dataset `91004` rendered a download section and complete-dataset action even
  though the fixture represents an incomplete/error processing state.
- Archive/detail download stayed on local endpoints, but the seeded archive
  file `/data/archive/qa-public-complete.tif` was missing.
- `qa-priwa`, `qa-labels`, and `qa-publication` need deeper deterministic
  fixture rows before their playbooks can be strict pass/fail checks.
- The audit queue processing count showed `0` while fixture `91004` has
  `has_error=true`, which needs product or fixture clarification.
- Browser file upload through the agent surface could not attach the GeoTIFF
  fixture; that playbook likely needs Playwright-backed file upload support or
  a documented fallback.

## Remaining Work

- Convert any failures or `needs-human-review` results into focused follow-up
  issues.
- Decide whether direct subagent launching belongs inside the runner or should
  remain an operator-level action around generated worker prompts.
