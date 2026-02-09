"""
Sync FreiData review status back to the local database.

Checks all publications that are `in_review` on FreiData:
- If the review was accepted and the record is published → update DB with DOI + published status
- If the review was declined → mark as declined
- Otherwise → leave as in_review (still pending community decision)
"""
from __future__ import annotations

import datetime as dt
from typing import Any, Dict, List

from supabase import Client

from .config import Config
from .db import extract_doi_identifier, update_publication_row
from .invenio_client import InvenioClient
from .notify import notify_declined, notify_published


def fetch_in_review_publications(db: Client) -> List[Dict[str, Any]]:
	"""Return all publications that are in_review and have a freidata_record_id."""
	resp = (
		db.table("data_publication")
		.select("id, title, freidata_record_id, status, doi")
		.eq("status", "in_review")
		.not_.is_("freidata_record_id", "null")
		.execute()
	)
	return resp.data or []


def sync_one(client: InvenioClient, db: Client, pub: Dict[str, Any], cfg: Config | None = None) -> str:
	"""
	Check a single in_review publication against FreiData.

	Returns a short status label: 'published', 'declined', 'in_review' (unchanged), or 'error'.
	"""
	pub_id = pub["id"]
	record_id = pub["freidata_record_id"]
	title_short = (pub.get("title") or "")[:60]

	# 1. Try fetching the published record (exists only after review accepted)
	published = client.get_published_record(record_id)
	if published and published.get("is_published"):
		doi = extract_doi_identifier(published)
		update_fields: Dict[str, Any] = {
			"status": "published",
			"published_at": dt.datetime.now(dt.timezone.utc).isoformat(),
		}
		if doi:
			update_fields["doi"] = doi

		update_publication_row(db, pub_id, update_fields)
		print(f"  [PUBLISHED] #{pub_id} '{title_short}' → DOI={doi or '(none yet)'}")

		if cfg:
			notify_published(cfg, pub_id=pub_id, title=title_short, record_id=record_id, doi=doi)
		return "published"

	# 2. Record not published yet — check the review request status
	try:
		review = client.get_review(record_id)
	except Exception as e:
		# Draft may no longer exist (deleted externally?)
		print(f"  [WARN] #{pub_id} could not fetch review: {e}")
		return "error"

	if review is None:
		# No review request exists — unusual for in_review status
		print(f"  [WARN] #{pub_id} '{title_short}' has no review request on FreiData")
		return "in_review"

	review_status = review.get("status", "").lower()

	if review_status == "declined":
		update_publication_row(db, pub_id, {"status": "declined"})
		print(f"  [DECLINED] #{pub_id} '{title_short}'")
		if cfg:
			notify_declined(cfg, pub_id=pub_id, title=title_short, record_id=record_id, review_status="declined")
		return "declined"

	if review_status in ("cancelled", "expired"):
		update_publication_row(db, pub_id, {"status": "declined"})
		print(f"  [{review_status.upper()}] #{pub_id} '{title_short}' → marked as declined")
		if cfg:
			notify_declined(cfg, pub_id=pub_id, title=title_short, record_id=record_id, review_status=review_status)
		return "declined"

	# Still in review (status: created, submitted, etc.)
	print(f"  [IN_REVIEW] #{pub_id} '{title_short}' (review_status={review_status})")
	return "in_review"


def sync_all(client: InvenioClient, db: Client, cfg: Config | None = None) -> Dict[str, int]:
	"""
	Sync all in_review publications. Returns a summary dict of counts.
	"""
	pubs = fetch_in_review_publications(db)
	if not pubs:
		print("[sync] No publications in_review to check.")
		return {}

	print(f"[sync] Checking {len(pubs)} publication(s) in_review...")
	counts: Dict[str, int] = {}
	for pub in pubs:
		result = sync_one(client, db, pub, cfg=cfg)
		counts[result] = counts.get(result, 0) + 1

	print(f"[sync] Done: {counts}")
	return counts
