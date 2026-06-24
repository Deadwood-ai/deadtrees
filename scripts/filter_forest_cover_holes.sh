#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'USAGE'
Usage:
  scripts/filter_forest_cover_holes.sh LABEL_ID [--apply] [--min-area-m2 METERS2]
  scripts/filter_forest_cover_holes.sh --all   [--apply] [--min-area-m2 METERS2]

Removes sub-threshold interior rings (holes) from stored forest-cover polygons.
Runs a measured dry run by default. Pass --apply only after reviewing the metrics.

  --all            Process every combined-model (deadwood_treecover_combined_v2)
                   forest-cover label, one transaction per label.
  --min-area-m2 N  Minimum hole area to keep, in square metres (default: 0.1).

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

label_id=""
all="0"
if [[ "$1" == "--all" ]]; then
	all="1"
else
	label_id="$1"
fi
shift

min_area_m2="0.1"
apply="0"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--apply)
			apply="1"
			shift
			;;
		--all)
			all="1"
			shift
			;;
		--min-area-m2)
			min_area_m2="${2:?Missing value for --min-area-m2}"
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
sql_file="${script_dir}/sql/filter_forest_cover_holes.sql"

# psql invocation differs between a direct DATABASE_URL and the docker container.
run_psql() {
	if [[ -n "${DATABASE_URL:-}" ]]; then
		psql "${DATABASE_URL}" "$@"
	else
		local db_container="${DB_CONTAINER:-supabase_db_deadwood-api}"
		docker exec -i "${db_container}" psql -U postgres -d postgres "$@"
	fi
}

run_one() {
	local lid="$1"
	echo "=== forest-cover label ${lid} ==="
	local psql_vars=(
		-v ON_ERROR_STOP=1
		-v "label_id=${lid}"
		-v "min_area_m2=${min_area_m2}"
		-v "apply=${apply}"
	)
	if [[ -n "${DATABASE_URL:-}" ]]; then
		run_psql "${psql_vars[@]}" -f "${sql_file}"
	else
		run_psql "${psql_vars[@]}" < "${sql_file}"
	fi
}

if [[ "${all}" == "1" ]]; then
	enumerate_sql="SELECT id FROM public.v2_labels WHERE label_data = 'forest_cover' AND model_config->>'module' = 'deadwood_treecover_combined_v2' AND coalesce(is_active, true) ORDER BY id;"
	mapfile -t label_ids < <(run_psql -tA -c "${enumerate_sql}")
	if [[ ${#label_ids[@]} -eq 0 ]]; then
		echo "No combined-model forest-cover labels found." >&2
		exit 1
	fi
	echo "Processing ${#label_ids[@]} forest-cover label(s)."
	for lid in "${label_ids[@]}"; do
		[[ -z "${lid}" ]] && continue
		run_one "${lid}"
	done
else
	run_one "${label_id}"
fi
