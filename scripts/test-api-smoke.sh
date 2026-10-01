#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

if [[ ! -f .env ]]; then
	cp .env.example .env
fi

if [[ -z "${COMPOSE_PROJECT_NAME:-}" ]]; then
	compose_project_name="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env | tail -n 1)"
	compose_project_name="${compose_project_name%\"}"
	compose_project_name="${compose_project_name#\"}"
	compose_project_name="${compose_project_name%\'}"
	compose_project_name="${compose_project_name#\'}"
	export COMPOSE_PROJECT_NAME="${compose_project_name:-deadtrees-test}"
else
	export COMPOSE_PROJECT_NAME
fi

mkdir -p \
	data/archive \
	data/cogs \
	data/thumbnails \
	data/label_objects \
	data/downloads \
	data/raw_images \
	data/trash

if command -v deadtrees >/dev/null 2>&1; then
	DEADTREES_CLI=(deadtrees)
elif [[ -x venv/bin/deadtrees ]]; then
	DEADTREES_CLI=(venv/bin/deadtrees)
else
	echo "Could not find the deadtrees CLI. Install it or create the repo venv first." >&2
	exit 1
fi

"${DEADTREES_CLI[@]}" dev test api api/tests/test_settings.py

# Run whole directories so every new test file is covered automatically.
# Heavy tests opt out with the slow/comprehensive markers (see pytest.ini),
# not by being left off a list.
docker compose -f docker-compose.test.yaml exec -T api-test \
	python -m pytest -v api/tests shared/tests
