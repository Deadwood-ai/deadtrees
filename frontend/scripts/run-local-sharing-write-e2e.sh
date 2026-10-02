#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$FRONTEND_DIR/.." && pwd)"

# Prefer the per-worktree isolated stack; fall back to the generic local env.
ISOLATED_ENV="${DEADTREES_ISOLATED_ENV_FILE:-$REPO_ROOT/.local/supabase/current.env}"
if [[ -f "$ISOLATED_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ISOLATED_ENV"
  set +a
fi

ENV_FILE="$REPO_ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  ENV_FILE="$REPO_ROOT/.env.example"
fi
for key in SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY; do
  if [[ -z "${!key:-}" ]]; then
    value="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
    if [[ -z "$value" ]]; then
      echo "Missing $key; the local sharing write E2E needs local Supabase keys." >&2
      exit 1
    fi
    export "$key=$value"
  fi
done

# Use the real CPU COG conversion, including EPSG:3857 reprojection. Copying an
# arbitrary GeoTIFF into cogs/ can pass range checks while rendering a blank map.
: "${COMPOSE_PROJECT_NAME:?Start the isolated QA environment first}"
docker exec "${COMPOSE_PROJECT_NAME}-api-test-1" python -c '
from pathlib import Path
from processor.src.cog.cog import calculate_cog
Path("/data/qa").mkdir(exist_ok=True)
calculate_cog("/app/assets/test_data/test-data-small.tif", "/data/qa/sharing-browser-cog.tif")
'

export E2E_LOCAL_SHARING_WRITE=1
export PLAYWRIGHT_PORT="${PLAYWRIGHT_PORT:-5174}"

cd "$FRONTEND_DIR"
exec ./node_modules/.bin/playwright test --config playwright.local.config.ts e2e-local/dataset-sharing-write-flows.spec.ts "$@"
