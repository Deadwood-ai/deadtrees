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
- Required host-local Compose overrides are documented and included by every
  deployment path. Keep automatic deployment disabled when the tracked deploy and
  maintenance scripts cannot preserve a required override.
- On hosts smaller than the defaults, set `PROCESSOR_CPU_LIMIT` (and optionally
  `PROCESSOR_MEMORY_LIMIT`) in `.env` so the processor container's caps fit the
  machine. `PROCESSOR_CPU_LIMIT` must be `<=` the host's CPU core count, or
  `docker compose up` fails with a "range of CPUs" error. Defaults: `30` / `96G`.
- The processor SSH keypair must sit on a filesystem the Docker daemon (root)
  can read. If the home directory is on NFS with root-squash, the default
  `~/.ssh/processing-to-storage` mount fails with
  `mkdir /…/.ssh: permission denied`. Put the key on local disk (e.g. the
  checkout's gitignored `.local/ssh/`) and set `PROCESSOR_SSH_KEY_PATH` to it.
- The storage server's reviewed public Ed25519 host key is pinned in
  `processor/config/storage_known_hosts` and loaded by every processor container.

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
- `${PROCESSOR_ASSETS_DIR:-./assets}`, mounted read-only at `/app/assets`
- `/data`
- gitignored `.local/processor-control`, mounted at `/processor-control`
- Docker socket for ODM and model helper containers
- processor SSH private/public keys
- reviewed storage-server host key from `processor/config/storage_known_hosts`
- `/etc/machine-id` mounted read-only at `/host/etc/machine-id`

Do not put runtime output under the git checkout. Keep temporary processing
artifacts under `/data`, for example `/data/processing_dir`.

Drain control files are the exception: create `.local/processor-control` in the
checkout and keep it writable by the host account running deploy cron. Compose
bind-mounts that small directory into the worker; processing output does not go
there. Set `PROCESSOR_CONTROL_DIR` only when the host needs a different source
path.

When code is deployed from a separate operator checkout, set
`PROCESSOR_ASSETS_DIR` in `.env` to the existing populated asset directory.
The guarded auto-deploy runs `scripts/processor_asset_preflight.py` before it
starts or resumes the worker. A missing model or metadata dataset leaves the
worker drained and pauses automatic deployment.

### Optional: reserve one GPU via MPS

A host can pin the worker to one GPU and keep other users off it. Hosts that do
not set `CUDA_MPS_PIPE_DIRECTORY` are unaffected. To opt in:

- on the host, set the card to `EXCLUSIVE_PROCESS` (`nvidia-smi -i <index> -c EXCLUSIVE_PROCESS`)
  and run an MPS control daemon with `CUDA_VISIBLE_DEVICES=<index>` and
  `CUDA_MPS_PIPE_DIRECTORY=/var/run/deadtrees-mps`
- in the host-local, gitignored compose override, set `NVIDIA_VISIBLE_DEVICES=<index>`
  and `CUDA_MPS_PIPE_DIRECTORY=/var/run/deadtrees-mps` for `processor`, and
  bind-mount `/var/run/deadtrees-mps` at the same path
- if `<index>` is not `0`, also pin the card at the CUDA level in that override
  with `CUDA_VISIBLE_DEVICES=<GPU UUID>` (take the UUID from `nvidia-smi -L`, never
  the index: PCI enumeration order is not stable across reboots). The tracked
  compose maps `/dev/nvidia0` explicitly, and `devices: !override` does not remove
  it on every Compose release -- on 2.18.1 the tag is silently ignored and the
  mapping is appended, leaving GPU 0 visible inside the container. The UUID filter
  holds on every version.
- name the override `.local/processor/<short hostname>.yaml`. The tracked deploy
  and maintenance scripts merge exactly that path, so automatic deployment
  preserves the pinning instead of recreating the container without it. Each
  deploy records the files it used in `auto-deploy.log` (`Using compose files:`).

The worker forwards both values to the TCD helper container and bind-mounts the
same host path there, so the path must be identical on host and worker.

## Bring-Up

From the production checkout on the new worker host:

```bash
cd /home/jj1049/prod/deadtrees
git fetch origin main
git checkout main
git pull --ff-only origin main
mkdir -p .local/processor-control
python3 scripts/processor_asset_preflight.py
docker compose -f docker-compose.processor.yaml build processor tcd
docker compose -f docker-compose.processor.yaml up -d processor
```

On a host that keeps a `.local/processor/<short hostname>.yaml` override, append
`-f .local/processor/<short hostname>.yaml` to both commands above, exactly as the
tracked scripts do. Bringing the container up from the tracked file alone drops
whatever the override pins.

If the host should auto-deploy like an existing production processor, first verify
that the tracked host scripts include every required Compose override and safety
control. Otherwise keep auto-deploy disabled and record the host as manual-deploy.
Never install or enable deployment scheduling as part of monitoring. When it is
safe to automate, install the tracked host scripts rather than a `docker compose
up` cron loop. The expected entries are documented in
`docs/playbooks/create-release.md`.

## Validation

Check the host:

```bash
docker ps --format "{{.Names}}\t{{.Status}}\t{{.Image}}" | grep deadtrees-processor
docker inspect deadtrees-processor-1 \
  --format 'State={{.State.Status}} Pid={{.State.Pid}} StartedAt={{.State.StartedAt}} RestartCount={{.RestartCount}} OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}} Image={{.Image}} Memory={{.HostConfig.Memory}} NanoCPUs={{.HostConfig.NanoCpus}} CgroupParent={{.HostConfig.CgroupParent}}'
docker logs --tail 120 deadtrees-processor-1
```

Add the host to local operator monitoring without committing its SSH alias:

```bash
DEADTREES_OPERATOR_PROCESSING_HOSTS=host-label=local-ssh-alias \
  python3 scripts/operator_status.py --skip-network --format markdown
```

The legacy primary target remains `DEADTREES_OPERATOR_PROCESSING_HOST`. The
additional list is for every other processor host. A valid healthy probe requires
`State=running` and a nonzero PID; record unavailable inspection as unknown rather
than inferring state from `docker ps`.

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
- Storage host-key mismatch: stop and verify the new fingerprint through an
  authenticated or out-of-band channel. Update `processor/config/storage_known_hosts`
  through review and redeploy; never learn a replacement key from the failing
  connection or switch back to automatic host-key acceptance.
- Missing Docker socket or NVIDIA runtime: ODM/model child containers may fail
  even though the processor container starts.
- Permanently dead worker with an owned active row: manual queue intervention is
  still required until the processor has heartbeat or lease recovery.

## Disable Or Roll Back A Worker

For planned shutdown:

```bash
python3 scripts/processor_runtime_control.py set-drain --reason planned-shutdown
python3 scripts/processor_runtime_control.py wait-for-idle --timeout-seconds 43200
docker compose -f docker-compose.processor.yaml stop processor
```

Then verify that the queue has no active row owned by that worker. A graceful
SIGTERM should release or requeue the in-flight task. If the host was killed or
removed permanently while owning a task, inspect the active queue row before
making any production write.
