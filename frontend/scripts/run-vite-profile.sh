#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PROFILE="${1:-}"
shift || true

case "$PROFILE" in
  local)
    ENV_FILE="$FRONTEND_DIR/.env.dev.local"
    DEFAULT_MODE="development"
    ;;
  prod)
    ENV_FILE="$FRONTEND_DIR/.env.prod.local"
    DEFAULT_MODE="production"
    ;;
  *)
    echo "Usage: bash ./scripts/run-vite-profile.sh <local|prod> [vite args...]" >&2
    exit 1
    ;;
esac

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env profile: $ENV_FILE" >&2
  echo "Create it first. See frontend/README.md for the expected setup." >&2
  exit 1
fi

cd "$FRONTEND_DIR"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export VITE_MODE="${VITE_MODE:-$DEFAULT_MODE}"

echo "Starting Vite with profile '$PROFILE' using $(basename "$ENV_FILE") (VITE_MODE=$VITE_MODE)"

exec ./node_modules/.bin/vite "$@"
