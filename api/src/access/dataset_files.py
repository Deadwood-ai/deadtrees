"""Locate a dataset's current COG and thumbnail under their stable storage paths."""

from pathlib import Path
from typing import Optional

from shared.settings import settings

FILE_COLUMNS = {
	'cog': (settings.cogs_table, 'cog_path'),
	'thumbnail': (settings.thumbnails_table, 'thumbnail_path'),
}


def inside(root: Path, relative_path: str) -> Optional[Path]:
	"""Resolve a stored relative path below root, refusing anything that escapes it."""
	if not relative_path:
		return None
	candidate = (root / relative_path).resolve()
	root_resolved = root.resolve()
	if candidate == root_resolved or root_resolved not in candidate.parents:
		return None
	return candidate


def stored_file_path(client, kind: str, dataset_id: int) -> Optional[str]:
	"""Relative path of the dataset's current file of this kind."""
	table, column = FILE_COLUMNS[kind]
	rows = client.table(table).select(column).eq('dataset_id', dataset_id).execute().data
	return rows[0].get(column) if rows else None


def find_dataset_file(kind: str, relative_path: str) -> Optional[Path]:
	directory = {'cog': settings.COG_DIR, 'thumbnail': settings.THUMBNAIL_DIR}[kind]
	path = inside(settings.base_path / directory, relative_path)
	return path if path and path.is_file() else None
