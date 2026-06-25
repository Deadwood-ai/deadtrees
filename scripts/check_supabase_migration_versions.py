#!/usr/bin/env python3
"""Guard Supabase migration filenames against local and production collisions."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


MIGRATION_RE = re.compile(r'^(?P<version>\d{14})_[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$')
MIGRATION_DIR = Path('supabase/migrations')


@dataclass(frozen=True)
class ChangedMigration:
	status: str
	path: Path
	version: str
	kind: str


def run_git(args: list[str]) -> str:
	result = subprocess.run(['git', *args], check=True, capture_output=True, text=True)
	return result.stdout


def migration_version(path: Path) -> str | None:
	match = MIGRATION_RE.match(path.name)
	if not match:
		return None
	return match.group('version')


def invalid_changed_migration_message(path: Path) -> str:
	return (
		f'Invalid changed migration filename: {path}. Expected '
		'<14-digit timestamp>_<description>.sql, for example '
		'20260625093000_add_example_table.sql.'
	)


def check_all_migration_filenames(migrations_dir: Path) -> list[str]:
	"""Validate the full migration directory so old hygiene drift blocks new migration work early."""
	errors: list[str] = []
	versions: dict[str, Path] = {}

	for path in sorted(migrations_dir.glob('*.sql')):
		version = migration_version(path)
		if version is None:
			errors.append(
				f'Invalid migration filename: {path}. Expected '
				'<14-digit timestamp>_<description>.sql, for example '
				'20260625093000_add_example_table.sql.'
			)
			continue

		previous = versions.get(version)
		if previous is not None:
			errors.append(
				f'Duplicate migration version {version}: {previous} and {path}. '
				'Supabase migration versions must be unique.'
			)
		else:
			versions[version] = path

	return errors


def changed_migration_version(path: Path, errors: list[str]) -> str | None:
	version = migration_version(path)
	if version is None and path.suffix == '.sql':
		errors.append(invalid_changed_migration_message(path))
	return version


def parse_changed_migrations(
	migrations_dir: Path, base_ref: str, head_ref: str
) -> tuple[list[ChangedMigration], list[str]]:
	diff_output = run_git(
		[
			'diff',
			'--name-status',
			'--find-renames',
			f'{base_ref}...{head_ref}',
			'--',
			str(migrations_dir),
		]
	)
	changes: list[ChangedMigration] = []
	errors: list[str] = []

	for line in diff_output.splitlines():
		if not line.strip():
			continue

		parts = line.split('\t')
		status = parts[0]

		if status.startswith('R') or status.startswith('C'):
			if len(parts) != 3:
				raise ValueError(f'Unexpected git diff rename/copy line: {line}')
			old_path = Path(parts[1])
			new_path = Path(parts[2])
			old_version = changed_migration_version(old_path, errors)
			new_version = changed_migration_version(new_path, errors)
			if old_version is not None:
				changes.append(ChangedMigration(status, old_path, old_version, 'existing'))
			if new_version is not None:
				changes.append(ChangedMigration(status, new_path, new_version, 'new'))
			continue

		if len(parts) != 2:
			raise ValueError(f'Unexpected git diff line: {line}')

		path = Path(parts[1])
		version = changed_migration_version(path, errors)
		if version is None:
			continue

		kind = 'new' if status == 'A' else 'existing'
		changes.append(ChangedMigration(status, path, version, kind))

	return changes, errors


def parse_changed_migrations_from_pr_files(
	migrations_dir: Path, pr_files: list[dict[str, str]]
) -> tuple[list[ChangedMigration], list[str]]:
	changes: list[ChangedMigration] = []
	errors: list[str] = []
	migration_prefix = f'{migrations_dir.as_posix().rstrip("/")}/'

	for pr_file in pr_files:
		status = pr_file.get('status', '')
		filename = pr_file.get('filename', '')
		previous_filename = pr_file.get('previous_filename')
		filename_is_migration = filename.startswith(migration_prefix)
		previous_is_migration = bool(previous_filename and previous_filename.startswith(migration_prefix))

		if not filename_is_migration and not previous_is_migration:
			continue

		path = Path(filename)
		if status == 'renamed' and previous_filename:
			if previous_is_migration:
				previous_path = Path(previous_filename)
				previous_version = changed_migration_version(previous_path, errors)
				if previous_version is not None:
					changes.append(ChangedMigration(status, previous_path, previous_version, 'existing'))
			if filename_is_migration:
				version = changed_migration_version(path, errors)
				if version is not None:
					changes.append(ChangedMigration(status, path, version, 'new'))
			continue

		if filename_is_migration:
			version = changed_migration_version(path, errors)
			if version is not None:
				kind = 'new' if status in {'added', 'copied'} else 'existing'
				changes.append(ChangedMigration(status, path, version, kind))

	return changes, errors


def check_changed_migrations(changes: list[ChangedMigration], latest_applied_version: str | None) -> list[str]:
	errors: list[str] = []

	if not latest_applied_version:
		return errors

	if not re.fullmatch(r'\d{14}', latest_applied_version):
		return [f'Invalid latest applied production migration version: {latest_applied_version!r}.']

	for change in changes:
		if change.kind == 'new' and change.version <= latest_applied_version:
			errors.append(
				f'New migration {change.path} has version {change.version}, but production '
				f'has already applied migrations through {latest_applied_version}. Create a '
				'new migration with a later timestamp.'
			)
		elif change.kind == 'existing' and change.version <= latest_applied_version:
			errors.append(
				f'Migration {change.path} has version {change.version}, which is already '
				'applied in production. Do not modify, rename, or delete applied migrations; '
				'add a new follow-up migration instead.'
			)

	return errors


def print_result(errors: list[str], changes: list[ChangedMigration]) -> int:
	if errors:
		print('Supabase migration version check failed:', file=sys.stderr)
		for error in errors:
			print(f'- {error}', file=sys.stderr)
		return 1

	if changes:
		changed_paths = ', '.join(str(change.path) for change in changes)
		print(f'Supabase migration version check passed for changed migrations: {changed_paths}')
	else:
		print('Supabase migration version check passed; no migration files changed.')
	return 0


def parse_args() -> argparse.Namespace:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument('--migrations-dir', type=Path, default=MIGRATION_DIR)
	parser.add_argument('--base-ref', help='Base git ref for PR diff checks.')
	parser.add_argument('--head-ref', default='HEAD', help='Head git ref for PR diff checks.')
	parser.add_argument(
		'--latest-applied-version',
		help='Latest version from supabase_migrations.schema_migrations on the target database.',
	)
	parser.add_argument(
		'--changed-files-json',
		type=Path,
		help='GitHub pull request files API JSON. Used by trusted pull_request_target workflows.',
	)
	return parser.parse_args()


def main() -> int:
	args = parse_args()
	print(f'Checking all migration filenames in {args.migrations_dir}.')
	errors = check_all_migration_filenames(args.migrations_dir)
	changes: list[ChangedMigration] = []

	if args.changed_files_json:
		with args.changed_files_json.open() as file:
			pr_files = json.load(file)
		changes, changed_errors = parse_changed_migrations_from_pr_files(args.migrations_dir, pr_files)
		errors.extend(changed_errors)
		errors.extend(check_changed_migrations(changes, args.latest_applied_version))
	elif args.base_ref:
		changes, changed_errors = parse_changed_migrations(args.migrations_dir, args.base_ref, args.head_ref)
		errors.extend(changed_errors)
		errors.extend(check_changed_migrations(changes, args.latest_applied_version))

	return print_result(errors, changes)


if __name__ == '__main__':
	raise SystemExit(main())
