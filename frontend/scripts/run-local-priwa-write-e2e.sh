#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$FRONTEND_DIR/.." && pwd)"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/require-isolated-write-e2e-env.sh"

export E2E_LOCAL_PRIWA_WRITE=1

cd "$FRONTEND_DIR"
exec ./node_modules/.bin/playwright test --config playwright.local.config.ts e2e-local/priwa-field-write-flows.spec.ts
