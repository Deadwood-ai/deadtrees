# Local Agent QA Playbooks

These playbooks are structured journeys for Codex/browser agents. They are not
Playwright tests. Use them after starting an isolated local stack and seeding
the required fixture packs.

## Common Setup

```bash
scripts/dev/isolated-supabase.sh start
set -a
source "$(scripts/dev/isolated-supabase.sh env)"
set +a
venv/bin/deadtrees dev start --services=api-test,nginx,mailpit
scripts/qa/seed.sh qa-full
npm --prefix frontend run dev:local -- --host 127.0.0.1
```

Use [fixtures.md](../fixtures.md) for deterministic personas, passwords, and
dataset IDs.

## Execution Rules

- Default to the built-in Browser for local app checks.
- Treat Browser Use CLI as conditional: require current probe evidence that the
  selected backend renders the real app before using it for QA conclusions.
- Keep evidence under `.local/qa-runs/<timestamp>/<playbook-id>/`.
- Capture focused evidence: URL, locator state, console errors, and a single
  screenshot only when visual evidence is needed.
- Do not paste full DOM snapshots, full page text, large logs, or screenshots
  into chat.
- Treat production URLs, production data, or production credentials as a stop
  condition.

## Playbook Index

| ID | Persona | Mutation | Fixture Packs | Main Routes |
| --- | --- | --- | --- | --- |
| `public-home-discovery` | anonymous | read-only | `qa-base` | `/`, `/dataset`, `/deadtrees`, `/releases` |
| `public-archive-detail-download` | anonymous | local-write | `qa-base` | `/dataset`, `/dataset/91001` |
| `public-releases-publications` | anonymous | read-only | `qa-base`, `qa-publication` | `/releases`, `/releases/:slug` |
| `auth-shell` | anonymous/contributor | local-write | `qa-auth` | `/sign-in`, `/sign-up`, `/forgot-password`, `/profile` |
| `contributor-upload-process` | contributor | local-write | `qa-contributor` | `/profile` |
| `contributor-profile-datasets` | contributor | read-only | `qa-base`, `qa-contributor` | `/profile`, `/dataset/91003`, `/dataset/91004` |
| `auditor-access-guards` | anonymous/contributor/auditor | read-only | `qa-auth`, `qa-auditor` | `/dataset-audit`, `/dataset-audit/91001` |
| `auditor-queue-triage` | auditor | local-write | `qa-auditor` | `/dataset-audit` |
| `auditor-final-assessment` | auditor | local-write | `qa-auditor` | `/dataset-audit/91001` |
| `labels-corrections-map` | contributor/auditor | local-write | `qa-labels` | `/dataset-label/91001`, `/dataset-corrections/91001` |
| `priwa-field-workflow` | authenticated field user | local-write | `qa-priwa` | `/priwa-field` |
| `negative-empty-error-states` | mixed | read-only | `qa-negative`, `qa-base` | `/dataset/999999`, `/dataset/91004`, `/dataset-audit` |
