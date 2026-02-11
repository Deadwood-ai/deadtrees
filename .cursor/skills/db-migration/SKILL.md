---
name: db-migration
description: Implements and validates DeadTrees database schema changes through MCP-first local workflow. Use when the user asks for database migrations, schema updates, Supabase diffs, local DB changes, migration validation, or exporting migration files.
---

# DB Migration Workflow

## Purpose

Use this workflow to safely create and validate database migrations in DeadTrees with MCP-first database operations.

## Core Rules

- Never connect to the database directly with Python; use MCP tools.
- Use local DB MCP (`user-deadtrees-local`) for schema changes and validation.
- Keep test scope fast first: run only relevant, quick tests before broader checks.
- Ask before committing; do not commit automatically.

## Required Workflow

Follow these steps in order.

### 1) Make local dev DB changes via MCP

- Apply schema/function/policy changes using MCP SQL execution against local DB.
- Prefer safe SQL patterns:
	- Start with small, targeted statements.
	- Validate affected objects immediately after each change.
- If view dependencies exist, handle drop/alter/recreate order explicitly.

### 2) Validate with fast tests and MCP checks

- Run relevant fast tests only (smallest affected scope first).
- Follow project testing rules:
	- Use `deadtrees` CLI for tests.
	- Prefer focused test paths instead of full suites.
- Review DB behavior with MCP:
	- Check updated schema objects.
	- Run validation queries that prove expected behavior.
	- Confirm no unintended side effects in related tables/views/functions.

### 3) Fix breakages if found

- If tests or MCP validation fail, fix code/SQL and re-run step 2.
- Continue until fast tests pass and MCP validation confirms expected behavior.

### 4) Export migration

Run:

```bash
PGSSLMODE=disable supabase db diff -f name-of-migration-file
```

- Use a descriptive migration file name.
- Ensure generated migration reflects only intended schema changes.

### 5) Review migration file

- Verify SQL ordering and dependency safety.
- Confirm idempotence expectations and rollback safety where applicable.
- Ensure no accidental changes are included.

### 6) Ask to commit

- Summarize what changed, what was tested, and MCP validation results.
- Ask user for approval before `git add`/`git commit`.

## Fast-Path Test Selection Guidance

When selecting tests, prefer this order:

1. Direct unit/integration tests for changed module.
2. Closely related API/processor test file via `--test-path`.
3. Broader suite only if targeted tests indicate cross-cutting impact.

## MCP Validation Checklist

Use this checklist before exporting migration:

- Local object exists and has expected definition.
- Key queries against changed object return expected results.
- Related policies/views/functions still work.
- No obvious regressions in dependent paths.
