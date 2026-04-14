# DeadTrees Frontend

React + TypeScript frontend for `deadtrees.earth` and GeoLabel workflows (map visualization, correction editing, and audit UI).

## Repository

- Monorepo: https://github.com/Deadwood-ai/deadtrees
- Frontend app path: `frontend/`
- Upload service: https://github.com/Deadwood-ai/deadtrees-upload
- Live platform: https://deadtrees.earth

## GeoLabel At A Glance

The frontend provides:
- high-performance map rendering with OpenLayers
- polygon editing tools (draw/delete/cut/merge/clip/undo)
- optional AI-assisted boundaries
- auditor review queue with approve/revert workflow

<p align="center">
<img src="https://github.com/Deadwood-ai/deadtrees/blob/main/docs/assets/ui-screenshot.jpg?raw=1" alt="GeoLabel UI overview" width="100%"/>
</p>

<p align="center">
<img src="https://github.com/Deadwood-ai/deadtrees/blob/main/docs/assets/adding-ai.gif?raw=1" alt="AI-assisted editing" width="48%"/>
<img src="https://github.com/Deadwood-ai/deadtrees/blob/main/docs/assets/approve.gif?raw=1" alt="Audit approval workflow" width="48%"/>
</p>

## Tech Stack

- React 18 + TypeScript + Vite
- OpenLayers for map rendering and interaction
- Ant Design for UI components
- TanStack Query for async state
- Supabase client for auth/data access

## Local Development

### Prerequisites

- Node.js 18+
- npm

### Install and Run

```bash
cd frontend
npm install
npm run dev
```

By default, Vite serves at `http://localhost:5173`.

### Build and Lint

```bash
cd frontend
npm run lint
npm run build
npm run preview
```

## Production Deploys

The frontend can deploy automatically to Firebase Hosting from GitHub Actions whenever `main` changes.

Workflow files:
- `.github/workflows/frontend-hosting-merge.yml`
- `.github/workflows/frontend-hosting-pull-request.yml`

These workflows intentionally let Firebase's framework-aware Hosting deploy perform the Vite build. That matches local `firebase deploy --only hosting` behavior and avoids blocking deploys on the repo's current standalone TypeScript check failures from `tsc && vite build`.

Required GitHub repository secrets:
- `FIREBASE_SERVICE_ACCOUNT_DEADWOOD_D4A4B`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_SUPABASE_SENTINEL_PROCESSING_URL`
- `VITE_SUPABASE_SENTINEL_PROCESSING_ANON_KEY`
- `VITE_GEOPIFY_KEY`

Optional GitHub repository secrets:
- `VITE_SAM_API_URL` if you want to override the built-in default
- `VITE_POSTHOG_PROJECT_KEY` if PostHog should be enabled in production

The quickest way to provision the Firebase deploy credential is to run:

```bash
firebase init hosting:github
```

Firebase's official Hosting docs say this command creates the deploy service account, stores its JSON key as a GitHub secret, and writes the workflow files for you. In this monorepo the Hosting workflow should deploy with `frontend/` as its entry point.

## Environment Variables

Create a `.env.local` file (or equivalent environment setup) and provide the values your deployment mode needs:

```bash
VITE_MODE=development
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...

# optional integrations
VITE_SAM_API_URL=...
VITE_POSTHOG_PROJECT_KEY=...
VITE_GEOPIFY_KEY=...
VITE_SUPABASE_SENTINEL_PROCESSING_URL=...
VITE_SUPABASE_SENTINEL_PROCESSING_ANON_KEY=...
```

## Important Feature Areas

- `src/components/DeadwoodMap/`: GeoLabel editing map and correction tooling
- `src/pages/DatasetAudit.tsx`: auditor review flows
- `src/hooks/`: data fetching and map-related behavior hooks
- `src/config.ts`: runtime configuration and environment-driven setup

## Related Documentation

- Full GeoLabel pilot roadmap: https://github.com/Deadwood-ai/deadtrees/blob/main/docs/projects/geolabel/roadmap-report.md
- Backend architecture and processing docs: https://github.com/Deadwood-ai/deadtrees

## License

MIT (see `LICENSE`).
