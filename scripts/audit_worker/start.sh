#!/usr/bin/env bash
# Start or restart the audit worker as a user service (deadtrees-audit-worker.service) on its own
# code copy, brought to the newest main first (DT-1489, DT-1619). Switching check versions on
# stays an operator's step (docs/audit-checks.md).
#
#   start.sh [ids file]   also queues these datasets in the manual queue for both checks
#
# Once per server, in $DIR: a clone of the repository in code/, a venv with
# processor/requirements.txt in venv/, and worker.env with the settings the processor uses on
# this host (ENV, DEV_MODE, STORAGE_SERVER_IP, STORAGE_SERVER_USERNAME, PROCESSOR_USERNAME,
# SSH_PRIVATE_KEY_PATH, SSH_KNOWN_HOSTS_PATH, and a PATH with the claude and codex binaries).
# The secrets come from the production checkout's .env, linked into the code copy.
set -euo pipefail
DIR=${DEADTREES_AUDIT_WORKER_DIR:-$HOME/.local/share/deadtrees-audit-worker}
PROD=${DEADTREES_PROD_CHECKOUT:-$HOME/prod/deadtrees}
CODE=$DIR/code
UNIT=deadtrees-audit-worker

git -C "$CODE" fetch --quiet origin main
if [ -n "$(git -C "$CODE" status --porcelain)" ]; then
	echo "The code copy $CODE has local changes; not touching it." >&2
	exit 1
fi
git -C "$CODE" merge --quiet --ff-only origin/main
[ -e "$CODE/.env" ] || ln -s "$PROD/.env" "$CODE/.env"
echo "Code: $(git -C "$CODE" log --oneline -1 | cut -c1-70)"

mkdir -p "$HOME/.config/systemd/user"
install -m 644 "$CODE/scripts/audit_worker/$UNIT.service" "$HOME/.config/systemd/user/$UNIT.service"
systemctl --user daemon-reload
systemctl --user enable --quiet "$UNIT"
systemctl --user restart "$UNIT"
echo "Worker started: systemctl --user status $UNIT, journalctl --user -u $UNIT"

if [ $# -gt 0 ]; then
	cd "$CODE"
	set -a
	. "$DIR/worker.env"
	set +a
	for check in dataset_evaluation prediction_quality; do
		"$DIR/venv/bin/python" -m processor.src.audit_worker enqueue --check "$check" --queue manual --file "$1"
	done
fi
