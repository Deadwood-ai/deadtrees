# Browser Use CLI Evidence

Date: 2026-06-17

## Scope

This evidence records the hardening experiment for using Browser Use CLI as an
agent QA browser surface.

## Availability

Local PATH did not include `browser-use`, but `uvx --from browser-use` could
load Browser Use after using repo-local ignored tool/cache directories:

```bash
UV_CACHE_DIR=.local/uv-cache \
UV_TOOL_DIR=.local/uv-tools \
uvx --from browser-use browser-use --help
```

Observed package:

```text
browser-use version: 0.13.1
```

The CLI exposes commands relevant to local QA:

- `--session`
- `open`
- `state`
- `click`
- `type`
- `upload`
- `screenshot`
- `eval`
- `close`

## Doctor

`browser-use doctor` passed outside the sandbox:

```text
package: browser-use unknown
browser: Browser profile available
network: Network connectivity OK
cloudflared: not installed
profile-use: not installed
```

Cloud/profiling extras are not required for the local QA lane.

## Session Isolation Probe

Created two named sessions:

```bash
browser-use --session dt-qa-probe-a open <local page A>
browser-use --session dt-qa-probe-b open <local page B>
browser-use sessions
```

The CLI reported both sessions as independently running with separate PIDs.

## Automated Upload Probe

Automated command:

```bash
scripts/qa/browser-use-cli-probe.sh \
  .local/qa-runs/browser-use-cli-probe \
  --exercise-upload
```

Against a tiny local HTTP page with an `<input type="file">`, Browser Use CLI
reported the file input in `state` output as an indexed element.

Uploading the existing GeoTIFF fixture worked through that discovered index:

```bash
browser-use --session dt-qa-probe-a upload <discovered-index> \
  frontend/test/fixtures/geotiff/upload-validation/rgb-real-crop.tif
```

The page then reported:

```text
rgb-real-crop.tif
```

Latest automated report:

```text
status=pass
category=none
```

## Real Frontend Smoke

With the isolated stack running, Browser Use CLI also opened the real local
frontend:

```bash
uvx --from browser-use browser-use \
  --session dt-qa-real-frontend \
  --json open http://127.0.0.1:57073/
```

Evaluation in the named session returned:

```text
document.title = deadtrees.earth
```

## Decision

Browser Use CLI is suitable for a targeted local QA role:

- per-worker browser sessions,
- file-upload playbooks,
- browser state isolation probes.

It should not replace the built-in Browser for all playbooks yet because:

- it requires `uvx` and repo-local cache/tool setup unless preinstalled,
- element interaction depends on Browser Use's indexed accessibility state,
- for complex product flows, Playwright remains the deterministic fallback when
  a stable selector contract already exists.

Use it as the preferred fallback for file upload and session-isolated workers.
Keep Playwright as the deterministic fallback for CI-like probes.
