# Milestone 5: Browser Tool Evidence

Date: 2026-06-16

## Scope

This evidence records the first browser-tool decision pass for
`docs/qa/local-agent-qa-plan.md`.

## Implemented Artifact

- `docs/qa/browser-tool-decision.md`

## In-App Browser Pilot

Prepared a targeted non-dry QA run:

```bash
scripts/qa/run-agent-qa.sh \
  --profile qa-full \
  --parallel 1 \
  --playbook public-home-discovery \
  --run-dir .local/qa-runs/browser-public-home
```

Executed `public-home-discovery` using the built-in Browser.

Result artifact:

```text
.local/qa-runs/browser-public-home/report.md
```

Report summary:

```text
pass=1
fail=0
blocked=0
needs-human-review=0
pending=0
```

Route checks:

- `/` -> `home-page` visible once
- `/dataset` -> `dataset-archive-page` visible once
- `/deadtrees` -> `deadtrees-map-page` visible once
- `/releases` -> `releases-page` visible once

## Chrome Probe

The available browser backend list exposed only the in-app Browser. Chrome was
not available as a controllable backend in this session, so a Chrome execution
pass could not be completed here.

## Computer Use Assessment

Computer Use was reviewed as a fallback surface. It remains useful for
screen-level interactions, but it is not the default because the QA playbooks
need structured locator/console/API evidence.

## Decision

Default local QA browser surface: built-in Browser.

Fallback order:

1. Chrome, only for real Chrome profile/session/extension state.
2. Computer Use, only for interactions that cannot be driven through Browser.
