#!/usr/bin/env bash

# This file is sourced by the local write E2E launchers. Keep it fail-closed:
# write-capable browser tests must never fall back to a production-shaped .env.

if [[ -z "${REPO_ROOT:-}" ]]; then
  echo "REPO_ROOT must be set before sourcing require-isolated-write-e2e-env.sh." >&2
  exit 1
fi

ISOLATED_ENV_FILE="${DEADTREES_ISOLATED_ENV_FILE:-$REPO_ROOT/.local/supabase/current.env}"
if [[ ! -f "$ISOLATED_ENV_FILE" ]]; then
  echo "Missing isolated QA env: $ISOLATED_ENV_FILE" >&2
  echo "Run scripts/qa/env.sh up before local write E2E." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ISOLATED_ENV_FILE"
set +a

case "${SUPABASE_URL:-}" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    echo "Refusing write E2E: SUPABASE_URL is not local: ${SUPABASE_URL:-unset}" >&2
    exit 1
    ;;
esac

case "${PLAYWRIGHT_BASE_URL:-}" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    echo "Refusing write E2E: PLAYWRIGHT_BASE_URL is not local: ${PLAYWRIGHT_BASE_URL:-unset}" >&2
    exit 1
    ;;
esac

for key in SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY; do
  if [[ -z "${!key:-}" ]]; then
    echo "Missing $key in $ISOLATED_ENV_FILE." >&2
    exit 1
  fi
done

export DEADTREES_ISOLATED_ENV_FILE="$ISOLATED_ENV_FILE"
