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

python3 - "$REPO_ROOT" "$RUN_DIR" "$PROFILE" "$PARALLEL" "$DRY_RUN" "$PLAYBOOK_CSV" "$ENV_FILE" "$PERSONA_FILTER" "$BROWSER_FILTER" "$MUTATION_LEVEL_FILTER" "$FIXTURE_PACK_CSV" <<'PY'
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
playbook_dir = repo_root / "docs" / "qa" / "playbooks"


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
            "routes": metadata["routes"],
            "path": str(path.relative_to(repo_root)),
        }
    )

def resource_locks_for(playbook: dict[str, object]) -> list[str]:
    if playbook["mutation_level"] == "read-only":
        return []

    locks: set[str] = set()
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

worker_count = min(parallel, len(playbooks)) if playbooks else 1
workers = [
    {"id": f"worker-{idx:02d}", "playbooks": [], "resource_locks": []}
    for idx in range(1, worker_count + 1)
]
lock_owners: dict[str, dict[str, object]] = {}

for idx, playbook in enumerate(playbooks):
    locks = set(playbook["resource_locks"])
    overlapping_workers = [
        lock_owners[lock]
        for lock in locks
        if lock in lock_owners
    ]
    if overlapping_workers:
        worker = overlapping_workers[0]
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
    "worker_count": worker_count,
    "playbook_count": len(playbooks),
    "workers": workers,
}
(run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

for worker in workers:
    worker_dir = run_dir / worker["id"]
    (worker_dir / "screenshots").mkdir(parents=True, exist_ok=True)
    prompt_path = run_dir / f"{worker['id']}.prompt.md"
    playbook_lines = "\n".join(
        f"- `{item['id']}`: `{item['path']}` ({item['persona']}, {item['mutation_level']}; locks: {', '.join(item['resource_locks']) or 'none'})"
        for item in worker["playbooks"]
    )
    worker_lock_lines = "\n".join(f"- `{lock}`" for lock in worker["resource_locks"]) or "- none"
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

## Rules

- Use the built-in Browser for ordinary route/locator checks unless a playbook explicitly says otherwise.
- Do not use Browser Use default Chromium as primary evidence for real-app rendering unless `scripts/qa/browser-use-real-app-probe.sh` classifies it as `pass` for this route.
- Use Browser Use CLI for per-worker session isolation or file-upload flows only when the selected backend has current DOM and screenshot evidence.
- To make Browser Use visible for a human observer, run it in headed mode with either `--headed` or `BROWSER_USE_HEADED=1`.
- Example headed Browser Use probe: `scripts/qa/browser-use-cli-probe.sh {worker_dir.relative_to(repo_root)}/browser-use-probe --exercise-upload --headed`.
- Example headed worker session: `uvx --from browser-use browser-use --headed --session {worker['id']} open {frontend_url}`.
- Use `scripts/qa/playwright-upload-probe.sh` as the deterministic upload fallback.
- Keep browser/auth state isolated from other workers when the selected tool supports it.
- Keep output compact and evidence-based.
- Do not use production URLs, production credentials, or production data.
- Store screenshots and raw artifacts under your artifact directory.
- Capture only focused evidence: current URL, relevant locator state, console errors, network/API status, and one screenshot when visual evidence is needed.
- For each playbook, report `pass`, `fail`, `blocked`, or `needs-human-review`.
- For each non-pass finding, include one category: `qa-platform-gap`, `fixture-gap`, `product-bug`, `tooling-limitation`, or `needs-design-decision`.

## Result Contract

Write your result summary to `{worker['id']}.result.md` with:

- playbook id
- status
- category, or `none` for pass
- evidence paths
- concise findings
- follow-up issue suggestions
"""
    prompt_path.write_text(prompt, encoding="utf-8")
    (run_dir / f"{worker['id']}.result.md").write_text(
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
