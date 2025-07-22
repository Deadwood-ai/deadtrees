import pytest
from datetime import datetime
from typing import Dict, Any

from shared.models import RawImages, TaskTypeEnum, StatusEnum, Status


class TestTaskTypeEnum:
	"""Test TaskTypeEnum includes ODM processing value"""

	def test_odm_processing_in_enum(self):
		"""Test that odm_processing is included in TaskTypeEnum"""
		assert TaskTypeEnum.odm_processing == 'odm_processing'
		assert 'odm_processing' in [task.value for task in TaskTypeEnum]

	def test_all_expected_task_types_present(self):
		"""Test that all expected task types are present"""
		expected_values = {'cog', 'thumbnail', 'deadwood', 'geotiff', 'metadata', 'odm_processing'}
		actual_values = {task.value for task in TaskTypeEnum}
		assert expected_values.issubset(actual_values)


class TestStatusEnum:
	"""Test StatusEnum includes ODM processing value"""

	def test_odm_processing_in_enum(self):
		"""Test that odm_processing is included in StatusEnum"""
		assert StatusEnum.odm_processing == 'odm_processing'
		assert 'odm_processing' in [status.value for status in StatusEnum]

	def test_all_expected_status_values_present(self):
		"""Test that core status values are present"""
		expected_values = {
			'idle',
			'uploading',
			'ortho_processing',
			'cog_processing',
			'metadata_processing',
			'odm_processing',
			'thumbnail_processing',
		}
		actual_values = {status.value for status in StatusEnum}
		assert expected_values.issubset(actual_values)


class TestStatusModel:
	"""Test Status model includes is_odm_done field"""

	def test_status_model_has_is_odm_done_field(self):
		"""Test that Status model includes is_odm_done field with correct default"""
		status = Status(dataset_id=1)
		assert hasattr(status, 'is_odm_done')
		assert status.is_odm_done is False
		assert isinstance(status.is_odm_done, bool)

	def test_status_model_is_odm_done_serialization(self):
		"""Test that is_odm_done field serializes correctly"""
		status = Status(dataset_id=1, is_odm_done=True)
		status_dict = status.model_dump()
		assert 'is_odm_done' in status_dict
		assert status_dict['is_odm_done'] is True

	def test_status_model_all_odm_flags(self):
		"""Test that Status model has all expected completion flags"""
		status = Status(dataset_id=1)
		expected_flags = [
			'is_upload_done',
			'is_ortho_done',
			'is_cog_done',
			'is_thumbnail_done',
			'is_deadwood_done',
			'is_forest_cover_done',
			'is_metadata_done',
			'is_odm_done',
		]
		for flag in expected_flags:
			assert hasattr(status, flag)
			assert isinstance(getattr(status, flag), bool)


class TestRawImagesModel:
	"""Test RawImages model validation and serialization"""

	def test_raw_images_model_basic_validation(self):
		"""Test RawImages model with minimal required fields"""
		raw_images = RawImages(
			dataset_id=1, raw_image_count=10, raw_image_size_mb=150, raw_images_path='raw_images/1/images/'
		)
		assert raw_images.dataset_id == 1
		assert raw_images.raw_image_count == 10
		assert raw_images.raw_image_size_mb == 150
		assert raw_images.raw_images_path == 'raw_images/1/images/'
		assert raw_images.has_rtk_data is False
		assert raw_images.rtk_file_count == 0
		assert raw_images.version == 1

	def test_raw_images_model_with_rtk_data(self):
		"""Test RawImages model with RTK data"""
		camera_metadata = {'camera_model': 'DJI Mavic 3', 'focal_length': 24}
		raw_images = RawImages(
			dataset_id=2,
			raw_image_count=25,
			raw_image_size_mb=300,
			raw_images_path='raw_images/2/images/',
			camera_metadata=camera_metadata,
			has_rtk_data=True,
			rtk_precision_cm=2.5,
			rtk_quality_indicator=8,
			rtk_file_count=3,
		)
		assert raw_images.has_rtk_data is True
		assert raw_images.rtk_precision_cm == 2.5
		assert raw_images.rtk_quality_indicator == 8
		assert raw_images.rtk_file_count == 3
		assert raw_images.camera_metadata == camera_metadata

	def test_raw_images_model_serialization(self):
		"""Test RawImages model serialization includes all fields"""
		raw_images = RawImages(
			dataset_id=3,
			raw_image_count=5,
			raw_image_size_mb=75,
			raw_images_path='raw_images/3/images/',
			has_rtk_data=True,
			rtk_precision_cm=1.2,
		)

		serialized = raw_images.model_dump()
		required_fields = [
			'dataset_id',
			'raw_image_count',
			'raw_image_size_mb',
			'raw_images_path',
			'camera_metadata',
			'has_rtk_data',
			'rtk_precision_cm',
			'rtk_quality_indicator',
			'rtk_file_count',
			'version',
			'created_at',
		]

		for field in required_fields:
			assert field in serialized

	def test_raw_images_model_datetime_serialization(self):
		"""Test RawImages model datetime serialization"""
		test_datetime = datetime(2024, 1, 15, 10, 30, 0)
		raw_images = RawImages(
			dataset_id=4,
			raw_image_count=8,
			raw_image_size_mb=120,
			raw_images_path='raw_images/4/images/',
			created_at=test_datetime,
		)

		serialized = raw_images.model_dump()
		assert serialized['created_at'] == test_datetime.isoformat()

	def test_raw_images_model_optional_fields(self):
		"""Test RawImages model handles optional fields correctly"""
		raw_images = RawImages(
			dataset_id=5, raw_image_count=12, raw_image_size_mb=200, raw_images_path='raw_images/5/images/'
		)

		# Test that optional fields have correct default values
		assert raw_images.camera_metadata is None
		assert raw_images.rtk_precision_cm is None
		assert raw_images.rtk_quality_indicator is None
		assert raw_images.created_at is None

		# Test that optional fields can be set
		raw_images.camera_metadata = {'test': 'data'}
		raw_images.rtk_precision_cm = 0.5
		assert raw_images.camera_metadata == {'test': 'data'}
		assert raw_images.rtk_precision_cm == 0.5
