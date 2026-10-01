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
