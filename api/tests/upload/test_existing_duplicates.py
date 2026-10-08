"""Which copy of a duplicated file stays, which are archived, and who is told what."""

from uuid import UUID

from api.src.upload.existing_duplicates import (
	DuplicateCandidate,
	archive_sql,
	notification_idempotency_key,
	owner_summaries,
	plan_duplicate_groups,
	sha256_of_file,
)
from shared.notifications.templates import duplicates_archived_email


def _candidate(dataset_id, tmp_path, content=b'same file', fingerprint='fp', **overrides):
	path = tmp_path / f'{dataset_id}_ortho.tif'
	if content is not None:
		path.write_bytes(content)
	values = {
		'id': dataset_id,
		'user_id': f'user-{dataset_id}',
		'file_name': f'{dataset_id}.tif',
		'created_at': f'2025-01-{dataset_id:02d}T00:00:00+00:00',
		'is_private': False,
		'is_excluded': False,
		'has_error': False,
		'is_published': False,
		'files': {fingerprint: path},
	}
	return DuplicateCandidate(**{**values, **overrides})


def _plan(*candidates):
	return plan_duplicate_groups(candidates, sha256_of_file)


def _kept_and_archived(group):
	return group['keep']['id'], [copy['id'] for copy in group['archive']]


def test_oldest_copy_is_kept(tmp_path):
	[group] = _plan(_candidate(2, tmp_path), _candidate(1, tmp_path), _candidate(3, tmp_path))

	assert _kept_and_archived(group) == (1, [2, 3])
	assert group['review'] is None


def test_public_copy_is_kept_over_an_older_private_one(tmp_path):
	[group] = _plan(_candidate(1, tmp_path, is_private=True), _candidate(2, tmp_path))

	assert _kept_and_archived(group) == (2, [1])


def test_copy_excluded_by_audit_is_not_kept_when_another_exists(tmp_path):
	[group] = _plan(_candidate(1, tmp_path, is_excluded=True), _candidate(2, tmp_path, is_private=True))

	assert _kept_and_archived(group) == (2, [1])


def test_datasets_with_different_files_are_not_grouped(tmp_path):
	assert _plan(_candidate(1, tmp_path, fingerprint='a'), _candidate(2, tmp_path, fingerprint='b')) == []


def test_copy_is_archived_only_when_the_whole_file_is_identical(tmp_path):
	"""The fingerprint samples the file; a differing or missing file must be left alone."""
	[group] = _plan(
		_candidate(1, tmp_path),
		_candidate(2, tmp_path, content=b'same size'),
		_candidate(3, tmp_path, content=None),
		_candidate(4, tmp_path),
	)

	assert _kept_and_archived(group) == (1, [4])
	assert group['unconfirmed'] == [2, 3]


def test_nothing_is_archived_when_the_kept_file_is_missing(tmp_path):
	[group] = _plan(_candidate(1, tmp_path, content=None), _candidate(2, tmp_path))

	assert group['archive'] == []
	assert group['unconfirmed'] == [2]


def test_published_copy_and_failed_keeper_need_a_manual_decision(tmp_path):
	[published] = _plan(_candidate(1, tmp_path), _candidate(2, tmp_path, is_published=True))
	[failed_keeper] = _plan(_candidate(1, tmp_path, has_error=True), _candidate(2, tmp_path))

	assert published['review'] and failed_keeper['review']
	assert archive_sql([published, failed_keeper]) == '-- No confirmed duplicates to archive.\n'


def test_dataset_is_archived_at_most_once_across_its_files(tmp_path):
	"""A ZIP upload holds two files (ZIP and orthomosaic) and can be a copy in two groups."""
	shared_zip, shared_ortho = tmp_path / 'zip', tmp_path / 'ortho'
	shared_zip.write_bytes(b'zip')
	shared_ortho.write_bytes(b'ortho')
	both = _candidate(3, tmp_path, files={'zip-fp': shared_zip, 'ortho-fp': shared_ortho})

	groups = _plan(
		_candidate(1, tmp_path, files={'ortho-fp': shared_ortho}),
		_candidate(2, tmp_path, files={'zip-fp': shared_zip}),
		both,
	)

	assert [_kept_and_archived(group) for group in groups] == [(1, [3])]


def test_archive_sql_lists_confirmed_copies_and_leaves_the_commit_to_the_operator(tmp_path):
	sql = archive_sql(_plan(_candidate(1, tmp_path), _candidate(2, tmp_path), _candidate(3, tmp_path)))

	assert 'set archived = true where not archived and id in (2, 3);' in sql
	assert sql.startswith('begin;')
	assert '\ncommit;' not in sql


def test_owner_summary_names_the_kept_dataset_only_when_the_owner_may_see_it(tmp_path):
	groups = _plan(
		_candidate(1, tmp_path, is_private=True, user_id='alice'),
		_candidate(2, tmp_path, is_private=True, user_id='alice'),
		_candidate(3, tmp_path, is_private=True, user_id='bob'),
	)

	summaries = owner_summaries(groups, archived_ids={2, 3})

	assert summaries == {
		'alice': [{'id': 2, 'file_name': '2.tif', 'kept_dataset_id': 1}],
		'bob': [{'id': 3, 'file_name': '3.tif', 'kept_dataset_id': None}],
	}


def test_owner_summary_skips_copies_that_were_not_archived(tmp_path):
	groups = _plan(_candidate(1, tmp_path), _candidate(2, tmp_path), _candidate(3, tmp_path))

	assert list(owner_summaries(groups, archived_ids={3})) == ['user-3']


def test_archive_email_lists_datasets_without_revealing_a_hidden_keeper():
	subject, text_body, html_body = duplicates_archived_email(
		[
			{'id': 2, 'file_name': 'a<b>.tif', 'kept_dataset_id': 1},
			{'id': 3, 'file_name': 'c.tif', 'kept_dataset_id': None},
		]
	)

	assert 'archived' in subject
	assert 'Dataset 2 (a<b>.tif): kept is dataset 1 (https://deadtrees.earth/dataset/1)' in text_body
	assert 'Dataset 3 (c.tif): kept is another upload of the same file' in text_body
	assert 'a&lt;b&gt;.tif' in html_body
	assert 'info@deadtrees.earth' in text_body


def test_notification_key_is_a_stable_uuid_per_owner_and_datasets():
	"""Brevo rejects other formats; the same summary must map to the same key so a resend is dropped."""
	datasets = [{'id': 2}, {'id': 3}]

	key = notification_idempotency_key('alice', datasets)

	assert str(UUID(key)) == key
	assert key == notification_idempotency_key('alice', datasets)
	assert key != notification_idempotency_key('bob', datasets)
	assert key != notification_idempotency_key('alice', [{'id': 2}])
