#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

if [[ ! -f .env ]]; then
	cp .env.example .env
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

api_smoke_tests=(
	api/tests/routers/test_contributor_contract_smoke.py
	api/tests/routers/test_upload_odm_detection.py
	api/tests/routers/test_process.py
	api/tests/routers/test_prepackaged.py
	api/tests/routers/test_dte_stats.py
	api/tests/routers/test_download.py::test_download_status_invalid_dataset_id_returns_400
	api/tests/routers/test_download.py::TestMultiBundleHelpers
	api/tests/db/test_auditor_flag_review_contract.py
	api/tests/db/test_dataset_rls_policy.py
	api/tests/db/test_privileged_users.py
	api/tests/db/test_dataset_audit.py
	api/tests/db/test_dataset_edit_history.py
	api/tests/db/test_data_publication.py
	api/tests/test_notifications.py
)

docker compose -f docker-compose.test.yaml exec -T api-test \
	python -m pytest -v "${api_smoke_tests[@]}"
