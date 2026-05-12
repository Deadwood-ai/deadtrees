#!/usr/bin/env bash
set -euo pipefail

TARGETS=(api shared processor deadtrees-cli scripts)
RULES=(E9 F63 F7 F82)

if [[ -n "${PYTHON:-}" ]]; then
	RUFF=("$PYTHON" -m ruff)
elif command -v ruff >/dev/null 2>&1; then
	RUFF=(ruff)
else
	RUFF=(python3 -m ruff)
fi

"${RUFF[@]}" check "${TARGETS[@]}" --select "$(IFS=,; echo "${RULES[*]}")" "$@"
