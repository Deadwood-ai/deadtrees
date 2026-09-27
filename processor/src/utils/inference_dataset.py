import numpy as np
from rasterio import windows
from torch.utils.data import Dataset

from .nodata import read_nodata_mask


class InferenceDataset(Dataset):
	def __init__(self, image_src, tile_size=512, padding=56, transform=None, skip_nodata_tiles=False):
		super().__init__()
		self.tile_size = tile_size
		self.padding = padding
		self.image_src = image_src
		self.width = self.image_src.width
		self.height = self.image_src.height
		self.transform = transform

		# With skip_nodata_tiles, tiles whose whole padded input is nodata are dropped:
		# every caller zeroes the nodata pixels of a tile's (smaller) output window and
		# starts from an all-zero output, so predicting them only costs GPU time. The
		# check reads each padded window's mask up front, which only pays off for heavy
		# models (deadwood/combined ~20-30% faster; the small AOI model got slower).
		self.cropped_windows = [
			window
			for window in get_windows(
				xmin=-self.padding,
				ymin=-self.padding,
				xmax=self.width + self.padding,
				ymax=self.height + self.padding,
				tile_width=self.tile_size - (padding * 2),
				tile_height=self.tile_size - (padding * 2),
				overlap=0,
			)
			if not (skip_nodata_tiles and self._is_all_nodata(window))
		]

	def _inference_window(self, cropped_window):
		return windows.Window(
			cropped_window.col_off - self.padding,
			cropped_window.row_off - self.padding,
			cropped_window.width + (2 * self.padding),
			cropped_window.height + (2 * self.padding),
		)

	def _is_all_nodata(self, cropped_window) -> bool:
		raster = windows.Window(0, 0, self.width, self.height)
		on_raster = windows.intersection(self._inference_window(cropped_window), raster)
		return bool(read_nodata_mask(self.image_src, on_raster).all())

	def __len__(self):
		return len(self.cropped_windows)

	def __getitem__(self, idx):
		cropped_window = self.cropped_windows[idx]
		cropped_window_dict = {
			'col_off': cropped_window.col_off,
			'row_off': cropped_window.row_off,
			'width': cropped_window.width,
			'height': cropped_window.height,
		}
		inference_window = self._inference_window(cropped_window)
		try:
			image = self.image_src.read((1, 2, 3), window=inference_window)
		except Exception as e:
			raise RuntimeError(
				f'Raster read failed at window {cropped_window_dict} (inference_window={inference_window}): {e}'
			) from e

		if image.shape[1] < self.tile_size or image.shape[2] < self.tile_size:
			pad_left = 0 if inference_window.col_off >= 0 else abs(inference_window.col_off)
			pad_right = self.tile_size - (pad_left + image.shape[2])
			pad_top = 0 if inference_window.row_off >= 0 else abs(inference_window.row_off)
			pad_bottom = self.tile_size - (pad_top + image.shape[1])

			image = np.pad(
				image,
				((0, 0), (pad_top, pad_bottom), (pad_left, pad_right)),
				mode='constant',
				constant_values=0,
			)

		image = image.transpose(1, 2, 0)
		if self.transform is not None:
			image = self.transform(image)
		return image, cropped_window_dict


def get_windows(xmin, ymin, xmax, ymax, tile_width, tile_height, overlap):
	xstep = tile_width - overlap
	ystep = tile_height - overlap
	for x in range(xmin, xmax, xstep):
		if x + tile_width > xmax:
			x = xmax - tile_width
		for y in range(ymin, ymax, ystep):
			if y + tile_height > ymax:
				y = ymax - tile_height
			yield windows.Window(x, y, tile_width, tile_height)
