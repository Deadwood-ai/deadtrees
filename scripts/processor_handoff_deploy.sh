#!/usr/bin/env bash
# Release handoff deploy for a processor host with room for two workers.
#
# processor_auto_deploy.sh drains the host's only worker before each release, so
# one long ODM task holds the release, and the host's share of the queue, for
# hours. Here releases alternate between worker slots a and b (see
# scripts/lib/processor_runtime.sh). A new release starts in the idle slot and
# takes the next task at once. The previous slot is drained, finishes its task
# on its own image, and a later run removes it. While both run, the new slot
# skips PROCESSOR_HANDOFF_TASK_BLACKLIST (ODM by default) and is capped at
# PROCESSOR_HANDOFF_MEMORY_LIMIT, so the two releases fit on the host together.
#
# Cron runs either this script or processor_auto_deploy.sh on a host, never both.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCK_DIR="${REPO_DIR}/.local/locks"
LOCK_FILE="${LOCK_DIR}/processor-runtime.lock"
ACTIVATED_SHA_FILE="${REPO_DIR}/.local/processor-activated-sha"
PAUSE_FILE="${REPO_DIR}/.local/processor-deploy-paused"
LOG_FILE="${REPO_DIR}/auto-deploy.log"
STATUS_SCRIPT="${REPO_DIR}/scripts/processor_runtime_control.py"
ASSET_PREFLIGHT_SCRIPT="${REPO_DIR}/scripts/processor_asset_preflight.py"
COMPOSE_FILE="${REPO_DIR}/docker-compose.processor.yaml"
BRANCH="${PROCESSOR_DEPLOY_BRANCH:-main}"
STARTUP_TIMEOUT_SECONDS="${PROCESSOR_STARTUP_TIMEOUT_SECONDS:-300}"
READINESS_POLL_SECONDS="${PROCESSOR_READINESS_POLL_SECONDS:-5}"
UNAVAILABLE_CONFIRMATIONS="${PROCESSOR_UNAVAILABLE_CONFIRMATIONS:-3}"
UNAVAILABLE_POLL_SECONDS="${PROCESSOR_UNAVAILABLE_POLL_SECONDS:-5}"
HANDOFF_TASK_BLACKLIST="${PROCESSOR_HANDOFF_TASK_BLACKLIST:-odm_processing}"

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--resume" ] && [ "$1" != "--status" ]; }; then
	echo "Usage: processor_handoff_deploy.sh [--resume|--status]" >&2
	exit 2
fi

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
		log "Refusing deploy from dirty checkout: ${dirty//$'\n'/'; '}"
		exit 1
	fi
}

# The shell environment wins over .env, as it does for Compose interpolation.
env_setting() {
	local name="$1"
	local default="$2"
	local from_file
	from_file="$(sed -n "s/^${name}=//p" "${REPO_DIR}/.env" 2>/dev/null | tail -n 1 | tr -d "\"'")"
	printf '%s\n' "${!name:-${from_file:-${default}}}"
}

source "${SCRIPT_DIR}/lib/processor_runtime.sh"

FULL_MEMORY_LIMIT="$(env_setting PROCESSOR_MEMORY_LIMIT 96G)"
HANDOFF_MEMORY_LIMIT="$(env_setting PROCESSOR_HANDOFF_MEMORY_LIMIT '')"

slot_container_id() {
	processor_compose ps -a -q processor 2>/dev/null || true
}

slot_drain_requested() {
	[ -e "${REPO_DIR}/${PROCESSOR_CONTROL_DIR:-.local/processor-control}/drain-request.json" ]
}

print_status() {
	local slot
	printf 'active slot: %s\nactivated release: %s\n' "$(processor_active_slot)" "$(cat "${ACTIVATED_SHA_FILE}" 2>/dev/null || printf none)"
	for slot in a b; do
		use_processor_slot "${slot}"
		printf '\n== slot %s (worker %s) ==\n' "${slot}" "$(python3 "${STATUS_SCRIPT}" worker-id)"
		docker inspect "$(slot_container_id)" \
			--format '{{.Name}} {{.State.Status}} release={{range .Config.Env}}{{if eq (index (split . "=") 0) "PROCESSOR_RELEASE_SHA"}}{{index (split . "=") 1}}{{end}}{{end}} memory={{.HostConfig.Memory}}' \
			2>/dev/null || printf 'no container\n'
		python3 "${STATUS_SCRIPT}" status || true
	done
}

# Remove a drained slot once its worker holds no task, then give the remaining
# slot back the full memory budget and every task type.
retire_slot_if_idle() {
	local slot="$1"
	local remaining_slot
	local container_id
	local wait_rc=0

	use_processor_slot "${slot}"
	if [ -z "$(slot_container_id)" ]; then
		return 0
	fi
	if ! slot_drain_requested; then
		log "Slot ${slot} runs without a drain request although slot $(processor_active_slot) is active; leaving it for an operator"
		return 0
	fi
	python3 "${STATUS_SCRIPT}" wait-for-idle --timeout-seconds 1 --poll-seconds 1 > /dev/null 2>&1 || wait_rc=$?
	if [ "${wait_rc}" -ne 0 ]; then
		return 0
	fi

	processor_compose rm --stop --force processor >> "${LOG_FILE}" 2>&1
	python3 "${STATUS_SCRIPT}" clear-drain >> "${LOG_FILE}" 2>&1
	log "Retired slot ${slot}; its worker finished its last task"

	remaining_slot="$(processor_other_slot "${slot}")"
	use_processor_slot "${remaining_slot}"
	python3 "${STATUS_SCRIPT}" clear-claim-limits >> "${LOG_FILE}" 2>&1
	container_id="$(slot_container_id)"
	if [ -n "${container_id}" ]; then
		docker update --memory "${FULL_MEMORY_LIMIT}" --memory-swap "${FULL_MEMORY_LIMIT}" "${container_id}" >> "${LOG_FILE}" 2>&1
		log "Slot ${remaining_slot} may now claim every task type with ${FULL_MEMORY_LIMIT} memory"
	fi
}

if [ "${1:-}" = "--status" ]; then
	cd "${REPO_DIR}"
	print_status
	exit 0
fi

exec 9<>"${LOCK_FILE}"
if ! flock -n 9; then
	log "Skipping deploy check because another processor runtime operation already holds ${LOCK_FILE}"
	exit 0
fi

new_slot_started=0
switched=0
on_exit() {
	local rc=$?
	trap - EXIT
	cleanup_processor_runtime_waiter
	if [ "${rc}" -eq 0 ]; then
		exit 0
	fi
	if [ "${new_slot_started}" -eq 1 ] && [ "${switched}" -eq 0 ]; then
		# The previous release never stopped claiming, so removing the new slot
		# leaves the host exactly as it was before this run.
		use_processor_slot "${new_slot}"
		processor_compose rm --stop --force processor >> "${LOG_FILE}" 2>&1 || true
		python3 "${STATUS_SCRIPT}" clear-drain >> "${LOG_FILE}" 2>&1 || true
		python3 "${STATUS_SCRIPT}" clear-claim-limits >> "${LOG_FILE}" 2>&1 || true
	fi
	if [ "${new_slot_started}" -eq 1 ] || [ "${switched}" -eq 1 ]; then
		printf 'failed_at=%s head=%s target=%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
			"$(git rev-parse HEAD 2>/dev/null || printf unknown)" "${remote_sha:-unknown}" > "${PAUSE_FILE}.tmp"
		mv "${PAUSE_FILE}.tmp" "${PAUSE_FILE}"
		log "Handoff to ${remote_sha:-unknown} failed; automatic deploy is paused. Fix the target release, then run ./scripts/processor_handoff_deploy.sh --resume"
	fi
	exit "${rc}"
}
trap on_exit EXIT

cd "${REPO_DIR}"

if [ "${1:-}" = "--resume" ]; then
	if [ -e "${PAUSE_FILE}" ]; then
		rm "${PAUSE_FILE}"
		log "Automatic processor deploy resumed"
	else
		log "Automatic processor deploy was not paused"
	fi
	exit 0
fi

if [ -e "${PAUSE_FILE}" ]; then
	log "Skipping deploy because automatic processor deploy is paused; inspect ${PAUSE_FILE}"
	exit 0
fi

active_slot="$(processor_active_slot)"
new_slot="$(processor_other_slot "${active_slot}")"
retire_slot_if_idle "${new_slot}"

require_clean_checkout
git fetch origin "${BRANCH}" >> "${LOG_FILE}" 2>&1
if ! git merge-base --is-ancestor HEAD "origin/${BRANCH}"; then
	log "Refusing deploy because HEAD contains local commits outside origin/${BRANCH}"
	exit 1
fi

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/${BRANCH}")"
activated_sha="$(cat "${ACTIVATED_SHA_FILE}" 2>/dev/null || true)"
if [ "${local_sha}" = "${remote_sha}" ] && [ "${activated_sha}" = "${remote_sha}" ]; then
	log "No changes"
	exit 0
fi

use_processor_slot "${new_slot}"
if [ -n "$(slot_container_id)" ]; then
	log "Release ${remote_sha} waits: slot ${new_slot} is still finishing a task on the previous release"
	exit 0
fi
use_processor_slot "${active_slot}"
if slot_drain_requested; then
	log "Skipping handoff to ${remote_sha} because slot ${active_slot} has a drain request; clear it or use processor_runtime_control.py"
	exit 0
fi
active_container_id="$(slot_container_id)"
if [ -n "${active_container_id}" ] && [ -n "$(docker inspect "${active_container_id}" --format '{{range .Mounts}}{{if eq .Destination "/app/processor"}}bind{{end}}{{end}}' 2>/dev/null)" ]; then
	log "Refusing handoff because slot ${active_slot} still bind-mounts its code; deploy once with processor_auto_deploy.sh first"
	exit 1
fi
if [ -z "${HANDOFF_MEMORY_LIMIT}" ]; then
	log "Refusing handoff because PROCESSOR_HANDOFF_MEMORY_LIMIT is not set in .env"
	exit 1
fi

log "Handing off from slot ${active_slot} (${activated_sha:-none}) to slot ${new_slot} (${remote_sha})"
git merge --ff-only "${remote_sha}" >> "${LOG_FILE}" 2>&1
require_clean_checkout
if ! python3 "${ASSET_PREFLIGHT_SCRIPT}" >> "${LOG_FILE}" 2>&1; then
	log "Refusing handoff because required processor assets are missing"
	exit 1
fi

# Start the new release drained, so it claims nothing until it proves it is ready.
use_processor_slot "${new_slot}"
new_slot_started=1
python3 "${STATUS_SCRIPT}" set-drain --reason "auto-deploy ${remote_sha}" >> "${LOG_FILE}" 2>&1
python3 "${STATUS_SCRIPT}" set-claim-limits \
	--task-blacklist ${HANDOFF_TASK_BLACKLIST//,/ } \
	--reason "slot ${active_slot} is still finishing a task" >> "${LOG_FILE}" 2>&1
log_processor_compose_files
processor_compose build processor >> "${LOG_FILE}" 2>&1
PROCESSOR_RELEASE_SHA="${remote_sha}" PROCESSOR_MEMORY_LIMIT="${HANDOFF_MEMORY_LIMIT}" \
	processor_compose up -d --force-recreate processor >> "${LOG_FILE}" 2>&1
python3 "${STATUS_SCRIPT}" wait-for-idle \
	--expected-release-sha "${remote_sha}" \
	--timeout-seconds "${STARTUP_TIMEOUT_SECONDS}" \
	--poll-seconds "${READINESS_POLL_SECONDS}" >> "${LOG_FILE}" 2>&1
wait_for_processor_running
inspect_processor_runtime
python3 "${STATUS_SCRIPT}" record-worker-id >> "${LOG_FILE}" 2>&1

# Switch: the previous release stops claiming, the new one starts.
use_processor_slot "${active_slot}"
switched=1
python3 "${STATUS_SCRIPT}" set-drain --reason "auto-deploy handoff to ${remote_sha}" >> "${LOG_FILE}" 2>&1
printf '%s\n' "${new_slot}" > "${PROCESSOR_ACTIVE_SLOT_FILE}.tmp"
mv "${PROCESSOR_ACTIVE_SLOT_FILE}.tmp" "${PROCESSOR_ACTIVE_SLOT_FILE}"
printf '%s\n' "${remote_sha}" > "${ACTIVATED_SHA_FILE}.tmp"
mv "${ACTIVATED_SHA_FILE}.tmp" "${ACTIVATED_SHA_FILE}"
use_processor_slot "${new_slot}"
python3 "${STATUS_SCRIPT}" clear-drain >> "${LOG_FILE}" 2>&1
log "Slot ${new_slot} now runs ${remote_sha}; slot ${active_slot} finishes its task and is retired by a later run"

retire_slot_if_idle "${active_slot}"
