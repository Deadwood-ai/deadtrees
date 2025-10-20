#!/bin/bash
#
# Cron wrapper for reference patches export - CONTAINER VERSION
# 
# This script runs the export inside the api container via docker exec.
# All dependencies are already installed in the container.
#
# Cron setup (run every minute on HOST):
# * * * * * /path/to/scripts/cron_export_reference_patches_docker.sh >> /data/logs/reference_export.log 2>&1

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOG_DIR="/data/logs"
CONTAINER_NAME="api"  # Change to your API container name
COMPOSE_FILE="${PROJECT_ROOT}/docker-compose.api.yaml"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Log with timestamp
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

# Check if container is running
if ! docker compose -f "$COMPOSE_FILE" ps "$CONTAINER_NAME" | grep -q "Up"; then
    log "ERROR: Container $CONTAINER_NAME is not running!"
    exit 1
fi

log "Starting reference patches export (container: $CONTAINER_NAME)..."

# Run export script inside container
# Environment variables are loaded from container's environment
docker compose -f "$COMPOSE_FILE" exec -T "$CONTAINER_NAME" \
    python /app/api/src/export/export_reference_patches.py

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    log "Export completed successfully"
else
    log "Export failed with exit code $EXIT_CODE"
fi

exit $EXIT_CODE

