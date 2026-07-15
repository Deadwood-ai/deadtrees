#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PROFILE="qa-full"
PARALLEL="4"
DRY_RUN=0
NO_SEED=0
RUN_DIR=""
PLAYBOOKS=()
PERSONA_FILTER=""
BROWSER_FILTER=""
MUTATION_LEVEL_FILTER=""
FIXTURE_PACKS=()
AGENT_BROWSER_SURFACE="browser"
AGENT_MODEL="gpt-5.5 low"
FOCUS=""
VISIBLE_BROWSER=0
BROWSER_ONLY=0

usage() {
	cat >&2 <<'USAGE'
Usage: scripts/qa/run-agent-qa.sh [options]

Options:
  --profile <name>       Fixture profile to seed/check, default qa-full
  --parallel <n>         Number of worker prompt files, default 4
  --playbook <id>        Restrict to a playbook id; may be repeated
  --persona <text>       Restrict to playbooks whose persona contains text
  --browser <name>       Restrict to playbooks with browser, chrome, or computer-use
  --mutation-level <lvl> Restrict to read-only or local-write
  --fixture-pack <name>  Restrict to playbooks requiring a fixture pack; may repeat
  --agent-browser-surface <browser|chrome>
                         Browser automation surface for generated worker prompts
  --agent-model <text>   Agent/model hint to include in worker prompts, default gpt-5.5 low
  --focus <text>         Additional feature-specific QA focus for workers
  --visible-browser      Mark generated workers for live in-app Browser execution
  --browser-only         Require bundled Browser for every UI interaction
  --dry-run              Generate manifest/prompts without readiness or seed
  --no-seed              Skip fixture seeding for non-dry runs
  --run-dir <path>       Override output directory
  -h, --help             Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--profile)
			PROFILE="${2:-}"
			shift 2
			;;
		--parallel)
			PARALLEL="${2:-}"
			shift 2
			;;
		--playbook)
			PLAYBOOKS+=("${2:-}")
			shift 2
			;;
		--persona)
			PERSONA_FILTER="${2:-}"
			shift 2
			;;
		--browser)
			BROWSER_FILTER="${2:-}"
			shift 2
			;;
		--mutation-level)
			MUTATION_LEVEL_FILTER="${2:-}"
			shift 2
			;;
		--fixture-pack)
			FIXTURE_PACKS+=("${2:-}")
			shift 2
			;;
		--agent-browser-surface)
			AGENT_BROWSER_SURFACE="${2:-}"
			shift 2
			;;
		--agent-model)
			AGENT_MODEL="${2:-}"
			shift 2
			;;
		--focus)
			FOCUS="${2:-}"
			shift 2
			;;
		--visible-browser)
			VISIBLE_BROWSER=1
			shift
			;;
		--browser-only)
			BROWSER_ONLY=1
			VISIBLE_BROWSER=1
			shift
			;;
		--dry-run)
			DRY_RUN=1
			shift
			;;
		--no-seed)
			NO_SEED=1
			shift
			;;
		--run-dir)
			RUN_DIR="${2:-}"
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

if [[ -z "$PROFILE" ]]; then
	echo "--profile must not be empty." >&2
	exit 1
fi
if ! [[ "$PARALLEL" =~ ^[1-9][0-9]*$ ]]; then
	echo "--parallel must be a positive integer." >&2
	exit 1
fi
case "$AGENT_BROWSER_SURFACE" in
	browser|chrome)
		;;
	*)
		echo "--agent-browser-surface must be one of: browser, chrome" >&2
		exit 1
		;;
esac
if [[ "$BROWSER_ONLY" == "1" && "$AGENT_BROWSER_SURFACE" != "browser" ]]; then
	echo "--browser-only requires --agent-browser-surface browser" >&2
	exit 1
fi

ENV_FILE="${DEADTREES_ISOLATED_ENV_FILE:-$REPO_ROOT/.local/supabase/current.env}"
if [[ -f "$ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
fi

for command in python3; do
	if ! command -v "$command" >/dev/null 2>&1; then
		echo "Missing required command: $command" >&2
		exit 1
	fi
done

"$REPO_ROOT/scripts/qa/lint-playbooks.sh" >/dev/null

if [[ "$DRY_RUN" == "0" ]]; then
	for command in curl psql; do
		if ! command -v "$command" >/dev/null 2>&1; then
			echo "Missing required command: $command" >&2
			exit 1
		fi
	done

	if [[ "$NO_SEED" == "0" ]]; then
		"$REPO_ROOT/scripts/qa/seed.sh" "$PROFILE"
	fi

	check_url() {
		local label="$1"
		local url="$2"
		local status
		status="$(curl -fsS -o /dev/null -w '%{http_code}' "$url" || true)"
		if [[ "$status" != "200" ]]; then
			echo "$label is not ready at $url (status: ${status:-curl-failed})" >&2
			exit 1
		fi
	}

	check_url "Supabase Auth" "${SUPABASE_URL:-http://127.0.0.1:54321}/auth/v1/settings"
	check_url "Local API" "${VITE_LOCAL_API_URL:-http://localhost:8080/api/v1}/"
	check_url "Frontend" "${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:${PLAYWRIGHT_PORT:-5173}}/"
fi

if [[ -z "$RUN_DIR" ]]; then
	RUN_DIR="$REPO_ROOT/.local/qa-runs/$(date -u '+%Y%m%dT%H%M%SZ')"
elif [[ "$RUN_DIR" != /* ]]; then
	RUN_DIR="$REPO_ROOT/$RUN_DIR"
fi
mkdir -p "$RUN_DIR"

PLAYBOOK_CSV=""
if [[ "${#PLAYBOOKS[@]}" -gt 0 ]]; then
	PLAYBOOK_CSV="$(IFS=,; echo "${PLAYBOOKS[*]}")"
fi
FIXTURE_PACK_CSV=""
if [[ "${#FIXTURE_PACKS[@]}" -gt 0 ]]; then
	FIXTURE_PACK_CSV="$(IFS=,; echo "${FIXTURE_PACKS[*]}")"
fi

python3 - "$REPO_ROOT" "$RUN_DIR" "$PROFILE" "$PARALLEL" "$DRY_RUN" "$PLAYBOOK_CSV" "$ENV_FILE" "$PERSONA_FILTER" "$BROWSER_FILTER" "$MUTATION_LEVEL_FILTER" "$FIXTURE_PACK_CSV" "$AGENT_BROWSER_SURFACE" "$AGENT_MODEL" "$FOCUS" "$VISIBLE_BROWSER" "$BROWSER_ONLY" <<'PY'
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

repo_root = Path(sys.argv[1])
run_dir = Path(sys.argv[2])
profile = sys.argv[3]
parallel = int(sys.argv[4])
dry_run = sys.argv[5] == "1"
selected_csv = sys.argv[6]
env_file = Path(sys.argv[7])
persona_filter = sys.argv[8].strip().lower()
browser_filter = sys.argv[9].strip()
mutation_level_filter = sys.argv[10].strip()
fixture_pack_filters = [item for item in sys.argv[11].split(",") if item]
agent_browser_surface = sys.argv[12].strip()
agent_model = sys.argv[13].strip() or "gpt-5.5 low"
focus = sys.argv[14].strip()
visible_browser = sys.argv[15] == "1"
browser_only = sys.argv[16] == "1"
playbook_dir = repo_root / "docs" / "qa" / "playbooks"


def resolve_chrome_client_path() -> str:
    configured = os.environ.get("CODEX_CHROME_CLIENT_PATH")
    if configured:
        path = Path(configured).expanduser()
        if path.exists():
            return str(path)
        raise RuntimeError(f"CODEX_CHROME_CLIENT_PATH does not exist: {path}")

    def version_key(path: Path) -> tuple[int, tuple[int, ...], str]:
        name = path.parent.parent.name
        if re.fullmatch(r"\d+(?:\.\d+)*", name):
            return (1, tuple(int(part) for part in name.split(".")), name)
        return (0, (), name)

    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
    candidates = sorted(
        codex_home.glob("plugins/cache/openai-bundled/chrome/*/scripts/browser-client.mjs"),
        key=version_key,
    )
    for path in reversed(candidates):
        if path.exists():
            return str(path)
    raise RuntimeError(
        "Chrome client script not found. Install/enable the Chrome plugin or set CODEX_CHROME_CLIENT_PATH."
    )


def parse_metadata(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    match = re.search(r"```yaml\n(.*?)\n```", text, re.DOTALL)
    if not match:
        raise ValueError(f"{path} has no yaml metadata block")
    data: dict[str, object] = {}
    current_list_key: str | None = None
    for raw_line in match.group(1).splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            continue
        if line.startswith("  - "):
            if current_list_key is None:
                raise ValueError(f"{path} has list item without key: {line}")
            data.setdefault(current_list_key, [])
            assert isinstance(data[current_list_key], list)
            data[current_list_key].append(line[4:].strip())
            continue
        current_list_key = None
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value:
            if value in {"true", "false"}:
                data[key] = value == "true"
            else:
                data[key] = value
        else:
            data[key] = []
            current_list_key = key
    return data


all_playbooks = []
for path in sorted(playbook_dir.glob("*.md")):
    if path.name in {"README.md", "TEMPLATE.md"}:
        continue
    metadata = parse_metadata(path)
    all_playbooks.append(
        {
            "id": metadata["id"],
            "persona": metadata["persona"],
            "fixture_packs": metadata["fixture_packs"],
            "browser": metadata["browser"],
            "parallel_safe": metadata["parallel_safe"],
            "mutation_level": metadata["mutation_level"],
            "resource_locks": metadata.get("resource_locks", []),
            "routes": metadata["routes"],
            "path": str(path.relative_to(repo_root)),
        }
    )

def resource_locks_for(playbook: dict[str, object]) -> list[str]:
    locks: set[str] = set(str(lock) for lock in playbook.get("resource_locks", []))
    if not playbook["parallel_safe"]:
        locks.add("serial:non-parallel")

    if playbook["mutation_level"] == "read-only":
        return sorted(locks)

    for route in playbook["routes"]:
        for dataset_id in re.findall(r"\b(9[1-9][0-9]{3})\b", str(route)):
            locks.add(f"dataset:{dataset_id}")

    if not locks and playbook["id"] == "auth-shell":
        locks.add("auth:mailpit")
    if not locks and playbook["mutation_level"] != "read-only":
        locks.add(f"playbook:{playbook['id']}")
    return sorted(locks)

for playbook in all_playbooks:
    playbook["resource_locks"] = resource_locks_for(playbook)

selected_ids = [item for item in selected_csv.split(",") if item] if selected_csv else []
if selected_ids:
    by_id = {item["id"]: item for item in all_playbooks}
    missing = [playbook_id for playbook_id in selected_ids if playbook_id not in by_id]
    if missing:
        raise SystemExit(f"Unknown playbook id(s): {', '.join(missing)}")
    playbooks = [by_id[playbook_id] for playbook_id in selected_ids]
else:
    playbooks = all_playbooks

if persona_filter:
    playbooks = [
        item
        for item in playbooks
        if persona_filter in str(item["persona"]).lower()
    ]
if browser_filter:
    playbooks = [item for item in playbooks if item["browser"] == browser_filter]
if mutation_level_filter:
    playbooks = [
        item
        for item in playbooks
        if item["mutation_level"] == mutation_level_filter
    ]
if fixture_pack_filters:
    filter_set = set(fixture_pack_filters)
    playbooks = [
        item
        for item in playbooks
        if filter_set.intersection(set(item["fixture_packs"]))
    ]

if not playbooks:
    raise SystemExit("No playbooks matched the requested filters.")

chrome_client_path = resolve_chrome_client_path() if agent_browser_surface == "chrome" else ""

worker_count = min(parallel, len(playbooks)) if playbooks else 1
workers = [
    {"id": f"worker-{idx:02d}", "playbooks": [], "resource_locks": []}
    for idx in range(1, worker_count + 1)
]
lock_owners: dict[str, dict[str, object]] = {}

for idx, playbook in enumerate(playbooks):
    locks = set(playbook["resource_locks"])
    overlapping_workers = []
    seen_worker_ids = set()
    for lock in locks:
        if lock not in lock_owners:
            continue
        owner = lock_owners[lock]
        owner_id = id(owner)
        if owner_id in seen_worker_ids:
            continue
        seen_worker_ids.add(owner_id)
        overlapping_workers.append(owner)
    if overlapping_workers:
        worker = overlapping_workers[0]
        for other in overlapping_workers[1:]:
            if other is worker:
                continue
            worker["playbooks"].extend(other["playbooks"])
            merged_locks = set(worker["resource_locks"])
            merged_locks.update(other["resource_locks"])
            worker["resource_locks"] = sorted(merged_locks)
            other["playbooks"] = []
            other["resource_locks"] = []
            for lock in merged_locks:
                lock_owners[lock] = worker
    else:
        worker = min(workers, key=lambda item: len(item["playbooks"]))

    worker["playbooks"].append(playbook)
    worker_locks = set(worker["resource_locks"])
    worker_locks.update(locks)
    worker["resource_locks"] = sorted(worker_locks)
    for lock in locks:
        lock_owners[lock] = worker

workers = [worker for worker in workers if worker["playbooks"]]
for idx, worker in enumerate(workers, start=1):
    worker["id"] = f"worker-{idx:02d}"
worker_count = len(workers)

generated_at = datetime.now(timezone.utc).isoformat()
frontend_url = os.environ.get("PLAYWRIGHT_BASE_URL") or f"http://127.0.0.1:{os.environ.get('PLAYWRIGHT_PORT', '5173')}"
api_url = os.environ.get("VITE_LOCAL_API_URL", "http://localhost:8080/api/v1")
supabase_url = os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321")
mailpit_url = (
    f"http://127.0.0.1:{os.environ['LOCAL_MAILPIT_HTTP_PORT']}"
    if os.environ.get("LOCAL_MAILPIT_HTTP_PORT")
    else "http://127.0.0.1:54324"
)

env_summary = {
    "generated_at": generated_at,
    "dry_run": dry_run,
    "profile": profile,
    "env_file": str(env_file),
    "frontend_url": frontend_url,
    "api_url": api_url,
    "supabase_url": supabase_url,
    "mailpit_url": mailpit_url,
    "local_data_root": os.environ.get("LOCAL_DATA_ROOT"),
    "compose_project_name": os.environ.get("COMPOSE_PROJECT_NAME"),
    "compose_network_name": os.environ.get("COMPOSE_NETWORK_NAME"),
}
(run_dir / "env-summary.json").write_text(json.dumps(env_summary, indent=2) + "\n", encoding="utf-8")

manifest = {
    "generated_at": generated_at,
    "profile": profile,
    "dry_run": dry_run,
    "parallel": parallel,
    "filters": {
        "playbooks": selected_ids,
        "persona": persona_filter or None,
        "browser": browser_filter or None,
        "mutation_level": mutation_level_filter or None,
        "fixture_packs": fixture_pack_filters,
    },
    "agent_browser_surface": agent_browser_surface,
    "agent_model": agent_model,
    "visible_browser": visible_browser,
    "browser_only": browser_only,
    "focus": focus or None,
    "worker_count": worker_count,
    "playbook_count": len(playbooks),
    "workers": workers,
}
(run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

for worker in workers:
    worker_dir = run_dir / worker["id"]
    result_path = run_dir / f"{worker['id']}.result.md"
    (worker_dir / "screenshots").mkdir(parents=True, exist_ok=True)
    prompt_path = run_dir / f"{worker['id']}.prompt.md"
    playbook_lines = "\n".join(
        f"- `{item['id']}`: `{item['path']}` ({item['persona']}, {item['mutation_level']}; locks: {', '.join(item['resource_locks']) or 'none'})"
        for item in worker["playbooks"]
    )
    worker_lock_lines = "\n".join(f"- `{lock}`" for lock in worker["resource_locks"]) or "- none"
    focus_block = (
        f"""
## Feature-Specific Focus

In addition to the standard assigned playbooks, explicitly test this current
feature/change when it is visible in the app:

{focus}

If the focus is too vague to verify directly, record `needs-human-review` with
the missing signal instead of inventing extra checks.
"""
        if focus
        else ""
    )
    live_viewing_block = (
        """
## Live Viewing

This is an operator-visible manual QA run.

- Use the in-app Browser, obtain its `visibility` capability, and call
  `set(true)` before opening the first assigned route.
- Keep the watchable journey in the bundled Browser. Do not switch it to
  Browser Use, Chrome, or terminal Playwright.
- Keep the Browser visible while navigating, clicking, typing, and cancelling
  forms so the operator can watch the journey in real time.
- Wait for the relevant rendered state after each action. Do not race through
  controls merely to finish faster.
- Do not hide the Browser or finalize its tabs until all assigned manual
  playbooks are complete and the result file has been written.
- Shell setup, validation, and non-browser diagnostics are supporting tools;
  do not substitute them for the visible manual journey.
"""
        if visible_browser and agent_browser_surface == "browser"
        else ""
    )
    browser_execution_rules = (
        """- Use the bundled in-app Browser for every UI action and assertion.
- Do not use Browser Use, Chrome, Computer Use, standalone Chromium, terminal
  Playwright, or repository Playwright probes.
- Use Browser-supported file chooser and download events for upload/download
  playbooks. If Browser cannot operate a required control, report the affected
  playbook as `blocked` with category `tooling-limitation`; do not switch tools.
- Use shell commands only for environment setup/reset/validation, non-browser
  diagnostics, evidence aggregation, and teardown."""
        if browser_only
        else f"""- Use the built-in Browser for ordinary route/locator checks unless a playbook explicitly says otherwise.
- Do not use Browser Use default Chromium as primary evidence for real-app rendering unless `scripts/qa/browser-use-real-app-probe.sh` classifies it as `pass` for this route.
- Use Browser Use CLI for per-worker session isolation or file-upload flows only when the selected backend has current DOM and screenshot evidence.
- To make Browser Use visible for a human observer, run it in headed mode with either `--headed` or `BROWSER_USE_HEADED=1`.
- Example headed Browser Use probe: `scripts/qa/browser-use-cli-probe.sh {worker_dir.relative_to(repo_root)}/browser-use-probe --exercise-upload --headed`.
- Example headed worker session: `uvx --from browser-use browser-use --headed --session {worker['id']} open {frontend_url}`.
- Use `scripts/qa/playwright-upload-probe.sh` as the deterministic upload fallback."""
    )
    common_result_contract = f"""## Result Contract

Write your result summary to `{result_path.relative_to(repo_root)}` with:

- `Status: pass|fail|blocked|needs-human-review`
- one section per playbook using heading `## <playbook-id>`
- `Status: ...`
- `Category: none|qa-platform-gap|fixture-gap|product-bug|tooling-limitation|needs-design-decision`
- exact evidence: URL, locator/test-id state, auth identity, console errors summary, and artifact paths
- concise findings
- follow-up issue suggestions
"""

    if agent_browser_surface == "chrome":
        prompt = f"""# {worker['id']} DeadTrees Chrome QA Prompt

You are a QA subagent executing DeadTrees local agent QA playbooks.

Recommended agent: {agent_model}. Follow the script mechanically. Do not
improvise browser tooling.

## Environment

- Frontend: {frontend_url}
- API: {api_url}
- Supabase: {supabase_url}
- Mailpit: {mailpit_url}
- Local data root: {os.environ.get("LOCAL_DATA_ROOT") or "not configured"}
- Fixture profile: {profile}
- Artifact directory: `{worker_dir.relative_to(repo_root)}`

## Assigned Playbooks

{playbook_lines}

## Worker Data Locks

{worker_lock_lines}
{focus_block}
## Chrome-Only Browser Rules

- Use the Chrome plugin / `chrome:control-chrome` surface only.
- Do not use terminal Playwright, standalone Chromium, the in-app Browser, or web search.
- Do not use Computer Use unless Chrome attach reports Chrome is unavailable; if used, use it only to foreground/open Chrome, then retry Chrome plugin and report it.
- If Chrome plugin attachment cannot be proven, mark the worker `blocked`.
- Do not run setup, restart services, reseed, or mutate production.
- Do not submit upload forms unless the assigned playbook explicitly requires a local write and the step is part of the current approved QA run.
- Treat any production API/Supabase/storage request as a failure signal. Public static/media URLs to `data2.deadtrees.earth` should be reported explicitly.

## Required Chrome Bootstrap

Run this through the Node REPL `js` tool. If a `const` name is already declared,
use `var` or fresh names rather than resetting blindly.

```js
const {{ setupBrowserRuntime }} = await import("{chrome_client_path}");
await setupBrowserRuntime({{ globals: globalThis }});
globalThis.browser = await agent.browsers.get("extension");
```

Prove Chrome attachment before QA:

- `browser.user.openTabs()` returns a count, or
- `browser.tabs.new()` creates a tab and `tab.url()` after navigation is the expected local URL.

## Login And Identity Rules

- Contributor: `qa-contributor-local@example.com` / `DeadTreesQA-Local-1!`
- Auditor: `qa-auditor-local@example.com` / `DeadTreesQA-Local-1!`
- PRIWA field user: use the contributor account; it has the seeded
  `qa-priwa-project` membership.
- After every login or account switch, verify the visible account identity before checking role-specific pages.
- Use scoped submit selectors, for example `form button[type="submit"]`, when sign-in buttons are ambiguous.
- If identity cannot be proven, mark the affected playbook `blocked`.

## Upload Mechanism

For Chrome upload checks, use the file chooser path. Do not use
`locator.setInputFiles` and do not click the hidden file input directly.
The generic browser API reference may only list `waitForEvent("download")`,
but the Chrome file-management documentation supports the `filechooser` event;
do not classify upload as unsupported solely from the generic API reference.

```js
const chooserPromise = tab.playwright.waitForEvent("filechooser");
await tab.playwright.locator(".ant-upload.ant-upload-btn").click();
const chooser = await chooserPromise;
await chooser.setFiles([
  "{repo_root}/frontend/test/fixtures/geotiff/upload-validation/rgb-real-crop.tif",
]);
```

Required upload evidence:

- `filechooser opened=true`
- `setFiles=ok`
- `rgb-real-crop.tif visible=true`
- `form submitted=false` unless explicitly approved for the playbook

## Multi-Tab Rule

Chrome same-profile multi-tab checks are allowed for read-only checks. Keep
local-write playbooks serial unless their resource locks are disjoint and the
playbook explicitly allows it.

## Evidence Discipline

- Keep output compact and evidence-based.
- Do not paste full DOM snapshots, full body text, large logs, or screenshots.
- Store screenshots and raw artifacts under your artifact directory only when needed.
- Capture focused evidence: current URL, relevant locator state, auth identity, console errors only, network target summary, and one screenshot only for visual failure.
- For each playbook, report `pass`, `fail`, `blocked`, or `needs-human-review`.
- For each non-pass finding, include one category: `qa-platform-gap`, `fixture-gap`, `product-bug`, `tooling-limitation`, or `needs-design-decision`.

{common_result_contract}
"""
    else:
        prompt = f"""# {worker['id']} DeadTrees Local QA Prompt

You are a QA subagent executing DeadTrees local agent QA playbooks.

## Environment

- Frontend: {frontend_url}
- API: {api_url}
- Supabase: {supabase_url}
- Mailpit: {mailpit_url}
- Local data root: {os.environ.get("LOCAL_DATA_ROOT") or "not configured"}
- Fixture profile: {profile}
- Artifact directory: `{worker_dir.relative_to(repo_root)}`

## Assigned Playbooks

{playbook_lines}

## Worker Data Locks

{worker_lock_lines}
{focus_block}
{live_viewing_block}

## Rules

{browser_execution_rules}
- Keep browser/auth state isolated from other workers when the selected tool supports it.
- Keep output compact and evidence-based.
- Do not use production URLs, production credentials, or production data.
- Store screenshots and raw artifacts under your artifact directory.
- Capture only focused evidence: current URL, relevant locator state, console errors, network/API status, and one screenshot when visual evidence is needed.
- For each playbook, report `pass`, `fail`, `blocked`, or `needs-human-review`.
- For each non-pass finding, include one category: `qa-platform-gap`, `fixture-gap`, `product-bug`, `tooling-limitation`, or `needs-design-decision`.

{common_result_contract}
"""
    prompt_path.write_text(prompt, encoding="utf-8")
    result_path.write_text(
        f"# {worker['id']} Result\n\nStatus: pending\n\n", encoding="utf-8"
    )

report_lines = [
    "# DeadTrees Local Agent QA Run",
    "",
    f"- Generated at: `{generated_at}`",
    f"- Profile: `{profile}`",
    f"- Dry run: `{str(dry_run).lower()}`",
    f"- Playbooks: `{len(playbooks)}`",
    f"- Workers: `{worker_count}`",
    f"- Frontend: `{frontend_url}`",
    f"- API: `{api_url}`",
    f"- Supabase: `{supabase_url}`",
    "",
    "## Worker Prompts",
    "",
]
for worker in workers:
    report_lines.append(f"- `{worker['id']}.prompt.md` ({len(worker['playbooks'])} playbooks)")
report_lines.extend(["", "## Playbook Status", ""])
for playbook in playbooks:
    report_lines.append(f"- `{playbook['id']}`: pending")
report_lines.extend(
    [
        "",
        "## Notes",
        "",
        "This runner prepares the manifest, worker prompts, artifact directories, and report skeleton. It does not launch Codex subagents from the shell.",
        "",
    ]
)
(run_dir / "report.md").write_text("\n".join(report_lines), encoding="utf-8")

print(run_dir)
PY
