#!/usr/bin/env bash
# FreiData cron runner — source env, activate venv, run one cron tick.
#
# Uses flock to guarantee only ONE instance runs at a time.
# If a previous run is still going (e.g. large upload), the new invocation
# exits immediately instead of duplicating work.
#
# Add to crontab (e.g. every 15 minutes):
#   */15 * * * * /path/to/deadtrees/scripts/freidata_cron.sh >> /var/log/freidata_cron.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCKFILE="/tmp/freidata_cron.lock"

# flock -n: non-blocking — exit immediately if lock is held by another instance
exec 200>"$LOCKFILE"
if ! flock -n 200; then
	echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Skipping: previous cron run still active."
	exit 0
fi

# Source environment
if [ -f "$REPO_ROOT/freidata/freidata.env" ]; then
	set -a
	source "$REPO_ROOT/freidata/freidata.env"
	set +a
fi

# Activate venv if present
if [ -f "$REPO_ROOT/freidata/.venv/bin/activate" ]; then
	source "$REPO_ROOT/freidata/.venv/bin/activate"
fi

cd "$REPO_ROOT"
python -m freidata.cron
