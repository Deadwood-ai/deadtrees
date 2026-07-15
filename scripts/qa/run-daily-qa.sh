#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PRODUCTION_ORIGIN="https://deadtrees.earth"
PROFILE="qa-full"
PARALLEL="4"
RUN_DIR=""
DRY_RUN=0
VISIBLE_BROWSER=0
BROWSER_ONLY=0

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/qa/run-daily-qa.sh <prepare|test-local|report|finish|down> [options]

Creates and operates one two-lane QA run:
  production-readonly  Real deployment behavior without domain-data writes
  local-write          Full write-capable journeys on the isolated local stack

Commands:
  prepare     Start/reset/validate local QA, then create both lane packages
  test-local  Run contributor, auditor, and PRIWA write E2E sequentially
  report      Combine production, agent-playbook, and deterministic evidence
  finish      Report and always tear down the isolated local stack
  down        Tear down the isolated local stack without changing evidence

Options:
  --run-dir <path>  Run artifact directory (required except for prepare; latest by default)
  --profile <name>  Local fixture profile, default qa-full
  --parallel <n>    Local agent prompt count, default 4
  --visible-browser Mark generated manual lanes for live in-app Browser execution
  --browser-only    Use bundled Browser for all UI automation; skip Playwright suites
  --dry-run         Prepare packages without starting or validating the stack
  -h, --help        Show this help

Typical agent-operated run:
  scripts/qa/run-daily-qa.sh prepare
  # execute production-readonly.prompt.md and local-write/worker-*.prompt.md
  scripts/qa/run-daily-qa.sh test-local --run-dir .local/qa-runs/daily-...
  scripts/qa/run-daily-qa.sh finish --run-dir .local/qa-runs/daily-...
USAGE
}

COMMAND="${1:-}"
if [[ -z "$COMMAND" || "$COMMAND" == "-h" || "$COMMAND" == "--help" ]]; then
  usage
  [[ -n "$COMMAND" ]]
  exit
fi
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-dir) RUN_DIR="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --parallel) PARALLEL="${2:-}"; shift 2 ;;
    --visible-browser) VISIBLE_BROWSER=1; shift ;;
    --browser-only) BROWSER_ONLY=1; VISIBLE_BROWSER=1; PARALLEL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "$BROWSER_ONLY" == "1" ]]; then
  PARALLEL=1
fi
if ! [[ "$PARALLEL" =~ ^[1-9][0-9]*$ ]]; then
  echo "--parallel must be a positive integer." >&2
  exit 1
fi

resolve_run_dir() {
  if [[ -n "$RUN_DIR" ]]; then
    [[ "$RUN_DIR" == /* ]] || RUN_DIR="$REPO_ROOT/$RUN_DIR"
    return
  fi
  if [[ "$COMMAND" == "prepare" ]]; then
    RUN_DIR="$REPO_ROOT/.local/qa-runs/daily-$(date -u '+%Y%m%dT%H%M%SZ')"
    return
  fi
  RUN_DIR="$(find "$REPO_ROOT/.local/qa-runs" -mindepth 1 -maxdepth 1 -type d -name 'daily-20*' 2>/dev/null | sort | tail -n 1)"
  if [[ -z "$RUN_DIR" ]]; then
    echo "No daily QA run found. Pass --run-dir or run prepare first." >&2
    exit 1
  fi
}
resolve_run_dir

require_run() {
  if [[ ! -f "$RUN_DIR/manifest.json" ]]; then
    echo "Missing daily QA manifest: $RUN_DIR/manifest.json" >&2
    exit 1
  fi
}

source_isolated_env() {
  local env_file="${DEADTREES_ISOLATED_ENV_FILE:-$REPO_ROOT/.local/supabase/current.env}"
  if [[ ! -f "$env_file" ]]; then
    echo "Missing isolated environment file: $env_file" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

write_lane_package() {
  python3 - "$REPO_ROOT" "$RUN_DIR" "$PROFILE" "$PARALLEL" "$DRY_RUN" "$PRODUCTION_ORIGIN" "$VISIBLE_BROWSER" "$BROWSER_ONLY" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

repo = Path(sys.argv[1])
run = Path(sys.argv[2])
profile = sys.argv[3]
parallel = int(sys.argv[4])
dry_run = sys.argv[5] == "1"
production_origin = sys.argv[6]
visible_browser = sys.argv[7] == "1"
browser_only = sys.argv[8] == "1"
generated_at = datetime.now(timezone.utc).isoformat()
playbook = repo / "docs/qa/playbooks/production-readonly-regression.md"

manifest = {
    "schema_version": 1,
    "generated_at": generated_at,
    "run_type": "daily-two-lane",
    "dry_run": dry_run,
    "production_origin": production_origin,
    "visible_browser": visible_browser,
    "browser_only": browser_only,
    "profile": profile,
    "parallel": parallel,
    "lanes": {
        "production-readonly": {
            "target": production_origin,
            "mutation_policy": "no-domain-data-writes",
            "playbook": str(playbook.relative_to(repo)),
            "result": "production-readonly.result.md",
        },
        "local-write": {
            "target_source": ".local/supabase/current.env",
            "mutation_policy": "isolated-local-writes-allowed",
            "package": "local-write/manifest.json",
            "deterministic_results": "local-write-tests/results.json",
        },
    },
}
(run / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

live_viewing = """
## Live Viewing

This is an operator-visible manual QA run.

- Use the in-app Browser, obtain its `visibility` capability, and call
  `set(true)` before opening the production origin.
- Keep the watchable journey in the bundled Browser. Do not switch it to
  Browser Use, Chrome, or terminal Playwright.
- Keep the Browser visible throughout navigation, authentication, responsive
  checks, and all form/editor entry-and-cancel steps.
- Wait for the relevant rendered state after each action so the operator can
  follow the journey. Do not hide or finalize the Browser until this lane is
  complete and its result has been written.
""" if visible_browser else ""

prompt = f"""# Production Read-Only QA Lane

Target: {production_origin}
Playbook: `{playbook.relative_to(repo)}`
Result: `{(run / 'production-readonly.result.md').relative_to(repo)}`

{live_viewing}

## Hard Boundary

- Use the built-in Browser only against `{production_origin}` and its production
  API, Supabase, and asset origins discovered by the application.
- Do not create, edit, upload, process, download-by-job, audit, label, correct,
  report, subscribe, reset a password, create PRIWA observations, or otherwise
  change domain data.
- Sign-in/sign-out may create and revoke an authentication session. Client-only
  filters, tabs, drawers, and forms that are cancelled before submission are allowed.
- If a step would cause any other non-idempotent request, stop before the action
  and record it as intentionally skipped. Never clean up by deleting production data.
- If the origin differs from exactly `{production_origin}`, stop the lane.
- Do not put credentials, tokens, cookies, or personal data in the result file.

## Execution

Follow every applicable step in the production read-only playbook. Check focused
console errors and responsive behavior. Use PostHog read-only if the connected
account is available. Search the issue tracker before suggesting a new defect,
but do not create/update an issue unless separately authorized for that run.

## Result Contract

Write:

- `Status: pass|fail|blocked|needs-human-review`
- `Started at:` and `Finished at:` in UTC
- route-by-route focused evidence
- console and PostHog summaries
- defects with severity and reproduction steps
- the explicit list of production mutations intentionally skipped
"""
(run / "production-readonly.prompt.md").write_text(prompt, encoding="utf-8")
(run / "production-readonly.result.md").write_text(
    "# Production Read-Only Result\n\nStatus: pending\n\n", encoding="utf-8"
)
if browser_only:
    tests_dir = run / "local-write-tests"
    tests_dir.mkdir(parents=True, exist_ok=True)
    (tests_dir / "results.json").write_text(
        json.dumps(
            {
                "generated_at": generated_at,
                "status": "skipped",
                "reason": "Browser-only skill mode; all UI automation uses the bundled Browser.",
                "suites": [],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
PY
}

prepare() {
  mkdir -p "$RUN_DIR"
  "$REPO_ROOT/scripts/qa/lint-playbooks.sh" >/dev/null

  if [[ "$DRY_RUN" == "0" ]]; then
    local prepared=0
    cleanup_failed_prepare() {
      if [[ "$prepared" == "0" ]]; then
        "$REPO_ROOT/scripts/qa/env.sh" down >/dev/null 2>&1 || true
      fi
    }
    trap cleanup_failed_prepare EXIT
    "$REPO_ROOT/scripts/qa/env.sh" up
    "$REPO_ROOT/scripts/qa/env.sh" reset
    "$REPO_ROOT/scripts/qa/validate-isolated-env.sh" "$RUN_DIR/isolation"
    source_isolated_env
  fi

  local runner_args=(
    --profile "$PROFILE"
    --parallel "$PARALLEL"
    --mutation-level local-write
    --run-dir "$RUN_DIR/local-write"
  )
  if [[ "$DRY_RUN" == "1" ]]; then
    runner_args+=(--dry-run)
  else
    runner_args+=(--no-seed)
  fi
  if [[ "$VISIBLE_BROWSER" == "1" ]]; then
    runner_args+=(--visible-browser)
  fi
  if [[ "$BROWSER_ONLY" == "1" ]]; then
    runner_args+=(--browser-only)
  fi
  "$REPO_ROOT/scripts/qa/run-agent-qa.sh" "${runner_args[@]}" >/dev/null
  write_lane_package
  report

  if [[ "$DRY_RUN" == "0" ]]; then
    prepared=1
    trap - EXIT
  fi
  if [[ "$VISIBLE_BROWSER" == "1" ]]; then
    echo "Visible Browser prompts prepared; this shell command does not launch a Codex agent."
    echo "Next Codex action: execute $RUN_DIR/production-readonly.prompt.md and $RUN_DIR/local-write/worker-*.prompt.md with the bundled Browser."
  fi
  echo "$RUN_DIR"
}

test_local() {
  require_run
  if [[ "$(python3 -c 'import json,sys; print(str(json.load(open(sys.argv[1])).get("browser_only", False)).lower())' "$RUN_DIR/manifest.json")" == "true" ]]; then
    echo "This run is browser-only; execute local UI journeys with the bundled Browser instead of test-local." >&2
    return 2
  fi
  source_isolated_env
  "$REPO_ROOT/scripts/qa/validate-isolated-env.sh" "$RUN_DIR/isolation-before-write" >/dev/null
  mkdir -p "$RUN_DIR/local-write-tests"
  local tsv="$RUN_DIR/local-write-tests/results.tsv"
  : >"$tsv"
  local failed=0
  local suites=(contributor auditor priwa)
  local commands=(test:e2e:local:write test:e2e:local:audit:write test:e2e:local:priwa:write)
  local idx name script_name log_file started finished status

  for idx in "${!suites[@]}"; do
    name="${suites[$idx]}"
    script_name="${commands[$idx]}"
    log_file="$RUN_DIR/local-write-tests/$name.log"
    started="$(date +%s)"
    if npm --prefix "$REPO_ROOT/frontend" run "$script_name" >"$log_file" 2>&1; then
      status=pass
    else
      status=fail
      failed=1
    fi
    finished="$(date +%s)"
    printf '%s\t%s\t%s\t%s\n' "$name" "$status" "$((finished - started))" "$script_name" >>"$tsv"
    echo "$name write suite: $status ($((finished - started))s; log: $log_file)"
  done

  python3 - "$tsv" "$RUN_DIR/local-write-tests/results.json" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

rows = []
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    name, status, duration, command = line.split("\t")
    rows.append({"name": name, "status": status, "duration_seconds": int(duration), "npm_script": command})
result = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "status": "pass" if rows and all(row["status"] == "pass" for row in rows) else "fail",
    "suites": rows,
}
Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
PY
  rm -f "$tsv"
  report
  return "$failed"
}

report() {
  require_run
  if [[ -f "$RUN_DIR/local-write/manifest.json" ]]; then
    "$REPO_ROOT/scripts/qa/report.sh" "$RUN_DIR/local-write" >/dev/null
  fi
  python3 - "$REPO_ROOT" "$RUN_DIR" <<'PY'
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

repo = Path(sys.argv[1])
run = Path(sys.argv[2])
manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))

def md_status(path: Path) -> str:
    if not path.exists():
        return "pending"
    match = re.search(r"(?im)^Status:\s*(pass|fail|blocked|needs-human-review|pending)\s*$", path.read_text(encoding="utf-8"))
    return match.group(1).lower() if match else "pending"

production_status = md_status(run / "production-readonly.result.md")
tests_path = run / "local-write-tests/results.json"
tests = json.loads(tests_path.read_text(encoding="utf-8")) if tests_path.exists() else {"status": "pending", "suites": []}
worker_results = []
for path in sorted((run / "local-write").glob("worker-*.result.md")):
    worker_results.append({"file": path.name, "status": md_status(path)})
agent_status = "pending"
statuses = [item["status"] for item in worker_results]
if statuses:
    if "fail" in statuses:
        agent_status = "fail"
    elif "blocked" in statuses:
        agent_status = "blocked"
    elif "needs-human-review" in statuses:
        agent_status = "needs-human-review"
    elif all(status == "pass" for status in statuses):
        agent_status = "pass"

overall_inputs = [production_status, agent_status]
if tests["status"] != "skipped":
    overall_inputs.append(tests["status"])
if "fail" in overall_inputs:
    overall = "fail"
elif "blocked" in overall_inputs:
    overall = "blocked"
elif "needs-human-review" in overall_inputs:
    overall = "needs-human-review"
elif all(status == "pass" for status in overall_inputs):
    overall = "pass"
else:
    overall = "pending"

lines = [
    "# DeadTrees Daily Two-Lane QA",
    "",
    f"- Updated: `{datetime.now(timezone.utc).isoformat()}`",
    f"- Overall: `{overall}`",
    f"- Production target: `{manifest['production_origin']}`",
    f"- Production read-only lane: `{production_status}`",
    f"- Local deterministic write suites: `{tests['status']}`",
    f"- Local agent write playbooks: `{agent_status}`",
    "",
    "## Safety Boundary",
    "",
    "- Production: no domain-data writes; only auth-session lifecycle and cancelled forms are allowed.",
    "- Local: writes are allowed only after isolated endpoint validation.",
    "- Cleanup: run `finish` to stop the per-worktree app and Supabase stack.",
    "",
    "## Deterministic Local Write Suites",
    "",
]
if tests["status"] == "skipped":
    lines.append(f"- skipped: {tests.get('reason', 'browser-only run')}")
elif tests["suites"]:
    for suite in tests["suites"]:
        lines.append(f"- `{suite['name']}`: {suite['status']} ({suite['duration_seconds']}s; `{suite['npm_script']}`)")
else:
    lines.append("- pending")

lines.extend(["", "## Local Agent Workers", ""])
if worker_results:
    for worker in worker_results:
        lines.append(f"- `{worker['file']}`: {worker['status']}")
else:
    lines.append("- pending")

lines.extend([
    "",
    "## Evidence",
    "",
    "- Production prompt/result: `production-readonly.prompt.md`, `production-readonly.result.md`",
    "- Local agent package/report: `local-write/`, `local-write/report.md`",
    "- Local deterministic logs/results: `local-write-tests/`",
    "- Isolation validation: `isolation/`, `isolation-before-write/`",
    "",
])
(run / "report.md").write_text("\n".join(lines), encoding="utf-8")
print(run / "report.md")
PY
}

finish() {
  require_run
  local result=0
  report || result=$?
  "$REPO_ROOT/scripts/qa/env.sh" down || result=$?
  return "$result"
}

case "$COMMAND" in
  prepare) prepare ;;
  test-local) test_local ;;
  report) report ;;
  finish) finish ;;
  down) "$REPO_ROOT/scripts/qa/env.sh" down ;;
  *) echo "Unknown command: $COMMAND" >&2; usage; exit 1 ;;
esac
