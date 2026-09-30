#!/usr/bin/env bash
# Claude Code WorktreeCreate / WorktreeRemove hook for Dead Trees.
#
#   claude-worktree.sh create   # stdin: hook JSON with "name" or "worktree_path"; stdout: path
#   claude-worktree.sh remove   # stdin: hook JSON with "worktree_path"
#
# Worktrees live under ${DEADTREES_WORKTREE_ROOT:-~/.claude/worktrees/deadtrees}/<name>,
# start detached at current origin/main (the thread names its fix/... or feat/...
# branch once it knows the task), and get the ignored local files and shared asset
# links from scripts/setup-worktree.sh. Heavy installs are left to the thread.
# Removal only touches clean worktrees whose commits are already on a remote.

set -euo pipefail

MODE="${1:-}"
WORKTREE_ROOT="${DEADTREES_WORKTREE_ROOT:-$HOME/.claude/worktrees/deadtrees}"
LOG_DIR="$WORKTREE_ROOT/.logs"
PAYLOAD="$(cat)"

json_field() {
  python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2]) or "")' "$PAYLOAD" "$1"
}

log() {
  printf '[claude-worktree] %s\n' "$*" >&2
}

main_checkout() {
  local start="${CLAUDE_PROJECT_DIR:-$(json_field cwd)}"
  local common_dir
  common_dir="$(git -C "${start:-.}" rev-parse --path-format=absolute --git-common-dir)"
  dirname "$common_dir"
}

create() {
  local name repo dest
  name="$(json_field name)"
  [[ -n "$name" ]] || name="$(basename "$(json_field worktree_path)")"
  name="$(printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '-' | sed -E 's/-+/-/g; s/^-//; s/-$//')"
  [[ -n "$name" ]] || name="thread-$(date +%Y%m%d-%H%M%S)"
  repo="$(main_checkout)"
  dest="$WORKTREE_ROOT/$name"

  mkdir -p "$LOG_DIR"
  exec 2> >(tee -a "$LOG_DIR/$name.log" >&2)
  log "$(date -u +%FT%TZ) create name=$name repo=$repo"

  if [[ -d "$dest" ]] && git -C "$dest" rev-parse --git-dir >/dev/null 2>&1; then
    log "Reusing existing worktree $dest"
    printf '%s\n' "$dest"
    return
  fi

  git -C "$repo" fetch origin main --prune >&2
  git -C "$repo" worktree add --detach "$dest" origin/main >&2

  if ! bash "$dest/scripts/setup-worktree.sh" --shared-root "$repo" --skip-git-fetch \
    --skip-assets --skip-frontend-install --skip-python-install >&2; then
    log "WARNING: setup-worktree.sh failed; rerun it inside $dest"
  fi

  printf '%s\n' "$dest"
}

remove() {
  local path
  path="$(json_field worktree_path)"
  [[ -n "$path" ]] || { log "No worktree_path in hook input"; exit 1; }

  case "$(cd "$path" 2>/dev/null && pwd -P)/" in
    "$(cd "$WORKTREE_ROOT" && pwd -P)"/*) ;;
    *) log "Refusing to remove $path: not under $WORKTREE_ROOT"; exit 1 ;;
  esac

  if [[ -x "$path/scripts/qa/env.sh" ]]; then
    (cd "$path" && scripts/qa/env.sh cleanup) >&2 || log "QA cleanup failed; continuing"
  fi

  if [[ -n "$(git -C "$path" status --porcelain --untracked-files=normal)" ]]; then
    log "Keeping $path: it has uncommitted changes"
    exit 1
  fi
  if [[ -n "$(git -C "$path" rev-list HEAD --not --remotes | head -n 1)" ]]; then
    log "Keeping $path: it has commits that are not on any remote"
    exit 1
  fi

  git -C "$path" worktree remove "$path" >&2
  log "Removed $path"
}

case "$MODE" in
  create) create ;;
  remove) remove ;;
  *) log "Usage: $0 create|remove  (hook JSON on stdin)"; exit 2 ;;
esac
