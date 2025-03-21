from typing import Optional
from pydantic_settings import BaseSettings
from dotenv import load_dotenv
from pathlib import Path
import tempfile
import os

# load an .env file if it exists
load_dotenv()

# Determine environment
ENV = os.getenv('ENV', 'development')
IS_DEVELOPMENT = ENV == 'development'

_tables = {
	'datasets': 'v2_datasets',
	'orthos': 'v2_orthos',
	'orthos_processed': 'v2_orthos_processed',
	'cogs': 'v2_cogs',
	'thumbnails': 'v2_thumbnails',
	'metadata': 'v2_metadata',
	'labels': 'v2_labels',
	'aois': 'v2_aois',
	'deadwood_geometries': 'v2_deadwood_geometries',
	'forest_cover_geometries': 'v2_forest_cover_geometries',
	'label_objects': 'v1_label_objects',
	'logs': 'v2_logs',
	'statuses': 'v2_statuses',
	'queue': 'v2_queue',
	'queue_positions': 'v2_queue_positions',
}


BASE = Path(__file__).parent.parent
ASSETS_DIR = BASE / 'assets'


# load the settings from environment variables
class Settings(BaseSettings):
	# Environment indicator
	ENV: str = ENV
	DEV_MODE: bool = IS_DEVELOPMENT

	# Base paths and directories
	BASE_DIR: str = str(BASE)
	# Default GADM path in assets, can be overridden by env var
	GADM_DATA_PATH: str = str(Path('/app/assets/gadm/gadm_410.gpkg'))
	CONCURRENT_TASKS: int = 2

	BIOME_DATA_PATH: str = str(Path('/app/assets/biom/terres_ecosystems.gpkg'))

	BIOME_DICT: dict[int, str] = {
		1: 'Tropical and Subtropical Moist Broadleaf Forests',
		2: 'Tropical and Subtropical Dry Broadleaf Forests',
		3: 'Tropical and Subtropical Coniferous Forests',
		4: 'Temperate Broadleaf and Mixed Forests',
		5: 'Temperate Coniferous Forests',
		6: 'Boreal Forests/Taiga',
		7: 'Tropical and Subtropical Grasslands, Savannas, and Shrublands',
		8: 'Temperate Grasslands, Savannas, and Shrublands',
		9: 'Flooded Grasslands and Savannas',
		10: 'Montane Grasslands and Shrublands',
		11: 'Tundra',
		12: 'Mediterranean Forests, Woodlands, and Scrub',
		13: 'Deserts and Xeric Shrublands',
		14: 'Mangroves',
	}

	# directly specify the locations for several files
	ARCHIVE_DIR: str = 'archive'
	COG_DIR: str = 'cogs'
	THUMBNAIL_DIR: str = 'thumbnails'
	LABEL_OBJECTS_DIR: str = 'label_objects'
	TRASH_DIR: str = 'trash'
	DOWNLOADS_DIR: str = 'downloads'
	PROCESSING_DIR: str = 'processing_dir'

	# Temporary processing directory
	# tmp_processing_path: str = str(Path(tempfile.mkdtemp(prefix='processing')))

	# supabase settings for supabase authentication
	SUPABASE_URL: str
	SUPABASE_KEY: str

	# some basic settings for the UVICORN server
	UVICORN_HOST: str = '127.0.0.1' if DEV_MODE else '0.0.0.0'
	UVICORN_PORT: int = 8017 if DEV_MODE else 8000
	UVICORN_ROOT_PATH: str = '/api/v1'
	UVICORN_PROXY_HEADERS: bool = True

	# storage server settings
	STORAGE_SERVER_IP: str = ''
	STORAGE_SERVER_USERNAME: str = ''
	STORAGE_SERVER_DATA_PATH: str = ''

	# api endpoint
	API_ENDPOINT: str = 'http://localhost:8080/api/v1/' if DEV_MODE else 'https://data2.deadtrees.earth/api/v1/'
	API_ENTPOINT_DATASETS: str = API_ENDPOINT + 'datasets/chunk'

	# processor settings
	PROCESSOR_USERNAME: str = 'processor@deadtrees.earth'
	PROCESSOR_PASSWORD: str = 'processor'
	SSH_PRIVATE_KEY_PATH: str = '/app/ssh_key'
	SSH_PRIVATE_KEY_PASSPHRASE: str = ''

	# monitoring
	LOGFIRE_TOKEN: str = None
	LOGFIRE_PYDANTIC_PLUGIN_RECORD: str = 'all'

	# Test settings
	TEST_USER_EMAIL: str = 'test@example.com'
	TEST_USER_PASSWORD: str = 'test123456'

	@property
	def base_path(self) -> Path:
		path = Path(self.BASE_DIR)
		if not path.exists():
			path.mkdir(parents=True, exist_ok=True)

		return path

	@property
	def processing_path(self) -> Path:
		path = self.base_path / self.PROCESSING_DIR
		if not path.exists():
			path.mkdir(parents=True, exist_ok=True)

		return path

	@property
	def archive_path(self) -> Path:
		path = self.base_path / self.ARCHIVE_DIR
		if not path.exists():
			path.mkdir(parents=True, exist_ok=True)

		return path

	@property
	def cog_path(self) -> Path:
		path = self.base_path / self.COG_DIR
		if not path.exists():
			path.mkdir(parents=True, exist_ok=True)

		return path

	@property
	def thumbnail_path(self) -> Path:
		path = self.base_path / self.THUMBNAIL_DIR
		if not path.exists():
			path.mkdir(parents=True, exist_ok=True)

		return path

	@property
	def user_label_path(self) -> Path:
		path = self.base_path / self.LABEL_OBJECTS_DIR
		if not path.exists():
			path.mkdir(parents=True, exist_ok=True)

		return path

	@property
	def trash_path(self) -> Path:
		path = self.base_path / self.TRASH_DIR
		if not path.exists():
			path.mkdir(parents=True, exist_ok=True)

		return path

	@property
	def downloads_path(self) -> Path:
		path = self.base_path / self.DOWNLOADS_DIR
		if not path.exists():
			path.mkdir(parents=True, exist_ok=True)

		return path

	@property
	def _tables(self) -> dict:
		return _tables

	@property
	def datasets_table(self) -> str:
		return self._tables['datasets']

	@property
	def orthos_table(self) -> str:
		return self._tables['orthos']

	@property
	def orthos_processed_table(self) -> str:
		return self._tables['orthos_processed']

	@property
	def cogs_table(self) -> str:
		return self._tables['cogs']

	@property
	def labels_table(self) -> str:
		return self._tables['labels']

	@property
	def aois_table(self) -> str:
		return self._tables['aois']

	@property
	def deadwood_geometries_table(self) -> str:
		return self._tables['deadwood_geometries']

	@property
	def forest_cover_geometries_table(self) -> str:
		return self._tables['forest_cover_geometries']

	@property
	def thumbnails_table(self) -> str:
		return self._tables['thumbnails']

	@property
	def metadata_table(self) -> str:
		return self._tables['metadata']

	@property
	def logs_table(self) -> str:
		return self._tables['logs']

	@property
	def label_objects_table(self) -> str:
		return self._tables['label_objects']

	@property
	def queue_table(self) -> str:
		return self._tables['queue']

	@property
	def queue_position_table(self) -> str:
		return self._tables['queue_positions']

	@property
	def statuses_table(self) -> str:
		return self._tables['statuses']


settings = Settings()
