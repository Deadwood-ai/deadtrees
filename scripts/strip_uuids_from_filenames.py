#!/usr/bin/env python3
"""
Script to strip UUIDs from filenames in a directory.
A UUID follows the pattern: 8-4-4-4-12 hexadecimal characters.
"""

import os
import re
from pathlib import Path
import argparse
import shutil


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


def main():
	parser = argparse.ArgumentParser(description='Strip UUIDs from filenames')
	parser.add_argument('directory', help='Directory containing files to process')
	parser.add_argument(
		'--dry-run', action='store_true', help='Show what would be done without actually renaming files'
	)
	parser.add_argument('--copy', action='store_true', help='Copy files instead of renaming them')
	parser.add_argument('--dest', help='Destination directory for copied files (required if --copy is used)')

	args = parser.parse_args()

	# Ensure directory exists
	source_dir = Path(args.directory)
	if not source_dir.exists() or not source_dir.is_dir():
		print(f'Error: {args.directory} is not a valid directory')
		return

	# If copying, ensure destination directory exists
	if args.copy:
		if not args.dest:
			print('Error: --dest is required when using --copy')
			return

		dest_dir = Path(args.dest)
		if not dest_dir.exists():
			if args.dry_run:
				print(f'Would create directory: {dest_dir}')
			else:
				print(f'Creating directory: {dest_dir}')
				dest_dir.mkdir(parents=True, exist_ok=True)

	# Get all files in the directory
	files = list(source_dir.glob('*'))

	renamed_count = 0
	skipped_count = 0

	for file_path in files:
		if file_path.is_file():
			original_name = file_path.name
			new_name = strip_uuid_from_filename(original_name)

			# Skip if no UUID was found
			if original_name == new_name:
				print(f'Skipping (no UUID): {original_name}')
				skipped_count += 1
				continue

			if args.copy:
				new_path = dest_dir / new_name
				if args.dry_run:
					print(f'Would copy: {original_name} -> {new_path}')
				else:
					print(f'Copying: {original_name} -> {new_path}')
					shutil.copy2(file_path, new_path)
			else:
				new_path = file_path.parent / new_name
				if args.dry_run:
					print(f'Would rename: {original_name} -> {new_name}')
				else:
					print(f'Renaming: {original_name} -> {new_name}')
					# Check if destination file already exists
					if new_path.exists():
						print(f'  Warning: {new_name} already exists, skipping')
						skipped_count += 1
						continue
					file_path.rename(new_path)

			renamed_count += 1

	print(f'\nSummary: {renamed_count} files processed, {skipped_count} files skipped')


if __name__ == '__main__':
	main()
