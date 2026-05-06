#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'USAGE'
Usage:
  scripts/simplify_forest_cover_label.sh LABEL_ID [--apply] [--metric-srid SRID] [--tolerance-m METERS]

Runs a measured dry run by default. Pass --apply only after reviewing the metrics.

Connection:
  By default this runs against the local Supabase Postgres container
  "supabase_db_deadwood-api". Set DB_CONTAINER to override it.

  Set DATABASE_URL to run against a direct Postgres connection instead.
USAGE
}

if [[ $# -lt 1 ]]; then
	usage >&2
	exit 2
fi

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
	usage
	exit 0
fi

label_id="$1"
shift

metric_srid="0"
tolerance_m="0.04"
apply="0"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--apply)
			apply="1"
			shift
			;;
		--metric-srid)
			metric_srid="${2:?Missing value for --metric-srid}"
			shift 2
			;;
		--tolerance-m)
			tolerance_m="${2:?Missing value for --tolerance-m}"
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "Unknown argument: $1" >&2
			usage >&2
			exit 2
			;;
	esac
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
sql_file="${script_dir}/sql/simplify_forest_cover_label.sql"

psql_vars=(
	-v ON_ERROR_STOP=1
	-v "label_id=${label_id}"
	-v "metric_srid=${metric_srid}"
	-v "tolerance_m=${tolerance_m}"
	-v "apply=${apply}"
)

if [[ -n "${DATABASE_URL:-}" ]]; then
	exec psql "${DATABASE_URL}" "${psql_vars[@]}" -f "${sql_file}"
fi

db_container="${DB_CONTAINER:-supabase_db_deadwood-api}"
exec docker exec -i "${db_container}" psql -U postgres -d postgres "${psql_vars[@]}" < "${sql_file}"
