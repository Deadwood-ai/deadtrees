import os
from json import loads, dumps
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.warp import calculate_default_transform, reproject, Resampling
from tqdm import tqdm
import utm
import torch
import torch.nn as nn
from safetensors.torch import load_model
from shapely.affinity import affine_transform, translate
from shapely.geometry import Polygon, MultiPolygon, mapping
import cv2

# from tcd.tcd_pipeline.pipeline import Pipeline
from torch.utils.data import DataLoader
from torchvision.transforms.functional import crop

from .InferenceDataset import InferenceDataset
from .unet_model import UNet

TCD_RESOLUTION = 0.1  # m -> tree crown detection only works as 10cm
TCD_THRESHOLD = 200
DEADWOOD_THRESHOLD = 0.9
DEADWOOD_MODEL_PATH = str(Path(__file__).parent / 'models/model.safetensors')
TEMP_DIR = 'temp'
os.makedirs(TEMP_DIR, exist_ok=True)

DEBUG = False


def reproject_to_10cm(input_tif, output_tif):
	"""takes an input tif file and reprojects it to 10cm resolution and writes it to output_tif"""

	with rasterio.open(input_tif) as src:
		# figure out centroid in epsg 4326
		centroid = src.lnglat()

		# dst crs is native utm zone for max precision
		dst_crs = utm.from_latlon(centroid[1], centroid[0])

		transform, width, height = calculate_default_transform(
			src.crs, dst_crs, src.width, src.height, *src.bounds, resolution=TCD_RESOLUTION
		)

		kwargs = src.meta.copy()
		kwargs.update({'crs': dst_crs, 'transform': transform, 'width': width, 'height': height})

		with rasterio.open(output_tif, 'w', **kwargs) as dst:
			for i in range(1, src.count + 1):
				reproject(
					source=rasterio.band(src, i),
					destination=rasterio.band(dst, i),
					src_transform=src.transform,
					src_crs=src.crs,
					dst_transform=transform,
					dst_crs=dst_crs,
					resampling=Resampling.nearest,
				)


def merge_polygons(contours, hierarchy) -> MultiPolygon:
	"""
	adapted from: https://stackoverflow.com/a/75510437/8832008
	"""

	# https://docs.opencv.org/4.x/d9/d8b/tutorial_py_contours_hierarchy.html
	# hierarchy structure: [next, prev, first_child, parent]

	def make_valid(polygon):
		if not polygon.is_valid:
			polygon = polygon.buffer(0)
		return polygon

	polygons = []

	if DEBUG:
		pbar = tqdm(total=len(contours))

	idx = 0
	while idx != -1:
		# Get contour from global list of contours
		contour = np.squeeze(contours[idx])

		if DEBUG:
			pbar.update(1)

		# cv2.findContours() sometimes returns a single point -> skip this case
		if len(contour) > 2:
			# Convert contour to shapely polygon
			holes = []

			# check if there is a child
			child_idx = hierarchy[idx][2]
			if child_idx != -1:
				# iterate over all children and add them as holes
				while child_idx != -1:
					if DEBUG:
						pbar.update(1)
					child = np.squeeze(contours[child_idx])
					if len(child) > 2:
						holes.append(child)
					child_idx = hierarchy[child_idx][0]

			new_poly = Polygon(shell=contour, holes=holes)

			# save poly
			polygons.append(new_poly)

		# Check if there is some next polygon at the same hierarchy level
		idx = hierarchy[idx][0]

	return polygons


def mask_to_polygons(mask, dataset_reader):
	"""
	this function takes a numpy mask as input and returns a list of polygons
	that are in the crs of the passed dataset reader
	"""
	contours, hierarchy = cv2.findContours(
		mask.astype(np.uint8).copy(), mode=cv2.RETR_CCOMP, method=cv2.CHAIN_APPROX_SIMPLE
	)

	# Return empty list if no contours found
	if len(contours) == 0:
		return []

	hierarchy = hierarchy[0]

	poly = merge_polygons(contours, hierarchy)

	# affine transform from pixel to world coordinates
	transform = dataset_reader.transform
	transform_matrix = (transform.a, transform.b, transform.d, transform.e, transform.c, transform.f)
	poly = [affine_transform(p, transform_matrix) for p in poly]

	return poly


def get_utm_string_from_latlon(lat, lon):
	zone = utm.from_latlon(lat, lon)
	utm_code = 32600 + zone[2]
	if lat < 0:
		utm_code -= 100
	return f'EPSG:{utm_code}'


def inference_deadwood(input_tif: str):
	"""
	gets path to tif file and returns polygons of deadwood in the CRS of the tif
	"""

	# Create path for reprojected image
	# input_path = Path(input_tif)
	# reprojected_tif = input_path.parent / f'{input_path.stem}_10cm{input_path.suffix}'

	# Reproject the input image to 10cm resolution
	# reproject_to_10cm(input_tif, str(reprojected_tif))

	# Use reprojected file for the dataset
	dataset = InferenceDataset(image_path=input_tif, tile_size=1024, padding=256)

	loader_args = {
		'batch_size': 1,
		# 'num_workers': 2,
		'num_workers': 0,
		'pin_memory': True,
		'shuffle': False,
	}
	inference_loader = DataLoader(dataset, **loader_args)

	# preferably use GPU
	device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
	print(f'Using device: {device}')

	# model with three input channels (RGB)
	model = UNet(
		n_channels=3,
		n_classes=1,
	).to(memory_format=torch.channels_last)

	load_model(model, DEADWOOD_MODEL_PATH)
	model = nn.DataParallel(model)
	model = model.to(memory_format=torch.channels_last, device=device)

	model.eval()

	outimage = np.zeros((dataset.height, dataset.width))
	for images, cropped_windows in tqdm(inference_loader):
		images = images.to(device=device, memory_format=torch.channels_last)
		with torch.no_grad():
			output = model(images)
			output = torch.sigmoid(output)
			output = (output > 0.3).float()

			# crop tensor by dataset padding
			output = crop(
				output,
				top=dataset.padding,
				left=dataset.padding,
				height=dataset.tile_size - (2 * dataset.padding),
				width=dataset.tile_size - (2 * dataset.padding),
			)

			# derive min/max from cropped window
			minx = cropped_windows['col_off']
			maxx = minx + cropped_windows['width']
			miny = cropped_windows['row_off']
			maxy = miny + cropped_windows['width']

			# save tile to output array
			outimage[miny:maxy, minx:maxx] = output[0][0].cpu().numpy()

	# threshold the output image
	outimage = (outimage > DEADWOOD_THRESHOLD).astype(np.uint8)

	# get polygons from mask
	polygons = mask_to_polygons(outimage, dataset.image_src)

	# If no polygons were found, return empty list
	if not polygons:
		return []

	return polygons


def inference_forestcover(input_tif: str):
	# reproject tif to 10cm
	temp_reproject_path = os.path.join(TEMP_DIR, input_tif.str.split('/')[-1])
	reproject_to_10cm(input_tif, temp_reproject_path)

	pipeline = Pipeline(model_or_config='restor/tcd-segformer-mit-b5')

	res = pipeline.predict(temp_reproject_path)

	dataset_reader_result = res.confidence_map

	# threshold the output image
	outimage = (res.confidence_map > TCD_THRESHOLD).astype(np.uint8)

	# convert to polygons
	polygons = mask_to_polygons(outimage, dataset_reader_result)

	# TODO need to cleanup temp file and prediction that was generated by the pipeline

	return polygons


def save_poly(filename, poly, crs):
	gpd.GeoDataFrame(dict(geometry=poly), crs=crs).to_file(filename)


def transform_mask(mask, image_path):
	"""
	transform a mask to the crs of the passed image path
	"""
	with rasterio.open(image_path) as src:
		gdf = gpd.GeoDataFrame(geometry=[MultiPolygon(mask)], crs=src.crs)
		gdf = gdf.to_crs(epsg=4326)
		polygons = mapping(gdf.geometry.iloc[0])
		polygons_str = loads(dumps(polygons))
	return polygons_str


# def transform_mask(polygons, image_path):
# 	"""Transform polygons to the CRS of the image"""
# 	with rasterio.open(image_path) as src:
# 		deadwood_gdf = gpd.GeoDataFrame(
# 			geometry=polygons,
# 			crs=src.crs,
# 		)
# 		deadwood_gdf = deadwood_gdf.to_crs('EPSG:4326')
# 		geojson = loads(deadwood_gdf.geometry.to_json())

# 		labels = {
# 			'type': 'MultiPolygon',
# 			'coordinates': [feature['geometry']['coordinates'] for feature in geojson['features']],
# 		}
# 	return labels


def extract_bbox(image_path: str) -> dict:
	"""
	Extract bounding box from raster file and return as GeoJSON MultiPolygon in EPSG:4326

	Args:
	    image_path (str): Path to the raster file

	Returns:
	    dict: GeoJSON MultiPolygon of the bounding box in WGS84 projection
	"""
	with rasterio.open(image_path) as src:
		bounds = src.bounds

		# Create polygon from bounds
		bbox_poly = Polygon(
			[
				[bounds.left, bounds.top],  # top-left
				[bounds.right, bounds.top],  # top-right
				[bounds.right, bounds.bottom],  # bottom-right
				[bounds.left, bounds.bottom],  # bottom-left
				[bounds.left, bounds.top],  # close the polygon
			]
		)

		# Convert to GeoDataFrame with source CRS
		bbox_gdf = gpd.GeoDataFrame(geometry=[bbox_poly], crs=src.crs)

		# Reproject to WGS84 if needed
		if src.crs != 'EPSG:4326':
			bbox_gdf = bbox_gdf.to_crs('EPSG:4326')

		# Convert coordinates to lists instead of tuples
		coords = [list(coord) for coord in bbox_gdf.geometry.iloc[0].exterior.coords[:]]

		# Convert to required MultiPolygon GeoJSON format
		bbox_geojson = {
			'type': 'MultiPolygon',
			'coordinates': [[coords]],
		}
	return bbox_geojson
