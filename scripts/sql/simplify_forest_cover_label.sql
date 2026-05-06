-- Simplify one forest-cover label in-place after a measured dry run.
--
-- Usage:
--   scripts/simplify_forest_cover_label.sh 14189
--   scripts/simplify_forest_cover_label.sh 14189 --metric-srid 32636 --apply
--
-- Set metric_srid=0 to estimate a UTM zone from the label centroid.
-- Set apply=1 only after reviewing the printed metrics.

\if :{?label_id}
\else
  \quit 'Missing required psql variable: label_id'
\endif

\if :{?metric_srid}
\else
  \set metric_srid 0
\endif

\if :{?tolerance_m}
\else
  \set tolerance_m 0.04
\endif

\if :{?apply}
\else
  \set apply 0
\endif

\echo 'Forest-cover simplification backfill'
\echo '  label_id: ' :label_id
\echo '  metric_srid: ' :metric_srid
\echo '  tolerance_m: ' :tolerance_m
\echo '  apply: ' :apply

BEGIN;
SET LOCAL statement_timeout = '10min';

CREATE TEMP TABLE _forest_cover_simplification_candidate ON COMMIT DROP AS
WITH label_center AS (
    SELECT ST_Extent(geometry)::geometry AS bbox
    FROM public.v2_forest_cover_geometries
    WHERE label_id = :label_id
),
params AS (
    SELECT
        :label_id::bigint AS label_id,
        :tolerance_m::double precision AS tolerance_m,
        CASE
            WHEN :metric_srid::integer > 0 THEN :metric_srid::integer
            WHEN ((ST_YMin(bbox) + ST_YMax(bbox)) / 2.0) >= 0
                THEN 32600 + least(greatest(floor((((ST_XMin(bbox) + ST_XMax(bbox)) / 2.0) + 180.0) / 6.0)::integer + 1, 1), 60)
            ELSE 32700 + least(greatest(floor((((ST_XMin(bbox) + ST_XMax(bbox)) / 2.0) + 180.0) / 6.0)::integer + 1, 1), 60)
        END AS metric_srid
    FROM label_center
),
simplified AS (
    SELECT
        g.id,
        g.geometry AS old_geometry,
        p.metric_srid,
        ST_Transform(
            ST_SimplifyPreserveTopology(
                ST_Transform(g.geometry, p.metric_srid),
                p.tolerance_m
            ),
            4326
        ) AS raw_geometry
    FROM public.v2_forest_cover_geometries g
    CROSS JOIN params p
    WHERE g.label_id = p.label_id
),
repaired AS (
    SELECT
        id,
        old_geometry,
        metric_srid,
        raw_geometry,
        CASE
            WHEN ST_IsValid(raw_geometry) THEN raw_geometry
            ELSE ST_Buffer(raw_geometry, 0)
        END AS new_geometry
    FROM simplified
)
SELECT *
FROM repaired;

SELECT DISTINCT metric_srid AS resolved_metric_srid
FROM _forest_cover_simplification_candidate;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM _forest_cover_simplification_candidate) THEN
        RAISE EXCEPTION 'No v2_forest_cover_geometries rows found for the requested label_id. Nothing to simplify.';
    END IF;
END $$;

SELECT
    variant,
    rows,
    points,
    pg_size_pretty(geom_bytes::bigint) AS geom_size,
    round(area_m2::numeric, 2) AS area_m2,
    invalid_rows,
    geom_types
FROM (
    SELECT
        'before' AS variant,
        count(*) AS rows,
        sum(ST_NPoints(old_geometry)) AS points,
        sum(pg_column_size(old_geometry)) AS geom_bytes,
        sum(ST_Area(old_geometry::geography)) AS area_m2,
        count(*) FILTER (WHERE NOT ST_IsValid(old_geometry)) AS invalid_rows,
        string_agg(DISTINCT GeometryType(old_geometry), ', ' ORDER BY GeometryType(old_geometry)) AS geom_types
    FROM _forest_cover_simplification_candidate
    UNION ALL
    SELECT
        'simplified_raw' AS variant,
        count(*) AS rows,
        sum(ST_NPoints(raw_geometry)) AS points,
        sum(pg_column_size(raw_geometry)) AS geom_bytes,
        sum(ST_Area(raw_geometry::geography)) AS area_m2,
        count(*) FILTER (WHERE NOT ST_IsValid(raw_geometry)) AS invalid_rows,
        string_agg(DISTINCT GeometryType(raw_geometry), ', ' ORDER BY GeometryType(raw_geometry)) AS geom_types
    FROM _forest_cover_simplification_candidate
    UNION ALL
    SELECT
        'simplified_repaired' AS variant,
        count(*) AS rows,
        sum(ST_NPoints(new_geometry)) AS points,
        sum(pg_column_size(new_geometry)) AS geom_bytes,
        sum(ST_Area(new_geometry::geography)) AS area_m2,
        count(*) FILTER (WHERE NOT ST_IsValid(new_geometry)) AS invalid_rows,
        string_agg(DISTINCT GeometryType(new_geometry), ', ' ORDER BY GeometryType(new_geometry)) AS geom_types
    FROM _forest_cover_simplification_candidate
) metrics
ORDER BY
    CASE variant
        WHEN 'before' THEN 1
        WHEN 'simplified_raw' THEN 2
        ELSE 3
    END;

SELECT
    id,
    GeometryType(new_geometry) AS geom_type,
    ST_IsValid(new_geometry) AS is_valid,
    ST_IsEmpty(new_geometry) AS is_empty
FROM _forest_cover_simplification_candidate
WHERE
    ST_IsEmpty(new_geometry)
    OR NOT ST_IsValid(new_geometry)
    OR GeometryType(new_geometry) <> 'POLYGON'
LIMIT 20;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM _forest_cover_simplification_candidate
        WHERE
            ST_IsEmpty(new_geometry)
            OR NOT ST_IsValid(new_geometry)
            OR GeometryType(new_geometry) <> 'POLYGON'
    ) THEN
        RAISE EXCEPTION 'Simplification produced rows that cannot be safely stored as geometry(Polygon,4326). See blocked row sample above.';
    END IF;
END $$;

\if :apply
    UPDATE public.v2_forest_cover_geometries g
    SET
        geometry = c.new_geometry::geometry(Polygon, 4326),
        area_m2 = ST_Area(c.new_geometry::geography)
    FROM _forest_cover_simplification_candidate c
    WHERE g.id = c.id;

    COMMIT;
    \echo 'Committed forest-cover simplification.'
\else
    ROLLBACK;
    \echo 'Dry run only. Re-run with -v apply=1 to commit.'
\endif
