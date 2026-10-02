from pydantic_settings import BaseSettings
from dotenv import load_dotenv
from pathlib import Path
import os

from .asset_manifest import BIOME_ASSET_PATH, GADM_ASSET_PATH, PHENOLOGY_ASSET_PATH

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
	'raw_images': 'v2_raw_images',
	'statuses': 'v2_statuses',
	'queue': 'v2_queue',
	'queue_positions': 'v2_queue_positions',
	'model_preferences': 'v2_model_preferences',
	'tile_embeddings': 'v2_tile_embeddings',
	'acquisition_date_estimates': 'v2_acquisition_date_estimates',
	'audit_suggestions': 'dataset_audit_suggestions',
	'georef_checks': 'v2_georef_checks',
	'notification_preferences': 'user_notification_preferences',
	'processing_notification_events': 'processing_notification_events',
}


BASE = Path(__file__).parent.parent
ASSETS_DIR = BASE / 'assets'


# load the settings from environment variables
class Settings(BaseSettings):
	# Environment indicator
	ENV: str = ENV
	DEV_MODE: bool = IS_DEVELOPMENT

	# Persistent Hugging Face cache for the pinned TCD tree cover checkpoint, so it is
	# downloaded once per host rather than on every run. Deployments point this at /data.
	TCD_MODEL_CACHE_DIR: str = str(ASSETS_DIR / 'tcd_model_cache')

	# docker.from_env() defaults to a 60s read timeout on the daemon socket, which applies
	# to control-plane calls (containers.create/start, put_archive, wait). When the host disk
	# is saturated flushing a freshly-extracted multi-GB raw-image zip, the daemon can take
	# well over 60s just to service a create/start, surfacing as spurious
	# "UnixHTTPConnectionPool(host='localhost', port=None): Read timed out. (read timeout=60)"
	# failures in the ODM copy-to-volume step. Give the daemon far more headroom; this is not
	# a timeout on the ODM run itself (that is bounded by ODM_RUN_TIMEOUT_SECONDS).
	DOCKER_CLIENT_TIMEOUT_SECONDS: int = 600

	# Upper bound for one ODM container run. Large flights take many hours; a run past
	# this is hung, and holding the worker longer blocks every other dataset.
	ODM_RUN_TIMEOUT_SECONDS: int = 48 * 3600

	# Storage-server SSH: connect, banner and auth must answer within this, and a
	# transfer that moves no bytes for SSH_TRANSFER_STALL_SECONDS is abandoned.
	# Neither bounds how long a healthy large transfer may take.
	SSH_CONNECT_TIMEOUT_SECONDS: int = 30
	SSH_TRANSFER_STALL_SECONDS: int = 600

	# Base paths and directories
	BASE_DIR: str = str(BASE)
	# Default to repo-local assets in dev/test; container deployments can still override via env.
	GADM_DATA_PATH: str = str(ASSETS_DIR / GADM_ASSET_PATH)

	BIOME_DATA_PATH: str = str(ASSETS_DIR / BIOME_ASSET_PATH)

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

	PHENOLOGY_DATA_PATH: str = str(ASSETS_DIR / PHENOLOGY_ASSET_PATH)

	# DTE maps (deadwood/forest cover COGs)
	DTE_MAPS_PATH: str = '/data/assets/dte_maps'
	DTE_MAPS_V2_PATH: str = '/data/assets/dte_maps_v2'

	# directly specify the locations for several files
	ARCHIVE_DIR: str = 'archive'
	COG_DIR: str = 'cogs'
	THUMBNAIL_DIR: str = 'thumbnails'
	LABEL_OBJECTS_DIR: str = 'label_objects'
	TRASH_DIR: str = 'trash'
	DOWNLOADS_DIR: str = 'downloads'
	PROCESSING_DIR: str = 'processing_dir'
	RAW_IMAGES_DIR: str = 'raw_images'
	# Signing key for private file paths. When empty, a key is derived from the
	# service-role key so deployments need no new secret.
	ASSET_TICKET_SECRET: str = ''
	ASSET_TICKET_TTL_SECONDS: int = 3600

	# Temporary processing directory
	# tmp_processing_path: str = str(Path(tempfile.mkdtemp(prefix='processing')))

	# supabase settings for supabase authentication
	SUPABASE_URL: str
	SUPABASE_KEY: str
	SUPABASE_ANON_KEY: str = ''
	SUPABASE_SERVICE_ROLE_KEY: str = ''  # Optional: for accessing auth.users table
	SUPABASE_DB_URL: str = ''  # Local/test-only direct connection for DB concurrency checks

	# some basic settings for the UVICORN server
	UVICORN_HOST: str = '127.0.0.1' if DEV_MODE else '0.0.0.0'
	UVICORN_PORT: int = 8017 if DEV_MODE else 8000
	UVICORN_ROOT_PATH: str = '/api/v1'
	UVICORN_PROXY_HEADERS: bool = True
	SEARCH_RATE_LIMIT_TRUSTED_PROXIES: str = '127.0.0.1,::1,172.16.0.0/12'

	# storage server settings
	STORAGE_SERVER_IP: str = ''
	STORAGE_SERVER_USERNAME: str = ''
	STORAGE_SERVER_DATA_PATH: str = ''

	# api endpoint
	API_ENDPOINT: str = 'http://localhost:8080/api/v1/' if DEV_MODE else 'https://data2.deadtrees.earth/api/v1/'
	API_ENTPOINT_DATASETS: str = API_ENDPOINT + 'datasets/chunk'
	PREPACKAGED_DOWNLOAD_BASE_URL: str = (
		'http://localhost:8080/prepackaged/v1' if DEV_MODE else 'https://data2.deadtrees.earth/prepackaged/v1'
	)
	PREPACKAGED_S3_ENDPOINT_URL: str = ''
	PREPACKAGED_S3_REGION: str = 'fr1-ec82'
	PREPACKAGED_S3_BUCKET: str = 'frct-deadtrees-products'
	PREPACKAGED_API_READ_S3_ACCESS_KEY: str = ''
	PREPACKAGED_API_READ_S3_SECRET_KEY: str = ''
	PREPACKAGED_SIGNED_URL_TTL_SECONDS: int = 86400

	# Sentinel-2 block cubes of the scaled Sentinel pipeline (read-only), used by
	# the acquisition-date (doy_estimation_v1) stage. Without keys the stage runs
	# the no-S2 model for every dataset.
	SENTINEL2_S3_ENDPOINT: str = 'https://s3.bwsfs.uni-freiburg.de/'
	SENTINEL2_S3_REGION: str = 'fr2-ec82'
	SENTINEL2_S3_BUCKET: str = 'frct-sentinel2'
	SENTINEL2_S3_PREFIX: str = 'sentinel-2-cubes'
	SENTINEL2_S3_ACCESS_KEY_ID: str = ''
	SENTINEL2_S3_SECRET_ACCESS_KEY: str = ''
	# Record the prefilled date check as an automatic decision (applying an
	# accepted suggested date) when no person has decided. Off: auditors decide.
	DOY_AUTO_DECIDE: bool = False

	# Optional satellite references of the georeferencing check (georef_check_v1)
	# besides keyless Esri World Imagery and its dated Wayback captures.
	GOOGLE_MAP_TILES_API_KEY: str = ''
	MAPTILER_API_KEY: str = ''
	MAPBOX_ACCESS_TOKEN: str = ''

	# processor settings
	PROCESSOR_USERNAME: str = 'processor@deadtrees.earth'
	# No default: deployments must set it. The local seed value lives in .env.example
	# and docker-compose.test.yaml, so production never falls back to a well-known password.
	PROCESSOR_PASSWORD: str = ''
	PROCESSOR_WORKER_ID: str = ''
	# Seconds the continuous processor waits before re-polling the queue when it
	# is idle or intentionally drained for deployment/maintenance.
	PROCESSOR_IDLE_BACKOFF_SECONDS: int = 10
	# Consecutive loop-level exceptions before the worker exits so Docker exposes
	# a restart state to host-side repair deployment.
	PROCESSOR_LOOP_FAILURE_LIMIT: int = 3
	PROCESSOR_RELEASE_SHA: str = 'unknown'
	# Host-local control file used to stop this worker from claiming new tasks
	# while it drains the current one for deployment or Docker maintenance.
	PROCESSOR_DRAIN_REQUEST_PATH: str = '/data/processor-control/drain-request.json'
	PROCESSOR_DRAIN_ACK_PATH: str = '/data/processor-control/drain-ack.json'
	PROCESSOR_UNHEALTHY_PATH: str = '/data/processor-control/loop-unhealthy.json'
	# Comma-separated task types this worker refuses to run (e.g. 'odm_processing').
	# A queue entry whose task_types include any blacklisted type is skipped so a
	# capable worker picks it up instead. See `processor_task_blacklist`.
	PROCESSOR_TASK_BLACKLIST: str = ''
	# Lowest queue priority this worker claims. The default 1 claims everything.
	# Set it to 4 on one host to keep that worker free for fresh uploads while a
	# long lower-priority reprocessing batch occupies the other workers.
	PROCESSOR_MIN_PRIORITY: int = 1
	SSH_PRIVATE_KEY_PATH: str = '/app/ssh_key'
	SSH_PRIVATE_KEY_PASSPHRASE: str = ''
	SSH_KNOWN_HOSTS_PATH: str = '~/.ssh/known_hosts'
	# Pinned so every host runs the same tested ODM release; Docker pulls it on first use.
	ODM_IMAGE: str = 'opendronemap/odm:3.6.2'
	ODM_AUTO_BOUNDARY: bool = False
	ODM_SKY_REMOVAL: bool = False
	ODM_BG_REMOVAL: bool = False
	ODM_MAX_NADIR_DEVIATION_DEGREES: float = 40.0
	# Largest image-position extent one ODM run may mosaic; successful ODM orthos reach ~20 km² (DT-1312).
	ODM_MAX_IMAGE_EXTENT_KM2: float = 30.0

	# Linear integration for processing failure notifications
	LINEAR_ENABLED: bool = False
	LINEAR_API_KEY: str = ''
	LINEAR_TEAM_ID: str = 'ba4011bf-0b5c-4631-9f88-1034ab4ef541'  # deadtrees team

	# PostHog integration for website analytics
	POSTHOG_API_KEY: str = ''
	POSTHOG_PROJECT_ID: str = ''
	POSTHOG_HOST: str = 'https://eu.posthog.com'  # EU instance

	# Zulip integration for notifications
	ZULIP_EMAIL: str = ''
	ZULIP_API_KEY: str = ''
	ZULIP_SITE: str = ''  # e.g., https://chat.deadtrees.earth
	ZULIP_STREAM: str = 'project_deadtree.earth'
	ZULIP_TOPIC: str = 'Daily Summary'

	# Brevo (transactional email notifications)
	BREVO_API_KEY: str = ''
	NOTIFICATION_SENDER_EMAIL: str = 'notifications@deadtrees.earth'
	NOTIFICATION_SENDER_NAME: str = 'DeadTrees'
	PROCESSING_EMAIL_NOTIFICATIONS_ENABLED: bool = False

	# Mailpit (local test email server) - used when ENV=development
	MAILPIT_SMTP_HOST: str = 'localhost'
	MAILPIT_SMTP_PORT: int = 54325
	MAILPIT_API_URL: str = 'http://localhost:54324'

	# Test settings
	TEST_USER_EMAIL: str = 'test@example.com'
	TEST_USER_PASSWORD: str = 'test123456'
	TEST_USER_EMAIL2: str = 'test2@example.com'
	TEST_USER_PASSWORD2: str = 'test2123456'

	def model_post_init(self, __context):
		if 'API_ENDPOINT' not in self.model_fields_set:
			self.API_ENDPOINT = 'http://localhost:8080/api/v1/' if self.DEV_MODE else 'https://data2.deadtrees.earth/api/v1/'
		if 'API_ENTPOINT_DATASETS' not in self.model_fields_set:
			self.API_ENTPOINT_DATASETS = self.API_ENDPOINT + 'datasets/chunk'
		if 'PREPACKAGED_DOWNLOAD_BASE_URL' not in self.model_fields_set:
			self.PREPACKAGED_DOWNLOAD_BASE_URL = (
				'http://localhost:8080/prepackaged/v1'
				if self.DEV_MODE
				else 'https://data2.deadtrees.earth/prepackaged/v1'
			)

	@property
	def base_path(self) -> Path:
		path = Path(self.BASE_DIR)
		if not path.exists():
			path.mkdir(parents=True, exist_ok=True)

		return path

	@property
	def scratch_path(self) -> Path:
		"""Temp files of the processor and its tools, kept off the container layer."""
		path = self.base_path / 'processor_tmp'
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
	def raw_images_path(self) -> Path:
		path = self.base_path / self.RAW_IMAGES_DIR
		if not path.exists():
			path.mkdir(parents=True, exist_ok=True)

		return path

	@property
	def dte_maps_path(self) -> Path:
		return Path(self.DTE_MAPS_PATH)

	@property
	def dte_maps_v2_path(self) -> Path:
		return Path(self.DTE_MAPS_V2_PATH)

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
	def raw_images_table(self) -> str:
		return self._tables['raw_images']

	@property
	def statuses_table(self) -> str:
		return self._tables['statuses']

	@property
	def model_preferences_table(self) -> str:
		return self._tables['model_preferences']

	@property
	def notification_preferences_table(self) -> str:
		return self._tables['notification_preferences']

	@property
	def processing_notification_events_table(self) -> str:
		return self._tables['processing_notification_events']

	@property
	def tile_embeddings_table(self) -> str:
		return self._tables['tile_embeddings']

	@property
	def acquisition_date_estimates_table(self) -> str:
		return self._tables['acquisition_date_estimates']

	@property
	def audit_suggestions_table(self) -> str:
		return self._tables['audit_suggestions']

	@property
	def georef_checks_table(self) -> str:
		return self._tables['georef_checks']

	@property
	def processor_task_blacklist(self) -> list[str]:
		"""Task type values this worker must not run, parsed from PROCESSOR_TASK_BLACKLIST."""
		return [t.strip() for t in self.PROCESSOR_TASK_BLACKLIST.split(',') if t.strip()]

settings = Settings()
