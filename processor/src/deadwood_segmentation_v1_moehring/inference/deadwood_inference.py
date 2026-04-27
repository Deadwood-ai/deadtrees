import sys
from pathlib import Path

import numpy as np
import rasterio
import safetensors.torch
import segmentation_models_pytorch as smp
import torch
from torch.utils.data import DataLoader
from torchvision.transforms import transforms
from torchvision.transforms.functional import crop
from tqdm import tqdm

from processor.src.utils.inference_dataset import InferenceDataset
from processor.src.utils.segmentation import (
	filter_polygons_by_area,
	image_reprojector,
	mask_to_polygons,
	reproject_polygons,
)

DEADWOOD_MODEL_NAME = 'segformer_b5_full_epoch_100'
DEADWOOD_PROBABILITY_THRESHOLD = 0.5
DEADWOOD_MINIMUM_INFERENCE_RESOLUTION = 0.05
DEADWOOD_BATCH_SIZE = 2
DEADWOOD_NUM_DATALOADER_WORKERS = 0
DEADWOOD_MINIMUM_POLYGON_AREA = 0.1


def build_deadwood_transform():
	return transforms.Compose(
		[
			transforms.ToTensor(),
			transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
		]
	)


class DeadwoodInference:
	def __init__(self, model_path: str):
		torch.set_float32_matmul_precision('high')

		self.model = None
		self.model_path = model_path
		self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
		self.load_model()

	def get_cache_path(self):
		model_path = Path(self.model_path)
		return model_path.parent / f'{DEADWOOD_MODEL_NAME}_pretrained.pt'

	def load_model(self):
		version_parts = torch.__version__.split('+', 1)[0].split('.')
		torch_version = tuple(int(part) for part in version_parts[:3])

		if 'segformer_b5' not in DEADWOOD_MODEL_NAME:
			print('Invalid model name: ', DEADWOOD_MODEL_NAME, 'Exiting...')
			exit()

		cache_path = self.get_cache_path()
		if cache_path.exists():
			model = smp.Unet(
				encoder_name='mit_b5',
				encoder_weights=None,
				in_channels=3,
				classes=1,
			).to(memory_format=torch.channels_last)
			model.load_state_dict(torch.load(str(cache_path)))
		else:
			model = smp.Unet(
				encoder_name='mit_b5',
				encoder_weights='imagenet',
				in_channels=3,
				classes=1,
			).to(memory_format=torch.channels_last)
			torch.save(model.state_dict(), str(cache_path))

		if hasattr(torch, 'compile') and (sys.version_info < (3, 12) or torch_version >= (2, 4, 0)):
			model = torch.compile(model, backend='aot_eager')
		safetensors.torch.load_model(model, self.model_path)
		model = model.to(memory_format=torch.channels_last, device=self.device)
		model.eval()
		self.model = model

	def inference_deadwood(self, input_tif):
		"""Return deadwood polygons in the CRS of the input tif."""
		vrt_src = image_reprojector(input_tif, min_res=DEADWOOD_MINIMUM_INFERENCE_RESOLUTION)
		dataset = InferenceDataset(
			image_src=vrt_src,
			tile_size=1024,
			padding=256,
			transform=build_deadwood_transform(),
		)
		vrt_src = dataset.image_src

		inference_loader = DataLoader(
			dataset,
			batch_size=DEADWOOD_BATCH_SIZE,
			num_workers=DEADWOOD_NUM_DATALOADER_WORKERS,
			pin_memory=True,
			shuffle=False,
		)

		outimage = np.zeros((dataset.height, dataset.width), dtype=np.float32)
		for images, cropped_windows in tqdm(inference_loader, desc='inference'):
			images = images.to(device=self.device, memory_format=torch.channels_last)

			with torch.no_grad():
				if images.shape[0] < DEADWOOD_BATCH_SIZE:
					pad = torch.zeros((DEADWOOD_BATCH_SIZE, 3, 1024, 1024), dtype=torch.float32)
					pad[: images.shape[0]] = images
					pad = pad.to(device=self.device, memory_format=torch.channels_last)
					output = self.model(pad)[: images.shape[0]]
				else:
					output = self.model(images)
				output = torch.sigmoid(output)

			for i in range(output.shape[0]):
				output_tile = crop(
					output[i].cpu(),
					top=dataset.padding,
					left=dataset.padding,
					height=dataset.tile_size - (2 * dataset.padding),
					width=dataset.tile_size - (2 * dataset.padding),
				)

				minx = cropped_windows['col_off'][i]
				maxx = minx + cropped_windows['width'][i]
				miny = cropped_windows['row_off'][i]
				maxy = miny + cropped_windows['width'][i]

				diff_minx = 0
				if minx < 0:
					diff_minx = abs(minx)
					minx = 0

				diff_miny = 0
				if miny < 0:
					diff_miny = abs(miny)
					miny = 0

				diff_maxx = 0
				if maxx > outimage.shape[1]:
					diff_maxx = maxx - outimage.shape[1]
					maxx = outimage.shape[1]

				diff_maxy = 0
				if maxy > outimage.shape[0]:
					diff_maxy = maxy - outimage.shape[0]
					maxy = outimage.shape[0]

				output_tile = output_tile[
					:,
					diff_miny : output_tile.shape[1] - diff_maxy,
					diff_minx : output_tile.shape[2] - diff_maxx,
				]
				outimage[miny:maxy, minx:maxx] = output_tile[0].numpy()

		print('Postprocessing mask into polygons and filtering....')
		outimage = (outimage > DEADWOOD_PROBABILITY_THRESHOLD).astype(np.uint8)

		try:
			nodata_mask = vrt_src.dataset_mask()
		except Exception as e:
			raise RuntimeError(f'Failed to read dataset mask from VRT: {e}') from e

		unique_mask_values = np.unique(nodata_mask)
		if len(unique_mask_values) <= 2 and (0 in unique_mask_values or 255 in unique_mask_values):
			outimage = outimage * (nodata_mask / 255).astype(np.uint8)
		else:
			print('Non-standard mask detected with values:', unique_mask_values)
			print('Skipping masking operation to avoid artifacts')

		polygons = mask_to_polygons(outimage, dataset.image_src)
		vrt_src.close()

		polygons = filter_polygons_by_area(polygons, DEADWOOD_MINIMUM_POLYGON_AREA)
		polygons = reproject_polygons(polygons, dataset.image_src.crs, rasterio.open(input_tif).crs)

		print('done')
		return polygons
