#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
	cat >&2 <<'USAGE'
Usage: scripts/qa/report.sh [latest|run-dir]

Aggregates worker-*.result.md files for a local QA run and rewrites report.md.
USAGE
}

RUN_ARG="${1:-latest}"
if [[ "$RUN_ARG" == "-h" || "$RUN_ARG" == "--help" ]]; then
	usage
	exit 0
fi

if [[ "$RUN_ARG" == "latest" ]]; then
	RUN_DIR="$(find "$REPO_ROOT/.local/qa-runs" -mindepth 1 -maxdepth 1 -type d -name '20*' 2>/dev/null | sort | tail -n 1)"
	if [[ -z "$RUN_DIR" ]]; then
		echo "No timestamped QA run directories found under .local/qa-runs." >&2
		exit 1
	fi
elif [[ "$RUN_ARG" == /* ]]; then
	RUN_DIR="$RUN_ARG"
else
	RUN_DIR="$REPO_ROOT/$RUN_ARG"
fi

if [[ ! -f "$RUN_DIR/manifest.json" ]]; then
	echo "Missing manifest.json in run directory: $RUN_DIR" >&2
	exit 1
fi

python3 - "$REPO_ROOT" "$RUN_DIR" <<'PY'
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

repo_root = Path(sys.argv[1])
run_dir = Path(sys.argv[2])
manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
env_summary = json.loads((run_dir / "env-summary.json").read_text(encoding="utf-8"))

allowed_statuses = {"pass", "fail", "blocked", "needs-human-review", "pending"}
playbook_status: dict[str, str] = {
    item["id"]: "pending"
    for worker in manifest["workers"]
    for item in worker["playbooks"]
}

worker_summaries = []
for result_path in sorted(run_dir.glob("worker-*.result.md")):
    text = result_path.read_text(encoding="utf-8")
    status_match = re.search(r"^Status:\s*([A-Za-z-]+)", text, re.MULTILINE)
    worker_status = status_match.group(1).lower() if status_match else "pending"
    if worker_status not in allowed_statuses:
        worker_status = "pending"

    worker_playbook_statuses = []
    for playbook_id in playbook_status:
        patterns = [
            rf"(?im)^[-*]\s*`?{re.escape(playbook_id)}`?\s*[:\-]\s*(pass|fail|blocked|needs-human-review|pending)\b",
            rf"(?im)^##+\s*`?{re.escape(playbook_id)}`?\s*(?:[:\-]|[ ]+)\s*(pass|fail|blocked|needs-human-review|pending)\b",
        ]
        match = next((found for pattern in patterns if (found := re.search(pattern, text))), None)
        if match:
            status = match.group(1).lower()
            playbook_status[playbook_id] = status
            worker_playbook_statuses.append(status)

    if worker_playbook_statuses:
        if any(status == "fail" for status in worker_playbook_statuses):
            worker_status = "fail"
        elif any(status == "blocked" for status in worker_playbook_statuses):
            worker_status = "blocked"
        elif any(status == "needs-human-review" for status in worker_playbook_statuses):
            worker_status = "needs-human-review"
        elif all(status == "pass" for status in worker_playbook_statuses):
            worker_status = "pass"
        else:
            worker_status = "pending"

    worker_summaries.append(
        {
            "file": result_path.name,
            "status": worker_status,
            "non_empty": bool(text.strip()),
        }
    )

counts = Counter(playbook_status.values())
generated_at = datetime.now(timezone.utc).isoformat()

lines = [
    "# DeadTrees Local Agent QA Run",
    "",
    f"- Report updated at: `{generated_at}`",
    f"- Run directory: `{run_dir.relative_to(repo_root)}`",
    f"- Profile: `{manifest['profile']}`",
    f"- Dry run: `{str(manifest['dry_run']).lower()}`",
    f"- Playbooks: `{manifest['playbook_count']}`",
    f"- Workers: `{manifest['worker_count']}`",
    f"- Frontend: `{env_summary.get('frontend_url')}`",
    f"- API: `{env_summary.get('api_url')}`",
    f"- Supabase: `{env_summary.get('supabase_url')}`",
    "",
    "## Status Summary",
    "",
]
for status in ["pass", "fail", "blocked", "needs-human-review", "pending"]:
    lines.append(f"- `{status}`: {counts.get(status, 0)}")

lines.extend(["", "## Worker Results", ""])
for worker in worker_summaries:
    lines.append(f"- `{worker['file']}`: {worker['status']}")

lines.extend(["", "## Playbook Status", ""])
for playbook_id in sorted(playbook_status):
    lines.append(f"- `{playbook_id}`: {playbook_status[playbook_id]}")

lines.extend(
    [
        "",
        "## Next Actions",
        "",
        "- Review failed, blocked, and `needs-human-review` playbooks.",
        "- Turn failures or `needs-human-review` items into focused follow-up work.",
        "- Re-run affected playbooks after fixture or product fixes.",
        "",
    ]
)

(run_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")
print(run_dir / "report.md")
PY
