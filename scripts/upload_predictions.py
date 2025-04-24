from pathlib import Path
import pandas as pd
from deadtrees_cli.data import DataCommands
from tqdm import tqdm
import geopandas as gpd
from shared.settings import settings
from shared.db import use_client
from shared.models import LabelSourceEnum, LabelTypeEnum, LabelDataEnum
from typing import List, Optional

# Database path configuration
DATABASE_PATH = Path('/Users/januschvajna-jehle/projects/deadwood-upload-labels/data')
# File to track processed labels
PROCESSED_LABELS_FILE = Path('processed_predictions_remaining.txt')

DATA_FOLDER = 'deadwood_segmentation_predictions_full_120_remaining'

DELETE_EXISTING_PREDICTIONS = False


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
	return DATABASE_PATH / DATA_FOLDER / filename.replace('.tif', '_prediction.gpkg')


def get_available_layers(gpkg_path: Path) -> List[str]:
	"""Get available layers in a GeoPackage file

	Args:
	    gpkg_path: Path to the GeoPackage file

	Returns:
	    List[str]: List of layer names
	"""
	import fiona

	return fiona.listlayers(str(gpkg_path))


def check_existing_predictions(data_commands, dataset_id: int) -> Optional[int]:
	"""Check if existing model predictions exist for a dataset

	Args:
	    data_commands: DataCommands instance
	    dataset_id: Dataset ID

	Returns:
	    int: return label id if existing, None otherwise
	"""
	token = data_commands._ensure_auth()
	try:
		with use_client(token) as client:
			response = (
				client.table('v2_labels')
				.select('id')
				.eq('dataset_id', dataset_id)
				.eq('label_source', LabelSourceEnum.model_prediction.value)
				.eq('label_data', LabelDataEnum.deadwood.value)
				.execute()
			)
			if len(response.data) > 0:
				return response.data[0]['id']
			else:
				return None
	except Exception as e:
		print(f'Error checking existing predictions for dataset {dataset_id}: {str(e)}')
		return None


def delete_existing_prediction(data_commands, label_id: int) -> bool:
	"""Delete existing model predictions for a dataset

	Args:
	    data_commands: DataCommands instance
	    label_id: Label ID

	Returns:
	    bool: True if deletion was successful, False otherwise
	"""
	token = data_commands._ensure_auth()
	try:
		with use_client(token) as client:
			# Find labels from model predictions
			response = client.table('v2_labels').delete().eq('id', label_id).execute()
			print(f'Successfully deleted existing prediction label {label_id}')
			return True
	except Exception as e:
		print(f'Error deleting existing predictions for label {label_id}: {str(e)}')
		return False


def main():
	# Initialize DataCommands
	data_commands = DataCommands()

	# Read database metadata
	df = pd.read_csv(DATABASE_PATH / 'metadata_manual.copy.csv', dtype={'public': bool, 'has_labels': bool})

	# Filter only rows with labels
	# df = df[df['has_labels']]

	# Load set of already processed files - we'll ignore this for reuploading
	# processed_files = load_processed_files()
	processed_files = set()  # Empty set to process all files

	# Keep track of failed files
	failed_files = []
	skipped_files = []

	# Process each row
	for _, row in tqdm(df.iterrows(), total=df.shape[0]):
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
			# Delete existing model predictions for this dataset
			label_id = check_existing_predictions(row_data_commands, dataset_id)
			if label_id is not None:
				if DELETE_EXISTING_PREDICTIONS:
					delete_success = delete_existing_prediction(row_data_commands, label_id)
					if not delete_success:
						print(f"Failed to delete existing predictions for {row['filename']}")
						failed_files.append(row['filename'])
						continue
				else:
					print(
						f"Skipping upload for {row['filename']} - existing prediction found and DELETE_EXISTING_PREDICTIONS is False"
					)
					skipped_files.append(row['filename'])
					continue

			upload_success = False

			result = row_data_commands.upload_label_from_gpkg(
				dataset_id=dataset_id,
				gpkg_path=str(label_path),
				label_source=LabelSourceEnum.model_prediction.value,
				label_type=LabelTypeEnum.semantic_segmentation.value,
				label_data=LabelDataEnum.deadwood.value,  # Assuming all labels are deadwood
				label_quality=3,
				labels_layer=available_layers[0],
				aoi_layer=None,
			)
			upload_success = bool(result)
			if upload_success:
				print(f"Successfully uploaded labels for {row['filename']}")

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
		with open('failed_predictions_uploads.txt', 'w') as f:
			for file in failed_files:
				f.write(f'{file}\n')
		print("\nFailed uploads have been saved to 'failed_predictions_uploads.txt'")


if __name__ == '__main__':
	main()
