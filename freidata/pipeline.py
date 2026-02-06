from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

from supabase import Client

from .config import Config
from .db import (
	extract_doi_identifier,
	fetch_publication_full_info,
	fetch_publication_row,
	update_publication_row,
)
from .download import download_publication_datasets
from .invenio_client import InvenioClient
from .state import load_state, save_state
from .zip_utils import clean_zip, list_zip_files, validate_zips_against_db


PUBLISHER_FIXED = "deadtrees.earth, Chair of Sensor-based Geoinformatics, University of Freiburg"


def normalize_author(a: Dict[str, Any]) -> Dict[str, Any]:
	first = (a.get("first_name") or "").strip()
	last = (a.get("last_name") or "").strip()
	org = (a.get("organisation") or "").strip()
	orcid = (a.get("orcid") or "").strip()

	person_or_org: Dict[str, Any] = {
		"type": "personal",
		"given_name": first or "Unknown",
		"family_name": last or "Unknown",
	}
	if orcid:
		person_or_org["identifiers"] = [{"scheme": "orcid", "identifier": orcid}]

	creator: Dict[str, Any] = {"person_or_org": person_or_org}
	if org:
		creator["affiliations"] = [{"name": org}]
	return creator


def build_record_payload(pub: Dict[str, Any]) -> Dict[str, Any]:
	title = (pub.get("title") or "").strip()
	description = (pub.get("description") or "").strip()

	authors = pub.get("authors") or []
	creators: List[Dict[str, Any]] = []
	if isinstance(authors, list):
		for a in authors:
			if isinstance(a, dict):
				creators.append(normalize_author(a))

	if not creators:
		creators = [{
			"person_or_org": {
				"type": "organizational",
				"name": "deadtrees.earth",
			}
		}]

	publication_date = dt.date.today().isoformat()

	md: Dict[str, Any] = {
		"resource_type": {"id": "dataset"},
		"title": title,
		"publication_date": publication_date,
		"creators": creators,
		"description": description,
		"publisher": PUBLISHER_FIXED,
	}

	md["rights"] = [{"id": "cc-by-4.0"}]

	payload: Dict[str, Any] = {
		"metadata": md,
		"files": {"enabled": True},
		"access": {"record": "public", "files": "public"},
	}
	return payload


def stop_if(cfg: Config, label: str) -> None:
	if cfg.stop_after and cfg.stop_after.strip().lower() == label:
		print(f"[STOP_AFTER={label}] stopping here.")
		sys.exit(0)


def is_review_already_open_error(err: Exception) -> bool:
	msg = str(err).lower()
	return (
		"open review cannot be deleted" in msg
		or "already under review" in msg
		or "review already exists" in msg
		or "already submitted" in msg
	)


def run_publication(cfg: Config, db: Client, folder: Path, publication_id: int) -> None:
	pub_row = fetch_publication_row(db, publication_id)
	if pub_row.get("doi"):
		print(f"[INFO] DOI bereits vorhanden für publication_id={publication_id} -> nichts zu tun.")
		return

	update_publication_row(db, publication_id, {"status": "uploading"})

	print("[1/7] Fetch publication info from DB...")
	pub = fetch_publication_full_info(db, publication_id)
	print(f"publication_id={pub.get('publication_id')}  title={pub.get('title')!r}")
	stop_if(cfg, "db")

	print("[2/7] Build InvenioRDM record payload...")
	record_payload = build_record_payload(pub)
	print(json.dumps(record_payload, indent=2, ensure_ascii=False))
	stop_if(cfg, "metadata")

	if cfg.auto_download:
		print("[3/7] Download datasets via API...")
		download_publication_datasets(cfg, db, folder, publication_id)
		stop_if(cfg, "download")
	else:
		print("[3/7] AUTO_DOWNLOAD=0 (skipping download, using existing ZIPs)")

	print("[4/7] Check ZIPs in folder...")
	zip_paths = list_zip_files(folder)
	for z in zip_paths:
		print(f" - {z.name}")
	validate_zips_against_db(zip_paths, pub)

	upload_paths = zip_paths
	if cfg.clean_zips:
		print("[5/7] Cleaning ZIPs...")
		cleaned_dir = folder / "cleaned"
		cleaned_dir.mkdir(exist_ok=True)
		new_paths: List[Path] = []
		for zp in zip_paths:
			out_zip = zp if cfg.clean_inplace else (cleaned_dir / zp.name)
			ok, msg = clean_zip(zp, out_zip)
			print(("OK  " if ok else "FAIL") + " " + msg)
			if not ok:
				raise RuntimeError(msg)
			new_paths.append(out_zip)
		upload_paths = new_paths
	else:
		print("[5/7] CLEAN_ZIPS=0 (skip cleaning).")

	stop_if(cfg, "zips")

	if not cfg.freidata_token:
		raise RuntimeError(
			"FREIDATA_TOKEN fehlt. Setze z.B.:\n"
			"  export FREIDATA_TOKEN='…'\n"
			"Dann Script erneut starten."
		)

	client = InvenioClient(cfg.freidata_base_url, cfg.freidata_token, upload_timeout=cfg.upload_timeout)

	state = load_state(folder)
	record_id = state.get("record_id") or pub_row.get("freidata_record_id")

	if record_id and not state.get("record_id"):
		state["record_id"] = record_id
		save_state(folder, state)

	if record_id:
		print(f"[6/7] Reuse existing draft record_id={record_id}")
		draft = client.get_draft(record_id)
	else:
		print("[6/7] Create draft on FreiData...")
		draft = client.create_draft(record_payload)
		record_id = draft["id"]
		state["record_id"] = record_id
		save_state(folder, state)
		update_publication_row(db, publication_id, {"freidata_record_id": record_id})

	print(f"Draft ID: {record_id}")
	print(f"Draft HTML: {draft.get('links', {}).get('self_html')}")
	print(f"Draft API : {draft.get('links', {}).get('self')}")

	pids = draft.get("pids") or {}
	doi_info = pids.get("doi")

	if doi_info and doi_info.get("identifier"):
		print(f"[INFO] DOI existiert bereits für diesen Draft: {doi_info.get('identifier')}")
	else:
		reserve_link = draft.get("links", {}).get("reserve_doi")
		if reserve_link:
			print("Reserve DOI (best-effort)…")
			doi_resp = client.reserve_doi(reserve_link)
			state["doi_response"] = doi_resp
			save_state(folder, state)
			print("DOI response:", json.dumps(doi_resp, indent=2, ensure_ascii=False))
		else:
			print("[WARN] Kein links.reserve_doi im Draft gefunden (Instanz-spezifisch).")

	stop_if(cfg, "draft")

	print("[7/7] Upload ZIP files sequentially...")
	keys = [p.name for p in upload_paths]

	files_info = client.list_draft_files(record_id)
	entries = files_info.get("entries") or []
	existing = {e.get("key"): e for e in entries if isinstance(e, dict) and e.get("key")}

	# Remove stale files from prior runs (different keys than current upload)
	stale_keys = [k for k in existing if k not in keys]
	if stale_keys:
		print(f"Removing {len(stale_keys)} stale file(s) from draft...")
		for k in stale_keys:
			print(f"  [DELETE] {k}")
			client.delete_draft_file(record_id, k)
			existing.pop(k, None)

	if cfg.overwrite_files:
		for k in list(existing.keys()):
			if k in keys:
				print(f"[OVERWRITE] Deleting existing draft file: {k}")
				client.delete_draft_file(record_id, k)
				existing.pop(k, None)

	to_init = [k for k in keys if k not in existing]
	if to_init:
		print(f"Init {len(to_init)} new file key(s)...")
		client.init_files(record_id, to_init)
	else:
		print("No new file keys to init.")

	files_info = client.list_draft_files(record_id)
	entries = files_info.get("entries") or []
	existing = {e.get("key"): e for e in entries if isinstance(e, dict) and e.get("key")}

	max_upload_attempts = 3
	for p in upload_paths:
		key = p.name
		local_size = p.stat().st_size
		entry = existing.get(key)
		status = (entry or {}).get("status")

		if (not cfg.overwrite_files) and status == "completed":
			# Verify the existing file has the correct size
			remote_size = (entry or {}).get("size")
			if remote_size is not None and remote_size != local_size:
				print(f"[SIZE MISMATCH] {key}: remote={remote_size}, local={local_size}. Re-uploading...")
				client.delete_draft_file(record_id, key)
				client.init_files(record_id, [key])
			else:
				print(f"[SKIP] {key} already completed in draft ({local_size} bytes).")
				continue

		for attempt in range(1, max_upload_attempts + 1):
			print(f"Upload {key} ({local_size:,} bytes)... attempt {attempt}/{max_upload_attempts}")
			client.upload_file_content(record_id, key, p)
			client.commit_file(record_id, key)

			# Verify committed file size matches local
			file_entry = client.get_file_entry(record_id, key)
			remote_size = file_entry.get("size")
			if remote_size is not None and remote_size != local_size:
				print(f"[WARN] Size mismatch after commit: remote={remote_size:,}, local={local_size:,}")
				if attempt < max_upload_attempts:
					print(f"  Deleting and retrying...")
					client.delete_draft_file(record_id, key)
					client.init_files(record_id, [key])
					continue
				else:
					raise RuntimeError(
						f"Upload failed after {max_upload_attempts} attempts: "
						f"{key} size mismatch (remote={remote_size:,}, local={local_size:,})"
					)
			else:
				print(f"Committed {key} (verified: {remote_size:,} bytes)")
				break

	stop_if(cfg, "upload")

	if cfg.create_community_review:
		print("Find community via /api/communities ...")
		comms = client.search_communities(cfg.community_query, size=10)
		hits = comms.get("hits", {}).get("hits", [])
		if not hits:
			raise RuntimeError(f"Keine Community gefunden für query={cfg.community_query!r}")
		community_id = hits[0].get("id")
		if not community_id:
			raise RuntimeError("Community hit ohne id (unerwartet).")

		review_already_open = False
		print(f"Set community review to community_id={community_id} ...")
		try:
			r = client.set_community_review(record_id, community_id)
			state["community_review"] = r
			save_state(folder, state)
		except Exception as e:
			if is_review_already_open_error(e):
				print("[INFO] Review already open; skipping review setup.")
				review_already_open = True
			else:
				raise

		if cfg.submit_community_review and not review_already_open:
			print("Submit community review request ...")
			try:
				r2 = client.submit_review(record_id)
				state["community_review_submitted"] = r2
				save_state(folder, state)
				update_publication_row(db, publication_id, {"status": "in_review"})
			except Exception as e:
				if is_review_already_open_error(e):
					print("[INFO] Review already submitted; skipping submit.")
					review_already_open = True
				else:
					raise

		if review_already_open:
			update_publication_row(db, publication_id, {"status": "in_review"})

	publish_allowed = cfg.publish
	if cfg.create_community_review and cfg.submit_community_review and cfg.publish:
		print("[WARN] Review submitted -> skipping publish (publish after accept).")
		publish_allowed = False

	if publish_allowed:
		print("PUBLISH=1 -> publishing draft ...")
		published = client.publish(record_id)
		print("Published:", json.dumps(published, indent=2, ensure_ascii=False))
		print("Record HTML:", published.get("links", {}).get("self_html"))
		doi_identifier = extract_doi_identifier(published) or extract_doi_identifier(draft)
		update_fields: Dict[str, Any] = {"status": "published"}
		if doi_identifier:
			update_fields["doi"] = doi_identifier
		update_publication_row(db, publication_id, update_fields)
	else:
		print("PUBLISH=0 -> done (draft bleibt unveröffentlicht).")
		print(f"Du kannst den Draft jetzt in der UI prüfen: {draft.get('links', {}).get('self_html')}")
		print("Zum Publish später: export PUBLISH=1 und Script erneut laufen lassen.")


def run_publication_safe(cfg: Config, db: Client, folder: Path, publication_id: int) -> None:
	try:
		run_publication(cfg, db, folder, publication_id)
	except Exception:
		try:
			update_publication_row(db, publication_id, {"status": "error"})
		except Exception:
			pass
		raise
