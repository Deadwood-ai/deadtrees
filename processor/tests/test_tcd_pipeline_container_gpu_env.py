import pytest

from processor.src.treecover_segmentation_oam_tcd import predict_treecover

pytestmark = pytest.mark.unit

VOLUME_NAME = 'tcd_volume_10179_test'
DATA_VOLUME = {VOLUME_NAME: {'bind': '/tcd_data', 'mode': 'rw'}}
MPS_DIR = '/var/run/deadtrees-mps'


class _FakeImages:
	def get(self, _image):
		return object()


class _FakeContainer:
	def __init__(self, status_code):
		self.status_code = status_code
		self.name = 'fake-tcd-container'

	def wait(self, timeout):
		return {'StatusCode': self.status_code}

	def logs(self, **_kwargs):
		return b'fake tcd output'

	def remove(self, force=False):
		pass


class _FakeContainers:
	def __init__(self, status_codes):
		self.status_codes = list(status_codes)
		self.run_kwargs = []

	def run(self, **kwargs):
		self.run_kwargs.append(kwargs)
		return _FakeContainer(self.status_codes.pop(0))


class _FakeDockerClient:
	def __init__(self, status_codes):
		self.images = _FakeImages()
		self.containers = _FakeContainers(status_codes)


def _launch(monkeypatch, *, visible_devices=None, mps_dir='', status_codes=(0,)):
	client = _FakeDockerClient(status_codes)
	monkeypatch.setattr(predict_treecover.docker, 'from_env', lambda: client)
	monkeypatch.setattr(predict_treecover, 'build_container_forensics', lambda *args, **kwargs: {})
	monkeypatch.setattr(predict_treecover, 'write_debug_bundle', lambda **kwargs: None)
	monkeypatch.setattr(predict_treecover.settings, 'CUDA_MPS_PIPE_DIRECTORY', mps_dir)
	if visible_devices is None:
		monkeypatch.delenv('NVIDIA_VISIBLE_DEVICES', raising=False)
	else:
		monkeypatch.setenv('NVIDIA_VISIBLE_DEVICES', visible_devices)

	predict_treecover._run_tcd_pipeline_container(VOLUME_NAME, 10179, 'token')
	return client.containers.run_kwargs


def test_tcd_launch_is_unchanged_without_gpu_pin_or_mps(monkeypatch):
	(kwargs,) = _launch(monkeypatch)

	assert kwargs['runtime'] == 'nvidia'
	assert kwargs['environment'] == {
		'NVIDIA_VISIBLE_DEVICES': 'all',
		'NVIDIA_DRIVER_CAPABILITIES': 'compute,utility',
	}
	assert kwargs['volumes'] == DATA_VOLUME
	assert 'device_requests' not in kwargs


def test_tcd_launch_is_unchanged_on_hosts_with_tracked_compose_default(monkeypatch):
	(kwargs,) = _launch(monkeypatch, visible_devices='all')

	assert kwargs['environment'] == {
		'NVIDIA_VISIBLE_DEVICES': 'all',
		'NVIDIA_DRIVER_CAPABILITIES': 'compute,utility',
	}
	assert kwargs['volumes'] == DATA_VOLUME


def test_tcd_launch_forwards_worker_gpu_pin(monkeypatch):
	(kwargs,) = _launch(monkeypatch, visible_devices='1')

	assert kwargs['environment'] == {
		'NVIDIA_VISIBLE_DEVICES': '1',
		'NVIDIA_DRIVER_CAPABILITIES': 'compute,utility',
	}
	assert kwargs['volumes'] == DATA_VOLUME


def test_tcd_launch_joins_mps_when_pipe_directory_is_set(monkeypatch):
	(kwargs,) = _launch(monkeypatch, visible_devices='1', mps_dir=MPS_DIR)

	assert kwargs['environment'] == {
		'NVIDIA_VISIBLE_DEVICES': '1',
		'NVIDIA_DRIVER_CAPABILITIES': 'compute,utility',
		'CUDA_MPS_PIPE_DIRECTORY': MPS_DIR,
	}
	assert kwargs['volumes'] == {
		**DATA_VOLUME,
		MPS_DIR: {'bind': MPS_DIR, 'mode': 'rw'},
	}


def test_tcd_cpu_fallback_gets_no_gpu_or_mps_wiring(monkeypatch):
	gpu_kwargs, cpu_kwargs = _launch(monkeypatch, visible_devices='1', mps_dir=MPS_DIR, status_codes=(1, 0))

	assert gpu_kwargs['runtime'] == 'nvidia'
	assert cpu_kwargs['runtime'] is None
	assert cpu_kwargs['environment'] == {}
	assert cpu_kwargs['volumes'] == DATA_VOLUME
