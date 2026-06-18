\set ON_ERROR_STOP on

begin;

create extension if not exists pgcrypto;

delete from public.dataset_flag_status_history where flag_id in (
	select id from public.dataset_flags where dataset_id between 91001 and 91099
);
delete from public.dataset_flags where dataset_id between 91001 and 91099;
delete from public.dataset_audit where dataset_id between 91001 and 91099;
delete from public.v2_geometry_corrections where dataset_id between 91001 and 91099;
delete from public.v2_deadwood_geometries where label_id in (
	select id from public.v2_labels where dataset_id between 91001 and 91099
);
delete from public.v2_forest_cover_geometries where label_id in (
	select id from public.v2_labels where dataset_id between 91001 and 91099
);
delete from public.v2_labels where dataset_id between 91001 and 91099;
delete from public.v2_logs where dataset_id between 91001 and 91099;
delete from public.v2_queue where dataset_id between 91001 and 91099;
delete from public.v2_metadata where dataset_id between 91001 and 91099;
delete from public.v2_thumbnails where dataset_id between 91001 and 91099;
delete from public.v2_cogs where dataset_id between 91001 and 91099;
delete from public.v2_orthos where dataset_id between 91001 and 91099;
delete from public.v2_statuses where dataset_id between 91001 and 91099;
delete from public.jt_data_publication_datasets where dataset_id between 91001 and 91099;
delete from public.jt_data_publication_user_info where publication_id between 91001 and 91099;
delete from public.data_publication where id between 91001 and 91099;
delete from public.user_info where id between 91001 and 91099;
delete from public.v2_datasets where id between 91001 and 91099;

delete from public.priwa_kaeferbaeume where project_id = '00000000-0000-4000-8000-00000000b001';
delete from public.priwa_project_memberships where project_id = '00000000-0000-4000-8000-00000000b001';
delete from public.priwa_projects where id = '00000000-0000-4000-8000-00000000b001';

delete from public.privileged_users where user_id in (
	'00000000-0000-4000-8000-00000000a001',
	'00000000-0000-4000-8000-00000000a002',
	'00000000-0000-4000-8000-00000000a003'
);
delete from auth.identities where user_id in (
	'00000000-0000-4000-8000-00000000a001',
	'00000000-0000-4000-8000-00000000a002',
	'00000000-0000-4000-8000-00000000a003'
);
delete from auth.users where id in (
	'00000000-0000-4000-8000-00000000a001',
	'00000000-0000-4000-8000-00000000a002',
	'00000000-0000-4000-8000-00000000a003'
);

insert into auth.users (
	instance_id,
	id,
	aud,
	role,
	email,
	encrypted_password,
	email_confirmed_at,
	raw_app_meta_data,
	raw_user_meta_data,
	created_at,
	updated_at
)
values
	(
		'00000000-0000-0000-0000-000000000000',
		'00000000-0000-4000-8000-00000000a001',
		'authenticated',
		'authenticated',
		'qa-contributor-local@example.com',
		crypt('DeadTreesQA-Local-1!', gen_salt('bf')),
		now(),
		'{"provider": "email", "providers": ["email"]}'::jsonb,
		'{}'::jsonb,
		now(),
		now()
	),
	(
		'00000000-0000-0000-0000-000000000000',
		'00000000-0000-4000-8000-00000000a002',
		'authenticated',
		'authenticated',
		'qa-auditor-local@example.com',
		crypt('DeadTreesQA-Local-1!', gen_salt('bf')),
		now(),
		'{"provider": "email", "providers": ["email"]}'::jsonb,
		'{}'::jsonb,
		now(),
		now()
	),
	(
		'00000000-0000-0000-0000-000000000000',
		'00000000-0000-4000-8000-00000000a003',
		'authenticated',
		'authenticated',
		'qa-viewer-local@example.com',
		crypt('DeadTreesQA-Local-1!', gen_salt('bf')),
		now(),
		'{"provider": "email", "providers": ["email"]}'::jsonb,
		'{}'::jsonb,
		now(),
		now()
	);

update auth.users
set
	confirmation_token = '',
	recovery_token = '',
	email_change_token_new = '',
	email_change = '',
	phone_change = '',
	phone_change_token = '',
	email_change_token_current = '',
	reauthentication_token = ''
where id in (
	'00000000-0000-4000-8000-00000000a001',
	'00000000-0000-4000-8000-00000000a002',
	'00000000-0000-4000-8000-00000000a003'
);

insert into auth.identities (
	id,
	provider_id,
	user_id,
	identity_data,
	provider,
	last_sign_in_at,
	created_at,
	updated_at
)
select
	id,
	id::text,
	id,
	jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true),
	'email',
	now(),
	now(),
	now()
from auth.users
where id in (
	'00000000-0000-4000-8000-00000000a001',
	'00000000-0000-4000-8000-00000000a002',
	'00000000-0000-4000-8000-00000000a003'
);

insert into public.privileged_users (
	user_id,
	can_upload_private,
	can_audit,
	can_view_all_private
)
values
	('00000000-0000-4000-8000-00000000a001', true, false, false),
	('00000000-0000-4000-8000-00000000a002', false, true, true),
	('00000000-0000-4000-8000-00000000a003', false, false, false);

insert into public.v2_datasets (
	id,
	user_id,
	created_at,
	file_name,
	license,
	platform,
	authors,
	aquisition_year,
	aquisition_month,
	aquisition_day,
	additional_information,
	data_access,
	citation_doi,
	archived
)
values
	(
		91001,
		'00000000-0000-4000-8000-00000000a001',
		'2026-01-02T10:00:00Z',
		'qa-public-complete.tif',
		'CC BY',
		'drone',
		array['QA Contributor'],
		2024,
		5,
		6,
		'QA public complete dataset for local agent journeys.',
		'public',
		'https://doi.org/10.9999/deadtrees.qa-public-complete',
		false
	),
	(
		91002,
		'00000000-0000-4000-8000-00000000a001',
		'2026-01-03T10:00:00Z',
		'qa-public-audited.tif',
		'CC BY',
		'drone',
		array['QA Contributor', 'QA Auditor'],
		2023,
		8,
		12,
		'QA audited dataset with completed audit fields.',
		'public',
		'https://doi.org/10.9999/deadtrees.qa-public-audited',
		false
	),
	(
		91003,
		'00000000-0000-4000-8000-00000000a001',
		'2026-01-04T10:00:00Z',
		'qa-private-contributor.tif',
		'CC BY-NC',
		'drone',
		array['QA Contributor'],
		2024,
		9,
		20,
		'QA private contributor-owned dataset.',
		'private',
		null,
		false
	),
	(
		91004,
		'00000000-0000-4000-8000-00000000a001',
		'2026-01-05T10:00:00Z',
		'qa-processing-error.tif',
		'CC BY',
		'drone',
		array['QA Contributor'],
		2024,
		11,
		4,
		'QA dataset representing an incomplete or errored processing state.',
		'public',
		null,
		false
	);

insert into public.v2_statuses (
	dataset_id,
	current_status,
	is_upload_done,
	is_ortho_done,
	is_cog_done,
	is_thumbnail_done,
	is_deadwood_done,
	is_forest_cover_done,
	is_metadata_done,
	is_combined_model_done,
	has_error,
	error_message,
	is_in_audit
)
values
	(91001, 'idle', true, true, true, true, true, true, true, true, false, null, false),
	(91002, 'idle', true, true, true, true, true, true, true, true, false, null, false),
	(91003, 'idle', true, true, true, true, false, false, true, false, false, null, false),
	(91004, 'cog_processing', true, true, false, false, false, false, true, false, true, 'QA fixture processing error', false);

insert into public.v2_orthos (
	dataset_id,
	ortho_file_name,
	version,
	sha256,
	ortho_upload_runtime,
	ortho_file_size,
	ortho_info
)
values
	(91001, 'qa-public-complete.tif', 1, 'qa-public-complete-sha256', 0.1, 123456, '{}'::jsonb),
	(91002, 'qa-public-audited.tif', 1, 'qa-public-audited-sha256', 0.1, 123456, '{}'::jsonb),
	(91003, 'qa-private-contributor.tif', 1, 'qa-private-contributor-sha256', 0.1, 123456, '{}'::jsonb),
	(91004, 'qa-processing-error.tif', 1, 'qa-processing-error-sha256', 0.1, 123456, '{}'::jsonb);

insert into public.v2_cogs (
	dataset_id,
	cog_file_name,
	version,
	cog_info,
	cog_processing_runtime,
	cog_path,
	cog_file_size
)
values
	(91001, 'qa-public-complete-cog.tif', 1, '{}'::jsonb, 0.1, 'qa/cogs/qa-public-complete-cog.tif', 234567),
	(91002, 'qa-public-audited-cog.tif', 1, '{}'::jsonb, 0.1, 'qa/cogs/qa-public-audited-cog.tif', 234567);

insert into public.v2_thumbnails (
	dataset_id,
	thumbnail_file_name,
	thumbnail_path,
	version,
	thumbnail_processing_runtime,
	thumbnail_file_size
)
values
	(91001, 'qa-public-complete.png', 'qa/thumbnails/qa-public-complete.png', 1, 0.1, 4567),
	(91002, 'qa-public-audited.png', 'qa/thumbnails/qa-public-audited.png', 1, 0.1, 4567);

insert into public.v2_metadata (
	dataset_id,
	metadata,
	version,
	processing_runtime
)
values
	(91001, '{"qa": true, "admin_level_1": "Germany", "admin_level_2": "Bavaria", "admin_level_3": "QA Forest"}'::jsonb, 1, 0.1),
	(91002, '{"qa": true, "admin_level_1": "Germany", "admin_level_2": "Hesse", "admin_level_3": "QA Audited Forest"}'::jsonb, 1, 0.1),
	(91003, '{"qa": true, "admin_level_1": "Germany", "admin_level_2": "Private QA", "admin_level_3": "QA Contributor Forest"}'::jsonb, 1, 0.1),
	(91004, '{"qa": true, "admin_level_1": "Germany", "admin_level_2": "Error QA", "admin_level_3": "QA Processing Forest"}'::jsonb, 1, 0.1);

insert into public.dataset_audit (
	dataset_id,
	is_georeferenced,
	has_valid_acquisition_date,
	acquisition_date_notes,
	has_valid_phenology,
	phenology_notes,
	deadwood_quality,
	deadwood_notes,
	forest_cover_quality,
	forest_cover_notes,
	aoi_done,
	has_cog_issue,
	has_thumbnail_issue,
	audited_by,
	notes,
	has_major_issue,
	final_assessment
)
values (
	91002,
	true,
	true,
	'QA acquisition date looks plausible.',
	true,
	'QA phenology accepted.',
	'sentinel_ok',
	'QA deadwood prediction is usable.',
	'great',
	'QA forest cover is good.',
	false,
	false,
	false,
	'00000000-0000-4000-8000-00000000a002',
	'QA audited fixture.',
	false,
	'no_major_issues'
);

insert into public.dataset_flags (
	dataset_id,
	created_by,
	is_ortho_mosaic_issue,
	is_prediction_issue,
	description,
	status
)
values (
	91001,
	'00000000-0000-4000-8000-00000000a003',
	true,
	false,
	'QA flag: visible ortho seam in the north-east corner.',
	'open'
);

insert into public.v2_labels (
	id,
	dataset_id,
	user_id,
	label_source,
	label_type,
	label_data,
	label_quality,
	model_config,
	is_active,
	version
)
values
	(
		9100101,
		91001,
		'00000000-0000-4000-8000-00000000a001',
		'model_prediction',
		'semantic_segmentation',
		'deadwood',
		2,
		'{"qa": true, "model": "qa-seed"}'::jsonb,
		true,
		1
	),
	(
		9100102,
		91001,
		'00000000-0000-4000-8000-00000000a001',
		'model_prediction',
		'semantic_segmentation',
		'forest_cover',
		2,
		'{"qa": true, "model": "qa-seed"}'::jsonb,
		true,
		1
	);

insert into public.v2_deadwood_geometries (
	id,
	label_id,
	geometry,
	properties,
	is_deleted
)
values (
	9100101,
	9100101,
	st_geomfromtext('POLYGON((7.9000 47.9900, 7.9003 47.9900, 7.9003 47.9903, 7.9000 47.9903, 7.9000 47.9900))', 4326),
	'{"qa": true, "source": "qa-labels"}'::jsonb,
	false
);

insert into public.v2_forest_cover_geometries (
	id,
	label_id,
	geometry,
	properties,
	is_deleted
)
values (
	9100102,
	9100102,
	st_geomfromtext('POLYGON((7.8995 47.9895, 7.9008 47.9895, 7.9008 47.9908, 7.8995 47.9908, 7.8995 47.9895))', 4326),
	'{"qa": true, "source": "qa-labels"}'::jsonb,
	false
);

insert into public.v2_geometry_corrections (
	id,
	geometry_id,
	layer_type,
	label_id,
	dataset_id,
	operation,
	original_geometry_id,
	user_id,
	session_id,
	review_status
)
values (
	9100101,
	9100101,
	'deadwood',
	9100101,
	91001,
	'modify',
	9100101,
	'00000000-0000-4000-8000-00000000a001',
	'00000000-0000-4000-8000-00000000c001',
	'pending'
);

insert into public.priwa_projects (
	id,
	slug,
	name
)
values (
	'00000000-0000-4000-8000-00000000b001',
	'qa-priwa-project',
	'QA PRIWA Project'
);

insert into public.priwa_project_memberships (
	project_id,
	user_id,
	role
)
values (
	'00000000-0000-4000-8000-00000000b001',
	'00000000-0000-4000-8000-00000000a001',
	'field_user'
);

insert into public.priwa_kaeferbaeume (
	id,
	project_id,
	geom,
	location_source,
	baumnr,
	fund,
	baumart,
	bm,
	bohrloch,
	harz,
	gruene_nadeln_am_boden,
	nadel,
	rinde,
	kv,
	name,
	datum,
	kom,
	raw_qr_value,
	created_by,
	updated_by
)
values (
	'00000000-0000-4000-8000-00000000b101',
	'00000000-0000-4000-8000-00000000b001',
	st_setsrid(st_makepoint(7.9001, 47.9901), 4326),
	'map_estimated',
	'QA-001',
	'stehend',
	'Fichte',
	'ja',
	'nein',
	'nein',
	'nein',
	'rot',
	'0%',
	'0%',
	'QA Field User',
	'2026-06-16',
	'QA seeded PRIWA point.',
	'QA-PRIWA-001',
	'00000000-0000-4000-8000-00000000a001',
	'00000000-0000-4000-8000-00000000a001'
);

insert into public.user_info (
	id,
	"user",
	organisation,
	orcid,
	first_name,
	last_name,
	title
)
values (
	91001,
	'00000000-0000-4000-8000-00000000a001',
	'DeadTrees QA',
	'0000-0000-0000-0000',
	'QA',
	'Contributor',
	'Dr.'
);

insert into public.data_publication (
	id,
	doi,
	title,
	description,
	user_id
)
values (
	91001,
	'10.9999/deadtrees.qa-publication',
	'QA Local Publication',
	'Local-only publication fixture for agent QA.',
	'00000000-0000-4000-8000-00000000a001'
);

insert into public.jt_data_publication_datasets (
	publication_id,
	dataset_id
)
values (
	91001,
	91001
);

insert into public.jt_data_publication_user_info (
	publication_id,
	user_info_id
)
values (
	91001,
	91001
);

commit;
