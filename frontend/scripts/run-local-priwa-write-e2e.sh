#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$FRONTEND_DIR/.." && pwd)"

ENV_FILE="$REPO_ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  ENV_FILE="$REPO_ROOT/.env.example"
fi

for key in SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY; do
  value="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  if [[ -z "$value" ]]; then
    echo "Missing $key in $ENV_FILE; local PRIWA write E2E needs local Supabase keys." >&2
    exit 1
  fi
  export "$key=$value"
done

export E2E_LOCAL_PRIWA_WRITE=1
export PLAYWRIGHT_PORT="${PLAYWRIGHT_PORT:-5175}"

cd "$FRONTEND_DIR"
exec ./node_modules/.bin/playwright test --config playwright.local.config.ts e2e-local/priwa-field-write-flows.spec.ts
