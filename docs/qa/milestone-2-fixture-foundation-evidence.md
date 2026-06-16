# Milestone 2: Fixture Foundation Evidence

Date: 2026-06-16

## Scope

This evidence records the first deterministic local QA fixture foundation for
`docs/qa/local-agent-qa-plan.md`.

## Implemented Artifacts

- `scripts/qa/seed.sh`
- `scripts/qa/check-fixtures.sql`
- `supabase/seeds/qa/qa-base.sql`
- `docs/qa/fixtures.md`

## Seed Profiles

Current supported profiles:

- `qa-base`
- `qa-full`

`qa-full` currently applies the same foundation as `qa-base`. Future slices
should split and extend narrower packs for labels, PRIWA, publications,
downloads, and negative states.

## Seeded Personas

All seeded users use the local-only password documented in `docs/qa/fixtures.md`.

- `qa-contributor-local@example.com`
- `qa-auditor-local@example.com`
- `qa-viewer-local@example.com`

The seed creates matching `auth.users`, `auth.identities`, and
`privileged_users` rows.

## Seeded Dataset States

- `91001`: public complete dataset with an open user flag
- `91002`: public completed audited dataset
- `91003`: private contributor-owned dataset
- `91004`: public incomplete/error-like processing state

## Checks Passed

```bash
set -a
source .local/supabase/current.env
set +a
scripts/qa/seed.sh qa-full
```

The seed completed and then ran `scripts/qa/check-fixtures.sql`.

Checker summary:

```text
qa fixtures ready | qa_users=3 | qa_datasets=4 | qa_public_view_rows=3
```

Auth sign-in was verified through local Supabase Auth:

```bash
curl -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  --data '{"email":"qa-contributor-local@example.com","password":"DeadTreesQA-Local-1!"}'
```

Result:

```text
200
qa-contributor-local@example.com
```

## Notes

Supabase Auth generated columns differ from ordinary application tables:

- `auth.users.confirmed_at` is generated and must not be explicitly inserted.
- `auth.identities.email` is generated and must not be explicitly inserted.
- Auth token fields such as `confirmation_token` should be empty strings rather
  than null for this local GoTrue version.
- `auth.users.phone` should remain null unless a unique phone value is needed.

