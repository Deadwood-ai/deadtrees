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

	# Logging
	log_file: Optional[str]


def env_bool(name: str, default: bool = False) -> bool:
	v = os.getenv(name)
	if v is None:
		return default
	return v.strip().lower() in ("1", "true", "yes", "y", "on")


def load_config() -> Config:
	base_url = os.getenv("FREIDATA_BASE_URL", "https://freidata.uni-freiburg.de").rstrip("/")
	token = os.getenv("FREIDATA_TOKEN", "").strip()
	supabase_url = os.getenv("SUPABASE_URL", "").strip()
	supabase_key = (os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY") or "").strip()

	return Config(
		freidata_base_url=base_url,
		freidata_token=token,
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
	)
