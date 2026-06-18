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
allowed_categories = {
    "qa-platform-gap",
    "fixture-gap",
    "product-bug",
    "tooling-limitation",
    "needs-design-decision",
    "none",
    "uncategorized",
}
playbook_status: dict[str, str] = {
    item["id"]: "pending"
    for worker in manifest["workers"]
    for item in worker["playbooks"]
}
playbook_category: dict[str, str] = {playbook_id: "uncategorized" for playbook_id in playbook_status}

worker_summaries = []
for result_path in sorted(run_dir.glob("worker-*.result.md")):
    text = result_path.read_text(encoding="utf-8")
    status_match = re.search(r"^(?:[-*]\s*)?Status:\s*([A-Za-z-]+)", text, re.MULTILINE | re.IGNORECASE)
    worker_status = status_match.group(1).lower() if status_match else "pending"
    if worker_status not in allowed_statuses:
        worker_status = "pending"

    worker_playbook_statuses = []
    for playbook_id in playbook_status:
        heading = re.search(
            rf"(?ims)^##+\s*`?{re.escape(playbook_id)}`?.*?(?=^##+\s|\Z)",
            text,
        )
        patterns = [
            rf"(?im)^[-*]\s*`?{re.escape(playbook_id)}`?\s*[:\-]\s*(pass|fail|blocked|needs-human-review|pending)\b",
            rf"(?im)^##+\s*`?{re.escape(playbook_id)}`?\s*(?:[:\-]|[ ]+)\s*(pass|fail|blocked|needs-human-review|pending)\b",
        ]
        match = next((found for pattern in patterns if (found := re.search(pattern, text))), None)
        heading_status_match = (
            re.search(r"(?im)^(?:[-*]\s*)?status:\s*`?(pass|fail|blocked|needs-human-review|pending)`?\s*$", heading.group(0))
            if heading
            else None
        )
        if match or heading_status_match:
            status = (match or heading_status_match).group(1).lower()
            playbook_status[playbook_id] = status
            worker_playbook_statuses.append(status)

            if heading:
                category_match = re.search(
                    r"(?im)^(?:[-*]\s*)?category:\s*`?([a-z-]+|none)`?\s*$",
                    heading.group(0),
                )
                if category_match:
                    category = category_match.group(1).lower()
                    if category in allowed_categories:
                        playbook_category[playbook_id] = category
            if playbook_status[playbook_id] == "pass" and playbook_category[playbook_id] == "uncategorized":
                playbook_category[playbook_id] = "none"

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
category_counts = Counter(playbook_category.values())
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
    f"- Local data root: `{env_summary.get('local_data_root')}`",
    "",
    "## Status Summary",
    "",
]
for status in ["pass", "fail", "blocked", "needs-human-review", "pending"]:
    lines.append(f"- `{status}`: {counts.get(status, 0)}")

lines.extend(["", "## Category Summary", ""])
for category in [
    "qa-platform-gap",
    "fixture-gap",
    "product-bug",
    "tooling-limitation",
    "needs-design-decision",
    "uncategorized",
    "none",
]:
    count = category_counts.get(category, 0)
    if count:
        lines.append(f"- `{category}`: {count}")

lines.extend(["", "## Worker Results", ""])
for worker in worker_summaries:
    lines.append(f"- `{worker['file']}`: {worker['status']}")

lines.extend(["", "## Playbook Status", ""])
for playbook_id in sorted(playbook_status):
    lines.append(
        f"- `{playbook_id}`: {playbook_status[playbook_id]} "
        f"(category: {playbook_category[playbook_id]})"
    )

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
