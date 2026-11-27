"""Paged reads for PostgREST queries."""

from typing import Callable, Dict, Iterator, List

# PostgREST caps every response at `max_rows` (1000, supabase/config.toml).
PAGE_SIZE = 1000


def iter_pages(build_query: Callable[[], object], page_size: int = PAGE_SIZE) -> Iterator[List[Dict]]:
	"""Yield every page of a deterministically ordered PostgREST query.

	`build_query` must return a fresh query with a stable order. Paging stops only at
	an empty page, so a server cap below `page_size` cannot truncate the result.
	"""
	offset = 0
	while True:
		page = build_query().range(offset, offset + page_size - 1).execute().data or []
		if not page:
			return
		yield page
		offset += len(page)


def fetch_all_rows(build_query: Callable[[], object], page_size: int = PAGE_SIZE) -> List[Dict]:
	"""Read every row of a deterministically ordered PostgREST query."""
	return [row for page in iter_pages(build_query, page_size) for row in page]


def iter_pages_by_id(
	build_query: Callable[[str], object], columns: str, page_size: int = PAGE_SIZE
) -> Iterator[List[Dict]]:
	"""Yield every page of one owner's rows in id order, where an index on (owner, id) exists
	(a dataset's CLIP tiles). `build_query(select)` must return a fresh query of the owner's rows
	selecting `select`; the pages hold `columns`.

	Each page is two reads: the next ids after the last one, which the index alone answers, then
	the rows from the first to the last of those ids. Asked for the rows after the last id
	directly, Postgres underestimated how many were left, read and sorted all of them for every
	page, and a dataset of 53,000 tiles ran past the statement timeout. An offset reads every
	earlier row again.
	"""
	last = None
	while True:
		query = build_query('id')
		if last is not None:
			query = query.gt('id', last)
		ids = [row['id'] for row in query.order('id').limit(page_size).execute().data or []]
		if not ids:
			return
		yield build_query(columns).gte('id', ids[0]).lte('id', ids[-1]).order('id').execute().data or []
		last = ids[-1]


def iter_pages_by_creation(build_query: Callable[[], object], page_size: int = PAGE_SIZE) -> Iterator[List[Dict]]:
	"""Yield every page of a PostgREST query in (created_at, id) order, continuing after the last row.

	For one owner's rows in a table of many million rows (a label's geometries). An offset
	sorts every earlier row again. Paging by id alone lets Postgres walk the primary key
	through other owners' rows, for minutes once the owner's rows end. No index covers
	(created_at, id), so each page reads the owner's rows through the owner's index and
	keeps only the next page in memory. `build_query` must return a fresh query that
	selects `created_at` and `id`.
	"""
	last = None
	while True:
		query = build_query()
		if last is not None:
			query = query.or_(f'created_at.gt."{last[0]}",and(created_at.eq."{last[0]}",id.gt.{last[1]})')
		page = query.order('created_at').order('id').limit(page_size).execute().data or []
		if not page:
			return
		yield page
		last = (page[-1]['created_at'], page[-1]['id'])
