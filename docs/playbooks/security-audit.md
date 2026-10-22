# Security audit

Continuous security checks for this repository (DT-1442). Server patching is a separate plan (DT-1438).

## What runs

| What | Where | When |
|---|---|---|
| CodeQL, secret scanning with push protection, Dependabot alerts and security updates | GitHub repository settings | every PR, push and weekly |
| Dependabot version updates | `.github/dependabot.yml` | weekly |
| `security-audit` workflow | `.github/workflows/security-audit.yml` | daily 03:17 UTC, PRs that change dependency files, by hand |
| Claude cloud routine | scheduled Claude session | weekdays 07:30 Berlin, full pass on Tuesdays |

The workflow runs:

- **pip-audit** on each Python requirements file after resolving it with `uv pip compile` for Python 3.12 on linux x86_64. Most requirements are unpinned, so this audits what a rebuild today would install, which can differ from the running containers.
- **npm audit** on `frontend/package-lock.json`.
- **zizmor** on `.github/workflows`. These findings are listed only and never turn the run red.
- **Trivy** on the pinned GDAL base image (OS packages, high and critical). This is skipped on PRs.
- **CISA KEV:** the catalog of known exploited vulnerabilities is cross-checked against every finding above. In scheduled runs it is also checked against `[[stack]]` in `scripts/security_stack.toml`, which covers the software the scans can't see (kernel, nginx, Kong, Postgres, Docker and so on).

`scripts/security_audit.py` turns the scanner JSON into the run summary.

## When the run is red

A run is red when something needs a decision:

- a finding is on the CISA KEV list, even if it is accepted
- a Python advisory is not accepted in `scripts/security_stack.toml`
- an npm high or critical advisory is not accepted
- an accepted risk is past its `review_by` date
- in scheduled runs: a KEV entry for our stack was added in the last 7 days (each such entry stays red for 7 days)

A scan that failed or is missing makes the run fail as `INCOMPLETE`. Unknown is not a pass.

Read the run summary, or the "Summarize" step log, which has the same Markdown.

## Accepting a risk

Accepting a risk is a security decision, so Janusch decides it. Add an `[[accepted]]` entry to `scripts/security_stack.toml` with:

- `reason`
- a Linear `issue`
- a `review_by` date
- either `ids` (advisory, CVE or GHSA ids) or `version` (every advisory for that exact package version, for held packages like torch)

## Claude routine

Findings go to Linear Triage, unassigned, after a duplicate search.

**Weekdays:** the routine reads the latest `security-audit` run and stops unless it is red or incomplete.

**Tuesdays:**
- builds one Dependabot bundle PR (patch, minor, and security fixes inside the current major)
- closes superseded Dependabot PRs
- checks CodeQL results on open PRs
- runs a web check for new disclosures on the stack list
- comments a weekly summary on DT-1442

**Needs Janusch:** merges, majors, held packages, server or production work, settings, credentials and dismissing alerts.

## Reuse in other repositories

The workflow and `scripts/security_audit.py` don't depend on anything specific to this repository. To reuse them, copy:

1. both files
2. the test `scripts/tests/test_security_audit.py`
3. a `security_stack.toml` with that project's stack

Then adjust the `audit` lines and the `FROM` lookup in the workflow.
