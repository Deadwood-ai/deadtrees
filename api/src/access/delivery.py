"""Authorize in the API; let nginx send bytes and implement range/HEAD requests."""

from pathlib import Path
from urllib.parse import quote
from fastapi import HTTPException, Response
from shared.settings import settings


def protected_file_response(path: Path, *, attachment: bool = False, cacheable: bool = False) -> Response:
	"""Send an authorized file through nginx.

	A cacheable file may be kept by the browser for the life of the signed link that
	named it; everything else is no-store.
	"""
	resolved = path.resolve()
	try:
		relative = resolved.relative_to(settings.base_path.resolve()).as_posix()
	except ValueError as error:
		raise HTTPException(status_code=404, detail='Not found') from error
	if not resolved.is_file():
		raise HTTPException(status_code=404, detail='Not found')
	headers = {
		# Caching, referrer and content-type headers are set by the internal nginx location.
		'X-Accel-Redirect': ('/_protected_cacheable/' if cacheable else '/_protected_data/') + quote(relative, safe='/'),
	}
	if attachment:
		headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + quote(path.name, safe='')
	return Response(headers=headers)
