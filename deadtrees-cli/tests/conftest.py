import pytest
from pathlib import Path
import shutil
from shared.settings import settings


@pytest.fixture(scope='session', autouse=True)
def data_directory():
	"""Override base directory for CLI tests"""
	# Create test directory under deadtrees-cli/tests/data
	test_dir = Path(__file__).parent.parent.parent / 'data'
	# original_base = settings.BASE_DIR

	# Override settings
	settings.BASE_DIR = str(test_dir)

	# Create directory structure
	# archive_dir = test_dir / settings.ARCHIVE_DIR
	# cogs_dir = test_dir / settings.COG_DIR
	# thumbnails_dir = test_dir / settings.THUMBNAIL_DIR
	# label_objects_dir = test_dir / settings.LABEL_OBJECTS_DIR
	# trash_dir = test_dir / settings.TRASH_DIR
	# downloads_dir = test_dir / settings.DOWNLOADS_DIR

	# Create all directories
	# for directory in [archive_dir, cogs_dir, thumbnails_dir, label_objects_dir, trash_dir, downloads_dir]:
	# 	directory.mkdir(parents=True, exist_ok=True)

	yield test_dir

	# Cleanup and restore settings
	# settings.BASE_DIR = original_base
	# if test_dir.exists():
	# 	shutil.rmtree(test_dir)
