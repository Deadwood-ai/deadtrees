import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.check_supabase_migration_versions import (
	ChangedMigration,
	check_all_migration_filenames,
	check_changed_migrations,
	parse_changed_migrations,
	parse_changed_migrations_from_pr_files,
)


class SupabaseMigrationVersionCheckTest(unittest.TestCase):
	def test_rejects_duplicate_migration_versions(self) -> None:
		with tempfile.TemporaryDirectory() as temp_dir:
			migrations = Path(temp_dir) / 'migrations'
			migrations.mkdir()
			(migrations / '20260625090000_first.sql').write_text('select 1;\n')
			(migrations / '20260625090000_second.sql').write_text('select 2;\n')

			errors = check_all_migration_filenames(migrations)

		self.assertTrue(any('Duplicate migration version 20260625090000' in error for error in errors))

	def test_rejects_new_migration_older_than_production(self) -> None:
		changes = [
			ChangedMigration(
				status='A',
				path=Path('supabase/migrations/20260619073000_add-aoi-status.sql'),
				version='20260619073000',
				kind='new',
			)
		]

		errors = check_changed_migrations(changes, latest_applied_version='20260620000000')

		self.assertEqual(
			errors,
			[
				'New migration supabase/migrations/20260619073000_add-aoi-status.sql has version '
				'20260619073000, but production has already applied migrations through 20260620000000. '
				'Create a new migration with a later timestamp.'
			],
		)

	def test_rejects_modifying_already_applied_migration(self) -> None:
		changes = [
			ChangedMigration(
				status='M',
				path=Path('supabase/migrations/20260619073000_add-aoi-status.sql'),
				version='20260619073000',
				kind='existing',
			)
		]

		errors = check_changed_migrations(changes, latest_applied_version='20260620000000')

		self.assertEqual(
			errors,
			[
				'Migration supabase/migrations/20260619073000_add-aoi-status.sql has version '
				'20260619073000, which is already applied in production. Do not modify, rename, or '
				'delete applied migrations; add a new follow-up migration instead.'
			],
		)

	def test_accepts_new_migration_newer_than_production(self) -> None:
		changes = [
			ChangedMigration(
				status='A',
				path=Path('supabase/migrations/20260625093000_add-example.sql'),
				version='20260625093000',
				kind='new',
			)
		]

		self.assertEqual(check_changed_migrations(changes, latest_applied_version='20260620000000'), [])

	def test_accepts_empty_latest_applied_version(self) -> None:
		changes = [
			ChangedMigration(
				status='A',
				path=Path('supabase/migrations/20260625093000_add-example.sql'),
				version='20260625093000',
				kind='new',
			)
		]

		self.assertEqual(check_changed_migrations(changes, latest_applied_version=None), [])

	def test_rejects_malformed_latest_applied_version(self) -> None:
		changes = [
			ChangedMigration(
				status='A',
				path=Path('supabase/migrations/20260625093000_add-example.sql'),
				version='20260625093000',
				kind='new',
			)
		]

		self.assertEqual(
			check_changed_migrations(changes, latest_applied_version='not-a-version'),
			["Invalid latest applied production migration version: 'not-a-version'."],
		)

	def test_parses_added_modified_and_renamed_migrations(self) -> None:
		diff_output = '\n'.join(
			[
				'A\tsupabase/migrations/20260625093000_add-example.sql',
				'M\tsupabase/migrations/20260619073000_existing.sql',
				'R100\tsupabase/migrations/20260619073100_old.sql\tsupabase/migrations/20260625100000_new.sql',
			]
		)

		with patch('scripts.check_supabase_migration_versions.run_git', return_value=diff_output):
			changes, errors = parse_changed_migrations(Path('supabase/migrations'), 'origin/main', 'HEAD')

		self.assertEqual(errors, [])
		self.assertEqual(
			changes,
			[
				ChangedMigration(
					status='A',
					path=Path('supabase/migrations/20260625093000_add-example.sql'),
					version='20260625093000',
					kind='new',
				),
				ChangedMigration(
					status='M',
					path=Path('supabase/migrations/20260619073000_existing.sql'),
					version='20260619073000',
					kind='existing',
				),
				ChangedMigration(
					status='R100',
					path=Path('supabase/migrations/20260619073100_old.sql'),
					version='20260619073100',
					kind='existing',
				),
				ChangedMigration(
					status='R100',
					path=Path('supabase/migrations/20260625100000_new.sql'),
					version='20260625100000',
					kind='new',
				),
			],
		)

	def test_rejects_invalid_changed_sql_migration_filename(self) -> None:
		diff_output = 'A\tsupabase/migrations/not_a_timestamp.sql'

		with patch('scripts.check_supabase_migration_versions.run_git', return_value=diff_output):
			changes, errors = parse_changed_migrations(Path('supabase/migrations'), 'origin/main', 'HEAD')

		self.assertEqual(changes, [])
		self.assertEqual(
			errors,
			[
				'Invalid changed migration filename: supabase/migrations/not_a_timestamp.sql. Expected '
				'<14-digit timestamp>_<description>.sql, for example '
				'20260625093000_add_example_table.sql.'
			],
		)

	def test_parses_github_pr_files_without_fetching_pr_code(self) -> None:
		pr_files = [
			{
				'status': 'added',
				'filename': 'supabase/migrations/20260625093000_add-example.sql',
			},
			{
				'status': 'renamed',
				'filename': 'supabase/migrations/20260625100000_new.sql',
				'previous_filename': 'supabase/migrations/20260619073100_old.sql',
			},
			{
				'status': 'modified',
				'filename': 'README.md',
			},
		]

		changes, errors = parse_changed_migrations_from_pr_files(Path('supabase/migrations'), pr_files)

		self.assertEqual(errors, [])
		self.assertEqual(
			changes,
			[
				ChangedMigration(
					status='added',
					path=Path('supabase/migrations/20260625093000_add-example.sql'),
					version='20260625093000',
					kind='new',
				),
				ChangedMigration(
					status='renamed',
					path=Path('supabase/migrations/20260619073100_old.sql'),
					version='20260619073100',
					kind='existing',
				),
				ChangedMigration(
					status='renamed',
					path=Path('supabase/migrations/20260625100000_new.sql'),
					version='20260625100000',
					kind='new',
				),
			],
		)

	def test_pr_files_parser_handles_renames_into_migrations(self) -> None:
		pr_files = [
			{
				'status': 'renamed',
				'filename': 'supabase/migrations/20260625100000_new.sql',
				'previous_filename': 'docs/schema.sql',
			}
		]

		changes, errors = parse_changed_migrations_from_pr_files(Path('supabase/migrations'), pr_files)

		self.assertEqual(errors, [])
		self.assertEqual(
			changes,
			[
				ChangedMigration(
					status='renamed',
					path=Path('supabase/migrations/20260625100000_new.sql'),
					version='20260625100000',
					kind='new',
				)
			],
		)

	def test_pr_files_parser_handles_renames_out_of_migrations(self) -> None:
		pr_files = [
			{
				'status': 'renamed',
				'filename': 'docs/old.sql',
				'previous_filename': 'supabase/migrations/20260619073100_old.sql',
			}
		]

		changes, errors = parse_changed_migrations_from_pr_files(Path('supabase/migrations'), pr_files)

		self.assertEqual(errors, [])
		self.assertEqual(
			changes,
			[
				ChangedMigration(
					status='renamed',
					path=Path('supabase/migrations/20260619073100_old.sql'),
					version='20260619073100',
					kind='existing',
				)
			],
		)


if __name__ == '__main__':
	unittest.main()
