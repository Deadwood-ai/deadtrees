#!/usr/bin/env bash
set -euo pipefail

AST_GREP_VERSION="${AST_GREP_VERSION:-0.42.2}"

exec npx --yes --package "@ast-grep/cli@${AST_GREP_VERSION}" sg scan --config sgconfig.yml --report-style short "$@"

