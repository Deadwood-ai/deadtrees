# Milestone 3: Playbook Library Evidence

Date: 2026-06-16

## Scope

This evidence records the first agent-followable QA playbook library for
`docs/qa/local-agent-qa-plan.md`.

## Implemented Artifacts

- `docs/qa/playbooks/TEMPLATE.md`
- `docs/qa/playbooks/README.md`
- `scripts/qa/lint-playbooks.sh`

Initial playbooks:

- `public-home-discovery`
- `public-archive-detail-download`
- `public-releases-publications`
- `auth-shell`
- `contributor-upload-process`
- `contributor-profile-datasets`
- `auditor-access-guards`
- `auditor-queue-triage`
- `auditor-final-assessment`
- `labels-corrections-map`
- `priwa-field-workflow`
- `negative-empty-error-states`

## Metadata Contract

Each playbook declares:

- `id`
- `persona`
- `fixture_packs`
- `browser`
- `parallel_safe`
- `mutation_level`
- `routes`

Each playbook includes these required execution sections:

- `Purpose`
- `Preconditions`
- `Steps`
- `Expected Observations`
- `Failure Signals`
- `Evidence To Capture`

## Checks Passed

```bash
scripts/qa/lint-playbooks.sh
```

Result:

```text
Checked 12 playbooks.
```

## Notes

Some playbooks intentionally mark future fixture gaps as
`needs-human-review`, especially `qa-labels`, `qa-priwa`, `qa-publication`, and
`qa-negative`. The journeys are still useful now because they make missing
fixture coverage explicit and give the next milestones concrete targets.
