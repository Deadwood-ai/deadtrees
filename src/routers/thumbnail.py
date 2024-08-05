from typing import Annotated
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer

from ..supabase import verify_token, use_client, login
from ..settings import settings
from ..deadwood.thumbnail import calculate_thumbnail
from ..models import Dataset, Cog, StatusEnum
from ..logger import logger


# create the router for the processing
router = APIRouter()

# create the OAuth2 password scheme for supabase login
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")


@router.put("/datasets/{dataset_id}/build-thumbnail")
def create_thumbnail(dataset_id: int, token: Annotated[str, Depends(oauth2_scheme)]):
    """ """
    # first thing we do is verify the token
    user = verify_token(token)
    if not user:
        return HTTPException(status_code=401, detail="Invalid token")

    # load the the dataset info for this one
    try:
        with use_client(token) as client:
            # filter using the given dataset_id
            response = (
                client.table(settings.datasets_table)
                .select("*")
                .eq("id", dataset_id)
                .execute()
            )

            # create the dataset
            dataset = Dataset(**response.data[0])
    except Exception as e:
        # log the error to the database
        msg = f"Error loading dataset {dataset_id}: {str(e)}"
        logger.error(msg, extra={"token": token})

        return HTTPException(status_code=500, detail=msg)

    # get the file path
    tiff_file_path = Path(settings.archive_path) / dataset.file_name
    thumbnail_file_name = dataset.file_name.replace(".tif", ".jpg")
    thumbnail_target_path = Path(settings.tmp_path) / thumbnail_file_name

    # check if file is already in the bucket
    if thumbnail_target_path.exists():
        thumbnail_target_path.unlink()

    try:
        calculate_thumbnail(tiff_file_path, thumbnail_target_path)
    except Exception as e:
        # log the error to the database
        msg = f"Error creating thumbnail for dataset {dataset_id}: {str(e)}"
        logger.error(
            msg, extra={"token": token, "dataset_id": dataset.id, "user_id": user.id}
        )

        return HTTPException(status_code=500, detail=msg)

    # processor_token = login(
    #     settings.processor_username, settings.processor_password
    # ).session.access_token

    try:
        with use_client(token) as client:
            print(client.auth.get_session())
            # adding thumbnail as binary to supabase table v1_thumbnails
            response_thumbnails = (
                client.table(settings.thumbnail_table)
                .insert(
                    {
                        "dataset_id": dataset_id,
                        "thumbnail": thumbnail_target_path.read_bytes(),
                    }
                )
                .execute()
            )
            # response_thumbnails = client.storage.from_(
            #     settings.thumbnail_bucket
            # ).upload(
            #     file=thumbnail_target_path,
            #     path=thumbnail_file_name,
            #     file_options={"content-type": "image/jpeg"},
            #     # content_type="image/jpeg",
            #     # insert=True,
            # )
    except Exception as e:
        # log the error to the database
        msg = f"---Error uploading thumbnail for dataset {dataset_id}: {str(e)} file_path: {thumbnail_target_path} filename: {thumbnail_file_name} thumbnail_bucket: {settings.thumbnail_table}"
        logger.error(msg, extra={"token": token})

        return HTTPException(status_code=500, detail=msg)

    return {
        "message": "Thumbnail uploaded successfully",
        "message": response_thumbnails,
    }
