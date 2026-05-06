CREATE OR REPLACE FUNCTION public.get_forest_cover_tiles_with_corrections(
    z integer,
    x integer,
    y integer,
    filter_label_id bigint,
    resolution integer DEFAULT 4096,
    filter_correction_status text DEFAULT NULL::text
)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    mvt bytea;
BEGIN
    WITH
    bbox AS (
        SELECT ST_TileEnvelope(z, x, y) AS bbox_3857
    ),
    settings AS (
        SELECT
            CASE WHEN z < 6 THEN 1000000
                 WHEN z < 8 THEN 500000
                 WHEN z < 10 THEN 100000
                 WHEN z < 12 THEN 50000
                 WHEN z < 14 THEN 10000
                 ELSE 0 END AS min_area
    )
    SELECT ST_AsMVT(tile_data, 'forest_cover', resolution)
    INTO mvt
    FROM (
        SELECT
            ST_AsMVTGeom(
                ST_SimplifyPreserveTopology(
                    ST_Transform(g.geometry, 3857),
                    (ST_XMax(b.bbox_3857) - ST_XMin(b.bbox_3857)) / NULLIF(resolution, 0) * 2.0
                ),
                b.bbox_3857,
                resolution,
                128,
                true
            ) AS geom,
            g.id,
            g.label_id,
            g.properties,
            g.is_deleted,
            COALESCE(c.review_status, 'original') AS correction_status,
            c.operation AS correction_operation,
            c.id AS correction_id
        FROM
            public.v2_forest_cover_geometries g
        CROSS JOIN bbox b
        CROSS JOIN settings s
        LEFT JOIN LATERAL (
            SELECT id, review_status, operation
            FROM v2_geometry_corrections
            WHERE geometry_id = g.id AND layer_type = 'forest_cover'
            ORDER BY created_at DESC
            LIMIT 1
        ) c ON true
        WHERE
            g.label_id = filter_label_id
            AND g.area_m2 >= s.min_area
            AND g.geometry && ST_Transform(b.bbox_3857, ST_SRID(g.geometry))
            AND ST_Intersects(g.geometry, ST_Transform(b.bbox_3857, ST_SRID(g.geometry)))
            AND (
                CASE filter_correction_status
                    WHEN 'all' THEN true
                    WHEN 'pending' THEN c.review_status = 'pending'
                    ELSE g.is_deleted = false
                END
            )
        LIMIT 50000
    ) AS tile_data
    WHERE tile_data.geom IS NOT NULL;

    RETURN encode(mvt, 'base64');
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_forest_cover_vector_tiles_perf(
    z integer,
    x integer,
    y integer,
    filter_label_id integer,
    resolution integer DEFAULT 4096
)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    mvt bytea;
BEGIN
    WITH
    bbox AS (
        SELECT ST_TileEnvelope(z, x, y) AS bbox_3857
    ),
    settings AS (
        SELECT
            CASE WHEN z < 6 THEN 1000000
                 WHEN z < 8 THEN 500000
                 WHEN z < 10 THEN 100000
                 WHEN z < 12 THEN 50000
                 WHEN z < 14 THEN 10000
                 ELSE 0 END AS min_area
    )
    SELECT ST_AsMVT(tile_data, 'forest_cover', resolution)
    INTO mvt
    FROM (
        SELECT
            ST_AsMVTGeom(
                ST_SimplifyPreserveTopology(
                    ST_Transform(g.geometry, 3857),
                    (ST_XMax(b.bbox_3857) - ST_XMin(b.bbox_3857)) / NULLIF(resolution, 0) * 2.0
                ),
                b.bbox_3857,
                resolution,
                128,
                true
            ) AS geom,
            g.id,
            g.label_id,
            g.properties,
            COALESCE(c.review_status, 'original') AS correction_status,
            c.operation AS correction_operation
        FROM
            public.v2_forest_cover_geometries g
            CROSS JOIN bbox b
            CROSS JOIN settings s
            LEFT JOIN LATERAL (
                SELECT review_status, operation
                FROM v2_geometry_corrections
                WHERE geometry_id = g.id AND layer_type = 'forest_cover'
                ORDER BY created_at DESC LIMIT 1
            ) c ON true
        WHERE
            g.label_id = filter_label_id
            AND g.is_deleted = false
            AND g.area_m2 >= s.min_area
            AND g.geometry && ST_Transform(b.bbox_3857, ST_SRID(g.geometry))
            AND ST_Intersects(g.geometry, ST_Transform(b.bbox_3857, ST_SRID(g.geometry)))
        LIMIT 50000
    ) AS tile_data
    WHERE tile_data.geom IS NOT NULL;

    RETURN encode(mvt, 'base64');
END;
$function$;
