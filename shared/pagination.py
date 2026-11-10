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
