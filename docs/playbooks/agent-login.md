# Agent login for signed-in checks

Agents sometimes need to act as a signed-in user, for example to prove that a
dataset download works. They do this through `dt-agent-session`, which signs in
as a dedicated agent account, runs one narrow check, signs out and prints JSON.
The agent never reads the password: a host wrapper injects it from a host-local
file. 3DTrees uses the same interface (3DT-2311), so commands carry over.

## Account policy

- One ordinary account, for example `agent-check@deadtrees.earth`. No
  `privileged_users` row: no operate, audit, private-view or private-upload
  rights, and no exemption from the daily download allowance.
- Auth `app_metadata.internal_test = true`, which marks it as a test account
  the same way 3DTrees does.
- Not shared with operator scripts. `scripts/requeue_datasets_via_api.py` and
  similar tools keep their own processor credentials.
- Only humans create the account, set its password or rotate it.

## Credentials on a host

The wrapper reads `~/.config/deadtrees/agent-login.env` (override with
`DEADTREES_AGENT_ENV_FILE`) and refuses to run unless the file is mode 600.

| Variable | Meaning |
| --- | --- |
| `DEADTREES_AGENT_EMAIL`, `DEADTREES_AGENT_PASSWORD` | the agent account |
| `DEADTREES_AGENT_SUPABASE_URL`, `DEADTREES_AGENT_SUPABASE_ANON_KEY` | the public Auth endpoint and key the web app uses |
| `DEADTREES_AGENT_API_URL` | optional; defaults to production `https://data2.deadtrees.earth/api/v1` |

Install the wrapper once per host from an up-to-date checkout:

```bash
ln -sf ~/deadtrees/scripts/dev/dt-agent-session ~/.local/bin/dt-agent-session
```

Agents must not read, print or copy the env file. Run the wrapper instead.

## Actions

```bash
dt-agent-session whoami
dt-agent-session get /download/datasets/1234/status
dt-agent-session download-check 1234 [--labels] [--no-bundle] [--wait 300]
dt-agent-session --api-url http://localhost:PORT/api/v1 whoami
```

- `whoami` prints the actor id, masked email, role, `internal_test` flag and
  token expiry.
- `get PATH` does one signed-in GET on a path relative to the API. Fields that
  look like tokens or signed links are replaced with `[redacted]`.
- `download-check ID` requests the dataset bundle, waits until it is built,
  follows the signed link and reads only its first byte. It prints filename,
  HTTP status and size, never the link. `--labels` also checks the labels
  GeoPackage; `--no-bundle` skips the ortho bundle. These match the 3DTrees
  `--segmentation` and `--no-raw` options.

Every action signs out at the end (`scope=local`, so other sessions of the
account stay valid) and reports `signed_out`. Output is one JSON object on
stdout. Exit codes: 0 ok, 1 check failed, 2 usage, 3 missing credentials or
sign-in failed, 7 network.

## Production use

Production checks stay read-only in intent: sign in, read a status, or request
one small public dataset. A download request is counted against the account's
daily allowance and logged like any user download. Never use the agent account
to upload, edit, audit or share.

## Local stack

For an isolated QA stack, point a mode-600 file at a seeded local account:

```bash
source .local/supabase/current.env
umask 077
cat > .local/agent-login.env <<EOF
DEADTREES_AGENT_EMAIL=qa-viewer-local@example.com
DEADTREES_AGENT_PASSWORD='DeadTreesQA-Local-1!'
DEADTREES_AGENT_SUPABASE_URL=$SUPABASE_URL
DEADTREES_AGENT_SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
DEADTREES_AGENT_API_URL=${VITE_LOCAL_API_URL%/}
EOF
DEADTREES_AGENT_ENV_FILE=$PWD/.local/agent-login.env scripts/dev/dt-agent-session download-check 91001
```
