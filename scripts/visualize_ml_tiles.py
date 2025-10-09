#!/usr/bin/env python3
"""
Visualize ML Training Tiles

Creates a grid visualization showing RGB tiles, deadwood masks, and forest cover masks.
Each row represents one tile with three columns:
- Column 1: RGB image
- Column 2: Deadwood mask
- Column 3: Forest cover mask

Usage:
	python scripts/visualize_ml_tiles.py --input-dir ml_ready_tiles --output visualization.png
	python scripts/visualize_ml_tiles.py --input-dir ml_ready_tiles --output viz.png --max-tiles 10
"""

import argparse
from pathlib import Path
from typing import List, Tuple
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from tqdm import tqdm


def find_tile_sets(input_dir: Path) -> List[dict]:
	"""Find all complete tile sets (RGB + deadwood + forestcover).

	Args:
		input_dir: Directory containing exported tiles

	Returns:
		List of dicts with tile information
	"""
	# Find all RGB images (base tiles)
	rgb_files = (
		sorted(input_dir.glob('*_5cm.png'))
		+ sorted(input_dir.glob('*_10cm.png'))
		+ sorted(input_dir.glob('*_20cm.png'))
	)

	# Filter out mask files
	rgb_files = [f for f in rgb_files if 'deadwood' not in f.name and 'forestcover' not in f.name]

	tile_sets = []
	for rgb_file in rgb_files:
		base_name = rgb_file.stem  # Remove .png

		# Find corresponding masks
		deadwood_file = input_dir / f'{base_name}_deadwood.png'
		forestcover_file = input_dir / f'{base_name}_forestcover.png'
		json_file = input_dir / f'{base_name}.json'

		if deadwood_file.exists() and forestcover_file.exists():
			tile_sets.append(
				{
					'name': base_name,
					'rgb': rgb_file,
					'deadwood': deadwood_file,
					'forestcover': forestcover_file,
					'json': json_file if json_file.exists() else None,
				}
			)

	return tile_sets


def load_and_resize_image(image_path: Path, target_size: int = 512) -> np.ndarray:
	"""Load image and resize to target size.

	Args:
		image_path: Path to image file
		target_size: Target width/height in pixels

	Returns:
		RGB numpy array
	"""
	img = Image.open(image_path)

	# Resize maintaining aspect ratio
	img = img.resize((target_size, target_size), Image.Resampling.LANCZOS)

	# Convert grayscale masks to RGB
	if img.mode == 'L':
		img = img.convert('RGB')

	return np.array(img)


def create_labeled_image(img_array: np.ndarray, label: str, font_size: int = 24) -> np.ndarray:
	"""Add label above image.

	Args:
		img_array: Image as numpy array
		label: Text label
		font_size: Font size for label

	Returns:
		Image with label
	"""
	img = Image.fromarray(img_array)

	# Create new image with space for label
	label_height = font_size + 20
	new_img = Image.new('RGB', (img.width, img.height + label_height), color='white')

	# Paste original image
	new_img.paste(img, (0, label_height))

	# Draw label
	draw = ImageDraw.Draw(new_img)

	# Try to use a nice font, fall back to default
	try:
		font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', font_size)
	except:
		font = ImageFont.load_default()

	# Center text
	bbox = draw.textbbox((0, 0), label, font=font)
	text_width = bbox[2] - bbox[0]
	text_x = (img.width - text_width) // 2

	draw.text((text_x, 5), label, fill='black', font=font)

	return np.array(new_img)


def create_tile_visualization(
	tile_sets: List[dict],
	tile_size: int = 512,
	spacing: int = 10,
	font_size: int = 20,
) -> np.ndarray:
	"""Create grid visualization of all tiles.

	Args:
		tile_sets: List of tile set dictionaries
		tile_size: Size to resize each tile to
		spacing: Pixel spacing between tiles
		font_size: Font size for labels

	Returns:
		Large visualization as numpy array
	"""
	num_tiles = len(tile_sets)
	label_height = font_size + 20
	row_height = tile_size + label_height

	# Calculate dimensions
	num_cols = 3  # RGB, Deadwood, Forest Cover
	grid_width = (tile_size * num_cols) + (spacing * (num_cols + 1))
	grid_height = (row_height * num_tiles) + (spacing * (num_tiles + 1))

	print(f'📐 Creating visualization: {grid_width}x{grid_height} pixels')

	# Create white canvas
	canvas = np.ones((grid_height, grid_width, 3), dtype=np.uint8) * 255

	# Process each tile
	for row_idx, tile_set in enumerate(tqdm(tile_sets, desc='Creating visualization')):
		y_offset = spacing + (row_idx * (row_height + spacing))

		# Load and resize images
		rgb_img = load_and_resize_image(tile_set['rgb'], tile_size)
		deadwood_img = load_and_resize_image(tile_set['deadwood'], tile_size)
		forestcover_img = load_and_resize_image(tile_set['forestcover'], tile_size)

		# Add labels
		rgb_labeled = create_labeled_image(rgb_img, f'RGB: {tile_set["name"]}', font_size)
		deadwood_labeled = create_labeled_image(deadwood_img, 'Deadwood', font_size)
		forestcover_labeled = create_labeled_image(forestcover_img, 'Forest Cover', font_size)

		# Place images in grid
		images = [rgb_labeled, deadwood_labeled, forestcover_labeled]
		for col_idx, img in enumerate(images):
			x_offset = spacing + (col_idx * (tile_size + spacing))

			# Paste image onto canvas
			y_end = y_offset + img.shape[0]
			x_end = x_offset + img.shape[1]

			canvas[y_offset:y_end, x_offset:x_end] = img

	return canvas


def main():
	parser = argparse.ArgumentParser(
		description='Create visualization grid of ML training tiles',
		formatter_class=argparse.RawDescriptionHelpFormatter,
		epilog="""
Examples:
  # Create visualization from all tiles
  python scripts/visualize_ml_tiles.py --input-dir ml_ready_tiles --output visualization.png
  
  # Visualize only first 10 tiles with smaller size
  python scripts/visualize_ml_tiles.py --input-dir ml_ready_tiles --output viz.png --max-tiles 10 --tile-size 256
  
  # Large high-quality visualization
  python scripts/visualize_ml_tiles.py --input-dir ml_ready_tiles --output viz_hq.png --tile-size 768
		""",
	)

	parser.add_argument(
		'--input-dir',
		type=str,
		default='ml_ready_tiles',
		help='Input directory containing exported tiles (default: ml_ready_tiles)',
	)
	parser.add_argument(
		'--output',
		type=str,
		default='ml_tiles_visualization.png',
		help='Output PNG file path (default: ml_tiles_visualization.png)',
	)
	parser.add_argument(
		'--tile-size',
		type=int,
		default=512,
		help='Size to resize each tile to in pixels (default: 512)',
	)
	parser.add_argument(
		'--spacing',
		type=int,
		default=10,
		help='Spacing between tiles in pixels (default: 10)',
	)
	parser.add_argument(
		'--max-tiles',
		type=int,
		help='Maximum number of tiles to visualize (optional, shows all by default)',
	)
	parser.add_argument(
		'--font-size',
		type=int,
		default=20,
		help='Font size for labels (default: 20)',
	)

	args = parser.parse_args()

	# Find tile sets
	input_dir = Path(args.input_dir)
	if not input_dir.exists():
		print(f'❌ Error: Input directory does not exist: {input_dir}')
		return 1

	print(f'📁 Input directory: {input_dir}')
	tile_sets = find_tile_sets(input_dir)

	if not tile_sets:
		print('❌ No complete tile sets found (need RGB + deadwood + forestcover)')
		return 1

	print(f'✓ Found {len(tile_sets)} complete tile sets')

	# Limit tiles if requested
	if args.max_tiles and args.max_tiles < len(tile_sets):
		print(f'ℹ️  Limiting to first {args.max_tiles} tiles')
		tile_sets = tile_sets[: args.max_tiles]

	# Create visualization
	visualization = create_tile_visualization(
		tile_sets,
		tile_size=args.tile_size,
		spacing=args.spacing,
		font_size=args.font_size,
	)

	# Save to file
	output_path = Path(args.output)
	print(f'💾 Saving to: {output_path}')

	img = Image.fromarray(visualization)
	img.save(output_path, 'PNG', optimize=False)

	print(f'✅ Visualization saved!')
	print(f'   Size: {visualization.shape[1]}x{visualization.shape[0]} pixels')
	print(f'   File: {output_path}')
	print(f'   Tiles: {len(tile_sets)}')

	return 0


if __name__ == '__main__':
	exit(main())
