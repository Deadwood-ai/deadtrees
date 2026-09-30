"""Correction, reference-patch and publication writes must act as the signed-in user.

Each RPC below is SECURITY DEFINER. They used to take the acting user from a
parameter, so an anonymous caller could delete or approve prediction polygons
as any auditor. These contracts run on the isolated local database only.
"""
import json
import uuid
from urllib.parse import urlparse

import psycopg
import pytest

from shared.settings import settings

POLYGON = {'type': 'Polygon', 'coordinates': [[[13.4, 52.5], [13.4, 52.6], [13.5, 52.6], [13.4, 52.5]]]}
SAVE = (
	"SELECT success, message, conflict_ids FROM public.save_prediction_corrections("
	"%s,%s,%s,'deadwood',%s,%s::bigint[],%s::timestamptz[],%s::jsonb)"
)


@pytest.fixture
def db():
	assert urlparse(settings.SUPABASE_DB_URL).hostname in {'localhost', '127.0.0.1', 'host.docker.internal'}, 'Local database required'
	with psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin') as connection:
		try:
			yield connection
		finally:
			connection.rollback()


def as_admin(db):
	db.execute('RESET ROLE')
	db.execute("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")


def as_anon(db):
	db.execute('RESET ROLE')
	db.execute('SET LOCAL ROLE anon')
	db.execute("SELECT set_config('request.jwt.claims','{\"role\":\"anon\"}',true)")


def act_as(db, user):
	db.execute('RESET ROLE')
	db.execute('SET LOCAL ROLE authenticated')
	db.execute("SELECT set_config('request.jwt.claims',%s,true)", (json.dumps({'sub': str(user), 'role': 'authenticated'}),))


def create_user(db, can_audit=False):
	as_admin(db)
	user = uuid.uuid4()
	db.execute('INSERT INTO auth.users(id,email) VALUES (%s,%s)', (user, f'{user}@example.invalid'))
	if can_audit:
		db.execute('INSERT INTO public.privileged_users(user_id,can_audit) VALUES (%s,true)', (user,))
	return user


def create_dataset(db, owner, data_access='public'):
	as_admin(db)
	dataset = db.execute(
		"INSERT INTO public.v2_datasets(user_id,file_name,license,platform,data_access) "
		"VALUES (%s,'access.tif','CC BY','drone',%s) RETURNING id",
		(owner, data_access),
	).fetchone()[0]
	db.execute('INSERT INTO public.v2_statuses(dataset_id) VALUES (%s)', (dataset,))
	return dataset


def create_prediction(db, dataset, owner, label_source='model_prediction'):
	"""A deadwood label with one polygon; returns (label, geometry, updated_at)."""
	as_admin(db)
	label = db.execute(
		"INSERT INTO public.v2_labels(dataset_id,user_id,label_source,label_type,label_data) "
		"VALUES (%s,%s,%s,'semantic_segmentation','deadwood') RETURNING id",
		(dataset, owner, label_source),
	).fetchone()[0]
	geometry, updated_at = db.execute(
		'INSERT INTO public.v2_deadwood_geometries(label_id,geometry) VALUES (%s,ST_GeomFromGeoJSON(%s)) '
		'RETURNING id, updated_at',
		(label, json.dumps(POLYGON)),
	).fetchone()
	return label, geometry, updated_at


def expect_denied(db, statement, params=(), error=psycopg.errors.InsufficientPrivilege):
	db.execute('SAVEPOINT denied')
	with pytest.raises(error):
		db.execute(statement, params)
	db.execute('ROLLBACK TO SAVEPOINT denied')


def geometry_deleted(db, geometry):
	as_admin(db)
	return db.execute('SELECT is_deleted FROM public.v2_deadwood_geometries WHERE id=%s', (geometry,)).fetchone()[0]


def test_anonymous_callers_cannot_run_correction_or_reference_rpcs(db):
	owner, auditor = create_user(db), create_user(db, can_audit=True)
	dataset = create_dataset(db, owner)
	label, geometry, updated_at = create_prediction(db, dataset, owner)

	as_anon(db)
	for statement, params in [
		(SAVE, (dataset, label, auditor, uuid.uuid4(), [geometry], [updated_at], '[]')),
		('SELECT public.approve_correction(%s,%s)', (1, auditor)),
		('SELECT public.revert_correction(%s,%s)', (1, auditor)),
		('SELECT * FROM public.get_pending_correction_locations(%s)', (dataset,)),
		("SELECT * FROM public.save_reference_geometries(1,%s,%s,'deadwood','[]'::jsonb)", (dataset, auditor)),
		("SELECT * FROM public.get_clipped_geometries_batch(%s,'v2_deadwood_geometries',0,0,1,1,4326)", (label,)),
	]:
		expect_denied(db, statement, params)
	assert geometry_deleted(db, geometry) is False


def test_signed_in_users_cannot_act_as_an_auditor(db):
	owner, auditor, other = create_user(db), create_user(db, can_audit=True), create_user(db)
	dataset = create_dataset(db, owner)
	label, geometry, updated_at = create_prediction(db, dataset, owner)

	# Proposing a correction under the auditor's id would auto-approve it.
	act_as(db, other)
	expect_denied(db, SAVE, (dataset, label, auditor, uuid.uuid4(), [geometry], [updated_at], '[]'))
	assert geometry_deleted(db, geometry) is False

	# The owner's own proposal stays pending until an auditor reviews it.
	act_as(db, owner)
	assert db.execute(SAVE, (dataset, label, owner, uuid.uuid4(), [geometry], [updated_at], '[]')).fetchone()[0] is True
	as_admin(db)
	correction, status = db.execute(
		'SELECT id, review_status FROM public.v2_geometry_corrections WHERE geometry_id=%s', (geometry,)
	).fetchone()
	assert status == 'pending'

	act_as(db, other)
	expect_denied(db, 'SELECT public.approve_correction(%s,%s)', (correction, auditor))
	expect_denied(db, 'SELECT public.revert_correction(%s,%s)', (correction, auditor))
	act_as(db, auditor)
	expect_denied(db, 'SELECT public.approve_correction(%s,%s)', (correction, other))
	assert db.execute('SELECT public.approve_correction(%s,%s)', (correction, auditor)).fetchone()[0] is True
	as_admin(db)
	assert db.execute(
		'SELECT review_status, reviewed_by FROM public.v2_geometry_corrections WHERE id=%s', (correction,)
	).fetchone() == ('approved', auditor)


def test_corrections_only_touch_geometries_of_their_label(db):
	owner, auditor = create_user(db), create_user(db, can_audit=True)
	dataset, other_dataset = create_dataset(db, owner), create_dataset(db, owner)
	label, _, _ = create_prediction(db, dataset, owner)
	_, foreign, foreign_updated_at = create_prediction(db, other_dataset, owner)

	act_as(db, auditor)
	success, _, conflicts = db.execute(
		SAVE, (dataset, label, auditor, uuid.uuid4(), [foreign], [foreign_updated_at], '[]')
	).fetchone()
	assert (success, conflicts) == (False, [foreign])
	modify = json.dumps([{'geometry': POLYGON, 'original_geometry_id': foreign}])
	expect_denied(db, SAVE, (dataset, label, auditor, uuid.uuid4(), [], [], modify))
	assert geometry_deleted(db, foreign) is False


def test_only_visible_model_predictions_are_correctable(db):
	owner, contributor = create_user(db), create_user(db)
	public_dataset = create_dataset(db, owner)
	private_dataset = create_dataset(db, owner, data_access='private')
	archived_dataset, excluded_dataset = create_dataset(db, owner), create_dataset(db, owner)
	as_admin(db)
	db.execute('UPDATE public.v2_datasets SET archived=true WHERE id=%s', (archived_dataset,))
	db.execute(
		"INSERT INTO public.dataset_audit(dataset_id,final_assessment) VALUES (%s,'exclude_completely')",
		(excluded_dataset,),
	)
	hidden = [(dataset, *create_prediction(db, dataset, owner)) for dataset in (private_dataset, archived_dataset, excluded_dataset)]
	upload = (public_dataset, *create_prediction(db, public_dataset, owner, 'visual_interpretation'))

	for dataset, label, geometry, updated_at in [*hidden, upload]:
		act_as(db, contributor)
		expect_denied(db, SAVE, (dataset, label, contributor, uuid.uuid4(), [geometry], [updated_at], '[]'))
		assert geometry_deleted(db, geometry) is False

	# Public labelling: any signed-in contributor proposes a pending correction.
	label, geometry, updated_at = create_prediction(db, public_dataset, owner)
	act_as(db, contributor)
	wrong_layer = SAVE.replace("'deadwood'", "'forest_cover'")
	expect_denied(db, wrong_layer, (public_dataset, label, contributor, uuid.uuid4(), [], [], json.dumps([{'geometry': POLYGON}])))
	assert db.execute(SAVE, (public_dataset, label, contributor, uuid.uuid4(), [geometry], [updated_at], '[]')).fetchone()[0] is True
	as_admin(db)
	assert db.execute(
		'SELECT review_status FROM public.v2_geometry_corrections WHERE geometry_id=%s', (geometry,)
	).fetchone()[0] == 'pending'

	# The owner still corrects the prediction of their private dataset.
	_, label, geometry, updated_at = hidden[0]
	act_as(db, owner)
	assert db.execute(SAVE, (private_dataset, label, owner, uuid.uuid4(), [geometry], [updated_at], '[]')).fetchone()[0] is True


def test_corrections_are_not_inserted_directly(db):
	owner = create_user(db)
	dataset = create_dataset(db, owner)
	label, geometry, _ = create_prediction(db, dataset, owner)

	act_as(db, owner)
	expect_denied(
		db,
		'INSERT INTO public.v2_geometry_corrections(geometry_id,layer_type,label_id,dataset_id,operation,user_id,session_id,review_status) '
		"VALUES (%s,'deadwood',%s,%s,'delete',%s,gen_random_uuid(),'approved')",
		(geometry, label, dataset, owner),
	)


def test_pending_correction_locations_are_for_owners_and_auditors(db):
	owner, auditor, other = create_user(db), create_user(db, can_audit=True), create_user(db)
	dataset = create_dataset(db, owner, data_access='private')

	act_as(db, other)
	expect_denied(db, 'SELECT * FROM public.get_pending_correction_locations(%s)', (dataset,))
	for user in (owner, auditor):
		act_as(db, user)
		assert db.execute('SELECT * FROM public.get_pending_correction_locations(%s)', (dataset,)).fetchall() == []


def test_reference_patches_are_written_and_read_by_auditors_only(db):
	owner, auditor, other = create_user(db), create_user(db, can_audit=True), create_user(db)
	dataset, other_dataset = create_dataset(db, owner, data_access='private'), create_dataset(db, owner)
	label, _, _ = create_prediction(db, dataset, owner)
	as_admin(db)
	patch = db.execute(
		'INSERT INTO public.reference_patches(dataset_id,user_id,resolution_cm,geometry,patch_index,bbox_minx,bbox_miny,bbox_maxx,bbox_maxy) '
		"VALUES (%s,%s,20,%s::jsonb,'0',13,52,14,53) RETURNING id",
		(dataset, auditor, json.dumps(POLYGON)),
	).fetchone()[0]
	save = "SELECT * FROM public.save_reference_geometries(%s,%s,%s,'deadwood',%s::jsonb)"
	clip = "SELECT * FROM public.get_clipped_geometries_batch(%s,%s,13,52,14,53,4326)"
	geometries = json.dumps([POLYGON])

	act_as(db, other)
	expect_denied(db, save, (patch, dataset, other, geometries))
	expect_denied(db, save, (patch, dataset, auditor, geometries))
	expect_denied(db, clip, (label, 'v2_deadwood_geometries'))

	act_as(db, auditor)
	expect_denied(db, save, (patch, other_dataset, auditor, geometries))
	expect_denied(db, clip, (label, 'auth.users'), psycopg.errors.InvalidParameterValue)
	assert db.execute(save, (patch, dataset, auditor, geometries)).fetchone()[1] == 1
	assert len(db.execute(clip, (label, 'v2_deadwood_geometries')).fetchall()) == 1


def test_publication_tables_accept_only_owner_inserts(db):
	owner, other = create_user(db), create_user(db)
	dataset = create_dataset(db, owner)
	as_admin(db)
	published = db.execute(
		"INSERT INTO public.data_publication(user_id,title,status,doi) VALUES (%s,'Published','published','10.1/x') RETURNING id",
		(owner,),
	).fetchone()[0]

	as_anon(db)
	expect_denied(db, "INSERT INTO public.data_publication(title) VALUES ('anon')")
	expect_denied(db, "UPDATE public.data_publication SET doi='10.1/forged' WHERE id=%s", (published,))
	expect_denied(db, 'DELETE FROM public.data_publication WHERE id=%s', (published,))
	expect_denied(db, "INSERT INTO public.user_info(first_name) VALUES ('anon')")

	act_as(db, other)
	expect_denied(db, "UPDATE public.data_publication SET doi='10.1/forged' WHERE id=%s", (published,))
	expect_denied(db, "UPDATE public.user_info SET orcid='forged'")
	expect_denied(db, 'DELETE FROM public.jt_data_publication_datasets')
	rls = psycopg.errors.InsufficientPrivilege
	expect_denied(db, "INSERT INTO public.data_publication(user_id,title) VALUES (%s,'not mine')", (owner,), rls)
	expect_denied(db, "INSERT INTO public.data_publication(user_id,title,doi) VALUES (%s,'forged','10.1/y')", (other,), rls)
	expect_denied(db, 'INSERT INTO public.jt_data_publication_datasets VALUES (%s,%s)', (published, dataset), rls)
	mine = db.execute("INSERT INTO public.data_publication(user_id,title) VALUES (%s,'mine') RETURNING id", (other,)).fetchone()[0]
	expect_denied(db, 'INSERT INTO public.jt_data_publication_datasets VALUES (%s,%s)', (mine, dataset), rls)


	# The owner's PublicationModal flow.
	act_as(db, owner)
	publication = db.execute(
		"INSERT INTO public.data_publication(user_id,title) VALUES (%s,'Mine') RETURNING id, status", (owner,)
	).fetchone()
	assert publication[1] == 'pending'
	author = db.execute(
		"INSERT INTO public.user_info(\"user\",first_name,last_name,organisation) VALUES (%s,'A','B','C') RETURNING id",
		(owner,),
	).fetchone()[0]
	db.execute('INSERT INTO public.jt_data_publication_user_info VALUES (%s,%s)', (publication[0], author))
	db.execute('INSERT INTO public.jt_data_publication_datasets VALUES (%s,%s)', (publication[0], dataset))
	expect_denied(db, 'DELETE FROM public.data_publication WHERE id=%s', (publication[0],))


# Definer functions anon may run. Every other SECURITY DEFINER function must
# check auth.uid() itself and be granted to signed-in roles only.
ANON_DEFINER_ALLOWLIST = {
	'can_audit',
	'can_view_all_private_data',
	'is_dataset_search_ready',
	'is_dataset_search_visible',
	'log_dataset_changes',
	'recompute_tile_aoi_membership',
	'search_datasets_by_embedding',
	'search_tiles_by_embedding',
	'update_flag_status',
	'v2_aois_refresh_membership',
	'validate_aoi_provenance_link',
}


def test_anon_executable_definer_functions_are_reviewed(db):
	rows = db.execute(
		"""
		SELECT DISTINCT p.proname
		FROM pg_proc p
		WHERE p.pronamespace = 'public'::regnamespace
			AND p.prosecdef
			AND has_function_privilege('anon', p.oid, 'EXECUTE')
			AND NOT EXISTS (
				SELECT 1 FROM pg_depend d
				WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
			)
		"""
	).fetchall()
	assert {name for (name,) in rows} <= ANON_DEFINER_ALLOWLIST
