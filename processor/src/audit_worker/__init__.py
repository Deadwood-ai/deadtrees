"""Audit worker: runs the automated audit checks on the processing server (DT-1482, plan DT-1470).

One worker, started under Janusch's account, so the model calls use his subscription logins:
Claude Haiku through `claude -p` and OpenAI models through the Codex login. It takes queued runs
from audit.runs (new uploads first, then manual runs, then the backfill), hands each to its
check's handler, and finishes the run. When a login has expired or a usage limit is reached it
puts the run back, pauses and says so in its status file, which the platform monitor reads; a
run never fails because of a login. See docs/audit-checks.md.
"""
