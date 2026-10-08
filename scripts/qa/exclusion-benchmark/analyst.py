#!/usr/bin/env python3
"""Freeze explicitly selected audit assets with the trusted SELECT-only route.

No audit answers, comments, user identities or label-quality fields enter inputs.
Use explicit label IDs: choosing a different prediction is a different task.
"""
from contextlib import contextmanager
import os
from urllib.parse import urlparse

import psycopg
from psycopg.rows import dict_row


@contextmanager
def analyst():
	uri = os.environ["DEADTREES_ANALYST_DATABASE_URL"]
	if urlparse(uri).hostname != "supabase.deadtrees.earth":
		raise ValueError("Unexpected production target")
	with psycopg.connect(uri, prepare_threshold=None, connect_timeout=10, autocommit=True) as db:
		db.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
		try:
			db.execute("SET LOCAL statement_timeout = '30s'")
			db.execute("SET LOCAL lock_timeout = '3s'")
			identity = db.execute("SELECT current_database(),current_user,session_user,"
				"pg_has_role(current_user,'analyst','MEMBER'),current_setting('transaction_read_only')").fetchone()
			if identity != ("postgres", "team_analyst", "team_analyst", True, "on"):
				raise RuntimeError("Unexpected analyst identity or transaction")
			db.row_factory = dict_row
			yield db
		finally:
			db.execute("ROLLBACK")

