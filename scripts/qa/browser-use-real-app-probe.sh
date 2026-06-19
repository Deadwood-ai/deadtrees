#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RUN_DIR="$REPO_ROOT/.local/qa-runs/browser-use-real-app-probe"
if [[ $# -gt 0 && "${1:-}" != --* ]]; then
	RUN_DIR="$1"
	shift
fi

ROUTE="/dataset"
PROFILE_NAME="${BROWSER_USE_PROFILE:-Person 1}"
RUN_PROFILE=1
RUN_DEFAULT=1
BROWSER_USE_HEADED="${BROWSER_USE_HEADED:-1}"

usage() {
	cat >&2 <<'USAGE'
Usage: scripts/qa/browser-use-real-app-probe.sh [run-dir] [options]

Compares real app rendering across:
  1. Playwright control
  2. Browser Use default Chromium
  3. Browser Use real Chrome profile

Options:
  --route <path>       Route to test, default /dataset.
  --profile <name>     Browser Use Chrome profile, default "Person 1".
  --no-profile         Skip the real Chrome profile check.
  --no-default         Skip the default Browser Use Chromium check.
  --headless           Do not pass --headed when opening Browser Use sessions.
  --headed             Pass --headed when opening Browser Use sessions, default.
  -h, --help           Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--route)
			ROUTE="${2:-}"
			shift 2
			;;
		--profile)
			PROFILE_NAME="${2:-}"
			shift 2
			;;
		--no-profile)
			RUN_PROFILE=0
			shift
			;;
		--no-default)
			RUN_DEFAULT=0
			shift
			;;
		--headless)
			BROWSER_USE_HEADED=0
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

if [[ -z "$ROUTE" || "$ROUTE" != /* ]]; then
	echo "--route must be an absolute frontend path such as /dataset" >&2
	exit 1
fi

ENV_FILE="${DEADTREES_ISOLATED_ENV_FILE:-$REPO_ROOT/.local/supabase/current.env}"
if [[ -f "$ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
fi

FRONTEND_URL="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:${PLAYWRIGHT_PORT:-5173}}"
TARGET_URL="${FRONTEND_URL%/}${ROUTE}"

mkdir -p "$RUN_DIR"
REPORT="$RUN_DIR/report.md"
SUMMARY_JSON="$RUN_DIR/summary.json"

export UV_CACHE_DIR="${UV_CACHE_DIR:-$REPO_ROOT/.local/uv-cache}"
export UV_TOOL_DIR="${UV_TOOL_DIR:-$REPO_ROOT/.local/uv-tools}"
mkdir -p "$UV_CACHE_DIR" "$UV_TOOL_DIR"

if ! command -v uvx >/dev/null 2>&1; then
	cat >"$REPORT" <<EOF
# Browser Use Real App Probe

- Status: \`blocked\`
- Category: \`tooling-limitation\`

\`uvx\` is unavailable, so Browser Use CLI cannot be executed.
EOF
	echo "$REPORT"
	exit 0
fi

if [[ ! -d "$REPO_ROOT/frontend/node_modules/playwright" ]]; then
	echo "Missing frontend/node_modules/playwright. Run: bash scripts/setup-worktree.sh --skip-assets" >&2
	exit 1
fi

BROWSER_USE=(uvx --from browser-use browser-use)
HEADED_ARGS=()
if [[ "$BROWSER_USE_HEADED" == "1" ]]; then
	HEADED_ARGS=(--headed)
fi

cleanup_sessions=()
cleanup() {
	local session
	for session in "${cleanup_sessions[@]:-}"; do
		"${BROWSER_USE[@]}" --session "$session" close >/dev/null 2>&1 || true
	done
}
trap cleanup EXIT

run_playwright_control() {
	node - "$REPO_ROOT" "$TARGET_URL" "$RUN_DIR/playwright" <<'NODE'
const fs = require("fs");
const path = require("path");
const repoRoot = process.argv[2];
const targetUrl = process.argv[3];
const outPrefix = process.argv[4];
const { chromium } = require(path.join(repoRoot, "frontend/node_modules/playwright"));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", msg => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", err => errors.push(String(err.message || err)));
  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30000 });
  await page.screenshot({ path: `${outPrefix}.png`, fullPage: false });
  const result = await page.evaluate(() => ({
    href: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 700),
    rootLen: document.querySelector("#root")?.innerHTML.length ?? null,
    datasetArchivePage: !!document.querySelector("[data-testid=dataset-archive-page]"),
    bodyLen: document.body.innerHTML.length,
  }));
  fs.writeFileSync(`${outPrefix}.json`, JSON.stringify({ success: true, result, errors }, null, 2));
  await browser.close();
})().catch(err => {
  fs.writeFileSync(`${outPrefix}.json`, JSON.stringify({ success: false, error: String(err && err.stack || err) }, null, 2));
  process.exitCode = 1;
});
NODE
}

run_browser_use_case() {
	local label="$1"
	local profile="$2"
	local session
	session="dt-${label}-$$"
	cleanup_sessions+=("$session")

	local -a open_command=("${BROWSER_USE[@]}")
	if [[ "${#HEADED_ARGS[@]}" -gt 0 ]]; then
		open_command+=("${HEADED_ARGS[@]}")
	fi
	if [[ -n "$profile" ]]; then
		open_command+=(--profile "$profile")
	fi
	open_command+=(--session "$session" open "$TARGET_URL")

	"${open_command[@]}" >"$RUN_DIR/${label}-open.txt" 2>&1 || true
	sleep 6
	"${BROWSER_USE[@]}" --session "$session" screenshot "$RUN_DIR/${label}.png" >"$RUN_DIR/${label}-screenshot.txt" 2>&1 || true
	"${BROWSER_USE[@]}" --session "$session" --json eval '({
  href: location.href,
  title: document.title,
  text: document.body.innerText.slice(0, 700),
  rootLen: document.querySelector("#root")?.innerHTML.length ?? null,
  datasetArchivePage: !!document.querySelector("[data-testid=dataset-archive-page]"),
  bodyLen: document.body.innerHTML.length
})' >"$RUN_DIR/${label}.json" 2>&1 || true
	"${BROWSER_USE[@]}" --session "$session" state >"$RUN_DIR/${label}-state.txt" 2>&1 || true
}

run_playwright_control
if [[ "$RUN_DEFAULT" == "1" ]]; then
	run_browser_use_case "browser-use-default" ""
fi
if [[ "$RUN_PROFILE" == "1" ]]; then
	run_browser_use_case "browser-use-profile" "$PROFILE_NAME"
fi

python3 - "$RUN_DIR" "$SUMMARY_JSON" "$REPORT" "$TARGET_URL" "$PROFILE_NAME" "$BROWSER_USE_HEADED" <<'PY'
import json
import os
import sys
from pathlib import Path

run_dir = Path(sys.argv[1])
summary_path = Path(sys.argv[2])
report_path = Path(sys.argv[3])
target_url = sys.argv[4]
profile_name = sys.argv[5]
headed = sys.argv[6]

def load_json(path: Path):
    if not path.exists():
        return {"success": False, "error": "missing artifact"}
    try:
        text = path.read_text(encoding="utf-8")
        return json.loads(text)
    except Exception as exc:
        return {"success": False, "error": f"{type(exc).__name__}: {exc}", "raw": path.read_text(encoding="utf-8", errors="replace")[:1000]}

def normalize_browser_use(payload):
    if not payload.get("success"):
        return payload
    data = payload.get("data", {})
    return {"success": True, "result": data.get("result")}

def classify(payload):
    result = payload.get("result") or {}
    if not payload.get("success"):
        return "blocked"
    root_len = result.get("rootLen")
    has_testid = bool(result.get("datasetArchivePage"))
    text = result.get("text") or ""
    if isinstance(root_len, int) and root_len > 1000 and has_testid and "Drone Archive" in text:
        return "pass"
    if root_len == 0 or text == "":
        return "fail"
    return "needs-human-review"

cases = {
    "playwright": load_json(run_dir / "playwright.json"),
}
if (run_dir / "browser-use-default.json").exists():
    cases["browser-use-default"] = normalize_browser_use(load_json(run_dir / "browser-use-default.json"))
if (run_dir / "browser-use-profile.json").exists():
    cases["browser-use-profile"] = normalize_browser_use(load_json(run_dir / "browser-use-profile.json"))

for name, payload in cases.items():
    payload["classification"] = classify(payload)
    screenshot = run_dir / f"{name}.png"
    payload["screenshot"] = str(screenshot) if screenshot.exists() else None
    payload["screenshot_bytes"] = screenshot.stat().st_size if screenshot.exists() else None

summary = {
    "target_url": target_url,
    "headed": headed == "1",
    "profile_name": profile_name,
    "cases": cases,
}
summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

default_status = cases.get("browser-use-default", {}).get("classification", "not-run")
profile_status = cases.get("browser-use-profile", {}).get("classification", "not-run")
playwright_status = cases["playwright"]["classification"]

if playwright_status != "pass":
    overall = "blocked"
    category = "qa-platform-gap"
elif default_status == "pass":
    overall = "pass"
    category = "none"
elif profile_status == "pass":
    overall = "needs-human-review"
    category = "tooling-limitation"
else:
    overall = "fail"
    category = "tooling-limitation"

lines = [
    "# Browser Use Real App Probe",
    "",
    f"- Status: `{overall}`",
    f"- Category: `{category}`",
    f"- Target URL: `{target_url}`",
    f"- Headed: `{str(headed == '1').lower()}`",
    f"- Chrome profile: `{profile_name}`",
    "",
    "## Case Summary",
    "",
]

for name, payload in cases.items():
    result = payload.get("result") or {}
    lines.extend([
        f"### `{name}`",
        "",
        f"- Classification: `{payload.get('classification')}`",
        f"- Href: `{result.get('href')}`",
        f"- Title: `{result.get('title')}`",
        f"- Root length: `{result.get('rootLen')}`",
        f"- Dataset archive test id: `{result.get('datasetArchivePage')}`",
        f"- Body text preview: `{(result.get('text') or '')[:180]}`",
        f"- Screenshot: `{payload.get('screenshot')}`",
        f"- Screenshot bytes: `{payload.get('screenshot_bytes')}`",
        "",
    ])
    if payload.get("error"):
        lines.extend([f"- Error: `{payload['error']}`", ""])

lines.extend([
    "## Interpretation",
    "",
])
if playwright_status == "pass" and default_status == "fail" and profile_status == "pass":
    lines.append("Default Browser Use Chromium does not render this real Vite app reliably, but Browser Use attached to the real Chrome profile does. Use Playwright/native browser as the primary QA oracle; use Browser Use profile mode only when visible/session-isolated operation is needed.")
elif playwright_status == "pass" and default_status == "pass":
    lines.append("Default Browser Use rendered the real app route consistently with the Playwright control in this run.")
elif playwright_status != "pass":
    lines.append("The Playwright control did not render the app route, so this run cannot judge Browser Use reliability.")
else:
    lines.append("Browser Use did not match the Playwright control. Treat Browser Use as untrusted for real app QA until this is explained.")

report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(report_path)
PY
