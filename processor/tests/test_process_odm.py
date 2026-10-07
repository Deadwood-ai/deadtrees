"""
Consolidated ODM processing tests covering complete functionality.

Tests ODM container execution, EXIF extraction, RTK detection, and orthomosaic generation
in a single comprehensive test suite, eliminating redundancy across multiple test files.

Fast unit tests (no Docker/SSH) cover analysis and EXIF extraction logic.
The slow integration test (marked @pytest.mark.slow) runs the full ODM pipeline.
"""

import json
import math
import os
import zipfile
import tempfile
import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, StatusEnum
from processor.src.process_odm import (
	process_odm,
	_analyze_extracted_files,
	_extract_exif_from_images,
	_build_odm_command,
	_filter_reconstruction_by_orientation,
	_metadata_off_nadir_degrees,
	_drop_metadata_obliques,
	RECONSTRUCTION_FILE,
	OPENSFM_RECONSTRUCT_REPORT,
)
from shared.exif_utils import extract_camera_nadir_deviation_degrees
from processor.src.utils.ssh import push_file_to_storage_server, check_file_exists_on_storage


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _extract_zip_to_tempdir(zip_path: Path) -> tempfile.TemporaryDirectory:
	"""Extract a ZIP to a fresh temp directory, return the TemporaryDirectory object."""
	tmp = tempfile.TemporaryDirectory()
	with zipfile.ZipFile(zip_path, 'r') as zf:
		zf.extractall(tmp.name)
	return tmp


def _find_test_zip(filename: str) -> Path | None:
	"""Find a test ZIP by checking known asset locations (base_path varies in containers)."""
	candidates = [
		Path(settings.base_path) / 'assets' / 'test_data' / 'raw_drone_images' / filename,
		Path('/app/assets/test_data/raw_drone_images') / filename,
		Path('./assets/test_data/raw_drone_images') / filename,
	]
	for p in candidates:
		if p.exists():
			return p
	return None


def _rtk_zip_path() -> Path | None:
	return _find_test_zip('test_minimal_5_images.zip')


def _no_rtk_zip_path() -> Path | None:
	return _find_test_zip('test_no_rtk_3_images.zip')


# ---------------------------------------------------------------------------
# Local fixture integration tests — no Docker, SSH, or DB, but require downloaded assets
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_analyze_extracted_files_detects_rtk_and_images():
	"""RTK files and 5 JPG images are correctly detected after local extraction."""
	zip_path = _rtk_zip_path()
	if zip_path is None:
		pytest.skip('test_minimal_5_images.zip not found; run make download-assets')

	with _extract_zip_to_tempdir(zip_path) as tmpdir:
		rtk_metadata, image_count, total_size_bytes = _analyze_extracted_files(Path(tmpdir), token='test', dataset_id=0)

	assert image_count == 5
	assert total_size_bytes > 0
	assert rtk_metadata['has_rtk_data'] is True
	assert rtk_metadata['rtk_file_count'] > 0
	assert len(rtk_metadata['detected_extensions']) > 0


@pytest.mark.integration
def test_analyze_extracted_files_no_rtk():
	"""A ZIP without RTK files reports has_rtk_data=False and correct image count."""
	zip_path = _no_rtk_zip_path()
	if zip_path is None:
		pytest.skip('test_no_rtk_3_images.zip not found; run make download-assets')

	with _extract_zip_to_tempdir(zip_path) as tmpdir:
		rtk_metadata, image_count, total_size_bytes = _analyze_extracted_files(Path(tmpdir), token='test', dataset_id=0)

	assert image_count >= 1
	assert total_size_bytes > 0
	assert rtk_metadata['has_rtk_data'] is False
	assert rtk_metadata['rtk_file_count'] == 0


@pytest.mark.integration
def test_extract_exif_from_real_drone_images():
	"""EXIF extraction returns camera make/model and GPS fields from real DJI images."""
	zip_path = _rtk_zip_path()
	if zip_path is None:
		pytest.skip('test_minimal_5_images.zip not found; run make download-assets')

	with _extract_zip_to_tempdir(zip_path) as tmpdir:
		exif_data = _extract_exif_from_images(Path(tmpdir), token='test', dataset_id=0)

	assert isinstance(exif_data, dict) and len(exif_data) > 0

	camera_fields = {'Make', 'Model', 'Software'}
	timing_fields = {'DateTime', 'DateTimeOriginal', 'DateTimeDigitized'}
	exposure_fields = {'ISOSpeedRatings', 'FNumber', 'FocalLength', 'ExposureTime'}

	categories_found = sum(
		[
			bool(camera_fields & exif_data.keys()),
			bool(timing_fields & exif_data.keys()),
			bool(exposure_fields & exif_data.keys()),
		]
	)
	assert categories_found >= 2, (
		f'Expected ≥2 EXIF categories, got {categories_found}. Keys: {list(exif_data.keys())[:10]}'
	)


@pytest.mark.unit
def test_build_odm_command_enables_auto_boundary(monkeypatch):
	"""Production ODM commands should include auto-boundary when enabled."""
	monkeypatch.setattr(settings, 'DEV_MODE', False)
	monkeypatch.setattr(settings, 'ODM_AUTO_BOUNDARY', True)
	monkeypatch.setattr(settings, 'ODM_SKY_REMOVAL', False)
	monkeypatch.setattr(settings, 'ODM_BG_REMOVAL', False)

	command, resolution, env_mode = _build_odm_command()

	assert '--auto-boundary' in command
	assert '--max-concurrency' in command
	assert command[command.index('--matcher-neighbors') + 1] == '0'
	assert resolution == '1.0'
	assert env_mode == 'Production quality'


@pytest.mark.unit
def test_build_odm_command_skips_auto_boundary_when_disabled(monkeypatch):
	"""Auto-boundary should remain opt-in via configuration."""
	monkeypatch.setattr(settings, 'DEV_MODE', False)
	monkeypatch.setattr(settings, 'ODM_AUTO_BOUNDARY', False)
	monkeypatch.setattr(settings, 'ODM_SKY_REMOVAL', False)
	monkeypatch.setattr(settings, 'ODM_BG_REMOVAL', False)

	command, _, _ = _build_odm_command()

	assert '--auto-boundary' not in command


@pytest.mark.unit
@pytest.mark.parametrize(
	('xmp', 'expected_orientation'),
	[
		(
			b'<rdf:Description drone-dji:GimbalPitchDegree="-90.00" />',
			(0.0, 'GimbalPitchDegree', -90.0),
		),
		(
			b'<drone-parrot:CameraPitchDegree>-82.0</drone-parrot:CameraPitchDegree>',
			(8.0, 'CameraPitchDegree', -82.0),
		),
		(b'<rdf:Description Camera:Pitch="+7.5" />', (7.5, 'Camera:Pitch', 7.5)),
		(
			b'<skydio:CameraOrientationNED>0.2, -84.0, 146.5</skydio:CameraOrientationNED>',
			(6.0, 'CameraOrientationNED', -84.0),
		),
	],
)
def test_extract_camera_nadir_deviation_supports_multiple_schemas(tmp_path, xmp, expected_orientation):
	"""Vendor and cross-vendor XMP conventions should normalize to off-nadir degrees."""
	image_path = tmp_path / 'drone.jpg'
	image_path.write_bytes(b'\xff\xd8' + xmp + b'\xff\xd9')

	assert extract_camera_nadir_deviation_degrees(image_path) == expected_orientation


@pytest.mark.unit
def test_extract_camera_nadir_deviation_ignores_vehicle_pitch(tmp_path):
	"""Aircraft attitude must not be mistaken for the camera viewing direction."""
	image_path = tmp_path / 'drone.jpg'
	image_path.write_bytes(b'<rdf:Description drone-dji:FlightPitchDegree="0.5" />')

	assert extract_camera_nadir_deviation_degrees(image_path) is None


@pytest.mark.unit
def test_extract_camera_nadir_deviation_scans_late_dng_xmp(tmp_path):
	"""Orientation XMP should be found even when a TIFF/DNG container stores it late."""
	image_path = tmp_path / 'drone.dng'
	image_path.write_bytes(
		b'II*\x00' + b'\x00' * (1024 * 1024) + b'<drone-parrot:CameraPitchDegree>-85.0</drone-parrot:CameraPitchDegree>'
	)

	assert extract_camera_nadir_deviation_degrees(image_path) == (5.0, 'CameraPitchDegree', -85.0)


def _write_image_with_pitch(path: Path, tag: str, pitch: str) -> Path:
	path.write_bytes(b'\xff\xd8<rdf:Description ' + tag.encode() + b'="' + pitch.encode() + b'" />\xff\xd9')
	return path


@pytest.mark.unit
def test_metadata_off_nadir_degrees_treats_zero_pitch_as_unknown(tmp_path):
	"""GimbalPitchDegree=0 is a placeholder on several DJI cameras (DT-951), not a horizontal camera."""
	paths = [
		_write_image_with_pitch(tmp_path / 'zero.jpg', 'GimbalPitchDegree', '+0.00'),
		_write_image_with_pitch(tmp_path / 'horizon.jpg', 'GimbalPitchDegree', '-9.80'),
		_write_image_with_pitch(tmp_path / 'nadir.jpg', 'GimbalPitchDegree', '-90.0'),
		_write_image_with_pitch(tmp_path / 'pix4d-nadir.jpg', 'Camera:Pitch', '0.0'),
	]
	unknown = tmp_path / 'unknown.jpg'
	unknown.write_bytes(b'\xff\xd8no pitch metadata\xff\xd9')

	angles = _metadata_off_nadir_degrees([*paths, unknown])

	assert angles == {
		'zero.jpg': None,
		'horizon.jpg': pytest.approx(80.2),
		'nadir.jpg': 0.0,
		'pix4d-nadir.jpg': 0.0,
		'unknown.jpg': None,
	}


@pytest.mark.unit
def test_drop_metadata_obliques_trusts_metadata_that_recognizes_nadir_images():
	paths = [Path(name) for name in ('nadir.jpg', 'nadir2.jpg', 'rounded.jpg', 'oblique.jpg', 'unknown.jpg')]
	angles = {'nadir.jpg': 0.0, 'nadir2.jpg': 1.0, 'rounded.jpg': 10.03, 'oblique.jpg': 45.0, 'unknown.jpg': None}

	kept, dropped = _drop_metadata_obliques(paths, angles, max_off_nadir=10.0)

	assert [p.name for p in kept] == ['nadir.jpg', 'nadir2.jpg', 'rounded.jpg', 'unknown.jpg']
	assert [p.name for p in dropped] == ['oblique.jpg']


@pytest.mark.unit
@pytest.mark.parametrize(
	'angles',
	[
		{'a.jpg': 80.2, 'b.jpg': 80.2},  # horizon timelapse: the reconstruction and its fallback decide
		{'a.jpg': None, 'b.jpg': None},  # placeholder or missing tags
		{'a.jpg': 25.0, 'b.jpg': None},
		{'a.jpg': 0.0, 'b.jpg': 25.0},  # a lone take-off frame does not make the tags trustworthy (8625)
	],
)
def test_drop_metadata_obliques_keeps_everything_without_a_recognized_nadir_image(angles):
	paths = [Path('a.jpg'), Path('b.jpg')]

	kept, dropped = _drop_metadata_obliques(paths, angles, max_off_nadir=10.0)

	assert kept == paths
	assert dropped == []


def _nadir_rotation(off_nadir_degrees: float) -> list[float]:
	"""Angle-axis rotation about x that tilts a down-looking OpenSfM camera by the given angle."""
	return [math.radians(180.0 - off_nadir_degrees), 0.0, 0.0]


def _area_reconstruction(angles: dict[str, float]) -> list[dict]:
	shots = {
		shot_id: {
			'rotation': _nadir_rotation(angle),
			'translation': [0.0, 0.0, 0.0],
			'camera': 'cam',
			'gps_position': [(index % 3) * 30.0, (index // 3) * 30.0, 100.0],
		}
		for index, (shot_id, angle) in enumerate(angles.items())
	}
	return [{'cameras': {'cam': {}}, 'shots': shots, 'points': {}}]


class _FakeVolume:
	"""In-memory stand-in for the shared ODM volume helpers."""

	def __init__(self, files: dict[str, bytes]):
		self.files = dict(files)

	def rewrite(self, volume_name, relative_path, transform, dataset_id):
		self.files[relative_path] = transform(self.files[relative_path])

	def read(self, volume_name, relative_path, dataset_id):
		return self.files.get(relative_path)


def _report(*partials: list[str]) -> bytes:
	return json.dumps(
		{
			'reconstructions': [
				{'bootstrap': {'image_pair': p[:2]}, 'grow': {'steps': [{'images': p[2:]}]}} for p in partials
			]
		}
	).encode()


@pytest.fixture
def fake_volume(monkeypatch):
	import processor.src.process_odm as process_odm_module

	def install(reconstruction: list[dict]) -> _FakeVolume:
		volume = _FakeVolume(
			{
				f'dataset_1/{RECONSTRUCTION_FILE}': json.dumps(reconstruction).encode(),
			}
		)
		monkeypatch.setattr(process_odm_module, 'rewrite_file_on_shared_volume', volume.rewrite)
		monkeypatch.setattr(process_odm_module, 'read_file_from_shared_volume', volume.read)
		monkeypatch.setattr(settings, 'ODM_MAX_NADIR_DEVIATION_DEGREES', 10.0)
		return volume

	return install


@pytest.mark.unit
def test_filter_reconstruction_by_orientation_drops_oblique_shots(fake_volume):
	volume = fake_volume(_area_reconstruction({'n1': 1.0, 'n2': 3.0, 'n3': 0.5, 'n4': 2.0, 'oblique': 30.0}))

	shots_dropped = _filter_reconstruction_by_orientation('odm_processing_1', 'dataset_1', {}, dataset_id=1, token='t')

	assert shots_dropped is True
	filtered = json.loads(volume.files[f'dataset_1/{RECONSTRUCTION_FILE}'])
	assert set(filtered[0]['shots']) == {'n1', 'n2', 'n3', 'n4'}


@pytest.mark.unit
def test_filter_reconstruction_by_orientation_keeps_zero_pitch_style_nadir_flight(fake_volume):
	"""The metadata-independent filter keeps nadir shots whatever their gimbal tags claim."""
	original = _area_reconstruction({f's{index}': 2.0 for index in range(6)})
	volume = fake_volume(original)

	assert _filter_reconstruction_by_orientation('odm_processing_1', 'dataset_1', {}, dataset_id=1, token='t') is False

	assert json.loads(volume.files[f'dataset_1/{RECONSTRUCTION_FILE}']) == original


@pytest.mark.unit
def test_filter_reconstruction_by_orientation_fails_clearly_for_all_oblique_imagery(fake_volume):
	volume = fake_volume(_area_reconstruction({f's{index}': 35.0 for index in range(6)}))

	with pytest.raises(
		Exception, match=r'No usable nadir images \(0 found\): 6 reconstructed images look more than 10 degrees'
	):
		_filter_reconstruction_by_orientation('odm_processing_1', 'dataset_1', {}, dataset_id=1, token='t')

	# Nothing is rewritten; the exception stops the pipeline before the orthophoto pass.
	assert json.loads(volume.files[f'dataset_1/{RECONSTRUCTION_FILE}'])[0]['shots'].keys() == {
		f's{i}' for i in range(6)
	}


@pytest.mark.unit
def test_filter_reconstruction_by_orientation_fails_when_only_unjudged_fragments_survive(fake_volume):
	"""A stray 2-image partial must not keep an otherwise oblique capture alive (seen on dataset 9515)."""
	angles = {f's{index}': 25.0 for index in range(6)}
	reconstruction = _area_reconstruction({**angles, 'frag_a': 0.0, 'frag_b': 10.0})
	volume = fake_volume(reconstruction)
	volume.files[f'dataset_1/{OPENSFM_RECONSTRUCT_REPORT}'] = _report(list(angles), ['frag_a', 'frag_b'])

	with pytest.raises(
		Exception, match=r'No usable nadir images \(0 found\): 6 reconstructed .* and 2 could not be judged'
	):
		_filter_reconstruction_by_orientation('odm_processing_1', 'dataset_1', {}, dataset_id=1, token='t')


@pytest.mark.unit
def test_filter_reconstruction_by_orientation_falls_back_to_metadata_for_a_line_flight(fake_volume):
	"""A horizon timelapse flown along a line (dataset 9671): no measurable vertical, metadata says 80 deg."""
	shots = {
		f'f{index}': {
			'rotation': _nadir_rotation(2.0),
			'translation': [0, 0, 0],
			'gps_position': [index * 10.0, 0.0, 100.0],
		}
		for index in range(5)
	}
	fake_volume([{'cameras': {}, 'shots': shots, 'points': {}}])

	with pytest.raises(Exception, match='camera metadata marks 5 more as oblique'):
		_filter_reconstruction_by_orientation(
			'odm_processing_1', 'dataset_1', {shot_id: 80.2 for shot_id in shots}, dataset_id=1, token='t'
		)


@pytest.mark.unit
def test_filter_reconstruction_by_orientation_fails_for_a_lone_nadir_frame_among_obliques(fake_volume):
	"""Dataset 8625: one take-off frame at nadir, 229 frames at 25 deg."""
	fake_volume(_area_reconstruction({'takeoff': 0.5, **{f's{index}': 25.0 for index in range(8)}}))

	with pytest.raises(Exception, match=r'No usable nadir images \(1 found\)'):
		_filter_reconstruction_by_orientation('odm_processing_1', 'dataset_1', {}, dataset_id=1, token='t')


@pytest.mark.unit
def test_filter_reconstruction_by_orientation_keeps_everything_when_nothing_can_be_judged(fake_volume):
	"""Two far-apart 2-image partials (dataset 9543) carry prior-aligned poses; leave them alone."""
	original = _area_reconstruction({'a1': 0.0, 'a2': 33.4, 'b1': 0.0, 'b2': 0.0})
	volume = fake_volume(original)
	volume.files[f'dataset_1/{OPENSFM_RECONSTRUCT_REPORT}'] = _report(['a1', 'a2'], ['b1', 'b2'])

	assert _filter_reconstruction_by_orientation('odm_processing_1', 'dataset_1', {}, dataset_id=1, token='t') is False

	assert json.loads(volume.files[f'dataset_1/{RECONSTRUCTION_FILE}']) == original


@pytest.fixture
def test_zip_file():
	"""Get path to test ZIP file for ODM processing.

	Resolution order:
	1) DEBUG_ODM_ZIP env var pointing to a local ZIP
	2) Any ZIP under assets/test_data/debugging/<id>/<id>.zip or assets/test_data/debugging/*.zip
	3) Default minimal dataset (5 images + RTK)
	"""
	# 1) Environment override
	env_path = os.getenv('DEBUG_ODM_ZIP')
	if env_path and Path(env_path).exists():
		return Path(env_path)

	# 2) Debugging folder
	debug_dir = Path(settings.base_path) / 'assets' / 'test_data' / 'debugging'
	debug_candidates = []
	if debug_dir.exists():
		debug_candidates.extend(debug_dir.glob('*/[0-9]*.zip'))
		debug_candidates.extend(debug_dir.glob('*.zip'))
	for cand in debug_candidates:
		if cand.exists():
			return cand

	# 3) Default minimal dataset
	possible_paths = [
		Path(settings.base_path) / 'assets' / 'test_data' / 'raw_drone_images' / 'test_minimal_5_images.zip',
		Path('/app/assets/test_data/raw_drone_images/test_minimal_5_images.zip'),
		Path('./assets/test_data/raw_drone_images/test_minimal_5_images.zip'),
	]
	for zip_path in possible_paths:
		if zip_path.exists():
			return zip_path

	pytest.skip(
		'No ODM test ZIP found. Set DEBUG_ODM_ZIP or place a ZIP under assets/test_data/debugging/, '
		'or run `make download-assets`.'
	)


@pytest.fixture
def zip_source_type(test_zip_file):
	"""Return 'debug' if the ZIP is from assets/test_data/debugging or via env override, else 'default'."""
	debug_dir = Path(settings.base_path) / 'assets' / 'test_data' / 'debugging'
	if str(test_zip_file).startswith(str(debug_dir)) or os.getenv('DEBUG_ODM_ZIP'):
		return 'debug'
	return 'default'


@pytest.fixture
def odm_test_dataset(auth_token, test_zip_file, test_processor_user):
	"""Create a test dataset for ODM processing with uploaded ZIP file"""
	dataset_id = None

	try:
		# Create test dataset in database (ZIP upload)
		with use_client(auth_token) as client:
			dataset_data = {
				'file_name': 'test_minimal_5_images.zip',
				'license': 'CC BY',
				'platform': 'drone',
				'authors': ['Test Author'],
				'user_id': test_processor_user,
				'data_access': 'public',
				'aquisition_year': 2024,
				'aquisition_month': 1,
				'aquisition_day': 1,
			}
			response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = response.data[0]['id']

			# Upload ZIP file to storage (simulating upload completion)
			zip_filename = f'{dataset_id}.zip'
			remote_zip_path = f'{settings.raw_images_path}/{zip_filename}'
			push_file_to_storage_server(str(test_zip_file), remote_zip_path, auth_token, dataset_id)

			# Create raw_images entry matching new upload flow (minimal info, updated during ODM processing)
			raw_images_data = {
				'dataset_id': dataset_id,
				'version': 1,
				'raw_image_count': 0,  # Placeholder - will be updated during ODM processing
				'raw_image_size_mb': int(test_zip_file.stat().st_size / 1024 / 1024),  # ZIP file size as placeholder
				'raw_images_path': remote_zip_path,
				'camera_metadata': {},  # Will be populated during ODM processing
				'has_rtk_data': False,  # Will be updated during ODM processing
				'rtk_precision_cm': None,  # Will be updated during ODM processing
				'rtk_quality_indicator': None,  # Will be updated during ODM processing
				'rtk_file_count': 0,  # Will be updated during ODM processing
			}
			client.table(settings.raw_images_table).insert(raw_images_data).execute()

			# Create status entry
			status_data = {
				'dataset_id': dataset_id,
				'current_status': StatusEnum.idle,
				'is_upload_done': True,
				'is_odm_done': False,  # ODM not yet processed
				'is_ortho_done': False,
				'is_cog_done': False,
				'is_thumbnail_done': False,
				'is_deadwood_done': False,
				'is_forest_cover_done': False,
				'is_metadata_done': False,
				'has_error': False,
			}
			client.table(settings.statuses_table).insert(status_data).execute()

			yield dataset_id

	finally:
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.raw_images_table).delete().eq('dataset_id', dataset_id).execute()


@pytest.fixture
def odm_task(odm_test_dataset, test_processor_user):
	"""Create a test task for ODM processing"""
	return QueueTask(
		id=1,
		dataset_id=odm_test_dataset,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.odm_processing],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)


@pytest.mark.slow
def test_complete_odm_processing_with_real_images(odm_task, auth_token, zip_source_type):
	"""
	Test complete ODM processing pipeline with real drone images.

	Covers:
	- ODM container execution with real 5-image dataset
	- EXIF metadata extraction and storage
	- RTK file detection and metadata updates
	- Orthomosaic generation and storage
	- Database status updates
	"""
	dataset_id = odm_task.dataset_id

	# Verify initial state (basic checks only)
	with use_client(auth_token) as client:
		initial_status = (
			client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute()
		).data[0]
		assert initial_status['is_upload_done'] is True

	# Execute ODM processing and capture outcome
	ran_ok = True
	try:
		process_odm(odm_task, Path(settings.processing_path))
	except Exception:
		ran_ok = False

	with use_client(auth_token) as client:
		final_status = (client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute()).data[
			0
		]

	if zip_source_type == 'debug':
		# Real-world debug datasets may fail; the stage raises and the orchestrator
		# (process_task) records the failure, so the stage leaves no error behind.
		assert ran_ok is False
		assert final_status['has_error'] is False
	else:
		# Default minimal dataset must succeed and produce expected updates
		assert ran_ok is True
		assert final_status['is_odm_done'] is True
		assert final_status['is_upload_done'] is True
		assert final_status['is_ortho_done'] is False  # Not yet processed by geotiff
		assert final_status['has_error'] is False

		# Verify orthomosaic was generated and stored
		remote_ortho_path = f'{settings.archive_path}/{dataset_id}_ortho.tif'
		ortho_exists = check_file_exists_on_storage(remote_ortho_path, auth_token)
		assert ortho_exists, f'Generated orthomosaic not found at {remote_ortho_path}'

		# Verify metadata updates
		with use_client(auth_token) as client:
			final_raw_images = (
				client.table(settings.raw_images_table).select('*').eq('dataset_id', dataset_id).execute()
			).data[0]

			camera_metadata = final_raw_images['camera_metadata']
			assert camera_metadata is not None and isinstance(camera_metadata, dict) and len(camera_metadata) > 0

			expected_field_categories = [
				['Make', 'Model', 'Software'],
				['ISOSpeedRatings', 'FNumber', 'FocalLength', 'ExposureTime'],
				['DateTime', 'DateTimeOriginal', 'DateTimeDigitized'],
			]
			fields_found = sum(
				1 for category in expected_field_categories if any(field in camera_metadata for field in category)
			)
			assert fields_found >= 2

			raw_image_count = final_raw_images['raw_image_count']
			raw_image_size_mb = final_raw_images['raw_image_size_mb']
			has_rtk_data = final_raw_images['has_rtk_data']
			rtk_file_count = final_raw_images['rtk_file_count']

			assert raw_image_count > 0 and raw_image_size_mb > 0
			assert isinstance(has_rtk_data, bool)
			assert isinstance(rtk_file_count, int)
			assert has_rtk_data is True and rtk_file_count > 0 and raw_image_count == 5


@pytest.mark.unit
def test_orthophoto_pass_gets_a_coarser_resolution_when_the_raster_would_not_fit(fake_volume, monkeypatch):
	from processor.src.process_odm import _with_budgeted_ortho_resolution

	fake_volume([{'points': {'a': {'coordinates': [0, 0, 0]}, 'b': {'coordinates': [2000, 3000, 0]}}}])
	monkeypatch.setattr(settings, 'ODM_MAX_ORTHO_PIXELS', 7e9)
	command = ['--fast-orthophoto', '--orthophoto-resolution', '1.0', '--project-path', '/odm_data', 'dataset_1']

	budgeted = _with_budgeted_ortho_resolution(command, 'odm_processing_1', 'dataset_1', dataset_id=1, token='t')

	assert budgeted == ['--fast-orthophoto', '--orthophoto-resolution', '3', '--project-path', '/odm_data', 'dataset_1']
	assert command[2] == '1.0'


@pytest.mark.unit
def test_orthophoto_pass_keeps_the_resolution_when_the_raster_fits(fake_volume, monkeypatch):
	from processor.src.process_odm import _with_budgeted_ortho_resolution

	fake_volume([{'points': {'a': {'coordinates': [0, 0, 0]}, 'b': {'coordinates': [500, 500, 0]}}}])
	monkeypatch.setattr(settings, 'ODM_MAX_ORTHO_PIXELS', 7e9)
	command = ['--orthophoto-resolution', '1.0', 'dataset_1']

	assert _with_budgeted_ortho_resolution(command, 'odm_processing_1', 'dataset_1', dataset_id=1, token='t') is command
