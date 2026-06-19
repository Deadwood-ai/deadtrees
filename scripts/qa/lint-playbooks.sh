#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLAYBOOK_DIR="$REPO_ROOT/docs/qa/playbooks"

python3 - "$PLAYBOOK_DIR" <<'PY'
import re
import sys
from pathlib import Path

playbook_dir = Path(sys.argv[1])

required_keys = {
    "id",
    "persona",
    "fixture_packs",
    "browser",
    "parallel_safe",
    "mutation_level",
    "routes",
}
required_sections = [
    "## Purpose",
    "## Preconditions",
    "## Steps",
    "## Expected Observations",
    "## Failure Signals",
    "## Evidence To Capture",
]
allowed_browsers = {"browser", "chrome", "computer-use"}
allowed_mutation_levels = {"read-only", "local-write"}


def parse_metadata(text: str) -> dict[str, object]:
    match = re.search(r"```yaml\n(.*?)\n```", text, re.DOTALL)
    if not match:
        raise ValueError("missing yaml metadata block")

    data: dict[str, object] = {}
    current_list_key: str | None = None
    for raw_line in match.group(1).splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            continue
        if line.startswith("  - "):
            if current_list_key is None:
                raise ValueError(f"list item without key: {line}")
            data.setdefault(current_list_key, [])
            assert isinstance(data[current_list_key], list)
            data[current_list_key].append(line[4:].strip())
            continue
        current_list_key = None
        if ":" not in line:
            raise ValueError(f"invalid metadata line: {line}")
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


def fail(path: Path, message: str) -> None:
    print(f"{path.relative_to(playbook_dir.parent.parent)}: {message}", file=sys.stderr)


errors = 0
playbooks = [
    path
    for path in sorted(playbook_dir.glob("*.md"))
    if path.name not in {"README.md", "TEMPLATE.md"}
]

if not playbooks:
    print("No playbooks found.", file=sys.stderr)
    sys.exit(1)

ids: set[str] = set()
for path in playbooks:
    text = path.read_text(encoding="utf-8")
    try:
        metadata = parse_metadata(text)
    except ValueError as exc:
        fail(path, str(exc))
        errors += 1
        continue

    missing = sorted(required_keys - set(metadata))
    if missing:
        fail(path, f"missing metadata keys: {', '.join(missing)}")
        errors += 1

    playbook_id = metadata.get("id")
    if playbook_id != path.stem:
        fail(path, f"id must match filename stem: expected {path.stem!r}, got {playbook_id!r}")
        errors += 1
    elif isinstance(playbook_id, str):
        if playbook_id in ids:
            fail(path, f"duplicate id: {playbook_id}")
            errors += 1
        ids.add(playbook_id)

    browser = metadata.get("browser")
    if browser not in allowed_browsers:
        fail(path, f"browser must be one of {sorted(allowed_browsers)}, got {browser!r}")
        errors += 1

    mutation_level = metadata.get("mutation_level")
    if mutation_level not in allowed_mutation_levels:
        fail(path, f"mutation_level must be one of {sorted(allowed_mutation_levels)}, got {mutation_level!r}")
        errors += 1

    if not isinstance(metadata.get("parallel_safe"), bool):
        fail(path, "parallel_safe must be true or false")
        errors += 1

    for list_key in ("fixture_packs", "routes"):
        value = metadata.get(list_key)
        if not isinstance(value, list) or not value:
            fail(path, f"{list_key} must be a non-empty list")
            errors += 1

    for section in required_sections:
        if section not in text:
            fail(path, f"missing required section {section}")
            errors += 1

expected_ids = {
    "public-home-discovery",
    "public-archive-detail-download",
    "public-releases-publications",
    "auth-shell",
    "contributor-upload-process",
    "contributor-profile-datasets",
    "auditor-access-guards",
    "auditor-queue-triage",
    "auditor-final-assessment",
    "labels-corrections-map",
    "priwa-field-workflow",
    "negative-empty-error-states",
}
missing_expected = sorted(expected_ids - ids)
if missing_expected:
    print(f"Missing expected playbooks: {', '.join(missing_expected)}", file=sys.stderr)
    errors += 1

if errors:
    sys.exit(1)

print(f"Checked {len(playbooks)} playbooks.")
PY
