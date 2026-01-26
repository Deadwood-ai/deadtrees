#!/bin/bash
#
# Cron wrapper for daily platform summary - CONTAINER VERSION
# 
# This script runs the daily summary inside the api container via docker exec.
# All dependencies are already installed in the container.
#
# Cron setup (run at 8:00 AM CET on weekdays on HOST):
# For CET (UTC+1 in winter, UTC+2 in summer), use 7:00 UTC in winter:
# 0 7 * * 1-5 /path/to/scripts/cron_daily_summary.sh >> /data/logs/daily_summary.log 2>&1

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOG_DIR="/data/logs"
CONTAINER_NAME="api"  # API container name
COMPOSE_FILE="${PROJECT_ROOT}/docker-compose.api.yaml"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Log with timestamp
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

log "Starting daily platform summary..."

# Check if container is running
if ! docker compose -f "$COMPOSE_FILE" ps "$CONTAINER_NAME" 2>/dev/null | grep -q "Up"; then
    log "ERROR: Container $CONTAINER_NAME is not running!"
    exit 1
fi

# Run the daily summary script inside container
docker compose -f "$COMPOSE_FILE" exec -T "$CONTAINER_NAME" \
    python /app/api/src/automation/daily_summary.py

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    log "Daily summary completed successfully"
else
    log "Daily summary failed with exit code $EXIT_CODE"
fi

exit $EXIT_CODE
