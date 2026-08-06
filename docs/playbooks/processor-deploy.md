# Processor Deploy Notes

The processor image is built from the repository root with
`docker-compose.processor.yaml`. Keep runtime output out of the git checkout so
deploy builds only send source files as Docker context.

For provisioning an additional processor host, use
[`processor-worker-setup.md`](processor-worker-setup.md). This file only covers
deployment hygiene for an existing processor checkout.

Processor runtime artifacts should live under `/data`, for example
`/data/processing_dir`, or another non-repo path mounted into the processor
container. Do not leave ODM or tree-cover temporary output under the checkout,
especially under `processor/temp/`, before rebuilding the processor image.

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

1. records the current SHA and rollback command in `auto-deploy.log`;
2. requests a drain;
3. waits until the host worker has no active claimed queue row;
4. fast-forwards the checkout to the exact `origin/main` SHA fetched before draining;
5. rebuilds `processor` and `tcd`;
6. force-recreates the processor container; and
7. clears the drain request after the new container is running; and
8. records the successfully activated SHA under `.local/`.

If the script fails after setting the drain request, it intentionally leaves the
drain file in place so the worker does not resume unexpectedly on a partially
updated checkout. The next cron run retries until that SHA is successfully
activated; checkout advancement alone is not treated as deployment success.

If the existing processor is stopped or crash-looping before it can acknowledge
the drain, including if it fails after the initial availability check, the deploy
script stops the container and enters recovery mode. That mode can continue
without an acknowledgement only when the database proves the worker has no
active queue row and there is no legacy unowned active row.

The host scripts require repeated stopped-state observations before entering
recovery; a single failed Docker inspection cannot stop an active worker. During
long drains the control tool reuses its Supabase session, refreshing only after
an authentication-expiry response.

## Docker Maintenance

Use `scripts/processor_docker_maintenance.sh` for Docker Snap refreshes or any
planned daemon restart. The script renews the Snap hold, drains the worker,
stops the container, refreshes Docker, re-applies the hold, restarts the
processor, and logs to `processor-maintenance.log`.

Run the maintenance script from root's cron. It intentionally refuses non-root
execution because Snap hold and refresh operations are privileged. Keep
`processor_auto_deploy.sh` in the normal checkout owner's crontab. The shared
runtime lock is a deliberately content-free, cross-user-writable file so these
two scheduled users still serialize deploy and maintenance operations.

Hold renewal does not depend on checkout cleanliness because it never builds or
deploys repository code. Full maintenance still requires a clean checkout and
uses the same stopped-worker/no-active-row recovery guard as auto-deploy.

The recommended hold-renew command is:

```bash
PROCESSOR_SNAP_HOLD_DURATION=7d ./scripts/processor_docker_maintenance.sh --renew-hold-only
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
