# Frontend Browser Regression Playbook

Use this playbook after frontend changes, especially when the code should be tested against the production Supabase/API/storage surfaces while running the local frontend. Keep it short and visible: this is a smoke/regression pass, not a full QA matrix.

## Goal

Answer one question:

> Does this frontend change still work in a real browser against the same backend surfaces users hit in production?

Prefer the Codex in-app browser through Browser Use for visible checks. Use terminal tests for fast coverage, then use the browser for product behavior, map rendering, auth, console, and network symptoms.

## Preflight

1. Read the change scope.
   - If only frontend files changed, prefer a local frontend connected to production services.
   - If backend, migration, processor, or storage behavior changed too, add the relevant API/DB/processor checks before trusting the browser smoke.
2. Check the working tree and do not disturb unrelated local edits:

   ```bash
   git status --short --branch
   ```

3. Run the cheap frontend checks when dependencies are installed:

   ```bash
   npm --prefix frontend test
   npm --prefix frontend run lint
   ```

   If `lint` or `build` is known to fail for unrelated baseline reasons, record the exact failure and continue with the browser pass.

## Start The Prod-Connected Frontend

For frontend-only regression, start Vite with the production profile:

```bash
npm --prefix frontend run dev:prod -- --host 127.0.0.1
```

This loads `frontend/.env.prod.local`, sets `VITE_MODE=production`, and should point the local UI at production Supabase plus the production `data2.deadtrees.earth` API/storage URLs.

Do not add credentials to tracked docs or `frontend/.env*` examples. If `frontend/.env.prod.local` is missing or stale, recreate it from the local access notes or ask the user. Keep secrets in local-only files.

Browser target:

```text
http://127.0.0.1:5173
```

If Vite chooses another port, use the URL printed by Vite.

## Browser Use Script

Use Browser Use with the Codex in-app browser, not an external browser, unless the user asks otherwise.

1. Open the local URL.
2. Take a DOM snapshot after each navigation or major UI change.
3. Use screenshots for visual checks: maps, modals, responsive layout, and loading states.
4. Check console and network symptoms after each flow:
   - uncaught React/runtime errors
   - Supabase `401`, `403`, or `500` responses
   - API calls going to local URLs during a prod-connected run
   - missing COG, thumbnail, map tile, or storage assets
   - PostHog or analytics initialization errors
5. Keep the session logged in only as long as needed. Sign out or close the tab when finished if the browser session will be reused.

Use the dedicated live test account from local-only access notes if available. If
those credentials are not available in the session, ask the user for a test
account. Do not use a personal account unless the user explicitly asks for it.

## Core Smoke Flow

Aim for 20-30 minutes. Cover these flows unless the change scope clearly makes one irrelevant.

### Public Pages

- Home page loads without blank screen or long blocking spinner.
- Main navigation works for `Home`, `Dataset Archive`, `About`, and legal/footer links if touched.
- Dataset archive loads cards/table content from production data.
- Search, sort, or filters still update the visible archive state if the change touched archive/data fetching.
- Open one public dataset detail page from the archive.
- Dataset detail map renders base layer, AOI/footprint, thumbnails, and labels/layers where available.
- Back/forward navigation keeps the app usable.

### Authentication

- Sign in with the dedicated live test account.
- Profile page loads and shows the expected signed-in state.
- Profile tabs still switch, especially `My Datasets`, `Published Datasets`, and `My Issues` if present.
- Sign out works and protected routes redirect or show the expected login state.

### Upload Surface

- Open the upload entry point from the home/profile flow.
- Confirm the modal/page renders, required fields are visible, and cancel/close works.
- For upload validation changes, select a known small fixture and verify client-side validation messages.
- Do not submit a real production upload unless the user explicitly asks for that mutation or the task is specifically an upload end-to-end check.

### Map And GeoLabel Surfaces

- `/deadtrees` loads the interactive map and sign-in gate or editing tools as expected.
- Pan/zoom/layer toggles work on the relevant map page.
- If dataset detail editing was touched, confirm edit controls appear only for the right signed-in state.
- If audit or reference-patch code changed, use an auditor-capable account for `/dataset-audit`; otherwise record that the normal test account cannot validate auditor-only routes.

## Change-Specific Add-Ons

Pick only what matches the diff:

- Data fetching/performance: compare first load, archive, dataset detail, and audit route network fan-out; note obviously repeated or oversized production requests.
- Auth/session: hard refresh after sign-in, return-to URL, protected route redirect, and expired-session messaging.
- Upload: file picker/drag-drop, metadata fields, validation, progress UI, retry/cancel behavior, and no accidental submission without approval.
- Audit/reference patches: audit list, row filters, dataset audit detail, lock warnings, reference-patch editor load, and save buttons disabled/enabled as expected. Avoid saving production changes unless requested.
- Visual/UI-only: desktop plus narrow mobile viewport, no overlapping text, no clipped buttons, modals fit the viewport, maps are not blank.

## Pass Criteria

Call the browser regression pass green only when:

- the prod-connected local app loads from the current branch
- the core public and auth flows complete
- no unexpected console errors or visible broken states appear
- no requests unexpectedly target local development backends
- changed surfaces were exercised directly
- any skipped flow has a clear reason, such as missing auditor account or mutation not authorized

Call it yellow when the main app works but there are skipped high-risk flows, unrelated baseline test failures, or non-blocking console/network warnings. Call it red when a core route is blank/broken, auth fails, production data cannot load, or the changed surface regresses.

## Result Template

```markdown
Frontend browser regression: green/yellow/red

Local frontend:
- URL:
- Mode:
- Backend/API surface:

Terminal checks:
- `npm --prefix frontend test`:
- `npm --prefix frontend run lint`:

Browser flows:
- Public pages:
- Auth/profile:
- Upload surface:
- Map/detail:
- Audit/reference patch, if relevant:

Findings:
- ...

Skipped / not covered:
- ...
```
