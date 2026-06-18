#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
	cat >&2 <<'USAGE'
Usage: scripts/qa/seed.sh <qa-base|qa-full|qa-realistic>

Seeds deterministic local-only QA data into the currently selected Supabase DB.
Source the isolated env first:

  set -a
  source "$(scripts/dev/isolated-supabase.sh env)"
  set +a
  scripts/qa/seed.sh qa-full
USAGE
}

require_local_database_url() {
	local db_url
	db_url="${SUPABASE_DB_URL:-}"

	if [[ -z "$db_url" ]]; then
		echo "SUPABASE_DB_URL must be set. Source the isolated env first." >&2
		exit 1
	fi

	case "$db_url" in
		postgresql://postgres:postgres@127.0.0.1:*|postgresql://postgres:postgres@localhost:*)
			;;
		*)
			echo "Refusing to seed non-local database URL: $db_url" >&2
			exit 1
			;;
	esac
}

PROFILE="${1:-}"
if [[ -z "$PROFILE" ]]; then
	usage
	exit 1
fi

case "$PROFILE" in
	qa-base|qa-full)
		SEED_FILES=("$REPO_ROOT/supabase/seeds/qa/qa-base.sql")
		CHECK_FILES=("$REPO_ROOT/scripts/qa/check-fixtures.sql")
		;;
	qa-realistic)
		REALISTIC_SEED_FILE="$REPO_ROOT/.local/qa-packs/realistic/qa-realistic.sql"
		if [[ ! -f "$REALISTIC_SEED_FILE" ]]; then
			echo "Missing realistic QA seed file: $REALISTIC_SEED_FILE" >&2
			echo "Run: scripts/qa/pull-realistic-fixtures.py" >&2
			exit 1
		fi
		SEED_FILES=(
			"$REPO_ROOT/scripts/qa/cleanup-realistic-fixtures.sql"
			"$REPO_ROOT/supabase/seeds/qa/qa-base.sql"
			"$REALISTIC_SEED_FILE"
		)
		CHECK_FILES=(
			"$REPO_ROOT/scripts/qa/check-fixtures.sql"
			"$REPO_ROOT/scripts/qa/check-realistic-fixtures.sql"
		)
		;;
	*)
		echo "Unknown QA seed profile: $PROFILE" >&2
		usage
		exit 1
		;;
esac

require_local_database_url

for seed_file in "${SEED_FILES[@]}"; do
	psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$seed_file"
done
"$REPO_ROOT/scripts/qa/prepare-fixtures.sh" "$PROFILE"
for check_file in "${CHECK_FILES[@]}"; do
	psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$check_file"
done
