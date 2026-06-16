# Negative Empty Error States

```yaml
id: negative-empty-error-states
persona: mixed
fixture_packs:
  - qa-negative
  - qa-base
browser: browser
parallel_safe: true
mutation_level: read-only
routes:
  - /dataset/999999
  - /dataset/91004
  - /dataset-audit
```

## Purpose

Verify common negative states are understandable: missing dataset, incomplete or
errored processing state, denied audit access, and empty/filtered archive
states.

## Preconditions

- `qa-full` fixtures are seeded.
- Use anonymous context for missing dataset and denied audit checks.
- Use contributor/auditor contexts only when checking role-specific error
  behavior.

## Steps

1. As anonymous, navigate to `/dataset/999999`.
2. Verify a not-found, empty, or recoverable error state appears.
3. Navigate to `/dataset/91004`.
4. Verify processing/error state is visible and does not masquerade as complete.
5. Navigate to `/dataset-audit` anonymously.
6. Verify authentication/authorization guard behavior.
7. Navigate to `/dataset` and apply a search/filter that should return no rows.
8. Verify `data-testid="dataset-empty-results"` or equivalent empty state.

## Expected Observations

- Missing dataset state is user-visible and does not crash the app.
- Incomplete/error-like dataset state is distinct from completed state.
- Protected routes do not expose sensitive content.
- Empty archive filters offer a recovery path such as clearing filters.

## Failure Signals

- Blank page with no error or recovery path.
- Protected audit content briefly visible to anonymous users.
- Console errors from unhandled null dataset state.
- Empty filter state traps the user without clear/reset affordance.

## Evidence To Capture

- Current URL and visible error/empty state.
- Guard redirect or denial state.
- Console errors filtered to route/data-loading failures.
- One screenshot only when the visual state is ambiguous.

