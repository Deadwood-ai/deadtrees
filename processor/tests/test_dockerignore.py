from pathlib import Path

import pytest

pytestmark = pytest.mark.unit


def _dockerignore_patterns() -> set[str]:
	return {
		line.strip()
		for line in Path('.dockerignore').read_text().splitlines()
		if line.strip() and not line.lstrip().startswith('#')
	}


def test_processor_runtime_artifacts_are_excluded_from_docker_context():
	patterns = _dockerignore_patterns()

	assert 'processor/temp/' in patterns
	assert 'processor/tmp/' in patterns
	assert 'processor/.cache/' in patterns
	assert 'processor/tcd_test_output/' in patterns
