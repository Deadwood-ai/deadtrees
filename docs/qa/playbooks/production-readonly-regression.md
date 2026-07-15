# Production Read-Only Regression

```yaml
id: production-readonly-regression
persona: anonymous/live test account
fixture_packs:
  - production-live-readonly
browser: browser
parallel_safe: false
mutation_level: read-only
routes:
  - /
  - /dataset
  - /dataset/:id
  - /deadtrees
  - /releases
  - /releases/:slug
  - /sign-in
  - /profile
  - /dataset-audit
  - /priwa-field
```

## Purpose

Verify the deployed application against production data and services while
keeping the pass strictly read-only. Cover public discovery, the dedicated live
test account, map rendering, release metadata, role guards, contributor form
shells, PRIWA read surfaces, responsive layouts, and matching PostHog signals.

## Preconditions

- Use the built-in Browser against `https://deadtrees.earth`.
- When the generated run requests live viewing, make the in-app Browser visible
  before the first route and keep it visible until the lane result is written.
- Use only the dedicated live test account from `.codex/local-access.md` or
  `docs/ops/local-access.md`.
- Confirm the account is not assumed to have auditor privileges.
- Do not submit uploads, downloads that enqueue work, issue reports, edits,
  audits, field observations, newsletter forms, password resets, or other
  production mutations.
- Opening a form, changing client-only controls, signing in/out, and cancelling
  before submission are allowed.

## Steps

1. Open `/` anonymously or with the restored test-account session.
2. Verify the home shell, live statistics, primary CTAs, release cards, and
   footer/legal links render without console errors.
3. Open `/releases` and one release detail. Compare availability badges and CTA
   state with the same release card on `/`.
4. Open `/dataset`, wait for the archive list and map, test a no-results search,
   clear it, and open one public dataset from a visible list item.
5. On `/dataset/:id`, verify imagery, AOI, prediction layers, metadata, and map
   controls render. Open and cancel the issue-report form.
6. Enter one prediction editor, verify tools and map state, then cancel without
   saving.
7. Sign out, verify `/sign-in`, then sign in with the dedicated test account and
   confirm `/profile` loads.
8. Switch `My Datasets`, `Published Datasets`, and `My Issues`. Open and cancel
   the upload modal without attaching or submitting a file.
9. Open `/dataset-audit` and verify the normal test account receives the auditor
   access guard without protected content leaking.
10. Open `/deadtrees`, dismiss the preview notice if present, switch one year or
    layer control, and verify the satellite product renders.
11. Open `/priwa-field` only if the test account is authorized. Verify the map,
    offline-ready state, and point list; do not create, edit, export, or delete.
12. Repeat `/`, `/dataset`, `/dataset/:id`, and `/profile` at a narrow mobile
    viewport. Verify navigation, map drawers, filters, and desktop-only notices.
13. Reset the viewport and inspect focused console errors.
14. In PostHog, review the last 30 days for `$exception`, `$web_vitals`,
    `$dead_click`, and `$rageclick` on the exercised routes. Exclude obvious
    extension errors and treat canvas/map dead clicks as potentially noisy.
15. Search Linear before recording a defect. Reopen a completed issue when the
    same failure is active again; otherwise create an unassigned Triage issue.

## Expected Observations

- Public and authenticated routes use production Supabase/API/storage only.
- Sign-out and sign-in return the dedicated account to `/profile`.
- The normal test account is denied auditor-only routes.
- Archive, dataset, satellite, and PRIWA maps render their intended imagery.
- Forms enforce required fields and cancel without production side effects.
- Mobile drawers and filter panels fit the viewport and remain dismissible.
- Release status and CTA state agree across home, index, and detail pages.
- PostHog findings support or qualify browser observations rather than replacing
  direct reproduction.

## Failure Signals

- Blank routes, stuck loading states, or unexpected auth redirects.
- Production forms submit or jobs start during a read-only pass.
- Release availability contradicts its detail/download state.
- Map layers fail, disappear, or throw OpenLayers/WebGL exceptions.
- Protected audit content appears for the normal test account.
- Mobile controls overlap, clip, or cannot be dismissed.
- PostHog shows current recurring exceptions or poor p75 web vitals on a core
  route even when the single manual session succeeds.

## Evidence To Capture

- Current URL and one focused locator state per failed flow.
- Console errors with route and message, capped to the relevant entries.
- One viewport or clipped screenshot for each distinct visual defect.
- PostHog event count, affected people, date window, route, and last-seen time.
- Linear issue URL and whether it was created or reopened.
- Explicit list of production mutations that were intentionally skipped.
