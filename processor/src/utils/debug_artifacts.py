import json
import os
import time
from pathlib import Path
from typing import Any, Optional

from shared.logger import logger
from shared.logging import LogCategory, LogContext
from shared.settings import settings


def _env_bool(name: str, default: bool = False) -> bool:
	raw = os.getenv(name)
	if raw is None:
		return default
	raw = raw.strip().lower()
	return raw in ('1', 'true', 'yes', 'y', 'on')


def _env_int(name: str, default: int) -> int:
	raw = os.getenv(name)
	if raw is None:
		return default
	try:
		return int(raw)
	except Exception:
		return default


def retain_failed_artifacts_enabled_for_dataset(dataset_id: int) -> bool:
	"""
	Retention is opt-in (default: off). Optional allowlist via DT_RETAIN_DATASET_IDS.
	"""
	if not _env_bool('DT_RETAIN_FAILED_ARTIFACTS', default=False):
		return False

	allowlist_raw = (os.getenv('DT_RETAIN_DATASET_IDS') or '').strip()
	if not allowlist_raw:
		return True

	allow = set()
	for part in allowlist_raw.split(','):
		part = part.strip()
		if not part:
			continue
		try:
			allow.add(int(part))
		except Exception:
			continue
	return dataset_id in allow


def retention_ttl_hours() -> int:
	return _env_int('DT_RETAIN_FAILED_TTL_HOURS', default=24)


def debug_bundle_base_dir() -> Path:
	# Default to /data/debug_bundles in production (BASE_DIR=/data).
	override = (os.getenv('DT_DEBUG_BUNDLE_DIR') or '').strip()
	if override:
		return Path(override)
	return settings.base_path / 'debug_bundles'


def _safe_write_text(path: Path, content: str) -> None:
	try:
		path.parent.mkdir(parents=True, exist_ok=True)
		path.write_text(content, encoding='utf-8', errors='ignore')
	except Exception:
		# Never let debug artifact writing break processing.
		pass


def _safe_write_json(path: Path, payload: dict[str, Any]) -> None:
	try:
		path.parent.mkdir(parents=True, exist_ok=True)
		path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding='utf-8')
	except Exception:
		pass


def build_container_forensics(
	container: Any,
	*,
	dataset_id: int,
	stage: str,
	command: Optional[list[str]] = None,
	volume_name: Optional[str] = None,
	log_tail_bytes: int = 20000,
) -> dict[str, Any]:
	"""
	Collect best-effort forensics. Works even if container already exited.
	"""
	forensics: dict[str, Any] = {
		'dataset_id': dataset_id,
		'stage': stage,
		'volume_name': volume_name,
		'collected_at_unix': int(time.time()),
	}

	try:
		container.reload()
	except Exception:
		pass

	try:
		forensics['container_id'] = getattr(container, 'id', None)
		forensics['container_name'] = getattr(container, 'name', None)
		forensics['container_short_id'] = getattr(container, 'short_id', None)
	except Exception:
		pass

	try:
		attrs = getattr(container, 'attrs', None) or {}
		state = attrs.get('State', {}) if isinstance(attrs, dict) else {}
		config = attrs.get('Config', {}) if isinstance(attrs, dict) else {}

		forensics['image'] = config.get('Image')
		forensics['created'] = attrs.get('Created')
		forensics['state'] = {
			'Status': state.get('Status'),
			'ExitCode': state.get('ExitCode'),
			'OOMKilled': state.get('OOMKilled'),
			'Error': state.get('Error'),
			'FinishedAt': state.get('FinishedAt'),
		}
	except Exception:
		pass

	if command is not None:
		forensics['command'] = command

	try:
		logs = container.logs(tail=200)
		if isinstance(logs, (bytes, bytearray)):
			text = logs.decode('utf-8', errors='replace')
		else:
			text = str(logs)
		# Bound size in case docker returns huge logs.
		forensics['logs_tail'] = text[-log_tail_bytes:]
	except Exception as e:
		forensics['logs_tail_error'] = str(e)

	return forensics


def write_debug_bundle(
	*,
	forensics: dict[str, Any],
	token: str,
	dataset_id: int,
	stage: str,
) -> Optional[Path]:
	"""
	Write a small on-disk bundle + emit a compact DB log line.
	"""
	try:
		ts = time.strftime('%Y%m%d-%H%M%S')
		base = debug_bundle_base_dir() / str(dataset_id) / f'{ts}_{stage}'
		_safe_write_json(base / 'forensics.json', forensics)
		if 'logs_tail' in forensics and isinstance(forensics.get('logs_tail'), str):
			_safe_write_text(base / 'logs_tail.txt', forensics['logs_tail'])

		# Emit a compact line to v2_logs so Linear issue creation can include it.
		compact = {
			'stage': stage,
			'container_name': forensics.get('container_name'),
			'exit_code': (forensics.get('state') or {}).get('ExitCode') if isinstance(forensics.get('state'), dict) else None,
			'oom_killed': (forensics.get('state') or {}).get('OOMKilled') if isinstance(forensics.get('state'), dict) else None,
			'volume_name': forensics.get('volume_name'),
			'debug_bundle_dir': str(base),
		}
		logger.error(
			f'DT_DEBUG_BUNDLE {json.dumps(compact, sort_keys=True)}',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

		return base
	except Exception:
		return None


def dt_resource_labels(*, dataset_id: int, stage: str, keep_eligible: bool) -> dict[str, str]:
	"""
	Labels for containers/volumes so we can find/TTL-clean them later.

	We cannot update labels after creation, so `keep_eligible` reflects whether the
	current run is configured to retain failed artifacts for this dataset.
	"""
	return {
		'dt': stage,
		'dt_dataset_id': str(dataset_id),
		'dt_stage': stage,
		'dt_keep': 'true' if keep_eligible else 'false',
		'dt_created_at_unix': str(int(time.time())),
		'dt_ttl_hours': str(retention_ttl_hours()),
	}

