# Processor Worker Setup

Use this playbook when adding another processor host to the production queue.
The processor can run on multiple machines as long as each running worker has a
stable, unique worker ID and all hosts can reach the same production database,
storage server, Docker runtime, and required model/assets volume.

## Preconditions

- The production migration that adds `v2_queue.claimed_by` and
  `v2_queue.claimed_at` has been applied.
- The host has Docker Compose installed.
- GPU hosts have the NVIDIA container runtime configured.
- The host can SSH to the storage/API server with the processor keypair.
- `/data` exists and has enough free space for raw uploads, ODM output,
  GeoTIFFs, model outputs, and temporary processing files.
- The repository checkout is clean and tracks `origin/main`.
- Required assets and model files are present under the paths mounted by
  `docker-compose.processor.yaml`.

## Worker Identity

Every simultaneously running processor host needs a unique stable worker ID.

Preferred default:

- keep the compose mount `/etc/machine-id:/host/etc/machine-id:ro`
- let the processor derive `host-<first-12-chars-of-machine-id>`
  automatically

Explicit override:

- set `PROCESSOR_WORKER_ID` only when the host needs a custom stable value
- never reuse the same `PROCESSOR_WORKER_ID` on two running hosts

Duplicate worker IDs make queue ownership ambiguous and can make recovery or
log inspection unreliable.

## Required Mounts

The production compose file expects these host resources to exist:

- repository checkout mounted into the processor image during local build
- `./processor` and `./shared`
- `./assets`
- `/data`
- Docker socket for ODM and model helper containers
- processor SSH private/public keys
- `/etc/machine-id` mounted read-only at `/host/etc/machine-id`

Do not put runtime output under the git checkout. Keep temporary processing
artifacts under `/data`, for example `/data/processing_dir`.

## Bring-Up

From the production checkout on the new worker host:

```bash
cd /home/jj1049/prod/deadtrees
git fetch origin main
git checkout main
git pull --ff-only origin main
docker compose -f docker-compose.processor.yaml build processor tcd
docker compose -f docker-compose.processor.yaml up -d processor
```

If the host should auto-deploy like the existing production processor, install
the same cron entries from an existing production processor host. The expected
entries are documented in `docs/playbooks/create-release.md`.

## Validation

Check the host:

```bash
docker ps --format "{{.Names}}\t{{.Status}}\t{{.Image}}" | grep deadtrees-processor
docker inspect deadtrees-processor-1 \
  --format 'StartedAt={{.State.StartedAt}} RestartCount={{.RestartCount}} OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}'
docker logs --tail 120 deadtrees-processor-1
```

Check queue ownership in production Postgres:

```sql
select
  count(*) filter (where is_processing) as active_claims,
  count(*) filter (where is_processing and claimed_by is not null) as active_with_owner,
  count(*) filter (where is_processing and claimed_by is null) as active_without_owner,
  count(*) filter (where not is_processing and claimed_by is not null) as pending_with_owner,
  array_agg(distinct claimed_by) filter (where is_processing) as active_workers
from v2_queue;
```

Inspect active work:

```sql
select id, dataset_id, priority, is_processing, claimed_by, claimed_at, task_types
from v2_queue
where is_processing
order by claimed_at desc nulls last
limit 20;
```

Healthy signs:

- each active row has `claimed_by`
- `active_without_owner` is `0`
- `pending_with_owner` is `0`
- active workers show distinct worker IDs when multiple hosts are busy
- processor logs show claimed tasks with the expected worker ID

## Failure Modes

- Duplicate worker ID: stop one worker and restart it with a unique stable ID.
- Missing machine-id mount: add `/etc/machine-id:/host/etc/machine-id:ro` or set
  a unique `PROCESSOR_WORKER_ID`.
- Dirty checkout: resolve local changes before relying on cron auto-deploy.
- Missing storage SSH access: fix the processor keypair and storage host
  authorization before starting queue work.
- Missing Docker socket or NVIDIA runtime: ODM/model child containers may fail
  even though the processor container starts.
- Permanently dead worker with an owned active row: manual queue intervention is
  still required until the processor has heartbeat or lease recovery.

## Disable Or Roll Back A Worker

For planned shutdown:

```bash
docker compose -f docker-compose.processor.yaml stop processor
```

Then verify that the queue has no active row owned by that worker. A graceful
SIGTERM should release or requeue the in-flight task. If the host was killed or
removed permanently while owning a task, inspect the active queue row before
making any production write.
