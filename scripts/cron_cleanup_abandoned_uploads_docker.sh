#!/bin/bash
#
# Cron wrapper: delete abandoned chunk-upload bytes (<upload_id>.tmp) inside the
# API container. See docs/playbooks/upload-retry-contract.md for the expiry
# contract and api/src/upload/abandoned_uploads.py for the rules.
#
# Suggested crontab on the storage/API host (daily at 03:30):
#   30 3 * * * /apps/deadtrees/scripts/cron_cleanup_abandoned_uploads_docker.sh
#
# Preview first with: DRY_RUN=1 scripts/cron_cleanup_abandoned_uploads_docker.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${PROJECT_ROOT}/docker-compose.api.yaml"
CONTAINER_NAME="${CONTAINER_NAME:-api}"
LOG_DIR="${LOG_DIR:-/data/logs}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/abandoned_uploads_cleanup.log}"
MAX_AGE_DAYS="${UPLOAD_TMP_RETENTION_DAYS:-7}"

mkdir -p "$LOG_DIR"
exec >>"$LOG_FILE" 2>&1

log() {
	echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

if ! docker compose -f "$COMPOSE_FILE" ps "$CONTAINER_NAME" | grep -q "Up"; then
	log "ERROR: Container $CONTAINER_NAME is not running!"
	exit 1
fi

ARGS=(--max-age-days "$MAX_AGE_DAYS")
if [ -n "${DRY_RUN:-}" ]; then
	ARGS+=(--dry-run)
fi

log "Starting abandoned upload cleanup (max age ${MAX_AGE_DAYS} days)..."
if docker compose -f "$COMPOSE_FILE" exec -T "$CONTAINER_NAME" \
	python /app/api/src/upload/abandoned_uploads.py "${ARGS[@]}"; then
	log "Abandoned upload cleanup completed"
else
	EXIT_CODE=$?
	log "Abandoned upload cleanup failed with exit code $EXIT_CODE"
	exit $EXIT_CODE
fi
