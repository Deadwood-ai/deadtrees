from __future__ import annotations

import json
from typing import Any, Dict, Optional

from supabase import Client, ClientOptions, create_client

from .config import Config


def get_supabase_client(cfg: Config) -> Client:
	if not cfg.supabase_url or not cfg.supabase_key:
		raise RuntimeError(
			"SUPABASE_URL / SUPABASE_SERVICE_KEY (oder SUPABASE_SERVICE_ROLE_KEY) fehlt. Bitte ENV setzen."
		)
	options = ClientOptions(auto_refresh_token=False)
	return create_client(cfg.supabase_url, cfg.supabase_key, options=options)


def parse_jsonish(value: Any) -> Any:
	"""Handle json/jsonb returned as dict/list or string."""
	if value is None:
		return None
	if isinstance(value, (dict, list)):
		return value
	if isinstance(value, str):
		s = value.strip()
		if (s.startswith("{") and s.endswith("}")) or (s.startswith("[") and s.endswith("]")):
			try:
				return json.loads(s)
			except Exception:
				return value
		return value
	return value


def fetch_publication_full_info(client: Client, publication_id: int) -> Dict[str, Any]:
	resp = (
		client.table("data_publication_full_info")
		.select("*")
		.eq("publication_id", publication_id)
		.limit(1)
		.execute()
	)
	data = resp.data[0] if resp.data else None
	if data is None:
		raise RuntimeError(f"Keine Daten gefunden für publication_id={publication_id}")

	for k in ("authors", "datasets"):
		if k in data:
			data[k] = parse_jsonish(data[k])

	if "doi" in data and isinstance(data["doi"], str):
		data["doi"] = data["doi"].strip()

	return data


def fetch_publication_row(client: Client, publication_id: int) -> Dict[str, Any]:
	resp = (
		client.table("data_publication")
		.select("id, title, doi, freidata_record_id, status, notified_at")
		.eq("id", publication_id)
		.limit(1)
		.execute()
	)
	data = resp.data[0] if resp.data else None
	if data is None:
		raise RuntimeError(f"Keine data_publication Zeile für id={publication_id}")
	if "doi" in data and isinstance(data["doi"], str):
		data["doi"] = data["doi"].strip()
	return data


def update_publication_row(client: Client, publication_id: int, fields: Dict[str, Any]) -> None:
	if not fields:
		return
	resp = client.table("data_publication").update(fields).eq("id", publication_id).execute()
	if hasattr(resp, "error") and resp.error:
		raise RuntimeError(f"DB update failed: {resp.error}")


def extract_doi_identifier(record: Dict[str, Any]) -> Optional[str]:
	pids = record.get("pids") or {}
	doi_info = pids.get("doi") or {}
	identifier = doi_info.get("identifier")
	if isinstance(identifier, str) and identifier.strip():
		return identifier.strip()
	return None
