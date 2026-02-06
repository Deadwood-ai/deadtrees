"""
Download dataset bundles from the API for FreiData publication.

This module uses the existing download endpoints to build canonical ZIP files
(ortho + metadata + labels + citation + license) and stores them locally.
"""
from __future__ import annotations

import re
import time
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import requests
from supabase import Client, ClientOptions, create_client

from .config import Config
from .db import fetch_publication_full_info


_cached_api_token: Optional[str] = None


def slugify_title(title: str, max_length: int = 60) -> str:
	"""
	Convert a publication title to a filesystem-safe slug.

	Examples:
		"Östra Göinge, Sweden by X - part of deadtrees.earth"
		-> "ostra-goinge-sweden"
	"""
	# Remove the " - part of deadtrees.earth" suffix and "by Author" parts
	cleaned = re.sub(r'\s*-\s*part of deadtrees\.earth\s*$', '', title, flags=re.IGNORECASE)
	cleaned = re.sub(r'\s+by\s+.*$', '', cleaned, flags=re.IGNORECASE)

	# Transliterate unicode to ASCII (ö -> o, é -> e, etc.)
	nfkd = unicodedata.normalize("NFKD", cleaned)
	ascii_text = nfkd.encode("ascii", "ignore").decode("ascii")

	# Lowercase, replace non-alphanumeric with hyphens
	slug = re.sub(r'[^a-z0-9]+', '-', ascii_text.lower()).strip('-')

	# Collapse multiple hyphens
	slug = re.sub(r'-{2,}', '-', slug)

	# Truncate to max_length at a word boundary
	if len(slug) > max_length:
		slug = slug[:max_length].rsplit('-', 1)[0]

	return slug or "bundle"


def make_bundle_filename(title: str, publication_id: int) -> str:
	"""
	Create a human-readable ZIP filename for a publication bundle.

	Example: "ostra-goinge-sweden_pub36.zip"
	"""
	slug = slugify_title(title)
	return f"{slug}_pub{publication_id}.zip"


def get_publication_dataset_ids(db: Client, publication_id: int) -> List[int]:
    pub = fetch_publication_full_info(db, publication_id)
    datasets = pub.get("datasets") or []
    dataset_ids: List[int] = []
    for d in datasets:
        if isinstance(d, dict) and "dataset_id" in d:
            try:
                dataset_ids.append(int(d["dataset_id"]))
            except Exception:
                continue
    return dataset_ids


def get_download_api_token(cfg: Config) -> Optional[str]:
    global _cached_api_token

    if cfg.download_api_token:
        return cfg.download_api_token.strip()

    if _cached_api_token:
        return _cached_api_token

    if not cfg.processor_username or not cfg.processor_password:
        return None

    if not cfg.supabase_url or not cfg.supabase_key:
        print("[WARN] Missing SUPABASE_URL / SUPABASE_KEY for API auth token")
        return None

    try:
        client = create_client(
            cfg.supabase_url,
            cfg.supabase_key,
            options=ClientOptions(auto_refresh_token=False),
        )
        auth_response = client.auth.sign_in_with_password(
            {"email": cfg.processor_username, "password": cfg.processor_password}
        )
        token = auth_response.session.access_token if auth_response.session else None
        if token:
            _cached_api_token = token
        return token
    except Exception as e:
        print(f"[WARN] Could not login for API token: {e}")
        return None


def build_auth_headers(cfg: Config) -> Dict[str, str]:
    token = get_download_api_token(cfg)
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}


def build_download_params(cfg: Config) -> Dict[str, Any]:
	return {
		"include_labels": str(cfg.download_include_labels).lower(),
		"include_parquet": str(cfg.download_include_parquet).lower(),
		"use_original_filename": str(cfg.download_use_original_filename).lower(),
	}


def build_download_url(download_api_base_url: str, download_path: str) -> str:
    if download_path.startswith("http://") or download_path.startswith("https://"):
        return download_path
    parsed = urlparse(download_api_base_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return urljoin(origin + "/", download_path.lstrip("/"))


def request_bundle(session: requests.Session, cfg: Config, dataset_ids: List[int]) -> Dict[str, Any]:
    if not dataset_ids:
        raise RuntimeError("No dataset_ids provided for bundle request.")

    url = f"{cfg.download_api_base_url}/bundle.zip"
    params = {
        "dataset_ids": ",".join([str(d) for d in dataset_ids]),
    }
    params.update(build_download_params(cfg))

    resp = session.get(
        url,
        headers=build_auth_headers(cfg),
        params=params,
        timeout=cfg.download_request_timeout_seconds,
    )
    resp.raise_for_status()
    return resp.json()


def poll_bundle_status(session: requests.Session, cfg: Config, job_id: str) -> Dict[str, Any]:
    deadline = time.monotonic() + cfg.download_timeout_seconds
    url = f"{cfg.download_api_base_url}/bundle/status"

    while True:
        resp = session.get(
            url,
            headers=build_auth_headers(cfg),
            params={"job_id": job_id},
            timeout=cfg.download_request_timeout_seconds,
        )
        resp.raise_for_status()
        data = resp.json()

        status = (data.get("status") or "").lower()
        if status == "completed":
            return data
        if status == "failed":
            raise RuntimeError(f"Download failed for bundle job_id={job_id}: {data.get('message')}")

        if time.monotonic() > deadline:
            raise RuntimeError(f"Download timed out for bundle job_id={job_id}")

        time.sleep(cfg.download_poll_interval_seconds)


def download_file(session: requests.Session, cfg: Config, url: str, target_path: Path) -> None:
	tmp_path = target_path.with_suffix(".zip.part")
	tmp_path.parent.mkdir(parents=True, exist_ok=True)

	with session.get(url, headers=build_auth_headers(cfg), stream=True, timeout=cfg.download_timeout_seconds) as resp:
		resp.raise_for_status()
		content_length = resp.headers.get("Content-Length")
		expected_size = None
		if content_length and content_length.isdigit():
			expected_size = int(content_length)

		with tmp_path.open("wb") as f:
			for chunk in resp.iter_content(chunk_size=cfg.download_chunk_size_bytes):
				if chunk:
					f.write(chunk)

	if tmp_path.exists():
		actual_size = tmp_path.stat().st_size
		if actual_size == 0:
			tmp_path.unlink(missing_ok=True)
			raise RuntimeError("Downloaded file is empty.")
		if expected_size is not None and actual_size != expected_size:
			tmp_path.unlink(missing_ok=True)
			raise RuntimeError(
				f"Downloaded file size mismatch: expected {expected_size}, got {actual_size}"
			)

	tmp_path.replace(target_path)


def download_dataset_zip(
    session: requests.Session,
    cfg: Config,
    dataset_ids: List[int],
    output_folder: Path,
    publication_id: int,
    publication_title: str = "",
) -> Path:
    output_zip: Optional[Path] = None
    print(f"  Requesting bundle for dataset_ids={dataset_ids}...")
    initial = request_bundle(session, cfg, dataset_ids)
    status = (initial.get("status") or "").lower()
    job_id = initial.get("job_id")

    if status != "completed":
        if not job_id:
            raise RuntimeError("No job_id returned for bundle request.")
        print(f"  Waiting for bundle job_id={job_id}...")
        initial = poll_bundle_status(session, cfg, job_id)

    download_path = initial.get("download_path")
    if not download_path and job_id:
        download_path = f"/downloads/v1/bundles/{job_id}.zip"
    if not download_path:
        raise RuntimeError("No download_path returned for bundle request.")

    download_url = build_download_url(cfg.download_api_base_url, download_path)

    # Use a meaningful filename instead of the job ID hash
    if publication_title:
        download_name = make_bundle_filename(publication_title, publication_id)
    else:
        download_name = Path(urlparse(download_path).path).name or f"bundle_{publication_id}.zip"

    output_zip = output_folder / download_name

    if output_zip.exists() and output_zip.stat().st_size > 0:
        print(f"  [SKIP] {output_zip.name} already exists")
        return output_zip
    if output_zip.exists() and output_zip.stat().st_size == 0:
        print(f"  [WARN] {output_zip.name} is empty; re-downloading.")
        output_zip.unlink(missing_ok=True)

    print(f"  Downloading {download_url} -> {output_zip.name}")
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            download_file(session, cfg, download_url, output_zip)
            break
        except Exception as e:
            if attempt >= max_attempts:
                raise
            print(f"  [WARN] Download attempt {attempt} failed: {e}")
            time.sleep(cfg.download_poll_interval_seconds)
    return output_zip


def download_publication_datasets(cfg: Config, db: Client, output_folder: Path, publication_id: int) -> List[Path]:
    print(f"[DOWNLOAD] Fetching datasets for publication {publication_id}...")

    pub = fetch_publication_full_info(db, publication_id)
    datasets = pub.get("datasets") or []
    dataset_ids: List[int] = []
    for d in datasets:
        if isinstance(d, dict) and "dataset_id" in d:
            try:
                dataset_ids.append(int(d["dataset_id"]))
            except Exception:
                continue

    if not dataset_ids:
        raise RuntimeError(f"No datasets found for publication {publication_id}")

    publication_title = pub.get("title") or ""

    print(f"[DOWNLOAD] Found {len(dataset_ids)} dataset(s)")
    output_folder.mkdir(parents=True, exist_ok=True)

    created_zips: List[Path] = []
    with requests.Session() as session:
        zip_path = download_dataset_zip(
            session=session,
            cfg=cfg,
            dataset_ids=dataset_ids,
            output_folder=output_folder,
            publication_id=publication_id,
            publication_title=publication_title,
        )
        created_zips.append(zip_path)

    if not created_zips:
        raise RuntimeError("No ZIP files could be downloaded")

    print(f"[DOWNLOAD] Downloaded {len(created_zips)} ZIP file(s)")
    return created_zips
