from typing import Optional, List, Dict, Any
from enum import Enum
from datetime import datetime

from pydantic import BaseModel, field_serializer, field_validator, model_validator
from pydantic_geojson import MultiPolygonModel
from pydantic_partial import PartialModelMixin
from pydantic_settings import BaseSettings
from rasterio.coords import BoundingBox

from .settings import settings


class LabelDataEnum(str, Enum):
	deadwood = 'deadwood'
	forest_cover = 'forest_cover'


class PlatformEnum(str, Enum):
	drone = 'drone'
	airborne = 'airborne'
	satellite = 'satellite'


class LicenseEnum(str, Enum):
	cc_by = 'CC BY'
	cc_by_sa = 'CC BY-SA'
	cc_by_nc_sa = 'CC BY-NC-SA'
	mit = 'MIT'


class StatusEnum(str, Enum):
	idle = 'idle'
	uploading = 'uploading'
	ortho_processing = 'ortho_processing'
	cog_processing = 'cog_processing'
	metadata_processing = 'metadata_processing'
	thumbnail_processing = 'thumbnail_processing'
	deadwood_segmentation = 'deadwood_segmentation'
	forest_cover_segmentation = 'forest_cover_segmentation'
	audit_in_progress = 'audit_in_progress'


class DatasetAccessEnum(str, Enum):
	public = 'public'
	private = 'private'
	viewonly = 'viewonly'


class LabelSourceEnum(str, Enum):
	visual_interpretation = 'visual_interpretation'
	model_prediction = 'model_prediction'
	fixed_model_prediction = 'fixed_model_prediction'


class LabelTypeEnum(str, Enum):
	point_observation = 'point_observation'
	segmentation = 'segmentation'
	instance_segmentation = 'instance_segmentation'
	semantic_segmentation = 'semantic_segmentation'


class TaskTypeEnum(str, Enum):
	cog = 'cog'  # Generate cloud optimized geotiff
	thumbnail = 'thumbnail'  # Generate thumbnail image
	deadwood = 'deadwood'  # Run deadwood segmentation
	geotiff = 'geotiff'  # Convert to geotiff
	metadata = 'metadata'  # Extract metadata


class TaskPayload(BaseModel):
	id: Optional[int] = None
	dataset_id: int
	user_id: str
	priority: int = 2
	is_processing: bool = False
	created_at: Optional[datetime] = None
	task_types: List[TaskTypeEnum]


class QueueTask(BaseModel):
	id: int
	dataset_id: int
	user_id: str
	priority: int
	is_processing: bool
	current_position: int
	estimated_time: float | None = None
	task_types: List[TaskTypeEnum]


class Status(BaseModel):
	"""
	Tracks the processing status and completion states for a dataset
	"""

	id: Optional[int] = None
	dataset_id: int
	current_status: StatusEnum = StatusEnum.idle
	is_upload_done: bool = False
	is_ortho_done: bool = False
	is_cog_done: bool = False
	is_thumbnail_done: bool = False
	is_deadwood_done: bool = False
	is_forest_cover_done: bool = False
	is_metadata_done: bool = False
	is_audited: bool = False
	has_error: bool = False
	error_message: Optional[str] = None
	created_at: Optional[datetime] = None
	updated_at: Optional[datetime] = None

	@field_serializer('created_at', 'updated_at', mode='plain')
	def datetime_to_isoformat(field: datetime | None) -> str | None:
		if field is None:
			return None
		return field.isoformat()


class Thumbnail(BaseModel):
	dataset_id: int
	thumbnail_path: str
	thumbnail_file_name: str
	thumbnail_file_size: int
	version: int
	thumbnail_processing_runtime: float


class Dataset(PartialModelMixin, BaseModel):
	"""
	V2Dataset combines the previous Dataset and Metadata models into a single model
	with only user-provided information that doesn't change after creation.
	"""

	id: Optional[int] = None
	user_id: str
	created_at: Optional[datetime] = None
	file_name: str
	license: LicenseEnum
	platform: PlatformEnum
	project_id: Optional[str] = None
	authors: List[str]
	aquisition_year: Optional[int] = None
	aquisition_month: Optional[int] = None
	aquisition_day: Optional[int] = None
	additional_information: Optional[str] = None
	data_access: DatasetAccessEnum = DatasetAccessEnum.public
	citation_doi: Optional[str] = None

	@field_serializer('created_at', mode='plain')
	def datetime_to_isoformat(field: datetime | None) -> str | None:
		if field is None:
			return None
		return field.isoformat()

	@field_validator('aquisition_year')
	@classmethod
	def validate_year(cls, v: Optional[int]) -> Optional[int]:
		if v is not None and (v < 1980 or v > 2099):
			raise ValueError('Year must be between 1980 and 2099')
		return v

	@field_validator('aquisition_month')
	@classmethod
	def validate_month(cls, v: Optional[int]) -> Optional[int]:
		if v is not None and (v < 1 or v > 12):
			raise ValueError('Month must be between 1 and 12')
		return v

	@field_validator('aquisition_day')
	@classmethod
	def validate_day(cls, v: Optional[int]) -> Optional[int]:
		if v is not None and (v < 1 or v > 31):
			raise ValueError('Day must be between 1 and 31')
		return v


class Cog(BaseModel):
	"""
	Represents the cloud optimized geotiff processing results
	"""

	dataset_id: int
	cog_file_size: int
	cog_file_name: str
	cog_path: str
	version: int
	created_at: Optional[datetime] = None
	cog_info: Optional[Dict] = None
	cog_processing_runtime: Optional[float] = None

	@field_serializer('created_at', mode='plain')
	def datetime_to_isoformat(field: datetime | None) -> str | None:
		if field is None:
			return None
		return field.isoformat()


class Ortho(BaseModel):
	"""
	Represents the orthophoto processing results
	"""

	dataset_id: int
	ortho_file_name: str
	version: int
	created_at: Optional[datetime] = None
	file_size: int
	bbox: Optional[BoundingBox] = None
	sha256: Optional[str] = None
	ortho_info: Optional[Dict] = None
	ortho_upload_runtime: Optional[float] = None
	ortho_processed: bool = False
	ortho_processing_runtime: Optional[float] = None

	@field_serializer('created_at', mode='plain')
	def datetime_to_isoformat(field: datetime | None) -> str | None:
		if field is None:
			return None
		return field.isoformat()

	@field_validator('bbox', mode='before')
	@classmethod
	def transform_bbox(cls, raw_string: Optional[str | BoundingBox]) -> Optional[BoundingBox]:
		if raw_string is None:
			return None
		if isinstance(raw_string, str):
			s = raw_string.replace('BOX(', '').replace(')', '')
			ll, ur = s.split(',')
			left, bottom = ll.strip().split(' ')
			right, top = ur.strip().split(' ')
			return BoundingBox(
				left=float(left),
				bottom=float(bottom),
				right=float(right),
				top=float(top),
			)
		return raw_string

	@field_serializer('bbox', mode='plain')
	def bbox_to_postgis(self, bbox: Optional[BoundingBox]) -> Optional[str]:
		if bbox is None:
			return None
		return f'BOX({bbox.left} {bbox.bottom},{bbox.right} {bbox.top})'


class LabelPayloadData(PartialModelMixin, BaseModel):
	"""
	The LabelPayloadData class is the base class for the payload of the label.
	This is the user provided data, before the Labels are validated and saved to
	the database.
	"""

	# AOI related fields
	aoi_geometry: Optional[MultiPolygonModel] = None
	aoi_is_whole_image: bool = False
	aoi_image_quality: Optional[int] = None
	aoi_notes: Optional[str] = None

	# Label related fields
	dataset_id: int
	label_source: LabelSourceEnum
	label_type: LabelTypeEnum
	label_data: LabelDataEnum
	label_quality: Optional[int] = None
	model_config: Optional[Dict[str, Any]] = None

	# Label geometry
	geometry: MultiPolygonModel
	properties: Optional[Dict[str, Any]] = None

	@field_validator('aoi_image_quality', 'label_quality')
	def validate_quality(cls, v):
		if v is not None and not 1 <= v <= 3:
			raise ValueError('Quality must be between 1 and 3')
		return v


PartialLabelPayloadData = LabelPayloadData.model_as_partial()


class UserLabelObject(BaseModel):
	dataset_id: int
	user_id: str
	file_type: str
	file_alias: str
	file_path: str
	label_description: str
	audited: bool


class LabelDataEnum(str, Enum):
	deadwood = 'deadwood'
	forest_cover = 'forest_cover'


class AOI(BaseModel):
	"""Area of Interest model for v2_aois table"""

	id: Optional[int] = None
	dataset_id: int
	user_id: str
	geometry: MultiPolygonModel
	is_whole_image: bool = False
	image_quality: Optional[int] = None
	notes: Optional[str] = None
	created_at: Optional[datetime] = None
	updated_at: Optional[datetime] = None

	@field_validator('image_quality')
	def validate_image_quality(cls, v):
		if v is not None and not 1 <= v <= 3:
			raise ValueError('Image quality must be between 1 and 3')
		return v


class Label(BaseModel):
	"""Label model for v2_labels table"""

	id: Optional[int] = None
	dataset_id: int
	aoi_id: Optional[int] = None
	user_id: str
	label_source: LabelSourceEnum
	label_type: LabelTypeEnum
	label_data: LabelDataEnum
	label_quality: Optional[int] = None
	# model_config: Optional[Dict[str, Any]] = None
	created_at: Optional[datetime] = None
	updated_at: Optional[datetime] = None

	@field_validator('label_quality')
	def validate_label_quality(cls, v):
		if v is not None and not 1 <= v <= 3:
			raise ValueError('Label quality must be between 1 and 3')
		return v


class LabelGeometry(BaseModel):
	"""Label geometry model for v2_label_geometries table"""

	id: Optional[int] = None
	label_id: int
	geometry: MultiPolygonModel
	properties: Optional[Dict[str, Any]] = None
	created_at: Optional[datetime] = None

	@field_serializer('created_at', mode='plain')
	def datetime_to_isoformat(field: datetime | None) -> str | None:
		if field is None:
			return None
		return field.isoformat()


# class MetadataPayloadData(PartialModelMixin, BaseModel):
# 	# now the metadata
# 	name: Optional[str] = None
# 	license: Optional[LicenseEnum] = None
# 	data_access: Optional[DatasetAccessEnum] = None
# 	platform: Optional[PlatformEnum] = None
# 	project_id: Optional[str] = None
# 	authors: Optional[str] = None
# 	spectral_properties: Optional[str] = None
# 	citation_doi: Optional[str] = None
# 	additional_information: Optional[str] = None

# 	# OSM admin levels
# 	admin_level_1: Optional[str] = None
# 	admin_level_2: Optional[str] = None
# 	admin_level_3: Optional[str] = None

# 	aquisition_year: Optional[int] = None
# 	aquisition_month: Optional[int] = None
# 	aquisition_day: Optional[int] = None


# class Metadata(MetadataPayloadData):
# 	"""
# 	Class for additional Metadata in the database. It has to be connected to a Dataset object
# 	using a 1:1 cardinality.
# 	This is separated, so that different RLS policies can apply. Additionally, this is the
# 	metadata that can potentially be
# 	"""

# 	# primary key
# 	dataset_id: int

# 	# link to a user
# 	user_id: str

# 	# make some field non-optional
# 	name: str
# 	data_access: DatasetAccessEnum
# 	# license: LicenseEnum
# 	platform: PlatformEnum
# 	# only the aquisition_year is necessary
# 	aquisition_year: int

# 	@classmethod
# 	def by_id(cls, dataset_id: int, token: str | None = None) -> 'Metadata':
# 		# instatiate a reader
# 		reader = SupabaseReader(Model=cls, table=settings.metadata_table, token=token)

# 		return reader.by_id(dataset_id)


# class ProcessOptions(BaseSettings):
# overviews: Optional[int] = 8
# resolution: Optional[float] = 0.04
# profile: Optional[str] = 'jpeg'
# quality: Optional[int] = 75
# force_recreate: Optional[bool] = False
# tiling_scheme: Optional[str] = 'web-optimized'


# @model_validator(mode='before')
# def convert_task_type_to_types(cls, values):
# 	"""Convert old task_type to task_types if necessary"""
# 	if isinstance(values, dict):
# 		if 'task_type' in values and 'task_types' not in values:
# 			values['task_types'] = [values['task_type']] if values['task_type'] else []
# 		elif 'task_types' not in values:
# 			values['task_types'] = []
# 	return values


class MetadataType(str, Enum):
	GADM = 'gadm'
	# Add more types as needed


class AdminBoundariesMetadata(BaseModel):
	"""Structure for GADM administrative boundaries metadata"""

	admin_level_1: Optional[str] = None  # Country
	admin_level_2: Optional[str] = None  # State/Province
	admin_level_3: Optional[str] = None  # District
	source: str = 'GADM'
	version: str = '4.1.0'  # GADM version


class DatasetMetadata(BaseModel):
	"""Model for the v2_metadata table"""

	dataset_id: int
	metadata: Dict[str, Any]  # Each key is a MetadataType
	version: int
	created_at: Optional[datetime] = None
	processing_runtime: Optional[float] = None

	@field_serializer('created_at', mode='plain')
	def datetime_to_isoformat(field: datetime | None) -> str | None:
		if field is None:
			return None
		return field.isoformat()
