#!/usr/bin/env bash
# Render one Mermaid source file with a pinned Mermaid CLI and fail on parse/render errors.
set -euo pipefail

if [[ $# -ne 1 || ! -s "$1" ]]; then
	echo "Usage: scripts/validate-mermaid.sh <file.mmd>" >&2
	exit 64
fi

output_dir="$(mktemp -d)"
trap 'rm -rf "$output_dir"' EXIT

npx --yes @mermaid-js/mermaid-cli@11.12.0 -i "$1" -o "$output_dir/out.svg" --quiet
[[ -s "$output_dir/out.svg" ]]
