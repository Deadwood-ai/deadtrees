# Auditor Access Guards

```yaml
id: auditor-access-guards
persona: anonymous/contributor/auditor
fixture_packs:
  - qa-auth
  - qa-auditor
browser: browser
parallel_safe: true
mutation_level: read-only
routes:
  - /dataset-audit
  - /dataset-audit/91001
```

## Purpose

Verify audit routes enforce role boundaries across anonymous, non-auditor, and
auditor personas.

## Preconditions

- `qa-full` fixtures are seeded.
- Use fresh browser contexts for anonymous, contributor, and auditor checks.
- Contributor is `qa-contributor-local@example.com`.
- Auditor is `qa-auditor-local@example.com`.

## Steps

1. As anonymous, navigate to `/dataset-audit`.
2. Verify redirect or denial state.
3. Sign in as contributor and navigate to `/dataset-audit`.
4. Verify contributor is denied auditor access.
5. Sign out or use a fresh context.
6. Sign in as auditor and navigate to `/dataset-audit`.
7. Verify the audit workspace loads.
8. Navigate to `/dataset-audit/91001`.
9. Verify auditor can access the target dataset audit detail.

## Expected Observations

- Anonymous users cannot use auditor routes.
- Non-auditor authenticated users cannot use auditor routes.
- Auditor user can access queue and detail routes.
- Guard decisions are based on local `privileged_users`, not client-side-only state.

## Failure Signals

- Contributor can access audit workspace.
- Auditor is denied despite seeded `can_audit=true`.
- Guard state flickers into visible sensitive content before redirect.
- Any auth or privilege query targets production.

## Evidence To Capture

- Current URL and guard state for each persona.
- `privileged_users` query status if visible in network summary.
- One screenshot only if protected content leaks.

