# Contributor Upload Process

```yaml
id: contributor-upload-process
persona: contributor
fixture_packs:
  - qa-contributor
browser: browser
parallel_safe: false
mutation_level: local-write
routes:
  - /profile
```

## Purpose

Verify the contributor can reach the upload workflow and submit metadata plus a
small GeoTIFF to the isolated local API.

## Preconditions

- `qa-full` fixtures are seeded.
- API/nginx is reachable through `VITE_LOCAL_API_URL`.
- Use seeded contributor credentials from `docs/qa/fixtures.md`.
- Use fixture file `frontend/test/fixtures/geotiff/upload-validation/rgb-real-crop.tif`
  if available.

## Steps

1. Sign in as the seeded contributor.
2. Navigate to `/profile`.
3. Open the upload modal.
4. Verify `data-testid="contributor-upload-modal"` and dropzone are visible.
5. Attach the small GeoTIFF fixture.
6. Fill required author, date, DOI or description, license, and consent fields.
7. Submit the upload.
8. Observe the upload and processing requests.
9. Verify the created dataset appears in local DB/API state.

## Expected Observations

- Upload UI enables submit only after required fields are valid.
- Upload request targets `$VITE_LOCAL_API_URL/datasets/chunk`.
- Processing request targets the local API route for the created dataset.
- Local DB receives dataset/status/queue/storage side effects.

## Failure Signals

- Upload modal cannot open from profile.
- File validation rejects the known good GeoTIFF fixture.
- Request targets production API or default non-isolated port unexpectedly.
- Local API accepts upload but no dataset/status row is created.

## Evidence To Capture

- Upload modal/dropzone locator state.
- Upload request URL/status and created dataset ID.
- Local DB assertion for created dataset and queue row.
- One screenshot only for UI validation/layout failure.

