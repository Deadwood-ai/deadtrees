from fastapi import APIRouter, Request
from pydantic import BaseModel

from shared.__version__ import __version__


class InfoResponse(BaseModel):
	name: str
	version: str
	docs: dict[str, str]


# build the router for main content
router = APIRouter()


@router.get('/', response_model=InfoResponse)
def info(request: Request):
	"""
	Get the API name, version and documentation links.

	Container healthchecks call this route, so it must stay cheap and public.
	"""
	root_path = (request.scope.get('root_path') or '').rstrip('/')

	return InfoResponse(
		name='Deadwood-AI Storage API',
		version=__version__,
		docs=dict(
			swagger=f'{root_path}/docs',
			redoc=f'{root_path}/redoc',
			download=f'{root_path}/download/docs',
		),
	)
