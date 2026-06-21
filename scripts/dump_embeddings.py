#!/usr/bin/env python3
"""Compute per-tile CLIP embeddings for one or more orthophotos and dump NDJSON.

Reproduces the production `embeddings_v1` pipeline (reproject to 10cm -> 512px
tiles -> drop >50% nodata -> OpenCLIP ViT-H/14) outside the processor, so search
can be tested with precomputed embeddings. Reports timing per ortho.

    python scripts/dump_embeddings.py \
        204:/path/204_postfire.tif \
        211:/path/211_auwald.tif \
        --out /tmp/tile_embeddings_seed.ndjson \
        --meta /tmp/tile_embeddings_meta.json

Each positional arg is `DATASET_ID:PATH`. Runs on GPU if available, else CPU.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
import torch
from PIL import Image
from rasterio.vrt import WarpedVRT
from rasterio.warp import calculate_default_transform, transform_bounds
from rasterio.windows import Window

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.embedding_model import load_openclip, encode_images  # noqa: E402

PATCH = 512
GSD_M = 0.10
NODATA_THRESHOLD = 0.5
BATCH = 16


def utm_epsg(lon: float, lat: float) -> int:
	import math

	zone = int(math.floor((lon + 180) / 6) % 60) + 1
	return (32600 if lat >= 0 else 32700) + zone


def open_10cm(path: str) -> WarpedVRT:
	ds = rasterio.open(path)
	lon, lat = ds.lnglat()
	crs = f"EPSG:{utm_epsg(lon, lat)}"
	transform, width, height = calculate_default_transform(
		ds.crs, crs, ds.width, ds.height, *ds.bounds, resolution=GSD_M
	)
	return WarpedVRT(ds, crs=crs, transform=transform, width=width, height=height, dtype="uint8", nodata=0)


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("orthos", nargs="+", help="DATASET_ID:PATH entries")
	ap.add_argument("--out", default="/tmp/tile_embeddings_seed.ndjson", type=Path)
	ap.add_argument("--meta", default="/tmp/tile_embeddings_meta.json", type=Path)
	args = ap.parse_args()

	entries = []
	for item in args.orthos:
		ds_id, _, path = item.partition(":")
		entries.append((int(ds_id), path))

	device = "cuda" if torch.cuda.is_available() else "cpu"
	bundle = load_openclip(device=device)
	print(f"Model loaded on {device}", flush=True)

	meta = {}
	if args.out.exists():
		args.out.unlink()

	with open(args.out, "w") as out_f:
		for ds_id, path in entries:
			t0 = time.time()
			vrt = open_10cm(path)
			w, h = vrt.width, vrt.height
			bands = [1, 2, 3] if vrt.count >= 3 else list(range(1, vrt.count + 1))
			ds_bounds = transform_bounds(vrt.crs, "EPSG:4326", *vrt.bounds)
			imgs, metas, kept = [], [], 0

			def flush():
				nonlocal kept
				if not imgs:
					return
				feats = encode_images(bundle, imgs).detach().cpu().float().numpy()
				for emb, m in zip(feats, metas):
					rec = dict(m)
					rec["embedding"] = [round(float(v), 6) for v in emb]
					out_f.write(json.dumps(rec) + "\n")
					kept += 1
				imgs.clear()
				metas.clear()

			for yy in range(0, h, PATCH):
				for xx in range(0, w, PATCH):
					win = Window(xx, yy, min(PATCH, w - xx), min(PATCH, h - yy))
					data = vrt.read(indexes=bands, window=win, masked=True)
					ndf = float(np.mean(np.all(data.mask, axis=0))) if data.mask is not np.ma.nomask else 0.0
					if ndf > NODATA_THRESHOLD:
						continue
					arr = np.where(data.mask, 0, data.data)
					arr = np.moveaxis(arr, 0, -1)
					arr = np.clip(arr, 0, 255).astype(np.uint8)
					if arr.shape[2] == 1:
						arr = np.repeat(arr, 3, axis=2)
					left, bottom, right, top = vrt.window_bounds(win)
					gb = transform_bounds(vrt.crs, "EPSG:4326", left, bottom, right, top)
					imgs.append(Image.fromarray(arr))
					metas.append({
						"dataset_id": ds_id,
						"min_lon": gb[0], "min_lat": gb[1], "max_lon": gb[2], "max_lat": gb[3],
						"pixel_x0": int(xx), "pixel_y0": int(yy),
						"pixel_x1": int(xx + win.width), "pixel_y1": int(yy + win.height),
						"nodata_fraction": round(ndf, 4),
					})
					if len(imgs) >= BATCH:
						flush()
			flush()
			vrt.close()
			dt = time.time() - t0
			meta[ds_id] = {
				"file": os.path.basename(path),
				"raster_w": w, "raster_h": h,
				"tiles_embedded": kept, "seconds": round(dt, 1),
				"sec_per_tile": round(dt / max(kept, 1), 3),
				"bbox_4326": [round(b, 6) for b in ds_bounds],
			}
			print(f"[{ds_id}] {kept} tiles in {dt:.0f}s ({dt/max(kept,1):.2f}s/tile) on {device}", flush=True)

	args.meta.write_text(json.dumps(meta, indent=2))
	print("META:", json.dumps(meta), flush=True)


if __name__ == "__main__":
	main()
