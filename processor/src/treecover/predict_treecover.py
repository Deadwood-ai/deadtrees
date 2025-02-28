import os
import json
import time
from pathlib import Path
import tempfile

import geopandas as gpd
from shapely.geometry import shape, mapping

from processor.src.deadwood_segmentation.deadtreesmodels.common.common import reproject_polygons
from processor.src.exceptions import ProcessingError
from shared.db import use_client
from shared.labels import create_label_with_geometries
from shared.settings import settings
from shared.logger import logger
from shared.models import LabelSourceEnum, LabelTypeEnum, LabelDataEnum, LabelPayloadData
from shared.logging import LogContext, LogCategory

# Import the direct implementation
from processor.src.deadwood_segmentation.deadtreesmodels.treecover.tree_cover_inference import inference_forestcover


def predict_treecover(dataset_id, image_path, user_id, token):
	"""
	Run tree cover detection on an orthophoto and save the results to the database.

	Args:
	    dataset_id (int): ID of the dataset
	    image_path (Path): Path to the input image
	    user_id (str): ID of the user
	    token (str): Authentication token
	"""
	try:
		start_time = time.time()
		logger.info(
			'Starting tree cover detection prediction',
			LogContext(
				category=LogCategory.FOREST,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'image_path': str(image_path)},
			),
		)

		# Run TCD prediction directly using our implementation
		polygons = inference_forestcover(str(image_path))

		polygons_reprojected = reproject_polygons(polygons, 'EPSG:3395', 'EPSG:4326')

		# Convert polygons to GeoJSON MultiPolygon format
		forest_cover_geojson = {
			'type': 'MultiPolygon',
			'coordinates': [[[[float(x), float(y)] for x, y in poly.exterior.coords]] for poly in polygons_reprojected],
		}

		# Create label payload
		payload = LabelPayloadData(
			dataset_id=dataset_id,
			label_source=LabelSourceEnum.model_prediction,
			label_type=LabelTypeEnum.semantic_segmentation,
			label_data=LabelDataEnum.forest_cover,
			label_quality=3,
			geometry=forest_cover_geojson,
			properties={'source': 'model_prediction'},
		)

		label = create_label_with_geometries(payload, user_id, token)

		processing_time = time.time() - start_time
		logger.info(
			'Tree cover detection completed',
			LogContext(
				category=LogCategory.FOREST,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'processing_time': processing_time},
			),
		)
	except Exception as e:
		logger.error(f'Error in predict_treecover: {str(e)}')
		raise ProcessingError(str(e), task_type='treecover_segmentation', dataset_id=dataset_id)
