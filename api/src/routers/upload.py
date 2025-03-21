from typing import Annotated, Optional, List

import time
import aiofiles
from fastapi import UploadFile, Depends, HTTPException, Form, APIRouter
from fastapi.security import OAuth2PasswordBearer
from rio_cogeo.cogeo import cog_info

from shared.models import StatusEnum, LicenseEnum, PlatformEnum, DatasetAccessEnum
from shared.db import verify_token
from shared.settings import settings
from shared.status import update_status
from shared.hash import get_file_identifier
from shared.ortho import upsert_ortho_entry
from shared.logging import LogCategory, LogContext, UnifiedLogger, SupabaseHandler

from ..upload.upload import create_dataset_entry


router = APIRouter()

oauth2_scheme = OAuth2PasswordBearer(tokenUrl='token')

# Create logger instance
logger = UnifiedLogger(__name__)
# Add Supabase handler after initialization
logger.add_supabase_handler(SupabaseHandler())


@router.post('/datasets/chunk')
async def upload_geotiff_chunk(
	file: UploadFile,
	chunk_index: Annotated[int, Form()],
	chunks_total: Annotated[int, Form()],
	upload_id: Annotated[str, Form()],
	token: Annotated[str, Depends(oauth2_scheme)],
	# Dataset required fields
	license: Annotated[LicenseEnum, Form()],
	platform: Annotated[PlatformEnum, Form()],
	authors: Annotated[List[str], Form()],  # List of authors
	# Dataset optional fields
	project_id: Annotated[Optional[str], Form()] = None,
	aquisition_year: Annotated[Optional[int], Form()] = None,
	aquisition_month: Annotated[Optional[int], Form()] = None,
	aquisition_day: Annotated[Optional[int], Form()] = None,
	additional_information: Annotated[Optional[str], Form()] = None,
	data_access: Annotated[DatasetAccessEnum, Form()] = DatasetAccessEnum.public,
	citation_doi: Annotated[Optional[str], Form()] = None,
):
	"""Handle chunked upload of a GeoTIFF file with incremental hash computation"""
	user = verify_token(token)
	if not user:
		logger.error('Invalid token provided for upload', LogContext(category=LogCategory.AUTH, token=token))
		raise HTTPException(status_code=401, detail='Invalid token')

	# Start upload timer
	t1 = time.time()

	chunk_index = int(chunk_index)
	chunks_total = int(chunks_total)

	upload_file_name = f'{upload_id}.tif.tmp'
	upload_target_path = settings.archive_path / upload_file_name

	# Log chunk upload start
	logger.info(
		f'Processing chunk {chunk_index + 1}/{chunks_total} for file {file.filename}',
		LogContext(
			category=LogCategory.UPLOAD,
			user_id=user.id,
			token=token,
			extra={'upload_id': upload_id, 'chunk_index': chunk_index, 'chunks_total': chunks_total},
		),
	)

	# Write chunk
	try:
		content = await file.read()
		mode = 'wb' if chunk_index == 0 else 'ab'
		async with aiofiles.open(upload_target_path, mode) as buffer:
			await buffer.write(content)
	except Exception as e:
		logger.error(
			f'Error writing chunk {chunk_index}: {str(e)}',
			LogContext(
				category=LogCategory.UPLOAD,
				user_id=user.id,
				token=token,
				extra={'upload_id': upload_id, 'chunk_index': chunk_index},
			),
		)
		raise HTTPException(status_code=500, detail=f'Error writing chunk: {str(e)}')

	# Process final chunk
	if chunk_index == chunks_total - 1:
		try:
			# Calculate upload runtime
			t2 = time.time()
			upload_runtime = t2 - t1

			logger.info(
				f'Creating dataset entry for {file.filename}',
				LogContext(
					category=LogCategory.UPLOAD,
					user_id=user.id,
					token=token,
					extra={'upload_id': upload_id, 'file_name': file.filename},
				),
			)

			# Create dataset entry
			dataset = create_dataset_entry(
				user_id=user.id,
				file_name=file.filename,
				license=license,
				platform=platform,
				authors=authors,
				project_id=project_id,
				aquisition_year=aquisition_year,
				aquisition_month=aquisition_month,
				aquisition_day=aquisition_day,
				additional_information=additional_information,
				data_access=data_access,
				citation_doi=citation_doi,
				token=token,
			)

			# Rename file with dataset ID
			file_name = f'{dataset.id}_ortho.tif'
			target_path = settings.archive_path / file_name
			upload_target_path.rename(target_path)

			# Create ortho entry
			sha256 = get_file_identifier(target_path)
			ortho_info = cog_info(target_path)

			logger.info(
				f'Creating ortho entry for dataset {dataset.id}',
				LogContext(
					category=LogCategory.UPLOAD,
					user_id=user.id,
					dataset_id=dataset.id,
					token=token,
					extra={'file_name': file_name},
				),
			)

			upsert_ortho_entry(
				dataset_id=dataset.id,
				file_path=target_path,
				ortho_upload_runtime=upload_runtime,
				ortho_info=ortho_info,
				version=1,
				sha256=sha256,
				token=token,
			)

			# Update status to indicate upload completion
			update_status(
				token=token,
				dataset_id=dataset.id,
				current_status=StatusEnum.idle,
				is_upload_done=True,
				has_error=False,
			)

			logger.info(
				f'Upload completed successfully for dataset {dataset.id}',
				LogContext(
					category=LogCategory.UPLOAD,
					user_id=user.id,
					dataset_id=dataset.id,
					token=token,
					extra={
						'file_size': target_path.stat().st_size,
						'upload_time': upload_runtime,
						'file_name': file_name,
					},
				),
			)

			return dataset

		except Exception as e:
			logger.error(
				f'Error processing final chunk: {str(e)}',
				LogContext(
					category=LogCategory.UPLOAD,
					user_id=user.id,
					dataset_id=dataset.id if 'dataset' in locals() else None,
					token=token,
					extra={'upload_id': upload_id, 'file_name': file.filename, 'error': str(e)},
				),
			)
			# Update status to indicate error
			if 'dataset' in locals():
				update_status(
					token=token,
					dataset_id=dataset.id,
					current_status=StatusEnum.uploading,
					has_error=True,
					error_message=str(e),
				)
			raise HTTPException(status_code=500, detail=str(e))

	return {'message': f'Chunk {chunk_index} of {chunks_total} received'}


# Main routes for the logic
# @router.post('/datasets')
# async def upload_geotiff(file: UploadFile, token: Annotated[str, Depends(oauth2_scheme)]):
# 	"""
# 	Create a new Dataset by uploading a GeoTIFF file.

# 	Further metadata is not yet necessary. The response will contain a Dataset.id
# 	that is needed for subsequent calls to the API. Once, the GeoTIFF is uploaded,
# 	the backend will start pre-processing the file.
# 	It can only be used in the front-end once preprocessing finished AND all mandatory
# 	metadata is set.

# 	To send the file use the `multipart/form-data` content type. The file has to be sent as the
# 	value of a field named `file`. For example, using HTML forms like this:

# 	```html
# 	<form action="/upload" method="post" enctype="multipart/form-data">
# 	    <input type="file" name="file">
# 	    <input type="submit">
# 	</form>
# 	```

# 	Or using the `requests` library in Python like this:

# 	```python
# 	import requests
# 	url = "http://localhost:8000/upload"
# 	files = {"file": open("example.txt", "rb")}
# 	response = requests.post(url, files=files)
# 	print(response.json())
# 	```

# 	"""
# 	# first thing we do is verify the token
# 	user = verify_token(token)
# 	if not user:
# 		return HTTPException(status_code=401, detail='Invalid token')

# 	# we create a uuid for this dataset
# 	uid = str(uuid.uuid4())

# 	# new file name
# 	file_name = f'{uid}_{Path(file.filename).stem}.tif'

# 	# use the settings path to figure out a new location for this file
# 	target_path = settings.archive_path / file_name

# 	# start a timer
# 	t1 = time.time()

# 	# Stream the file in chunks instead of loading it all at once
# 	sha256_hash = hashlib.sha256()
# 	chunk_size = 4 * 1024 * 1024  # 4MB chunks for better performance with large files

# 	try:
# 		with target_path.open('wb') as buffer:
# 			while chunk := await file.read(chunk_size):
# 				buffer.write(chunk)
# 				sha256_hash.update(chunk)

# 		sha256 = sha256_hash.hexdigest()
# 	except Exception as e:
# 		logger.exception(f'Error saving file: {str(e)}', extra={'token': token})
# 		raise HTTPException(status_code=400, detail=f'Error saving file: {str(e)}')

# 	# try to open with rasterio
# 	with rasterio.open(str(target_path), 'r') as src:
# 		bounds = src.bounds
# 		transformed_bounds = rasterio.warp.transform_bounds(src.crs, 'EPSG:4326', *bounds)

# 	# stop the timer
# 	t2 = time.time()

# 	# fill the metadata
# 	# dataset = Dataset(
# 	data = dict(
# 		file_name=target_path.name,
# 		file_alias=file.filename,
# 		file_size=target_path.stat().st_size,
# 		copy_time=t2 - t1,
# 		sha256=sha256,
# 		bbox=transformed_bounds,
# 		status=StatusEnum.pending,
# 		user_id=user.id,
# 	)
# 	# print(data)
# 	dataset = Dataset(**data)

# 	# upload the dataset
# 	with use_client(token) as client:
# 		try:
# 			send_data = {k: v for k, v in dataset.model_dump().items() if k != 'id' and v is not None}
# 			response = client.table(settings.datasets_table).insert(send_data).execute()
# 		except Exception as e:
# 			logger.exception(
# 				f'An error occurred while trying to upload the dataset: {str(e)}',
# 				extra={'token': token, 'user_id': user.id},
# 			)
# 			raise HTTPException(
# 				status_code=400,
# 				detail=f'An error occurred while trying to upload the dataset: {str(e)}',
# 			)

# 	# update the dataset with the id
# 	dataset = Dataset(**response.data[0])

# 	logger.info(
# 		f'Created new dataset <ID={dataset.id}> with file {dataset.file_alias}. ({format_size(dataset.file_size)}). Took {dataset.copy_time:.2f}s.',
# 		extra={'token': token, 'user_id': user.id, 'dataset_id': dataset.id},
# 	)

# 	return dataset
