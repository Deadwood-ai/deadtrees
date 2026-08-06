#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCK_DIR="${REPO_DIR}/.local/locks"
LOCK_FILE="${LOCK_DIR}/processor-runtime.lock"
ACTIVATED_SHA_FILE="${REPO_DIR}/.local/processor-activated-sha"
LOG_FILE="${REPO_DIR}/processor-maintenance.log"
STATUS_SCRIPT="${REPO_DIR}/scripts/processor_runtime_control.py"
COMPOSE_FILE="${REPO_DIR}/docker-compose.processor.yaml"
HOLD_DURATION="${PROCESSOR_SNAP_HOLD_DURATION:-168h}"
SNAP_CONTROL="${PROCESSOR_SNAP_CONTROL:-/usr/local/sbin/deadtrees-processor-snap-control}"
DRAIN_TIMEOUT_SECONDS="${PROCESSOR_DRAIN_TIMEOUT_SECONDS:-43200}"
DRAIN_POLL_SECONDS="${PROCESSOR_DRAIN_POLL_SECONDS:-15}"
RENEW_HOLD_ONLY=0
STARTUP_TIMEOUT_SECONDS="${PROCESSOR_STARTUP_TIMEOUT_SECONDS:-300}"
READINESS_POLL_SECONDS="${PROCESSOR_READINESS_POLL_SECONDS:-5}"
UNAVAILABLE_CONFIRMATIONS="${PROCESSOR_UNAVAILABLE_CONFIRMATIONS:-3}"
UNAVAILABLE_POLL_SECONDS="${PROCESSOR_UNAVAILABLE_POLL_SECONDS:-5}"

while [ "$#" -gt 0 ]; do
	case "$1" in
		--renew-hold-only)
			RENEW_HOLD_ONLY=1
			shift
			;;
		--hold-duration)
			HOLD_DURATION="$2"
			shift 2
			;;
		*)
			echo "Unknown argument: $1" >&2
			exit 2
			;;
	esac
done

mkdir -p "${LOCK_DIR}"
if [ ! -e "${LOCK_FILE}" ]; then
	(umask 000; : > "${LOCK_FILE}")
fi
touch "${LOG_FILE}"

log() {
	printf '%s: %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >> "${LOG_FILE}"
}

require_clean_checkout() {
	local dirty
	dirty="$(
		git status --porcelain --untracked-files=all -- \
			. \
			':(exclude).local/locks' \
			':(exclude)auto-deploy.log' \
			':(exclude)processor-maintenance.log'
	)"
	if [ -n "${dirty}" ]; then
		log "Refusing Docker maintenance from dirty checkout: ${dirty//$'\n'/'; '}"
		exit 1
	fi
}

require_activated_checkout() {
	local head_sha
	activated_sha="$(cat "${ACTIVATED_SHA_FILE}" 2>/dev/null || true)"
	head_sha="$(git rev-parse HEAD)"
	if [ -z "${activated_sha}" ] || [ "${activated_sha}" != "${head_sha}" ]; then
		log "Refusing Docker maintenance because HEAD ${head_sha} does not match activated SHA ${activated_sha:-missing}"
		exit 1
	fi
}

source "${SCRIPT_DIR}/lib/processor_runtime.sh"

exec 9<>"${LOCK_FILE}"
if ! flock -n 9; then
	log "Skipping Docker maintenance because another processor runtime operation already holds ${LOCK_FILE}"
	exit 0
fi

drain_set=0
on_exit() {
	local rc=$?
	trap - EXIT
	cleanup_processor_runtime_waiter
	if [ "${rc}" -ne 0 ] && [ "${drain_set}" -eq 1 ]; then
		log "Docker maintenance failed; drain request remains in place for operator review"
	fi
	exit "${rc}"
}
trap on_exit EXIT

cd "${REPO_DIR}"

sudo -n "${SNAP_CONTROL}" hold "${HOLD_DURATION}" >> "${LOG_FILE}" 2>&1
log "Renewed Docker snap hold for ${HOLD_DURATION}"

if [ "${RENEW_HOLD_ONLY}" -eq 1 ]; then
	exit 0
fi

require_clean_checkout
require_activated_checkout

python3 "${STATUS_SCRIPT}" set-drain --reason "docker-maintenance" >> "${LOG_FILE}" 2>&1
drain_set=1
wait_for_drain_with_recovery

docker compose -f "${COMPOSE_FILE}" stop processor >> "${LOG_FILE}" 2>&1
sudo -n "${SNAP_CONTROL}" refresh >> "${LOG_FILE}" 2>&1
sudo -n "${SNAP_CONTROL}" hold "${HOLD_DURATION}" >> "${LOG_FILE}" 2>&1
require_clean_checkout
python3 "${STATUS_SCRIPT}" clear-ack >> "${LOG_FILE}" 2>&1
PROCESSOR_RELEASE_SHA="${activated_sha}" docker compose -f "${COMPOSE_FILE}" up -d processor >> "${LOG_FILE}" 2>&1
python3 "${STATUS_SCRIPT}" wait-for-idle \
	--expected-release-sha "${activated_sha}" \
	--timeout-seconds "${STARTUP_TIMEOUT_SECONDS}" \
	--poll-seconds "${READINESS_POLL_SECONDS}" >> "${LOG_FILE}" 2>&1
wait_for_processor_running
inspect_processor_runtime
python3 "${STATUS_SCRIPT}" record-worker-id >> "${LOG_FILE}" 2>&1

python3 "${STATUS_SCRIPT}" clear-drain >> "${LOG_FILE}" 2>&1
drain_set=0

log "Docker maintenance complete"
