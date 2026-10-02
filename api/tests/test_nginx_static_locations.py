"""Static nginx locations must never reach private dataset files.

An ``alias`` that ends in ``/`` under a ``location`` that does not lets a request
such as ``/downloads/v1../archive/x`` escape to the parent directory. Raw uploads
(``/data/archive``) must not be aliased at all; COGs and thumbnails only behind an
authorization subrequest; prepared downloads only through the API.
"""

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIGS = [REPO_ROOT / 'nginx/api-conf/storage-server.conf', REPO_ROOT / 'nginx/test-conf/storage-server.conf']
LOCATION_ALIAS = re.compile(r'location\s+(?:\^~\s+)?(?P<prefix>/[^\s{]*)\s*\{[^}]*?\balias\s+(?P<alias>[^;]+);', re.S)


def _aliases(config: Path) -> list[tuple[str, str]]:
	if not config.exists():
		pytest.skip(f'{config.relative_to(REPO_ROOT)} is not available in this environment')
	return [(match['prefix'], match['alias'].strip()) for match in LOCATION_ALIAS.finditer(config.read_text())]


@pytest.mark.parametrize('config', CONFIGS, ids=lambda path: path.parent.name)
def test_aliases_cannot_escape_their_directory(config):
	unsafe = [(prefix, alias) for prefix, alias in _aliases(config) if alias.endswith('/') and not prefix.endswith('/')]
	assert unsafe == []


@pytest.mark.parametrize('config', CONFIGS, ids=lambda path: path.parent.name)
def test_private_and_raw_trees_are_never_served(config):
	served = [alias for _, alias in _aliases(config)]
	assert served, 'expected static locations'
	assert not [alias for alias in served if alias.startswith(('/data/private', '/data/archive'))]


def _location(text: str, prefix: str) -> str:
	match = re.search(r'location\s+' + re.escape(prefix) + r'\s*\{(?P<body>[^}]*)\}', text)
	assert match, f'missing location {prefix}'
	return match['body']


@pytest.mark.parametrize('config', CONFIGS, ids=lambda path: path.parent.name)
def test_images_and_exports_need_authorization(config):
	if not config.exists():
		pytest.skip('nginx config not mounted')
	text = config.read_text()
	assert 'internal;' in _location(text, '^~ /_protected_data/')
	for prefix in ('/cogs/v1/', '/thumbnails/v1/'):
		body = _location(text, prefix)
		assert 'auth_request /_authorize_public_file;' in body
		assert 'autoindex off;' in body
	assert 'return 404;' in _location(text, '/downloads/v1')
	assert 'alias /data/downloads' not in text
	assert 'internal;' in _location(text, '= /_authorize_public_file')
