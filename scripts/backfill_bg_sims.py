#!/usr/bin/env python3
"""Backfill v2_tile_embeddings.bg_sims for rows that don't have it yet.

bg_sims (a tile's cosine similarities to the fixed background prompt bank) is
query-independent and can be recomputed from the already-stored tile embeddings
plus the background prompt embeddings — no image inference needed. Used to
calibrate existing seeded data after the softmax-calibration migration.

    python scripts/backfill_bg_sims.py \
        --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import psycopg2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.embedding_model import background_embeddings  # noqa: E402

DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--db-url", default=DEFAULT_DB_URL)
	ap.add_argument("--all", action="store_true", help="recompute for all rows, not just empty bg_sims")
	args = ap.parse_args()

	bg = background_embeddings()  # K x D (loads the model once)
	print(f"background bank: {bg.shape[0]} prompts x {bg.shape[1]} dims")

	conn = psycopg2.connect(args.db_url)
	conn.autocommit = False
	cur = conn.cursor()

	# Two literal queries instead of interpolating a WHERE clause, so static
	# analysis can see no string is ever built into the SQL.
	if args.all:
		cur.execute("select id, embedding::real[] from public.v2_tile_embeddings")
	else:
		cur.execute(
			"select id, embedding::real[] from public.v2_tile_embeddings "
			"where array_length(bg_sims, 1) is null"
		)
	rows = cur.fetchall()
	print(f"rows to backfill: {len(rows)}")
	if not rows:
		conn.close()
		return

	ids = [r[0] for r in rows]
	emb = np.asarray([r[1] for r in rows], dtype=np.float32)  # N x D
	sims = emb @ bg.T  # N x K

	for i, rid in enumerate(ids):
		cur.execute(
			"update public.v2_tile_embeddings set bg_sims = %s where id = %s",
			([round(float(v), 6) for v in sims[i]], rid),
		)
	conn.commit()
	print(f"updated {len(ids)} rows")
	conn.close()


if __name__ == "__main__":
	main()
