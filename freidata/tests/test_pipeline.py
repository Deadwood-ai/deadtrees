import datetime as dt

import pytest

from freidata import pipeline
from freidata.pipeline import PUBLISHER_FIXED, build_record_payload, run_publication_safe
from freidata.tests.conftest import FakeDB


def test_record_payload_carries_title_authors_and_license():
	payload = build_record_payload({
		'title': '  Freiburg, Germany - part of deadtrees.earth ',
		'description': ' Drone orthophotos ',
		'authors': [
			{'first_name': 'Ada', 'last_name': 'Lovelace', 'organisation': 'Uni Freiburg', 'orcid': '0000-0002-1825-0097'},
			{'first_name': ' ', 'last_name': 'Baum', 'organisation': '', 'orcid': None},
			'not an author',
		],
	})

	md = payload['metadata']
	assert md['title'] == 'Freiburg, Germany - part of deadtrees.earth'
	assert md['description'] == 'Drone orthophotos'
	assert md['publisher'] == PUBLISHER_FIXED
	assert md['resource_type'] == {'id': 'dataset'}
	assert md['rights'] == [{'id': 'cc-by-4.0'}]
	assert md['publication_date'] == dt.date.today().isoformat()
	assert md['creators'] == [
		{
			'person_or_org': {
				'type': 'personal',
				'given_name': 'Ada',
				'family_name': 'Lovelace',
				'identifiers': [{'scheme': 'orcid', 'identifier': '0000-0002-1825-0097'}],
			},
			'affiliations': [{'name': 'Uni Freiburg'}],
		},
		{'person_or_org': {'type': 'personal', 'given_name': 'Unknown', 'family_name': 'Baum'}},
	]
	assert payload['access'] == {'record': 'public', 'files': 'public'}
	assert payload['files'] == {'enabled': True}


def test_record_payload_without_authors_credits_deadtrees():
	creators = build_record_payload({'title': 'T', 'authors': None})['metadata']['creators']
	assert creators == [{'person_or_org': {'type': 'organizational', 'name': 'deadtrees.earth'}}]


def test_a_failed_run_moves_the_publication_from_uploading_to_error(cfg, notifications, tmp_path):
	db = FakeDB([{'id': 5, 'title': 'Broken', 'doi': None, 'status': 'pending', 'freidata_record_id': None}])
	# No data_publication_full_info row: the pipeline fails after marking the upload.

	with pytest.raises(RuntimeError):
		run_publication_safe(cfg, db, tmp_path, 5)

	row = db.publications[0]
	assert row['status'] == 'error'
	assert dt.datetime.fromisoformat(row['upload_started_at']) <= dt.datetime.now(dt.timezone.utc)
	assert [n['pub_id'] for n in notifications] == [5]


def test_a_publication_with_a_doi_is_left_alone(cfg, notifications, tmp_path, monkeypatch):
	db = FakeDB([{'id': 6, 'title': 'Done', 'doi': '10.1/x', 'status': 'published', 'freidata_record_id': 'abc'}])
	monkeypatch.setattr(pipeline, 'fetch_publication_full_info', lambda *_: pytest.fail('must not run'))

	run_publication_safe(cfg, db, tmp_path, 6)

	assert db.publications[0]['status'] == 'published'
	assert notifications == []
