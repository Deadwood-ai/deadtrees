#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCK_DIR="${REPO_DIR}/.local/locks"
LOCK_FILE="${LOCK_DIR}/processor-runtime.lock"
LOG_FILE="${REPO_DIR}/auto-deploy.log"
STATUS_SCRIPT="${REPO_DIR}/scripts/processor_runtime_control.py"
COMPOSE_FILE="${REPO_DIR}/docker-compose.processor.yaml"
BRANCH="${PROCESSOR_DEPLOY_BRANCH:-main}"
DRAIN_TIMEOUT_SECONDS="${PROCESSOR_DRAIN_TIMEOUT_SECONDS:-43200}"
DRAIN_POLL_SECONDS="${PROCESSOR_DRAIN_POLL_SECONDS:-15}"

mkdir -p "${LOCK_DIR}"
touch "${LOG_FILE}"

log() {
	printf '%s: %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >> "${LOG_FILE}"
}

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
	log "Skipping deploy check because another processor runtime operation already holds ${LOCK_FILE}"
	exit 0
fi

drain_set=0
trap 'rc=$?; if [ "${rc}" -ne 0 ] && [ "${drain_set}" -eq 1 ]; then log "Deployment failed; drain request remains in place for inspection and rollback"; fi' EXIT

cd "${REPO_DIR}"

git fetch origin "${BRANCH}" >> "${LOG_FILE}" 2>&1

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/${BRANCH}")"

if [ "${local_sha}" = "${remote_sha}" ]; then
	log "No changes"
	exit 0
fi

log "Preparing deploy from ${local_sha} to ${remote_sha}"
log "Rollback path: git reset --hard ${local_sha} && docker compose -f ${COMPOSE_FILE} up -d --force-recreate processor"

python3 "${STATUS_SCRIPT}" set-drain --reason "auto-deploy ${remote_sha}" >> "${LOG_FILE}" 2>&1
drain_set=1
python3 "${STATUS_SCRIPT}" wait-for-idle \
	--timeout-seconds "${DRAIN_TIMEOUT_SECONDS}" \
	--poll-seconds "${DRAIN_POLL_SECONDS}" >> "${LOG_FILE}" 2>&1

git pull --ff-only origin "${BRANCH}" >> "${LOG_FILE}" 2>&1
docker compose -f "${COMPOSE_FILE}" build processor tcd >> "${LOG_FILE}" 2>&1
docker compose -f "${COMPOSE_FILE}" up -d --force-recreate processor >> "${LOG_FILE}" 2>&1
docker inspect deadtrees-processor-1 \
	--format 'Cmd={{json .Config.Cmd}} RestartPolicy={{.HostConfig.RestartPolicy.Name}} StartedAt={{.State.StartedAt}}' \
	>> "${LOG_FILE}" 2>&1 || true

python3 "${STATUS_SCRIPT}" clear-drain >> "${LOG_FILE}" 2>&1
drain_set=0

log "Deployment complete ($(git rev-parse --short HEAD))"
