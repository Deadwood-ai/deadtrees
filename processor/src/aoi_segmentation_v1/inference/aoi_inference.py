"""Full-orthomosaic Area-of-Interest (AOI) inference.

Ports the production OrthoAOI SegFormer-B1 model into the deadtrees processor.
The model performs binary inside/outside-AOI classification and the pipeline
returns a single cleaned AOI polygon per orthomosaic.

Reuses the existing segmentation infrastructure:
- `image_reprojector` to read the ortho in a metric (UTM) CRS so that the
  polygon cleanup distances below are in metres, matching the production
  "map-unit" defaults.
- `InferenceDataset` for padded, overlap-aware tiling (identical to the
  combined deadwood/treecover model).
- `mask_to_polygons_scanline` to polygonize the binary mask without ever
  materialising the full-resolution array.
"""

import os
import tempfile

import numpy as np
import rasterio
import torch
import torch.nn.functional as F
from rasterio.windows import Window as RioWindow
from safetensors import safe_open
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union
from torch.utils.data import DataLoader
from torchvision.transforms import transforms
from torchvision.transforms.functional import crop
from transformers import SegformerConfig, SegformerForSemanticSegmentation
from tqdm import tqdm

from processor.src.utils.inference_dataset import InferenceDataset
from processor.src.utils.segmentation import (
	filter_polygons_by_area,
	image_reprojector,
	mask_to_polygons_scanline,
	reproject_polygons,
)

# Binary class indices (config/aoi_segformer.yml in the production package).
CLASS_OUTSIDE_AOI = 0
CLASS_INSIDE_AOI = 1

# Tiling matches the combined model so the InferenceDataset windows behave
# identically: 1024 px tiles with a 256 px padded border that is cropped away.
TILE_SIZE = 1024
PADDING = 256
BATCH_SIZE = 2
NUM_DATALOADER_WORKERS = 0

# The model expects a fixed 10 cm ground sampling distance, so every ortho is
# resampled to exactly this resolution (both finer and coarser inputs) when
# reprojected to its metric UTM CRS.
INFERENCE_RESOLUTION_M = 0.10

# Polygon cleanup, in metres (we run inference in a metric UTM CRS). These
# mirror config/evaluation/full_ortho_b1_50epoch_production.yml so the AOI shape
# matches the validated production output.
MIN_POLYGON_AREA_M2 = 5.0
POLYGON_OPENING_RADIUS_M = 5.0
NEGATIVE_BUFFER_M = -1.5
SIMPLIFY_TOLERANCE_M = 5.0
CHAIKIN_ITERATIONS = 1


def _build_transform():
	return transforms.Compose(
		[
			transforms.ToTensor(),
			transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
		]
	)


def _build_model_config() -> SegformerConfig:
	# SegFormer mit-b1 architecture (segformer-b1-finetuned-ade-512-512) with a
	# 2-class head. Values taken from the bundled HF config.json.
	return SegformerConfig(
		num_channels=3,
		num_encoder_blocks=4,
		depths=[2, 2, 2, 2],
		sr_ratios=[8, 4, 2, 1],
		hidden_sizes=[64, 128, 320, 512],
		patch_sizes=[7, 3, 3, 3],
		strides=[4, 2, 2, 2],
		num_attention_heads=[1, 2, 5, 8],
		mlp_ratios=[4, 4, 4, 4],
		hidden_act='gelu',
		hidden_dropout_prob=0.0,
		attention_probs_dropout_prob=0.0,
		classifier_dropout_prob=0.1,
		initializer_range=0.02,
		drop_path_rate=0.1,
		layer_norm_eps=1e-6,
		decoder_hidden_size=256,
		num_labels=2,
		id2label={0: 'outside_aoi', 1: 'inside_aoi'},
		label2id={'outside_aoi': 0, 'inside_aoi': 1},
		semantic_loss_ignore_index=255,
	)


def _remove_polygon_holes(geometry):
	"""Drop interior rings so the AOI is a solid outline."""
	if geometry is None or geometry.is_empty:
		return geometry
	if isinstance(geometry, Polygon):
		return Polygon(geometry.exterior)
	if isinstance(geometry, MultiPolygon):
		return MultiPolygon([Polygon(part.exterior) for part in geometry.geoms if not part.is_empty])
	return geometry


def _keep_largest_polygon(geometry):
	if geometry is None or geometry.is_empty:
		return geometry
	if isinstance(geometry, Polygon):
		return geometry
	if isinstance(geometry, MultiPolygon):
		parts = [part for part in geometry.geoms if not part.is_empty]
		return max(parts, key=lambda part: part.area) if parts else geometry
	return geometry


def _chaikin_ring(coords: list[tuple[float, float]], iterations: int) -> list[tuple[float, float]]:
	if iterations <= 0 or len(coords) < 4:
		return coords

	ring = list(coords)
	if ring[0] == ring[-1]:
		ring = ring[:-1]

	for _ in range(iterations):
		if len(ring) < 3:
			break
		smoothed = []
		for idx, p0 in enumerate(ring):
			p1 = ring[(idx + 1) % len(ring)]
			q = (0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1])
			r = (0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1])
			smoothed.extend([q, r])
		ring = smoothed

	ring.append(ring[0])
	return ring


def _chaikin_polygon(polygon: Polygon, iterations: int) -> Polygon:
	if polygon.is_empty or iterations <= 0:
		return polygon
	exterior = _chaikin_ring(list(polygon.exterior.coords), iterations)
	if len(exterior) < 4:
		return polygon
	smoothed = Polygon(exterior)
	if not smoothed.is_valid:
		smoothed = smoothed.buffer(0)
	return smoothed if not smoothed.is_empty else polygon


def _smooth_geometry(geometry, simplify_tolerance: float, chaikin_iterations: int):
	if geometry is None or geometry.is_empty:
		return geometry

	smoothed = geometry
	if simplify_tolerance > 0:
		smoothed = smoothed.simplify(simplify_tolerance, preserve_topology=True)
	if smoothed.is_empty:
		return geometry

	if chaikin_iterations > 0:
		if isinstance(smoothed, Polygon):
			smoothed = _chaikin_polygon(smoothed, chaikin_iterations)
		elif isinstance(smoothed, MultiPolygon):
			parts = [_chaikin_polygon(part, chaikin_iterations) for part in smoothed.geoms if not part.is_empty]
			smoothed = MultiPolygon([part for part in parts if not part.is_empty])
	if not smoothed.is_valid:
		smoothed = smoothed.buffer(0)
	return smoothed if not smoothed.is_empty else geometry


def cleanup_aoi_polygon(polygons: list[Polygon]) -> list[Polygon]:
	"""Merge per-tile polygons into the single cleaned production AOI shape.

	Steps mirror the production package: union -> drop holes -> morphological
	opening to remove narrow outward blobs -> inward buffer -> light smoothing
	clipped back to the opened geometry (non-expansive) -> keep the largest
	polygon -> drop holes again. Operates in the inference (UTM) CRS, so all
	distances are metres.
	"""
	if not polygons:
		return []

	geometry = unary_union(polygons)
	geometry = _remove_polygon_holes(geometry)
	if geometry is None or geometry.is_empty:
		return []

	if POLYGON_OPENING_RADIUS_M > 0:
		opened = geometry.buffer(-POLYGON_OPENING_RADIUS_M).buffer(POLYGON_OPENING_RADIUS_M)
		if not opened.is_empty:
			geometry = opened
	if NEGATIVE_BUFFER_M != 0:
		buffered = geometry.buffer(NEGATIVE_BUFFER_M)
		if not buffered.is_empty:
			geometry = buffered

	non_expansive_reference = geometry
	geometry = _smooth_geometry(geometry, SIMPLIFY_TOLERANCE_M, CHAIKIN_ITERATIONS)
	# Clip the smoothed boundary back so smoothing never adds outside-AOI area.
	geometry = geometry.intersection(non_expansive_reference)
	if not geometry.is_valid:
		geometry = geometry.buffer(0)

	geometry = _keep_largest_polygon(geometry)
	geometry = _remove_polygon_holes(geometry)

	if geometry is None or geometry.is_empty:
		return []
	if isinstance(geometry, MultiPolygon):
		return [part for part in geometry.geoms if not part.is_empty]
	return [geometry]


class AOIInference:
	"""Runs the SegFormer-B1 AOI model and returns the cleaned AOI polygon(s)
	in the CRS of the input orthomosaic."""

	def __init__(self, model_path: str):
		torch.set_float32_matmul_precision('high')
		self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
		self.model = self._load_model(model_path)

	def _load_model(self, model_path: str) -> SegformerForSemanticSegmentation:
		# The checkpoint was saved from a training wrapper (self.model = ...), so
		# every key is prefixed with "model.". Strip it before loading, matching
		# the combined model loader.
		state_dict = {}
		with safe_open(model_path, framework='pt', device='cpu') as f:
			for key in f.keys():
				new_key = key[len('model.') :] if key.startswith('model.') else key
				state_dict[new_key] = f.get_tensor(key)

		model = SegformerForSemanticSegmentation(_build_model_config())
		model.load_state_dict(state_dict, strict=True)
		model = model.to(self.device)
		model.eval()
		return model

	def inference(self, input_tif: str) -> list[Polygon]:
		"""Run inference on a GeoTIFF and return the cleaned AOI polygon(s) in the
		CRS of the input file."""
		# Reproject to a metric (UTM) CRS and resample to the model's fixed 10 cm
		# grid. Passing the same value as min and max resolution forces exactly
		# INFERENCE_RESOLUTION_M whether the input is finer or coarser, and the
		# metric CRS keeps the polygon cleanup buffers expressed in metres.
		vrt_src = image_reprojector(
			input_tif,
			min_res=INFERENCE_RESOLUTION_M,
			max_res=INFERENCE_RESOLUTION_M,
		)
		dataset = InferenceDataset(
			image_src=vrt_src,
			tile_size=TILE_SIZE,
			padding=PADDING,
			transform=_build_transform(),
		)
		vrt_src = dataset.image_src

		loader = DataLoader(
			dataset,
			batch_size=BATCH_SIZE,
			num_workers=NUM_DATALOADER_WORKERS,
			pin_memory=True,
			shuffle=False,
		)

		tmp_mask_path = None
		try:
			# Binary mask written tile-by-tile so the full-resolution array never
			# lives in RAM. Nodata pixels (from the VRT mask band) are forced to
			# outside-AOI per tile.
			with tempfile.NamedTemporaryFile(suffix='_aoi_mask.tif', delete=False) as f:
				tmp_mask_path = f.name

			tif_kwargs = dict(
				driver='GTiff',
				height=dataset.height,
				width=dataset.width,
				count=1,
				dtype=np.uint8,
				crs=vrt_src.crs,
				transform=vrt_src.transform,
			)
			with rasterio.open(tmp_mask_path, 'w', **tif_kwargs) as dst_mask:
				for images, cropped_windows in tqdm(loader, desc='aoi inference'):
					images = images.to(self.device)

					with torch.no_grad():
						if images.shape[0] < BATCH_SIZE:
							pad = torch.zeros((BATCH_SIZE, 3, TILE_SIZE, TILE_SIZE), dtype=torch.float32)
							pad[: images.shape[0]] = images
							pad = pad.to(self.device)
							logits = self.model(pixel_values=pad).logits[: images.shape[0]]
						else:
							logits = self.model(pixel_values=images).logits

						logits = F.interpolate(
							logits, size=(TILE_SIZE, TILE_SIZE), mode='bilinear', align_corners=False
						)
						preds = logits.argmax(dim=1, keepdim=True).float()  # (B, 1, H, W)

					for i in range(preds.shape[0]):
						pred_tile = crop(
							preds[i].cpu(),
							top=PADDING,
							left=PADDING,
							height=TILE_SIZE - (2 * PADDING),
							width=TILE_SIZE - (2 * PADDING),
						)

						minx = int(cropped_windows['col_off'][i])
						maxx = minx + int(cropped_windows['width'][i])
						miny = int(cropped_windows['row_off'][i])
						maxy = miny + int(cropped_windows['width'][i])

						diff_minx = max(0, -minx)
						minx = max(0, minx)
						diff_miny = max(0, -miny)
						miny = max(0, miny)
						diff_maxx = max(0, maxx - dataset.width)
						maxx = min(maxx, dataset.width)
						diff_maxy = max(0, maxy - dataset.height)
						maxy = min(maxy, dataset.height)

						if maxx <= minx or maxy <= miny:
							continue

						pred_tile = pred_tile[
							:,
							diff_miny : pred_tile.shape[1] - diff_maxy if diff_maxy else pred_tile.shape[1],
							diff_minx : pred_tile.shape[2] - diff_maxx if diff_maxx else pred_tile.shape[2],
						]

						out_window = RioWindow(col_off=minx, row_off=miny, width=maxx - minx, height=maxy - miny)
						mask_arr = (pred_tile[0].numpy() == CLASS_INSIDE_AOI).astype(np.uint8)

						nodata_tile = vrt_src.read_masks(1, window=out_window)
						mask_arr[nodata_tile == 0] = CLASS_OUTSIDE_AOI

						dst_mask.write(mask_arr, 1, window=out_window)

			src_crs = vrt_src.crs
			vrt_src.close()

			with rasterio.open(input_tif) as src:
				orig_crs = src.crs

			# Polygonize the inside-AOI class scanline-by-scanline (no full-res
			# array), then run the production polygon cleanup in the metric CRS.
			with rasterio.open(tmp_mask_path) as ds:
				inside_polys = mask_to_polygons_scanline(ds, CLASS_INSIDE_AOI)

			inside_polys = filter_polygons_by_area(inside_polys, MIN_POLYGON_AREA_M2)
			cleaned = cleanup_aoi_polygon(inside_polys)
			if not cleaned:
				return []

			return reproject_polygons(cleaned, src_crs, orig_crs)

		finally:
			if tmp_mask_path and os.path.exists(tmp_mask_path):
				os.unlink(tmp_mask_path)
