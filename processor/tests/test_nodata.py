"""Tests for bulletproof nodata resolution (processor.src.utils.nodata).

Two layers:

* Deterministic unit tests of ``resolve_nodata_policy`` / ``_detect_mask_band`` /
  ``read_nodata_mask`` using duck-typed fakes, so every ortho nodata convention
  is covered without fighting GDAL's raster-creation quirks (a written 4-band
  Byte GTiff is silently coerced to have an alpha band).
* End-to-end tests through the real ``image_reprojector`` + ``read_nodata_mask``
  for the conventions GDAL lets us author on disk (alpha band, declared nodata,
  internal mask, un-tagged solid-white fill, and clean imagery).
"""

import numpy as np
import pytest
import rasterio
import rasterio.enums as CI
from rasterio.transform import from_origin

from processor.src.utils.nodata import (
	NodataPolicy,
	_detect_mask_band,
	read_nodata_mask,
	resolve_nodata_policy,
)
from processor.src.utils.segmentation import image_reprojector

pytestmark = pytest.mark.unit

ALL_VALID = [CI.MaskFlags.all_valid]
NODATA_FLAGS = [CI.MaskFlags.nodata]
MASK_FLAGS = [CI.MaskFlags.per_dataset]
ALPHA_FLAGS = [CI.MaskFlags.per_dataset, CI.MaskFlags.alpha]


class FakeSrc:
	"""Minimal stand-in for a rasterio dataset for the resolver/detector."""

	def __init__(self, bands, colorinterp, mask_flag_enums=None, nodata=None):
		self._bands = np.asarray(bands, dtype=np.uint8)
		self.count = self._bands.shape[0]
		self.height = self._bands.shape[1]
		self.width = self._bands.shape[2]
		self.colorinterp = tuple(colorinterp)
		self.nodata = nodata
		self.mask_flag_enums = mask_flag_enums or [list(ALL_VALID) for _ in range(self.count)]

	def read(self, band, out_shape=None):
		arr = self._bands[band - 1]
		if out_shape and tuple(out_shape) != arr.shape:
			h, w = out_shape
			ys = np.linspace(0, arr.shape[0] - 1, h).astype(int)
			xs = np.linspace(0, arr.shape[1] - 1, w).astype(int)
			return arr[np.ix_(ys, xs)]
		return arr


def _rgb(value=120, shape=(4, 4)):
	return np.full((3, *shape), value, dtype=np.uint8)


# --------------------------------------------------------------------------- #
# resolve_nodata_policy: one branch per real-world ortho convention
# --------------------------------------------------------------------------- #


def test_policy_real_alpha_band_defers_to_read_masks():
	bands = np.concatenate([_rgb(), np.full((1, 4, 4), 255, np.uint8)])
	src = FakeSrc(bands, [CI.ColorInterp.red, CI.ColorInterp.green, CI.ColorInterp.blue, CI.ColorInterp.alpha], ALPHA_FLAGS)
	assert resolve_nodata_policy(src) == NodataPolicy()


def test_policy_internal_mask_defers_to_read_masks():
	src = FakeSrc(_rgb(), [CI.ColorInterp.red, CI.ColorInterp.green, CI.ColorInterp.blue], [list(MASK_FLAGS)] * 3)
	assert resolve_nodata_policy(src) == NodataPolicy()


@pytest.mark.parametrize('nodata', [0.0, 255.0, float('nan'), 65535.0])
def test_policy_declared_nodata_defers_to_read_masks(nodata):
	src = FakeSrc(_rgb(), [CI.ColorInterp.red, CI.ColorInterp.green, CI.ColorInterp.blue], [list(NODATA_FLAGS)] * 3, nodata=nodata)
	assert resolve_nodata_policy(src) == NodataPolicy()


def test_policy_recovers_mislabeled_binary_mask_band():
	# The dataset-3789 shape: RGB + a 4th band that is really a 0/255 alpha but
	# tagged 'undefined', with no other masking metadata.
	band4 = np.full((1, 4, 4), 255, np.uint8)
	band4[0, :, :2] = 0
	bands = np.concatenate([_rgb(255), band4])  # RGB is solid white in the masked area
	src = FakeSrc(bands, [CI.ColorInterp.red, CI.ColorInterp.green, CI.ColorInterp.blue, CI.ColorInterp.undefined])
	assert resolve_nodata_policy(src) == NodataPolicy(mask_band=4)


def test_policy_ignores_continuous_extra_band_and_falls_back():
	# A 4-band RGB+NIR image: the 4th band is continuous data, not a mask, so it
	# must NOT be treated as alpha. With no other metadata we fall back to fill.
	nir = np.arange(16, dtype=np.uint8).reshape(1, 4, 4)
	bands = np.concatenate([_rgb(), nir])
	src = FakeSrc(bands, [CI.ColorInterp.red, CI.ColorInterp.green, CI.ColorInterp.blue, CI.ColorInterp.undefined])
	assert resolve_nodata_policy(src) == NodataPolicy(treat_white_fill=True, treat_black_fill=True)


def test_policy_no_metadata_uses_solid_fill_fallback():
	src = FakeSrc(_rgb(), [CI.ColorInterp.red, CI.ColorInterp.green, CI.ColorInterp.blue])
	assert resolve_nodata_policy(src) == NodataPolicy(treat_white_fill=True, treat_black_fill=True)


# --------------------------------------------------------------------------- #
# _detect_mask_band edge cases
# --------------------------------------------------------------------------- #


def test_detect_mask_band_requires_four_bands():
	band3 = np.full((1, 4, 4), 255, np.uint8)
	band3[0, :, :2] = 0
	src = FakeSrc(np.concatenate([_rgb()[:2], band3]), [CI.ColorInterp.red, CI.ColorInterp.green, CI.ColorInterp.undefined])
	assert _detect_mask_band(src) is None


def test_detect_mask_band_skips_color_last_band():
	band4 = np.full((1, 4, 4), 255, np.uint8)
	band4[0, :, :2] = 0
	src = FakeSrc(np.concatenate([_rgb(), band4]), [CI.ColorInterp.undefined, CI.ColorInterp.green, CI.ColorInterp.blue, CI.ColorInterp.red])
	assert _detect_mask_band(src) is None


def test_detect_mask_band_skips_band_without_zeros():
	# All-opaque (all 255) 4th band masks nothing → not a useful mask band.
	band4 = np.full((1, 4, 4), 255, np.uint8)
	src = FakeSrc(np.concatenate([_rgb(), band4]), [CI.ColorInterp.red, CI.ColorInterp.green, CI.ColorInterp.blue, CI.ColorInterp.undefined])
	assert _detect_mask_band(src) is None


def test_detect_mask_band_skips_non_binary_band():
	band4 = (np.arange(16, dtype=np.uint8).reshape(1, 4, 4) * 8)  # spread of values
	src = FakeSrc(np.concatenate([_rgb(), band4]), [CI.ColorInterp.red, CI.ColorInterp.green, CI.ColorInterp.blue, CI.ColorInterp.undefined])
	assert _detect_mask_band(src) is None


# --------------------------------------------------------------------------- #
# read_nodata_mask: combination logic
# --------------------------------------------------------------------------- #


class FakeVRT:
	"""Stand-in for an image_reprojector WarpedVRT for read_nodata_mask."""

	def __init__(self, rgb, declared_nodata, policy, extra_band=None):
		self._rgb = np.asarray(rgb, dtype=np.uint8)
		self._declared = np.asarray(declared_nodata, dtype=bool)
		# Stored as a 2D band, matching rasterio's read(band_index) shape.
		self._extra = None if extra_band is None else np.asarray(extra_band, dtype=np.uint8).reshape(self._rgb.shape[1:])
		self.count = self._rgb.shape[0] + (0 if self._extra is None else 1)
		self.nodata_policy = policy

	def read_masks(self, band, window=None):
		return np.where(self._declared, 0, 255).astype(np.uint8)

	def read(self, indexes=None, window=None):
		if isinstance(indexes, int):
			return self._extra if indexes == self.count and self._extra is not None else self._rgb[indexes - 1]
		return self._rgb[[i - 1 for i in indexes]]


def test_read_mask_declared_only():
	declared = np.array([[True, False], [False, True]])
	vrt = FakeVRT(_rgb(120, (2, 2)), declared, NodataPolicy())
	np.testing.assert_array_equal(read_nodata_mask(vrt), declared)


def test_read_mask_unions_declared_and_mask_band():
	declared = np.array([[True, False], [False, False]])
	extra = np.array([[[255, 255], [0, 255]]], dtype=np.uint8)  # (1,2,2): bottom-left is nodata
	vrt = FakeVRT(_rgb(120, (2, 2)), declared, NodataPolicy(mask_band=4), extra_band=extra)
	np.testing.assert_array_equal(read_nodata_mask(vrt), np.array([[True, False], [True, False]]))


def test_read_mask_white_fill():
	rgb = np.array([[[255, 120]], [[255, 120]], [[255, 120]]], dtype=np.uint8)  # left col solid white
	vrt = FakeVRT(rgb, np.zeros((1, 2), bool), NodataPolicy(treat_white_fill=True))
	np.testing.assert_array_equal(read_nodata_mask(vrt), np.array([[True, False]]))


def test_read_mask_black_fill():
	rgb = np.array([[[0, 120]], [[0, 120]], [[0, 120]]], dtype=np.uint8)  # left col solid black
	vrt = FakeVRT(rgb, np.zeros((1, 2), bool), NodataPolicy(treat_black_fill=True))
	np.testing.assert_array_equal(read_nodata_mask(vrt), np.array([[True, False]]))


def test_read_mask_white_fill_keeps_partially_bright_pixels():
	# Bright in only two of three bands → real data, not fill.
	rgb = np.array([[[255]], [[255]], [[200]]], dtype=np.uint8)
	vrt = FakeVRT(rgb, np.zeros((1, 1), bool), NodataPolicy(treat_white_fill=True, treat_black_fill=True))
	np.testing.assert_array_equal(read_nodata_mask(vrt), np.array([[False]]))


# --------------------------------------------------------------------------- #
# End-to-end through the real image_reprojector + read_nodata_mask
# --------------------------------------------------------------------------- #

# UTM 32N so image_reprojector reprojects UTM->UTM (no rotation/border noise).
_CRS = 'EPSG:32632'
_TRANSFORM = from_origin(500000, 5320000, 1.0, 1.0)


def _write(path, data, nodata=None, mask=None, alpha=False):
	count, h, w = data.shape
	profile = dict(driver='GTiff', height=h, width=w, count=count, dtype='uint8', crs=_CRS, transform=_TRANSFORM)
	if nodata is not None:
		profile['nodata'] = nodata
	with rasterio.open(path, 'w', **profile) as ds:
		ds.write(data)
		if alpha:
			ds.colorinterp = [CI.ColorInterp.red, CI.ColorInterp.green, CI.ColorInterp.blue, CI.ColorInterp.alpha]
		if mask is not None:
			ds.write_mask(mask)
	return str(path)


def _split_data(shape=(32, 32)):
	"""RGB image whose left half is 'fill' and right half is real data (120)."""
	h, w = shape
	rgb = np.full((3, h, w), 120, dtype=np.uint8)
	left = slice(0, w // 2)
	right = slice(w // 2, w)
	return rgb, left, right


def _assert_left_nodata_right_data(mask, left, right):
	# Ignore the outermost columns to stay clear of any warp-resampling seam.
	assert mask[:, left].mean() > 0.9, 'expected the fill half to be flagged nodata'
	assert mask[:, right][:, 1:-1].mean() < 0.05, 'expected the data half to be kept'


def test_e2e_alpha_band(tmp_path):
	rgb, left, right = _split_data()
	rgb[:, :, left] = 255  # white fill under the alpha
	alpha = np.full((1, 32, 32), 255, np.uint8)
	alpha[0, :, left] = 0
	path = _write(tmp_path / 'alpha.tif', np.concatenate([rgb, alpha]), alpha=True)
	vrt = image_reprojector(path)
	try:
		_assert_left_nodata_right_data(read_nodata_mask(vrt), left, right)
	finally:
		vrt.close()


def test_e2e_declared_white_nodata(tmp_path):
	rgb, left, right = _split_data()
	rgb[:, :, left] = 255
	path = _write(tmp_path / 'nd255.tif', rgb, nodata=255)
	vrt = image_reprojector(path)
	try:
		assert vrt.nodata_policy == NodataPolicy()
		_assert_left_nodata_right_data(read_nodata_mask(vrt), left, right)
	finally:
		vrt.close()


def test_e2e_internal_mask(tmp_path):
	rgb, left, right = _split_data()
	rgb[:, :, left] = 200  # arbitrary; the mask (not the pixels) defines nodata
	mask = np.full((32, 32), 255, np.uint8)
	mask[:, left] = 0
	path = _write(tmp_path / 'imask.tif', rgb, mask=mask)
	vrt = image_reprojector(path)
	try:
		_assert_left_nodata_right_data(read_nodata_mask(vrt), left, right)
	finally:
		vrt.close()


def test_e2e_untagged_white_fill(tmp_path):
	# No nodata, no mask, no alpha — the hard case the fallback exists for.
	rgb, left, right = _split_data()
	rgb[:, :, left] = 255
	path = _write(tmp_path / 'whitefill.tif', rgb)
	vrt = image_reprojector(path)
	try:
		assert vrt.nodata_policy == NodataPolicy(treat_white_fill=True, treat_black_fill=True)
		_assert_left_nodata_right_data(read_nodata_mask(vrt), left, right)
	finally:
		vrt.close()


def test_e2e_clean_imagery_masks_nothing(tmp_path):
	# Full-frame real imagery (no fill) must not be spuriously masked.
	rng = np.random.default_rng(0)
	rgb = rng.integers(40, 210, size=(3, 32, 32), dtype=np.uint8)
	path = _write(tmp_path / 'clean.tif', rgb)
	vrt = image_reprojector(path)
	try:
		# Interior only — the reprojection can leave a 1px seam at the edge.
		assert read_nodata_mask(vrt)[1:-1, 1:-1].mean() < 0.01
	finally:
		vrt.close()
