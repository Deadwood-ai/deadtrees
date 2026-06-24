"""Backfill phenology metadata for datasets that currently have none.

Some datasets have no ``phenology`` entry in ``v2_metadata.metadata`` because the dataset
centroid landed on a masked MODIS pixel (coast/island/no-cycle area) and the old lookup gave
up. The lookup now falls back to the globally nearest valid pixel, so this script recomputes
phenology for the affected datasets and merges it into their existing metadata (GADM/biome are
left untouched).

Usage (from repo root, inside the processor environment / container):

    python -m scripts.backfill_phenology --dry-run            # report what would change
    python -m scripts.backfill_phenology                      # apply to all missing datasets
    python -m scripts.backfill_phenology --dataset-ids 214 310 756   # only these
    python -m scripts.backfill_phenology --limit 50           # cap how many are processed

The script authenticates as the processor user (PROCESSOR_USERNAME/PASSWORD), so it must run in
an environment where those credentials and the phenology asset are available.
"""

from __future__ import annotations

import argparse
import sys
from typing import Optional

from shared.db import login, use_client
from shared.models import Ortho
from shared.settings import settings
from shared.logger import logger
from processor.src.utils.phenology import get_phenology_metadata


def _missing_phenology_dataset_ids(client) -> list[int]:
	"""Return dataset_ids whose metadata row exists but has no 'phenology' key."""
	rows = client.table(settings.metadata_table).select('dataset_id, metadata').execute().data
	missing = []
	for row in rows:
		metadata = row.get('metadata') or {}
		if 'phenology' not in metadata:
			missing.append(row['dataset_id'])
	return missing


def backfill(dataset_ids: Optional[list[int]], dry_run: bool, limit: Optional[int]) -> int:
	"""Backfill phenology for the requested datasets. Returns the number updated."""
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

	with use_client(token) as client:
		targets = dataset_ids if dataset_ids else _missing_phenology_dataset_ids(client)

	if limit is not None:
		targets = targets[:limit]

	print(f'{len(targets)} dataset(s) to process{" (dry run)" if dry_run else ""}.')

	updated = 0
	skipped = 0
	for dataset_id in targets:
		# Refresh token periodically; cheap and avoids long-run expiry.
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		with use_client(token) as client:
			ortho_resp = client.table(settings.orthos_table).select('*').eq('dataset_id', dataset_id).execute()
			if not ortho_resp.data:
				print(f'  dataset {dataset_id}: no ortho row, skipping')
				skipped += 1
				continue
			ortho = Ortho(**ortho_resp.data[0])
			if not ortho.bbox:
				print(f'  dataset {dataset_id}: no bbox, skipping')
				skipped += 1
				continue

			lon = (ortho.bbox.left + ortho.bbox.right) / 2
			lat = (ortho.bbox.bottom + ortho.bbox.top) / 2

			phenology = get_phenology_metadata(lat=lat, lon=lon, dataset_id=dataset_id)
			if phenology is None:
				print(f'  dataset {dataset_id}: phenology still unavailable at ({lat:.4f}, {lon:.4f}), skipping')
				skipped += 1
				continue

			meta_resp = client.table(settings.metadata_table).select('metadata').eq('dataset_id', dataset_id).execute()
			if not meta_resp.data:
				print(f'  dataset {dataset_id}: no metadata row, skipping')
				skipped += 1
				continue
			metadata = meta_resp.data[0].get('metadata') or {}
			metadata['phenology'] = phenology.model_dump()

			if dry_run:
				print(f'  dataset {dataset_id}: would add phenology (centroid {lat:.4f}, {lon:.4f})')
			else:
				client.table(settings.metadata_table).update({'metadata': metadata}).eq(
					'dataset_id', dataset_id
				).execute()
				print(f'  dataset {dataset_id}: phenology added (centroid {lat:.4f}, {lon:.4f})')
			updated += 1

	print(f'Done. {updated} updated, {skipped} skipped.')
	return updated


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument('--dataset-ids', type=int, nargs='*', help='Only backfill these dataset ids.')
	parser.add_argument('--dry-run', action='store_true', help='Report changes without writing.')
	parser.add_argument('--limit', type=int, default=None, help='Process at most this many datasets.')
	args = parser.parse_args()

	try:
		backfill(args.dataset_ids, args.dry_run, args.limit)
	except Exception as exc:  # noqa: BLE001 - surface a clear message for an operator-run script
		logger.error(f'Phenology backfill failed: {exc}')
		print(f'ERROR: {exc}', file=sys.stderr)
		return 1
	return 0


if __name__ == '__main__':
	raise SystemExit(main())
