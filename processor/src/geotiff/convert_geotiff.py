from datetime import datetime
import subprocess
from pathlib import Path
from rio_cogeo.cogeo import cog_info
from shared.settings import settings
from shared.db import use_client
from shared.hash import get_file_identifier
from shared.logger import logger
from shared.models import Ortho


def convert_geotiff(input_path: str, output_path: str, token: str = None) -> bool:
	"""Convert GeoTIFF using gdalwarp with optimized parameters"""
	cmd = [
		'gdalwarp',
		'-co',
		'COMPRESS=DEFLATE',
		'-co',
		'PREDICTOR=2',
		'-co',
		'TILED=YES',
		'-wo',
		'NUM_THREADS=ALL_CPUS',
		'-multi',
		'-co',
		'BIGTIFF=YES',
		'-ot',
		'Byte',
		'-dstnodata',
		'0',
		input_path,
		output_path,
	]

	try:
		logger.info('Running gdalwarp conversion', extra={'token': token})
		result = subprocess.run(cmd, check=True, capture_output=True, text=True)
		logger.info(f'gdalwarp output:\n{result.stdout}', extra={'token': token})
		return True
	except subprocess.CalledProcessError as e:
		logger.error(f'Error during gdalwarp conversion: {e}', extra={'token': token})
		return False


def verify_geotiff(file_path: str, token: str = None) -> bool:
	"""Verify GeoTIFF file integrity"""
	try:
		cmd = ['gdalinfo', file_path]
		result = subprocess.run(cmd, check=True, capture_output=True, text=True)
		return 'ERROR' not in result.stdout and 'FAILURE' not in result.stdout
	except subprocess.CalledProcessError as e:
		logger.error(f'File verification failed: {e}', extra={'token': token})
		return False


def update_ortho_table(file_path: Path, dataset_id: int, ortho_processing_runtime: float, token: str):
	"""Update the ortho table with the new ortho file information"""
	try:
		info = cog_info(str(file_path))
		sha256 = get_file_identifier(file_path)
		ortho = Ortho(
			dataset_id=dataset_id,
			ortho_file_name=file_path.name,
			version=1,
			created_at=datetime.now(),
			file_size=file_path.stat().st_size,
			sha256=sha256,
			ortho_info=info.model_dump(),
			ortho_processed=True,
			ortho_processing_runtime=ortho_processing_runtime,
		)

		with use_client(token) as client:
			client.table(settings.orthos_table).upsert(ortho.model_dump()).execute()
			return ortho
	except Exception as e:
		logger.error(f'Error updating ortho table: {e}', extra={'token': token})
		return None
