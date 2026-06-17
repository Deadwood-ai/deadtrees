# <Journey Name>

```yaml
id: example-journey-id
persona: anonymous
fixture_packs:
  - qa-base
browser: browser
parallel_safe: true
mutation_level: read-only
routes:
  - /
```

## Purpose

State the product behavior this journey proves.

## Preconditions

- Source the isolated local env from `scripts/dev/isolated-supabase.sh env`.
- Start the local app stack and frontend.
- Seed the fixture packs listed above.
- Use `.local/qa-runs/<timestamp>/<playbook-id>/` for artifacts.

## Steps

1. Navigate to the first route.
2. Perform the user actions.
3. Check the expected state after each material action.

## Expected Observations

- List visible controls, URL states, data states, and permission boundaries.

## Failure Signals

- List symptoms that should be treated as failures or `needs-human-review`.

## Evidence To Capture

- Current URL at failure.
- Focused locator state.
- Console errors only.
- One screenshot only when visual evidence is needed.
- API or DB assertion for mutating journeys.
