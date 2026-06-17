#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RUN_DIR="$REPO_ROOT/.local/qa-runs/isolated-env-validation"
CHECK_AUTH_MAILPIT=1
CHECK_FIXTURES=1

usage() {
	cat >&2 <<'USAGE'
Usage: scripts/qa/validate-isolated-env.sh [run-dir] [options]

Validates that the current worktree's isolated local dev instance is safe and
ready for QA. Start and seed the instance first:

  scripts/qa/env.sh up
  scripts/qa/env.sh reset
  scripts/qa/validate-isolated-env.sh

Options:
  --skip-auth-mailpit  Do not send a local Auth recovery email through Mailpit.
  --skip-fixtures      Do not run the QA fixture SQL check.
  -h, --help           Show this help.
USAGE
}

if [[ $# -gt 0 && "${1:-}" != --* ]]; then
	RUN_DIR="$1"
	shift
fi

while [[ $# -gt 0 ]]; do
	case "$1" in
		--skip-auth-mailpit)
			CHECK_AUTH_MAILPIT=0
			shift
			;;
		--skip-fixtures)
			CHECK_FIXTURES=0
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "Unknown option: $1" >&2
			usage
			exit 1
			;;
	esac
done

mkdir -p "$RUN_DIR"
REPORT="$RUN_DIR/report.md"
SUMMARY="$RUN_DIR/summary.json"

ENV_FILE="$("$REPO_ROOT/scripts/dev/isolated-supabase.sh" env)"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

fail() {
	local message="$1"
	cat >"$REPORT" <<EOF
# Isolated Env Validation

- Status: \`fail\`
- Category: \`qa-platform-gap\`
- Reason: $message

EOF
	printf '{"status":"fail","category":"qa-platform-gap","reason":%s}\n' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$message")" >"$SUMMARY"
	echo "$message" >&2
	exit 1
}

require_local_url() {
	local name="$1"
	local value="$2"
	case "$value" in
		http://127.0.0.1:*|http://localhost:*|postgresql://postgres:postgres@127.0.0.1:*|postgresql://postgres:postgres@localhost:*)
			;;
		*)
			fail "$name must point at a local isolated endpoint, got: $value"
			;;
	esac
}

require_nonempty() {
	local name="$1"
	local value="$2"
	if [[ -z "$value" ]]; then
		fail "$name must be set"
	fi
}

check_url() {
	local label="$1"
	local url="$2"
	local expected="${3:-200}"
	local status
	status="$(curl -fsS -o /dev/null -w '%{http_code}' "$url" || true)"
	if [[ "$status" != "$expected" ]]; then
		fail "$label not ready at $url (status: ${status:-curl-failed})"
	fi
	printf '%s ready: %s\n' "$label" "$url"
}

require_nonempty DEADTREES_ISOLATED_SLUG "${DEADTREES_ISOLATED_SLUG:-}"
require_nonempty DEADTREES_PORT_BASE "${DEADTREES_PORT_BASE:-}"
require_nonempty SUPABASE_PROJECT_ID "${SUPABASE_PROJECT_ID:-}"
require_nonempty COMPOSE_PROJECT_NAME "${COMPOSE_PROJECT_NAME:-}"
require_nonempty PLAYWRIGHT_BASE_URL "${PLAYWRIGHT_BASE_URL:-}"
require_nonempty VITE_LOCAL_API_URL "${VITE_LOCAL_API_URL:-}"
require_nonempty SUPABASE_URL "${SUPABASE_URL:-}"
require_nonempty SUPABASE_DB_URL "${SUPABASE_DB_URL:-}"
require_nonempty LOCAL_MAILPIT_HTTP_PORT "${LOCAL_MAILPIT_HTTP_PORT:-}"
require_nonempty LOCAL_DATA_ROOT "${LOCAL_DATA_ROOT:-}"

require_local_url PLAYWRIGHT_BASE_URL "$PLAYWRIGHT_BASE_URL"
require_local_url VITE_LOCAL_API_URL "$VITE_LOCAL_API_URL"
require_local_url SUPABASE_URL "$SUPABASE_URL"
require_local_url SUPABASE_DB_URL "$SUPABASE_DB_URL"

case "$COMPOSE_PROJECT_NAME" in
	deadtrees-test-"$DEADTREES_ISOLATED_SLUG")
		;;
	*)
		fail "COMPOSE_PROJECT_NAME does not match isolated slug: $COMPOSE_PROJECT_NAME vs $DEADTREES_ISOLATED_SLUG"
		;;
esac

case "$SUPABASE_PROJECT_ID" in
	deadwood-api-"$DEADTREES_ISOLATED_SLUG")
		;;
	*)
		fail "SUPABASE_PROJECT_ID does not match isolated slug: $SUPABASE_PROJECT_ID vs $DEADTREES_ISOLATED_SLUG"
		;;
esac

check_url "Supabase Auth" "${SUPABASE_URL}/auth/v1/settings"
check_url "Local API" "${VITE_LOCAL_API_URL%/}/"
check_url "Mailpit" "http://127.0.0.1:${LOCAL_MAILPIT_HTTP_PORT}/"
check_url "Frontend" "${PLAYWRIGHT_BASE_URL%/}/"

if [[ "$CHECK_FIXTURES" == "1" ]]; then
	psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$REPO_ROOT/scripts/qa/check-fixtures.sql" >"$RUN_DIR/fixtures.txt"
fi

if [[ "$CHECK_AUTH_MAILPIT" == "1" ]]; then
	if ! "$REPO_ROOT/scripts/qa/check-auth-mailpit.sh" >"$RUN_DIR/auth-mailpit.txt" 2>"$RUN_DIR/auth-mailpit.err"; then
		python3 - "$RUN_DIR/auth-mailpit.txt" "http://127.0.0.1:${LOCAL_MAILPIT_HTTP_PORT}" "${QA_AUTH_RECOVERY_EMAIL:-qa-contributor-local@example.com}" <<'PY' || fail "Auth/Mailpit recovery check failed; see auth-mailpit.txt and auth-mailpit.err"
import json
import sys
from urllib.request import urlopen

out_path = sys.argv[1]
mailpit_url = sys.argv[2].rstrip("/")
email = sys.argv[3].lower()

with urlopen(f"{mailpit_url}/api/v1/messages", timeout=5) as response:
    payload = json.load(response)

def addresses(message):
    values = []
    for field in ("To", "Cc", "Bcc"):
        entries = message.get(field) or []
        for entry in entries:
            if isinstance(entry, str):
                values.append(entry)
            elif isinstance(entry, dict):
                values.extend(str(entry.get(key, "")) for key in ("Address", "Mailbox", "Name"))
    return " ".join(values).lower()

for message in payload.get("messages") or []:
    subject = str(message.get("Subject", "")).lower()
    if email in addresses(message) and ("recover" in subject or "reset" in subject or "password" in subject):
        with open(out_path, "a", encoding="utf-8") as handle:
            handle.write(f"Existing Mailpit recovery email ready for {email}: {message.get('ID')}\n")
        raise SystemExit(0)

raise SystemExit(1)
PY
	fi
fi

python3 - "$SUMMARY" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

keys = [
    "DEADTREES_ISOLATED_SLUG",
    "DEADTREES_PORT_BASE",
    "SUPABASE_PROJECT_ID",
    "SUPABASE_URL",
    "SUPABASE_DB_URL",
    "PLAYWRIGHT_BASE_URL",
    "VITE_LOCAL_API_URL",
    "LOCAL_MAILPIT_HTTP_PORT",
    "LOCAL_DATA_ROOT",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_NETWORK_NAME",
]
payload = {
    "status": "pass",
    "category": "none",
    "validated_at": datetime.now(timezone.utc).isoformat(),
    "env": {key: os.environ.get(key) for key in keys},
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
    handle.write("\n")
PY

cat >"$REPORT" <<EOF
# Isolated Env Validation

- Status: \`pass\`
- Category: \`none\`
- Slug: \`${DEADTREES_ISOLATED_SLUG}\`
- Port base: \`${DEADTREES_PORT_BASE}\`
- Frontend: \`${PLAYWRIGHT_BASE_URL}\`
- API: \`${VITE_LOCAL_API_URL}\`
- Supabase: \`${SUPABASE_URL}\`
- Database: \`${SUPABASE_DB_URL}\`
- Mailpit: \`http://127.0.0.1:${LOCAL_MAILPIT_HTTP_PORT}/\`
- Compose project: \`${COMPOSE_PROJECT_NAME}\`
- Supabase project: \`${SUPABASE_PROJECT_ID}\`
- Fixture check: \`${CHECK_FIXTURES}\`
- Auth/Mailpit check: \`${CHECK_AUTH_MAILPIT}\`

The isolated local dev instance is reachable, local-only, seeded, and ready for
QA work.
EOF

echo "$REPORT"
