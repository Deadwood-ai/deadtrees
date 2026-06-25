#!/usr/bin/env python3
"""DB-free open-vocabulary search demo over precomputed tile embeddings.

Mirrors exactly what the production stack does at query time:
  1. The API encodes the text query with OpenCLIP ViT-H/14 -> 1024-d vector.
  2. ``search_datasets_by_embedding`` ranks each dataset by its SINGLE
     best-matching tile (max calibrated match probability over that dataset's tiles).
  3. ``search_tiles_by_embedding`` returns that dataset's tiles ordered by
     similarity (used for map highlighting).

This script reads the NDJSON dump produced by tools/dump_embeddings and runs the
same math locally, so you can sanity-check ranking without bringing up Postgres.

Usage:
  python scripts/search_demo.py "fire" "river" "railway tracks" \
      --seed /tmp/tile_embeddings_seed.ndjson --topk 3
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.embedding_model import DEFAULT_TEMPERATURE, load_openclip, encode_texts  # noqa: E402


def match_probability(sim_q: np.ndarray, bg_sims: np.ndarray, temperature: float = DEFAULT_TEMPERATURE) -> np.ndarray:
    """Vectorized equivalent of SQL tile_match_probability."""
    if bg_sims.size == 0:
        return sim_q
    logits = temperature * np.concatenate([sim_q[:, None], bg_sims], axis=1)
    logits = logits - logits.max(axis=1, keepdims=True)
    probs = np.exp(logits)
    probs = probs / probs.sum(axis=1, keepdims=True)
    return probs[:, 0]


def load_seed(path: Path):
	"""Return {dataset_id: {"emb": (N,1024), "bg": (N,K), "tiles": [meta,...]}}."""
	by_ds: dict[int, dict] = {}
	with open(path) as f:
		for line in f:
			rec = json.loads(line)
			ds = rec["dataset_id"]
			slot = by_ds.setdefault(ds, {"emb": [], "bg": [], "tiles": []})
			slot["emb"].append(rec.pop("embedding"))
			slot["bg"].append(rec.pop("bg_sims", []))
			slot["tiles"].append(rec)
	for ds, slot in by_ds.items():
		slot["emb"] = np.asarray(slot["emb"], dtype=np.float32)
		slot["bg"] = np.asarray(slot["bg"], dtype=np.float32)
	return by_ds


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("queries", nargs="+", help="One or more text queries")
	ap.add_argument("--seed", default="/tmp/tile_embeddings_seed.ndjson", type=Path)
	ap.add_argument("--topk", type=int, default=3, help="Top tiles to print per dataset")
	args = ap.parse_args()

	by_ds = load_seed(args.seed)
	print(f"Loaded {sum(len(s['tiles']) for s in by_ds.values())} tiles "
		  f"across {len(by_ds)} datasets from {args.seed}\n")

	bundle = load_openclip(device="cpu")

	for query in args.queries:
		qvec = encode_texts(bundle, [query]).detach().cpu().float().numpy()[0]

		# Rank datasets by best calibrated tile (== search_datasets_by_embedding).
		ranking = []
		for ds, slot in by_ds.items():
			sims = slot["emb"] @ qvec  # cosine (both L2-normalized)
			scores = match_probability(sims, slot["bg"])
			best = int(np.argmax(scores))
			ranking.append((ds, float(scores[best]), best, scores))
		ranking.sort(key=lambda r: r[1], reverse=True)

		print(f"=== query: {query!r} ===")
		for rank, (ds, best_score, best_i, scores) in enumerate(ranking, 1):
			print(f"  #{rank} dataset {ds}: best-tile match probability = {best_score:.4f} "
				  f"(tiles={len(scores)})")
		# Show the top matching tiles of the winning dataset (== highlight order).
		win_ds, _, _, win_scores = ranking[0]
		order = np.argsort(-win_scores)[: args.topk]
		print(f"  top {args.topk} tiles in winning dataset {win_ds} (for highlighting):")
		for i in order:
			t = by_ds[win_ds]["tiles"][i]
			print(f"    p={win_scores[i]:.4f}  bbox4326=({t['min_lon']:.5f},{t['min_lat']:.5f},"
				  f"{t['max_lon']:.5f},{t['max_lat']:.5f})")
		print()


if __name__ == "__main__":
	main()
