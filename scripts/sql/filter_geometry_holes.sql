-- Remove sub-threshold interior rings (holes) from one label's polygons in-place.
--
-- Works on either v2_forest_cover_geometries or v2_deadwood_geometries (pass the
-- table via -v target_table=...). Both store geometry(Polygon,4326) with an
-- area_m2 column.
--
-- Background: model-prediction polygons could carry large numbers of tiny interior
-- rings (often degenerate triangles). These were meant to be dropped at ingestion
-- by filter_polygons_by_area, but a bug appended the unfiltered polygon, so the
-- holes were persisted. This backfill rebuilds each polygon keeping only interior
-- rings whose geodesic area is >= the threshold.
--
-- Exterior rings are always kept; whole rows are never deleted (only holes change).
--
-- Usage (via scripts/filter_geometry_holes.sh):
--   -v label_id=32269 -v target_table=public.v2_forest_cover_geometries
--   -v label_id=32268 -v target_table=public.v2_deadwood_geometries -v apply=1
--
-- Set apply=1 only after reviewing the printed before/after metrics.

\if :{?label_id}
\else
  \quit 'Missing required psql variable: label_id'
\endif

\if :{?target_table}
\else
  \set target_table public.v2_forest_cover_geometries
\endif

\if :{?min_area_m2}
\else
  \set min_area_m2 0.1
\endif

\if :{?apply}
\else
  \set apply 0
\endif

\echo 'Geometry hole filter backfill'
\echo '  target_table: ' :target_table
\echo '  label_id: ' :label_id
\echo '  min_area_m2: ' :min_area_m2
\echo '  apply: ' :apply

BEGIN;
SET LOCAL statement_timeout = '10min';
-- Pre-existing invalid geometries (self-intersecting rings) make PostGIS emit a
-- flood of "Self-intersection" NOTICEs from ST_IsValid/ST_Buffer/ST_MakePolygon.
-- They are expected and handled (such rows are skipped), so quiet them; the
-- skipped-rows report below still surfaces the affected ids and reasons.
SET LOCAL client_min_messages = warning;

CREATE TEMP TABLE _hole_filter_candidate ON COMMIT DROP AS
WITH params AS (
    SELECT
        :label_id::bigint AS label_id,
        :min_area_m2::double precision AS min_area_m2
),
src AS (
    SELECT g.id, g.geometry AS old_geometry, p.min_area_m2
    FROM :target_table g
    CROSS JOIN params p
    WHERE g.label_id = p.label_id
),
-- ST_DumpRings splits a polygon into its rings: path[1] = 0 is the exterior shell,
-- path[1] >= 1 are the interior rings (holes). Each ring comes back as a POLYGON.
rings AS (
    SELECT
        s.id,
        s.old_geometry,
        s.min_area_m2,
        (d).path[1] AS ring_index,
        (d).geom AS ring_poly
    FROM src s,
    LATERAL ST_DumpRings(s.old_geometry) AS d
),
shell AS (
    SELECT id, old_geometry, ST_ExteriorRing(ring_poly) AS shell_ring
    FROM rings
    WHERE ring_index = 0
),
kept_holes AS (
    SELECT id, array_agg(ST_ExteriorRing(ring_poly)) AS hole_rings
    FROM rings
    WHERE ring_index > 0
      AND ST_Area(ring_poly::geography) >= min_area_m2
    GROUP BY id
),
rebuilt AS (
    SELECT
        s.id,
        s.old_geometry,
        CASE
            WHEN h.hole_rings IS NULL THEN ST_MakePolygon(s.shell_ring)
            ELSE ST_MakePolygon(s.shell_ring, h.hole_rings)
        END AS raw_geometry
    FROM shell s
    LEFT JOIN kept_holes h USING (id)
),
repaired AS (
    SELECT
        id,
        old_geometry,
        CASE
            WHEN ST_IsValid(raw_geometry) THEN raw_geometry
            ELSE ST_Buffer(raw_geometry, 0)
        END AS new_geometry
    FROM rebuilt
)
SELECT
    id,
    old_geometry,
    new_geometry,
    -- A row is only safe to write back if hole removal yielded a valid, non-empty
    -- single POLYGON with fewer vertices. Pre-existing invalid geometries (e.g.
    -- self-intersecting rings) can repair into a MULTIPOLYGON or empty geometry,
    -- which cannot go into a geometry(Polygon,4326) column; those are left as-is.
    (
        ST_IsValid(new_geometry)
        AND NOT ST_IsEmpty(new_geometry)
        AND GeometryType(new_geometry) = 'POLYGON'
        AND ST_NPoints(new_geometry) < ST_NPoints(old_geometry)
    ) AS applicable
FROM repaired;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM _hole_filter_candidate) THEN
        RAISE EXCEPTION 'No rows found for the requested label_id in the target table. Nothing to do.';
    END IF;
END $$;

-- This script only knows how to rebuild single POLYGON rows. Bail out loudly if a
-- stored row is something else, rather than silently corrupting it.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM _hole_filter_candidate
        WHERE GeometryType(old_geometry) <> 'POLYGON'
    ) THEN
        RAISE EXCEPTION 'Found non-POLYGON rows; this backfill only supports POLYGON geometries.';
    END IF;
END $$;

SELECT
    variant,
    rows,
    points,
    holes,
    pg_size_pretty(geom_bytes::bigint) AS geom_size,
    round(area_m2::numeric, 2) AS area_m2
FROM (
    SELECT
        'before' AS variant,
        count(*) AS rows,
        sum(ST_NPoints(old_geometry)) AS points,
        sum(ST_NumInteriorRings(old_geometry)) AS holes,
        sum(pg_column_size(old_geometry)) AS geom_bytes,
        sum(ST_Area(old_geometry::geography)) AS area_m2
    FROM _hole_filter_candidate
    UNION ALL
    SELECT
        'after' AS variant,
        count(*) AS rows,
        sum(ST_NPoints(CASE WHEN applicable THEN new_geometry ELSE old_geometry END)) AS points,
        sum(ST_NumInteriorRings(CASE WHEN applicable THEN new_geometry ELSE old_geometry END)) AS holes,
        sum(pg_column_size(CASE WHEN applicable THEN new_geometry ELSE old_geometry END)) AS geom_bytes,
        sum(ST_Area((CASE WHEN applicable THEN new_geometry ELSE old_geometry END)::geography)) AS area_m2
    FROM _hole_filter_candidate
) metrics
ORDER BY (variant = 'after');

-- Report rows that had holes but could NOT be safely rebuilt into a single valid
-- POLYGON (almost always pre-existing invalid input geometry). These are left
-- untouched by the UPDATE below rather than aborting the whole label.
SELECT
    id,
    GeometryType(new_geometry) AS rebuilt_type,
    ST_IsValid(new_geometry) AS is_valid,
    ST_IsEmpty(new_geometry) AS is_empty,
    ST_IsValidReason(old_geometry) AS old_geometry_reason
FROM _hole_filter_candidate
WHERE NOT applicable
  AND ST_NumInteriorRings(old_geometry) > 0
LIMIT 20;

SELECT
    count(*) FILTER (WHERE applicable) AS rows_to_update,
    count(*) FILTER (WHERE NOT applicable AND ST_NumInteriorRings(old_geometry) > 0) AS rows_skipped_with_holes
FROM _hole_filter_candidate;

\if :apply
    -- Only rewrite rows flagged applicable: a valid, non-empty single POLYGON with
    -- fewer vertices than before. Unchanged and unstorable rows are left as-is.
    UPDATE :target_table g
    SET
        geometry = c.new_geometry::geometry(Polygon, 4326),
        area_m2 = ST_Area(c.new_geometry::geography)
    FROM _hole_filter_candidate c
    WHERE g.id = c.id
      AND c.applicable;

    COMMIT;
    \echo 'Committed hole filtering.'
\else
    ROLLBACK;
    \echo 'Dry run only. Re-run with --apply to commit.'
\endif
