# AI Labeling Service (SAM 3)

The editors' AI tools (box and clicks, "Find trees") call a SAM 3 service on the
processing server's RTX 3090. The processing server sits behind the university
VPN, so it opens the connection itself:

```text
browser ──HTTPS──> data2 nginx /api/v1/sam/ ──auth_request──> API /labeling/sam-authorize
                        │ (signed-in users only)
                        └──> 127.0.0.1:18731 on data2 ══reverse SSH tunnel══> processing server 127.0.0.1:18731
```

- Code: `labeling-service/` (`sam_service/app.py` routes, `models.py` GPU work,
  `masks.py` outlines). Tests: `python -m pytest labeling-service/tests` in a
  venv from `labeling-service/requirements.txt`.
- Weights: `~/models/sam3` on the processing server (official `facebook/sam3`,
  gated on Hugging Face; access approved 5 Oct 2026). They are not in the repo.
- The model loads on the first request (about 6 s) and unloads after 15 minutes
  without requests. Loaded it holds about 2.6 GB; `SAM_GPU_FRACTION` caps it so
  the processor keeps the rest of the card.

## Processing server

Both parts run as systemd user units of `jj1049`; the templates are in
`labeling-service/deploy/`. The service runs from the production checkout
`~/prod/deadtrees`, which auto-deploys from `main`; restart the service after a
change under `labeling-service/`.

```bash
python3 -m venv ~/.local/share/deadtrees-sam/venv
~/.local/share/deadtrees-sam/venv/bin/pip install -r ~/prod/deadtrees/labeling-service/requirements.txt
cp ~/prod/deadtrees/labeling-service/deploy/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now deadtrees-sam deadtrees-sam-tunnel
curl -s 127.0.0.1:18731/health
```

The tunnel key `~/.ssh/deadtrees-sam-tunnel` is used for nothing else. On data2
its `authorized_keys` line for the no-shell account `sam-tunnel` reads:

```text
restrict,port-forwarding,permitlisten="127.0.0.1:18731",command="/usr/sbin/nologin" ssh-ed25519 <key> deadtrees-sam-tunnel
```

`permitlisten` only limits remote forwards, and `permitopen="none"` is not valid in
`authorized_keys` (sshd then rejects the whole key), so sshd also gets a rule for this
account in `/etc/ssh/sshd_config.d/deadtrees-sam-tunnel.conf`:

```text
Match User sam-tunnel
    AllowTcpForwarding remote
    PermitOpen none
    PermitListen 127.0.0.1:18731
    AllowAgentForwarding no
    AllowStreamLocalForwarding no
    X11Forwarding no
    PermitTTY no
    ForceCommand /usr/sbin/nologin
```

Together they allow one listener on data2's loopback and nothing else: no
local forwards into data2, no shell, no agent or socket forwarding. Check with
`sshd -T -C user=sam-tunnel,host=x,addr=127.0.0.2`.

## data2

Host nginx serves data2 from a hand-edited config; `nginx/api-conf/storage-server.conf`
carries the reference `map $http_origin $sam_cors_origin`, `location = /_authorize_sam`
and `location /api/v1/sam/` blocks. On the live host the API is reached at
`127.0.0.1:40831`. Root changes on data2 go through the documented docker
route (there is no sudo), with a dated backup first.

## Checks

- On the processing server: `systemctl --user status deadtrees-sam deadtrees-sam-tunnel`
  and `curl -s 127.0.0.1:18731/health`.
- Through data2: an unauthenticated `POST https://data2.deadtrees.earth/api/v1/sam/segment`
  must answer 401; a signed-in request from the editor gets an outline.

## Rollback

Point the frontend back at Modal (`VITE_SAM_API_URL`), then stop the units:
`systemctl --user disable --now deadtrees-sam-tunnel deadtrees-sam`. The data2
nginx blocks are harmless without the tunnel (requests fail with 502); remove
them from the live config and reload to clean up.
