"""Storage writes are atomic, and superseded files are removed conservatively."""

from contextlib import contextmanager

import pytest

from processor.src.utils import ssh
from shared.settings import settings

pytestmark = pytest.mark.unit

UUID = '0b8f7c4e-3b9e-4e0e-9a55-5d8f3c1e2a10'


class FakeSFTP:
	"""In-memory remote filesystem with POSIX rename semantics."""

	def __init__(self, files=None, dirs=None, fail_put_after=None):
		self.files = dict(files or {})
		self.dirs = set(dirs or ())
		self.fail_put_after = fail_put_after

	def stat(self, path):
		if path not in self.files and path not in self.dirs:
			raise FileNotFoundError(path)

	def mkdir(self, path):
		self.dirs.add(path)

	def put(self, local_path, remote_path):
		with open(local_path, 'rb') as fh:
			data = fh.read()
		if self.fail_put_after is not None:
			self.files[remote_path] = data[: self.fail_put_after]
			raise OSError('connection lost during upload')
		self.files[remote_path] = data

	def posix_rename(self, source, target):
		self.files[target] = self.files.pop(source)

	def remove(self, path):
		if path not in self.files:
			raise FileNotFoundError(path)
		del self.files[path]

	def rmdir(self, path):
		if any(name.startswith(f'{path}/') for name in self.files):
			raise OSError('directory not empty')
		self.dirs.discard(path)


@pytest.fixture
def remote(monkeypatch):
	holder = {}

	@contextmanager
	def fake_storage_sftp(_token, _dataset_id):
		yield holder['sftp']

	monkeypatch.setattr(ssh, '_storage_sftp', fake_storage_sftp)
	monkeypatch.setattr(settings, 'STORAGE_SERVER_DATA_PATH', '/data')
	return holder


def test_push_replaces_existing_file_atomically(remote, tmp_path):
	local = tmp_path / 'new.tif'
	local.write_bytes(b'new complete file')
	remote['sftp'] = FakeSFTP(files={'/data/archive/1_ortho.tif': b'old'}, dirs={'/data/archive'})

	ssh.push_file_to_storage_server(str(local), '/data/archive/1_ortho.tif', 'token', 1)

	assert remote['sftp'].files == {'/data/archive/1_ortho.tif': b'new complete file'}


@pytest.mark.parametrize('existing', [None, b'old complete file'])
def test_failed_push_never_leaves_partial_file_at_final_path(remote, tmp_path, existing):
	local = tmp_path / 'new.tif'
	local.write_bytes(b'new complete file')
	final = f'/data/cogs/{UUID}/1_cog.tif'
	remote['sftp'] = FakeSFTP(files={final: existing} if existing else {}, fail_put_after=3)

	with pytest.raises(OSError, match='connection lost'):
		ssh.push_file_to_storage_server(str(local), final, 'token', 1)

	# The previous complete file (or nothing) remains; the temp upload is removed.
	assert remote['sftp'].files == ({final: existing} if existing else {})


def test_delete_superseded_removes_previous_uuid_directory(remote):
	previous = f'{UUID}/1_cog.tif'
	remote['sftp'] = FakeSFTP(
		files={f'/data/cogs/{previous}': b'old', '/data/cogs/new-uuid/1_cog.tif': b'new'},
		dirs={f'/data/cogs/{UUID}', '/data/cogs/new-uuid'},
	)

	ssh.delete_superseded_storage_file('cogs', previous, 'new-uuid/1_cog.tif', 'token', 1)

	assert remote['sftp'].files == {'/data/cogs/new-uuid/1_cog.tif': b'new'}
	assert remote['sftp'].dirs == {'/data/cogs/new-uuid'}


@pytest.mark.parametrize(
	'previous',
	[
		None,
		'same/1_cog.tif',
		'../archive/1_ortho.tif',
		'/data/archive/1_ortho.tif',
		'not-a-uuid/1_cog.tif',
		'a/b/c.tif',
	],
)
def test_delete_superseded_leaves_unexpected_paths_alone(remote, previous):
	remote['sftp'] = sftp = FakeSFTP(files={'/data/archive/1_ortho.tif': b'raw'})

	ssh.delete_superseded_storage_file('cogs', previous, 'same/1_cog.tif', 'token', 1)

	assert sftp.files == {'/data/archive/1_ortho.tif': b'raw'}


def test_delete_superseded_failure_is_logged_not_raised(remote, monkeypatch):
	@contextmanager
	def unreachable(_token, _dataset_id):
		raise OSError('storage unreachable')
		yield

	monkeypatch.setattr(ssh, '_storage_sftp', unreachable)

	ssh.delete_superseded_storage_file('thumbnails', f'{UUID}/1_thumbnail.jpg', 'new/1_thumbnail.jpg', 'token', 1)
