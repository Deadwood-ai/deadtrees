"""Signed-in access to the AI labeling service.

The SAM segmentation service runs on the processing server and reaches the
storage server through a reverse SSH tunnel. nginx forwards /api/v1/sam/ to it
only after this route has accepted the caller's session (auth_request), so the
GPU is never open to anonymous requests.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Response
from fastapi.security import OAuth2PasswordBearer

from .dataset_access import require_user

router = APIRouter()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl='token', auto_error=False)


@router.get('/labeling/sam-authorize', status_code=204)
def authorize_sam_request(token: Annotated[str | None, Depends(oauth2_scheme)] = None):
	"""nginx auth_request for the AI labeling service: any signed-in user may use it."""
	require_user(token or '')
	return Response(status_code=204)
