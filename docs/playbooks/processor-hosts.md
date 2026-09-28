# Processor Hosts And Auto-Deploy

Read this before checking, deploying to, or touching any production processor
host. It lists every host that runs a production worker, how each one picks up a
new release, and where to look when a deploy stalls.

The deploy mechanics themselves (drain, fast-forward, rebuild, recreate, pause)
are in [`processor-deploy.md`](processor-deploy.md). Adding a host is in
[`processor-worker-setup.md`](processor-worker-setup.md). Update the table below
whenever a host is added, removed, or changes how it is scheduled.

## What A Merge To `main` Does

Every host below runs the same tracked `scripts/processor_auto_deploy.sh` once a
minute. There is no push-based deploy: merging to `main` is the deploy.

1. On its next tick each host fetches `origin/main` and sees a new SHA.
2. It sets a drain. The worker finishes its current task and claims no new one.
   An ODM task or a very large ortho can take many hours, and the deploy waits
   as long as it takes: after `PROCESSOR_DRAIN_TIMEOUT_SECONDS` (12 hours) a run
   exits with the drain still set, and the next run keeps waiting.
3. Once the worker is idle, the script fast-forwards the checkout, rebuilds the
   image, recreates the container, waits for it to report the new release SHA,
   and clears the drain.
4. The first task the host claims after that runs on the new release. No task
   ever starts on old code after the drain is set.

The hosts deploy independently, so for a while after a merge some hosts may
still be draining on the old release while others already run the new one.

## Hosts

SSH aliases are operator-local; the names below are host names. Worker IDs are
what appears in `v2_queue.claimed_by` and in the processor logs.

| | `processing-server` | `helicon` | `deepl1` |
| --- | --- | --- | --- |
| Checkout | `/home/jj1049/prod/deadtrees` | `/opt/deadtrees_prod/deadtrees` | `/home/clemens/deadtrees` |
| Runs as | `jj1049` | `cmosig` | `clemens` |
| Trigger | crontab, every minute | user systemd timer, every minute | crontab, every minute |
| Compose override | none | none | `.local/processor/deepl1.yaml` |
| Worker ID | `host-f9760a054cb8` | `host-bb400fd18e59` | `host-56916e6e7ab8` |
| GPU | 1x RTX 3090 | 1x RTX 2080 Ti, shared | GPU1 of 2x TITAN RTX, via MPS |
| Docker maintenance | nightly Snap hold renewal | none | none |

Every host logs to `auto-deploy.log` in its checkout. Deploy state lives under
`.local/` in the checkout: `processor-activated-sha`,
`processor-activated-worker-id`, `processor-control/` and, after a failed deploy,
`processor-deploy-paused`.

### `processing-server`

The reference host. `docs/playbooks/create-release.md` documents its crontab:

```cron
* * * * * cd /home/jj1049/prod/deadtrees && ./scripts/processor_auto_deploy.sh
0 3 * * * cd /home/jj1049/prod/deadtrees && PROCESSOR_SNAP_HOLD_DURATION=168h ./scripts/processor_docker_maintenance.sh --renew-hold-only
```

- Docker is a held Snap. The only privileged action is the root-owned
  `/usr/local/sbin/deadtrees-processor-snap-control` helper, run through a narrow
  sudo rule. The account has no other sudo.
- The host also runs `deadtrees-test-processor-1`, a separate test stack that
  auto-deploy does not manage. Leave it alone.
- Other entries in the same crontab (for example `freidata_cron.sh`) are
  unrelated to the processor.

### `helicon`

A shared compute server; the production worker is one tenant among several.

- **Trigger.** `cron` never runs jobs for this LDAP/NFS-home account (its PAM
  session setup fails under `/etc/pam.d/cron`), so the deploy runs from a user
  systemd timer instead, with lingering enabled:
  `~/.config/systemd/user/deadtrees-processor.timer` →
  `deadtrees-processor.service` → `sg docker -c /opt/deadtrees_prod/poll_processor.sh`.
  The `sg docker` wrapper gives the lingering user manager access to the Docker
  socket.
- **Launcher.** `/opt/deadtrees_prod/poll_processor.sh` lives outside the
  checkout and is not tracked. It runs `processor_auto_deploy.sh`, then starts the
  container if it is not running. Its own output goes to
  `/opt/deadtrees_prod/poll_processor.log`; the deploy itself still logs to the
  checkout's `auto-deploy.log`.
- **Extra pause switch.** `touch /opt/deadtrees_prod/processor.paused` makes the
  launcher skip both the deploy and the relaunch. It exists for development
  sessions that need the single GPU. It is separate from the deploy pause file
  and from the drain; check for it when `helicon` stops deploying.
- The machine's local disk and GPU are shared with other users' work. Resource
  caps come from `PROCESSOR_CPU_LIMIT` in `.env`.
- Timer status: `systemctl --user list-timers deadtrees-processor.timer`.

### `deepl1`

A workstation with two GPUs. GPU0 drives the display and is for its users; the
processor gets GPU1.

- **Override.** `.local/processor/deepl1.yaml` pins the worker to GPU1 (MPS,
  `EXCLUSIVE_PROCESS`, `deadtrees-mps.service`) and puts it in the
  `deadtrees.slice` cgroup for a memory floor. The deploy and maintenance scripts
  merge `.local/processor/<short hostname>.yaml` automatically, and each deploy
  logs `Using compose files:`. Never run `docker compose up` on this host without
  `-f .local/processor/deepl1.yaml`; the container would come up on the display
  GPU.
- Compose here is 2.18.1, which ignores `devices: !override`. That is why the
  override also sets `CUDA_VISIBLE_DEVICES` by GPU UUID.
- The resolver (systemd-resolved) fails intermittently. On 2026-09-27 a DNS
  failure while the deploy waited for the drain paused auto-deploy for the night,
  leaving the worker drained and idle. `wait-for-idle` now retries network errors
  and 5xx responses until its timeout instead of failing the deploy.
- The crontab keeps a commented-out legacy launcher
  (`.local/processor/auto_deploy_processor.sh`). Do not re-enable it.

## Checking All Hosts

All of these are read-only. Run them from the host's checkout.

```bash
git log -1 --oneline                          # deployed code
cat .local/processor-activated-sha            # last successfully activated release
ls .local/processor-deploy-paused 2>/dev/null && cat .local/processor-deploy-paused
python3 scripts/processor_runtime_control.py status   # drain state and active task
tail -40 auto-deploy.log
docker inspect deadtrees-processor-1 --format '{{.State.Status}} StartedAt={{.State.StartedAt}}'
```

A host is current when `HEAD`, `processor-activated-sha` and `origin/main` are
the same SHA, there is no pause file, and the log's last line is `No changes`.
On `helicon`, also check that `/opt/deadtrees_prod/processor.paused` is absent.

## When A Host Stops Deploying

The script logs every decision, so start with `tail -80 auto-deploy.log`.

| Log line or state | Meaning | What to do |
| --- | --- | --- |
| `Skipping deploy because automatic processor deploy is paused` | An earlier deploy failed after setting the drain. The worker is drained and idle. | Read the pause file and the log above the failure. Fix the cause, then run `./scripts/processor_auto_deploy.sh --resume`. That only removes the pause file; the next tick retries. |
| `Skipping deploy because an operator drain is active` | Someone set a drain by hand. | Find out who and why before clearing it. |
| `Refusing deploy from dirty checkout` | Files in the checkout were edited or added. | Remove or move the change. Never commit or patch in a production checkout. |
| `Refusing deploy because HEAD contains local commits` | The checkout has commits that are not on `main`. | Ask the host owner. |
| `Skipping deploy check because another processor runtime operation already holds` | A deploy or maintenance run is still going, for example a long drain. | Normal. Wait. |
| `transient_error` entries during a drain | Network or 5xx failures while polling the queue. | Retried automatically until the drain timeout, then the next run keeps waiting. |
| `Worker still busy after ...s; keeping the drain` | The worker's current task outlasted one drain wait. | Normal for long tasks; the host deploys once the task finishes. Check progress in `docker logs deadtrees-processor-1` if it looks stuck. |
| No new lines at all | The trigger is not running. | Check the crontab, or on `helicon` the timer and `processor.paused`. |

`--resume` retries the same target release. If the release itself is broken, fix
it on `main` first; resuming a known-bad release only pauses the host again.

## Rules For Agents

- Checking is read-only. Changing a host (resuming, draining, restarting,
  editing crontabs, timers or overrides) is a production change. Do it only when
  the user explicitly asks.
- Do not edit files in a production checkout. A dirty checkout blocks every
  later deploy on that host.
- Do not delete `.local/processor-control/drain-request.json` or
  `loop-unhealthy.json` to get a worker running. Use the scripts.
- Do not run `docker compose up`, `restart` or `down` on a busy worker. Drain
  first, as `processor-deploy.md` describes.
- Never print `.env` values. List key names only when you need them.
