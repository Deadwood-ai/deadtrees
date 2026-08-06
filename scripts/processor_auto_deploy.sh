#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCK_DIR="${REPO_DIR}/.local/locks"
LOCK_FILE="${LOCK_DIR}/processor-runtime.lock"
ACTIVATED_SHA_FILE="${REPO_DIR}/.local/processor-activated-sha"
ROLLBACK_SHA_FILE="${REPO_DIR}/.local/processor-rollback-sha"
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

mkdir -p "${LOCK_DIR}"
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

processor_availability() {
	local container_id=""
	local inspect_output=""
	local status=""
	local restarting=""

	container_id="$(docker compose -f "${COMPOSE_FILE}" ps -q processor 2>/dev/null || true)"
	inspect_output="$(docker inspect "${container_id}" --format '{{.State.Status}} {{.State.Restarting}}' 2>/dev/null || true)"
	if [ -n "${inspect_output}" ]; then
		read -r status restarting <<< "${inspect_output}"
		if [ "${status}" = "running" ] && [ "${restarting}" = "false" ]; then
			return 0
		fi
		if [ "${restarting}" = "true" ] || [[ "${status}" =~ ^(created|exited|dead|removing)$ ]]; then
			return 1
		fi
		return 2
	fi

	if docker info >/dev/null 2>&1; then
		return 1
	fi
	return 2
}

confirm_processor_unavailable() {
	local attempt=1
	local availability_rc

	while [ "${attempt}" -le "${UNAVAILABLE_CONFIRMATIONS}" ]; do
		if processor_availability; then
			return 1
		else
			availability_rc=$?
		fi
		if [ "${availability_rc}" -ne 1 ]; then
			log "Processor availability probe was inconclusive; continuing the normal drain wait"
			return 1
		fi
		if [ "${attempt}" -lt "${UNAVAILABLE_CONFIRMATIONS}" ]; then
			sleep "${UNAVAILABLE_POLL_SECONDS}"
		fi
		attempt=$((attempt + 1))
	done
	return 0
}

wait_for_drain_with_recovery() {
	local wait_pid

	if confirm_processor_unavailable; then
		log "Processor is unavailable; entering stopped-worker recovery mode"
		docker compose -f "${COMPOSE_FILE}" stop processor >> "${LOG_FILE}" 2>&1
		python3 "${STATUS_SCRIPT}" wait-for-idle \
			--allow-unacknowledged-stopped-worker \
			--timeout-seconds "${DRAIN_TIMEOUT_SECONDS}" \
			--poll-seconds "${DRAIN_POLL_SECONDS}" >> "${LOG_FILE}" 2>&1
		return
	fi

	python3 "${STATUS_SCRIPT}" wait-for-idle \
		--timeout-seconds "${DRAIN_TIMEOUT_SECONDS}" \
		--poll-seconds "${DRAIN_POLL_SECONDS}" >> "${LOG_FILE}" 2>&1 &
	wait_pid=$!
	while kill -0 "${wait_pid}" 2>/dev/null; do
		if confirm_processor_unavailable; then
			log "Processor became unavailable while draining; entering stopped-worker recovery mode"
			kill "${wait_pid}" 2>/dev/null || true
			wait "${wait_pid}" 2>/dev/null || true
			docker compose -f "${COMPOSE_FILE}" stop processor >> "${LOG_FILE}" 2>&1
			python3 "${STATUS_SCRIPT}" wait-for-idle \
				--allow-unacknowledged-stopped-worker \
				--timeout-seconds "${DRAIN_TIMEOUT_SECONDS}" \
				--poll-seconds "${DRAIN_POLL_SECONDS}" >> "${LOG_FILE}" 2>&1
			return
		fi
		sleep "${DRAIN_POLL_SECONDS}"
	done
	wait "${wait_pid}"
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
	local container_id=""

	while [ "${SECONDS}" -lt "${deadline}" ]; do
		container_id="$(docker compose -f "${COMPOSE_FILE}" ps -q processor 2>/dev/null || true)"
		inspect_output="$(docker inspect "${container_id}" --format '{{.State.Status}} {{.State.Restarting}} {{.RestartCount}} {{.State.ExitCode}}' 2>/dev/null || true)"
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
			log "Waiting for processor readiness: Compose processor container is not inspectable yet"
		fi
		sleep "${READINESS_POLL_SECONDS}"
	done

	log "Processor failed readiness check within ${STARTUP_TIMEOUT_SECONDS}s"
	return 1
}

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
	log "Skipping deploy check because another processor runtime operation already holds ${LOCK_FILE}"
	exit 0
fi

drain_set=0
trap 'rc=$?; if [ "${rc}" -ne 0 ] && [ "${drain_set}" -eq 1 ]; then log "Deployment failed; drain request remains in place for inspection and rollback"; fi' EXIT

cd "${REPO_DIR}"
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
if [ "${local_sha}" != "${remote_sha}" ]; then
	printf '%s\n' "${local_sha}" > "${ROLLBACK_SHA_FILE}.tmp"
	mv "${ROLLBACK_SHA_FILE}.tmp" "${ROLLBACK_SHA_FILE}"
fi
rollback_sha="$(cat "${ROLLBACK_SHA_FILE}" 2>/dev/null || printf '%s' "${local_sha}")"
log "Rollback path: git reset --hard ${rollback_sha} && docker compose -f ${COMPOSE_FILE} build processor tcd && docker compose -f ${COMPOSE_FILE} up -d --force-recreate processor"

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
processor_container_id="$(docker compose -f "${COMPOSE_FILE}" ps -q processor)"
if [ -z "${processor_container_id}" ]; then
	log "Processor readiness passed but Compose returned no processor container ID"
	exit 1
fi
docker inspect "${processor_container_id}" \
	--format 'Cmd={{json .Config.Cmd}} RestartPolicy={{.HostConfig.RestartPolicy.Name}} StartedAt={{.State.StartedAt}}' \
	>> "${LOG_FILE}" 2>&1

python3 "${STATUS_SCRIPT}" clear-drain >> "${LOG_FILE}" 2>&1
drain_set=0

printf '%s\n' "${deployed_sha}" > "${ACTIVATED_SHA_FILE}.tmp"
mv "${ACTIVATED_SHA_FILE}.tmp" "${ACTIVATED_SHA_FILE}"

log "Deployment complete ($(git rev-parse --short HEAD))"
