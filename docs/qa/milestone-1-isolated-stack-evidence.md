# Milestone 1: Isolated Stack Evidence

Date: 2026-06-16

## Scope

This evidence records the first full local app-stack isolation pass for
`docs/qa/local-agent-qa-plan.md`.

## Environment

- Worktree slug: `7f37`
- Supabase workdir: `.local/supabase/7f37`
- Supabase project id: `deadwood-api-7f37`
- Supabase API: `http://127.0.0.1:57021`
- Supabase DB: `postgresql://postgres:postgres@127.0.0.1:57022/postgres`
- Compose project: `deadtrees-test-7f37`
- Compose network: `deadwood_network_7f37`
- Nginx/API: `http://127.0.0.1:57080/api/v1/`
- Mailpit: `http://127.0.0.1:57024`
- Frontend: `http://127.0.0.1:57073/`

## Checks Passed

```bash
scripts/dev/isolated-supabase.sh status
```

Confirmed the light isolated Supabase stack was running with DB, Auth, REST,
and Kong. Optional services excluded by the default light profile were stopped.

```bash
set -a
source .local/supabase/current.env
set +a
docker compose -f docker-compose.test.yaml config
```

Confirmed the generated Compose project, network, ports, and container
Supabase URL:

- project: `deadtrees-test-7f37`
- network: `deadwood_network_7f37`
- API container Supabase URL: `http://host.docker.internal:57021`
- nginx published ports: `57080`, `57082`

```bash
set -a
source .local/supabase/current.env
set +a
venv/bin/deadtrees dev start --services=api-test,nginx,mailpit
```

Started the scoped backend-lite app stack on generated ports. Docker reported
`api-test`, `nginx`, and `mailpit` as healthy.

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:57080/api/v1/
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:57080/api/v1/docs
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:57024
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:57021/auth/v1/settings
```

Each endpoint returned `200`.

```bash
npm --prefix frontend run dev:local -- --host 127.0.0.1
```

Started Vite on `http://127.0.0.1:57073/`.

```bash
curl -fsS http://127.0.0.1:57073/src/config.ts
```

Confirmed Vite served generated local env values:

- `VITE_SUPABASE_URL=http://127.0.0.1:57021`
- `VITE_LOCAL_STORAGE_SERVER_URL=http://localhost:57080`
- `VITE_LOCAL_API_URL=http://localhost:57080/api/v1`

```bash
set -a
source .local/supabase/current.env
set +a
npm --prefix frontend run test:e2e:local -- contributor-local.spec.ts
npm --prefix frontend run test:e2e:local -- auditor-local.spec.ts
```

Results:

- contributor local E2E: 2 passed
- auditor local E2E: 4 passed

## Fixes Made During Verification

The local E2E specs had hardcoded default local service URLs. They now derive
from generated env values where available:

- `VITE_SUPABASE_URL` or `SUPABASE_URL`
- `VITE_LOCAL_API_URL`
- `LOCAL_MAILPIT_HTTP_PORT`

This keeps the default local workflow intact while allowing isolated worktree
stacks to run on generated ports.

## Remaining Milestone 1 Gaps

- Run the final static validation ladder after the larger QA scaffolding lands.
- Optionally prove two independent worktrees concurrently; current evidence
  proves this worktree can run on generated ports and avoids the default shared
  port band.
