PROCESSOR_DRAIN_WAIT_PID=""

cleanup_processor_runtime_waiter() {
	local wait_pid="${PROCESSOR_DRAIN_WAIT_PID:-}"
	if [ -n "${wait_pid}" ] && kill -0 "${wait_pid}" 2>/dev/null; then
		kill "${wait_pid}" 2>/dev/null || true
		wait "${wait_pid}" 2>/dev/null || true
	fi
	PROCESSOR_DRAIN_WAIT_PID=""
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
		--poll-seconds "${DRAIN_POLL_SECONDS}" >> "${LOG_FILE}" 2>&1 9>&- &
	wait_pid=$!
	PROCESSOR_DRAIN_WAIT_PID="${wait_pid}"
	while kill -0 "${wait_pid}" 2>/dev/null; do
		if confirm_processor_unavailable; then
			log "Processor became unavailable while draining; entering stopped-worker recovery mode"
			kill "${wait_pid}" 2>/dev/null || true
			wait "${wait_pid}" 2>/dev/null || true
			PROCESSOR_DRAIN_WAIT_PID=""
			docker compose -f "${COMPOSE_FILE}" stop processor >> "${LOG_FILE}" 2>&1
			python3 "${STATUS_SCRIPT}" wait-for-idle \
				--allow-unacknowledged-stopped-worker \
				--timeout-seconds "${DRAIN_TIMEOUT_SECONDS}" \
				--poll-seconds "${DRAIN_POLL_SECONDS}" >> "${LOG_FILE}" 2>&1
			return
		fi
		sleep "${DRAIN_POLL_SECONDS}"
	done
	if wait "${wait_pid}"; then
		PROCESSOR_DRAIN_WAIT_PID=""
		return 0
	else
		local wait_rc=$?
		PROCESSOR_DRAIN_WAIT_PID=""
		return "${wait_rc}"
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

inspect_processor_runtime() {
	local container_id
	container_id="$(docker compose -f "${COMPOSE_FILE}" ps -q processor)"
	if [ -z "${container_id}" ]; then
		log "Processor readiness passed but Compose returned no processor container ID"
		return 1
	fi
	docker inspect "${container_id}" \
		--format 'Cmd={{json .Config.Cmd}} RestartPolicy={{.HostConfig.RestartPolicy.Name}} StartedAt={{.State.StartedAt}}' \
		>> "${LOG_FILE}" 2>&1
}
