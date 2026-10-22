#!/usr/bin/env bash
# Prepare a Claude Code cloud VM (Ubuntu 24.04, root, Docker installed but not
# running) so agent sessions can run tests and scripts/qa/review-regression.sh.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${DEADTREES_CLOUD_LOG_DIR:-/tmp/deadtrees-cloud-setup}"
PW_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"

usage() {
  cat <<'EOF'
Usage: scripts/setup-cloud.sh [provision|session|compose-override]

  provision  Default. Install GDAL, ssh-keygen, the Supabase CLI, the repo venv,
             frontend node_modules and the Playwright Chromium build, and point
             Docker at the mirror.gcr.io Docker Hub mirror. Meant for the
             cloud environment's Setup script: steps run in parallel, no
             Docker images are pulled (the environment cache only keeps setups
             that finish in about 5 minutes), and it always exits 0 so a flaky
             mirror never blocks a session.
  session    Run once per session before Docker work: starts dockerd (the cache
             keeps files, not processes) and fills in any repo dependency the
             snapshot lacks. Exits non-zero if Docker does not come up.
  compose-override
             Used by scripts/dev/isolated-supabase.sh in cloud sessions: writes
             a compose override under .local/cloud that lets the api-test build
             trust the VM's TLS-intercepting egress, and prints COMPOSE_FILE.

Docker images for the QA stack (Supabase, api-test) are pulled or built by the
first scripts/qa/review-regression.sh run in a session. In cloud sessions
scripts/dev/isolated-supabase.sh pulls Supabase images from ghcr.io, because
public.ecr.aws and Docker Hub rate-limit the shared egress.
EOF
}

log() {
  printf '[setup-cloud] %s\n' "$*"
}

as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

supabase_cli_version() {
  # Keep the CLI in step with CI.
  sed -n '/supabase\/setup-cli/,/version:/s/^ *version: *//p' \
    "$REPO_ROOT/.github/workflows/api-smoke.yml" | head -n 1
}

install_apt_packages() {
  local missing=()
  command -v gdal_translate >/dev/null 2>&1 || missing+=(gdal-bin)
  command -v ssh-keygen >/dev/null 2>&1 || missing+=(openssh-client)
  if [[ ${#missing[@]} -eq 0 ]]; then
    log "apt packages already present"
    return 0
  fi
  log "Installing ${missing[*]}"
  as_root apt-get update -q &&
    DEBIAN_FRONTEND=noninteractive as_root apt-get install -y -q --no-install-recommends "${missing[@]}"
}

install_supabase_cli() {
  local version
  version="$(supabase_cli_version)"
  if [[ -z "$version" ]]; then
    log "Could not read the Supabase CLI version from api-smoke.yml"
    return 1
  fi
  if command -v supabase >/dev/null 2>&1 && [[ "$(supabase --version 2>/dev/null)" == "$version" ]]; then
    log "Supabase CLI $version already installed"
    return 0
  fi
  local tmp
  tmp="$(mktemp -d)"
  log "Installing Supabase CLI $version"
  curl -fsSL "https://github.com/supabase/cli/releases/download/v${version}/supabase_linux_amd64.tar.gz" \
    | tar -xz -C "$tmp" supabase &&
    as_root install -m 0755 "$tmp/supabase" /usr/local/bin/supabase
  local status=$?
  rm -rf "$tmp"
  return "$status"
}

install_python_env() {
  # Needs ssh-keygen for the local test SSH keys, so it runs after apt.
  bash "$REPO_ROOT/scripts/setup-worktree.sh" \
    --skip-assets --skip-frontend-install --skip-git-fetch --allow-stale-base
}

install_frontend() {
  npm --prefix "$REPO_ROOT/frontend" ci --no-audit --no-fund &&
    install_playwright_browser
}

install_playwright_browser() {
  # The image's /opt/pw-browsers build is older than the pinned @playwright/test.
  (
    cd "$REPO_ROOT/frontend" &&
      env -u PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD PLAYWRIGHT_BROWSERS_PATH="$PW_BROWSERS_PATH" \
        ./node_modules/.bin/playwright install chromium
  )
}

run_step() {
  local name="$1"
  shift
  local start=$SECONDS
  if "$@" >"$LOG_DIR/$name.log" 2>&1; then
    log "$name: ok ($((SECONDS - start))s)"
  else
    log "$name: FAILED ($((SECONDS - start))s); see $LOG_DIR/$name.log"
    return 1
  fi
}

provision() {
  mkdir -p "$LOG_DIR"
  local start=$SECONDS
  local failed=0
  local pids=()

  { run_step apt install_apt_packages; run_step python install_python_env; } &
  pids+=($!)
  run_step supabase install_supabase_cli &
  pids+=($!)
  run_step docker configure_docker_mirror &
  pids+=($!)
  run_step frontend install_frontend &
  pids+=($!)

  for pid in "${pids[@]}"; do
    wait "$pid" || failed=1
  done

  log "Provision finished in $((SECONDS - start))s"
  if ((failed)); then
    log "Some steps failed; 'scripts/setup-cloud.sh session' retries the repo steps."
  fi
  # A non-zero exit would stop the session from starting.
  return 0
}

configure_docker_mirror() {
  # Shared cloud egress gets 429 from Docker Hub; mirror.gcr.io serves the same
  # images and dockerd falls back to Docker Hub for anything it lacks.
  local config=/etc/docker/daemon.json
  if [[ -f "$config" ]] && grep -q 'registry-mirrors' "$config"; then
    log "Docker registry mirror already configured"
    return 0
  fi
  as_root mkdir -p /etc/docker
  python3 - "$config" <<'PY' | as_root tee "$config.tmp" >/dev/null || true
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
config = json.loads(path.read_text()) if path.exists() else {}
config["registry-mirrors"] = ["https://mirror.gcr.io"]
print(json.dumps(config, indent=2))
PY
  if [[ ! -s "$config.tmp" ]]; then
    as_root rm -f "$config.tmp"
    log "Could not write $config; Docker Hub pulls may hit 429"
    return 1
  fi
  as_root mv "$config.tmp" "$config"
  log "Configured Docker registry mirror mirror.gcr.io"
  # A running dockerd reloads registry-mirrors on SIGHUP.
  if docker_ready; then
    as_root pkill -HUP -x dockerd || true
  fi
}

docker_ready() {
  docker info >/dev/null 2>&1
}

start_docker() {
  if docker_ready; then
    log "Docker is running"
    return 0
  fi
  if ! command -v dockerd >/dev/null 2>&1; then
    log "dockerd is not installed"
    return 1
  fi
  mkdir -p "$LOG_DIR"
  log "Starting dockerd (log: $LOG_DIR/dockerd.log)"
  as_root nohup dockerd >"$LOG_DIR/dockerd.log" 2>&1 &
  for _ in $(seq 1 30); do
    if docker_ready; then
      log "Docker is running"
      return 0
    fi
    sleep 1
  done
  log "Docker did not start within 30s; see $LOG_DIR/dockerd.log"
  return 1
}

compose_override() {
  # Builds in the cloud VM see its TLS-intercepting egress, so pip inside the
  # api-test build needs the VM's CA bundle. Write a copy of api/Dockerfile that
  # trusts it and a compose override that uses the copy; print COMPOSE_FILE.
  local ca_bundle="${DEADTREES_CLOUD_CA_BUNDLE:-/root/.ccr/ca-bundle.crt}"
  local out_dir="$REPO_ROOT/.local/cloud"
  if [[ ! -f "$ca_bundle" ]]; then
    log "No CA bundle at $ca_bundle; using docker-compose.test.yaml unchanged" >&2
    printf '%s\n' "$REPO_ROOT/docker-compose.test.yaml"
    return 0
  fi
  mkdir -p "$out_dir"
  cp "$ca_bundle" "$out_dir/ca-bundle.crt"
  awk '
    { print }
    /^FROM / {
      print "COPY --from=cloud_ca ca-bundle.crt /usr/local/share/cloud-ca-bundle.crt"
      print "ENV PIP_CERT=/usr/local/share/cloud-ca-bundle.crt SSL_CERT_FILE=/usr/local/share/cloud-ca-bundle.crt REQUESTS_CA_BUNDLE=/usr/local/share/cloud-ca-bundle.crt CURL_CA_BUNDLE=/usr/local/share/cloud-ca-bundle.crt"
    }
  ' "$REPO_ROOT/api/Dockerfile" >"$out_dir/api.Dockerfile"
  # The VM kernel has no IPv6, so nginx cannot bind [::]:80.
  grep -v 'listen \[::\]' "$REPO_ROOT/nginx/test-conf/storage-server.conf" >"$out_dir/storage-server.conf"
  cat >"$out_dir/docker-compose.cloud.yaml" <<EOF
# Generated by scripts/setup-cloud.sh for Claude cloud sessions.
services:
  api-test:
    build:
      dockerfile: $out_dir/api.Dockerfile
      additional_contexts:
        cloud_ca: $out_dir
  nginx:
    volumes:
      - $out_dir/storage-server.conf:/etc/nginx/conf.d/storage-server.conf:ro
EOF
  printf '%s:%s\n' "$REPO_ROOT/docker-compose.test.yaml" "$out_dir/docker-compose.cloud.yaml"
}

session() {
  mkdir -p "$LOG_DIR"
  configure_docker_mirror || true
  start_docker || return 1
  command -v gdal_translate >/dev/null 2>&1 && command -v ssh-keygen >/dev/null 2>&1 \
    || run_step apt install_apt_packages || true
  command -v supabase >/dev/null 2>&1 || run_step supabase install_supabase_cli || true
  [[ -x "$REPO_ROOT/venv/bin/deadtrees" ]] || run_step python install_python_env || true
  if [[ -d "$REPO_ROOT/frontend/node_modules" ]]; then
    # A no-op when the pinned Chromium is present; retries a failed download.
    run_step playwright install_playwright_browser || true
  else
    run_step frontend install_frontend || true
  fi
  log "Ready. QA gate: scripts/qa/review-regression.sh"
}

case "${1:-provision}" in
  provision)
    provision
    ;;
  session)
    session
    ;;
  compose-override)
    compose_override
    ;;
  -h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
