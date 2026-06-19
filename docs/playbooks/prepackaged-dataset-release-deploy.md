# Prepackaged Dataset Release Deploy

Use this checklist when deploying prepackaged dataset downloads. The API mints
authenticated StorageGRID/S3 signed URLs and records an audit row for each
download request. There is no application download quota for prepackaged
datasets.

## Release Inputs

- Bucket: `frct-deadtrees-products`
- Endpoint: `https://s3.bwsfs.uni-freiburg.de`
- Region: `fr1-ec82`
- Object prefix: `prepackaged/v2026-04-17/`

Expected objects:

```text
prepackaged/v2026-04-17/tree-cover-aerial-global_2026.04.17.zip
prepackaged/v2026-04-17/standing-deadwood-aerial-global-conservative_2026.04.17.zip
prepackaged/v2026-04-17/image-tiles-1024-global-aerial-sampled-20-random_2026.04.17.zip
```

## Required API Settings

Set these in the API runtime environment:

```text
PREPACKAGED_S3_ENDPOINT_URL=https://s3.bwsfs.uni-freiburg.de
PREPACKAGED_S3_REGION=fr1-ec82
PREPACKAGED_S3_BUCKET=frct-deadtrees-products
PREPACKAGED_API_READ_S3_ACCESS_KEY=<read-user-access-key>
PREPACKAGED_API_READ_S3_SECRET_KEY=<read-user-secret-key>
PREPACKAGED_SIGNED_URL_TTL_SECONDS=86400
```

The API read user only needs `s3:GetObject` on
`arn:aws:s3:::frct-deadtrees-products/prepackaged/*` and `s3:ListBucket` scoped
to the `prepackaged/*` prefix. It must not have write access.

## Production Migration Policy

Avoid manual production Supabase migrations. They should happen through the
merge-to-main workflow so schema history, reviewed SQL, and deployment state
stay aligned.

If the GitHub migration workflow fails, stop before changing host state and
diagnose the workflow failure first. For out-of-order migration errors, prefer
a reviewed follow-up migration with a newer timestamp or an explicit workflow
fix. Do not apply local SQL to production as a normal workaround.

## Upload Objects

Upload the ZIPs to the expected prefix from a host that has the publisher S3
credentials and AWS CLI configured:

```bash
aws --endpoint-url "$PREPACKAGED_S3_ENDPOINT_URL" s3 cp \
  /data/assets/prepackaged_datasets_out/tree-cover-aerial-global_2026.04.17.zip \
  s3://frct-deadtrees-products/prepackaged/v2026-04-17/tree-cover-aerial-global_2026.04.17.zip
```

Repeat for the other two ZIPs. Then verify object presence and sizes:

```bash
aws --endpoint-url "$PREPACKAGED_S3_ENDPOINT_URL" s3 ls \
  s3://frct-deadtrees-products/prepackaged/v2026-04-17/
```

## Verify API Runtime

Confirm that the API has deployed the prepackaged router:

```bash
curl -fsS https://data2.deadtrees.earth/api/v1/prepackaged/packages
```

Confirm production settings without printing secrets:

```bash
ssh storage-server 'docker exec deadtrees-api-1 python -c "
from shared.settings import settings
print(settings.DEV_MODE)
print(settings.PREPACKAGED_S3_ENDPOINT_URL)
print(settings.PREPACKAGED_S3_REGION)
print(settings.PREPACKAGED_S3_BUCKET)
print(settings.PREPACKAGED_SIGNED_URL_TTL_SECONDS)
print(bool(settings.PREPACKAGED_API_READ_S3_ACCESS_KEY))
print(bool(settings.PREPACKAGED_API_READ_S3_SECRET_KEY))
"'
```

Expected:

```text
False
https://s3.bwsfs.uni-freiburg.de
fr1-ec82
frct-deadtrees-products
86400
True
True
```

## Production Smoke Test

After signing in, trigger a frontend download. The API response should contain a
StorageGRID signed URL, not a `data2.deadtrees.earth/prepackaged/v1` token URL.

Confirm the API recorded the request in
`public.prepackaged_dataset_download_grants`. The `extra` JSON should include:

```json
{
  "event": "prepackaged_signed_download_created",
  "storage_bucket": "frct-deadtrees-products",
  "storage_key": "prepackaged/v2026-04-17/<zip-name>",
  "size_bytes": 123
}
```

The old Nginx-backed `/prepackaged/v1/` route and
`/_prepackaged_download_auth` validation endpoint are no longer part of the
tracked deployment config. If rollback to host-served ZIPs is required, restore
that route together with the matching API validation endpoint in the same
reviewed rollback change.

Signed URLs are direct object-storage URLs. Revoking an app-side grant prevents
new links, but an already issued URL remains usable until its one-day expiry
unless the object, credentials, or bucket policy are changed.

The old public asset path must stay blocked:

```bash
curl -sk -o /dev/null -w "%{http_code}\n" \
  "https://data2.deadtrees.earth/assets/v1/prepackaged_datasets_out/"
```

Expected: `404`.
