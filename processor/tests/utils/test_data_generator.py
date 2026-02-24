"""
Systematic test data generator for GeoTIFF standardization testing.
Creates controlled datasets with different characteristics to test edge cases.
"""

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.crs import CRS
from pathlib import Path
from typing import Dict, List, Optional, Union, Tuple
import pytest
from dataclasses import dataclass
from enum import Enum


class NoDataType(Enum):
	NONE = 'none'
	EXPLICIT_NUMERIC = 'explicit_numeric'
	NAN = 'nan'
	EDGE_DETECTED = 'edge_detected'
	MIXED = 'mixed'
	NEGATIVE_NUMERIC = 'negative_numeric'  # NEW: -32767, -10000 etc.


class ValueRangeType(Enum):
	FULL_UINT8 = 'full_uint8'  # 0-255
	COMPRESSED = 'compressed'  # 0-70 (like your real data)
	NEGATIVE = 'negative'  # -50 to 50
	EXTREME_FLOAT = 'extreme_float'  # Very large/small float values
	UNIFORM = 'uniform'  # Single value throughout
	ALREADY_SCALED = 'already_scaled'  # NEW: Already 0-255 range
	UINT16_RANGE = 'uint16_range'  # NEW: 0-65535 range


class BlockLayout(Enum):
	TILED = 'tiled'  # Block=256x256 or 512x512
	STRIP = 'strip'  # Block=width x small_height
	SINGLE_STRIP = 'single_strip'  # Block=width x 1


@dataclass
class TestDatasetConfig:
	"""Configuration for generating a test dataset"""

	name: str
	dtype: str  # 'uint8', 'uint16', 'float32', 'float64'
	bands: int  # 1, 3, or 4
	width: int = 512
	height: int = 512
	nodata_type: NoDataType = NoDataType.NONE
	value_range: ValueRangeType = ValueRangeType.FULL_UINT8
	nodata_percentage: float = 0.0  # 0.0 to 1.0
	crs: str = 'EPSG:4326'
	compress: Optional[str] = None
	block_layout: BlockLayout = BlockLayout.TILED
	has_alpha: bool = False  # NEW: Explicit alpha channel
	large_image: bool = False  # NEW: Create large image like your real data
	nodata_value: Optional[Union[float, int]] = None  # NEW: Custom nodata value

	# This is a helper config object, not a pytest test class.
	__test__ = False


class GeoTIFFTestDataGenerator:
	"""Generate synthetic GeoTIFF files for testing standardization functions"""

	def __init__(self, output_dir: Path):
		self.output_dir = Path(output_dir)
		self.output_dir.mkdir(parents=True, exist_ok=True)

	def generate_dataset(self, config: TestDatasetConfig) -> Path:
		"""Generate a single test dataset based on configuration"""
		output_path = self.output_dir / f'{config.name}.tif'

		# Adjust size for large images
		if config.large_image:
			config.width = 2000
			config.height = 2000

		# Create base data array
		data = self._create_base_data(config)

		# Apply nodata values
		data = self._apply_nodata(data, config)

		# Set up rasterio profile
		profile = self._create_profile(config)

		# Handle alpha channel if needed
		if config.has_alpha and config.bands >= 3:
			# Add alpha channel (start with full opacity)
			alpha = np.full((config.height, config.width), 255, dtype=data.dtype)
			if len(data.shape) == 3:
				data = np.concatenate([data, alpha[np.newaxis, :, :]], axis=0)
			else:
				data = np.stack([data, data, data, alpha])
			profile['count'] = data.shape[0]

		# Write the file
		with rasterio.open(output_path, 'w', **profile) as dst:
			if len(data.shape) == 3:
				for i in range(data.shape[0]):
					dst.write(data[i], i + 1)
			else:
				dst.write(data, 1)

		return output_path

	def _create_base_data(self, config: TestDatasetConfig) -> np.ndarray:
		"""Create base data array with specified characteristics"""
		# Set random seed for reproducible tests
		np.random.seed(42)

		shape = (config.bands, config.height, config.width) if config.bands > 1 else (config.height, config.width)

		if config.value_range == ValueRangeType.FULL_UINT8:
			data = np.random.randint(0, 256, shape, dtype='uint16').astype(config.dtype)
		elif config.value_range == ValueRangeType.COMPRESSED:
			# Like your compressed data (0-70)
			data = np.random.randint(0, 71, shape, dtype='uint16').astype(config.dtype)
		elif config.value_range == ValueRangeType.NEGATIVE:
			data = np.random.randint(-50, 51, shape).astype(config.dtype)
		elif config.value_range == ValueRangeType.EXTREME_FLOAT:
			data = np.random.uniform(-10000, 10000, shape).astype(config.dtype)
		elif config.value_range == ValueRangeType.UNIFORM:
			# Single value throughout
			fill_value = 128 if config.dtype.startswith('uint') else 50.0
			data = np.full(shape, fill_value, dtype=config.dtype)
		elif config.value_range == ValueRangeType.ALREADY_SCALED:
			# Already in 0-255 range
			data = np.random.randint(0, 256, shape, dtype='uint16').astype(config.dtype)
		elif config.value_range == ValueRangeType.UINT16_RANGE:
			# Full uint16 range
			data = np.random.randint(0, 65536, shape, dtype='uint32').astype(config.dtype)
		else:
			data = np.random.randint(0, 256, shape, dtype='uint16').astype(config.dtype)

		return data

	def _apply_nodata(self, data: np.ndarray, config: TestDatasetConfig) -> np.ndarray:
		"""Apply nodata values based on configuration"""
		if config.nodata_type == NoDataType.NONE:
			return data

		# Create mask for nodata areas (more predictable patterns for testing)
		mask = self._create_nodata_mask(data.shape, config.nodata_percentage)

		if config.nodata_type == NoDataType.EXPLICIT_NUMERIC:
			nodata_value = (
				config.nodata_value
				if config.nodata_value is not None
				else (0 if config.dtype.startswith('uint') else -9999)
			)
			data[mask] = nodata_value
		elif config.nodata_type == NoDataType.NEGATIVE_NUMERIC:
			# Like -32767, -10000 from your real data
			nodata_value = config.nodata_value if config.nodata_value is not None else -32767
			data[mask] = nodata_value
		elif config.nodata_type == NoDataType.NAN:
			if config.dtype.startswith('float'):
				data[mask] = np.nan
			else:
				# For integer types, convert to float temporarily
				data = data.astype('float32')
				data[mask] = np.nan
		elif config.nodata_type == NoDataType.EDGE_DETECTED:
			# Create nodata along edges (your edge detection scenario)
			if len(data.shape) == 3:  # Multi-band
				data[:, 0, :] = 0  # Top edge
				data[:, -1, :] = 0  # Bottom edge
				data[:, :, 0] = 0  # Left edge
				data[:, :, -1] = 0  # Right edge
			else:  # Single band
				data[0, :] = 0
				data[-1, :] = 0
				data[:, 0] = 0
				data[:, -1] = 0
		elif config.nodata_type == NoDataType.MIXED:
			# Mix of NaN and numeric nodata
			if config.dtype.startswith('float'):
				half_mask = mask.copy()
				half_mask[::2] = False
				data[half_mask] = np.nan
				data[mask & ~half_mask] = -9999

		return data

	def _create_nodata_mask(self, shape: Tuple[int, ...], percentage: float) -> np.ndarray:
		"""Create predictable mask for nodata areas (for reliable testing)"""
		if len(shape) == 3:  # Multi-band
			mask_shape = shape[1:]  # Height, width
		else:
			mask_shape = shape

		mask = np.zeros(mask_shape, dtype=bool)

		if percentage > 0:
			# Create predictable nodata patterns instead of completely random
			# This ensures tests can reliably expect transparency
			h, w = mask_shape

			if percentage >= 0.5:
				# For high percentages, create large contiguous areas
				# Top quarter and bottom quarter
				mask[: h // 4, :] = True
				mask[3 * h // 4 :, :] = True
			elif percentage >= 0.3:
				# For medium percentages, create some strips and blocks
				# Top strip and center block
				mask[: h // 8, :] = True
				center_h, center_w = h // 4, w // 4
				mask[center_h : center_h + h // 4, center_w : center_w + w // 4] = True
			elif percentage >= 0.1:
				# For lower percentages, create smaller blocks
				block_size = max(10, int(h * percentage * 0.5))
				mask[:block_size, :block_size] = True
				mask[-block_size:, -block_size:] = True
			else:
				# For very low percentages, create a small corner
				corner_size = max(5, int(h * percentage))
				mask[:corner_size, :corner_size] = True

		# Broadcast to all bands if needed
		if len(shape) == 3:
			mask = np.broadcast_to(mask, shape)

		return mask

	def _create_profile(self, config: TestDatasetConfig) -> Dict:
		"""Create rasterio profile for the dataset"""
		# Use different CRS based on config
		if 'utm32' in config.name.lower():
			bounds = (500000, 5300000, 501000, 5301000)  # UTM coordinates
		elif 'utm30' in config.name.lower():
			bounds = (672000, 4649000, 673000, 4650000)  # UTM30 coordinates
		else:
			bounds = (-1, -1, 1, 1)  # Simple geographic bounds

		transform = from_bounds(*bounds, config.width, config.height)

		# Set up block size based on layout
		blocksizes = None
		if config.block_layout == BlockLayout.TILED:
			blocksizes = [256, 256]
		elif config.block_layout == BlockLayout.STRIP:
			blocksizes = [config.width, 32]
		elif config.block_layout == BlockLayout.SINGLE_STRIP:
			blocksizes = [config.width, 1]

		profile = {
			'driver': 'GTiff',
			'dtype': config.dtype,
			'nodata': None,  # Will be set based on nodata_type
			'width': config.width,
			'height': config.height,
			'count': config.bands,
			'crs': CRS.from_string(config.crs),
			'transform': transform,
		}

		# Set nodata value in profile
		if config.nodata_type == NoDataType.EXPLICIT_NUMERIC:
			profile['nodata'] = (
				config.nodata_value
				if config.nodata_value is not None
				else (0 if config.dtype.startswith('uint') else -9999)
			)
		elif config.nodata_type == NoDataType.NEGATIVE_NUMERIC:
			profile['nodata'] = config.nodata_value if config.nodata_value is not None else -32767
		elif config.nodata_type == NoDataType.NAN:
			if config.dtype.startswith('float'):
				profile['nodata'] = np.nan

		# Add compression and block size if specified
		if config.compress:
			profile['compress'] = config.compress
		if blocksizes:
			profile['blockxsize'] = blocksizes[0]
			profile['blockysize'] = blocksizes[1]
			profile['tiled'] = config.block_layout == BlockLayout.TILED

		return profile


# Enhanced test configurations covering ALL edge cases from your real data
TEST_CONFIGURATIONS = [
	# Basic data types - no issues
	TestDatasetConfig(
		'uint8_rgb_clean', 'uint8', 3, nodata_type=NoDataType.NONE, value_range=ValueRangeType.FULL_UINT8
	),
	TestDatasetConfig(
		'uint16_rgb_clean', 'uint16', 3, nodata_type=NoDataType.NONE, value_range=ValueRangeType.UINT16_RANGE
	),
	TestDatasetConfig(
		'float32_rgb_clean', 'float32', 3, nodata_type=NoDataType.NONE, value_range=ValueRangeType.FULL_UINT8
	),
	# Your main problem cases
	TestDatasetConfig(
		'float32_nan_compressed',
		'float32',
		3,
		nodata_type=NoDataType.NAN,
		value_range=ValueRangeType.COMPRESSED,
		nodata_percentage=0.68,
	),  # Like 3885_ortho_black.tif
	# Cases from your real data - FIXED: Added nodata_percentage
	TestDatasetConfig(
		'float32_10bands_negative_nodata',
		'float32',
		10,  # Like 3798_ortho_blue.tif
		nodata_type=NoDataType.NEGATIVE_NUMERIC,
		nodata_value=-32767,
		nodata_percentage=0.4,  # ADDED: Ensure nodata pixels exist
		crs='EPSG:25832',
		compress='LZW',
	),
	TestDatasetConfig(
		'float32_3bands_nan_already_scaled',
		'float32',
		3,  # Like 3885_ortho_black.tif
		nodata_type=NoDataType.NAN,
		value_range=ValueRangeType.ALREADY_SCALED,
		nodata_percentage=0.3,  # ADDED: Ensure nodata pixels exist
		block_layout=BlockLayout.SINGLE_STRIP,
		large_image=True,
	),
	TestDatasetConfig(
		'uint16_8bands_with_alpha',
		'uint16',
		8,  # Like 3850_ortho.tif
		nodata_type=NoDataType.NONE,
		has_alpha=True,
		block_layout=BlockLayout.STRIP,
		large_image=True,
	),
	TestDatasetConfig(
		'uint8_corrupted_crs',
		'uint8',
		3,  # Like corrupted-crs.tif
		nodata_type=NoDataType.NONE,
		crs='EPSG:3857',
		large_image=True,
	),
	TestDatasetConfig(
		'uint16_4bands_rgba',
		'uint16',
		4,  # Like fva_offset_bug.tif
		nodata_type=NoDataType.NONE,
		value_range=ValueRangeType.UINT16_RANGE,
	),
	TestDatasetConfig(
		'float32_grayscale_large_negative_nodata',
		'float32',
		1,  # Like 3332_ortho.tif
		nodata_type=NoDataType.NEGATIVE_NUMERIC,
		nodata_value=-10000,
		nodata_percentage=0.3,  # ADDED: Ensure nodata pixels exist
		crs='EPSG:25830',
		compress='LZW',
	),
	TestDatasetConfig(
		'uint8_large_cog_format',
		'uint8',
		3,  # Like COG files
		nodata_type=NoDataType.NONE,
		large_image=True,
		crs='EPSG:7854',
		compress='DEFLATE',
		block_layout=BlockLayout.TILED,
	),
	# Edge detection scenarios
	TestDatasetConfig(
		'uint8_edge_nodata',
		'uint8',
		3,
		nodata_type=NoDataType.EDGE_DETECTED,
	),
	TestDatasetConfig(
		'float32_edge_nodata',
		'float32',
		3,
		nodata_type=NoDataType.EDGE_DETECTED,
	),
	# Mixed nodata types - FIXED: Increased percentage for reliable transparency
	TestDatasetConfig(
		'float32_mixed_nodata',
		'float32',
		3,
		nodata_type=NoDataType.MIXED,
		nodata_percentage=0.5,  # INCREASED: From 0.3 to 0.5 for reliable transparency
	),
	# Different value ranges
	TestDatasetConfig(
		'float32_extreme_values',
		'float32',
		3,
		value_range=ValueRangeType.EXTREME_FLOAT,
	),
	TestDatasetConfig(
		'float32_negative_values',
		'float32',
		3,
		value_range=ValueRangeType.NEGATIVE,
	),
	# Different layouts and compression
	TestDatasetConfig(
		'lzw_compressed_strip',
		'uint8',
		3,
		compress='LZW',
		block_layout=BlockLayout.STRIP,
	),
	TestDatasetConfig(
		'deflate_compressed_tiled',
		'uint8',
		3,
		compress='DEFLATE',
		block_layout=BlockLayout.TILED,
	),
	# Extreme edge cases
	TestDatasetConfig(
		'all_nodata',
		'float32',
		3,
		nodata_type=NoDataType.NAN,
		nodata_percentage=1.0,
	),
	TestDatasetConfig(
		'uniform_values',
		'uint8',
		3,
		value_range=ValueRangeType.UNIFORM,
	),
	# More band variations
	TestDatasetConfig(
		'grayscale_float32_nan',
		'float32',
		1,
		nodata_type=NoDataType.NAN,
		nodata_percentage=0.5,
	),
	TestDatasetConfig(
		'rgb_uint16_compressed',
		'uint16',
		3,
		value_range=ValueRangeType.COMPRESSED,
	),
	# Large image scenarios
	TestDatasetConfig(
		'large_float32_strip_layout',
		'float32',
		3,
		large_image=True,
		block_layout=BlockLayout.STRIP,
		nodata_type=NoDataType.NAN,
		nodata_percentage=0.4,
	),
]


@pytest.fixture
def test_data_generator(tmp_path):
	"""Fixture providing a test data generator"""
	return GeoTIFFTestDataGenerator(tmp_path / 'test_geotiffs')


def generate_all_test_datasets(output_dir: Path) -> List[Path]:
	"""Generate all predefined test datasets"""
	generator = GeoTIFFTestDataGenerator(output_dir)
	generated_files = []

	for config in TEST_CONFIGURATIONS:
		file_path = generator.generate_dataset(config)
		generated_files.append(file_path)
		print(f'Generated: {file_path}')

	return generated_files


if __name__ == '__main__':
	# Generate test datasets when run directly
	output_dir = Path(__file__).parent.parent.parent / 'assets' / 'synthetic_test_data'
	generate_all_test_datasets(output_dir)
