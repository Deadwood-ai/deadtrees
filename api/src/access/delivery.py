"""Authorize in the API; let nginx send bytes and implement range/HEAD requests."""

from pathlib import Path
from urllib.parse import quote
from fastapi import HTTPException, Response
from shared.settings import settings


def protected_file_response(path: Path, *, attachment: bool = False) -> Response:
	resolved = path.resolve()
	try:
		relative = resolved.relative_to(settings.base_path.resolve()).as_posix()
	except ValueError as error:
		raise HTTPException(status_code=404, detail='Not found') from error
	if not resolved.is_file():
		raise HTTPException(status_code=404, detail='Not found')
	headers = {
		# Caching, referrer and content-type headers are set by the internal nginx location.
		'X-Accel-Redirect': '/_protected_data/' + quote(relative, safe='/'),
	}
	if attachment:
		headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + quote(path.name, safe='')
	return Response(headers=headers)
