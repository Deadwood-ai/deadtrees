"""The saved legacy audits (dataset_audit_legacy, view dataset_audit) are read-only history."""

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


def test_auditors_read_the_history_and_nobody_writes_it(db):
	auditor, outsider = create_user(db, can_audit=True), create_user(db)
	dataset, other = (create_dataset(db, create_user(db)) for _ in range(2))
	db.execute(
		"INSERT INTO public.dataset_audit_legacy(dataset_id,audited_by,final_assessment) VALUES (%s,%s,'no_issues')",
		(dataset, auditor),
	)
	lease = uuid.uuid4()
	act_as(db, auditor)
	claim(db, dataset, lease)
	act_as(db, auditor, lease)
	assert db.execute('SELECT final_assessment FROM public.dataset_audit WHERE dataset_id=%s', (dataset,)).fetchone() == (
		'no_issues',
	)
	assert db.execute(
		'SELECT count(*) FROM public.get_dataset_audits_with_emails() WHERE dataset_id=%s', (dataset,)
	).fetchone() == (1,)
	for statement, args in (
		("UPDATE public.dataset_audit SET final_assessment='exclude_completely' WHERE dataset_id=%s", (dataset,)),
		('INSERT INTO public.dataset_audit(dataset_id,audited_by) VALUES (%s,%s)', (other, auditor)),
		('DELETE FROM public.dataset_audit WHERE dataset_id=%s', (dataset,)),
		("UPDATE public.dataset_audit_legacy SET notes='mine' WHERE dataset_id=%s", (dataset,)),
	):
		with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
			db.execute(statement, args)
	act_as(db, outsider)
	assert db.execute('SELECT count(*) FROM public.dataset_audit WHERE dataset_id=%s', (dataset,)).fetchone() == (0,)
	as_admin(db)
	for role in ('anon', 'authenticated', 'service_role'):
		for privilege in ('INSERT', 'UPDATE', 'DELETE'):
			assert not db.execute(
				"SELECT has_table_privilege(%s,'public.dataset_audit_legacy',%s)", (role, privilege)
			).fetchone()[0]
	# no trigger writes decisions or guards the lease on the history any more
	assert db.execute(
		"SELECT count(*) FROM pg_trigger WHERE tgrelid='public.dataset_audit_legacy'::regclass AND NOT tgisinternal"
	).fetchone() == (0,)


def test_a_legacy_exclusion_counts_only_once_imported_as_a_decision(db):
	dataset = create_dataset(db, create_user(db))
	db.execute(
		"INSERT INTO public.dataset_audit_legacy(dataset_id,final_assessment) VALUES (%s,'exclude_completely')", (dataset,)
	)
	assert db.execute('SELECT internal.is_dataset_excluded_from_public_surface(%s)', (dataset,)).fetchone() == (False,)
	assert db.execute('SELECT id FROM public.v2_full_dataset_view_public WHERE id=%s', (dataset,)).fetchall() == [
		(dataset,)
	]
	# nothing but the history view reads the legacy table
	assert db.execute(
		'SELECT array_agg(DISTINCT r.ev_class::regclass::text) FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid '
		"WHERE d.refobjid = 'public.dataset_audit_legacy'::regclass AND r.ev_class <> 'public.dataset_audit_legacy'::regclass"
	).fetchone() == (['dataset_audit'],)
