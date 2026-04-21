# Deadtrees AARRR Analytics

This document is the source-of-truth for the current Deadtrees analytics v1 migration.

## Current Production Status

- The live website is reachable and core flows such as homepage, sign-in, and profile load normally.
- Production analytics are currently undercounting because PostHog initialization can be skipped after deploys when old consent state is present in the browser.
- The existing AARRR overview dashboard already exists in PostHog, but named product events are effectively absent in production history until the initialization fix is deployed.
- The companion dashboards for contribution funnels, retention, and friction were created as shells but were not populated with insights.

## AARRR Event Map

### Acquisition

- `$pageview`
- `landing_cta_clicked`
- `newsletter_signup_submitted`
- `dataset_archive_viewed`
- `dataset_search_used`
- `dataset_filter_applied`
- `dataset_map_interacted`
- `dataset_opened`

### Activation

- `sign_up_started`
- `sign_up_completed`
- `sign_in_completed`
- `upload_started`
- `upload_completed`
- `processing_result_viewed`

### Retention / Value

- `dataset_download_started`
- `dataset_download_completed`
- `edit_started`
- `edit_saved`
- `publish_started`
- `publish_submitted`
- `publish_completed`

### Referral / Community

- `newsletter_signup_submitted`
- `email_link_clicked`

### Core Team / Operations

- `audit_queue_viewed`
- `audit_started`
- `audit_completed`
- `correction_review_started`
- `correction_approved`
- `correction_reverted`
- `reference_patch_editor_opened`
- `flag_submitted`
- `upload_failed`
- `dataset_download_failed`
- `publish_failed`

## Existing PostHog Dashboards

- `623122`: `Analytics V1 - AARRR Overview`
- `623123`: `Analytics V1 - Contribution Funnel`
- `623124`: `Analytics V1 - Retention and Cohorts`
- `623125`: `Analytics V1 - Core Team Audit`
- `623126`: `Analytics V1 - Friction and Errors`

## What Was Broken

- PostHog init treated persisted opt-in or opt-out state as if the current page had already initialized the SDK.
- Returning browsers could therefore skip `posthog.init(...)` after the analytics rollout.
- If consent changed from pending to accepted on the same page, PostHog could remain in limited mode instead of switching to cookie-backed persistence and autocapture.
- The AARRR companion dashboards existed, but several were still empty and did not yet provide operational visibility.

## What Needs To Happen

- Deploy the frontend analytics initialization fix.
- Verify that named events begin appearing in production again.
- Keep the AARRR dashboards attached to the current event names instead of creating a second competing taxonomy.
- Treat `Referral` as a light-weight stage for now; Deadtrees does not yet have a deeper invite or share loop instrumented.
