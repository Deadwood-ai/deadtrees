from pathlib import Path
import re

import pytest


pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
	'config_path',
	[
		Path('nginx/api-conf/storage-server.conf'),
		Path('nginx/test-conf/storage-server.conf'),
	],
)
def test_warnkarte_upload_routes_have_ingress_body_limit(config_path):
	config = config_path.read_text()
	location = re.search(
		r'location ~ \^/api/v1/priwa/warnkarte/\(validate\|import\)\$ \{(?P<body>.*?)\n    \}',
		config,
		flags=re.DOTALL,
	)

	assert location is not None
	assert 'client_max_body_size 52M;' in location.group('body')
