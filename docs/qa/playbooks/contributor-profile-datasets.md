# Contributor Profile Datasets

```yaml
id: contributor-profile-datasets
persona: contributor
fixture_packs:
  - qa-base
  - qa-contributor
browser: browser
parallel_safe: true
mutation_level: read-only
routes:
  - /profile
  - /dataset/91003
  - /dataset/91004
```

## Purpose

Verify contributor-owned dataset visibility, private dataset access, and
processing/error state presentation.

## Preconditions

- `qa-full` fixtures are seeded.
- Sign in as `qa-contributor-local@example.com`.
- Dataset `91003` is private and owned by the contributor.
- Dataset `91004` represents an incomplete/error-like processing state.

## Steps

1. Sign in as the seeded contributor.
2. Navigate to `/profile`.
3. Verify contributor account identity is visible.
4. Check whether seeded datasets are listed or reachable from profile.
5. Navigate directly to `/dataset/91003`.
6. Verify the contributor can view the private dataset.
7. Navigate to `/dataset/91004`.
8. Verify processing or error state is visible and understandable.

## Expected Observations

- `/profile` requires authentication and displays contributor identity.
- Private dataset `91003` is visible to its owner.
- Anonymous users should not have equivalent access to `91003`.
- Incomplete dataset `91004` does not render as a completed public dataset.

## Failure Signals

- Contributor cannot view own private dataset.
- Private dataset leaks in anonymous context.
- Processing/error state is blank or indistinguishable from completed data.
- Profile loads but uses production Supabase/API.

## Evidence To Capture

- Profile identity locator state.
- URL and authorization result for `/dataset/91003`.
- URL and visible state for `/dataset/91004`.
- Console errors related to dataset/profile queries.
