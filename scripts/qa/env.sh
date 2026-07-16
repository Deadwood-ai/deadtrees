#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="$REPO_ROOT/.local/qa"
ENV_SUMMARY="$STATE_DIR/env-summary.json"
VITE_PID_FILE="$STATE_DIR/vite.pid"
VITE_STDIN_FILE="$STATE_DIR/vite.stdin"
VITE_STDIN_PID_FILE="$STATE_DIR/vite-stdin.pid"
VITE_LOG_FILE="$STATE_DIR/vite.log"

vite_session_name() {
	printf 'deadtrees-qa-vite-%s' "${DEADTREES_ISOLATED_SLUG:-default}"
}

usage() {
	cat >&2 <<'USAGE'
Usage: scripts/qa/env.sh <render|up|status|reset|down|cleanup>

Manages the local isolated QA environment for this worktree.

Commands:
  render  Render isolated Supabase/app env files and write QA env summary.
  up      Start isolated Supabase, app services, and Vite.
  status  Check Supabase/Auth, API, Mailpit, and frontend readiness.
  reset   Reseed qa-full and refresh fixture assets.
  down    Stop Vite, app services, and isolated Supabase.
  cleanup Stop an already-rendered QA stack without creating new runtime state.
USAGE
}

source_isolated_env() {
	local env_file
	env_file="$("$REPO_ROOT/scripts/dev/isolated-supabase.sh" env)"
	set -a
	# shellcheck disable=SC1090
	source "$env_file"
	set +a
}

existing_isolated_env_file() {
	if [[ -n "${DEADTREES_ISOLATED_ENV_FILE:-}" && -f "$DEADTREES_ISOLATED_ENV_FILE" ]]; then
		printf '%s\n' "$DEADTREES_ISOLATED_ENV_FILE"
		return 0
	fi
	if [[ -f "$REPO_ROOT/.local/supabase/current.env" ]]; then
		printf '%s\n' "$REPO_ROOT/.local/supabase/current.env"
		return 0
	fi
	return 1
}

source_existing_isolated_env() {
	local env_file
	if ! env_file="$(existing_isolated_env_file)"; then
		return 1
	fi
	set -a
	# shellcheck disable=SC1090
	source "$env_file"
	set +a
}

write_summary() {
	mkdir -p "$STATE_DIR"
	python3 - "$ENV_SUMMARY" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

summary = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "env_file": os.environ.get("DEADTREES_ISOLATED_ENV_FILE"),
    "slug": os.environ.get("DEADTREES_ISOLATED_SLUG"),
    "port_base": os.environ.get("DEADTREES_PORT_BASE"),
    "frontend_url": os.environ.get("PLAYWRIGHT_BASE_URL"),
    "api_url": os.environ.get("VITE_LOCAL_API_URL"),
    "supabase_url": os.environ.get("SUPABASE_URL"),
    "supabase_db_url": os.environ.get("SUPABASE_DB_URL"),
    "local_data_root": os.environ.get("LOCAL_DATA_ROOT"),
    "mailpit_url": f"http://127.0.0.1:{os.environ.get('LOCAL_MAILPIT_HTTP_PORT')}",
    "compose_project_name": os.environ.get("COMPOSE_PROJECT_NAME"),
    "compose_network_name": os.environ.get("COMPOSE_NETWORK_NAME"),
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(summary, handle, indent=2)
    handle.write("\n")
PY
}

check_url() {
	local label="$1"
	local url="$2"
	local status
	status="$(curl -fsS -o /dev/null -w '%{http_code}' "$url" || true)"
	if [[ "$status" != "200" ]]; then
		echo "$label not ready at $url (status: ${status:-curl-failed})" >&2
		return 1
	fi
	echo "$label ready: $url"
}

wait_url() {
	local label="$1"
	local url="$2"
	local timeout="${3:-90}"
	local start
	start="$(date +%s)"
	until check_url "$label" "$url" >/dev/null 2>&1; do
		if (( $(date +%s) - start >= timeout )); then
			check_url "$label" "$url"
			return 1
		fi
		sleep 2
	done
	check_url "$label" "$url"
}

vite_is_running() {
	if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$(vite_session_name)" >/dev/null 2>&1; then
		return 0
	fi
	[[ -f "$VITE_PID_FILE" ]] && kill -0 "$(cat "$VITE_PID_FILE")" >/dev/null 2>&1
}

start_vite() {
	mkdir -p "$STATE_DIR"
	if vite_is_running; then
		if check_url "Frontend" "${PLAYWRIGHT_BASE_URL}/" >/dev/null 2>&1; then
			echo "Vite already running with PID $(cat "$VITE_PID_FILE")"
			return
		fi
		echo "Recorded Vite process is not serving ${PLAYWRIGHT_BASE_URL}; restarting Vite"
		stop_vite
	fi

	if command -v tmux >/dev/null 2>&1; then
		local session
		session="$(vite_session_name)"
		: >"$VITE_LOG_FILE"
		tmux new-session -d -s "$session" -c "$REPO_ROOT" \
			"set -a; source '$DEADTREES_ISOLATED_ENV_FILE'; set +a; bash frontend/scripts/run-vite-profile.sh local --host 127.0.0.1 >> '$VITE_LOG_FILE' 2>&1"
		tmux display-message -p -t "$session" '#{pane_pid}' >"$VITE_PID_FILE"
		echo "Started Vite in tmux session $session with pane PID $(cat "$VITE_PID_FILE"); log: $VITE_LOG_FILE"
		return
	fi

	rm -f "$VITE_STDIN_FILE" "$VITE_STDIN_PID_FILE"
	mkfifo "$VITE_STDIN_FILE"
	(
		cd "$REPO_ROOT"
		nohup bash -c 'exec > "$1"; while :; do sleep 3600; done' _ "$VITE_STDIN_FILE" 2>/dev/null &
		echo "$!" >"$VITE_STDIN_PID_FILE"
		nohup bash frontend/scripts/run-vite-profile.sh local --host 127.0.0.1 >"$VITE_LOG_FILE" 2>&1 <"$VITE_STDIN_FILE" &
		echo "$!" >"$VITE_PID_FILE"
	)
	echo "Started Vite with PID $(cat "$VITE_PID_FILE"); log: $VITE_LOG_FILE"
}

stop_vite() {
	if command -v tmux >/dev/null 2>&1; then
		local session
		session="$(vite_session_name)"
		if tmux has-session -t "$session" >/dev/null 2>&1; then
			tmux kill-session -t "$session" >/dev/null 2>&1 || true
			echo "Stopped Vite tmux session $session"
		fi
	fi
	if vite_is_running; then
		local pid
		pid="$(cat "$VITE_PID_FILE")"
		kill "$pid" >/dev/null 2>&1 || true
		for _ in 1 2 3 4 5; do
			if ! kill -0 "$pid" >/dev/null 2>&1; then
				break
			fi
			sleep 1
		done
		if kill -0 "$pid" >/dev/null 2>&1; then
			kill -9 "$pid" >/dev/null 2>&1 || true
		fi
		echo "Stopped Vite PID $pid"
	fi
	if [[ -f "$VITE_STDIN_PID_FILE" ]]; then
		local stdin_pid
		stdin_pid="$(cat "$VITE_STDIN_PID_FILE")"
		kill "$stdin_pid" >/dev/null 2>&1 || true
	fi
	rm -f "$VITE_PID_FILE" "$VITE_STDIN_FILE" "$VITE_STDIN_PID_FILE"
}

connect_mailpit_to_supabase_network() {
	local mailpit_container
	local supabase_network
	local supabase_mail_alias
	local output

	mailpit_container="${COMPOSE_PROJECT_NAME}-mailpit-1"
	supabase_network="supabase_network_${SUPABASE_PROJECT_ID}"
	supabase_mail_alias="supabase_inbucket_${SUPABASE_PROJECT_ID}"

	if ! docker container inspect "$mailpit_container" >/dev/null 2>&1; then
		echo "Mailpit container not found: $mailpit_container" >&2
		return 1
	fi
	if ! docker network inspect "$supabase_network" >/dev/null 2>&1; then
		echo "Supabase network not found: $supabase_network" >&2
		return 1
	fi

	if output="$(docker network connect --alias "$supabase_mail_alias" "$supabase_network" "$mailpit_container" 2>&1)"; then
		echo "Connected $mailpit_container to $supabase_network as $supabase_mail_alias"
		return 0
	fi

	if [[ "$output" == *"already exists"* || "$output" == *"is already connected"* ]]; then
		echo "$mailpit_container already connected to $supabase_network"
		return 0
	fi

	echo "$output" >&2
	return 1
}

render() {
	source_isolated_env
	write_summary
	echo "Rendered QA environment summary: $ENV_SUMMARY"
}

up() {
	source_isolated_env
	write_summary
	if [[ ! -x "$REPO_ROOT/venv/bin/deadtrees" ]]; then
		echo "Missing $REPO_ROOT/venv/bin/deadtrees. Run: bash scripts/setup-worktree.sh --skip-assets" >&2
		return 1
	fi
	"$REPO_ROOT/scripts/dev/isolated-supabase.sh" start
	"$REPO_ROOT/scripts/qa/prepare-fixtures.sh" qa-full
	"$REPO_ROOT/venv/bin/deadtrees" dev start --services=api-test,nginx,mailpit
	connect_mailpit_to_supabase_network
	start_vite
	status
}

status() {
	source_isolated_env
	write_summary
	wait_url "Supabase Auth" "${SUPABASE_URL}/auth/v1/settings" 60
	wait_url "Local API" "${VITE_LOCAL_API_URL}/" 90
	wait_url "Mailpit" "http://127.0.0.1:${LOCAL_MAILPIT_HTTP_PORT}/" 60
	wait_url "Frontend" "${PLAYWRIGHT_BASE_URL}/" 45
	if vite_is_running; then
		echo "Vite PID: $(cat "$VITE_PID_FILE")"
	else
		echo "Vite PID: not recorded or not running"
	fi
}

reset() {
	source_isolated_env
	"$REPO_ROOT/scripts/qa/seed.sh" qa-full
	"$REPO_ROOT/scripts/qa/check-auth-mailpit.sh" --allow-fail
	write_summary
}

down() {
	source_isolated_env
	stop_vite
	"$REPO_ROOT/venv/bin/deadtrees" dev stop || true
	export DEADTREES_WORKTREE_SLUG="${DEADTREES_WORKTREE_SLUG:-$DEADTREES_ISOLATED_SLUG}"
	"$REPO_ROOT/scripts/dev/isolated-supabase.sh" stop || true
}

cleanup() {
	if ! source_existing_isolated_env; then
		echo "No rendered QA environment found; nothing to clean up."
		return 0
	fi
	stop_vite
	if [[ -x "$REPO_ROOT/venv/bin/deadtrees" ]]; then
		"$REPO_ROOT/venv/bin/deadtrees" dev stop || true
	else
		echo "Missing $REPO_ROOT/venv/bin/deadtrees; skipping app service cleanup."
	fi
	export DEADTREES_WORKTREE_SLUG="${DEADTREES_WORKTREE_SLUG:-$DEADTREES_ISOLATED_SLUG}"
	"$REPO_ROOT/scripts/dev/isolated-supabase.sh" stop || true
}

COMMAND="${1:-}"
case "$COMMAND" in
	render)
		render
		;;
	up)
		up
		;;
	status)
		status
		;;
	reset)
		reset
		;;
	down)
		down
		;;
	cleanup)
		cleanup
		;;
	-h|--help|"")
		usage
		[[ -n "$COMMAND" ]]
		;;
	*)
		echo "Unknown command: $COMMAND" >&2
		usage
		exit 1
		;;
esac
