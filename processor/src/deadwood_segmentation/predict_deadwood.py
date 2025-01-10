from pathlib import Path
from shared.logger import logger
from .deadtreesmodels.deadwood import DeadwoodInference
from .upload_prediction import upload_to_supabase
from ..exceptions import ProcessingError
import rasterio

CONFIG_PATH = str(Path(__file__).parent / 'deadtreesmodels/deadwood_inference_config.json')


def predict_deadwood(dataset_id, file_path):
	try:
		logger.info('Initializing deadwood inference model')
		deadwood_model = DeadwoodInference(config_path=CONFIG_PATH)

		logger.info('Running deadwood inference')
		polygons = deadwood_model.inference_deadwood(str(file_path))

		logger.info('Transforming polygons')
		# Note: transform_mask is now handled inside inference_deadwood
		transformed_polygons = {'type': 'MultiPolygon', 'coordinates': [p.exterior.coords[:] for p in polygons]}

		# logger.info('Extracting bbox')
		# with rasterio.open(file_path) as src:
		# 	bounds = src.bounds
		# 	bbox_geojson = {
		# 		'type': 'MultiPolygon',
		# 		'coordinates': [
		# 			[
		# 				[
		# 					[bounds.left, bounds.top],
		# 					[bounds.right, bounds.top],
		# 					[bounds.right, bounds.bottom],
		# 					[bounds.left, bounds.bottom],
		# 					[bounds.left, bounds.top],
		# 				]
		# 			]
		# 		],
		# 	}
		bbox_geojson = None

		logger.info('Uploading to supabase')
		res = upload_to_supabase(
			dataset_id,
			transformed_polygons,
			bbox_geojson,
			'segmentation',
			'model_prediction',
			3,
		)

		if res.status_code == 200:
			logger.info('Uploaded to supabase')
		else:
			logger.error(f'Error uploading to supabase: {res.json()}')
			raise ProcessingError(
				f'Error uploading to supabase: {res.json()}', task_type='deadwood_segmentation', dataset_id=dataset_id
			)

		logger.info('Inference deadwood Done')

	except Exception as e:
		logger.error(f'Error in deadwood prediction: {str(e)}')
		raise ProcessingError(str(e), task_type='deadwood_segmentation', dataset_id=dataset_id)
