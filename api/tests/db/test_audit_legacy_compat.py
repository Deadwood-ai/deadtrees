"""dataset_audit is a view over dataset_audit_legacy: readers and the audit page work as before (DT-1481)."""

import uuid

import psycopg
import pytest

from api.tests.db.test_acquisition_date_estimates import create_dataset, create_user, db  # noqa: F401
from api.tests.db.test_dataset_audit_lease import act_as, as_admin, claim


def columns(db, name):
	return db.execute(
		'SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns '
		"WHERE table_schema='public' AND table_name=%s",
		(name,),
	).fetchone()[0]


def test_the_view_has_the_columns_of_the_table_in_their_order(db):
	assert db.execute("SELECT relkind FROM pg_class WHERE oid='public.dataset_audit'::regclass").fetchone() == ('v',)
	assert columns(db, 'dataset_audit') == columns(db, 'dataset_audit_legacy')
	assert len(columns(db, 'dataset_audit')) == 23


def test_the_audit_page_saves_through_the_view_as_before(db):
	auditor, colleague, outsider = create_user(db, can_audit=True), create_user(db, can_audit=True), create_user(db)
	dataset, other = (create_dataset(db, create_user(db)) for _ in range(2))
	lease = uuid.uuid4()
	act_as(db, auditor)
	claim(db, dataset, lease)
	act_as(db, auditor, lease)
	# insert with defaults and RETURNING, as supabase-js .insert().select().single() does
	row = db.execute(
		"INSERT INTO public.dataset_audit(dataset_id,audited_by,final_assessment) VALUES (%s,%s,'no_issues') "
		'RETURNING dataset_id, audit_date IS NOT NULL, final_assessment',
		(dataset, auditor),
	).fetchone()
	assert row == (dataset, True, 'no_issues')
	# update with RETURNING, and the upsert of the e2e flow (ON CONFLICT DO NOTHING)
	assert db.execute(
		"UPDATE public.dataset_audit SET final_assessment='exclude_completely' WHERE dataset_id=%s RETURNING final_assessment",
		(dataset,),
	).fetchone() == ('exclude_completely',)
	assert (
		db.execute(
			"INSERT INTO public.dataset_audit(dataset_id,audited_by,final_assessment) VALUES (%s,%s,'no_issues') "
			'ON CONFLICT (dataset_id) DO NOTHING',
			(dataset, auditor),
		).rowcount
		== 0
	)
	# the table's lease guard still fires through the view: another page holds this dataset
	with pytest.raises(psycopg.errors.ObjectInUse), db.transaction():
		act_as(db, colleague)
		db.execute("UPDATE public.dataset_audit SET notes='mine' WHERE dataset_id=%s", (dataset,))
	# and its row policies still decide: a non-auditor sees and writes nothing
	act_as(db, outsider)
	assert db.execute('SELECT count(*) FROM public.dataset_audit WHERE dataset_id=%s', (dataset,)).fetchone() == (0,)
	with pytest.raises(psycopg.Error), db.transaction():
		db.execute('INSERT INTO public.dataset_audit(dataset_id,audited_by) VALUES (%s,%s)', (other, outsider))
	as_admin(db)
	assert db.execute(
		'SELECT final_assessment FROM public.dataset_audit_legacy WHERE dataset_id=%s', (dataset,)
	).fetchone() == ('exclude_completely',)


def test_an_exclusion_saved_through_the_view_still_hides_the_dataset_publicly(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	assert db.execute('SELECT internal.is_dataset_excluded_from_public_surface(%s)', (dataset,)).fetchone() == (False,)
	lease = uuid.uuid4()
	act_as(db, auditor)
	claim(db, dataset, lease)
	act_as(db, auditor, lease)
	db.execute(
		"INSERT INTO public.dataset_audit(dataset_id,audited_by,final_assessment) VALUES (%s,%s,'exclude_completely')",
		(dataset, auditor),
	)
	as_admin(db)
	assert db.execute('SELECT internal.is_dataset_excluded_from_public_surface(%s)', (dataset,)).fetchone() == (True,)
	# the views compiled against the table read the same row
	assert db.execute('SELECT id FROM public.v2_full_dataset_view_public WHERE id=%s', (dataset,)).fetchall() == []
	assert (
		db.execute(
			'SELECT count(*) FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid '
			"WHERE d.refobjid = 'public.dataset_audit_legacy'::regclass AND r.ev_class <> 'public.dataset_audit'::regclass"
		).fetchone()[0]
		>= 6
	)
