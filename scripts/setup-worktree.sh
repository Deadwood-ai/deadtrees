#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

DEFAULT_COMPOSE_PROJECT_NAME="deadtrees-test"
SHARED_ROOT=""
LINK_SHARED=true
INSTALL_FRONTEND=true
INSTALL_PYTHON=true
ENSURE_ASSETS=true

usage() {
  cat <<'EOF'
Usage: scripts/setup-worktree.sh [options]

Prepare a Dead Trees git worktree so it can run frontend, API, and processor tests
without duplicating the local Supabase database or heavy asset directories.

Options:
  --shared-root PATH       Use PATH as the canonical checkout for shared assets/data
  --no-link-shared         Keep local assets/data/.local instead of symlinking
  --skip-frontend-install  Do not run npm --prefix frontend ci
  --skip-python-install    Do not create/update venv or install deadtrees-cli
  --skip-assets            Do not download missing test assets
  -h, --help               Show this help
EOF
}

log() {
  printf '[setup-worktree] %s\n' "$*"
}

die() {
  printf '[setup-worktree] ERROR: %s\n' "$*" >&2
  exit 1
}

relative_to_repo_root() {
  python3 - "$REPO_ROOT" "$1" <<'PY'
from pathlib import Path
import sys

repo_root = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).resolve()

try:
    print(target.relative_to(repo_root))
except ValueError:
    print(target)
PY
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shared-root)
      [[ $# -ge 2 ]] || die "--shared-root requires a path"
      SHARED_ROOT="$2"
      shift 2
      ;;
    --no-link-shared)
      LINK_SHARED=false
      shift
      ;;
    --skip-frontend-install)
      INSTALL_FRONTEND=false
      shift
      ;;
    --skip-python-install)
      INSTALL_PYTHON=false
      shift
      ;;
    --skip-assets)
      ENSURE_ASSETS=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

detect_default_shared_root() {
  local first_worktree
  first_worktree="$(git -C "$REPO_ROOT" worktree list --porcelain | awk '/^worktree / {print substr($0, 10); exit}')"
  if [[ -n "$first_worktree" ]]; then
    printf '%s\n' "$first_worktree"
  fi
}

ensure_file_from_example() {
  local target="$1"
  local example="$2"

  if [[ -e "$target" ]]; then
    return
  fi

  cp "$example" "$target"
  log "Created $(relative_to_repo_root "$target") from example"
}

ensure_env_line() {
  local file="$1"
  local key="$2"
  local value="$3"

  if [[ ! -f "$file" ]]; then
    touch "$file"
  fi

  if grep -Eq "^${key}=" "$file"; then
    return
  fi

  printf '\n%s=%s\n' "$key" "$value" >>"$file"
  log "Added ${key} to $(relative_to_repo_root "$file")"
}

dir_is_empty() {
  local path="$1"
  [[ -d "$path" ]] && [[ -z "$(find "$path" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]
}

link_shared_path() {
  local relative_path="$1"
  local source_path="$SHARED_ROOT/$relative_path"
  local target_path="$REPO_ROOT/$relative_path"

  if [[ "$SHARED_ROOT" == "$REPO_ROOT" ]]; then
    return
  fi

  if [[ ! -e "$source_path" ]]; then
    log "Shared path missing, skipping link: $relative_path"
    return
  fi

  mkdir -p "$(dirname "$target_path")"

  if [[ -L "$target_path" ]]; then
    if [[ "$(readlink "$target_path")" == "$source_path" ]]; then
      return
    fi
    rm "$target_path"
  elif [[ -d "$target_path" ]] && dir_is_empty "$target_path"; then
    rmdir "$target_path"
  elif [[ -e "$target_path" ]]; then
    log "Keeping existing local path: $relative_path"
    return
  fi

  ln -s "$source_path" "$target_path"
  log "Linked $relative_path -> $source_path"
}

ensure_python_env() {
  if [[ ! -d "$REPO_ROOT/venv" ]]; then
    python3 -m venv "$REPO_ROOT/venv"
    log "Created venv"
  fi

  "$REPO_ROOT/venv/bin/python" -m pip install --upgrade pip
  "$REPO_ROOT/venv/bin/pip" install -e "$REPO_ROOT/deadtrees-cli[test]"
}

ensure_frontend_deps() {
  npm --prefix "$REPO_ROOT/frontend" ci
}

ensure_assets_and_keys() {
  local need_assets=false
  local need_processor_assets=false
  local need_ssh=false

  [[ -f "$REPO_ROOT/assets/test_data/test-data.tif" ]] || need_assets=true
  [[ -f "$REPO_ROOT/assets/test_data/test-data-small.tif" ]] || need_assets=true
  [[ -f "$REPO_ROOT/assets/models/segformer_b5_full_epoch_100.safetensors" ]] || need_assets=true
  [[ -f "$REPO_ROOT/assets/gadm/gadm_410.gpkg" ]] || need_assets=true

  [[ -f "$REPO_ROOT/assets/biom/terres_ecosystems.gpkg" ]] || need_processor_assets=true
  [[ -d "$REPO_ROOT/assets/pheno/modispheno_aggregated_normalized_filled.zarr" ]] || need_processor_assets=true
  [[ -f "$REPO_ROOT/assets/test_data/worldview_uint16_crop.tif" ]] || need_processor_assets=true

  [[ -f "$REPO_ROOT/.local/ssh/processing-to-storage" ]] || need_ssh=true
  [[ -f "$REPO_ROOT/.local/ssh/processing-to-storage.pub" ]] || need_ssh=true

  if [[ "$need_assets" == true ]]; then
    make -C "$REPO_ROOT" download-assets
  fi

  if [[ "$need_processor_assets" == true ]]; then
    make -C "$REPO_ROOT" download-processor-assets
  fi

  if [[ "$need_ssh" == true ]]; then
    make -C "$REPO_ROOT" setup-local-test-ssh
  fi
}

require_command git
require_command python3
require_command npm
require_command make

if [[ -z "$SHARED_ROOT" ]]; then
  SHARED_ROOT="$(detect_default_shared_root)"
fi

if [[ -z "$SHARED_ROOT" ]]; then
  SHARED_ROOT="$REPO_ROOT"
fi

[[ -d "$SHARED_ROOT" ]] || die "Shared root does not exist: $SHARED_ROOT"

log "Repo root: $REPO_ROOT"
log "Shared root: $SHARED_ROOT"

git -C "$REPO_ROOT" submodule update --init --recursive

ensure_file_from_example "$REPO_ROOT/.env" "$REPO_ROOT/.env.example"
ensure_file_from_example "$REPO_ROOT/frontend/.env.local" "$REPO_ROOT/frontend/.env.local.example"
ensure_env_line "$REPO_ROOT/.env" "COMPOSE_PROJECT_NAME" "$DEFAULT_COMPOSE_PROJECT_NAME"

if [[ "$LINK_SHARED" == true ]]; then
  link_shared_path "assets"
  link_shared_path "data"
  link_shared_path ".local/ssh"
fi

if [[ "$INSTALL_PYTHON" == true ]]; then
  ensure_python_env
fi

if [[ "$INSTALL_FRONTEND" == true ]]; then
  ensure_frontend_deps
fi

if [[ "$ENSURE_ASSETS" == true ]]; then
  ensure_assets_and_keys
fi

cat <<EOF

Worktree setup complete.

What this prepared:
  - repo env files
  - stable Docker compose project name (${DEFAULT_COMPOSE_PROJECT_NAME})
  - git submodules
  - per-worktree Python CLI environment
  - per-worktree frontend dependencies
  - shared heavy paths where available (assets, data, .local/ssh)

Typical next steps:
  source "$REPO_ROOT/venv/bin/activate"
  deadtrees dev start
  deadtrees dev test api
  deadtrees dev test processor
  npm --prefix frontend test

Notes:
  - The local Supabase stack still needs to be running separately on port 54321.
  - deadtrees dev start/test will reuse the single Docker compose project name above,
    so one worktree can take over the shared test containers without duplicating them.
EOF
