import pytest
import shutil
from pathlib import Path


@pytest.fixture(scope='session', autouse=True)
def setup_test_cog():
	"""Setup test COG file by copying from assets to cogs directory"""
	# Get paths from assets and target cogs directory
	assets_dir = Path(__file__).parent.parent.parent / 'assets' / 'test_data'
	cogs_dir = Path(__file__).parent.parent / 'data' / 'cogs'

	source_file = assets_dir / 'test-data.tif'
	target_file = cogs_dir / 'test-data.tif'

	if not source_file.exists():
		pytest.skip('Test COG file not found in assets. Run `make download-assets` first.')

	# Copy the file
	shutil.copy2(source_file, target_file)

	yield

	# Cleanup after tests
	if target_file.exists():
		target_file.unlink()
