# Public Home Discovery

```yaml
id: public-home-discovery
persona: anonymous
fixture_packs:
  - qa-base
browser: browser
parallel_safe: true
mutation_level: read-only
routes:
  - /
  - /dataset
  - /deadtrees
  - /releases
```

## Purpose

Verify the anonymous public entry points are reachable, navigable, and wired to
the isolated local app stack.

## Preconditions

- Isolated local env is sourced.
- Frontend is running at `PLAYWRIGHT_BASE_URL` or `http://127.0.0.1:$LOCAL_FRONTEND_PORT`.
- `scripts/qa/seed.sh qa-full` has completed.
- Use anonymous browser context.

## Steps

1. Navigate to `/`.
2. Verify the home page renders with `data-testid="home-page"`.
3. Use visible navigation or page links to open `/dataset`.
4. Verify the archive page renders with `data-testid="dataset-archive-page"`.
5. Return to `/` and open `/deadtrees`.
6. Verify the public deadtrees map page renders with `data-testid="deadtrees-map-page"`.
7. Open `/releases`.
8. Verify the releases page renders with `data-testid="releases-page"`.

## Expected Observations

- Public routes do not require authentication.
- Navigation does not leave the isolated frontend origin.
- Archive, map, and releases routes render without blank states or route errors.
- No request targets production API, Supabase, or storage hosts.

## Failure Signals

- Auth redirect from a public route.
- Console error caused by route load, Supabase config, or missing env.
- Network call to production for Supabase/API/storage.
- Empty main content where a page test id is expected.

## Evidence To Capture

- Current URL for any failed route.
- Visibility state for the expected `data-testid`.
- Console errors filtered to `error` level.
- One screenshot only if layout is visibly broken.

