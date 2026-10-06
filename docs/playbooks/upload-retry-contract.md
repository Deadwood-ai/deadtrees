# Upload retry contract

`POST /datasets/chunk` accepts the existing multipart fields. The browser sends
sequential 50-MiB chunks; the CLI can use other chunk sizes. Neither client needs
a new offset or checksum field. The server computes SHA-256 for each chunk.

- `upload_id` identifies one immutable upload: owner, filename, upload type,
  dataset metadata, and total chunk count. IDs contain 1–128 ASCII letters,
  digits, underscores or hyphens. Both current clients generate compatible IDs.
- Indexes are zero-based. The next unseen index must follow the last accepted
  index. An identical earlier chunk returns its original acknowledgement without
  changing the file. Different bytes or metadata return HTTP 409.
- The last chunk is accepted only after all preceding chunks. A completed final
  request returns the same dataset response on every identical retry, even after
  the temporary file has moved or the API process has restarted.
- Concurrent requests for one upload use a filesystem lock shared by API workers.
  A busy session returns HTTP 503 with `Retry-After: 2`, which the browser's existing
  bounded retry policy handles. Unrelated uploads use separate locks.
- No token is stored in a receipt. Authentication is checked on every request,
  and the authenticated user must match the receipt owner. A refreshed token for
  that same user works normally.

## Persistence and failure behavior

Receipts and lock files live in `settings.base_path / '.upload-sessions'`, outside
the nginx static aliases. The directory is private to the API runtime. Temporary
upload bytes retain their existing archive/raw-images paths. Accepted data is
flushed before an atomic receipt replacement. A retry overwrites any bytes beyond
the last saved receipt, recovering a partial append or an append whose receipt
was not saved. No second full copy of the upload is retained.

Validation of the assembled bytes that has no side effects (currently the ZIP
compression check for raw-image uploads) runs before finalization starts. A
rejected upload returns HTTP 400, its receipt stays `receiving`, and every
identical retry returns the same HTTP 400. The client must fix the file and
start again with a new upload ID.

The same step rejects a file that is already on the platform: any non-archived
dataset with the same fingerprint (`shared/hash.py`), whoever owns it. The
response is HTTP 409 with `detail.code == "DUPLICATE_UPLOAD"`, a `message` for
the contributor and `existing_dataset_id`, which is null when the caller may
not see that dataset. Other 409s of this contract carry a string `detail`, so
clients key on the code. Browser and CLI ask the database function
`find_duplicate_upload` with the same fingerprint before sending any bytes;
this step is the enforcement.

Before database/file finalization, a durable `finalizing` receipt prevents a
second attempt from repeating side effects. Normal successful finalization saves
the response before acknowledging the client. The filesystem and database are
not a distributed transaction: a process failure or ambiguous database response
after this fence returns HTTP 409 on subsequent attempts. It requires inspection
of existing dataset/status/storage state before recovery. Do not delete the
receipt or start another upload automatically; that could create a duplicate
dataset. Automatic reconciliation is outside this contract.

Receipts and lock files are intentionally retained, including after dataset
deletion. Removing one lets a delayed request reuse the ID; removing a live lock
file can also break mutual exclusion. Include this directory in storage backup
and recovery planning.

## Expiry of abandoned uploads

An upload expires when neither its `.tmp` file nor its receipt changed for
7 days (configurable). The retention job
`api/src/upload/abandoned_uploads.py`, run on the storage/API host by
`scripts/cron_cleanup_abandoned_uploads_docker.sh`, then deletes the
`<upload_id>.tmp` bytes. This covers uploads that stopped before their last
chunk and uploads whose final chunk failed validation. The job:

- deletes only files whose receipt is still `receiving`, or old `.tmp` files
  with a valid upload-ID name and no receipt;
- keeps `finalizing` uploads, which need manual inspection, and never deletes
  receipts or lock files;
- skips an upload while a request holds its lock.

A retry of an expired upload ID returns HTTP 409 "Upload data is missing;
restart with a new upload ID". Clients must restart with a new ID. Set the
expiry with `UPLOAD_TMP_RETENTION_DAYS` (or `--max-age-days`) and preview with
`DRY_RUN=1` (or `--dry-run`). The cron entry is installed on the host by hand,
like the other `scripts/cron_*.sh` jobs.

## Deployment boundary

This design assumes the current single API/storage host and one shared local
filesystem across its API workers. It needs no database migration. Mixed old and
new API workers are unsafe because old workers ignore receipts and locks. Drain
active uploads and replace all API workers together. An old `.tmp` upload without
a receipt is rejected with HTTP 409 and must restart using a new ID; its existing
bytes are preserved. Do not roll back to the append-only implementation while
uploads are active. Multi-host storage or automatic finalization recovery needs
a separate design.

## Local regression checks

Bootstrap and validate the isolated environment using
`docs/agents/environment-and-access.md`, then run:

```bash
deadtrees dev test api api/tests/routers/test_upload_retries.py api/tests/upload/
scripts/test-api-smoke.sh
```

The router tests use the real local database and storage for ZIP and GeoTIFF
uploads, including a rejected ZIP that is retried. Filesystem tests cover
separate-process locking, missing committed bytes, uncommitted append recovery,
owner conflicts, restart replay, the interrupted-finalization fence, validation
before the fence, and expiry of abandoned uploads. These tests do not identify the cause of any
particular reported production upload failure.
