from pathlib import Path
import pandas as pd
from deadtrees_cli.data import DataCommands
from tqdm import tqdm
import geopandas as gpd
from shared.settings import settings
from shared.db import use_client
from shared.models import LabelSourceEnum, LabelTypeEnum, LabelDataEnum
from typing import List

# Database path configuration
DATABASE_PATH = Path('/Users/januschvajna-jehle/projects/deadwood-upload-labels/data')
# File to track processed labels
PROCESSED_LABELS_FILE = Path('processed_stale_aois.txt')


def load_processed_files() -> set:
	"""Load the set of already processed files from disk

	Returns:
	    set: Set of filenames that have already been processed
	"""
	if PROCESSED_LABELS_FILE.exists():
		with open(PROCESSED_LABELS_FILE, 'r') as f:
			return set(line.strip() for line in f)
	return set()


def get_dataset_id(data_commands, filename: str) -> int:
	"""Get the dataset ID for a given orthophoto filename

	Args:
	    filename: Name of the orthophoto file

	Returns:
	    int: Dataset ID
	"""
	token = data_commands._ensure_auth()
	with use_client(token) as client:
		response = client.table(settings.datasets_table).select('id').eq('file_name', filename).execute()
		if len(response.data) == 0:
			return None
		else:
			return response.data[0]['id']


def mark_as_processed(filename: str):
	"""Mark a file as successfully processed by appending to the processed files list

	Args:
	    filename: Name of the file that was processed
	"""
	with open(PROCESSED_LABELS_FILE, 'a') as f:
		f.write(f'{filename}\n')


def get_label_files(filename: str) -> Path:
	"""Get the path to the label files for a given orthophoto filename

	Args:
	    filename: Name of the orthophoto file

	Returns:
	    Path: Path to the label GeoPackage file
	"""
	return DATABASE_PATH / 'stale_aois' / filename.replace('.tif', '_polygons.gpkg')


def get_available_layers(gpkg_path: Path) -> List[str]:
	"""Get available layers in a GeoPackage file

	Args:
	    gpkg_path: Path to the GeoPackage file

	Returns:
	    List[str]: List of layer names
	"""
	import fiona

	return fiona.listlayers(str(gpkg_path))


def main():
	# Initialize DataCommands
	data_commands = DataCommands()

	# Read database metadata
	df = pd.read_csv(DATABASE_PATH / 'metadata_manual.copy.csv', dtype={'public': bool, 'has_labels': bool})

	# Filter only rows with labels
	# df = df[df['has_labels']]

	# Load set of already processed files
	processed_files = load_processed_files()

	# Keep track of failed files
	failed_files = []
	skipped_files = []

	# Process each row
	for _, row in tqdm(df.iterrows(), total=df.shape[0]):
		# Skip if already processed
		if row['filename'] in processed_files:
			print(f"Skipping {row['filename']} - already processed")
			skipped_files.append(row['filename'])
			continue

		# Create new DataCommands instance for each row to ensure fresh token
		row_data_commands = DataCommands()

		# Get label file path
		label_path = get_label_files(row['filename'])

		if not label_path.exists():
			print(f"Skipping {row['filename']} - label file not found")
			skipped_files.append(row['filename'])
			continue

		dataset_id = get_dataset_id(row_data_commands, row['filename'])
		if dataset_id is None:
			print(f"Skipping {row['filename']} - dataset ID not found")
			skipped_files.append(row['filename'])
			continue

		# Check available layers in the GeoPackage
		available_layers = get_available_layers(label_path)
		print(f"Available layers in {row['filename']}: {available_layers}")

		try:
			upload_success = False

			# Check if we have labels layer
			if 'standing_deadwood' in available_layers:
				# Try uploading labels (which will also upload AOI if present)
				# clean data (switzerland plots)
				aoi_note = None
				if row['label_source'] == 'visual_interpretation/circles':
					row['label_source'] = 'visual_interpretation'
					row['label_type'] = 'point_observation'
				if row['label_source'] == 'visual_interpretation/lidar_derived':
					row['label_source'] = 'visual_interpretation'
					aoi_note = 'Lidar derived'
				if row['filename'] == 'berchtesgarten_rgb_2020.tif':
					row['label_source'] = 'visual_interpretation'
					row['label_type'] = 'point_observation'

				result = row_data_commands.upload_label_from_gpkg(
					dataset_id=dataset_id,
					gpkg_path=str(label_path),
					label_source=row['label_source'],
					label_type=row['label_type'],
					label_data='deadwood',  # Assuming all labels are deadwood
					label_quality=row['label_quality'],
					labels_layer='standing_deadwood',
					aoi_layer='aoi',
					aoi_notes=aoi_note,
				)
				upload_success = bool(result)
				if upload_success:
					print(f"Successfully uploaded labels for {row['filename']}")

			# If no labels were uploaded but we have an AOI layer, try uploading just the AOI
			elif 'aoi' in available_layers:
				result = row_data_commands.upload_aoi_from_gpkg(
					dataset_id=dataset_id,
					gpkg_path=str(label_path),
					aoi_layer='aoi',
					aoi_image_quality=row.get('aoi_image_quality', None),  # Add this column to your CSV if available
					aoi_notes=None,  # Add this column to your CSV if you want to include notes
				)
				upload_success = bool(result)
				if upload_success:
					print(f"Successfully uploaded AOI for {row['filename']}")

			if upload_success:
				mark_as_processed(row['filename'])
			else:
				print(f"Failed to upload data for {row['filename']}")
				failed_files.append(row['filename'])

		except Exception as e:
			print(f"Error processing file {row['filename']}: {str(e)}")
			failed_files.append(row['filename'])
			continue

	# Print summary
	print('\nLabel Upload Summary:')
	print(f'Successfully processed: {len(processed_files)} files')
	print(f'Failed uploads: {len(failed_files)} files')
	print(f'Skipped (already processed or missing files): {len(skipped_files)} files')

	# Save failed files to resume later if needed
	if failed_files:
		with open('failed_stale_aois_uploads.txt', 'w') as f:
			for file in failed_files:
				f.write(f'{file}\n')
		print("\nFailed uploads have been saved to 'failed_stale_aois_uploads.txt'")


if __name__ == '__main__':
	main()
