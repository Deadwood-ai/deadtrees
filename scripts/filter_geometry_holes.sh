#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'USAGE'
Usage:
  scripts/filter_geometry_holes.sh LABEL_ID [--table forest_cover|deadwood] [--apply] [--min-area-m2 M2]
  scripts/filter_geometry_holes.sh --all [--table forest_cover|deadwood] [--apply] [--min-area-m2 M2]

Removes sub-threshold interior rings (holes) from stored model-prediction polygons.
Runs a measured dry run by default. Pass --apply only after reviewing the metrics.

  LABEL_ID         Process a single label. Defaults to --table forest_cover.
  --all            Sweep every model_prediction label across all datasets. Without
                   --table this covers BOTH forest_cover and deadwood layers.
  --table LAYER    forest_cover (v2_forest_cover_geometries) or
                   deadwood (v2_deadwood_geometries).
  --min-area-m2 N  Minimum hole area to keep, in square metres (default: 0.1).

Connection:
  By default this runs against the local Supabase Postgres container
  "supabase_db_deadwood-api". Set DB_CONTAINER to override it (e.g. supabase-db).

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
table=""        # empty => default later (single: forest_cover; --all: both)
min_area_m2="0.1"
apply="0"

if [[ "$1" == "--all" ]]; then
	all="1"
else
	label_id="$1"
fi
shift

while [[ $# -gt 0 ]]; do
	case "$1" in
		--apply)
			apply="1"; shift ;;
		--all)
			all="1"; shift ;;
		--table)
			table="${2:?Missing value for --table}"; shift 2 ;;
		--min-area-m2)
			min_area_m2="${2:?Missing value for --min-area-m2}"; shift 2 ;;
		-h|--help)
			usage; exit 0 ;;
		*)
			echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
	esac
done

# Map a layer name to (table, label_data) used for enumeration.
table_for_layer() {
	case "$1" in
		forest_cover) echo "public.v2_forest_cover_geometries" ;;
		deadwood)     echo "public.v2_deadwood_geometries" ;;
		*) echo "Unknown --table value: $1 (use forest_cover or deadwood)" >&2; exit 2 ;;
	esac
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
sql_file="${script_dir}/sql/filter_geometry_holes.sql"

run_psql() {
	if [[ -n "${DATABASE_URL:-}" ]]; then
		psql "${DATABASE_URL}" "$@"
	else
		local db_container="${DB_CONTAINER:-supabase_db_deadwood-api}"
		docker exec -i "${db_container}" psql -U postgres -d postgres "$@"
	fi
}

run_one() {
	local target_table="$1" lid="$2"
	echo "=== ${target_table} label ${lid} ==="
	local psql_vars=(
		-v ON_ERROR_STOP=1
		-v "target_table=${target_table}"
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

# Process every model_prediction label for a given layer, across all datasets.
run_layer_all() {
	local layer="$1"
	local target_table label_data
	target_table="$(table_for_layer "${layer}")"
	label_data="${layer}"  # layer name matches label_data enum value
	local enumerate_sql="SELECT id FROM public.v2_labels WHERE label_data = '${label_data}' AND label_source = 'model_prediction' AND coalesce(is_active, true) ORDER BY id;"
	mapfile -t label_ids < <(run_psql -tA -c "${enumerate_sql}")
	local count=0
	for lid in "${label_ids[@]}"; do
		[[ -z "${lid}" ]] && continue
		run_one "${target_table}" "${lid}"
		count=$((count + 1))
	done
	echo ">>> ${layer}: processed ${count} label(s)."
}

if [[ "${all}" == "1" ]]; then
	if [[ -n "${table}" ]]; then
		run_layer_all "${table}"
	else
		run_layer_all forest_cover
		run_layer_all deadwood
	fi
else
	run_one "$(table_for_layer "${table:-forest_cover}")" "${label_id}"
fi
