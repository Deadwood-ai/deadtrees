# Processor Deploy Notes

The processor image is built from the repository root with `docker-compose.processor.yaml`.
Keep runtime output out of the git checkout so deploy builds only send source files as Docker
context.

For provisioning an additional processor host, use
[`processor-worker-setup.md`](processor-worker-setup.md). This file only covers
deployment hygiene for an existing processor checkout.

Processor runtime artifacts should live under `/data`, for example `/data/processing_dir`, or
another non-repo path mounted into the processor container. Do not leave ODM or tree-cover
temporary output under the checkout, especially under `processor/temp/`, before rebuilding the
processor image.

Before cleaning old artifacts on `processing-server`, confirm no active processor or ODM task still
depends on them.
