import pytest

from processor.src.utils import linear_issues

pytestmark = pytest.mark.unit


class MockResponse:
	def __init__(self, status_code: int, payload: dict):
		self.status_code = status_code
		self._payload = payload
		self.text = ''

	def json(self):
		return self._payload


def _search_payload(*nodes):
	return {'data': {'searchIssues': {'nodes': list(nodes)}}}


@pytest.fixture
def linear_enabled(monkeypatch):
	monkeypatch.setattr(linear_issues.settings, 'LINEAR_ENABLED', True)
	monkeypatch.setattr(linear_issues.settings, 'LINEAR_API_KEY', 'test-key')
	monkeypatch.setattr(linear_issues, 'get_dataset_context', lambda token, dataset_id: {'file_name': 'a.tif'})
	monkeypatch.setattr(linear_issues, 'get_recent_error_logs', lambda token, dataset_id: [])


@pytest.mark.parametrize(
	'stage,expected',
	[
		('cog', 'processor/failure/cog_processing'),
		('cog_processing', 'processor/failure/cog_processing'),
		('convert', 'processor/failure/ortho_processing'),
		('treecover_segmentation', 'processor/failure/forest_cover_segmentation'),
		('embeddings_v1', 'processor/failure/embedding_processing'),
		('odm_processing', 'processor/failure/odm_processing'),
		('processing', 'processor/failure/unknown'),
		(None, 'processor/failure/unknown'),
	],
)
def test_failure_fingerprint_names_one_key_per_stage(stage, expected):
	assert linear_issues.failure_fingerprint(stage) == expected


def test_find_open_cluster_issue_requires_exact_fingerprint_line_on_open_issue(monkeypatch):
	monkeypatch.setattr(linear_issues.settings, 'LINEAR_API_KEY', 'test-key')
	payload = _search_payload(
		{'id': '1', 'identifier': 'DT-1', 'description': 'fingerprint: processor/failure/cog_processing_extra', 'state': {'type': 'triage'}},
		{'id': '2', 'identifier': 'DT-2', 'description': 'fingerprint: processor/failure/cog_processing', 'state': {'type': 'completed'}},
		{'id': '3', 'identifier': 'DT-3', 'description': 'intro\n\nfingerprint: processor/failure/cog_processing', 'state': {'type': 'backlog'}},
	)
	monkeypatch.setattr(linear_issues.requests, 'post', lambda *args, **kwargs: MockResponse(200, payload))

	assert linear_issues.find_open_cluster_issue('processor/failure/cog_processing')['identifier'] == 'DT-3'


def test_report_comments_on_existing_cluster_issue(monkeypatch, linear_enabled):
	calls = []

	def mock_post(*args, json, **kwargs):
		calls.append(json)
		if 'searchIssues' in json['query']:
			return MockResponse(200, _search_payload({'id': 'abc', 'identifier': 'DT-7', 'description': 'fingerprint: processor/failure/cog_processing', 'state': {'type': 'backlog'}}))
		return MockResponse(200, {'data': {'commentCreate': {'success': True}}})

	monkeypatch.setattr(linear_issues.requests, 'post', mock_post)

	assert linear_issues.report_processing_failure('token', 42, 'cog', 'boom') == 'DT-7'
	assert ['issueCreate' in call['query'] for call in calls] == [False, False]
	assert calls[1]['variables']['input']['issueId'] == 'abc'
	assert 'Dataset ID:** 42' in calls[1]['variables']['input']['body']


def test_report_opens_medium_triage_cluster_issue_when_none_is_open(monkeypatch, linear_enabled):
	calls = []

	def mock_post(*args, json, **kwargs):
		calls.append(json)
		if 'searchIssues' in json['query']:
			return MockResponse(200, _search_payload())
		if 'issueCreate' in json['query']:
			return MockResponse(200, {'data': {'issueCreate': {'success': True, 'issue': {'id': 'new', 'identifier': 'DT-9'}}}})
		return MockResponse(200, {'data': {'commentCreate': {'success': True}}})

	monkeypatch.setattr(linear_issues.requests, 'post', mock_post)

	assert linear_issues.report_processing_failure('token', 42, 'odm_processing', 'boom') == 'DT-9'
	created = calls[1]['variables']['input']
	assert created['priority'] == linear_issues.LINEAR_PRIORITY_MEDIUM
	assert created['title'] == 'Processing failures: ODM'
	assert created['description'].endswith('fingerprint: processor/failure/odm_processing')
	assert calls[2]['variables']['input']['issueId'] == 'new'


def test_report_never_raises_when_linear_fails(monkeypatch, linear_enabled):
	monkeypatch.setattr(linear_issues.requests, 'post', lambda *args, **kwargs: MockResponse(500, {}))
	assert linear_issues.report_processing_failure('token', 42, 'cog', 'boom') is None


def test_report_is_skipped_without_key(monkeypatch):
	monkeypatch.setattr(linear_issues.settings, 'LINEAR_ENABLED', True)
	monkeypatch.setattr(linear_issues.settings, 'LINEAR_API_KEY', '')
	monkeypatch.setattr(linear_issues.requests, 'post', lambda *args, **kwargs: pytest.fail('no request expected'))
	assert linear_issues.report_processing_failure('token', 42, 'cog', 'boom') is None
