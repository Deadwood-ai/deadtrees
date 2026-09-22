#!/usr/bin/env bash
# Rollback-only scale check; never accepts a caller-supplied database URL.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
count="${1:-10000}"
if [[ ! "$count" =~ ^[0-9]+$ ]] || ((count < 100 || count > 100000)); then
  echo "Usage: scripts/qa/benchmark-factory.sh [100..100000 datasets]" >&2
  exit 1
fi
set -a
source .local/supabase/current.env
set +a
python3 - <<'PY'
import os
from urllib.parse import urlparse
url = urlparse(os.environ['SUPABASE_DB_URL'])
if url.hostname not in ('127.0.0.1', 'localhost') or url.port in (None, 5432, 54322):
    raise SystemExit('Factory benchmark requires the isolated worktree database.')
PY
scripts/qa/validate-isolated-env.sh >/dev/null
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -v n="$count" -f scripts/qa/benchmark-factory.sql
