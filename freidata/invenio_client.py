from __future__ import annotations

from typing import Any, Dict, List
from urllib.parse import quote

import requests


class InvenioClient:
	def __init__(self, base_url: str, token: str, request_timeout: int = 120, upload_timeout: int = 7200):
		self.base_url = base_url.rstrip("/")
		self.request_timeout = request_timeout
		self.upload_timeout = upload_timeout
		self.session = requests.Session()
		if token:
			self.session.headers.update({"Authorization": f"Bearer {token}"})

	def _url(self, path: str) -> str:
		if path.startswith("http://") or path.startswith("https://"):
			return path
		return f"{self.base_url}{path}"

	def request(self, method: str, path: str, **kwargs) -> requests.Response:
		url = self._url(path)
		timeout = kwargs.pop("timeout", self.request_timeout)
		return self.session.request(method, url, timeout=timeout, **kwargs)

	def require_ok(self, r: requests.Response, context: str) -> Dict[str, Any]:
		if not (200 <= r.status_code < 300):
			try:
				payload = r.json()
			except Exception:
				payload = r.text
			raise RuntimeError(f"{context} failed: HTTP {r.status_code}\n{payload}")
		if r.status_code == 204:
			return {}
		try:
			return r.json()
		except Exception:
			return {"raw": r.text}

	def create_draft(self, record_payload: Dict[str, Any]) -> Dict[str, Any]:
		r = self.request("POST", "/api/records", json=record_payload, headers={"Content-Type": "application/json"})
		return self.require_ok(r, "create_draft")

	def get_draft(self, record_id: str) -> Dict[str, Any]:
		r = self.request("GET", f"/api/records/{record_id}/draft")
		return self.require_ok(r, "get_draft")

	def reserve_doi(self, reserve_url_or_record_id: str) -> Dict[str, Any]:
		if reserve_url_or_record_id.startswith("http"):
			url = reserve_url_or_record_id
		else:
			url = self._url(f"/api/records/{reserve_url_or_record_id}/draft/pids/doi")

		r = self.session.post(url, timeout=60)
		if r.status_code == 405:
			r = self.session.put(url, timeout=60)
		return self.require_ok(r, "reserve_doi")

	def list_draft_files(self, record_id: str) -> Dict[str, Any]:
		r = self.request("GET", f"/api/records/{record_id}/draft/files")
		return self.require_ok(r, "list_draft_files")

	def delete_draft_file(self, record_id: str, key: str) -> None:
		key_q = quote(key, safe="")
		r = self.request("DELETE", f"/api/records/{record_id}/draft/files/{key_q}")
		if r.status_code != 204:
			self.require_ok(r, "delete_draft_file")

	def init_files(self, record_id: str, keys: List[str]) -> Dict[str, Any]:
		r = self.request(
			"POST",
			f"/api/records/{record_id}/draft/files",
			json=[{"key": k} for k in keys],
			headers={"Content-Type": "application/json"},
		)
		return self.require_ok(r, "init_files")

	def upload_file_content(self, record_id: str, key: str, filepath) -> Dict[str, Any]:
		with open(filepath, "rb") as f:
			r = self.request(
				"PUT",
				f"/api/records/{record_id}/draft/files/{key}/content",
				data=f,
				headers={"Content-Type": "application/octet-stream"},
				timeout=(60, self.upload_timeout),
			)
		return self.require_ok(r, f"upload_content:{key}")

	def commit_file(self, record_id: str, key: str) -> Dict[str, Any]:
		r = self.request("POST", f"/api/records/{record_id}/draft/files/{key}/commit")
		return self.require_ok(r, f"commit_file:{key}")

	def publish(self, record_id: str) -> Dict[str, Any]:
		r = self.request("POST", f"/api/records/{record_id}/draft/actions/publish")
		return self.require_ok(r, "publish")

	def search_communities(self, query: str, size: int = 10) -> Dict[str, Any]:
		r = self.request("GET", f"/api/communities?q={quote(query)}&size={size}")
		return self.require_ok(r, "search_communities")

	def set_community_review(self, record_id: str, community_id: str) -> Dict[str, Any]:
		payload = {
			"type": "community-submission",
			"receiver": {"community": community_id},
		}
		r = self.request(
			"PUT",
			f"/api/records/{record_id}/draft/review",
			json=payload,
			headers={"Content-Type": "application/json"},
		)
		return self.require_ok(r, "set_community_review")

	def submit_review(self, record_id: str) -> Dict[str, Any]:
		r = self.request("POST", f"/api/records/{record_id}/draft/actions/submit-review")
		return self.require_ok(r, "submit_review")
