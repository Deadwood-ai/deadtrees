import os
import tempfile

import numpy as np
import rasterio
import safetensors.torch
import segmentation_models_pytorch as smp
import torch

from processor.src.utils.inference_dataset import InferenceDataset, normalize_imagenet, predict_tiles
from processor.src.utils.segmentation import (
	filter_polygons_by_area,
	image_reprojector,
	mask_to_polygons_scanline,
	reproject_polygons,
)
from shared.asset_manifest import DEADWOOD_V1_MODEL_CHECKPOINT_NAME

DEADWOOD_MODEL_NAME = DEADWOOD_V1_MODEL_CHECKPOINT_NAME.removesuffix('.safetensors')
DEADWOOD_PROBABILITY_THRESHOLD = 0.5
DEADWOOD_MINIMUM_INFERENCE_RESOLUTION = 0.05
DEADWOOD_BATCH_SIZE = 2
DEADWOOD_MINIMUM_POLYGON_AREA = 0.1
# The checkpoint was saved from a torch.compile'd model.
COMPILED_KEY_PREFIX = '_orig_mod.'


class DeadwoodInference:
	def __init__(self, model_path: str):
		self.model = None
		self.model_path = model_path
		self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
		# fp16 weights on the GPU are ~2.5x faster than fp32 and keep the binarized
		# deadwood mask at IoU >= 0.998 against fp32.
		self.dtype = torch.float16 if self.device.type == 'cuda' else torch.float32
		self.load_model()

	def load_model(self):
		if 'segformer_b5' not in DEADWOOD_MODEL_NAME:
			print('Invalid model name: ', DEADWOOD_MODEL_NAME, 'Exiting...')
			exit()

		# The safetensors checkpoint contains the complete state dict, so no
		# separately downloaded or pickle-serialized encoder weights are needed.
		model = smp.Unet(
			encoder_name='mit_b5',
			encoder_weights=None,
			in_channels=3,
			classes=1,
		)
		state_dict = safetensors.torch.load_file(self.model_path)
		model.load_state_dict({key.removeprefix(COMPILED_KEY_PREFIX): value for key, value in state_dict.items()})
		model = model.to(device=self.device, dtype=self.dtype, memory_format=torch.channels_last)
		model.eval()
		self.model = model

	def predict(self, images: torch.Tensor) -> torch.Tensor:
		"""(B, 3, H, W) uint8 tiles -> (B, H, W) uint8 deadwood mask."""
		pixels = normalize_imagenet(images, self.dtype).contiguous(memory_format=torch.channels_last)
		probabilities = torch.sigmoid(self.model(pixels).float())
		return (probabilities[:, 0] > DEADWOOD_PROBABILITY_THRESHOLD).to(torch.uint8)

	def inference_deadwood(self, input_tif):
		"""Return deadwood polygons in the CRS of the input tif."""
		dataset = InferenceDataset(
			lambda: image_reprojector(input_tif, min_res=DEADWOOD_MINIMUM_INFERENCE_RESOLUTION),
			tile_size=1024,
			padding=256,
			skip_nodata_tiles=True,
		)
		vrt_src = dataset.image_src

		tmp_path = None
		try:
			with tempfile.NamedTemporaryFile(suffix='_deadwood.tif', delete=False) as f:
				tmp_path = f.name

			# Write the uint8 mask tile-by-tile so the full-res mask never lives in RAM.
			with rasterio.open(
				tmp_path, 'w',
				driver='GTiff',
				height=dataset.height,
				width=dataset.width,
				count=1,
				dtype=np.uint8,
				crs=vrt_src.crs,
				transform=vrt_src.transform,
			) as dst:
				for out_window, mask in predict_tiles(dataset, self.predict, self.device, DEADWOOD_BATCH_SIZE):
					dst.write(mask, 1, window=out_window)

			print('Postprocessing mask into polygons and filtering....')
			src_crs = vrt_src.crs
			vrt_src.close()

			with rasterio.open(tmp_path) as ds:
				polygons = mask_to_polygons_scanline(ds, 1)

			polygons = filter_polygons_by_area(polygons, DEADWOOD_MINIMUM_POLYGON_AREA)
			polygons = reproject_polygons(polygons, src_crs, rasterio.open(input_tif).crs)

			print('done')
			return polygons

		finally:
			if tmp_path and os.path.exists(tmp_path):
				os.unlink(tmp_path)
