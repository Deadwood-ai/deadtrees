# Public Archive Detail Download

```yaml
id: public-archive-detail-download
persona: anonymous
fixture_packs:
  - qa-base
browser: browser
parallel_safe: true
mutation_level: local-write
routes:
  - /dataset
  - /dataset/91001
```

## Purpose

Verify anonymous discovery can move from archive to a public dataset detail page
and exercise the local download surface without touching production.

## Preconditions

- `qa-full` or `qa-base` fixtures are seeded.
- Dataset `91001` exists and is public.
- Local API/nginx is reachable through `VITE_LOCAL_API_URL`.
- Use anonymous browser context.

## Steps

1. Navigate to `/dataset`.
2. Verify `data-testid="dataset-archive-page"` is visible.
3. Search or scan for `qa-public-complete.tif` or dataset ID `91001`.
4. Open the dataset detail route `/dataset/91001`.
5. Verify `data-testid="dataset-detail-page"` is visible.
6. Verify the detail map area or layer controls render if present.
7. Find the download section with `data-testid="dataset-download-section"`.
8. Start a labels-only or dataset download action if the UI exposes one.
9. Verify the request targets `VITE_LOCAL_API_URL`, not production.

## Expected Observations

- Public dataset `91001` is visible to anonymous users.
- Detail route shows metadata, map/detail controls, and download UI.
- Download request either returns a local success/pending state or a clear local
  API error that can be investigated.
- Any local write side effect stays in the isolated DB/storage path.

## Failure Signals

- Dataset `91001` is missing from archive and direct detail route.
- Detail page renders but download controls are absent without explanation.
- Download calls `data2.deadtrees.earth` or another production host.
- API returns authorization failure for public download with no UI explanation.

## Evidence To Capture

- Archive locator state for dataset `91001`.
- Current detail URL.
- Download request URL/status.
- One screenshot of the download section only if the UI is visually broken.

