#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_DIR="$REPO_ROOT/.local/qa-runs/browser-use-cli-probe"
if [[ $# -gt 0 && "${1:-}" != --* ]]; then
	RUN_DIR="$1"
	shift
fi
ENV_FILE="${DEADTREES_ISOLATED_ENV_FILE:-$REPO_ROOT/.local/supabase/current.env}"
if [[ -f "$ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
fi
FRONTEND_URL="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:${PLAYWRIGHT_PORT:-5173}}"
REPORT="$RUN_DIR/report.md"
EXERCISE_UPLOAD=0
BROWSER_USE_HEADED="${BROWSER_USE_HEADED:-0}"
PROBE_PORT="${BROWSER_USE_PROBE_PORT:-58091}"
UPLOAD_FILE="${QA_UPLOAD_FILE:-$REPO_ROOT/frontend/test/fixtures/geotiff/upload-validation/rgb-real-crop.tif}"

usage() {
	cat >&2 <<'USAGE'
Usage: scripts/qa/browser-use-cli-probe.sh [run-dir] [--exercise-upload] [--headed]

Options:
  --exercise-upload  Verify named sessions and file upload against a local probe page.
  --headed           Show Browser Use browser windows. Equivalent to BROWSER_USE_HEADED=1.
USAGE
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--exercise-upload)
			EXERCISE_UPLOAD=1
			shift
			;;
		--headed)
			BROWSER_USE_HEADED=1
			shift
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
export UV_CACHE_DIR="${UV_CACHE_DIR:-$REPO_ROOT/.local/uv-cache}"
export UV_TOOL_DIR="${UV_TOOL_DIR:-$REPO_ROOT/.local/uv-tools}"
mkdir -p "$UV_CACHE_DIR"
mkdir -p "$UV_TOOL_DIR"

BROWSER_USE_COMMAND=()
BROWSER_USE_OPEN_COMMAND=()

browser_use() {
	"${BROWSER_USE_COMMAND[@]}" "$@"
}

browser_use_open() {
	"${BROWSER_USE_OPEN_COMMAND[@]}" "$@"
}

write_report() {
	local status="$1"
	local category="$2"
	local notes="$3"
	cat > "$REPORT" <<EOF
# Browser Use CLI Probe

- Status: \`$status\`
- Category: \`$category\`
- Frontend: \`$FRONTEND_URL\`
- Headed: \`$BROWSER_USE_HEADED\`

## Notes

$notes
EOF
	echo "$REPORT"
}

if command -v browser-use >/dev/null 2>&1; then
	BROWSER_USE_COMMAND=(browser-use)
	{
		echo "## browser-use --help"
		browser-use --help
	} > "$RUN_DIR/browser-use-help.txt" 2>&1 || true
else
	if ! command -v uvx >/dev/null 2>&1; then
		write_report "blocked" "tooling-limitation" "\`browser-use\` is not installed and \`uvx\` is unavailable, so the CLI experiment cannot run from this environment."
		exit 0
	fi

	set +e
	uvx --from browser-use python - <<'PY' > "$RUN_DIR/uvx-import.txt" 2>&1
import importlib.metadata
import browser_use

print("browser_use module:", browser_use.__file__)
try:
    print("browser-use version:", importlib.metadata.version("browser-use"))
except importlib.metadata.PackageNotFoundError:
    print("browser-use version: unknown")
PY
	IMPORT_STATUS=$?
	set -e

	if [[ "$IMPORT_STATUS" != "0" ]]; then
		write_report "blocked" "tooling-limitation" "Browser Use could not be loaded through \`uvx --from browser-use\`. See \`uvx-import.txt\` for details."
		exit 0
	fi

	BROWSER_USE_COMMAND=(uvx --from browser-use browser-use)
fi

if [[ "$BROWSER_USE_HEADED" == "1" ]]; then
	BROWSER_USE_OPEN_COMMAND=("${BROWSER_USE_COMMAND[@]}" --headed)
else
	BROWSER_USE_OPEN_COMMAND=("${BROWSER_USE_COMMAND[@]}")
fi

set +e
browser_use --help > "$RUN_DIR/uvx-cli-help.txt" 2>&1
CLI_STATUS=$?
set -e

if [[ "$CLI_STATUS" != "0" ]]; then
	write_report "blocked" "tooling-limitation" "Browser Use is importable through \`uvx\`, but no working \`browser-use\` executable was exposed by the package. See \`uvx-import.txt\` and \`uvx-cli-help.txt\`. Treat Browser Use as a Python-library integration candidate, not a CLI replacement, unless a supported CLI command is identified."
	exit 0
fi

if [[ "$EXERCISE_UPLOAD" == "0" ]]; then
	write_report "needs-human-review" "tooling-limitation" "Browser Use is importable and exposes a \`browser-use\` command. See \`uvx-cli-help.txt\`. Run this script with \`--exercise-upload\` to verify local named sessions and CLI file upload."
	exit 0
fi

cat > "$RUN_DIR/session-a.html" <<'HTML'
<html>
  <title>Browser Use QA A</title>
  <body>
    <input id="file" type="file" />
    <p>session-a</p>
  </body>
</html>
HTML
cat > "$RUN_DIR/session-b.html" <<'HTML'
<html>
  <title>Browser Use QA B</title>
  <body><p>session-b</p></body>
</html>
HTML

set +e
python3 -m http.server "$PROBE_PORT" --directory "$RUN_DIR" > "$RUN_DIR/http-server.log" 2>&1 &
SERVER_PID=$!
set -e

cleanup() {
	browser_use --session dt-qa-probe-a close >/dev/null 2>&1 || true
	browser_use --session dt-qa-probe-b close >/dev/null 2>&1 || true
	if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
		kill "$SERVER_PID" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT

sleep 1
if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
	write_report "blocked" "tooling-limitation" "Could not start local HTTP probe server on port $PROBE_PORT. See \`http-server.log\`."
	exit 0
fi

browser_use_open --session dt-qa-probe-a open "http://127.0.0.1:$PROBE_PORT/session-a.html" > "$RUN_DIR/open-a.txt" 2>&1
browser_use_open --session dt-qa-probe-b open "http://127.0.0.1:$PROBE_PORT/session-b.html" > "$RUN_DIR/open-b.txt" 2>&1
browser_use sessions > "$RUN_DIR/sessions.txt" 2>&1 || true
browser_use --session dt-qa-probe-a --json state > "$RUN_DIR/state-a.json" 2>&1
browser_use --session dt-qa-probe-b --json state > "$RUN_DIR/state-b.json" 2>&1

INPUT_INDEX="$(python3 - "$RUN_DIR/state-a.json" <<'PY'
import json
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read()
payload = json.loads(text)
raw = payload.get("data", {}).get("_raw_text", "")
match = re.search(r"\[(\d+)\]<input\b[^>]*type=file", raw)
if match:
    print(match.group(1))
PY
)"

if [[ -z "$INPUT_INDEX" ]]; then
	write_report "blocked" "tooling-limitation" "Browser Use session state did not expose the file input index. See \`state-a.json\`."
	exit 0
fi

browser_use --session dt-qa-probe-a upload "$INPUT_INDEX" "$UPLOAD_FILE" > "$RUN_DIR/upload.txt" 2>&1
browser_use --session dt-qa-probe-a --json eval 'document.querySelector("input[type=file]").files[0]?.name' > "$RUN_DIR/upload-eval.json" 2>&1

UPLOADED_NAME="$(python3 - "$RUN_DIR/upload-eval.json" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
print(payload.get("data", {}).get("result") or "")
PY
)"

if [[ "$UPLOADED_NAME" == "$(basename "$UPLOAD_FILE")" ]]; then
	write_report "pass" "none" "Browser Use CLI exposed independent named sessions and uploaded \`$UPLOAD_FILE\` through indexed element \`$INPUT_INDEX\`. See \`sessions.txt\`, \`state-a.json\`, and \`upload-eval.json\`."
else
	write_report "blocked" "tooling-limitation" "Browser Use CLI opened sessions but upload verification failed. Expected \`$(basename "$UPLOAD_FILE")\`, got \`${UPLOADED_NAME:-empty}\`. See \`upload.txt\` and \`upload-eval.json\`."
fi
