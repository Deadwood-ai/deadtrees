from pathlib import Path
from shared.logger import logger
from shared.logging import LogContext, LogCategory
from shared.models import LabelDataEnum
from .inference import DeadwoodInference
from ..exceptions import ProcessingError
import rasterio
from ..utils.prediction_labels import replace_model_prediction_label
from ..utils.segmentation import polygons_to_multipolygon_geojson, reproject_polygons

# Get base project directory (where assets folder is located)
PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
ASSETS_DIR = PROJECT_ROOT / 'assets'

MODEL_PATH = str(ASSETS_DIR / 'models' / 'segformer_b5_full_epoch_100.safetensors')
MODULE_NAME = 'deadwood_segmentation_v1_moehring'
CHECKPOINT_NAME = Path(MODEL_PATH).name


def predict_deadwood(dataset_id: int, file_path: Path, user_id: str, token: str):
	try:
		# First, check and delete any existing model prediction labels for deadwood
		logger.info(
			f'Checking for existing deadwood prediction labels for dataset {dataset_id}',
			LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user_id, token=token),
		)

		logger.info(
			'Initializing deadwood inference model',
			LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		deadwood_model = DeadwoodInference(model_path=MODEL_PATH)

		logger.info(
			'Running deadwood inference',
			LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		polygons = deadwood_model.inference_deadwood(str(file_path))

		if len(polygons) == 0:
			logger.warning(
				'No deadwood polygons detected',
				LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user_id, token=token),
			)
			return

		with rasterio.open(str(file_path)) as src:
			src_crs = src.crs
		# Reproject polygons to WGS 84
		polygons = reproject_polygons(polygons, src_crs, 'EPSG:4326')

		# Validate and fix geometries before saving (CRITICAL for frontend performance)
		logger.info(
			'Validating and fixing geometries before database storage',
			LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		from processor.src.utils.geometry_validation import validate_and_fix_polygons

		polygons, validation_stats = validate_and_fix_polygons(
			polygons, min_area=0.0, dataset_id=dataset_id, label_type='deadwood'
		)

		if len(polygons) == 0:
			logger.warning(
				'No valid deadwood polygons after geometry validation',
				LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user_id, token=token),
			)
			return

		deadwood_geojson = polygons_to_multipolygon_geojson(polygons)

		logger.info(
			'Creating label with geometries',
			LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		label = replace_model_prediction_label(
			dataset_id=dataset_id,
			user_id=user_id,
			label_data=LabelDataEnum.deadwood,
			geometry=deadwood_geojson,
			token=token,
			model_config={
				'module': MODULE_NAME,
				'checkpoint_name': CHECKPOINT_NAME,
			},
		)
		logger.info(
			f'Created label {label.id} with geometries',
			LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user_id, token=token),
		)

	except Exception as e:
		logger.error(
			f'Error in predict_deadwood: {str(e)}',
			LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		raise ProcessingError(str(e), task_type='deadwood_segmentation', dataset_id=dataset_id)
