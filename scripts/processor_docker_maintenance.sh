#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCK_DIR="${REPO_DIR}/.local/locks"
LOCK_FILE="${LOCK_DIR}/processor-runtime.lock"
LOG_FILE="${REPO_DIR}/processor-maintenance.log"
STATUS_SCRIPT="${REPO_DIR}/scripts/processor_runtime_control.py"
COMPOSE_FILE="${REPO_DIR}/docker-compose.processor.yaml"
HOLD_DURATION="${PROCESSOR_SNAP_HOLD_DURATION:-7d}"
DRAIN_TIMEOUT_SECONDS="${PROCESSOR_DRAIN_TIMEOUT_SECONDS:-43200}"
DRAIN_POLL_SECONDS="${PROCESSOR_DRAIN_POLL_SECONDS:-15}"
RENEW_HOLD_ONLY=0
CONTROL_DIR="$(dirname "${PROCESSOR_DRAIN_REQUEST_PATH:-/data/processor-control/drain-request.json}")"
DRAIN_ACK_PATH="${PROCESSOR_DRAIN_ACK_PATH:-/data/processor-control/drain-ack.json}"
STARTUP_TIMEOUT_SECONDS="${PROCESSOR_STARTUP_TIMEOUT_SECONDS:-300}"
READINESS_POLL_SECONDS="${PROCESSOR_READINESS_POLL_SECONDS:-5}"

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

wait_for_processor_running() {
	local deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
	local stable_polls=0
	local last_restart_count=""
	local inspect_output=""
	local status=""
	local restarting=""
	local restart_count=""
	local exit_code=""

	while [ "${SECONDS}" -lt "${deadline}" ]; do
		inspect_output="$(docker inspect deadtrees-processor-1 --format '{{.State.Status}} {{.State.Restarting}} {{.RestartCount}} {{.State.ExitCode}}' 2>/dev/null || true)"
		if [ -n "${inspect_output}" ]; then
			read -r status restarting restart_count exit_code <<< "${inspect_output}"
			log "Waiting for processor readiness: status=${status} restarting=${restarting} restart_count=${restart_count} exit_code=${exit_code}"
			if [ "${status}" = "running" ] && [ "${restarting}" = "false" ]; then
				if [ "${restart_count}" = "${last_restart_count}" ]; then
					stable_polls=$((stable_polls + 1))
				else
					stable_polls=1
					last_restart_count="${restart_count}"
				fi
				if [ "${stable_polls}" -ge 2 ]; then
					return 0
				fi
			else
				stable_polls=0
				last_restart_count="${restart_count}"
			fi
		else
			log "Waiting for processor readiness: container deadtrees-processor-1 is not inspectable yet"
		fi
		sleep "${READINESS_POLL_SECONDS}"
	done

	log "Processor failed readiness check within ${STARTUP_TIMEOUT_SECONDS}s"
	return 1
}

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
	log "Skipping Docker maintenance because another processor runtime operation already holds ${LOCK_FILE}"
	exit 0
fi

drain_set=0
trap 'rc=$?; if [ "${rc}" -ne 0 ] && [ "${drain_set}" -eq 1 ]; then log "Docker maintenance failed; drain request remains in place for operator review"; fi' EXIT

cd "${REPO_DIR}"
mkdir -p "${CONTROL_DIR}"
require_clean_checkout

snap refresh --hold="${HOLD_DURATION}" docker >> "${LOG_FILE}" 2>&1
log "Renewed Docker snap hold for ${HOLD_DURATION}"

if [ "${RENEW_HOLD_ONLY}" -eq 1 ]; then
	exit 0
fi

python3 "${STATUS_SCRIPT}" set-drain --reason "docker-maintenance" >> "${LOG_FILE}" 2>&1
drain_set=1
python3 "${STATUS_SCRIPT}" wait-for-idle \
	--timeout-seconds "${DRAIN_TIMEOUT_SECONDS}" \
	--poll-seconds "${DRAIN_POLL_SECONDS}" >> "${LOG_FILE}" 2>&1

docker compose -f "${COMPOSE_FILE}" stop processor >> "${LOG_FILE}" 2>&1
snap refresh docker >> "${LOG_FILE}" 2>&1
snap refresh --hold="${HOLD_DURATION}" docker >> "${LOG_FILE}" 2>&1
require_clean_checkout
rm -f "${DRAIN_ACK_PATH}"
docker compose -f "${COMPOSE_FILE}" up -d processor >> "${LOG_FILE}" 2>&1
python3 "${STATUS_SCRIPT}" wait-for-idle \
	--timeout-seconds "${STARTUP_TIMEOUT_SECONDS}" \
	--poll-seconds "${READINESS_POLL_SECONDS}" >> "${LOG_FILE}" 2>&1
wait_for_processor_running
docker inspect deadtrees-processor-1 \
	--format 'Cmd={{json .Config.Cmd}} RestartPolicy={{.HostConfig.RestartPolicy.Name}} StartedAt={{.State.StartedAt}}' \
	>> "${LOG_FILE}" 2>&1

python3 "${STATUS_SCRIPT}" clear-drain >> "${LOG_FILE}" 2>&1
drain_set=0

log "Docker maintenance complete"
