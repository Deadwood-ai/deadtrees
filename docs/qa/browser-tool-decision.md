# Browser Tool Decision

Date: 2026-06-16

## Decision

Use the built-in Browser as the default execution surface for ordinary local
DeadTrees agent QA.

Fallbacks:

- Use Browser Use CLI only for playbooks that need per-worker browser/session
  isolation or file upload, and require probe evidence that the selected Browser
  Use backend renders the real app.
- Use Chrome only when a journey explicitly needs the user's real Chrome
  profile, cookies, extensions, or logged-in browser state.
- Use Computer Use only when DOM/browser automation cannot operate a required
  local UI interaction and a screen-level fallback is acceptable.
- Use Playwright-backed helper scripts for deterministic fallback checks when
  Browser Use CLI or Browser cannot operate a control reliably.

## Why Browser Is The Default

The local QA platform needs repeatable evidence:

- route URL,
- locator visibility/count,
- console error summary,
- local API/Supabase endpoint checks,
- artifact paths,
- minimal screenshots only when visual evidence is needed.

The built-in Browser exposes these checks directly through Playwright-style
locators and console logs. That matches the playbook evidence contract better
than screen-only control.

## Current Evidence

Runner artifact:

```text
.local/qa-runs/browser-public-home
```

Executed playbook:

```text
public-home-discovery
```

Browser result:

```text
pass
```

Checks performed:

- `/` rendered `data-testid="home-page"` exactly once.
- `/dataset` rendered `data-testid="dataset-archive-page"` exactly once.
- `/deadtrees` rendered `data-testid="deadtrees-map-page"` exactly once.
- `/releases` rendered `data-testid="releases-page"` exactly once.
- Console error summary contained one non-blocking Ant Design deprecation
  warning for Modal `destroyOnClose`.

Notable finding:

- Home and releases routes include several
  `https://data2.deadtrees.earth/reference/...png` image assets. This is not a
  Supabase/API production mutation risk, but it is relevant if the desired local
  QA lane must be fully offline or fully local-asset-backed.

## Chrome Availability

Chrome is not currently exposed as a controllable browser backend in this
session. The available browser backend list contained only:

```text
Codex In-app Browser (type: iab)
```

Because Chrome is primarily useful for real user-profile state, this does not
block the default local QA lane. If a future playbook needs extension state or a
real saved Chrome session, run the same representative playbook through Chrome
and update this decision.

## Computer Use Assessment

Computer Use is available as a Mac screen-control fallback, but it is not the
right default for local QA because it operates at the UI/screen level and does
not naturally provide the structured locator, console, and network evidence
expected by the playbooks.

Use it only for cases such as:

- a canvas/map gesture that Browser/Playwright cannot perform,
- a system/browser permission prompt that cannot be reached through Browser,
- a visual-only issue where a screenshot and coordinates are the relevant
  evidence.

## Browser Use CLI Probe

Hardening evidence:

```text
docs/qa/browser-use-cli-evidence.md
```

Result:

- Browser Use CLI is available via `uvx --from browser-use`.
- It supports named sessions.
- It supports indexed file upload.
- A local upload probe successfully attached
  `frontend/test/fixtures/geotiff/upload-validation/rgb-real-crop.tif`.

Decision:

- Do not use Browser Use default Chromium as the primary real-app QA renderer
  unless `scripts/qa/browser-use-real-app-probe.sh` classifies it as `pass` for
  the target route. It has previously rendered `/dataset` as a blank page while
  Playwright and Browser Use with a real Chrome profile rendered the app.
- Use Browser Use CLI for isolated worker sessions and upload-specific
  playbooks only after a current probe produces usable DOM and screenshot
  evidence.
- Keep built-in Browser as the default for simple route/locator/console checks.
- Keep Playwright helpers as the deterministic fallback.

## Follow-Up Comparison Still Recommended

For a fuller comparison, repeat the following playbooks when Chrome is exposed
as a backend:

- `public-archive-detail-download`
- `auth-shell`
- `auditor-queue-triage`

Capture:

- pass/fail/blocked status,
- setup friction,
- evidence quality,
- tab/session cleanup behavior,
- whether multiple workers can run without state collision.
