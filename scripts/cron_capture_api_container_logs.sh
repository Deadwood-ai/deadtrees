#!/usr/bin/env bash
#
# Incrementally capture API container stdout/stderr logs to /data/logs so they
# are visible on the mounted storage path.
#
# Suggested crontab (every 3 minutes):
#   */3 * * * * /apps/deadtrees/scripts/cron_capture_api_container_logs.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${PROJECT_ROOT}/docker-compose.api.yaml"
CONTAINER_NAME="${CONTAINER_NAME:-api}"

LOG_DIR="${LOG_DIR:-/data/logs}"
CAPTURE_LOG_FILE="${CAPTURE_LOG_FILE:-$LOG_DIR/api_container_capture.log}"
API_LOG_FILE="${API_LOG_FILE:-$LOG_DIR/api_container.log}"
STATE_FILE="${STATE_FILE:-$LOG_DIR/.api_container_logs_since}"
LOCKFILE="${LOCKFILE:-/tmp/api_container_logs.lock}"

mkdir -p "$LOG_DIR"
exec >>"$CAPTURE_LOG_FILE" 2>&1

log() {
	echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

exec 200>"$LOCKFILE"
if ! flock -n 200; then
	log "Skipping: previous API log capture still active."
	exit 0
fi

if ! docker compose -f "$COMPOSE_FILE" ps "$CONTAINER_NAME" 2>/dev/null | grep -q "Up"; then
	log "ERROR: Container $CONTAINER_NAME is not running."
	exit 1
fi

if [ -f "$STATE_FILE" ]; then
	SINCE="$(tr -d '\n' < "$STATE_FILE")"
else
	SINCE="$(date -u -d '5 minutes ago' +'%Y-%m-%dT%H:%M:%SZ')"
fi

if [ -z "$SINCE" ]; then
	SINCE="$(date -u -d '5 minutes ago' +'%Y-%m-%dT%H:%M:%SZ')"
fi

NOW="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
TMP_LOGS="$(mktemp)"

if docker compose -f "$COMPOSE_FILE" logs --no-color --timestamps --since "$SINCE" "$CONTAINER_NAME" > "$TMP_LOGS"; then
	if [ -s "$TMP_LOGS" ]; then
		log "Appending API container logs since $SINCE"
		cat "$TMP_LOGS" >> "$API_LOG_FILE"
		log "Wrote $(wc -l < "$TMP_LOGS") log line(s) to $API_LOG_FILE"
	else
		log "No new API container logs since $SINCE"
	fi

	echo "$NOW" > "$STATE_FILE"
else
	log "ERROR: Failed to fetch logs from container $CONTAINER_NAME"
	rm -f "$TMP_LOGS"
	exit 1
fi

rm -f "$TMP_LOGS"
log "Capture run complete (until $NOW)"
