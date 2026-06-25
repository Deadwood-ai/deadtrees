#!/usr/bin/env python3
"""Apply a .sql file to a Postgres database (used to load the demo tile-embedding
seed into the local Supabase). Defaults to the local Supabase CLI Postgres.

    python scripts/apply_sql.py /tmp/seed_tile_embeddings.sql \
        --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres
"""
import argparse
import sys

import psycopg2

DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("sql_file")
	ap.add_argument("--db-url", default=DEFAULT_DB_URL)
	args = ap.parse_args()

	sql = open(args.sql_file).read()
	conn = psycopg2.connect(args.db_url)
	conn.autocommit = True  # the file manages its own begin/commit
	try:
		with conn.cursor() as cur:
			cur.execute(sql)
		print(f"Applied {args.sql_file}")
	except Exception as e:
		print(f"ERROR applying {args.sql_file}: {e}", file=sys.stderr)
		sys.exit(1)
	finally:
		conn.close()


if __name__ == "__main__":
	main()
