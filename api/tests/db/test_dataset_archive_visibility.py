"""Archive feed visibility must stay exact while being resolved once per query."""
import json
import uuid

import pytest

from api.tests.db.test_factory import db  # noqa: F401
from api.tests.db.test_factory_query_plans import walk_plan


def account(db, *, sees_all=False):
	identity = uuid.uuid4()
	db.execute('INSERT INTO auth.users (id,email) VALUES (%s,%s)', (identity, f'{identity}@example.invalid'))
	if sees_all:
		db.execute(
			'INSERT INTO public.privileged_users (user_id,can_view_all_private) VALUES (%s,true)', (identity,)
		)
	return identity


def archive_dataset(db, owner, *, access='public', archived=False, excluded=False, labels=()):
	"""A dataset that meets every archive readiness predicate."""
	row = db.execute(
		"""INSERT INTO public.v2_datasets (user_id,file_name,license,platform,data_access,archived,authors)
		VALUES (%s,'archive.tif','CC BY','drone',%s,%s,ARRAY['Archive Test']) RETURNING id""",
		(owner, access, archived),
	).fetchone()[0]
	db.execute(
		"""INSERT INTO public.v2_statuses (dataset_id,is_cog_done,is_thumbnail_done,is_metadata_done)
		VALUES (%s,true,true,true)""",
		(row,),
	)
	db.execute(
		"""INSERT INTO public.v2_orthos (dataset_id,ortho_file_name,version,ortho_file_size,bbox,sha256,ortho_upload_runtime)
		VALUES (%s,'archive.tif',1,1,'BOX(13.40 52.50,13.41 52.51)','x',0.1)""",
		(row,),
	)
	db.execute(
		"""INSERT INTO public.v2_thumbnails (dataset_id,thumbnail_path,version,thumbnail_file_name,thumbnail_file_size,thumbnail_processing_runtime)
		VALUES (%s,'t.png',1,'t.png',1,0.1)""",
		(row,),
	)
	db.execute(
		"""INSERT INTO public.v2_metadata (dataset_id,metadata,version,processing_runtime)
		VALUES (%s,'{"gadm":{"admin_level_1":"Germany"}}',1,0.1)""",
		(row,),
	)
	if excluded:
		db.execute(
			"INSERT INTO public.dataset_audit (dataset_id,final_assessment) VALUES (%s,'exclude_completely')", (row,)
		)
	for source in labels:
		db.execute(
			"""INSERT INTO public.v2_labels (dataset_id,user_id,label_source,label_type,label_data)
			VALUES (%s,%s,%s,'semantic_segmentation','deadwood')""",
			(row, owner, source),
		)
	return row


def act_as(db, identity):
	db.execute('RESET ROLE')
	if identity is None:
		db.execute("SELECT set_config('request.jwt.claims','',true)")
		db.execute('SET LOCAL ROLE anon')
		return
	db.execute(
		"SELECT set_config('request.jwt.claims',%s,true)",
		(json.dumps({'sub': str(identity), 'role': 'authenticated'}),),
	)
	db.execute('SET LOCAL ROLE authenticated')


@pytest.fixture
def world(db):
	owner, stranger, privileged = account(db), account(db), account(db, sees_all=True)
	rows = {
		'public': archive_dataset(db, owner, labels=('visual_interpretation', 'model_prediction')),
		'public_predicted': archive_dataset(db, owner, labels=('model_prediction',)),
		'private': archive_dataset(db, owner, access='private', labels=('visual_interpretation',)),
		'public_excluded': archive_dataset(db, owner, excluded=True, labels=('visual_interpretation',)),
		'private_excluded': archive_dataset(db, owner, access='private', excluded=True),
		'archived': archive_dataset(db, owner, archived=True),
		'archived_excluded': archive_dataset(db, owner, archived=True, excluded=True),
	}
	callers = {'anonymous': None, 'stranger': stranger, 'owner': owner, 'privileged': privileged}
	return rows, callers


@pytest.mark.parametrize('caller', ['anonymous', 'stranger', 'owner', 'privileged'])
def test_excluded_set_matches_per_row_check_for_every_caller(db, world, caller):
	rows, callers = world
	act_as(db, callers[caller])
	per_row = {
		row
		for row in rows.values()
		if db.execute('SELECT internal.is_dataset_excluded_from_public_surface(%s)', (row,)).fetchone()[0]
	}
	resolved = {
		row
		for (row,) in db.execute(
			'SELECT id FROM internal.public_surface_excluded_dataset_ids() id WHERE id = ANY(%s)',
			(list(rows.values()),),
		)
	}
	assert resolved == per_row


@pytest.mark.parametrize(
	'caller,visible',
	[
		('anonymous', {'public', 'public_predicted'}),
		('stranger', {'public', 'public_predicted'}),
		('owner', {'public', 'public_predicted', 'private'}),
		('privileged', {'public', 'public_predicted', 'private'}),
	],
)
def test_archive_rows_and_label_flags_follow_caller_visibility(db, world, caller, visible):
	rows, callers = world
	act_as(db, callers[caller])
	names = {row: name for name, row in rows.items()}
	archive = {
		names[row]: (has_labels, has_prediction)
		for row, has_labels, has_prediction in db.execute(
			"""SELECT id,has_labels,has_deadwood_prediction FROM public.public_dataset_archive_items
			WHERE id = ANY(%s)""",
			(list(rows.values()),),
		)
	}
	expected = {'public': (True, True), 'public_predicted': (False, True), 'private': (True, False)}
	assert archive == {name: expected[name] for name in visible}


@pytest.mark.parametrize(
	'caller,visible',
	[
		('anonymous', {'public', 'public_predicted'}),
		('stranger', {'public', 'public_predicted'}),
		# Owners and privileged viewers keep raw access to their excluded labels.
		('owner', {'public', 'public_predicted', 'private', 'public_excluded'}),
		('privileged', {'public', 'public_predicted', 'private', 'public_excluded'}),
	],
)
def test_raw_label_reads_follow_caller_visibility(db, world, caller, visible):
	rows, callers = world
	act_as(db, callers[caller])
	names = {row: name for name, row in rows.items()}
	labelled = {
		names[row]
		for (row,) in db.execute(
			'SELECT DISTINCT dataset_id FROM public.v2_labels WHERE dataset_id = ANY(%s)', (list(rows.values()),)
		)
	}
	assert labelled == visible


def test_archive_resolves_exclusions_once_per_query(db, world):
	"""Per-row SECURITY DEFINER calls are what pushed the feed past the anon timeout."""
	act_as(db, None)
	plan = db.execute(
		'EXPLAIN (FORMAT JSON) SELECT * FROM public.public_dataset_archive_items ORDER BY id DESC'
	).fetchone()[0][0]['Plan']
	assert 'is_dataset_excluded_from_public_surface' not in json.dumps(plan)
	assert any(
		'hashed SubPlan' in node.get('Filter', '') for node in walk_plan(plan)
	), 'excluded datasets should be a hashed set, not a per-row lookup'
	db.execute('RESET ROLE')
	policies = db.execute(
		"""SELECT string_agg(qual, ' ') FROM pg_policies
		WHERE schemaname='public' AND tablename IN ('v2_datasets','v2_labels')"""
	).fetchone()[0]
	assert 'is_dataset_excluded_from_public_surface' not in policies
