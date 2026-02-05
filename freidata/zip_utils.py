from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Tuple


def list_zip_files(folder: Path) -> List[Path]:
	return sorted([p for p in folder.glob("*.zip") if p.is_file()])


def expected_tif_name(zip_path: Path) -> str:
	return f"ortho_{zip_path.stem}.tif"


def clean_zip(zip_path: Path, out_zip: Path) -> Tuple[bool, str]:
	"""
	Create a cleaned zip with only:
	  - METADATA.csv (case-sensitive output name)
	  - ortho_<zipstem>.tif (renamed to expected)
	Returns (ok, message).
	"""
	tif_target = expected_tif_name(zip_path)

	with tempfile.TemporaryDirectory() as td:
		td_path = Path(td)
		meta_out = td_path / "METADATA.csv"
		tif_out = td_path / tif_target

		found_meta = None
		found_tif = None

		import zipfile
		try:
			with zipfile.ZipFile(zip_path, "r") as zf:
				names = zf.namelist()

				for n in names:
					if Path(n).name.lower() == "metadata.csv":
						found_meta = n
						break

				for n in names:
					if Path(n).name == tif_target:
						found_tif = n
						break
				if found_tif is None:
					tifs = [n for n in names if Path(n).suffix.lower() in (".tif", ".tiff")]
					if len(tifs) == 1:
						found_tif = tifs[0]
					elif len(tifs) > 1:
						tifs_sorted = sorted(tifs, key=lambda n: (zf.getinfo(n).file_size, n))
						found_tif = tifs_sorted[-1]

				if not found_meta:
					return (False, f"{zip_path.name}: kein METADATA.csv gefunden")
				if not found_tif:
					return (False, f"{zip_path.name}: kein .tif/.tiff gefunden")

				meta_out.write_bytes(zf.read(found_meta))
				tif_out.write_bytes(zf.read(found_tif))

		except zipfile.BadZipFile:
			return (False, f"{zip_path.name}: BadZipFile (defekt?)")

		out_zip.parent.mkdir(parents=True, exist_ok=True)
		with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf_out:
			zf_out.write(meta_out, arcname="METADATA.csv")
			zf_out.write(tif_out, arcname=tif_target)

	return (True, f"{zip_path.name}: cleaned -> {out_zip.name}")


def validate_zips_against_db(zip_paths: List[Path], pub: Dict[str, Any]) -> None:
	datasets = pub.get("datasets")
	dataset_count = pub.get("dataset_count")

	if not zip_paths:
		raise RuntimeError("Keine .zip Dateien im Ordner gefunden.")

	if isinstance(dataset_count, int) and dataset_count > 0:
		if len(zip_paths) != dataset_count:
			print(f"[WARN] dataset_count={dataset_count}, aber im Ordner sind {len(zip_paths)} ZIPs.", file=sys.stderr)

	if isinstance(datasets, list):
		dataset_ids = set()
		for d in datasets:
			if isinstance(d, dict) and "dataset_id" in d:
				try:
					dataset_ids.add(str(int(d["dataset_id"])))
				except Exception:
					dataset_ids.add(str(d["dataset_id"]))
		if dataset_ids:
			stems = set([p.stem for p in zip_paths])
			missing = dataset_ids - stems
			if missing:
				print(f"[WARN] Diese dataset_id(s) fehlen als ZIP-Datei (Stem): {sorted(missing)}", file=sys.stderr)
