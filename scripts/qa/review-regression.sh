#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
	cat >&2 <<'USAGE'
Usage: scripts/qa/review-regression.sh [options]

Local-review browser regression gate. Starts and validates this worktree's
isolated stack, runs every local Playwright suite (read and local-write) in
headless Chromium, and writes agent QA prompts for the change under review.

Options:
  --focus <text>   Change-specific QA focus written into the agent prompts
  --keep-up        Leave the stack running for the agent QA pass; stop it
                   afterwards with scripts/qa/env.sh down
  --run-dir <path> Output directory, default .local/qa-runs/review-<timestamp>
  --workers <n>    Playwright workers, default 4; the write suites share one
                   database and Vite server, so more workers add flakes
  -h, --help       Show this help

Each failing test is retried once. A test that passes on retry does not fail
the gate but is printed as flaky in the summary; report it in the review. Exit
status is the Playwright suite result. Without --keep-up the stack is
always stopped, including after a failure.
USAGE
}

FOCUS=""
KEEP_UP=0
WORKERS=4
RUN_DIR="$REPO_ROOT/.local/qa-runs/review-$(date -u +%Y%m%dT%H%M%SZ)"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--focus)
			FOCUS="${2:?--focus needs a value}"
			shift 2
			;;
		--workers)
			WORKERS="${2:?--workers needs a value}"
			shift 2
			;;
		--keep-up)
			KEEP_UP=1
			shift
			;;
		--run-dir)
			RUN_DIR="${2:?--run-dir needs a value}"
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "Unknown option: $1" >&2
			usage
			exit 1
			;;
	esac
done

mkdir -p "$RUN_DIR"
RUN_DIR="$(cd "$RUN_DIR" && pwd)"
ENV_SH="$REPO_ROOT/scripts/qa/env.sh"

stop_stack() {
	if ((KEEP_UP)); then
		echo "Stack left running; stop it with: scripts/qa/env.sh down"
	else
		"$ENV_SH" down >"$RUN_DIR/env-down.log" 2>&1 || echo "env.sh down failed; see $RUN_DIR/env-down.log" >&2
	fi
}
trap stop_stack EXIT

run_setup_step() {
	local name="$1"
	shift
	if ! "$@" >"$RUN_DIR/env-$name.log" 2>&1; then
		echo "Stack setup step '$name' failed; see $RUN_DIR/env-$name.log" >&2
		exit 1
	fi
}

echo "Starting isolated stack (logs in $RUN_DIR)"
run_setup_step up "$ENV_SH" up
run_setup_step reset "$ENV_SH" reset
run_setup_step validate "$REPO_ROOT/scripts/qa/validate-isolated-env.sh"

set -a
# shellcheck disable=SC1091
source "$REPO_ROOT/.local/supabase/current.env"
set +a
case "$PLAYWRIGHT_BASE_URL" in
	http://127.0.0.1:*|http://localhost:*) ;;
	*)
		echo "Refusing to run: PLAYWRIGHT_BASE_URL is not a loopback URL." >&2
		exit 1
		;;
esac

echo "Running local Playwright suites against $PLAYWRIGHT_BASE_URL"
suite_status=0
(
	cd "$REPO_ROOT/frontend"
	E2E_LOCAL_WRITE=1 E2E_LOCAL_AUDITOR_WRITE=1 E2E_LOCAL_PRIWA_WRITE=1 \
		PLAYWRIGHT_HTML_OPEN=never PLAYWRIGHT_HTML_OUTPUT_DIR="$RUN_DIR/playwright-report" \
		./node_modules/.bin/playwright test --config playwright.local.config.ts \
		--workers "$WORKERS" --retries 1 --reporter=line,html \
		--output "$RUN_DIR/playwright-artifacts"
) >"$RUN_DIR/playwright.log" 2>&1 || suite_status=$?
tail -n 30 "$RUN_DIR/playwright.log"
# Playwright's final summary lists failed and flaky tests under "N failed"/"N flaky".
flaky_count="$(sed -n 's/^ *\([0-9][0-9]*\) flaky$/\1/p' "$RUN_DIR/playwright.log" | tail -n 1)"

qa_args=(--no-seed --parallel 1 --agent-browser-surface playwright --run-dir "$RUN_DIR/agent-qa")
if [[ -n "$FOCUS" ]]; then
	qa_args+=(--focus "$FOCUS")
fi
"$REPO_ROOT/scripts/qa/run-agent-qa.sh" "${qa_args[@]}" >"$RUN_DIR/agent-qa.log" 2>&1 \
	|| echo "Agent QA prompt generation failed; see $RUN_DIR/agent-qa.log" >&2

echo
echo "Playwright suites: $([[ $suite_status -eq 0 ]] && echo pass || echo "fail (exit $suite_status)"), flaky: ${flaky_count:-0}"
echo "Log: $RUN_DIR/playwright.log"
echo "Agent QA prompts: $RUN_DIR/agent-qa"
exit "$suite_status"
