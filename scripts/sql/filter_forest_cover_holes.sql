-- Remove sub-threshold interior rings (holes) from one forest-cover label in-place.
--
-- Background: forest-cover polygons stored in v2_forest_cover_geometries can carry
-- huge numbers of tiny interior rings (often degenerate triangles). These were
-- meant to be dropped at ingestion by filter_polygons_by_area, but a bug appended
-- the unfiltered polygon, so the holes were persisted. This backfill rebuilds each
-- polygon keeping only interior rings whose geodesic area is >= the threshold.
--
-- Exterior rings are always kept; whole rows are never deleted (only holes change).
--
-- Usage:
--   scripts/filter_forest_cover_holes.sh 10494
--   scripts/filter_forest_cover_holes.sh 10494 --min-area-m2 0.1 --apply
--
-- Set apply=1 only after reviewing the printed before/after metrics.

\if :{?label_id}
\else
  \quit 'Missing required psql variable: label_id'
\endif

\if :{?min_area_m2}
\else
  \set min_area_m2 0.1
\endif

\if :{?apply}
\else
  \set apply 0
\endif

\echo 'Forest-cover hole filter backfill'
\echo '  label_id: ' :label_id
\echo '  min_area_m2: ' :min_area_m2
\echo '  apply: ' :apply

BEGIN;
SET LOCAL statement_timeout = '10min';

CREATE TEMP TABLE _forest_cover_hole_candidate ON COMMIT DROP AS
WITH params AS (
    SELECT
        :label_id::bigint AS label_id,
        :min_area_m2::double precision AS min_area_m2
),
src AS (
    SELECT g.id, g.geometry AS old_geometry, p.min_area_m2
    FROM public.v2_forest_cover_geometries g
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
        raw_geometry,
        CASE
            WHEN ST_IsValid(raw_geometry) THEN raw_geometry
            ELSE ST_Buffer(raw_geometry, 0)
        END AS new_geometry
    FROM rebuilt
)
SELECT * FROM repaired;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM _forest_cover_hole_candidate) THEN
        RAISE EXCEPTION 'No v2_forest_cover_geometries rows found for the requested label_id. Nothing to do.';
    END IF;
END $$;

-- This script only knows how to rebuild single POLYGON rows. Bail out loudly if a
-- stored row is something else, rather than silently corrupting it.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM _forest_cover_hole_candidate
        WHERE GeometryType(old_geometry) <> 'POLYGON'
    ) THEN
        RAISE EXCEPTION 'Found non-POLYGON forest-cover rows; this backfill only supports POLYGON geometries.';
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
    FROM _forest_cover_hole_candidate
    UNION ALL
    SELECT
        'after' AS variant,
        count(*) AS rows,
        sum(ST_NPoints(new_geometry)) AS points,
        sum(ST_NumInteriorRings(new_geometry)) AS holes,
        sum(pg_column_size(new_geometry)) AS geom_bytes,
        sum(ST_Area(new_geometry::geography)) AS area_m2
    FROM _forest_cover_hole_candidate
) metrics
ORDER BY (variant = 'after');

-- Safety gate: nothing other than valid, non-empty POLYGONs may be written back.
SELECT
    id,
    GeometryType(new_geometry) AS geom_type,
    ST_IsValid(new_geometry) AS is_valid,
    ST_IsEmpty(new_geometry) AS is_empty
FROM _forest_cover_hole_candidate
WHERE
    ST_IsEmpty(new_geometry)
    OR NOT ST_IsValid(new_geometry)
    OR GeometryType(new_geometry) <> 'POLYGON'
LIMIT 20;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM _forest_cover_hole_candidate
        WHERE
            ST_IsEmpty(new_geometry)
            OR NOT ST_IsValid(new_geometry)
            OR GeometryType(new_geometry) <> 'POLYGON'
    ) THEN
        RAISE EXCEPTION 'Hole filtering produced rows that cannot be safely stored as geometry(Polygon,4326). See blocked row sample above.';
    END IF;
END $$;

\if :apply
    -- Only rewrite rows that actually lost holes (fewer vertices), to avoid
    -- churning unchanged geometries and their area_m2.
    UPDATE public.v2_forest_cover_geometries g
    SET
        geometry = c.new_geometry::geometry(Polygon, 4326),
        area_m2 = ST_Area(c.new_geometry::geography)
    FROM _forest_cover_hole_candidate c
    WHERE g.id = c.id
      AND ST_NPoints(c.new_geometry) < ST_NPoints(c.old_geometry);

    COMMIT;
    \echo 'Committed forest-cover hole filtering.'
\else
    ROLLBACK;
    \echo 'Dry run only. Re-run with --apply to commit.'
\endif
