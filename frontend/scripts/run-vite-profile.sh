#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$FRONTEND_DIR/.." && pwd)"

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
if [[ "$PROFILE" == "local" ]]; then
  if [[ -n "${DEADTREES_ISOLATED_ENV_FILE:-}" ]]; then
    if [[ ! -f "$DEADTREES_ISOLATED_ENV_FILE" ]]; then
      echo "Missing isolated env file: $DEADTREES_ISOLATED_ENV_FILE" >&2
      exit 1
    fi
    # shellcheck disable=SC1090
    source "$DEADTREES_ISOLATED_ENV_FILE"
  elif [[ -f "$REPO_ROOT/.local/supabase/current.env" ]]; then
    # shellcheck disable=SC1091
    source "$REPO_ROOT/.local/supabase/current.env"
  fi
fi
set +a

export VITE_MODE="${VITE_MODE:-$DEFAULT_MODE}"

echo "Starting Vite with profile '$PROFILE' using $(basename "$ENV_FILE") (VITE_MODE=$VITE_MODE)"

if [[ -n "${LOCAL_FRONTEND_PORT:-}" ]]; then
  has_port_arg=0
  for arg in "$@"; do
    if [[ "$arg" == "--port" || "$arg" == --port=* ]]; then
      has_port_arg=1
      break
    fi
  done
  if [[ "$has_port_arg" == "0" ]]; then
    exec ./node_modules/.bin/vite "$@" --port "$LOCAL_FRONTEND_PORT"
  fi
fi

exec ./node_modules/.bin/vite "$@"
