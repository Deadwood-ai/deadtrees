# Auth Shell

```yaml
id: auth-shell
persona: anonymous/contributor
fixture_packs:
  - qa-auth
browser: browser
parallel_safe: false
mutation_level: local-write
routes:
  - /sign-in
  - /sign-up
  - /forgot-password
  - /profile
```

## Purpose

Verify local Supabase Auth pages work against the isolated Auth service and
Mailpit, including seeded login and password-reset shell behavior.

## Preconditions

- `qa-full` fixtures are seeded.
- Mailpit is reachable at `http://127.0.0.1:$LOCAL_MAILPIT_HTTP_PORT`.
- Use seeded contributor `qa-contributor-local@example.com` with the password in
  `docs/qa/fixtures.md`.
- Use a fresh browser context or clear local storage before starting.

## Steps

1. Navigate to `/sign-in`.
2. Sign in as the seeded contributor.
3. Verify navigation to `/profile`.
4. Verify the profile page shows the contributor email.
5. Sign out if a sign-out control is available.
6. Navigate to `/forgot-password`.
7. Submit a reset request for the seeded contributor.
8. Open local Mailpit and verify a reset email was captured.
9. Do not change the shared seeded password unless the run owns an isolated DB.
10. Clear the session, navigate to `/sign-up` and register a fresh
    `@example.com` address. The captcha uses Cloudflare's always-pass test key
    locally, so the Sign up button enables without a challenge.
11. Verify the page says "Check your inbox", open the "Confirm your DeadTrees
    account" email in Mailpit and follow its link.
12. Verify the link lands on `/profile` signed in as the new address.

## Expected Observations

- Auth calls target `VITE_SUPABASE_URL`.
- Seeded contributor can sign in.
- Authenticated-only `/profile` route is accessible after sign-in.
- Password-reset email appears in local Mailpit, not external email.
- Sign-up posts to the local API `/auth/signup`, never directly to Supabase
  `/auth/v1/signup`, and the confirmation email appears in Mailpit.

## Failure Signals

- Sign-in calls default `54321` while isolated env uses another port.
- Sign-in succeeds but profile remains unauthenticated.
- Reset email is not captured in Mailpit.
- The Sign up button stays disabled because the captcha never loads.
- Any real external email service is contacted.

## Evidence To Capture

- Auth endpoint URL and status for sign-in failure.
- Profile route URL and visible contributor email state.
- Mailpit message count and subject for reset check.
- Console errors only.
