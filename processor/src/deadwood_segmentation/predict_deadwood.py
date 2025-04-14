from pathlib import Path
from shared.logger import logger
from shared.models import LabelPayloadData, LabelSourceEnum, LabelTypeEnum, LabelDataEnum
from shared.labels import create_label_with_geometries
from .deadtreesmodels.deadwood import DeadwoodInference
from ..exceptions import ProcessingError
import rasterio
import asyncio
from .deadtreesmodels.common.common import reproject_polygons

# Get base project directory (where assets folder is located)
PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
ASSETS_DIR = PROJECT_ROOT / 'assets'

CONFIG_PATH = str(Path(__file__).parent / 'deadtreesmodels/deadwood_inference_config.json')
MODEL_PATH = str(ASSETS_DIR / 'models' / 'segformer_b5_full_epoch_100.safetensors')


def predict_deadwood(dataset_id: int, file_path: Path, user_id: str, token: str):
	try:
		logger.info('Initializing deadwood inference model')
		deadwood_model = DeadwoodInference(config_path=CONFIG_PATH, model_path=MODEL_PATH)

		logger.info('Running deadwood inference')
		polygons = deadwood_model.inference_deadwood(str(file_path))

		if not any(polygons):
			logger.warning('No deadwood polygons detected')
			return

		with rasterio.open(str(file_path)) as src:
			src_crs = src.crs
		# Reproject polygons to WGS 84
		polygons = reproject_polygons(polygons, src_crs, 'EPSG:4326')

		# Convert polygons to GeoJSON MultiPolygon format with holes
		deadwood_geojson = {
			'type': 'MultiPolygon',
			'coordinates': [
				[[[float(x), float(y)] for x, y in poly.exterior.coords]]
				+ [[[float(x), float(y)] for x, y in interior.coords] for interior in poly.interiors]
				for poly in polygons
			],
		}

		# Create label payload
		payload = LabelPayloadData(
			dataset_id=dataset_id,
			label_source=LabelSourceEnum.model_prediction,
			label_type=LabelTypeEnum.semantic_segmentation,
			label_data=LabelDataEnum.deadwood,
			label_quality=3,
			geometry=deadwood_geojson,
			# properties={'source': 'model_prediction'},
		)

		# Create label with geometries
		logger.info('Creating label with geometries')
		label = create_label_with_geometries(payload, user_id, token)
		logger.info(f'Created label {label.id} with geometries')

	except Exception as e:
		logger.error(f'Error in predict_deadwood: {str(e)}')
		raise ProcessingError(str(e), task_type='deadwood_segmentation', dataset_id=dataset_id)
