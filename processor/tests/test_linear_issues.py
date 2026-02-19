import pytest

from processor.src.utils import linear_issues


class MockResponse:
	def __init__(self, status_code: int, payload: dict):
		self.status_code = status_code
		self._payload = payload

	def json(self):
		return self._payload


def test_check_existing_issue_requires_exact_dataset_id(monkeypatch):
	"""Only exact 'Dataset ID: <id>' matches should be treated as duplicates."""
	monkeypatch.setattr(linear_issues.settings, 'LINEAR_API_KEY', 'test-key')

	payload = {
		'data': {
			'searchIssues': {
				'nodes': [
					{
						'identifier': 'DT-1',
						'title': '[Processing Failure] Something else (Dataset ID: 18037)',
						'description': 'Similar but not exact',
					},
					{
						'identifier': 'DT-2',
						'title': 'ODM failed',
						'description': 'Dataset ID: 8037',
					},
				]
			}
		}
	}

	def mock_post(*args, **kwargs):
		return MockResponse(200, payload)

	monkeypatch.setattr(linear_issues.requests, 'post', mock_post)

	assert linear_issues.check_existing_issue(8037) is True


def test_check_existing_issue_ignores_noisy_search_results(monkeypatch):
	"""No match should return False even when Linear search returns unrelated issues."""
	monkeypatch.setattr(linear_issues.settings, 'LINEAR_API_KEY', 'test-key')

	payload = {
		'data': {
			'searchIssues': {
				'nodes': [
					{
						'identifier': 'DT-10',
						'title': 'Dataset migration improvements',
						'description': 'No dataset id token here',
					},
					{
						'identifier': 'DT-11',
						'title': 'Another issue with Dataset ID: 80370',
						'description': 'Not exact',
					},
				]
			}
		}
	}

	def mock_post(*args, **kwargs):
		return MockResponse(200, payload)

	monkeypatch.setattr(linear_issues.requests, 'post', mock_post)

	assert linear_issues.check_existing_issue(8037) is False


def test_check_existing_issue_returns_false_without_key(monkeypatch):
	"""Duplicate check should be disabled if no API key exists."""
	monkeypatch.setattr(linear_issues.settings, 'LINEAR_API_KEY', '')
	assert linear_issues.check_existing_issue(8037) is False
