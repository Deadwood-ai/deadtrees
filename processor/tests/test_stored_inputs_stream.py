"""The audit checks read the COG streamed (range requests) and copy it only as a fallback (DT-1561)."""

from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from processor.src.utils import stored_inputs
from shared.logging import LogContext, LogCategory
from shared.models import Cog

pytestmark = pytest.mark.unit

COG = Cog(
	dataset_id=7,
	cog_file_name='a.tif',
	cog_path='7/a.tif',
	version=1,
	cog_info={},
	cog_processing_runtime=0,
	cog_file_size=1,
)
CTX = LogContext(category=LogCategory.PROCESS, dataset_id=7)


class Response:
	def __init__(self, files):
		self.files = files

	def raise_for_status(self):
		pass

	def json(self):
		return {'files': self.files}


def test_a_private_cog_gets_its_signed_link_and_a_public_one_its_static_url(monkeypatch):
	monkeypatch.setattr(stored_inputs.settings, 'API_ENDPOINT', 'https://data2.example/api/v1/')
	monkeypatch.setattr(
		stored_inputs.httpx, 'post', lambda *a, **k: Response({'7': {'cog_url': '/datasets/7/files/cog/T'}})
	)
	assert stored_inputs.cog_url(COG, 'tok', 7) == 'https://data2.example/api/v1/datasets/7/files/cog/T'
	monkeypatch.setattr(stored_inputs.httpx, 'post', lambda *a, **k: Response({}))
	assert stored_inputs.cog_url(COG, 'tok', 7) == 'https://data2.example/cogs/v1/7/a.tif'

	def down(*a, **k):
		raise stored_inputs.httpx.ConnectError('down')

	monkeypatch.setattr(stored_inputs.httpx, 'post', down)
	assert stored_inputs.cog_url(COG, 'tok', 7) is None


def _tif(path: Path) -> Path:
	with rasterio.open(
		path,
		'w',
		driver='GTiff',
		width=4,
		height=4,
		count=3,
		dtype='uint8',
		crs='EPSG:32632',
		transform=from_origin(0, 4, 1, 1),
	) as dst:
		dst.write(np.zeros((3, 4, 4), 'uint8'))
	return path


def test_the_check_streams_the_link_and_copies_the_file_only_when_the_link_fails(monkeypatch, tmp_path):
	streamed = _tif(tmp_path / 'streamed.tif')
	copied = []
	monkeypatch.setattr(stored_inputs, 'local_cog', lambda *a: copied.append(1) or Path('/copy.tif'))
	monkeypatch.setattr(stored_inputs, 'cog_url', lambda *a: str(streamed))
	with stored_inputs.readable_cog(COG, tmp_path, 'tok', 7, CTX) as source:
		assert source == str(streamed) and not copied
	monkeypatch.setattr(stored_inputs, 'cog_url', lambda *a: str(tmp_path / 'missing.tif'))
	with stored_inputs.readable_cog(COG, tmp_path, 'tok', 7, CTX) as source:
		assert source == '/copy.tif' and copied


def test_an_error_while_streaming_does_not_carry_the_signed_link(monkeypatch, tmp_path):
	link = str(_tif(tmp_path / 'ticket-SECRET.tif'))
	monkeypatch.setattr(stored_inputs, 'cog_url', lambda *a: link)
	with pytest.raises(RuntimeError) as raised:
		with stored_inputs.readable_cog(COG, tmp_path, 'tok', 7, CTX) as source:
			raise ValueError(f'could not read {source}')
	assert 'SECRET' not in str(raised.value) and stored_inputs.STREAMED in str(raised.value)


def test_a_runs_images_share_one_sftp_session_and_a_broken_one_is_opened_again(monkeypatch):
	from contextlib import contextmanager

	from processor.src.utils import ssh

	opened, pushed = [], []

	@contextmanager
	def session(token, dataset_id):
		opened.append(1)
		yield f'sftp-{len(opened)}'

	def push_over(sftp, local, remote, token, dataset_id):
		if remote == 'breaks' and sftp == 'sftp-1':
			raise EOFError('connection closed')
		pushed.append((sftp, remote))

	monkeypatch.setattr(ssh, '_storage_sftp', session)
	monkeypatch.setattr(ssh, '_push_over', push_over)
	connection = ssh.StorageConnection()
	for remote in ('a', 'b', 'c'):
		connection.push('/tmp/x', remote, 'tok', 7)
	assert len(opened) == 1 and [r for _, r in pushed] == ['a', 'b', 'c']
	connection.push('/tmp/x', 'breaks', 'tok', 7)
	assert len(opened) == 2 and pushed[-1] == ('sftp-2', 'breaks')
