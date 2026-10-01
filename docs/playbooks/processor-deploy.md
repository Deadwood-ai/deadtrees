# Processor Deploy Notes

The processor image is built from the repository root with
`docker-compose.processor.yaml`. Keep runtime output out of the git checkout so
deploy builds only send source files as Docker context.

For provisioning an additional processor host, use
[`processor-worker-setup.md`](processor-worker-setup.md). For the list of
production hosts and how each one is scheduled, use
[`processor-hosts.md`](processor-hosts.md). This file only covers deployment
hygiene for an existing processor checkout.

Processor runtime artifacts should live under `/data`, for example
`/data/processing_dir`. The one exception is ODM output: the gitignored
`processor/temp/` directory is mounted at `/app/processor/temp`, and the Docker
build context excludes it. The image contains the processor code, so the
checkout is the build context but is not mounted into the running worker.

## Current Production Model

- one long-lived processor container per host
- `command: python -m processor.src.continuous_processor`
- `restart: unless-stopped`
- deploys and Docker maintenance go through tracked scripts under `scripts/`
- the worker must be drained before any planned restart or Docker daemon change

The host-side drain control file defaults to
`.local/processor-control/drain-request.json` in the production checkout. Compose
bind-mounts that gitignored directory at `/processor-control` in the worker. While
the request exists the worker finishes its current task and refuses to claim a
new one. Keep control state separate from `/data`: Snap-packaged Docker can expose
that mount only inside its own namespace, where host deploy scripts cannot see it.

## Deploy Steps

Use `scripts/processor_auto_deploy.sh` on the host instead of ad hoc `docker
compose` commands. The script:

1. records the current and target SHAs in `auto-deploy.log`;
2. requests a drain;
3. waits until the host worker has no active claimed queue row;
4. fast-forwards the checkout to the exact `origin/main` SHA fetched before draining;
5. rebuilds `processor`;
6. force-recreates the processor container; and
7. clears the drain request after the new container is running; and
8. records the successfully activated SHA under `.local/`.

If the script fails after setting the drain request, it intentionally leaves the
drain file in place and creates `.local/processor-deploy-paused`, so the worker
does not resume unexpectedly on a partially updated checkout and cron does not
reapply a known-bad release. After fixing or replacing the target release, run
`./scripts/processor_auto_deploy.sh --resume`; the next cron run retries while
the drain remains in place. Checkout advancement alone is not deployment
success, and resetting the bind-mounted checkout is not a safe rollback.

Waiting for the drain never pauses automatic deploy on its own. Network failures
and 5xx responses are logged and polled through. When the wait reaches
`PROCESSOR_DRAIN_TIMEOUT_SECONDS`, `wait-for-idle` exits with code 4 and the
deploy exits cleanly with the drain still set; the next cron run waits again, so
the host deploys as soon as a long task finishes. Only real failures, such as a
broken build or a new release that never becomes ready, pause automatic deploy.

If the existing processor is stopped or crash-looping before it can acknowledge
the drain, including if it fails after the initial availability check, the deploy
script stops the container and enters recovery mode. That mode can continue
without an acknowledgement only when the database proves the worker has no
active queue row and there is no legacy unowned active row.

After repeated queue-loop failures, the worker records
`.local/processor-control/loop-unhealthy.json` before exiting. The marker
survives Docker's automatic restart, so host deploy and maintenance checks can
enter recovery even when they miss the brief restart transition. A successful
queue poll clears the marker; do not remove it manually to make a failing worker
appear healthy.

The host scripts require repeated stopped-state observations before entering
recovery; a single failed Docker inspection cannot stop an active worker. During
long drains the control tool reuses its Supabase session, refreshing only after
an authentication-expiry response.

## Release Handoff (Opt-In Per Host)

`scripts/processor_handoff_deploy.sh` replaces the drain deploy on a host that
has room for two workers. It removes the wait for a long running task: the new
release takes the next task at once, and the old release finishes its own task.

The processor image contains its code, and Compose no longer bind-mounts
`processor/` or `shared/`. A running container keeps the release it was started
with while the checkout moves on, so two releases can run side by side.

The host has two worker slots. Each slot has its own resources:

| | slot a | slot b |
| --- | --- | --- |
| Compose project | default (`deadtrees-processor-1`) | `<checkout>-b` (`deadtrees-b-processor-1`) |
| Worker ID | host default | host default + `-b` |
| Control directory | `.local/processor-control` | `.local/processor-control-b` |
| Processing directory | `/data/processing_dir` | `/data/processing_dir_b` |
| ODM temp directory | `processor/temp` | `.local/processor-temp-b` |

`.local/processor-active-slot` names the slot that claims new tasks. A host
without this file runs only slot a, so drain-deploy hosts work as before.

On each run, the script:

1. removes the other slot if it is drained and its worker holds no task, then
   gives the active slot the full `PROCESSOR_MEMORY_LIMIT` and clears its claim
   limits;
2. if `origin/main` moved and the other slot is free, fast-forwards the
   checkout, builds the image in the other slot's project and starts that slot
   drained, capped at `PROCESSOR_HANDOFF_MEMORY_LIMIT`, and with claim limits
   that skip `PROCESSOR_HANDOFF_TASK_BLACKLIST` (`odm_processing` by default);
3. waits until the new worker acknowledges the drain with the target release SHA;
4. drains the active slot, records the new active slot and release, and clears
   the new slot's drain, so the new release starts claiming;
5. removes the old slot at once if it was idle. Otherwise a later run removes it.

Only one handoff runs at a time. If another release lands while the old slot is
still finishing, the release waits until that slot is free, and the active slot
keeps working meanwhile. If the build or the startup fails before the switch,
the script removes the new slot. The old worker never stopped claiming. The
script then pauses automatic deploy with `.local/processor-deploy-paused`. After
the fix, run `./scripts/processor_handoff_deploy.sh --resume`.

The script refuses to run when:

- `PROCESSOR_HANDOFF_MEMORY_LIMIT` is missing from `.env`;
- the active worker still bind-mounts its code (deploy once with
  `processor_auto_deploy.sh` first);
- the active slot has a drain request.

`processor_auto_deploy.sh` refuses to run on a handoff host. Docker maintenance
waits until no retired slot remains.

While both slots run, they share the CPU, the GPU and the host memory. The old
slot's long task is usually ODM, which runs in its own container with a 100 GB
limit. Size `PROCESSOR_HANDOFF_MEMORY_LIMIT` to what the host has left beside
that, for example about 24 GB on a 125 GB host. A task that needs more memory
than the handoff limit fails if it starts during the overlap.

`./scripts/processor_handoff_deploy.sh --status` prints the active slot, the
activated release, and the container, drain and queue state of each slot.

To enable handoff on a host (a production change that needs approval):

1. Let the drain deploy activate a release that contains this script, so the
   worker runs without code bind mounts.
2. Set `PROCESSOR_HANDOFF_MEMORY_LIMIT` in `.env`.
3. In the crontab, replace `processor_auto_deploy.sh` with
   `processor_handoff_deploy.sh`.

To return to drain deploy, wait until only one slot runs. If slot b is active,
hand off back to slot a first. Then delete `.local/processor-active-slot` and
restore the crontab entry.

## Docker Maintenance

Use `scripts/processor_docker_maintenance.sh` for Docker Snap refreshes or any
planned daemon restart. The script renews the Snap hold, drains the worker,
stops the container, refreshes Docker, re-applies the hold, restarts the
processor, and logs to `processor-maintenance.log`.

Run the maintenance script from the checkout-owner cron. It delegates only the
validated Docker Snap hold or refresh command to the root-owned
`/usr/local/sbin/deadtrees-processor-snap-control` helper through a narrow sudo
rule. Root must never execute scripts, Compose configuration, or environment
files from the writable checkout. The shared runtime lock serializes deploy and
maintenance operations.

Hold renewal does not depend on checkout cleanliness because it never builds or
deploys repository code. Full maintenance still requires a clean checkout and
uses the same stopped-worker/no-active-row recovery guard as auto-deploy.

The recommended hold-renew command is:

```bash
PROCESSOR_SNAP_HOLD_DURATION=168h ./scripts/processor_docker_maintenance.sh --renew-hold-only
```

Do not run `snap refresh docker`, `systemctl restart snap.docker.dockerd`, or
other daemon restarts directly on a busy processor host without first draining
the worker or proving it is idle.

## Manual Checks

```bash
python3 scripts/processor_runtime_control.py status
tail -80 auto-deploy.log
tail -80 processor-maintenance.log
docker inspect deadtrees-processor-1 --format 'Cmd={{json .Config.Cmd}} RestartPolicy={{.HostConfig.RestartPolicy.Name}} StartedAt={{.State.StartedAt}}'
snap refresh --time
```

Before cleaning old artifacts on `processing-server`, confirm no active
processor or ODM task still depends on them.
