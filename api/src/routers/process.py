from typing import Optional, Annotated, List
from fastapi import APIRouter, Depends, HTTPException, Body
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel

from shared.db import verify_token, use_client
from shared.settings import settings
from shared.models import TaskPayload, QueueTask, TaskTypeEnum
from shared.logging import LogContext, LogCategory, UnifiedLogger, SupabaseHandler

# create the router for the processing
router = APIRouter()

# create the OAuth2 password scheme for supabase login
oauth2_scheme = OAuth2PasswordBearer(tokenUrl='token')

# Create logger instance
logger = UnifiedLogger(__name__)
# Add Supabase handler
logger.add_supabase_handler(SupabaseHandler())


class ProcessRequest(BaseModel):
	task_types: List[str]


@router.put('/datasets/{dataset_id}/process')
def create_processing_task(
	dataset_id: int,
	token: Annotated[str, Depends(oauth2_scheme)],
	request: ProcessRequest,
):
	# Verify the token
	user = verify_token(token)
	if not user:
		logger.warning('Invalid token attempt', LogContext(category=LogCategory.AUTH, token=token))
		raise HTTPException(status_code=401, detail='Invalid token')

	# Log process request
	logger.info(
		f'Processing request received for dataset {dataset_id}',
		LogContext(
			category=LogCategory.ADD_PROCESS,
			user_id=user.id,
			dataset_id=dataset_id,
			token=token,
			extra={'task_types': request.task_types},
		),
	)

	# Validate task_types
	if not request.task_types:
		logger.warning(
			'Empty task types list provided',
			LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token),
		)
		raise HTTPException(status_code=400, detail='At least one task type must be specified')

	try:
		validated_task_types = [TaskTypeEnum(t) for t in request.task_types]
	except ValueError as e:
		logger.warning(
			f'Invalid task type provided: {str(e)}',
			LogContext(
				category=LogCategory.ADD_PROCESS,
				user_id=user.id,
				dataset_id=dataset_id,
				token=token,
				extra={'invalid_task_types': request.task_types},
			),
		)
		raise HTTPException(status_code=400, detail=f'Invalid task type: {str(e)}')

	# Load the dataset info
	try:
		with use_client(token) as client:
			response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()
			if not response.data:
				logger.warning(
					f'Dataset not found: {dataset_id}',
					LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token),
				)
				raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> not found.')
	except HTTPException:
		raise
	except Exception as e:
		msg = f'Error loading dataset {dataset_id}: {str(e)}'
		logger.error(
			msg, LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token)
		)
		raise HTTPException(status_code=500, detail=msg)

	# Create the task payload
	payload = TaskPayload(
		dataset_id=dataset_id,
		user_id=user.id,
		task_types=validated_task_types,
		priority=2,
		is_processing=False,
	)

	# Add the task to the queue
	try:
		with use_client(token) as client:
			send_data = {k: v for k, v in payload.model_dump().items() if v is not None and k != 'id'}
			response = client.table(settings.queue_table).insert(send_data).execute()
			task = TaskPayload(**response.data[0])

		logger.info(
			f'Added task to queue for dataset {dataset_id}',
			LogContext(
				category=LogCategory.ADD_PROCESS,
				user_id=user.id,
				dataset_id=dataset_id,
				token=token,
				extra={'task_id': task.id, 'task_types': request.task_types},
			),
		)

	except Exception as e:
		msg = f'Error adding task to queue: {str(e)}'
		logger.error(
			msg, LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token)
		)
		raise HTTPException(status_code=500, detail=msg)

	# Load the current position assigned to this task
	try:
		with use_client(token) as client:
			response = client.table(settings.queue_position_table).select('*').eq('id', task.id).execute()
			if response.data:
				task_data = response.data[0]
				task_data['estimated_time'] = task_data.get('estimated_time') or 0.0
				task = QueueTask(**task_data)
				logger.info(
					f'Task position loaded for task {task.id}',
					LogContext(
						category=LogCategory.ADD_PROCESS,
						user_id=user.id,
						dataset_id=dataset_id,
						token=token,
						extra={'position': task.current_position, 'estimated_time': task.estimated_time},
					),
				)
				return task
			else:
				logger.warning(
					f'No task position found for task {task.id}',
					LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token),
				)
				task = QueueTask(
					id=task.id,
					dataset_id=dataset_id,
					user_id=user.id,
					priority=2,
					is_processing=False,
					current_position=-1,
					estimated_time=0.0,
					task_types=validated_task_types,
				)
				return task

	except Exception as e:
		msg = f'Error loading task position: {str(e)}'
		logger.error(
			msg, LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token)
		)
		raise HTTPException(status_code=500, detail=msg)


# # @router.put("/datasets/{dataset_id}/force-cog-build")
# async def create_direct_cog(
# 	dataset_id: int,
# 	options: Optional[ProcessOptions],
# 	token: Annotated[str, Depends(oauth2_scheme)],
# ):
# 	"""
# 	This route will bypass the queue and directly start the cog calculation for the given dataset_id.
# 	"""
# 	# count an invoke
# 	monitoring.cog_invoked.inc()
# 	pass

# 	# first thing we do is verify the token
# 	user = verify_token(token)
# 	if not user:
# 		return HTTPException(status_code=401, detail='Invalid token')

# 	# load the dataset
# 	try:
# 		with use_client(token) as client:
# 			response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()
# 			dataset = Dataset(**response.data[0])
# 	except Exception as e:
# 		# log the error to the database
# 		msg = f'Error loading dataset {dataset_id}: {str(e)}'
# 		logger.error(msg, extra={'token': token, 'user_id': user.id, 'dataset_id': dataset_id})

# 		return HTTPException(status_code=500, detail=msg)

# 	# if we are still here, update the status to processing
# 	update_status(token, dataset.id, StatusEnum.cog_processing)

# 	# get the output path settings
# 	cog_folder = Path(dataset.file_name).stem

# 	file_name = f'{cog_folder}_cog_{options.profile}_ts_{options.tiling_scheme}_q{options.quality}.tif'
# 	# file_name = f"{cog_folder}_cog_{options.profile}_ovr{options.overviews}_q{options.quality}.tif"

# 	# output path is the cog folder, then a folder for the dataset, then the cog file
# 	output_path = settings.cog_path / cog_folder / file_name

# 	# get the input path
# 	input_path = settings.archive_path / dataset.file_name

# 	# crete if not exists
# 	if not output_path.parent.exists():
# 		output_path.parent.mkdir(parents=True, exist_ok=True)

# 	# start the cog calculation
# 	t1 = time.time()
# 	try:
# 		info = calculate_cog(
# 			str(input_path),
# 			str(output_path),
# 			profile=options.profile,
# 			quality=options.quality,
# 			skip_recreate=not options.force_recreate,
# 			tiling_scheme=options.tiling_scheme,
# 		)
# 		logger.info(
# 			f'COG profile returned for dataset {dataset.id}: {info}',
# 			extra={'token': token, 'dataset_id': dataset.id, 'user_id': user.id},
# 		)
# 	except Exception as e:
# 		msg = f'Error processing COG for dataset {dataset.id}: {str(e)}'

# 		# set the status
# 		update_status(token, dataset.id, StatusEnum.cog_errored)

# 		# log the error to the database
# 		logger.error(msg, extra={'token': token, 'user_id': user.id, 'dataset_id': dataset.id})
# 		return

# 	# stop the timer
# 	t2 = time.time()

# 	# calcute number of overviews
# 	overviews = len(info.IFD) - 1  # since first IFD is the main image

# 	# fill the metadata
# 	meta = dict(
# 		dataset_id=dataset.id,
# 		cog_folder=str(cog_folder),
# 		cog_name=file_name,
# 		cog_url=f'{cog_folder}/{file_name}',
# 		cog_size=output_path.stat().st_size,
# 		runtime=t2 - t1,
# 		user_id=user.id,
# 		compression=options.profile,
# 		overviews=overviews,
# 		tiling_scheme=options.tiling_scheme,
# 		# !! This is not correct!!
# 		resolution=int(options.resolution * 100),
# 		blocksize=info.IFD[0].Blocksize[0],
# 	)

# 	# Build the Cog metadata
# 	cog = Cog(**meta)

# 	with use_client(token) as client:
# 		try:
# 			# filter out the None data
# 			send_data = {k: v for k, v in cog.model_dump().items() if v is not None}
# 			response = client.table(settings.cogs_table).upsert(send_data).execute()
# 		except Exception as e:
# 			msg = f'An error occured while trying to save the COG metadata for dataset {dataset.id}: {str(e)}'

# 			logger.error(
# 				msg,
# 				extra={'token': token, 'user_id': user.id, 'dataset_id': dataset.id},
# 			)
# 			update_status(token, dataset.id, StatusEnum.cog_errored)

# 	# if there was no error, update the status
# 	update_status(token, dataset.id, StatusEnum.processed)

# 	logger.info(
# 		f'Finished creating new COG <profile: {cog.compression}> for dataset {dataset.id}.',
# 		extra={'token': token, 'dataset_id': dataset.id, 'user_id': user.id},
# 	)


# @router.put('/datasets/{dataset_id}/build-cog')
# def create_cog(
# 	dataset_id: int,
# 	options: Optional[ProcessOptions],
# 	token: Annotated[str, Depends(oauth2_scheme)],
# 	background_tasks: BackgroundTasks,
# ):
# 	"""FastAPI process chain to add a cog-calculation task to the processing queue, with monitoring and logging.
# 	Verifies the access token, loads the dataset to calculate, creates a TaskPayload and adds the task to
# 	the background process of FastAPI. The task metadata is returned to inform the user on the frontend
# 	about the queue position and estimated wait time.

# 	Args:
# 	    dataset_id (int): The id of the processed cog
# 	    options (Optional[ProcessOptions]): Optional processsing options to change the standard settings for the cog creation
# 	    token (Annotated[str, Depends): Supabase access token
# 	    background_tasks (BackgroundTasks): FastAPI background tasks object

# 	Returns:
# 	    QueueTask: Returns the task
# 	"""
# 	# count an invoke
# 	monitoring.cog_invoked.inc()

# 	# first thing we do is verify the token
# 	user = verify_token(token)
# 	if not user:
# 		return HTTPException(status_code=401, detail='Invalid token')

# 	# load the the dataset info for this one
# 	try:
# 		with use_client(token) as client:
# 			# filter using the given dataset_id
# 			response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()

# 			# create the dataset
# 			dataset = Dataset(**response.data[0])
# 	except Exception as e:
# 		# log the error to the database
# 		msg = f'Error loading dataset {dataset_id}: {str(e)}'
# 		logger.error(msg, extra={'token': token, 'user_id': user.id, 'dataset_id': dataset_id})

# 		return HTTPException(status_code=500, detail=msg)

# 	# get the options
# 	options = options or ProcessOptions()

# 	# add a new task to the queue
# 	try:
# 		payload = TaskPayload(
# 			dataset_id=dataset.id,
# 			user_id=user.id,
# 			build_args=options,
# 			priority=2,
# 			is_processing=False,
# 		)

# 		with use_client(token) as client:
# 			send_data = {k: v for k, v in payload.model_dump().items() if v is not None and k != 'id'}
# 			response = client.table(settings.queue_table).insert(send_data).execute()
# 			payload = TaskPayload(**response.data[0])
# 	except Exception as e:
# 		# log the error to the database
# 		msg = f'Error adding task to queue: {str(e)}'
# 		logger.error(msg, extra={'token': token, 'user_id': user.id, 'dataset_id': dataset_id})

# 		return HTTPException(status_code=500, detail=msg)

# 	# Load the current position assigned to this task
# 	try:
# 		with use_client(token) as client:
# 			response = client.table(settings.queue_position_table).select('*').eq('id', payload.id).execute()
# 			if response.data:
# 				task_data = response.data[0]
# 				# Handle the case where estimated_time might be None
# 				task_data['estimated_time'] = task_data.get('estimated_time') or 0.0
# 				task = QueueTask(**task_data)
# 			else:
# 				# Handle the case where no task data is found
# 				logger.warning(
# 					f'No task position found for task ID {payload.id}',
# 					extra={
# 						'token': token,
# 						'user_id': user.id,
# 						'dataset_id': dataset_id,
# 					},
# 				)
# 				task = QueueTask(
# 					id=payload.id,
# 					dataset_id=dataset_id,
# 					user_id=user.id,
# 					build_args=options,
# 					priority=2,
# 					is_processing=False,
# 					current_position=-1,
# 					estimated_time=0.0,
# 					task_types=validated_task_types,
# 				)
# 	except Exception as e:
# 		# Log the error to the database
# 		msg = f'Error loading task position: {str(e)}'
# 		logger.error(msg, extra={'token': token, 'user_id': user.id, 'dataset_id': dataset_id})
# 		return HTTPException(status_code=500, detail=msg)

# 	# start the background task
# 	# background_tasks.add_task(background_process)

# 	# return the task
# 	return task
