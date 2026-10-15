# Internal forest disturbance benchmark release — DT-1410

## Intent and current state

Deploy this viewer now for **internal research use by a separate named allowlist**,
not as a public release. Teja requested this scope on 15 October 2026. Obtain the
initial user IDs from Teja; start with an empty allowlist. Administrator/auditor
status alone must not grant access. This PR contains frontend code only: the
protected data service and feedback mail endpoint described below still need to
be implemented before enabling the viewer. Do not interpret merging this PR as
authorization to publish the imagery or to make a public release announcement.

The route is `/releases/disturbance-benchmark`, with optional `?site=<site-id>`.
It is absent from the public releases catalogue and disabled unless the frontend
is built with `VITE_ENABLE_INTERNAL_DISTURBANCE_BENCHMARK=true`. This build switch
is **not an authorization mechanism**. Keep it off until the server gates below
pass. Existing releases, account/profile code, database schema and processing
code are unchanged by this PR.

## Data handoff: use this completed NAS export

Windows/SMB run directory:

```text
\\unfnrd02.public.ads.uni-freiburg.de\unfnrd02\projects\deadtrees\disturbances\11-Webviewer_visuals\runs\pylos-2026-10-15
```

On the conversion workstation this is mounted at:

```text
/mnt/gsdata/projects/deadtrees/disturbances/11-Webviewer_visuals/runs/pylos-2026-10-15
```

**Only `export/` is the web payload.** Keep the surrounding reports and source
inventory internal; they are useful for diagnosis, not web assets. The export is
already complete: 114 sites, 16,253 files, 939,577,822 bytes (about 940 MB decimal).
`handoff-audit.json` reports zero missing references among 16,252 referenced asset
paths. Conversion exited successfully in 1,058.5 seconds with 16 workers.

| Payload | Location/representation |
| --- | --- |
| Site catalogue, map locations, products | `export/catalog.json` |
| Per-site metadata, acquisition date, links, warnings | `export/<site-id>/site.json` |
| Drone RGB and thumbnails | JPEG paths referenced by the catalogue/site JSON |
| Drone binary reference and satellite predictions | Lossless PNG paths in site JSON; prediction masks retain alpha |
| Drone reference polygons | Embedded normalized geometry in site/frame JSON |
| Planet RGB context | 15,288 JPEG frames referenced by `contexts.planet` |
| Google Earth historical context | 247 JPEG frames referenced by `contexts.google` |
| Esri context | 28 JPEG frames referenced by `contexts.esri` |
| Sentinel NDVI, NDII, EVI, kNDVI | 62,119 observations embedded in `site.json` → `series` |
| Planet GCC greenness | 15,288 observations in `planetSeries` |

Copy the **whole export directory**, preserving names and relative structure.
There is no separate plotting workbook or TIFF dependency at runtime. The
viewer rewrites JSON paths starting `/data/` to `/disturbance-benchmark/data/`;
do not rewrite JSON paths or flatten directories. For example,
`export/catalog.json` must be served at
`/disturbance-benchmark/data/catalog.json` and
`export/Fire_Peru_2024/site.json` at
`/disturbance-benchmark/data/Fire_Peru_2024/site.json`.

Do **not** commit this directory or place it in a public Vite/CDN asset folder.
The matching public data directory is gitignored as an accidental-commit guard,
not as a recommended production deployment location. Install the payload outside
the public web root and serve it through an authorized server route. Stage a new
version, validate it, then switch the serving directory atomically. Keep the
previous version for rollback. No data are uploaded by this PR.

## Server implementation contract for the colleague's assistant

Reuse the platform's established authentication and storage delivery mechanisms;
do not invent client-side email lists or embed credentials in Vite configuration.
All routes below are same-origin. The frontend sends the current platform bearer
token on access and feedback requests. It deliberately fails closed if the access
endpoint is missing, denies permission, returns invalid JSON, or fails.

1. Maintain a server-owned named allowlist keyed by stable authenticated user ID.
   Changes to membership require an authorized operator. Default deny, including
   signed-in users not on the list; never infer membership from an email domain.
2. Implement `GET /api/v1/disturbance-benchmark/access`. Validate the platform
   session and allowlist membership. Return `200 {"allowed":true}` only for
   approved users, `401` for anonymous/expired sessions and `403` for excluded
   users. Establish a short-lived, Secure, HttpOnly, same-site session for image
   and JSON requests (which cannot carry custom bearer headers in `<img>`).
   Do not put bearer tokens in URLs. Bind asset access to the authenticated user
   and recheck membership on requests; handle sign-out, expiry and revocation.
3. Protect **every** `/disturbance-benchmark/data/**` request, including catalogue,
   site JSON, thumbnails, full-size images and masks. Use the existing protected
   storage/auth-request pattern with a benchmark-specific allowlist decision.
   Return 401/403 rather than the SPA index for denied files. Prevent path traversal
   and directory listing. Do not expose an alternate origin, public bucket, build
   artifact, CDN URL or unprotected alias of the same files. Use private/no-store
   responses for authorization and sensitive data; do not share cached responses
   between users. The frontend gate is an additional UX check, not the data gate.
4. Enable the build switch only after these protections are installed and tested.
   Share the direct route with invited users. Do not add it to the public release
   cards, sitemap or public announcements for this phase.

## Feedback goes to the DeadTrees information mailbox

The visitor sees only a comment field, **Send comment**, and success/error feedback.
There is no `mailto:` link and no recipient address in the form. Implement:

```text
POST /api/v1/disturbance-benchmark/feedback
Authorization: Bearer <current platform session>
Content-Type: application/json
{"siteId":"Fire_Peru_2024","comment":"..."}
```

Validate the session **and the same named allowlist**, require a known site ID,
trim the comment and enforce 1–4000 characters server-side. Rate limit and prevent
duplicate mail on retries. Use the existing platform mail service and configured
DeadTrees sender account. The **server-configured recipient is
`info@deadtrees.earth`**. Include the site ID, canonical drone link, timestamp and
authenticated sender identity in the team message. Do not accept a recipient,
sender address or arbitrary mail headers from the browser; safely escape comment
text if sending HTML. No mail credentials belong in this PR or frontend env.

Return `202 {"accepted":true}` only after durable queuing (or `200` after delivery
acceptance). The frontend clears the field and confirms success only after this
response. Failed requests retain the comment and show an error. Do not report
success for a missing endpoint or rejected mail. Delivery retries, monitoring and
idempotency belong in the backend; ordinary comments should not be posted to
Zulip. Test with an isolated mail sink, not the real information mailbox.

## Scientific/data limitations to preserve

- All 114 imagery exports succeeded; this does **not** mean every satellite
  product is available at every site. There are 233 saved overlays across 41
  sites; 73 sites have no matching saved b+y products. Keep those sites visible
  with their warnings and temporal context. Never replace unavailable products
  or scores with zeros.
- Imagery/reference/context inputs: `5-Graph/Results_plots_v10`. Predictions:
  `6-Validation/tmp_residuals_0.25_all_NO_mask_v5`, only saved `*_by_pred_res.tif`
  (preceding year b OR flight year y). Exclude year a and bya. DTE uses the supplied
  `dt_fc_dw_comb_by`; do not rethreshold continuous change TIFFs in the frontend.
- Precision, recall and F1 remain NA. Flight IDs/dates follow Claudia's sheet.
  Preserve source warnings, including the Brazil3 flight/prediction mismatch;
  dates must not silently be replaced by current platform records.
- PNG binary masks stay lossless and transparent. JPEGs are display imagery,
  not analytical rasters. Planet GCC is an RGB greenness proxy, not NDVI.
- Smoothing is visualization only: original observations remain available;
  missing intervals are not manufactured. Keep the drone acquisition marker.
- Retain Planet, Google and Esri credits and dataset licence links. Internal
  access is not a blanket redistribution licence. A future public launch needs
  a separate imagery-rights review and approval.

## Acceptance and handover checks

1. Verify the complete payload against `handoff-audit.json`, `report.html` and
   `binary-coverage.html` beside `export/`. These reports distinguish conversion
   failures from unavailable prediction coverage.
2. Check anonymous, signed-in non-member and allowed-user access separately.
   Direct image and JSON URLs must be denied for the first two, including after
   logout/revocation. Confirm an unavailable authorization service fails closed.
3. For an allowed user, open the default site, Fire Peru, Logging Indonesia and a
   European site. Check site switching/map selection, all available product
   overlays, NA scores, galleries/zoom/reference outlines, all three context
   sources, Sentinel index selection, smoothing and acquisition-date marker.
4. Test feedback success/failure, duplicate clicks, unauthorized attempts and
   server-side limits with a mail sink. Verify the server recipient configuration
   points to the information mailbox without exposing it in the UI.
5. Run frontend build, lint, focused tests and isolated browser regression before
   enabling access. The UI PR alone is not the completed server deployment.

Conversion code is maintained separately in
`https://github.com/Deadwood-ai/disturbance_benchmark_visuals`. No rerun is needed
to install this snapshot. The local laptop preview is a separate, earlier review
environment; do not copy its directory instead of the NAS snapshot above.
