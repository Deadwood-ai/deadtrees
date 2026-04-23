from pathlib import Path

import rasterio

from shared.logger import logger
from shared.logging import LogContext, LogCategory
from shared.models import LabelDataEnum

from ..exceptions import ProcessingError
from ..utils.prediction_labels import replace_model_prediction_label
from ..utils.segmentation import polygons_to_multipolygon_geojson, reproject_polygons
from ..utils.geometry_validation import validate_and_fix_polygons
from .inference import CombinedInference

PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
ASSETS_DIR = PROJECT_ROOT / 'assets'

MODEL_PATH = str(ASSETS_DIR / 'models' / 'mitb3_seed200_ckpt_epoch_6_best_macro_f1.safetensors')
MODULE_NAME = 'deadwood_treecover_combined_v2'
CHECKPOINT_NAME = Path(MODEL_PATH).name


def predict_combined(dataset_id: int, file_path: Path, user_id: str, token: str):
    try:
        log = lambda msg, **extra: logger.info(
            msg,
            LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user_id, token=token, extra=extra),
        )

        log('Initializing combined inference model')
        model = CombinedInference(model_path=MODEL_PATH)

        log('Running combined inference', file_path=str(file_path))
        deadwood_polygons, treecover_polygons = model.inference(str(file_path))

        with rasterio.open(str(file_path)) as src:
            src_crs = src.crs

        model_config = {'module': MODULE_NAME, 'checkpoint_name': CHECKPOINT_NAME}

        _save_label(
            polygons=deadwood_polygons,
            label_data=LabelDataEnum.deadwood,
            src_crs=src_crs,
            dataset_id=dataset_id,
            user_id=user_id,
            token=token,
            model_config=model_config,
            label_type='deadwood',
        )

        _save_label(
            polygons=treecover_polygons,
            label_data=LabelDataEnum.forest_cover,
            src_crs=src_crs,
            dataset_id=dataset_id,
            user_id=user_id,
            token=token,
            model_config=model_config,
            label_type='treecover',
        )

    except Exception as e:
        logger.error(
            f'Error in predict_combined: {str(e)}',
            LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user_id, token=token),
        )
        raise ProcessingError(str(e), task_type='deadwood_treecover_combined_segmentation', dataset_id=dataset_id)


def _save_label(polygons, label_data, src_crs, dataset_id, user_id, token, model_config, label_type):
    log_ctx = LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user_id, token=token)

    if len(polygons) == 0:
        logger.warning(f'No {label_type} polygons detected', log_ctx)
        return

    polygons = reproject_polygons(polygons, src_crs, 'EPSG:4326')
    polygons, _ = validate_and_fix_polygons(polygons, min_area=0.0, dataset_id=dataset_id, label_type=label_type)

    if len(polygons) == 0:
        logger.warning(f'No valid {label_type} polygons after geometry validation', log_ctx)
        return

    geojson = polygons_to_multipolygon_geojson(polygons)
    label = replace_model_prediction_label(
        dataset_id=dataset_id,
        user_id=user_id,
        label_data=label_data,
        geometry=geojson,
        token=token,
        model_config=model_config,
    )
    logger.info(f'Created {label_type} label {label.id}', log_ctx)
