#!/usr/bin/env python3
"""Create a local-only QA fixture pack from public production samples."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:
    tomllib = None


DEFAULT_DATASETS = [3813, 8034, 9810, 9837]
LOCAL_DATASET_START = 92001
LOCAL_DATASET_END = 92099
CONTRIBUTOR_ID = "00000000-0000-4000-8000-00000000a001"
AUDITOR_ID = "00000000-0000-4000-8000-00000000a002"
VIEWER_ID = "00000000-0000-4000-8000-00000000a003"
SESSION_ID = "00000000-0000-4000-8000-00000000c920"


def root() -> Path:
    return Path(__file__).resolve().parents[2]


def run(cmd: list[str], timeout: int = 120) -> str:
    result = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout, check=False)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "").strip() or f"{cmd[0]} failed")
    return result.stdout


def prod_db_url(repo: Path) -> str:
    if os.environ.get("DEADTREES_QA_PROD_DB_URL"):
        return os.environ["DEADTREES_QA_PROD_DB_URL"]

    config = repo / ".codex" / "config.toml"
    if config.exists() and tomllib is not None:
        data = tomllib.loads(config.read_text(encoding="utf-8"))
        servers = data.get("mcp_servers", {})
        ordered_servers = sorted(
            servers.items(),
            key=lambda item: 0 if "production" in item[0] else 1,
        )
        for _, server in ordered_servers:
            for arg in server.get("args", []):
                if isinstance(arg, str) and arg.startswith(("postgres://", "postgresql://")):
                    return arg

    if config.exists():
        match = re.search(r"postgres(?:ql)?://[^\"\\s]+", config.read_text(encoding="utf-8"))
        if match:
            return match.group(0)

    raise RuntimeError("Set DEADTREES_QA_PROD_DB_URL or configure .codex/config.toml")


def psql_json(db_url: str, query: str) -> list[dict[str, Any]]:
    wrapped = f"select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)::text from ({query}) q"
    return json.loads(run(["psql", db_url, "-v", "ON_ERROR_STOP=1", "-qAt", "-c", wrapped], 120).strip() or "[]")


def q(value: Any) -> str:
    if value is None:
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def qb(value: Any) -> str:
    return "true" if bool(value) else "false"


def qj(value: Any) -> str:
    return q(json.dumps(value if value is not None else {}, separators=(",", ":"))) + "::jsonb"


def qn(value: Any, default: str = "null") -> str:
    return default if value is None else str(value)


def qa(value: list[str]) -> str:
    return "array[" + ", ".join(q(item) for item in value) + "]"


def fetch(db_url: str, ids: list[int]) -> dict[str, list[dict[str, Any]]]:
    id_sql = ",".join(str(item) for item in ids)
    return {
        "datasets": psql_json(
            db_url,
            f"""
            select d.id as source_dataset_id, d.created_at, d.file_name,
                   d.license::text as license, d.platform::text as platform,
                   d.aquisition_year, d.aquisition_month, d.aquisition_day,
                   d.data_access::text as data_access,
                   s.current_status::text as current_status, s.is_upload_done,
                   s.is_ortho_done, s.is_cog_done, s.is_thumbnail_done,
                   s.is_deadwood_done, s.is_forest_cover_done, s.is_metadata_done,
                   s.is_combined_model_done,
                   exists(select 1 from dataset_audit a where a.dataset_id = d.id) as is_audited,
                   s.has_error,
                   s.is_in_audit, o.ortho_file_size, o.bbox::text as bbox,
                   c.cog_path, c.cog_file_size,
                   t.thumbnail_path, t.thumbnail_file_size,
                   coalesce(m.metadata, '{{}}'::jsonb) as metadata
            from v2_datasets d
            join v2_statuses s on s.dataset_id = d.id
            left join v2_orthos o on o.dataset_id = d.id
            left join v2_cogs c on c.dataset_id = d.id
            left join v2_thumbnails t on t.dataset_id = d.id
            left join v2_metadata m on m.dataset_id = d.id
            where d.id in ({id_sql})
            order by d.id
            """,
        ),
        "labels": psql_json(
            db_url,
            f"""
            select id as source_label_id, dataset_id as source_dataset_id,
                   label_source::text, label_type::text, label_data::text,
                   label_quality, coalesce(model_config, '{{}}'::jsonb) as model_config,
                   version
            from v2_labels
            where dataset_id in ({id_sql}) and coalesce(is_active, false)
            order by dataset_id, label_data, label_source, id
            """,
        ),
        "geometries": psql_json(
            db_url,
            f"""
            select 'deadwood' as layer_type, g.id as source_geometry_id,
                   l.dataset_id as source_dataset_id, g.label_id as source_label_id,
                   st_astext(g.geometry) as wkt, st_srid(g.geometry) as srid,
                   coalesce(g.properties, '{{}}'::jsonb) as properties,
                   g.area_m2, coalesce(g.is_deleted, false) as is_deleted
            from v2_deadwood_geometries g
            join v2_labels l on l.id = g.label_id
            where l.dataset_id in ({id_sql}) and coalesce(l.is_active, false)
            union all
            select 'forest_cover' as layer_type, g.id as source_geometry_id,
                   l.dataset_id as source_dataset_id, g.label_id as source_label_id,
                   st_astext(g.geometry) as wkt, st_srid(g.geometry) as srid,
                   coalesce(g.properties, '{{}}'::jsonb) as properties,
                   g.area_m2, coalesce(g.is_deleted, false) as is_deleted
            from v2_forest_cover_geometries g
            join v2_labels l on l.id = g.label_id
            where l.dataset_id in ({id_sql}) and coalesce(l.is_active, false)
            order by source_dataset_id, layer_type, source_geometry_id
            """,
        ),
        "corrections": psql_json(
            db_url,
            f"""
            select id as source_correction_id, geometry_id as source_geometry_id,
                   layer_type, label_id as source_label_id,
                   dataset_id as source_dataset_id, operation,
                   original_geometry_id as source_original_geometry_id,
                   review_status, reviewed_at
            from v2_geometry_corrections
            where dataset_id in ({id_sql})
            order by dataset_id, created_at, id
            """,
        ),
        "audits": psql_json(
            db_url,
            f"""
            select dataset_id as source_dataset_id, is_georeferenced,
                   has_valid_acquisition_date, has_valid_phenology,
                   deadwood_quality::text, forest_cover_quality::text,
                   aoi_done, has_cog_issue, has_thumbnail_issue,
                   has_major_issue, final_assessment, reviewed_at
            from dataset_audit
            where dataset_id in ({id_sql})
            order by dataset_id
            """,
        ),
        "flags": psql_json(
            db_url,
            f"""
            select id as source_flag_id, dataset_id as source_dataset_id,
                   is_ortho_mosaic_issue, is_prediction_issue, status
            from dataset_flags
            where dataset_id in ({id_sql})
            order by dataset_id, id
            """,
        ),
    }


def download(url: str, target: Path, refresh: bool) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 0 and not refresh:
        return
    tmp = target.with_suffix(target.suffix + ".tmp")
    run(["curl", "-fsSL", "--retry", "3", "--retry-delay", "2", "-o", str(tmp), url], 900)
    tmp.replace(target)


def require_existing_file(path: Path, reason: str) -> None:
    if not path.exists() or path.stat().st_size <= 0:
        raise RuntimeError(f"missing {reason}: {path}")


def size(path: Path, fallback: Any = 0) -> int:
    if path.exists():
        return path.stat().st_size
    try:
        return int(fallback or 0)
    except (TypeError, ValueError):
        return 0


def size_mb(path: Path, fallback: Any = 0) -> int:
    if path.exists():
        return max(1, int(path.stat().st_size / 1024 / 1024))
    try:
        return int(fallback or 0)
    except (TypeError, ValueError):
        return 0


def render_sql(data: dict[str, list[dict[str, Any]]], id_map: dict[int, int], assets: dict[int, dict[str, Any]]) -> str:
    lines = [
        "\\set ON_ERROR_STOP on",
        "",
        "begin;",
        "",
        "delete from public.dataset_flag_status_history where flag_id in (select id from public.dataset_flags where dataset_id between 92001 and 92099);",
        "delete from public.dataset_flags where dataset_id between 92001 and 92099;",
        "delete from public.dataset_audit where dataset_id between 92001 and 92099;",
        "delete from public.v2_geometry_corrections where dataset_id between 92001 and 92099;",
        "delete from public.v2_deadwood_geometries where label_id in (select id from public.v2_labels where dataset_id between 92001 and 92099);",
        "delete from public.v2_forest_cover_geometries where label_id in (select id from public.v2_labels where dataset_id between 92001 and 92099);",
        "delete from public.v2_labels where dataset_id between 92001 and 92099;",
        "delete from public.v2_logs where dataset_id between 92001 and 92099;",
        "delete from public.v2_queue where dataset_id between 92001 and 92099;",
        "delete from public.v2_metadata where dataset_id between 92001 and 92099;",
        "delete from public.v2_thumbnails where dataset_id between 92001 and 92099;",
        "delete from public.v2_cogs where dataset_id between 92001 and 92099;",
        "delete from public.v2_orthos where dataset_id between 92001 and 92099;",
        "delete from public.v2_statuses where dataset_id between 92001 and 92099;",
        "delete from public.v2_datasets where id between 92001 and 92099;",
        "",
    ]

    dataset_rows, status_rows, ortho_rows, cog_rows, thumb_rows, meta_rows = [], [], [], [], [], []
    for row in data["datasets"]:
        source_id = int(row["source_dataset_id"])
        local_id = id_map[source_id]
        asset = assets[source_id]
        dataset_rows.append("(" + ", ".join([
            str(local_id), q(CONTRIBUTOR_ID), q(row["created_at"]),
            q(f"qa-realistic-{local_id}-{row.get('file_name') or source_id}"),
            q(row.get("license") or "CC BY"), q(row.get("platform") or "drone"),
            qa([f"QA Production Sample {source_id}"]),
            qn(row.get("aquisition_year")), qn(row.get("aquisition_month")), qn(row.get("aquisition_day")),
            q(f"Local QA copy of public production dataset {source_id}. Identity fields are sanitized."),
            q(row.get("data_access") or "public"), "null", "false",
        ]) + ")")
        has_error = bool(row.get("has_error"))
        status_rows.append("(" + ", ".join([
            str(local_id), q(row.get("current_status") or ("deadwood_segmentation" if has_error else "idle")),
            qb(row.get("is_upload_done")), qb(row.get("is_ortho_done")), qb(row.get("is_cog_done")),
            qb(row.get("is_thumbnail_done")), qb(row.get("is_deadwood_done")),
            qb(row.get("is_forest_cover_done")), qb(row.get("is_metadata_done")),
            qb(row.get("is_combined_model_done")), qb(has_error),
            q(f"QA realistic source dataset {source_id} has a production processing error." if has_error else None),
            qb(row.get("is_in_audit")),
        ]) + ")")
        ortho_rows.append("(" + ", ".join([str(local_id), q(asset["archive_name"]), "1", q(f"qa-realistic-{source_id}-sha256"), "0.1", str(asset["archive_size"]), q(row.get("bbox")), qj({"qa": True, "source_dataset_id": source_id})]) + ")")
        cog_rows.append("(" + ", ".join([str(local_id), q(asset["cog_name"]), "1", qj({"qa": True, "source_dataset_id": source_id}), "0.1", q(asset["cog_path"]), str(asset["cog_size"])]) + ")")
        thumb_rows.append("(" + ", ".join([str(local_id), q(asset["thumbnail_name"]), q(asset["thumbnail_path"]), "1", "0.1", str(asset["thumbnail_size"])]) + ")")
        prod_meta = row.get("metadata") or {}
        qa_meta = {"qa": True, "qa_pack": "qa-realistic", "source": "production-readonly", "source_dataset_id": source_id, "source_file_name": row.get("file_name")}
        for key in ("admin_level_1", "admin_level_2", "admin_level_3", "biome_name", "country", "continent"):
            if prod_meta.get(key) is not None:
                qa_meta[key] = prod_meta[key]
        meta_rows.append("(" + ", ".join([str(local_id), qj(qa_meta), "1", "0.1"]) + ")")

    lines += [
        "insert into public.v2_datasets (id, user_id, created_at, file_name, license, platform, authors, aquisition_year, aquisition_month, aquisition_day, additional_information, data_access, citation_doi, archived)",
        "values", ",\n".join(dataset_rows) + ";", "",
        "insert into public.v2_statuses (dataset_id, current_status, is_upload_done, is_ortho_done, is_cog_done, is_thumbnail_done, is_deadwood_done, is_forest_cover_done, is_metadata_done, is_combined_model_done, has_error, error_message, is_in_audit)",
        "values", ",\n".join(status_rows) + ";", "",
        "insert into public.v2_orthos (dataset_id, ortho_file_name, version, sha256, ortho_upload_runtime, ortho_file_size, bbox, ortho_info)",
        "values", ",\n".join(ortho_rows) + ";", "",
        "insert into public.v2_cogs (dataset_id, cog_file_name, version, cog_info, cog_processing_runtime, cog_path, cog_file_size)",
        "values", ",\n".join(cog_rows) + ";", "",
        "insert into public.v2_thumbnails (dataset_id, thumbnail_file_name, thumbnail_path, version, thumbnail_processing_runtime, thumbnail_file_size)",
        "values", ",\n".join(thumb_rows) + ";", "",
        "insert into public.v2_metadata (dataset_id, metadata, version, processing_runtime)",
        "values", ",\n".join(meta_rows) + ";", "",
    ]

    label_map, geom_map = {}, {}
    label_seq, geom_seq = {}, {}
    label_rows = []
    for label in data["labels"]:
        local_dataset = id_map[int(label["source_dataset_id"])]
        label_seq[local_dataset] = label_seq.get(local_dataset, 0) + 1
        local_label = local_dataset * 100 + label_seq[local_dataset]
        label_map[int(label["source_label_id"])] = local_label
        model = label.get("model_config") or {}
        model["qa_source_label_id"] = int(label["source_label_id"])
        label_rows.append("(" + ", ".join([
            str(local_label), str(local_dataset), q(CONTRIBUTOR_ID),
            q(label.get("label_source") or "model_prediction"),
            q(label.get("label_type") or "semantic_segmentation"),
            q(label.get("label_data") or "deadwood"),
            qn(label.get("label_quality"), "2"), qj(model), "true", qn(label.get("version"), "1"),
        ]) + ")")
    if label_rows:
        lines += ["insert into public.v2_labels (id, dataset_id, user_id, label_source, label_type, label_data, label_quality, model_config, is_active, version)", "values", ",\n".join(label_rows) + ";", ""]

    deadwood_rows, forest_rows = [], []
    for geom in data["geometries"]:
        source_label = int(geom["source_label_id"])
        if source_label not in label_map:
            continue
        local_dataset = id_map[int(geom["source_dataset_id"])]
        layer = geom["layer_type"]
        key = (local_dataset, layer)
        geom_seq[key] = geom_seq.get(key, 0) + 1
        local_geom = local_dataset * 10000 + (1000 if layer == "deadwood" else 5000) + geom_seq[key]
        geom_map[(layer, int(geom["source_geometry_id"]))] = local_geom
        props = geom.get("properties") or {}
        props["qa_source_geometry_id"] = int(geom["source_geometry_id"])
        geom_row = "(" + ", ".join([
            str(local_geom), str(label_map[source_label]),
            f"st_geomfromtext({q(geom['wkt'])}, {int(geom.get('srid') or 4326)})",
            qj(props), qn(geom.get("area_m2")), qb(geom.get("is_deleted")),
        ]) + ")"
        if layer == "deadwood":
            deadwood_rows.append(geom_row)
        else:
            forest_rows.append(geom_row)
    if deadwood_rows:
        lines += ["insert into public.v2_deadwood_geometries (id, label_id, geometry, properties, area_m2, is_deleted)", "values", ",\n".join(deadwood_rows) + ";", ""]
    if forest_rows:
        lines += ["insert into public.v2_forest_cover_geometries (id, label_id, geometry, properties, area_m2, is_deleted)", "values", ",\n".join(forest_rows) + ";", ""]

    correction_rows = []
    for index, correction in enumerate(data["corrections"], start=1):
        source_label = int(correction["source_label_id"])
        layer = str(correction.get("layer_type") or "")
        source_geom = correction.get("source_geometry_id")
        if source_label not in label_map or source_geom is None:
            continue
        source_geom_key = (layer, int(source_geom))
        if source_geom_key not in geom_map:
            continue
        source_original = correction.get("source_original_geometry_id")
        original = (
            geom_map.get((layer, int(source_original)))
            if source_original is not None
            else None
        )
        reviewed = correction.get("review_status") in {"approved", "rejected"}
        correction_rows.append("(" + ", ".join([
            str(9200000 + index), str(geom_map[source_geom_key]), q(layer),
            str(label_map[source_label]), str(id_map[int(correction["source_dataset_id"])]),
            q(correction.get("operation") or "modify"), qn(original), q(CONTRIBUTOR_ID),
            q(SESSION_ID), q(correction.get("review_status") or "pending"),
            q(AUDITOR_ID) if reviewed else "null",
            q(correction.get("reviewed_at")) if reviewed and correction.get("reviewed_at") else "null",
        ]) + ")")
    if correction_rows:
        lines += ["insert into public.v2_geometry_corrections (id, geometry_id, layer_type, label_id, dataset_id, operation, original_geometry_id, user_id, session_id, review_status, reviewed_by, reviewed_at)", "values", ",\n".join(correction_rows) + ";", ""]

    audit_rows = []
    for audit in data["audits"]:
        local_dataset = id_map[int(audit["source_dataset_id"])]
        audit_rows.append("(" + ", ".join([
            str(local_dataset), qb(audit.get("is_georeferenced")),
            qb(audit.get("has_valid_acquisition_date")), q("Sanitized QA audit from public production sample."),
            qb(audit.get("has_valid_phenology")), q("Sanitized QA audit from public production sample."),
            q(audit.get("deadwood_quality") or "sentinel_ok"), q("Sanitized QA audit from public production sample."),
            q(audit.get("forest_cover_quality") or "sentinel_ok"), q("Sanitized QA audit from public production sample."),
            qb(audit.get("aoi_done")), qb(audit.get("has_cog_issue")), qb(audit.get("has_thumbnail_issue")),
            q(AUDITOR_ID), q(f"QA realistic audit based on production dataset {audit['source_dataset_id']}."),
            qb(audit.get("has_major_issue")), q(audit.get("final_assessment") or "no_major_issues"),
            q(audit.get("reviewed_at")) if audit.get("reviewed_at") else "null", q(AUDITOR_ID),
        ]) + ")")
    if audit_rows:
        lines += ["insert into public.dataset_audit (dataset_id, is_georeferenced, has_valid_acquisition_date, acquisition_date_notes, has_valid_phenology, phenology_notes, deadwood_quality, deadwood_notes, forest_cover_quality, forest_cover_notes, aoi_done, has_cog_issue, has_thumbnail_issue, audited_by, notes, has_major_issue, final_assessment, reviewed_at, reviewed_by)", "values", ",\n".join(audit_rows) + ";", ""]

    flag_rows = []
    for index, flag in enumerate(data["flags"], start=1):
        flag_rows.append("(" + ", ".join([
            str(920000 + index), str(id_map[int(flag["source_dataset_id"])]), q(VIEWER_ID),
            qb(flag.get("is_ortho_mosaic_issue")), qb(flag.get("is_prediction_issue")),
            q(f"QA realistic flag derived from production dataset {flag['source_dataset_id']}."),
            q(flag.get("status") or "open"),
        ]) + ")")
    if flag_rows:
        lines += ["insert into public.dataset_flags (id, dataset_id, created_by, is_ortho_mosaic_issue, is_prediction_issue, description, status)", "values", ",\n".join(flag_rows) + ";", ""]

    lines += ["commit;", ""]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--datasets", default=",".join(str(item) for item in DEFAULT_DATASETS))
    parser.add_argument("--data-url", default="https://data2.deadtrees.earth")
    parser.add_argument("--data-root", default=None)
    parser.add_argument("--pack-root", default=None)
    parser.add_argument("--skip-assets", action="store_true")
    parser.add_argument("--refresh-assets", action="store_true")
    args = parser.parse_args()

    repo = root()
    ids = [int(item) for item in args.datasets.split(",") if item.strip()]
    max_dataset_count = LOCAL_DATASET_END - LOCAL_DATASET_START + 1
    if len(ids) > max_dataset_count:
        raise RuntimeError(
            f"qa-realistic supports at most {max_dataset_count} datasets "
            f"in the {LOCAL_DATASET_START}-{LOCAL_DATASET_END} fixture window."
        )
    id_map = {source: LOCAL_DATASET_START + index for index, source in enumerate(sorted(ids))}
    data = fetch(prod_db_url(repo), ids)
    if len(data["datasets"]) != len(ids):
        found = {int(row["source_dataset_id"]) for row in data["datasets"]}
        raise RuntimeError(f"missing production datasets: {sorted(set(ids) - found)}")

    data_root = Path(args.data_root or os.environ.get("DEADTREES_QA_DATA_ROOT") or repo / ".local" / "qa-data")
    pack_root = Path(args.pack_root or repo / ".local" / "qa-packs" / "realistic")
    pack_root.mkdir(parents=True, exist_ok=True)

    assets = {}
    for row in data["datasets"]:
        source_id = int(row["source_dataset_id"])
        local_id = id_map[source_id]
        cog_name = f"qa-realistic-{local_id}-cog.tif"
        thumb_name = f"qa-realistic-{local_id}-thumbnail.jpg"
        archive_name = f"qa-realistic-{local_id}.tif"
        cog_rel = f"realistic/cogs/{cog_name}"
        thumb_rel = f"realistic/thumbnails/{thumb_name}"
        cog_target = data_root / "cogs" / cog_rel
        thumb_target = data_root / "thumbnails" / thumb_rel
        archive_target = data_root / "archive" / archive_name
        if not args.skip_assets:
            download(f"{args.data_url}/cogs/v1/{row['cog_path']}", cog_target, args.refresh_assets)
            archive_target.parent.mkdir(parents=True, exist_ok=True)
            if args.refresh_assets or not archive_target.exists():
                shutil.copyfile(cog_target, archive_target)
            download(f"{args.data_url}/thumbnails/v1/{row['thumbnail_path']}", thumb_target, args.refresh_assets)
        require_existing_file(cog_target, "realistic COG asset")
        require_existing_file(archive_target, "realistic archive asset")
        require_existing_file(thumb_target, "realistic thumbnail asset")
        assets[source_id] = {
            "archive_name": archive_name,
            "archive_size": size_mb(archive_target, row.get("ortho_file_size")),
            "cog_name": cog_name,
            "cog_path": cog_rel,
            "cog_size": size_mb(cog_target, row.get("cog_file_size")),
            "thumbnail_name": thumb_name,
            "thumbnail_path": thumb_rel,
            "thumbnail_size": size(thumb_target, row.get("thumbnail_file_size")),
        }

    seed_file = pack_root / "qa-realistic.sql"
    manifest_file = pack_root / "manifest.json"
    seed_file.write_text(render_sql(data, id_map, assets), encoding="utf-8")
    manifest_file.write_text(json.dumps({
        "pack": "qa-realistic",
        "source": "production-readonly",
        "source_datasets": id_map,
        "local_dataset_range": "92001-92099",
        "data_root": str(data_root),
        "seed_file": str(seed_file),
        "label_count": len(data["labels"]),
        "geometry_count": len(data["geometries"]),
        "correction_count": len(data["corrections"]),
        "audit_count": len(data["audits"]),
        "flag_count": len(data["flags"]),
    }, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {seed_file}")
    print(f"Wrote {manifest_file}")
    print(f"Fetched {len(data['datasets'])} datasets, {len(data['labels'])} labels, {len(data['geometries'])} geometries, {len(data['corrections'])} corrections")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
