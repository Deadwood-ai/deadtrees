# Browser Tool Decision

Date: 2026-06-16

## Decision

Use the built-in Browser as the default execution surface for local DeadTrees
agent QA.

Fallbacks:

- Use Chrome only when a journey explicitly needs the user's real Chrome
  profile, cookies, extensions, or logged-in browser state.
- Use Computer Use only when DOM/browser automation cannot operate a required
  local UI interaction and a screen-level fallback is acceptable.

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

