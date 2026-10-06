#!/bin/bash
#
# Run the one-time duplicate cleanup inside the API container. Use it on the
# storage/API host, from the production checkout, one step at a time:
#
#   /apps/deadtrees/scripts/existing_duplicates_docker.sh backfill-zips
#   /apps/deadtrees/scripts/existing_duplicates_docker.sh plan
#   /apps/deadtrees/scripts/existing_duplicates_docker.sh notify
#   /apps/deadtrees/scripts/existing_duplicates_docker.sh notify --send
#
# Nothing here changes the database: backfill-zips and plan print SQL to review
# and run, and keep it in /data/.duplicate-cleanup/. See
# api/src/upload/existing_duplicates.py for what each step does.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${PROJECT_ROOT}/docker-compose.api.yaml"
CONTAINER_NAME="${CONTAINER_NAME:-api}"

case "${1:-}" in
	backfill-zips | plan | notify) ;;
	*)
		echo "Usage: $0 backfill-zips | plan | notify [--send]" >&2
		exit 2
		;;
esac

if ! docker compose -f "$COMPOSE_FILE" ps "$CONTAINER_NAME" | grep -q "Up"; then
	echo "ERROR: Container $CONTAINER_NAME is not running" >&2
	exit 1
fi

exec docker compose -f "$COMPOSE_FILE" exec -T "$CONTAINER_NAME" \
	python /app/api/src/upload/existing_duplicates.py "$@"
