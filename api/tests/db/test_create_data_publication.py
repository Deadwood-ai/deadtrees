"""create_data_publication writes a publication, its authors and datasets together.

These contracts run on the isolated local database only.
"""
import json

import psycopg

from api.tests.db.test_correction_and_publication_access import (  # noqa: F401
	act_as,
	as_admin,
	as_anon,
	create_dataset,
	create_user,
	db,
	expect_denied,
)

CREATE = 'SELECT public.create_data_publication(%s, %s, %s::jsonb, %s::bigint[])'
AUTHORS = json.dumps([
	{'first_name': 'Ada', 'last_name': 'Lovelace', 'organisation': 'Uni', 'orcid': '0000-0002-1825-0097'},
	{'first_name': 'Bea', 'last_name': 'Baum', 'organisation': 'Wald', 'orcid': '', 'title': 'Dr.'},
])


def publication_rows(db, user):
	"""Publications, author records and links owned by the user."""
	as_admin(db)
	return db.execute(
		"""
		SELECT
			(SELECT count(*) FROM public.data_publication WHERE user_id = %(user)s),
			(SELECT count(*) FROM public.user_info WHERE "user" = %(user)s),
			(SELECT count(*) FROM public.jt_data_publication_user_info l
				JOIN public.data_publication p ON p.id = l.publication_id WHERE p.user_id = %(user)s),
			(SELECT count(*) FROM public.jt_data_publication_datasets l
				JOIN public.data_publication p ON p.id = l.publication_id WHERE p.user_id = %(user)s)
		""",
		{'user': user},
	).fetchone()


def test_owner_creates_a_complete_pending_publication(db):
	owner = create_user(db)
	datasets = [create_dataset(db, owner), create_dataset(db, owner)]

	act_as(db, owner)
	publication = db.execute(CREATE, ('Title', 'Description', AUTHORS, datasets)).fetchone()[0]

	as_admin(db)
	assert db.execute(
		'SELECT title, description, user_id, status, doi FROM public.data_publication WHERE id=%s', (publication,)
	).fetchone() == ('Title', 'Description', owner, 'pending', None)
	assert db.execute(
		'SELECT u.first_name, u.orcid, u.title FROM public.jt_data_publication_user_info l '
		'JOIN public.user_info u ON u.id = l.user_info_id WHERE l.publication_id=%s ORDER BY u.first_name',
		(publication,),
	).fetchall() == [('Ada', '0000-0002-1825-0097', None), ('Bea', None, 'Dr.')]
	assert sorted(
		row[0] for row in db.execute(
			'SELECT dataset_id FROM public.jt_data_publication_datasets WHERE publication_id=%s', (publication,)
		).fetchall()
	) == sorted(datasets)
	# freidata/ reads the publication through this view.
	assert db.execute(
		'SELECT jsonb_array_length(authors::jsonb), jsonb_array_length(datasets::jsonb) '
		'FROM public.data_publication_full_info WHERE publication_id=%s',
		(publication,),
	).fetchone() == (2, 2)


def test_a_failure_part_way_leaves_no_partial_publication(db):
	owner, other = create_user(db), create_user(db)
	mine, foreign = create_dataset(db, owner), create_dataset(db, other)
	missing = foreign + 1_000_000
	incomplete_author = json.dumps([json.loads(AUTHORS)[0], {'first_name': 'No', 'last_name': 'Org'}])

	for authors, datasets, error in [
		# The last dataset link fails after the publication and authors were written.
		(AUTHORS, [mine, foreign], psycopg.errors.InsufficientPrivilege),
		(AUTHORS, [mine, missing], psycopg.errors.InsufficientPrivilege),
		# The second author fails after the first was written.
		(incomplete_author, [mine], psycopg.errors.InvalidParameterValue),
		('[]', [mine], psycopg.errors.InvalidParameterValue),
		(AUTHORS, [], psycopg.errors.InvalidParameterValue),
	]:
		act_as(db, owner)
		expect_denied(db, CREATE, ('Title', None, authors, datasets), error)
		assert publication_rows(db, owner) == (0, 0, 0, 0)


def test_datasets_in_a_pending_publication_cannot_be_submitted_again(db):
	owner = create_user(db)
	first, second = create_dataset(db, owner), create_dataset(db, owner)

	act_as(db, owner)
	publication = db.execute(CREATE, ('First', None, AUTHORS, [first])).fetchone()[0]
	expect_denied(db, CREATE, ('Again', None, AUTHORS, [second, first]), psycopg.errors.UniqueViolation)
	assert publication_rows(db, owner) == (1, 2, 2, 1)

	# Once the publication has a DOI its datasets may join a new one.
	as_admin(db)
	db.execute("UPDATE public.data_publication SET doi='10.1/x', status='published' WHERE id=%s", (publication,))
	act_as(db, owner)
	db.execute(CREATE, ('Second', None, AUTHORS, [first, second]))
	assert publication_rows(db, owner) == (2, 4, 4, 3)


def test_anonymous_callers_cannot_create_publications(db):
	owner = create_user(db)
	dataset = create_dataset(db, owner)

	as_anon(db)
	expect_denied(db, CREATE, ('Title', None, AUTHORS, [dataset]))
	assert publication_rows(db, owner) == (0, 0, 0, 0)
