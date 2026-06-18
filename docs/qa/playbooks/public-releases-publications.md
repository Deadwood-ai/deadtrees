# Public Releases Publications

```yaml
id: public-releases-publications
persona: anonymous
fixture_packs:
  - qa-base
  - qa-publication
browser: browser
parallel_safe: true
mutation_level: read-only
routes:
  - /releases
  - /releases/:slug
```

## Purpose

Verify the public release and publication discovery surface loads in the local
environment and handles the currently seeded release catalog state.

## Preconditions

- `qa-full` fixtures are seeded.
- If no `qa-publication` extension exists yet, treat this as a current-gap
  playbook and record missing fixture coverage as `needs-human-review`.
- Use anonymous browser context.

## Steps

1. Navigate to `/releases`.
2. Verify `data-testid="releases-page"` is visible.
3. Count visible `data-testid="release-card"` elements.
4. Open the first release card if one exists.
5. Verify `data-testid="release-detail-page"` or a clear local empty state.
6. Inspect release artifacts if `data-testid="release-artifacts"` is present.

## Expected Observations

- `/releases` is public and reachable.
- The page either lists local releases or communicates an empty state.
- Release detail routes stay on the local frontend origin.
- Artifact links do not unexpectedly point at production-only private resources.

## Failure Signals

- Blank release page with no empty state.
- Release card opens a broken route.
- Console error from release catalog query.
- Artifact action fails without a user-visible state.

## Evidence To Capture

- Number of release cards.
- URL and state of the first opened detail page.
- Console errors filtered to release/publication calls.
- Note whether missing `qa-publication` fixture coverage blocked deeper checks.
