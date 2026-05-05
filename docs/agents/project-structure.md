# Project Structure Guidance

Use this when adding files, moving code, or deciding where logic belongs.

## Module Boundaries

- `api/src/routers/`: FastAPI route definitions and request/response wiring.
- `api/src/upload/`: upload business logic and upload-specific processors.
- `api/src/export/`: export workflows and reference-patch export logic.
- `processor/src/`: processing stages and processor orchestration.
- `processor/src/utils/`: shared processor helpers for files, SSH, labels, and
  diagnostics.
- `shared/`: models, settings, DB clients, logging, and cross-service helpers.
- `frontend/src/components/`: UI components organized by product feature.
- `frontend/src/hooks/`: reusable React hooks.
- `frontend/src/utils/`: frontend utilities.
- `supabase/migrations/`: schema and policy history.
- `docs/playbooks/`: operational and agent workflows.
- `docs/agents/`: durable agent rules.

## Placement Rules

- Put route-only code in routers.
- Put reusable business logic in service/upload/export modules, not routes.
- Put cross-service contracts in `shared`.
- Put processor-stage logic in named `process_*` modules.
- Put broadly reused processor helpers in `processor/src/utils`.
- Co-locate focused tests near the relevant API/processor/frontend test area.

## Naming

- Use descriptive module names over generic names like `utils.py` when adding new
  code.
- Use verb-noun function names for operations.
- Use noun phrases for classes and Pydantic models.
- Avoid circular imports by keeping dependencies flowing from utilities and
  models toward orchestration and routes.

## Anti-patterns

- God modules that mix routing, validation, storage, and DB logic.
- Deep import paths for reusable concepts that should be promoted.
- Adding one-off helpers to shared modules before a second real use case exists.
- Moving code only to make it look cleaner without reducing coupling or risk.
