# DeadTrees Frontend Agent Instructions

Read this in addition to the root `AGENTS.md` and `docs/agents/rules.md` for
frontend work.

## Stack

- React + TypeScript + Vite
- Ant Design and Tailwind
- OpenLayers for maps and COG rendering
- Supabase client for auth and data access
- React Query for server state

## Environment

- `npm run dev:local` loads `frontend/.env.dev.local` for local API/Supabase.
- `npm run dev:prod` loads `frontend/.env.prod.local` for local UI against
  production services.
- Only browser-safe `VITE_*` values belong in frontend env files.
- Never put service-role keys, MCP tokens, SSH/VPN credentials, or private API
  keys in `frontend/.env*`.

## TypeScript And React

- Prefix domain interfaces with `I` where that pattern already exists.
- Use `Props` suffixes for component props.
- Keep large components below roughly 200 lines by extracting hooks,
  subcomponents, render helpers, or config.
- Use React Query for Supabase/server state and local state for UI-only state.
- Keep global context limited to auth, map viewport, theme, or similarly broad
  cross-cutting state.
- Prefer `console.debug()` over `console.log()`.

## Review guidelines

- Apply the root review guidelines, especially for correctness, security, maintainability, and testability risks in changed frontend code.
- Flag frontend changes that expose service-role keys, MCP tokens, SSH/VPN credentials, private API keys, or production-only values to browser code or tracked `frontend/.env*` files.
- Flag auth, Supabase, React Query, upload, map, or COG-rendering changes that make permissions, cache invalidation, cancellation, cleanup, or error states hard to reason about or hard to test.
- Treat large React components, duplicated data-fetching logic, unstable query keys, missing cleanup of OpenLayers resources, and hidden side effects as review issues when they create concrete regression risk.
- Do not flag subjective UI style preferences unless they affect accessibility, data integrity, security, testability, or a documented product requirement.

## Query Keys

Use stable tuple keys:

```ts
["datasets"]
["datasets", id]
["datasets", id, "labels"]
```

## OpenLayers

- Do not store `Map` instances in React state. Use refs.
- Always cleanup layers, sources, listeners, and `map.setTarget(undefined)`.
- Use `fromLonLat` and `toLonLat` for coordinate transforms.
- Use `WebGLTileLayer` with `GeoTIFF` for COG rendering.

## Uploads

- Chunk size is 50 MB.
- Refresh auth before long-running chunk uploads.
- Use `AbortController` for cancellation.

## Validation

Run targeted checks first:

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run lint
```

For user-facing UI changes, start the relevant Vite profile and validate with the
Codex in-app browser or Playwright. Use `docs/playbooks/frontend-browser-regression.md`
for production-connected smoke checks.
