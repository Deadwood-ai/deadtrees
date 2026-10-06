"""One-time cleanup of duplicate datasets that predate the upload block.

New uploads of a file that is already on the platform are rejected (see
shared/upload_duplicates.py). This tool handles what was uploaded before. It
never changes the database: it prints SQL for an operator to review and run.

Run inside the API container on the storage server, which has both the files
and database access:

	python /app/api/src/upload/existing_duplicates.py backfill-zips > backfill.sql
	python /app/api/src/upload/existing_duplicates.py plan --out plan.json > archive.sql
	python /app/api/src/upload/existing_duplicates.py notify --plan plan.json [--send]

backfill-zips  fingerprints raw-image ZIPs uploaded before fingerprints were
               stored, so they block re-uploads and take part in `plan`.
plan           groups non-archived datasets that hold the same file, confirms
               each group by hashing the files in full, and keeps one dataset:
               not excluded by audit before excluded, public or view-only
               before private, then the oldest. The rest go into the archive SQL.
notify         after the archive SQL has run, sends each owner one summary
               e-mail (owners who switched processing e-mails off get none).
               Without --send it only reports what would be sent.
"""

import argparse
from collections import defaultdict
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Callable, Iterable, Optional

from shared.db import use_service_client
from shared.hash import get_file_identifier
from shared.notifications.email import send_email
from shared.notifications.templates import duplicates_archived_email
from shared.settings import settings

PAGE_SIZE = 1000
ZIP_NAME = re.compile(r'^(\d+)\.zip$')


@dataclass(frozen=True)
class DuplicateCandidate:
	"""A non-archived dataset and the files it holds, by fingerprint."""

	id: int
	user_id: str
	file_name: str
	created_at: str
	is_private: bool
	is_excluded: bool
	has_error: bool
	is_published: bool
	files: dict[str, Path]


def sha256_of_file(path: Path) -> Optional[str]:
	"""Full-content hash, or None when the file is not on disk."""
	if not path.is_file():
		return None
	hasher = hashlib.sha256()
	with path.open('rb') as file:
		while block := file.read(8 * 1024 * 1024):
			hasher.update(block)
	return hasher.hexdigest()


def plan_duplicate_groups(
	candidates: Iterable[DuplicateCandidate], full_hash: Callable[[Path], Optional[str]]
) -> list[dict]:
	"""Decide per shared fingerprint which dataset stays and which copies are archived.

	The fingerprint only samples a file, so a copy is archived only when
	`full_hash` proves it identical to the kept file; other copies are listed
	as `unconfirmed` and left alone. A group gets a `review` reason, and must
	not be archived automatically, when archiving would lose something the
	kept dataset does not have.
	"""
	holders: dict[str, list[DuplicateCandidate]] = defaultdict(list)
	for candidate in candidates:
		for fingerprint in candidate.files:
			holders[fingerprint].append(candidate)

	groups = []
	archived_ids: set[int] = set()
	for fingerprint in sorted(holders):
		members = [member for member in holders[fingerprint] if member.id not in archived_ids]
		if len(members) < 2:
			continue
		members.sort(key=lambda member: (member.is_excluded, member.is_private, member.created_at, member.id))
		keep, copies = members[0], members[1:]
		kept_hash = full_hash(keep.files[fingerprint])
		confirmed = [
			copy for copy in copies if kept_hash is not None and full_hash(copy.files[fingerprint]) == kept_hash
		]

		review = None
		if any(copy.is_published for copy in confirmed):
			review = 'a copy is part of a data publication'
		elif keep.has_error and not all(copy.has_error for copy in confirmed):
			review = 'the kept dataset failed processing while a copy did not'
		if not review:
			archived_ids.update(copy.id for copy in confirmed)

		groups.append(
			{
				'fingerprint': fingerprint,
				'keep': {'id': keep.id, 'user_id': keep.user_id, 'is_private': keep.is_private},
				'archive': [
					{'id': copy.id, 'user_id': copy.user_id, 'file_name': copy.file_name} for copy in confirmed
				],
				'unconfirmed': [copy.id for copy in copies if copy not in confirmed],
				'review': review,
			}
		)
	return groups


def archive_sql(groups: list[dict]) -> str:
	ids = sorted(copy['id'] for group in groups if not group['review'] for copy in group['archive'])
	if not ids:
		return '-- No confirmed duplicates to archive.\n'
	return (
		'begin;\n'
		f'update public.v2_datasets set archived = true where not archived and id in ({", ".join(map(str, ids))});\n'
		f'-- Expect at most {len(ids)} rows. Check the count, then run: commit;\n'
	)


def owner_summaries(groups: list[dict], archived_ids: set[int]) -> dict[str, list[dict]]:
	"""Per owner, the archived copies and the kept dataset where that owner may know it."""
	summaries: dict[str, list[dict]] = defaultdict(list)
	for group in groups:
		keep = group['keep']
		for copy in group['archive']:
			if copy['id'] not in archived_ids:
				continue
			keep_is_visible = keep['user_id'] == copy['user_id'] or not keep['is_private']
			summaries[copy['user_id']].append(
				{
					'id': copy['id'],
					'file_name': copy['file_name'],
					'kept_dataset_id': keep['id'] if keep_is_visible else None,
				}
			)
	return dict(summaries)


def _select_all(client, table: str, columns: str, order: str) -> list[dict]:
	rows: list[dict] = []
	while True:
		page = (
			client.table(table).select(columns).order(order).range(len(rows), len(rows) + PAGE_SIZE - 1).execute().data
		)
		rows.extend(page)
		if len(page) < PAGE_SIZE:
			return rows


def _load_candidates(client) -> list[DuplicateCandidate]:
	datasets = _select_all(
		client, settings.datasets_table, 'id,user_id,file_name,created_at,data_access,archived,upload_fingerprint', 'id'
	)
	ortho_fingerprints = {
		row['dataset_id']: row['sha256']
		for row in _select_all(client, settings.orthos_table, 'dataset_id,sha256', 'dataset_id')
	}
	zip_uploads = {
		row['dataset_id'] for row in _select_all(client, settings.raw_images_table, 'dataset_id', 'dataset_id')
	}
	excluded = {
		row['dataset_id']
		for row in _select_all(client, 'dataset_audit', 'dataset_id,final_assessment', 'dataset_id')
		if row['final_assessment'] == 'exclude_completely'
	}
	failed = {
		row['dataset_id']
		for row in _select_all(client, settings.statuses_table, 'dataset_id,has_error', 'dataset_id')
		if row['has_error']
	}
	published = {
		row['dataset_id'] for row in _select_all(client, 'jt_data_publication_datasets', 'dataset_id', 'dataset_id')
	}

	candidates = []
	for dataset in datasets:
		if dataset['archived']:
			continue
		dataset_id = dataset['id']
		ortho_path = settings.archive_path / f'{dataset_id}_ortho.tif'
		files = {}
		if ortho_fingerprints.get(dataset_id):
			files[ortho_fingerprints[dataset_id]] = ortho_path
		if dataset['upload_fingerprint']:
			is_zip = dataset_id in zip_uploads
			files[dataset['upload_fingerprint']] = (
				settings.raw_images_path / f'{dataset_id}.zip' if is_zip else ortho_path
			)
		if files:
			candidates.append(
				DuplicateCandidate(
					id=dataset_id,
					user_id=dataset['user_id'],
					file_name=dataset['file_name'],
					created_at=dataset['created_at'],
					is_private=dataset['data_access'] == 'private',
					is_excluded=dataset_id in excluded,
					has_error=dataset_id in failed,
					is_published=dataset_id in published,
					files=files,
				)
			)
	return candidates


def backfill_zips() -> int:
	with use_service_client() as client:
		zip_uploads = {
			row['dataset_id'] for row in _select_all(client, settings.raw_images_table, 'dataset_id', 'dataset_id')
		}
	on_disk = set()
	print('begin;')
	for zip_path in sorted(settings.raw_images_path.glob('*.zip')):
		match = ZIP_NAME.match(zip_path.name)
		if not match or int(match.group(1)) not in zip_uploads:
			continue
		dataset_id = int(match.group(1))
		on_disk.add(dataset_id)
		print(
			f"update public.v2_datasets set upload_fingerprint = '{get_file_identifier(zip_path)}' "
			f'where id = {dataset_id} and upload_fingerprint is null;'
		)
	print(f'-- {len(on_disk)} ZIP uploads fingerprinted. Check, then run: commit;')
	missing = sorted(zip_uploads - on_disk)
	print(f'{len(missing)} ZIP uploads have no file on disk and stay without a fingerprint: {missing}', file=sys.stderr)
	return 0


def plan(out: Path) -> int:
	with use_service_client() as client:
		candidates = _load_candidates(client)
	groups = plan_duplicate_groups(candidates, sha256_of_file)
	out.write_text(json.dumps({'groups': groups}, indent='\t'))
	print(archive_sql(groups), end='')
	to_archive = sum(len(group['archive']) for group in groups if not group['review'])
	print(
		f'{len(groups)} groups: {to_archive} datasets to archive, '
		f'{sum(1 for group in groups if group["review"])} groups need a manual decision, '
		f'{sum(len(group["unconfirmed"]) for group in groups)} copies not confirmed as identical. Details: {out}',
		file=sys.stderr,
	)
	return 0


def notify(plan_path: Path, send: bool) -> int:
	groups = json.loads(plan_path.read_text())['groups']
	planned_ids = [copy['id'] for group in groups for copy in group['archive']]
	with use_service_client() as client:
		archived_ids = {
			row['id']
			for start in range(0, len(planned_ids), 200)
			for row in client.table(settings.datasets_table)
			.select('id')
			.in_('id', planned_ids[start : start + 200])
			.eq('archived', True)
			.execute()
			.data
		}
		summaries = owner_summaries(groups, archived_ids)
		opted_out = {
			row['user_id']
			for row in client.table(settings.notification_preferences_table)
			.select('user_id,processing_emails_enabled')
			.in_('user_id', list(summaries))
			.execute()
			.data
			if not row['processing_emails_enabled']
		}
		failures = 0
		for user_id, datasets in sorted(summaries.items()):
			if user_id in opted_out:
				print(f'{user_id}: {len(datasets)} archived datasets, e-mails switched off, skipped')
				continue
			if not send:
				print(f'{user_id}: {len(datasets)} archived datasets, would be notified')
				continue
			email = client.auth.admin.get_user_by_id(user_id).user.email
			subject, text_body, html_body = duplicates_archived_email(datasets)
			dataset_ids = ','.join(str(dataset['id']) for dataset in datasets)
			result = send_email(
				email,
				subject,
				html_body,
				text_body=text_body,
				idempotency_key=hashlib.sha256(f'duplicates-archived:{user_id}:{dataset_ids}'.encode()).hexdigest(),
			)
			failures += not result['success']
			print(f'{user_id}: {len(datasets)} archived datasets, {"sent" if result["success"] else "FAILED"}')
	return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	commands = parser.add_subparsers(dest='command', required=True)
	commands.add_parser('backfill-zips')
	plan_parser = commands.add_parser('plan')
	plan_parser.add_argument('--out', type=Path, required=True, help='Where to write the plan (JSON)')
	notify_parser = commands.add_parser('notify')
	notify_parser.add_argument('--plan', type=Path, required=True, help='The plan the archive SQL came from')
	notify_parser.add_argument('--send', action='store_true', help='Send the e-mails instead of listing them')
	args = parser.parse_args(argv)

	if args.command == 'backfill-zips':
		return backfill_zips()
	if args.command == 'plan':
		return plan(args.out)
	return notify(args.plan, args.send)


if __name__ == '__main__':
	sys.exit(main())
