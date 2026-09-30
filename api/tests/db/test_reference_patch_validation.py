"""set_reference_patch_validation writes a patch and recomputes its ancestors together.

These contracts run on the isolated local database only.
"""
import json
import threading

import psycopg

from api.tests.db.test_correction_and_publication_access import (  # noqa: F401
	POLYGON,
	act_as,
	as_admin,
	as_anon,
	create_dataset,
	create_user,
	db,
	expect_denied,
)
from shared.settings import settings

SET = 'SELECT id FROM public.set_reference_patch_validation(%s, %s::text[], %s)'
BOTH = ['deadwood', 'forest_cover']


def create_patch(db, dataset, auditor, resolution, parent=None, index='0'):
	as_admin(db)
	return db.execute(
		'INSERT INTO public.reference_patches(dataset_id,user_id,resolution_cm,parent_tile_id,geometry,patch_index,'
		'bbox_minx,bbox_miny,bbox_maxx,bbox_maxy) '
		'VALUES (%s,%s,%s,%s,%s::jsonb,%s,13,52,14,53) RETURNING id',
		(dataset, auditor, resolution, parent, json.dumps(POLYGON), index),
	).fetchone()[0]


def create_hierarchy(db, dataset, auditor):
	"""One 20 cm patch with two 10 cm children, each with two 5 cm children."""
	root = create_patch(db, dataset, auditor, 20)
	middles = [create_patch(db, dataset, auditor, 10, root, f'0_{i}') for i in range(2)]
	leaves = {m: [create_patch(db, dataset, auditor, 5, m, f'0_{i}_{j}') for j in range(2)] for i, m in enumerate(middles)}
	return root, middles, leaves


def validation(db, patch):
	as_admin(db)
	return db.execute(
		'SELECT deadwood_validated, forest_cover_validated FROM public.reference_patches WHERE id=%s', (patch,)
	).fetchone()


def test_validating_a_patch_recomputes_its_parent_and_grandparent(db):
	owner, auditor = create_user(db), create_user(db, can_audit=True)
	dataset = create_dataset(db, owner)
	root, (first, second), leaves = create_hierarchy(db, dataset, auditor)

	act_as(db, auditor)
	db.execute(SET, (leaves[first][0], ['deadwood'], True))
	# A parent stays unvalidated while any child is.
	assert validation(db, first) == (None, None)
	assert validation(db, root) == (None, None)

	act_as(db, auditor)
	db.execute(SET, (leaves[first][1], ['deadwood'], True))
	assert validation(db, first) == (True, None)
	assert validation(db, root) == (None, None)

	act_as(db, auditor)
	for leaf in leaves[second]:
		db.execute(SET, (leaf, ['deadwood'], True))
	assert validation(db, second) == (True, None)
	assert validation(db, root) == (True, None)

	# One bad child makes the parent and grandparent bad.
	act_as(db, auditor)
	db.execute(SET, (leaves[second][0], ['deadwood'], False))
	assert validation(db, second) == (False, None)
	assert validation(db, root) == (False, None)

	# Resetting a child makes its ancestors unvalidated again.
	act_as(db, auditor)
	db.execute(SET, (leaves[second][0], ['deadwood'], None))
	assert validation(db, second) == (None, None)
	assert validation(db, root) == (None, None)


def test_both_layers_are_set_and_propagated_in_one_call(db):
	owner, auditor = create_user(db), create_user(db, can_audit=True)
	dataset = create_dataset(db, owner)
	root, (first, second), leaves = create_hierarchy(db, dataset, auditor)

	act_as(db, auditor)
	for leaf in leaves[first] + leaves[second]:
		db.execute(SET, (leaf, BOTH, True))
	assert validation(db, root) == (True, True)

	# A 10 cm patch validated directly updates its 20 cm parent.
	act_as(db, auditor)
	db.execute(SET, (second, ['forest_cover'], False))
	assert validation(db, second) == (True, False)
	assert validation(db, root) == (True, False)


def test_invalid_layers_are_rejected(db):
	owner, auditor = create_user(db), create_user(db, can_audit=True)
	patch = create_patch(db, create_dataset(db, owner), auditor, 20)

	act_as(db, auditor)
	for layers in ([], ['ortho'], ['deadwood', 'status']):
		expect_denied(db, SET, (patch, layers, True), psycopg.errors.InvalidParameterValue)
	assert validation(db, patch) == (None, None)


def test_only_auditors_can_set_validation(db):
	owner, auditor, other = create_user(db), create_user(db, can_audit=True), create_user(db)
	dataset = create_dataset(db, owner)
	root, (first, _), leaves = create_hierarchy(db, dataset, auditor)

	as_anon(db)
	expect_denied(db, SET, (leaves[first][0], BOTH, True))
	for user in (owner, other):
		act_as(db, user)
		expect_denied(db, SET, (leaves[first][0], BOTH, True))
	assert validation(db, leaves[first][0]) == (None, None)
	assert validation(db, root) == (None, None)


def test_concurrent_sibling_validations_leave_the_parent_consistent():
	"""Two auditors validate the two children of one parent at the same time."""
	with psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin', autocommit=True) as setup:
		as_admin(setup)
		owner, auditor = create_user(setup), create_user(setup, can_audit=True)
		dataset = create_dataset(setup, owner)
		parent = create_patch(setup, dataset, auditor, 10)
		children = [create_patch(setup, dataset, auditor, 5, parent, f'0_{i}') for i in range(2)]
		try:
			with (
				psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin') as first,
				psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin') as second,
			):
				act_as(first, auditor)
				first.execute(SET, (children[0], BOTH, True))

				def validate_second():
					act_as(second, auditor)
					second.execute(SET, (children[1], BOTH, True))
					second.commit()

				# The second call waits for the parent lock held by the first.
				worker = threading.Thread(target=validate_second)
				worker.start()
				worker.join(timeout=1)
				assert worker.is_alive()
				first.commit()
				worker.join(timeout=10)
				assert not worker.is_alive()

			assert validation(setup, parent) == (True, True)
		finally:
			as_admin(setup)
			setup.execute('DELETE FROM public.reference_patches WHERE dataset_id=%s', (dataset,))
			setup.execute('DELETE FROM public.v2_statuses WHERE dataset_id=%s', (dataset,))
			setup.execute('DELETE FROM public.v2_datasets WHERE id=%s', (dataset,))
			setup.execute('DELETE FROM public.privileged_users WHERE user_id=%s', (auditor,))
			setup.execute('DELETE FROM auth.users WHERE id = ANY(%s)', ([owner, auditor],))


def test_unknown_patches_are_reported(db):
	auditor = create_user(db, can_audit=True)
	act_as(db, auditor)
	expect_denied(db, SET, (-1, BOTH, True))
