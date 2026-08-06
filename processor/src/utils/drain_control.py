import json
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

from shared.settings import settings


class BackgroundProcessResult(str, Enum):
	WORKED = 'worked'
	IDLE = 'idle'
	FAILED = 'failed'


def _read_json(path: Path) -> dict | None:
	if not path.exists():
		return None

	try:
		return json.loads(path.read_text())
	except json.JSONDecodeError:
		return None


def drain_request_path() -> Path:
	return Path(settings.PROCESSOR_DRAIN_REQUEST_PATH)


def drain_ack_path() -> Path:
	return Path(settings.PROCESSOR_DRAIN_ACK_PATH)


def unhealthy_path() -> Path:
	return Path(settings.PROCESSOR_UNHEALTHY_PATH)


def load_drain_request() -> dict | None:
	return _read_json(drain_request_path())


def load_drain_ack() -> dict | None:
	return _read_json(drain_ack_path())


def drain_ack_matches_request(request: dict | None, ack: dict | None) -> bool:
	if request is None or ack is None:
		return False
	return ack.get('request_id') == request.get('request_id') and ack.get('requested_at') == request.get('requested_at')


def is_drain_requested() -> bool:
	return load_drain_request() is not None


def mark_loop_unhealthy(failure_count: int) -> None:
	path = unhealthy_path()
	payload = {
		'failed_at': datetime.now(timezone.utc).isoformat(),
		'failure_count': failure_count,
		'release_sha': settings.PROCESSOR_RELEASE_SHA,
	}
	temporary_path = path.with_suffix(f'{path.suffix}.tmp')
	temporary_path.write_text(json.dumps(payload, indent=2) + '\n')
	temporary_path.replace(path)


def clear_loop_unhealthy() -> None:
	unhealthy_path().unlink(missing_ok=True)


def acknowledge_drain_request(worker_id: str) -> dict | None:
	request = load_drain_request()
	if request is None:
		return None

	ack = {
		'request_id': request.get('request_id'),
		'requested_at': request.get('requested_at'),
		'acknowledged_by': worker_id,
		'release_sha': settings.PROCESSOR_RELEASE_SHA,
	}
	drain_ack_path().write_text(json.dumps(ack, indent=2) + '\n')
	return ack
