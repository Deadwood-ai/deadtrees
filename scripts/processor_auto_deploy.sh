#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCK_DIR="${REPO_DIR}/.local/locks"
LOCK_FILE="${LOCK_DIR}/processor-runtime.lock"
ACTIVATED_SHA_FILE="${REPO_DIR}/.local/processor-activated-sha"
PAUSE_FILE="${REPO_DIR}/.local/processor-deploy-paused"
LOG_FILE="${REPO_DIR}/auto-deploy.log"
STATUS_SCRIPT="${REPO_DIR}/scripts/processor_runtime_control.py"
COMPOSE_FILE="${REPO_DIR}/docker-compose.processor.yaml"
BRANCH="${PROCESSOR_DEPLOY_BRANCH:-main}"
DRAIN_TIMEOUT_SECONDS="${PROCESSOR_DRAIN_TIMEOUT_SECONDS:-43200}"
DRAIN_POLL_SECONDS="${PROCESSOR_DRAIN_POLL_SECONDS:-15}"
STARTUP_TIMEOUT_SECONDS="${PROCESSOR_STARTUP_TIMEOUT_SECONDS:-300}"
READINESS_POLL_SECONDS="${PROCESSOR_READINESS_POLL_SECONDS:-5}"
UNAVAILABLE_CONFIRMATIONS="${PROCESSOR_UNAVAILABLE_CONFIRMATIONS:-3}"
UNAVAILABLE_POLL_SECONDS="${PROCESSOR_UNAVAILABLE_POLL_SECONDS:-5}"
RESUME_DEPLOY=0

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--resume" ]; }; then
	echo "Usage: processor_auto_deploy.sh [--resume]" >&2
	exit 2
fi
if [ "${1:-}" = "--resume" ]; then
	RESUME_DEPLOY=1
fi

mkdir -p "${LOCK_DIR}"
if [ ! -e "${LOCK_FILE}" ]; then
	(umask 000; : > "${LOCK_FILE}")
fi
touch "${LOG_FILE}"

log() {
	printf '%s: %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >> "${LOG_FILE}"
}

require_head_is_ancestor_of_remote() {
	local remote_ref="$1"
	if ! git merge-base --is-ancestor HEAD "${remote_ref}"; then
		log "Refusing deploy because HEAD contains local commits outside ${remote_ref}"
		exit 1
	fi
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
		log "Refusing deploy from dirty checkout: ${dirty//$'\n'/'; '}"
		exit 1
	fi
}

source "${SCRIPT_DIR}/lib/processor_runtime.sh"

exec 9<>"${LOCK_FILE}"
if ! flock -n 9; then
	log "Skipping deploy check because another processor runtime operation already holds ${LOCK_FILE}"
	exit 0
fi

drain_set=0
on_exit() {
	local rc=$?
	trap - EXIT
	cleanup_processor_runtime_waiter
	if [ "${rc}" -ne 0 ] && [ "${drain_set}" -eq 1 ]; then
		printf 'failed_at=%s head=%s target=%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
			"$(git rev-parse HEAD 2>/dev/null || printf unknown)" "${remote_sha:-unknown}" > "${PAUSE_FILE}.tmp"
		mv "${PAUSE_FILE}.tmp" "${PAUSE_FILE}"
		log "Deployment failed; drain remains set and automatic deploy is paused. Fix the target release, then run ./scripts/processor_auto_deploy.sh --resume"
	fi
	exit "${rc}"
}
trap on_exit EXIT

cd "${REPO_DIR}"

if [ "${RESUME_DEPLOY}" -eq 1 ]; then
	if [ -e "${PAUSE_FILE}" ]; then
		rm "${PAUSE_FILE}"
		log "Automatic processor deploy resumed; the next cron run will retry while preserving the existing drain"
	else
		log "Automatic processor deploy was not paused"
	fi
	exit 0
fi

if [ -e "${PAUSE_FILE}" ]; then
	log "Skipping deploy because automatic processor deploy is paused; inspect ${PAUSE_FILE}"
	exit 0
fi

require_clean_checkout

git fetch origin "${BRANCH}" >> "${LOG_FILE}" 2>&1
require_head_is_ancestor_of_remote "origin/${BRANCH}"

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/${BRANCH}")"
activated_sha="$(cat "${ACTIVATED_SHA_FILE}" 2>/dev/null || true)"

if [ "${local_sha}" = "${remote_sha}" ] && [ "${activated_sha}" = "${remote_sha}" ]; then
	log "No changes"
	exit 0
fi

log "Preparing deploy from ${local_sha} to ${remote_sha}"

python3 "${STATUS_SCRIPT}" set-drain --reason "auto-deploy ${remote_sha}" >> "${LOG_FILE}" 2>&1
drain_set=1
wait_for_drain_with_recovery

git merge --ff-only "${remote_sha}" >> "${LOG_FILE}" 2>&1
deployed_sha="$(git rev-parse HEAD)"
if [ "${deployed_sha}" != "${remote_sha}" ]; then
	log "Refusing deploy because HEAD (${deployed_sha}) does not match fetched ${remote_sha}"
	exit 1
fi
require_clean_checkout
docker compose -f "${COMPOSE_FILE}" build processor tcd >> "${LOG_FILE}" 2>&1
python3 "${STATUS_SCRIPT}" clear-ack >> "${LOG_FILE}" 2>&1
docker compose -f "${COMPOSE_FILE}" up -d --force-recreate processor >> "${LOG_FILE}" 2>&1
python3 "${STATUS_SCRIPT}" wait-for-idle \
	--timeout-seconds "${STARTUP_TIMEOUT_SECONDS}" \
	--poll-seconds "${READINESS_POLL_SECONDS}" >> "${LOG_FILE}" 2>&1
wait_for_processor_running
inspect_processor_runtime
python3 "${STATUS_SCRIPT}" record-worker-id >> "${LOG_FILE}" 2>&1

python3 "${STATUS_SCRIPT}" clear-drain >> "${LOG_FILE}" 2>&1
drain_set=0

printf '%s\n' "${deployed_sha}" > "${ACTIVATED_SHA_FILE}.tmp"
mv "${ACTIVATED_SHA_FILE}.tmp" "${ACTIVATED_SHA_FILE}"

log "Deployment complete ($(git rev-parse --short HEAD))"
