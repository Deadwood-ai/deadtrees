"""
Zulip notifications for the FreiData publication lifecycle.

Posts status updates to the configured Zulip stream/topic whenever a
publication changes state (submitted, published, declined, error).
"""
from __future__ import annotations

import datetime as dt
from typing import Any, Dict, Optional

import httpx

from .config import Config


# ---------------------------------------------------------------------------
# Low-level Zulip poster (mirrors api/src/automation/daily_summary.py)
# ---------------------------------------------------------------------------

def post_to_zulip(cfg: Config, message: str) -> bool:
	"""Post a message to the configured Zulip stream/topic.

	Returns True on success, False if Zulip is not configured or the request failed.
	"""
	if not cfg.zulip_email or not cfg.zulip_api_key or not cfg.zulip_site:
		print("[zulip] Not configured (ZULIP_EMAIL / ZULIP_API_KEY / ZULIP_SITE missing). Skipping notification.")
		return False

	url = f"{cfg.zulip_site}/api/v1/messages"
	data = {
		"type": "stream",
		"to": cfg.zulip_stream,
		"topic": cfg.zulip_topic,
		"content": message,
	}

	try:
		with httpx.Client(timeout=30) as client:
			response = client.post(
				url,
				data=data,
				auth=(cfg.zulip_email, cfg.zulip_api_key),
			)
			if response.status_code == 200:
				result = response.json()
				if result.get("result") == "success":
					print(f"[zulip] Posted to {cfg.zulip_stream} > {cfg.zulip_topic}")
					return True
				else:
					print(f"[zulip] API error: {result}")
					return False
			else:
				print(f"[zulip] HTTP {response.status_code}: {response.text[:200]}")
				return False
	except Exception as e:
		print(f"[zulip] Failed to post: {e}")
		return False


# ---------------------------------------------------------------------------
# FreiData URL helpers
# ---------------------------------------------------------------------------

def _freidata_record_url(base_url: str, record_id: str) -> str:
	"""Build the public URL for a FreiData record."""
	return f"{base_url}/records/{record_id}"


def _freidata_draft_url(base_url: str, record_id: str) -> str:
	"""Build the draft-edit URL for a FreiData record."""
	return f"{base_url}/uploads/{record_id}"


def _freidata_request_url(base_url: str, request_id: str) -> str:
	"""Build the review-request URL for a FreiData community submission."""
	return f"{base_url}/me/requests/{request_id}"


# ---------------------------------------------------------------------------
# Message formatters
# ---------------------------------------------------------------------------

def _pub_header(pub_id: int, title: str) -> str:
	return f"**#{pub_id}** — {title}"


def notify_submitted_for_review(
	cfg: Config,
	pub_id: int,
	title: str,
	record_id: str,
	dataset_count: int,
	zip_names: list[str] | None = None,
	request_id: Optional[str] = None,
) -> bool:
	"""Notify that a publication was uploaded and submitted for community review."""
	if request_id:
		url = _freidata_request_url(cfg.freidata_base_url, request_id)
		link_label = "Review request"
	else:
		url = _freidata_draft_url(cfg.freidata_base_url, record_id)
		link_label = "FreiData draft"
	lines = [
		f"### Submitted for Review",
		"",
		_pub_header(pub_id, title),
		"",
		f"| Detail | Value |",
		f"|--------|-------|",
		f"| Datasets | {dataset_count} |",
		f"| {link_label} | [View on FreiData]({url}) |",
	]
	if zip_names:
		files_str = ", ".join(f"`{z}`" for z in zip_names[:5])
		if len(zip_names) > 5:
			files_str += f" (+{len(zip_names) - 5} more)"
		lines.append(f"| Files | {files_str} |")
	lines.append("")
	lines.append(f"*Awaiting community review on FreiData.*")

	return post_to_zulip(cfg, "\n".join(lines))


def notify_published(
	cfg: Config,
	pub_id: int,
	title: str,
	record_id: str,
	doi: Optional[str] = None,
) -> bool:
	"""Notify that a publication was accepted and is now publicly available."""
	url = _freidata_record_url(cfg.freidata_base_url, record_id)
	doi_display = f"[{doi}](https://doi.org/{doi})" if doi else "*(pending)*"

	lines = [
		f"### Published",
		"",
		_pub_header(pub_id, title),
		"",
		f"| Detail | Value |",
		f"|--------|-------|",
		f"| DOI | {doi_display} |",
		f"| FreiData | [View record]({url}) |",
		"",
		f"The publication is now publicly available on FreiData.",
	]

	return post_to_zulip(cfg, "\n".join(lines))


def notify_declined(
	cfg: Config,
	pub_id: int,
	title: str,
	record_id: str,
	review_status: str = "declined",
) -> bool:
	"""Notify that a publication review was declined or cancelled."""
	url = _freidata_draft_url(cfg.freidata_base_url, record_id)

	lines = [
		f"### Review {review_status.title()}",
		"",
		_pub_header(pub_id, title),
		"",
		f"The community review was **{review_status}**.",
		f"[View draft on FreiData]({url})",
		"",
		"*Manual intervention required — check FreiData for details.*",
	]

	return post_to_zulip(cfg, "\n".join(lines))


def notify_error(
	cfg: Config,
	pub_id: int,
	title: str,
	error_message: str,
	record_id: Optional[str] = None,
) -> bool:
	"""Notify that a publication pipeline encountered an error."""
	lines = [
		f"### Pipeline Error",
		"",
		_pub_header(pub_id, title),
		"",
	]
	if record_id:
		url = _freidata_draft_url(cfg.freidata_base_url, record_id)
		lines.append(f"[View draft on FreiData]({url})")
		lines.append("")

	# Truncate long error messages
	err_short = error_message[:500]
	if len(error_message) > 500:
		err_short += "..."

	lines.extend([
		f"```\n{err_short}\n```",
		"",
		"*Manual intervention required.*",
	])

	return post_to_zulip(cfg, "\n".join(lines))
