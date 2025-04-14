#!/usr/bin/env python3
"""
Script to rerun deadwood segmentation for a list of datasets specified in a CSV file.
"""

from pathlib import Path
import pandas as pd
import sys
from tqdm import tqdm
from deadtrees_cli.data import DataCommands
from shared.models import TaskTypeEnum
from shared.logger import logger

# Configuration constants
BASE_PATH = Path('/Users/januschvajna-jehle/projects/deadwood-upload-labels/data')
CSV_PATH = BASE_PATH / 'rerun_segmentation/rerun_deadwood_segmentation.csv'
FORCE_REPROCESS = False  # Set to True to reprocess already processed datasets
PRIORITY = 2  # Processing priority (1-5, where 1 is highest)

# File to track processed datasets
PROCESSED_FILE = BASE_PATH / 'rerun_segmentation/rerun_segmentation_processed.txt'
FAILED_FILE = BASE_PATH / 'rerun_segmentation/rerun_segmentation_failed.txt'


def load_processed_datasets() -> set:
	"""Load the set of already processed dataset IDs from disk.

	Returns:
	    set: Set of dataset IDs that have already been processed
	"""
	if PROCESSED_FILE.exists():
		with open(PROCESSED_FILE, 'r') as f:
			return {int(line.strip()) for line in f if line.strip().isdigit()}
	return set()


def mark_as_processed(dataset_id: int):
	"""Mark a dataset as successfully processed.

	Args:
	    dataset_id: ID of the dataset that was processed
	"""
	with open(PROCESSED_FILE, 'a') as f:
		f.write(f'{dataset_id}\n')


def mark_as_failed(dataset_id: int, reason: str):
	"""Mark a dataset as failed and record the reason.

	Args:
	    dataset_id: ID of the dataset that failed
	    reason: Reason for failure
	"""
	with open(FAILED_FILE, 'a') as f:
		f.write(f'{dataset_id}: {reason}\n')


def rerun_segmentation(dataset_ids: list, skip_processed: bool = True, priority: int = 2):
	"""Rerun deadwood segmentation for a list of dataset IDs.

	Args:
	    dataset_ids: List of dataset IDs to process
	    skip_processed: Whether to skip already processed datasets
	    priority: Processing priority (1-5, where 5 is highest)
	"""
	# Initialize DataCommands
	data_commands = DataCommands()

	# Load set of already processed datasets if skipping
	processed_datasets = load_processed_datasets() if skip_processed else set()

	# Stats counters
	successful = 0
	failed = 0
	skipped = 0

	# Process each dataset ID
	for dataset_id in tqdm(dataset_ids, desc='Processing datasets'):
		# Skip if already processed and skip_processed is True
		if dataset_id in processed_datasets and skip_processed:
			logger.info(f'Skipping dataset {dataset_id} - already processed')
			skipped += 1
			continue

		try:
			# Create a fresh DataCommands instance for each dataset
			# to ensure we have a valid token
			row_data_commands = DataCommands()

			# Start the deadwood segmentation task
			result = row_data_commands.process(
				dataset_id=dataset_id, task_types=[TaskTypeEnum.deadwood.value], priority=priority
			)

			if result:
				logger.info(f'Successfully started deadwood segmentation for dataset {dataset_id}')
				mark_as_processed(dataset_id)
				successful += 1
			else:
				logger.error(f'Failed to start processing for dataset {dataset_id}')
				mark_as_failed(dataset_id, 'Failed to start processing')
				failed += 1

		except Exception as e:
			logger.error(f'Error processing dataset {dataset_id}: {str(e)}')
			mark_as_failed(dataset_id, str(e))
			failed += 1

	# Print summary
	print('\nSegmentation Processing Summary:')
	print(f'Successfully started: {successful} datasets')
	print(f'Failed: {failed} datasets')
	print(f'Skipped (already processed): {skipped} datasets')

	if failed > 0:
		print(f"\nFailed datasets have been saved to '{FAILED_FILE}'")


def main():
	try:
		# Validate CSV file exists
		if not CSV_PATH.exists():
			print(f'Error: CSV file not found at {CSV_PATH}')
			sys.exit(1)

		# Read CSV file
		df = pd.read_csv(CSV_PATH)

		# Check if 'id' column exists
		if 'id' not in df.columns:
			print("Error: CSV file must contain an 'id' column with dataset IDs")
			sys.exit(1)

		# Extract dataset IDs
		dataset_ids = df['id'].tolist()

		if not dataset_ids:
			print('Error: No dataset IDs found in the CSV file')
			sys.exit(1)

		print(f'Found {len(dataset_ids)} datasets to process')

		# Run the segmentation process
		rerun_segmentation(dataset_ids=dataset_ids, skip_processed=not FORCE_REPROCESS, priority=PRIORITY)

	except Exception as e:
		print(f'Error: {str(e)}')
		sys.exit(1)


if __name__ == '__main__':
	main()
