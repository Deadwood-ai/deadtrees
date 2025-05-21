create or replace view "public"."data_publication_full_info" as  WITH datasets_by_publication AS (
         SELECT jp.publication_id,
            jsonb_agg(jsonb_build_object('dataset_id', ds.id, 'file_name', ds.file_name, 'license', ds.license, 'platform', ds.platform, 'authors', ds.authors, 'citation_doi', ds.citation_doi, 'aquisition_year', ds.aquisition_year, 'aquisition_month', ds.aquisition_month, 'aquisition_day', ds.aquisition_day, 'data_access', ds.data_access)) AS datasets
           FROM (jt_data_publication_datasets jp
             JOIN v2_datasets ds ON ((jp.dataset_id = ds.id)))
          GROUP BY jp.publication_id
        ), authors_by_publication AS (
         SELECT jp.publication_id,
            jsonb_agg(jsonb_build_object('author_id', ui.id, 'first_name', ui.first_name, 'last_name', ui.last_name, 'title', ui.title, 'organisation', ui.organisation, 'orcid', ui.orcid) ORDER BY ui.last_name, ui.first_name) AS authors,
            string_agg((((
                CASE
                    WHEN (ui.title IS NOT NULL) THEN (ui.title || ' '::text)
                    ELSE ''::text
                END || ui.first_name) || ' '::text) || ui.last_name), ', '::text ORDER BY ui.last_name, ui.first_name) AS author_display_names
           FROM (jt_data_publication_user_info jp
             JOIN user_info ui ON ((jp.user_info_id = ui.id)))
          GROUP BY jp.publication_id
        ), dataset_counts AS (
         SELECT jt_data_publication_datasets.publication_id,
            count(*) AS dataset_count
           FROM jt_data_publication_datasets
          GROUP BY jt_data_publication_datasets.publication_id
        )
 SELECT p.id AS publication_id,
    p.created_at,
    p.doi,
    p.title,
    p.description,
    p.user_id AS creator_user_id,
    a.authors,
    a.author_display_names,
    d.datasets,
    dc.dataset_count,
        CASE
            WHEN (p.doi IS NOT NULL) THEN true
            ELSE false
        END AS is_published
   FROM (((data_publication p
     LEFT JOIN datasets_by_publication d ON ((p.id = d.publication_id)))
     LEFT JOIN authors_by_publication a ON ((p.id = a.publication_id)))
     LEFT JOIN dataset_counts dc ON ((p.id = dc.publication_id)));



