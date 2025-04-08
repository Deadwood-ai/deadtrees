#!/usr/bin/env python3
"""
Script to upload files from a downloaded archive to the deadtrees platform.
The script strips UUIDs from filenames and uses metadata from a CSV file.
"""

import os
from pathlib import Path
import pandas as pd
import re
from deadtrees_cli.data import DataCommands
from tqdm import tqdm
from shared.db import use_client
from shared.settings import settings

# File paths configuration
ARCHIVE_PATH = Path('/Users/januschvajna-jehle/projects/deadwood-upload-labels/data/uploads-via-platform/archive')
DATASETS_CSV = Path(
	'/Users/januschvajna-jehle/projects/deadwood-upload-labels/data/uploads-via-platform/v1_datasets_rows_uploded.csv'
)
METADATA_CSV = Path(
	'/Users/januschvajna-jehle/projects/deadwood-upload-labels/data/uploads-via-platform/v1_metadata_rows_uploads.csv'
)


def strip_uuid_from_filename(filename: str) -> str:
	"""
	Remove UUID from filename (format: uuid_actualfilename)

	Args:
	    filename: Original filename with UUID prefix

	Returns:
	    str: Filename with UUID removed
	"""
	# UUID pattern is a hyphen-separated string at the beginning followed by underscore
	uuid_pattern = r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_'
	return re.sub(uuid_pattern, '', filename)


def file_exists_in_db(data_commands, filename: str) -> bool:
	"""
	Check if a file already exists in the database

	Args:
	    data_commands: DataCommands instance for auth token
	    filename: Name of the file to check

	Returns:
	    bool: True if file exists, False otherwise
	"""
	try:
		# Get auth token from data_commands
		token = data_commands._ensure_auth()

		# Query the datasets table
		with use_client(token) as client:
			response = client.table(settings.datasets_table).select('id').eq('file_name', filename).execute()
			return len(response.data) > 0
	except Exception as e:
		print(f'Error checking file existence: {str(e)}')
		return False


def main():
	# Initialize DataCommands for file existence checks
	data_commands = DataCommands()

	# Read datasets and metadata CSV files
	print('Reading CSV files...')
	datasets_df = pd.read_csv(DATASETS_CSV)
	metadata_df = pd.read_csv(METADATA_CSV)

	# Verify that the archive directory exists
	if not ARCHIVE_PATH.exists():
		print(f'Archive directory {ARCHIVE_PATH} does not exist. Creating it...')
		ARCHIVE_PATH.mkdir(parents=True, exist_ok=True)

	# Get list of files in the archive
	archive_files = list(ARCHIVE_PATH.glob('*.tif'))
	if not archive_files:
		print(f'No .tif files found in {ARCHIVE_PATH}')
		return

	print(f'Found {len(archive_files)} files in the archive')

	# Keep track of processed files
	processed_files = []
	failed_files = []
	skipped_files = []
	processing_failed = []

	# Process each file in the archive
	for file_path in tqdm(archive_files, desc='Processing files'):
		# Create new DataCommands instance for each file to ensure fresh token
		file_data_commands = DataCommands()

		# Get the pure filename (without UUID)
		original_filename = file_path.name
		# clean_filename = strip_uuid_from_filename(original_filename)

		# Check if this file already exists in the database
		if file_exists_in_db(data_commands, original_filename):
			print(f'Skipping {original_filename} - already exists in database')
			skipped_files.append(original_filename)
			continue

		# Find matching row in datasets_df to get dataset_id and file_alias
		dataset_row = datasets_df[datasets_df['file_alias'] == original_filename]
		if dataset_row.empty:
			print(f'No dataset information found for {original_filename}')
			failed_files.append(original_filename)
			continue

		dataset_id = dataset_row['id'].iloc[0]
		file_alias = dataset_row['file_alias'].iloc[0]

		# Find matching metadata in metadata_df based on dataset_id
		metadata_row = metadata_df[metadata_df['dataset_id'] == dataset_id]
		if metadata_row.empty:
			print(f'No metadata found for dataset ID {dataset_id}')
			failed_files.append(original_filename)
			continue

		# Extract metadata
		metadata = metadata_row.iloc[0]

		# Prepare parameters
		authors = str(metadata['authors']).split('and')
		platform = metadata['platform']
		license_value = metadata['license'] if pd.notna(metadata['license']) else 'CC BY'
		data_access = metadata['data_access'] if pd.notna(metadata['data_access']) else 'public'

		# Handle acquisition dates
		acquisition_year = int(metadata['aquisition_year']) if pd.notna(metadata['aquisition_year']) else None
		acquisition_month = int(metadata['aquisition_month']) if pd.notna(metadata['aquisition_month']) else None
		acquisition_day = int(metadata['aquisition_day']) if pd.notna(metadata['aquisition_day']) else None

		# Additional metadata
		additional_info = metadata['additional_information'] if pd.notna(metadata['additional_information']) else None
		citation_doi = metadata['citation_doi'] if pd.notna(metadata['citation_doi']) else None

		try:
			print(f'Uploading {original_filename}...')

			# Upload the dataset with metadata
			result = file_data_commands.upload(
				file_path=str(file_path),
				authors=authors,
				platform=platform,
				license=license_value,
				data_access=data_access,
				aquisition_year=acquisition_year,
				aquisition_month=acquisition_month,
				aquisition_day=acquisition_day,
				additional_information=additional_info,
				citation_doi=citation_doi,
			)

			if result:
				new_dataset_id = result['id']
				print(f'Successfully uploaded {original_filename} with dataset ID: {new_dataset_id}')

				# Start processing tasks
				try:
					process_result = file_data_commands.process(
						dataset_id=new_dataset_id,
						task_types=['geotiff', 'metadata', 'cog', 'thumbnail', 'deadwood'],
						priority=3,
					)
					print(f'Started processing tasks for dataset {new_dataset_id}')
					processed_files.append(original_filename)
				except Exception as e:
					print(f'Error starting processing for {new_dataset_id}: {str(e)}')
					processing_failed.append((original_filename, new_dataset_id))
			else:
				print(f'Failed to upload {original_filename}')
				failed_files.append(original_filename)

		except Exception as e:
			print(f'Error processing {original_filename}: {str(e)}')
			failed_files.append(original_filename)
			continue

	# Print summary
	print('\nUpload Summary:')
	print(f'Successfully processed: {len(processed_files)} files')
	print(f'Failed uploads: {len(failed_files)} files')
	print(f'Failed processing starts: {len(processing_failed)} files')
	print(f'Skipped (already exists): {len(skipped_files)} files')

	# Save failed files to resume later if needed
	if failed_files:
		with open('failed_uploads_upload_from_platform.txt', 'w') as f:
			for file in failed_files:
				f.write(f'{file}\n')
		print("\nFailed uploads have been saved to 'failed_uploads_upload_from_platform.txt'")

	if processing_failed:
		with open('failed_processing_upload_from_platform.txt', 'w') as f:
			for file, dataset_id in processing_failed:
				f.write(f'{file},{dataset_id}\n')
		print("\nFailed processing starts have been saved to 'failed_processing_upload_from_platform.txt'")


if __name__ == '__main__':
	main()
