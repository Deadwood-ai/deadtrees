import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import export_ml_tiles


class ExportMlTilesSecurityTest(unittest.TestCase):
	def test_download_cog_reserves_temp_file_before_writing(self):
		def write_download(_url: str, destination: Path):
			destination = Path(destination)
			self.assertTrue(destination.exists())
			destination.write_bytes(b'cog')

		with patch.object(export_ml_tiles.urllib.request, 'urlretrieve', write_download):
			temp_file = export_ml_tiles.download_cog_to_temp('https://example.test/cog.tif')

		try:
			self.assertEqual(temp_file.read_bytes(), b'cog')
			self.assertEqual(temp_file.stat().st_mode & 0o077, 0)
		finally:
			temp_file.unlink(missing_ok=True)

	def test_download_cog_removes_reserved_file_after_failure(self):
		reserved_path = None

		def fail_download(_url: str, destination: Path):
			nonlocal reserved_path
			reserved_path = Path(destination)
			self.assertTrue(reserved_path.exists())
			raise OSError('download failed')

		with (
			patch.object(export_ml_tiles.urllib.request, 'urlretrieve', fail_download),
			self.assertRaisesRegex(Exception, 'Failed to download COG'),
		):
			export_ml_tiles.download_cog_to_temp('https://example.test/cog.tif')

		self.assertIsNotNone(reserved_path)
		self.assertFalse(reserved_path.exists())
