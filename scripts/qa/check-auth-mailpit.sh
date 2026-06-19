#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ALLOW_FAIL=0
if [[ "${1:-}" == "--allow-fail" ]]; then
	ALLOW_FAIL=1
fi

ENV_FILE="${DEADTREES_ISOLATED_ENV_FILE:-$REPO_ROOT/.local/supabase/current.env}"
if [[ -f "$ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
fi

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"
MAILPIT_URL="${MAILPIT_URL:-http://127.0.0.1:${LOCAL_MAILPIT_HTTP_PORT:-54324}}"
EMAIL="${QA_AUTH_RECOVERY_EMAIL:-qa-contributor-local@example.com}"
REDIRECT_TO="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:5173}/profile"

fail() {
	if [[ "$ALLOW_FAIL" == "1" ]]; then
		echo "qa-platform-gap: $*" >&2
		exit 0
	fi
	echo "$*" >&2
	exit 1
}

if [[ -z "$SUPABASE_ANON_KEY" ]]; then
	fail "SUPABASE_ANON_KEY must be set for Auth recovery check."
fi

BEFORE_IDS="$(python3 - "$MAILPIT_URL" <<'PY' || true
import json
import sys
from urllib.request import urlopen

mailpit_url = sys.argv[1].rstrip("/")
with urlopen(f"{mailpit_url}/api/v1/messages", timeout=5) as response:
    payload = json.load(response)
print(",".join(str(message.get("ID", "")) for message in payload.get("messages", []) if message.get("ID")))
PY
)"

curl -fsS -X POST \
	"$SUPABASE_URL/auth/v1/recover" \
	-H "apikey: $SUPABASE_ANON_KEY" \
	-H "Content-Type: application/json" \
	-d "{\"email\":\"$EMAIL\",\"redirect_to\":\"$REDIRECT_TO\"}" >/dev/null || fail "Supabase recovery request failed."

python3 - "$MAILPIT_URL" "$EMAIL" "$BEFORE_IDS" <<'PY' || fail "Mailpit did not receive a new recovery email for ${EMAIL}."
import json
import sys
import time
from urllib.request import urlopen

mailpit_url = sys.argv[1].rstrip("/")
email = sys.argv[2].lower()
before_ids = {item for item in sys.argv[3].split(",") if item}
deadline = time.time() + 20

def message_addresses(message):
    values = []
    for field in ("To", "Cc", "Bcc"):
        entries = message.get(field) or []
        for entry in entries:
            if isinstance(entry, str):
                values.append(entry)
            elif isinstance(entry, dict):
                values.extend(str(entry.get(key, "")) for key in ("Address", "Mailbox", "Name"))
    return " ".join(values).lower()

while time.time() < deadline:
    with urlopen(f"{mailpit_url}/api/v1/messages", timeout=5) as response:
        payload = json.load(response)
    messages = payload.get("messages") or []
    for message in messages:
        message_id = str(message.get("ID", ""))
        if message_id in before_ids:
            continue
        recipients = message_addresses(message)
        subject = str(message.get("Subject", "")).lower()
        if email in recipients and ("recover" in subject or "reset" in subject or "password" in subject):
            print(f"Mailpit recovery email ready for {email}: {message.get('ID')}")
            raise SystemExit(0)
    time.sleep(1)

raise SystemExit(1)
PY
