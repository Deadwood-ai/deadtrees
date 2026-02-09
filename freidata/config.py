from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Optional


@dataclass
class Config:
	# Invenio/FreiData
	freidata_base_url: str
	freidata_token: str

	stop_after: Optional[str]
	clean_zips: bool
	clean_inplace: bool
	overwrite_files: bool
	publish: bool
	upload_timeout: int

	community_query: str
	create_community_review: bool
	submit_community_review: bool

	# DB (Supabase)
	supabase_url: str
	supabase_key: str

	# Zulip notifications
	zulip_email: str
	zulip_api_key: str
	zulip_site: str
	zulip_stream: str
	zulip_topic: str

	# Logging
	log_file: Optional[str]

	# Download/bundling
	auto_download: bool
	download_api_base_url: str
	download_timeout_seconds: int
	download_poll_interval_seconds: int
	download_request_timeout_seconds: int
	download_chunk_size_bytes: int
	download_api_token: Optional[str]
	processor_username: Optional[str]
	processor_password: Optional[str]
	download_include_labels: bool
	download_include_parquet: bool
	download_use_original_filename: bool


def env_bool(name: str, default: bool = False) -> bool:
	v = os.getenv(name)
	if v is None:
		return default
	return v.strip().lower() in ("1", "true", "yes", "y", "on")


def load_config() -> Config:
	base_url = os.getenv("FREIDATA_BASE_URL", "https://freidata.uni-freiburg.de").rstrip("/")
	token = os.getenv("FREIDATA_TOKEN", "").strip()
	supabase_url = os.getenv("SUPABASE_URL", "").strip()
	supabase_key = (
		os.getenv("SUPABASE_SERVICE_KEY")
		or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
		or os.getenv("SUPABASE_KEY")
		or ""
	).strip()

	return Config(
		freidata_base_url=base_url,
		freidata_token=token,
		zulip_email=os.getenv("ZULIP_EMAIL", "").strip(),
		zulip_api_key=os.getenv("ZULIP_API_KEY", "").strip(),
		zulip_site=os.getenv("ZULIP_SITE", "").strip(),
		zulip_stream=os.getenv("ZULIP_STREAM", "project_deadtree.earth"),
		zulip_topic=os.getenv("ZULIP_TOPIC", "New Data Publications"),
		stop_after=os.getenv("STOP_AFTER"),
		clean_zips=env_bool("CLEAN_ZIPS", False),
		clean_inplace=env_bool("CLEAN_INPLACE", False),
		overwrite_files=env_bool("OVERWRITE_FILES", False),
		publish=env_bool("PUBLISH", False),
		upload_timeout=int(os.getenv("UPLOAD_TIMEOUT", "7200")),
		community_query=os.getenv("COMMUNITY_QUERY", "deadtrees.earth"),
		create_community_review=env_bool("CREATE_COMMUNITY_REVIEW", False),
		submit_community_review=env_bool("SUBMIT_COMMUNITY_REVIEW", False),
		supabase_url=supabase_url,
		supabase_key=supabase_key,
		log_file=os.getenv("FREIDATA_LOG_FILE"),
		auto_download=env_bool("AUTO_DOWNLOAD", True),
		download_api_base_url=os.getenv("DOWNLOAD_API_BASE_URL", "http://localhost:8080/api/v1/download").rstrip("/"),
		download_timeout_seconds=int(os.getenv("DOWNLOAD_TIMEOUT_SECONDS", "7200")),
		download_poll_interval_seconds=int(os.getenv("DOWNLOAD_POLL_INTERVAL_SECONDS", "5")),
		download_request_timeout_seconds=int(os.getenv("DOWNLOAD_REQUEST_TIMEOUT_SECONDS", "60")),
		download_chunk_size_bytes=int(os.getenv("DOWNLOAD_CHUNK_SIZE_BYTES", "1048576")),
		download_api_token=os.getenv("DOWNLOAD_API_TOKEN"),
		processor_username=os.getenv("PROCESSOR_USERNAME"),
		processor_password=os.getenv("PROCESSOR_PASSWORD"),
		download_include_labels=env_bool("DOWNLOAD_INCLUDE_LABELS", True),
		download_include_parquet=env_bool("DOWNLOAD_INCLUDE_PARQUET", True),
		download_use_original_filename=env_bool("DOWNLOAD_USE_ORIGINAL_FILENAME", False),
	)
