import requests
from urllib3.exceptions import ReadTimeoutError

from processor.src.treecover_segmentation_oam_tcd import predict_treecover


class _FakeImages:
	def get(self, _image):
		return object()


class _FakeContainer:
	def __init__(self):
		self.killed = False
		self.removed = False
		self.name = 'fake-tcd-container'

	def wait(self, timeout):
		raise requests.exceptions.ConnectionError(
			ReadTimeoutError(None, None, 'Read timed out.')
		)

	def kill(self):
		self.killed = True

	def remove(self, force=False):
		self.removed = force


class _FakeContainers:
	def __init__(self):
		self.runs = []

	def run(self, **_kwargs):
		container = _FakeContainer()
		self.runs.append(container)
		return container


class _FakeDockerClient:
	def __init__(self):
		self.images = _FakeImages()
		self.containers = _FakeContainers()


def test_tcd_wait_connection_timeout_is_controlled_and_not_retried(monkeypatch):
	client = _FakeDockerClient()
	bundles = []

	monkeypatch.setattr(predict_treecover.docker, 'from_env', lambda: client)
	monkeypatch.setattr(
		predict_treecover,
		'build_container_forensics',
		lambda *args, **kwargs: {'dataset_id': kwargs['dataset_id'], 'stage': kwargs['stage']},
	)
	monkeypatch.setattr(
		predict_treecover,
		'write_debug_bundle',
		lambda **kwargs: bundles.append(kwargs),
	)

	try:
		predict_treecover._run_tcd_pipeline_container('tcd_volume_10179_test', 10179, 'token')
	except Exception as exc:
		assert 'TCD container timed out after 4 hours' in str(exc)
	else:
		raise AssertionError('expected controlled TCD timeout')

	assert len(client.containers.runs) == 1
	assert client.containers.runs[0].killed is True
	assert client.containers.runs[0].removed is True
	assert bundles
