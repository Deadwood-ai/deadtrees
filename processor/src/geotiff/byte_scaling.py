"""Choose how a high bit-depth ortho maps onto 8-bit display values.

Each display band is stretched linearly between its 2nd and 98th percentile,
measured on a decimated sample of the whole image. Some sources (for example
calibrated reflectance exports) store linear values without a display gamma;
after the linear stretch most of such an image is still near black. When the
median stretched brightness stays below ``DARK_MEDIAN``, one shared exponent is
applied to all bands so the median lands near ``TARGET_MEDIAN``, never stronger
than a standard 2.2 display gamma.
"""

from dataclasses import dataclass
import math

import numpy as np
import rasterio
from rasterio.enums import Resampling

SAMPLE_MAX_SIDE = 2048
LOW_PERCENTILE = 2
HIGH_PERCENTILE = 98
DARK_MEDIAN = 0.15
TARGET_MEDIAN = 0.25
MIN_EXPONENT = 1 / 2.2
# Constant bands have no usable range; map the uint16 range as before.
CONSTANT_BAND_RANGE = (0.0, 65535.0)


@dataclass(frozen=True)
class ByteScaling:
	band_ranges: tuple[tuple[float, float], ...]
	exponent: float = 1.0
	median_brightness: float | None = None

	@property
	def constant_bands(self) -> list[int]:
		return [index for index, (low, high) in enumerate(self.band_ranges, start=1) if low == high]

	def translate_args(self) -> list[str]:
		"""gdal_translate arguments that apply this scaling to bands 1..n."""
		args = []
		for index, (low, high) in enumerate(self.band_ranges, start=1):
			if low == high:
				low, high = CONSTANT_BAND_RANGE
			args.extend([f'-scale_{index}', str(low), str(high), '0', '255'])
			if self.exponent != 1.0:
				args.extend([f'-exponent_{index}', f'{self.exponent:.4f}'])
		return args


def compute_byte_scaling(
	src: rasterio.DatasetReader,
	band_count: int,
	alpha_band_index: int | None = None,
	excluded_values: tuple[float, ...] = (),
) -> ByteScaling:
	"""Measure the first ``band_count`` bands of ``src`` and choose their byte scaling.

	Pixels that are NaN, transparent in ``alpha_band_index`` or equal to one of
	``excluded_values`` (nodata) are ignored.
	"""
	scale = max(1, math.ceil(max(src.width, src.height) / SAMPLE_MAX_SIDE))
	out_shape = (max(1, src.height // scale), max(1, src.width // scale))
	indexes = list(range(1, band_count + 1))
	sample = src.read(indexes, out_shape=(band_count, *out_shape), resampling=Resampling.nearest).astype('float64')

	valid = ~np.isnan(sample)
	if alpha_band_index is not None:
		alpha = src.read(alpha_band_index, out_shape=out_shape, resampling=Resampling.nearest)
		valid &= alpha > 0
	for value in excluded_values:
		valid &= sample != value

	band_ranges = []
	for band, band_valid in zip(sample, valid):
		values = band[band_valid]
		if values.size:
			low, high = np.percentile(values, [LOW_PERCENTILE, HIGH_PERCENTILE])
			band_ranges.append((float(low), float(high)))
		else:
			band_ranges.append((0.0, 255.0))

	pixel_valid = valid.all(axis=0) & ~_undetected_fill(sample, valid)
	median = _median_stretched_brightness(sample, pixel_valid, band_ranges)
	return ByteScaling(tuple(band_ranges), _display_exponent(median), median)


def _undetected_fill(sample, valid):
	"""Pixels at the sample minimum in every band, such as a black collar that nodata detection missed.

	Left in, such a collar drags the median down and would brighten an image that is not linear.
	"""
	minima = [band[band_valid].min() if band_valid.any() else 0.0 for band, band_valid in zip(sample, valid)]
	return np.all([band == minimum for band, minimum in zip(sample, minima)], axis=0)


def _median_stretched_brightness(sample, pixel_valid, band_ranges) -> float | None:
	if not pixel_valid.any():
		return None
	stretched = [
		np.clip((band[pixel_valid] - low) / (high - low), 0.0, 1.0)
		for band, (low, high) in zip(sample, band_ranges)
		if high > low
	]
	if not stretched:
		return None
	return float(np.median(np.mean(stretched, axis=0)))


def _display_exponent(median: float | None) -> float:
	if median is None or median >= DARK_MEDIAN:
		return 1.0
	if median <= 0.0:
		return MIN_EXPONENT
	return max(MIN_EXPONENT, math.log(TARGET_MEDIAN) / math.log(median))
