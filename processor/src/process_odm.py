import json
import zipfile
import docker
import requests
import time
from pathlib import Path
from typing import Optional, Dict, Any

from shared.models import QueueTask, StatusEnum
from shared.logger import logger
from shared.settings import settings
from shared.status import update_status
from shared.logging import LogContext, LogCategory
from shared.db import use_client, login
from shared.upload_validation import RAW_IMAGE_EXTENSIONS
from shared.zip_utils import (
	ensure_supported_zip_compression,
	UnsupportedZipCompressionError,
	InvalidZipArchiveError,
)
from processor.src.utils.ssh import (
	pull_file_from_storage_server,
	push_file_to_storage_server,
	check_file_exists_on_storage,
)
from processor.src.utils.shared_volume import (
	copy_files_to_shared_volume,
	copy_results_from_shared_volume,
	cleanup_volume_and_references,
	create_file_on_shared_volume,
	path_exists_on_shared_volume,
	read_file_from_shared_volume,
	remove_file_from_shared_volume,
	rewrite_file_on_shared_volume,
)
from processor.src.utils.reconstruction_orientation import (
	METADATA_TOLERANCE_DEGREES,
	filter_reconstructions_by_orientation,
	partials_from_opensfm_report,
)
from processor.src.utils.debug_artifacts import (
	retain_failed_artifacts_enabled_for_dataset,
	dt_resource_labels,
	build_container_forensics,
	write_debug_bundle,
)
from processor.src.utils.odm_inputs import select_odm_images
from processor.src.utils.ortho_resolution import budgeted_resolution_cm, mission_extent, reduced_resolution_note
from shared.exif_utils import extract_camera_nadir_deviation_degrees, extract_comprehensive_exif

# RTK file extensions as specified in requirements
RTK_EXTENSIONS = {'.RTK', '.MRK', '.RTL', '.RTB', '.RPOS', '.RTS', '.IMU'}
# ODM's OpenSfM stage stops right after reconstruction when this file exists
# (stages/run_opensfm.py, meant for split-merge); a later run without it resumes.
STOP_AFTER_RECONSTRUCTION_FLAG = 'opensfm/split_merge_stop_at_reconstruction.txt'
RECONSTRUCTION_FILE = 'opensfm/reconstruction.json'
# Created by the OpenSfM stage only after the stop point, so pass 1 must not produce it.
UNDISTORTED_DIR = 'opensfm/undistorted'
# Written by OpenSfM's reconstruct step; lists the images of each partial reconstruction.
OPENSFM_RECONSTRUCT_REPORT = 'opensfm/reports/reconstruction.json'
PRUNE_POINTS_SCRIPT = Path(__file__).parent / 'utils' / 'odm_prune_points.py'
CHECK_PHOTOS_SCRIPT = Path(__file__).parent / 'utils' / 'odm_check_photos.py'
# Several DJI cameras write exactly 0 into these tags for nadir shots (DT-951).
PLACEHOLDER_ZERO_PITCH_TAGS = {'GimbalPitchDegree', 'CameraPitchDegree'}
# Fewer nadir images than this among oblique ones cannot make an orthophoto (e.g. one take-off frame).
MIN_NADIR_IMAGES = 3


def _metadata_off_nadir_degrees(image_files: list[Path]) -> dict[str, float | None]:
	"""Off-nadir angle from camera metadata per image name, or None when unknown.

	An exact 0 gimbal/camera pitch is a placeholder on several cameras, so it counts
	as unknown rather than horizontal.
	"""
	angles: dict[str, float | None] = {}
	for image_file in image_files:
		orientation = extract_camera_nadir_deviation_degrees(image_file)
		if orientation is None or (orientation[1] in PLACEHOLDER_ZERO_PITCH_TAGS and orientation[2] == 0.0):
			angles[image_file.name] = None
		else:
			angles[image_file.name] = orientation[0]
	return angles


def _drop_metadata_obliques(
	image_files: list[Path], metadata_off_nadir: dict[str, float | None], max_off_nadir: float
) -> tuple[list[Path], list[Path]]:
	"""Drop images whose metadata says oblique, but only where the metadata is evidently usable.

	Metadata is trusted here only if it also recognizes at least MIN_NADIR_IMAGES nadir images; a
	flight whose tags all read oblique (or unknown) goes to ODM whole and the
	reconstructed orientation decides. Oblique images that never reconstruct still
	cost pass-1 time and can derail ODM (dataset 12174 ran out of memory with them).
	Returns ``(kept, dropped)``.
	"""
	limit = max_off_nadir + METADATA_TOLERANCE_DEGREES
	angles = [metadata_off_nadir.get(image_file.name) for image_file in image_files]
	if sum(angle is not None and angle <= limit for angle in angles) < MIN_NADIR_IMAGES:
		return list(image_files), []
	kept = [image_file for image_file, angle in zip(image_files, angles) if angle is None or angle <= limit]
	dropped = [image_file for image_file, angle in zip(image_files, angles) if angle is not None and angle > limit]
	return kept, dropped


def _build_odm_command() -> tuple[list[str], str, str]:
	"""Build the ODM CLI command for the current environment."""
	odm_command: list[str] = []

	if settings.DEV_MODE:
		resolution = '50.0'  # 50cm/pixel for fast testing
		odm_command.extend(['--fast-orthophoto'])
	else:
		# --max-concurrency 2: limits parallel threads to ~2x image_MP GB peak RAM
		# (default 4 causes OOM on large datasets: 655 images × 12MP × 4 threads ≈ 120GB+)
		# --matcher-neighbors 0: pair images by triangulation instead of the N nearest GPS
		# neighbours. With dense along-track capture (e.g. DJI L3 left/right pairs), N nearest
		# neighbours never reach the adjacent flight line, so strips are not tied together and
		# the ortho shows ghosted/duplicated features.
		resolution = '1.0'  # 1cm/pixel for production quality
		odm_command.extend(
			['--fast-orthophoto', '--feature-quality', 'high', '--matcher-neighbors', '0', '--max-concurrency', '2']
		)

	if settings.ODM_AUTO_BOUNDARY:
		odm_command.append('--auto-boundary')
	if settings.ODM_SKY_REMOVAL:
		odm_command.append('--sky-removal')
	if settings.ODM_BG_REMOVAL:
		odm_command.append('--bg-removal')

	env_mode = 'Speed optimized' if settings.DEV_MODE else 'Production quality'
	return odm_command, resolution, env_mode


def _filter_reconstruction_by_orientation(
	volume_name: str, project_name: str, metadata_off_nadir: dict[str, float | None], dataset_id: int, token: str
) -> bool:
	"""Drop reconstructed shots that look too far away from nadir from ``reconstruction.json``.

	Runs between the two ODM passes, so the orthophoto pass only undistorts and
	textures the remaining shots. The reconstructed orientation decides wherever GPS
	pins down the vertical; elsewhere camera metadata does. Returns whether any shot
	was dropped.
	"""
	max_off_nadir = settings.ODM_MAX_NADIR_DEVIATION_DEGREES
	log_context = LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id)
	raw_report = read_file_from_shared_volume(volume_name, f'{project_name}/{OPENSFM_RECONSTRUCT_REPORT}', dataset_id)
	partials = partials_from_opensfm_report(json.loads(raw_report)) if raw_report else None

	shots_dropped = False

	def drop_oblique_shots(raw_reconstruction: bytes) -> bytes:
		nonlocal shots_dropped
		filtered, result = filter_reconstructions_by_orientation(
			json.loads(raw_reconstruction), max_off_nadir, partials, metadata_off_nadir
		)
		logger.info(
			f'Reconstructed-orientation filter kept {len(result.kept)} shots within nadir +/- {max_off_nadir:g} degrees '
			f'and excluded {len(result.excluded)}; of the shots whose vertical could not be measured'
			+ (f' ({"; ".join(result.unjudged_reasons)})' if result.unjudged_reasons else '')
			+ f', camera metadata excluded {len(result.excluded_by_metadata)} and {len(result.unjudged)} were kept',
			log_context,
		)
		dropped = result.excluded + result.excluded_by_metadata
		if dropped:
			excluded_sample = ', '.join(f'{shot_id} ({angle:.1f} deg)' for shot_id, angle in dropped[:10])
			logger.warning(
				f'Excluded oblique shots: {excluded_sample}{" ..." if len(dropped) > 10 else ""}', log_context
			)
		# Unjudged shots come from partial reconstructions without a measured up axis. When (almost)
		# every shot that could be judged is oblique, they are stray fragments of the same oblique
		# capture; a lone nadir frame (e.g. at take-off, dataset 8625) cannot make an orthophoto either.
		too_few_nadir = len(result.kept) < MIN_NADIR_IMAGES
		if (result.excluded and too_few_nadir) or (not result.kept and not result.unjudged):
			raise Exception(
				f'No usable nadir images ({len(result.kept)} found): {len(result.excluded)} reconstructed images '
				f'look more than {max_off_nadir:g} degrees '
				f'away from nadir, camera metadata marks {len(result.excluded_by_metadata)} more as oblique, and '
				f'{len(result.unjudged)} could not be judged; oblique imagery cannot produce an orthophoto'
			)
		shots_dropped = bool(dropped)
		return json.dumps(filtered).encode() if shots_dropped else raw_reconstruction

	rewrite_file_on_shared_volume(volume_name, f'{project_name}/{RECONSTRUCTION_FILE}', drop_oblique_shots, dataset_id)
	return shots_dropped


def _with_budgeted_ortho_resolution(
	odm_command: list[str], volume_name: str, project_name: str, dataset_id: int, token: str
) -> tuple[list[str], str | None]:
	"""Return ``odm_command`` with a resolution whose orthophoto fits ``ODM_MAX_ORTHO_PIXELS``.

	Runs between the two ODM passes, when the reconstruction already shows the mission's
	extent. Missions that fit are left unchanged; otherwise also returns the note for the
	dataset's additional information.
	"""
	raw_reconstruction = read_file_from_shared_volume(volume_name, f'{project_name}/{RECONSTRUCTION_FILE}', dataset_id)
	extent = mission_extent(json.loads(raw_reconstruction)) if raw_reconstruction else None
	if extent is None:
		return odm_command, None
	index = odm_command.index('--orthophoto-resolution') + 1
	requested_cm = float(odm_command[index])
	resolution_cm = budgeted_resolution_cm(requested_cm, extent, settings.ODM_MAX_ORTHO_PIXELS)
	if resolution_cm == requested_cm:
		return odm_command, None
	logger.warning(
		f'Mission spans {extent.width_m:.0f} x {extent.height_m:.0f} m at ~{extent.gsd_cm:.1f} cm GSD; rendering the '
		f'orthophoto at {resolution_cm:g} cm/pixel so it stays within {settings.ODM_MAX_ORTHO_PIXELS / 1e9:g} Gpx',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)
	command = [*odm_command[:index], f'{resolution_cm:g}', *odm_command[index + 1 :]]
	return command, reduced_resolution_note(resolution_cm, extent)


def _append_dataset_note(dataset_id: int, note: str, token: str) -> None:
	"""Add ``note`` to the dataset's additional information, keeping what the contributor wrote."""
	with use_client(token) as client:
		row = client.table(settings.datasets_table).select('additional_information').eq('id', dataset_id).execute()
		existing = (row.data[0].get('additional_information') or '').strip() if row.data else ''
		if note in existing:
			return
		combined = f'{existing}\n\n{note}' if existing else note
		client.table(settings.datasets_table).update({'additional_information': combined}).eq('id', dataset_id).execute()


def _run_script_in_odm_image(
	client, script: Path, args: list[str], volume_name: str, resource_labels: dict, dataset_id: int, role: str
) -> str:
	"""Run a self-contained script with the ODM image's Python on the shared volume; return its last output line."""
	container = client.containers.run(
		image=settings.ODM_IMAGE,
		# The image's PATH picks the Python that has OpenSfM (ODM 3.6 puts /code/venv/bin first),
		# and its working directory /code makes the opendm package importable.
		entrypoint='python3',
		command=['-c', script.read_text(), *args],
		volumes={volume_name: {'bind': '/odm_data', 'mode': 'rw'}},
		mem_limit='100g',
		memswap_limit='100g',
		oom_score_adj=500,
		detach=True,
		name=f'dt-odm-{role}-d{dataset_id}-{int(time.time())}',
		labels={**resource_labels, 'dt_role': f'odm_{role}', 'dt_volume': volume_name},
	)
	try:
		result = _wait_for_container(container, f'ODM {role} step')
		output = container.logs().decode('utf-8', errors='ignore')
	finally:
		container.remove(force=True)
	if result.get('StatusCode', 1) != 0:
		raise Exception(f'{script.name} failed in the ODM image: {output[-2000:]}')
	return output.strip().splitlines()[-1]


def _prune_unobserved_points(
	client, volume_name: str, project_name: str, resource_labels: dict, dataset_id: int, token: str
) -> None:
	"""Remove sparse points only dropped shots observed, using OpenSfM inside the ODM image.

	OpenSfM's export fails on such points once their observations are gone, and
	tracks.csv is a binary OpenSfM format, so this runs odm_prune_points.py there.
	"""
	summary = _run_script_in_odm_image(
		client,
		PRUNE_POINTS_SCRIPT,
		[f'/odm_data/{project_name}/opensfm'],
		volume_name,
		resource_labels,
		dataset_id,
		'prune',
	)
	logger.info(
		f'Pruned sparse points seen only by excluded shots: {summary}',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)


def _check_photos_for_odm(
	client, volume_name: str, project_name: str, resource_labels: dict, dataset_id: int, token: str
) -> None:
	"""Parse and decode every image the way ODM does before ODM runs, so one unreadable image cannot stop it.

	See odm_check_photos.py: images that crash the parser get their MakerNote blanked
	(DT-1289, DJI "DJI MakerNotes" placeholder), and images that still crash or whose
	pixels OpenSfM cannot decode (DT-913) are left out.
	"""
	summary = json.loads(
		_run_script_in_odm_image(
			client,
			CHECK_PHOTOS_SCRIPT,
			[f'/odm_data/{project_name}/images'],
			volume_name,
			resource_labels,
			dataset_id,
			'photo_check',
		)
	)
	log_context = LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id)
	repaired, removed = summary['repaired'], summary['removed']
	logger.info(
		f'ODM photo check read {summary["checked"]} images: blanked the MakerNote of {len(repaired)} and '
		f'left out {len(removed)} that ODM cannot read',
		log_context,
	)
	if repaired:
		logger.warning(
			f"Blanked the MakerNote of images that crashed ODM's EXIF parser (GPS, XMP and pixels unchanged): "
			f'{", ".join(repaired[:10])}{" ..." if len(repaired) > 10 else ""}',
			log_context,
		)
	if removed:
		removed_sample = '; '.join(f'{entry["image"]} ({entry["error"]})' for entry in removed[:5])
		logger.warning(
			f'Left out images that ODM cannot read: {removed_sample}{" ..." if len(removed) > 5 else ""}',
			log_context,
		)


def process_odm(task: QueueTask, temp_dir: Path):
	"""
	Process ODM (OpenDroneMap) task for raw drone images.

	Steps:
	1. Query database to get actual raw_images_path (ZIP file location)
	2. Pull ZIP file from storage via SSH
	3. Extract ZIP file locally
	4. Detect RTK files and update database with metadata
	5. Extract EXIF metadata from images and update database
	6. Execute ODM Docker container using fast orthophoto settings
	7. Move generated orthomosaic to archive/{dataset_id}_ortho.tif
	8. Update status is_odm_done=True

	Uses an environment-specific ODM configuration optimized for our current
	production memory limits and development speed.

	Args:
		task: QueueTask with dataset_id and user information
		temp_dir: Temporary directory for processing
	"""
	from shared.db import login

	dataset_id = task.dataset_id
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

	update_status(token=token, dataset_id=dataset_id, current_status=StatusEnum.odm_processing)

	logger.info(
		f'Starting ODM processing for dataset {dataset_id}',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	try:
		# Step 1: Query database to get actual raw_images_path (ZIP file location)
		with use_client(token) as client:
			response = (
				client.table(settings.raw_images_table).select('raw_images_path').eq('dataset_id', dataset_id).execute()
			)
			if not response.data:
				raise Exception(f'No raw_images entry found for dataset {dataset_id}')

			remote_zip_path = response.data[0]['raw_images_path']
			logger.info(
				f'Found raw_images_path in database: {remote_zip_path}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)

		# Step 2: Pull ZIP file from storage
		zip_filename = f'{dataset_id}.zip'
		local_zip_path = temp_dir / zip_filename

		logger.info(
			f'Pulling ZIP file from storage: {remote_zip_path}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		pull_file_from_storage_server(
			remote_file_path=remote_zip_path, local_file_path=str(local_zip_path), token=token, dataset_id=dataset_id
		)

		# Step 3: Extract ZIP file locally
		extraction_dir = temp_dir / f'raw_images_{dataset_id}'
		extraction_dir.mkdir(exist_ok=True)

		logger.info(
			f'Extracting ZIP file to: {extraction_dir}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		try:
			ensure_supported_zip_compression(local_zip_path)
		except UnsupportedZipCompressionError as e:
			raise Exception(f'Unsupported ZIP compression for dataset {dataset_id}: {str(e)}') from e
		except InvalidZipArchiveError as e:
			raise Exception(f'Invalid ZIP archive for dataset {dataset_id}: {str(e)}') from e

		with zipfile.ZipFile(local_zip_path, 'r') as zip_ref:
			zip_ref.extractall(extraction_dir)

		# Step 4: Detect RTK files and update database with comprehensive metadata
		logger.info(
			'Analyzing extracted files for RTK data and image content',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		rtk_metadata, image_count, total_size_bytes = _analyze_extracted_files(extraction_dir, token, dataset_id)
		# Input transfer, extraction, and analysis can outlive the Supabase JWT.
		# Refresh immediately before the first post-work database write.
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		_update_raw_images_metadata(dataset_id, rtk_metadata, image_count, total_size_bytes, token)

		# Step 5: Extract EXIF metadata from images and update database
		logger.info(
			'Extracting EXIF metadata from drone images',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		exif_metadata = _extract_exif_from_images(extraction_dir, token, dataset_id)
		if exif_metadata:
			_update_camera_metadata(dataset_id, exif_metadata, token)

		# Step 6: Execute ODM Docker container. ODM runs on a named volume; only its
		# orthophoto is copied back to /data (the checkout and the container layer
		# sit on the hosts' smaller root disks). Output that may be retained after a
		# failure goes to the scratch dir, because the processing dir is always
		# removed when the task ends; startup cleanup prunes it after 24 h.
		output_root = settings.scratch_path if retain_failed_artifacts_enabled_for_dataset(dataset_id) else temp_dir
		odm_host_temp_dir = output_root / f'odm_temp_{dataset_id}'
		odm_host_temp_dir.mkdir(parents=True, exist_ok=True)

		logger.info(
			'Starting ODM processing with Docker container',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		token = _run_odm_container(
			images_dir=extraction_dir,
			output_dir=odm_host_temp_dir,
			token=token,
			dataset_id=dataset_id,
		)

		# Step 7: Move generated orthomosaic to standard location
		project_name = f'dataset_{dataset_id}'
		orthomosaic_path = _find_orthomosaic(odm_host_temp_dir, project_name, token, dataset_id)
		if not orthomosaic_path:
			raise Exception('ODM did not generate an orthomosaic')

		# Push orthomosaic to storage server at standard location (remote path)
		remote_ortho_path = f'{settings.STORAGE_SERVER_DATA_PATH}/{settings.ARCHIVE_DIR}/{dataset_id}_ortho.tif'

		logger.info(
			f'Pushing generated orthomosaic to storage: {remote_ortho_path}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		push_file_to_storage_server(
			local_file_path=str(orthomosaic_path),
			remote_file_path=remote_ortho_path,
			token=token,
			dataset_id=dataset_id,
		)

		# Verify orthomosaic exists on storage after push
		if check_file_exists_on_storage(remote_ortho_path, token):
			logger.info(
				f'Verified orthomosaic on storage: {remote_ortho_path}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
		else:
			logger.error(
				f'Orthomosaic missing on storage after push: {remote_ortho_path}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
			raise Exception('Orthomosaic verification failed after push to storage')

		# Step 8: Update status
		# Re-login to ensure we have a fresh token (ODM processing may take >1hr for large datasets)
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		update_status(dataset_id=dataset_id, is_odm_done=True, current_status=StatusEnum.idle, token=token)

		logger.info(
			f'ODM processing completed successfully for dataset {dataset_id}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		# Step 9: Cleanup temporary ODM directory
		if odm_host_temp_dir.exists():
			import shutil

			shutil.rmtree(odm_host_temp_dir)
			logger.info(
				f'Cleaned up temporary ODM directory: {odm_host_temp_dir}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)

	except Exception as e:
		logger.error(
			f'ODM processing failed for dataset {dataset_id}: {str(e)}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		# Cleanup temporary ODM directory on failure unless retention is enabled for this dataset.
		if 'odm_host_temp_dir' in locals() and odm_host_temp_dir.exists():
			if retain_failed_artifacts_enabled_for_dataset(dataset_id):
				logger.warning(
					f'Retaining temporary ODM directory after failure (DT_RETAIN_FAILED_ARTIFACTS enabled): {odm_host_temp_dir}',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)
			else:
				import shutil

				shutil.rmtree(odm_host_temp_dir)
				logger.info(
					f'Cleaned up temporary ODM directory after failure: {odm_host_temp_dir}',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)

		raise


def _analyze_extracted_files(extraction_dir: Path, token: str, dataset_id: int) -> tuple[dict, int, int]:
	"""
	Analyze extracted files to detect RTK data, count images, and calculate total size.

	Args:
		extraction_dir: Directory containing extracted images and RTK files
		token: Authentication token for logging
		dataset_id: Dataset ID for logging

	Returns:
		Tuple containing:
			rtk_metadata: Dictionary with RTK detection results
			image_count: Number of valid image files
			total_size_bytes: Total size of valid image files in bytes
	"""
	# Get list of all files in extraction directory
	extracted_files = []
	for file_path in extraction_dir.rglob('*'):
		if file_path.is_file():
			relative_path = file_path.relative_to(extraction_dir)
			extracted_files.append(str(relative_path))

	# Detect RTK files
	rtk_files = []
	rtk_file_types = {}
	for file_path in extracted_files:
		file_path_obj = Path(file_path)
		extension = file_path_obj.suffix.upper()

		if extension in RTK_EXTENSIONS:
			rtk_files.append(file_path)
			if extension not in rtk_file_types:
				rtk_file_types[extension] = []
			rtk_file_types[extension].append(file_path)

	# Count image files and calculate total size
	image_count = 0
	total_size_bytes = 0

	for file_path in extracted_files:
		if Path(file_path).suffix.lower() in RAW_IMAGE_EXTENSIONS:
			full_path = extraction_dir / file_path
			if full_path.exists():
				image_count += 1
				total_size_bytes += full_path.stat().st_size

	# Parse RTK timestamp data if available
	rtk_precision_cm = None
	rtk_quality_indicator = None
	if rtk_files:
		mrk_files = [f for f in extracted_files if f.upper().endswith('.MRK')]
		if mrk_files:
			mrk_path = extraction_dir / mrk_files[0]
			rtk_timestamp_data = _parse_rtk_timestamp_file(mrk_path, token, dataset_id)
			if rtk_timestamp_data.get('rtk_timestamp_available'):
				rtk_precision_cm = 2.0  # Typical RTK precision in cm
				rtk_quality_indicator = 5  # Quality indicator

	rtk_metadata = {
		'has_rtk_data': len(rtk_files) > 0,
		'rtk_file_count': len(rtk_files),
		'rtk_precision_cm': rtk_precision_cm,
		'rtk_quality_indicator': rtk_quality_indicator,
		'rtk_files': rtk_files,
		'rtk_file_types': rtk_file_types,
		'detected_extensions': list(rtk_file_types.keys()),
	}

	logger.info(
		f'Analysis complete: {len(rtk_files)} RTK files, {image_count} images, {total_size_bytes} bytes total',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	return rtk_metadata, image_count, total_size_bytes


def _parse_rtk_timestamp_file(mrk_path: Path, token: str, dataset_id: int) -> Dict[str, Any]:
	"""Parse RTK timestamp file for basic metadata"""
	if not mrk_path.exists():
		return {'rtk_timestamp_available': False}

	try:
		# Read first few lines to extract basic info
		with open(mrk_path, 'r', encoding='utf-8', errors='ignore') as f:
			lines = []
			for i, line in enumerate(f):
				if i >= 10:  # Only read first 10 lines for basic info
					break
				lines.append(line.strip())

		logger.info(
			f'Successfully parsed RTK timestamp file {mrk_path.name} with {len(lines)} lines',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		return {
			'rtk_timestamp_available': True,
			'mrk_file_path': str(mrk_path),
			'file_size_bytes': mrk_path.stat().st_size,
			'line_count_sample': len(lines),
			'records_count': len(lines),
			'has_content': len(lines) > 0,
			'first_line_preview': lines[0] if lines else None,
		}

	except Exception as e:
		logger.warning(
			f'Failed to parse RTK timestamp file {mrk_path.name}: {str(e)}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)
		return {
			'rtk_timestamp_available': False,
			'parse_error': str(e),
			'mrk_file_path': str(mrk_path),
			'records_count': 0,
		}


def _update_raw_images_metadata(
	dataset_id: int, rtk_metadata: dict, image_count: int, total_size_bytes: int, token: str
):
	"""
	Update the raw_images table with RTK metadata, image count, and total size.

	Args:
		dataset_id: Dataset ID to update
		rtk_metadata: Dictionary containing RTK detection results
		image_count: Number of valid image files
		total_size_bytes: Total size of valid image files in bytes
		token: Authentication token for database access
	"""
	# Convert bytes to MB for storage
	total_size_mb = max(1, total_size_bytes // (1024 * 1024))

	with use_client(token) as client:
		response = (
			client.table(settings.raw_images_table)
			.update(
				{
					'raw_image_count': image_count,
					'raw_image_size_mb': total_size_mb,
					'has_rtk_data': rtk_metadata.get('has_rtk_data', False),
					'rtk_precision_cm': rtk_metadata.get('rtk_precision_cm'),
					'rtk_quality_indicator': rtk_metadata.get('rtk_quality_indicator'),
					'rtk_file_count': rtk_metadata.get('rtk_file_count', 0),
				}
			)
			.eq('dataset_id', dataset_id)
			.execute()
		)

		if response.data:
			logger.info(
				f'Successfully updated raw_images metadata for dataset {dataset_id}: {image_count} images, {rtk_metadata.get("rtk_file_count", 0)} RTK files, {total_size_mb}MB total',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
		else:
			logger.error(
				f'Failed to update raw_images metadata for dataset {dataset_id} - no raw_images entry found',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)


def _extract_exif_from_images(extraction_dir: Path, token: str, dataset_id: int) -> dict:
	"""
	Extract EXIF metadata from the first valid image file with EXIF data.

	Args:
		extraction_dir: Directory containing extracted images
		token: Authentication token for logging
		dataset_id: Dataset ID for logging

	Returns:
		Dictionary containing comprehensive EXIF metadata, or empty dict if none found
	"""
	# Find image files in extraction directory (search recursively)
	image_extensions = ['.jpg', '.jpeg', '.tif', '.tiff', '.JPG', '.JPEG', '.TIF', '.TIFF']
	image_files = []

	for ext in image_extensions:
		found_files = list(extraction_dir.rglob(f'*{ext}'))
		# Filter out files in __MACOSX directories
		filtered_files = [f for f in found_files if '__MACOSX' not in str(f)]
		image_files.extend(filtered_files)

	if not image_files:
		logger.warning(
			f'No image files found in extraction directory: {extraction_dir}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)
		return {}

	logger.info(
		f'Found {len(image_files)} image files, extracting EXIF from first valid image',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	# Sample first 3 images to find representative EXIF data
	for image_file in image_files[:3]:
		try:
			exif_data = extract_comprehensive_exif(image_file)
			if exif_data:
				logger.info(
					f'Successfully extracted EXIF metadata from {image_file.name} with {len(exif_data)} fields',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)
				return exif_data
		except Exception as e:
			logger.warning(
				f'Failed to extract EXIF from {image_file.name}: {str(e)}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
			continue

	logger.warning(
		'No valid EXIF data found in any of the sampled image files',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)
	return {}


def _update_camera_metadata(dataset_id: int, exif_metadata: dict, token: str):
	"""
	Update the camera_metadata field in v2_raw_images table with EXIF data.

	Args:
		dataset_id: Dataset ID to update
		exif_metadata: Dictionary containing EXIF metadata
		token: Authentication token for database access
	"""
	with use_client(token) as client:
		response = (
			client.table(settings.raw_images_table)
			.update({'camera_metadata': exif_metadata})
			.eq('dataset_id', dataset_id)
			.execute()
		)

		if response.data:
			logger.info(
				f'Successfully updated camera_metadata for dataset {dataset_id} with {len(exif_metadata)} EXIF fields',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
		else:
			logger.error(
				f'Failed to update camera_metadata for dataset {dataset_id} - no raw_images entry found',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)


def _run_odm_pass(
	client, odm_command: list[str], volume_name: str, resource_labels: dict, dataset_id: int, token: str, pass_name: str
):
	"""Run one ODM container over the shared volume and wait for it.

	Returns ``(container, exit_status, stdout_logs)``. The container is left in
	place (remove=False) so a failure can be inspected and persisted as forensics.
	"""
	logger.info(
		f'Starting ODM {pass_name} pass on shared volume {volume_name}',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)
	odm_container = None
	stdout_logs = ''
	exit_status = 1
	try:
		# Hard cap ODM container RAM via cgroups so a runaway ODM stage
		# (texrecon / gdal ortho writeout) cannot exhaust host memory and
		# take the processor container down with it as OOM collateral.
		# Host has ~125 GB; processor is capped at 96 GB; leaving ODM
		# uncapped was causing global OOM events that killed the
		# processor mid-pipeline (see DT-263 / forensics for 8469, 8473,
		# 8503). 100 GB is generous for ODM while guaranteeing the
		# processor can always keep running. oom_score_adj biases the
		# kernel OOM killer toward the ODM container if memory pressure
		# still occurs, protecting the processor from collateral kills.
		odm_container = client.containers.run(
			image=settings.ODM_IMAGE,
			command=odm_command,
			volumes={volume_name: {'bind': '/odm_data', 'mode': 'rw'}},
			environment={
				'GDAL_CACHEMAX': '16384',
			},
			mem_limit='100g',
			memswap_limit='100g',
			oom_score_adj=500,
			remove=False,
			detach=True,
			name=f'dt-odm-pipeline-d{dataset_id}-{pass_name}-{int(time.time())}',
			labels={
				**resource_labels,
				'dt_role': 'odm_container',
				'dt_volume': volume_name,
			},
		)

		result = _wait_for_container(odm_container, f'ODM {pass_name} pass')
		exit_status = result.get('StatusCode', 1) if isinstance(result, dict) else 1

		log_bytes = odm_container.logs()
		stdout_logs = (
			log_bytes.decode('utf-8', errors='ignore') if isinstance(log_bytes, (bytes, bytearray)) else str(log_bytes)
		)
	except TimeoutError:
		raise
	except Exception as e:
		logger.error(
			f'ODM container execution failed unexpectedly: {e}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		# Best-effort log capture if container exists.
		if odm_container is not None:
			try:
				log_bytes = odm_container.logs()
				stdout_logs = (
					log_bytes.decode('utf-8', errors='ignore')
					if isinstance(log_bytes, (bytes, bytearray))
					else str(log_bytes)
				)
			except Exception:
				pass

	return odm_container, exit_status, stdout_logs


def _wait_for_container(container, what: str) -> dict:
	"""Wait for a container to exit, killing it once ODM_RUN_TIMEOUT_SECONDS has passed."""
	timeout = settings.ODM_RUN_TIMEOUT_SECONDS
	started = time.monotonic()
	try:
		return container.wait(timeout=timeout)
	except (requests.exceptions.ReadTimeout, requests.exceptions.ConnectionError) as wait_error:
		# docker-py reports an expired wait as a read timeout on the daemon socket;
		# an earlier socket error is a different failure and keeps its own message.
		if time.monotonic() - started < timeout:
			raise
		try:
			tail = container.logs(tail=40).decode('utf-8', errors='ignore')
		except Exception:
			tail = ''
		try:
			container.kill()
		except Exception:
			pass
		raise TimeoutError(
			f'{what} did not finish within {timeout // 3600} h and was stopped. Last output:\n{tail}'
		) from wait_error


def _run_odm_container(images_dir: Path, output_dir: Path, token: str, dataset_id: int) -> str:
	"""
	Execute ODM Docker container using shared named volumes for file sharing.
	This approach eliminates host path complexity and works identically in test and production.

	Args:
		images_dir: Directory containing extracted drone images
		output_dir: Directory for ODM output results
		token: Authentication token for logging
		dataset_id: Dataset ID for logging
	"""
	# Generous read timeout: creating/starting the ODM container can block past the
	# 60s docker default when the host disk is saturated after extracting the raw-image zip.
	client = docker.from_env(timeout=settings.DOCKER_CLIENT_TIMEOUT_SECONDS)
	volume_name = f'odm_processing_{dataset_id}'
	retain_on_failure = retain_failed_artifacts_enabled_for_dataset(dataset_id)
	resource_labels = dt_resource_labels(dataset_id=dataset_id, stage='odm', keep_eligible=retain_on_failure)
	odm_success = False
	reduced_resolution = None
	odm_container = None

	logger.info(
		f'Starting ODM processing with shared volume approach for dataset {dataset_id}',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	# Find all files recursively, excluding __MACOSX directories
	all_files = []
	for file_path in images_dir.rglob('*'):
		if file_path.is_file() and '__MACOSX' not in str(file_path):
			all_files.append(file_path)

	# Separate files by type
	image_files = []
	rtk_files = []
	other_files = []

	for file_path in all_files:
		ext = file_path.suffix.lower()
		if ext in RAW_IMAGE_EXTENSIONS:
			image_files.append(file_path)
		elif ext.upper() in RTK_EXTENSIONS:
			rtk_files.append(file_path)
		else:
			other_files.append(file_path)

	# Leave out paired DNGs, multispectral bands and GPS outliers; fail early on an oversized extent.
	selection = select_odm_images(image_files, settings.ODM_MAX_IMAGE_EXTENT_KM2)
	for reason, dropped in selection.dropped.items():
		sample = ', '.join(f.name for f in dropped[:5])
		logger.info(
			f'Left out {len(dropped)} {reason}: {sample}{" ..." if len(dropped) > 5 else ""}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)
	image_files = selection.kept

	logger.info(
		f'Found {len(image_files)} image files, {len(rtk_files)} RTK files, {len(other_files)} other files in {images_dir}',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	if len(image_files) == 0:
		# Log directory structure for debugging
		logger.error(
			f'No image files found. Directory contains: {[f.name for f in all_files[:20]]}{"..." if len(all_files) > 20 else ""}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)
		raise Exception(f'No supported images found in {images_dir}')

	# Filter out obviously corrupt images by size (but be less restrictive - 100KB minimum)
	valid_image_files = []
	for image_file in image_files:
		file_size = image_file.stat().st_size
		if file_size > 100 * 1024:  # At least 100KB (less restrictive than 1MB)
			valid_image_files.append(image_file)
		else:
			logger.warning(
				f'Skipping potentially corrupt image {image_file.name} (size: {file_size} bytes)',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)

	logger.info(
		f'Image-size validation kept {len(valid_image_files)} images and filtered out '
		f'{len(image_files) - len(valid_image_files)} potentially corrupt images',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	if not valid_image_files:
		raise Exception(
			f'All {len(image_files)} images are 100 KB or smaller and were skipped as potentially corrupt; '
			'nothing left for ODM'
		)

	# Oblique images are judged by their reconstructed orientation after pass 1
	# (_filter_reconstruction_by_orientation). Metadata only pre-filters where it is evidently
	# usable, because vendor tags can be wrong (e.g. GimbalPitchDegree=0 for nadir shots, DT-951).
	metadata_off_nadir = _metadata_off_nadir_degrees(valid_image_files)
	valid_image_files, metadata_dropped = _drop_metadata_obliques(
		valid_image_files, metadata_off_nadir, settings.ODM_MAX_NADIR_DEVIATION_DEGREES
	)
	if metadata_dropped:
		dropped_sample = ', '.join(
			f'{image_file.name} ({metadata_off_nadir[image_file.name]:.1f} deg)' for image_file in metadata_dropped[:10]
		)
		logger.info(
			f'Camera metadata marks {len(metadata_dropped)} images as more than '
			f'{settings.ODM_MAX_NADIR_DEVIATION_DEGREES:g} degrees off nadir and also recognizes nadir images; '
			f'leaving them out of ODM: {dropped_sample}{" ..." if len(metadata_dropped) > 10 else ""}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

	logger.info(
		f'Preparing to copy {len(valid_image_files)} images to the shared ODM volume',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	try:
		# Create shared volume for this processing session
		client.volumes.create(name=volume_name, labels=resource_labels)

		logger.info(
			f'Created shared volume {volume_name} for ODM processing',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		# Copy files to shared volume using the current approach
		copy_files_to_shared_volume(images_dir, valid_image_files, rtk_files, volume_name, dataset_id, token)

		project_name = f'dataset_{dataset_id}'
		_check_photos_for_odm(client, volume_name, project_name, resource_labels, dataset_id, token)

		# Environment-aware ODM configuration
		odm_command, resolution, env_mode = _build_odm_command()

		# Add common parameters
		odm_command.extend(
			[
				'--orthophoto-resolution',
				resolution,  # Environment-specific resolution (1cm production, 50cm test)
				'--skip-report',  # Skip PDF report generation (can hang on WeasyPrint font issues)
				'--project-path',
				'/odm_data',
				project_name,  # This is the PROJECTDIR argument
			]
		)

		logger.info(
			f'Starting ODM processing with command: {" ".join(odm_command)} (Resolution: {resolution}cm/pixel, {env_mode})',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		try:
			# Pass 1 stops right after OpenSfM has reconstructed the camera poses, so
			# oblique shots can be dropped from the reconstruction before anything is
			# undistorted, meshed or textured. Pass 2 resumes from the edited state.
			create_file_on_shared_volume(volume_name, f'{project_name}/{STOP_AFTER_RECONSTRUCTION_FLAG}', dataset_id)
			odm_container, exit_status, stdout_logs = _run_odm_pass(
				client, odm_command, volume_name, resource_labels, dataset_id, token, pass_name='reconstruction'
			)
			if exit_status == 0:
				odm_container.remove(force=True)
				odm_container = None
				# The stop flag is an ODM implementation detail (split-merge hook in run_opensfm.py).
				# If a future ODM ignores it, pass 1 runs to the end and filtering would silently do nothing.
				if path_exists_on_shared_volume(volume_name, f'{project_name}/{UNDISTORTED_DIR}', dataset_id):
					raise Exception(
						f'ODM did not stop after reconstruction ({STOP_AFTER_RECONSTRUCTION_FLAG} was ignored); '
						'the camera-orientation filter cannot run'
					)
				if _filter_reconstruction_by_orientation(
					volume_name, project_name, metadata_off_nadir, dataset_id, token
				):
					_prune_unobserved_points(client, volume_name, project_name, resource_labels, dataset_id, token)
				remove_file_from_shared_volume(
					volume_name, f'{project_name}/{STOP_AFTER_RECONSTRUCTION_FLAG}', dataset_id
				)
				odm_command, reduced_resolution = _with_budgeted_ortho_resolution(
					odm_command, volume_name, project_name, dataset_id, token
				)
				odm_container, exit_status, stdout_logs = _run_odm_pass(
					client, odm_command, volume_name, resource_labels, dataset_id, token, pass_name='orthophoto'
				)

			if exit_status == 0:
				odm_success = True
				logger.info(
					'ODM processing completed successfully',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)

				# Log output for debugging
				if stdout_logs:
					# Log last 1000 chars to avoid huge logs but still show completion status
					stdout_tail = stdout_logs[-1000:] if len(stdout_logs) > 1000 else stdout_logs
					logger.info(
						f'ODM stdout (tail): {stdout_tail}',
						LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
					)

				# Refresh token before extraction - ODM containers can run for hours and token may have expired
				token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
				logger.info(
					'Token refreshed before result extraction',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)

				# Copy results from shared volume to output directory
				copy_results_from_shared_volume(volume_name, output_dir, project_name, dataset_id, token)
				if reduced_resolution:
					_append_dataset_note(dataset_id, reduced_resolution, token)
				return token
			else:
				# ODM failed - log detailed error information
				logger.error(
					f'ODM container failed with exit code {exit_status}',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)

				if stdout_logs:
					# Log the last part of stdout which often contains error info
					stdout_tail = stdout_logs[-2000:] if len(stdout_logs) > 2000 else stdout_logs
					logger.error(
						f'ODM stdout (tail): {stdout_tail}',
						LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
					)

				# Persist forensics so we can debug even if the processor crashes later.
				if odm_container is not None:
					forensics = build_container_forensics(
						odm_container,
						dataset_id=dataset_id,
						stage='odm',
						command=odm_command,
						volume_name=volume_name,
					)
					write_debug_bundle(forensics=forensics, token=token, dataset_id=dataset_id, stage='odm')

					if retain_on_failure:
						logger.warning(
							f'Retaining failed ODM container/volume for debugging: container={getattr(odm_container, "name", None)} volume={volume_name}',
							LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
						)
					else:
						try:
							odm_container.remove(force=True)
						except Exception:
							pass

				# Check if images directory exists and has content for debugging
				if images_dir.exists():
					image_files = list(images_dir.glob('*.jpg')) + list(images_dir.glob('*.JPG'))
					logger.error(
						f'Images directory contains {len(image_files)} image files: {[f.name for f in image_files[:5]]}',
						LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
					)
				else:
					logger.error(
						f'Images directory {images_dir} does not exist!',
						LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
					)

				raise Exception(
					f'ODM processing failed with exit code {exit_status}. stdout: {stdout_logs[-2000:] if stdout_logs else "No stdout"}'
				)
		finally:
			# Always remove successful container to avoid leaks (failure retention is optional).
			if odm_container is not None and (odm_success or not retain_on_failure):
				try:
					odm_container.remove(force=True)
				except Exception:
					pass

	except Exception as e:
		logger.error(
			f'Failed to run ODM container: {str(e)}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)
		raise
	finally:
		# Clean up shared volume unless we intentionally retained failed artifacts.
		if odm_success or not retain_on_failure:
			try:
				cleanup_volume_and_references(volume_name, token, dataset_id)
			except Exception as volume_cleanup_error:
				logger.error(
					f'Failed to fully cleanup shared volume {volume_name}: {str(volume_cleanup_error)}',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)
		else:
			logger.warning(
				f'Retaining shared volume {volume_name} after ODM failure (DT_RETAIN_FAILED_ARTIFACTS enabled)',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)


def _find_orthomosaic(output_dir: Path, project_name: str, token: str, dataset_id: int) -> Optional[Path]:
	"""
	Find the generated orthomosaic file in ODM output directory.

	Args:
		output_dir: ODM output directory containing project directory
		project_name: Name of the ODM project directory

	Returns:
		Path to orthomosaic file or None if not found
	"""
	# ODM outputs orthomosaic in PROJECT/odm_orthophoto/odm_orthophoto.tif
	project_dir = output_dir / project_name

	# Debug: Log what's actually in the output directory
	logger.info(
		f'Looking for orthomosaic in: {project_dir}',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)
	if project_dir.exists():
		all_files = list(project_dir.rglob('*'))
		logger.info(
			f'Files in project directory: {[str(f.relative_to(project_dir)) for f in all_files[:20]]}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		# Look specifically in odm_orthophoto directory
		orthophoto_dir = project_dir / 'odm_orthophoto'
		if orthophoto_dir.exists():
			orthophoto_files = list(orthophoto_dir.iterdir())
			logger.info(
				f'Files in odm_orthophoto directory: {[f.name for f in orthophoto_files]}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
		else:
			logger.warning(
				f'odm_orthophoto directory does not exist in {project_dir}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
	else:
		logger.error(
			f'Project directory does not exist: {project_dir}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)
		return None

	orthophoto_patterns = [
		project_dir / 'odm_orthophoto' / 'odm_orthophoto.tif',
		project_dir / 'odm_orthophoto' / 'odm_orthophoto.original.tif',  # ODM often generates .original.tif
		project_dir / 'odm_orthophoto' / 'odm_orthophoto.png',
		# Fallback: look for any .tif file in project directory
	]

	for pattern in orthophoto_patterns:
		logger.debug(
			f'Checking pattern: {pattern}', LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id)
		)
		if pattern.exists():
			logger.info(
				f'Found orthomosaic at: {pattern}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
			return pattern

	# Fallback: search for any .tif files in the project directory
	for tif_file in project_dir.rglob('*.tif'):
		if 'orthophoto' in tif_file.name.lower():
			logger.info(
				f'Found orthomosaic via fallback search: {tif_file}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
			return tif_file

	logger.error(
		f'No orthomosaic found in {project_dir}',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)
	return None
