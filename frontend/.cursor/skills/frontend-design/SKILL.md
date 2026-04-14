---
name: frontend-design
description: Create distinctive, production-grade DeadTrees frontend interfaces using React, Ant Design, and Tailwind. Use when building or restyling pages/components, dashboards, maps, forms, upload flows, or other UI in deadtrees-frontend-react. Enforces project styling conventions, existing color usage, and avoids generic AI aesthetics.
license: Complete terms in LICENSE.txt
---

# Frontend Design (DeadTrees)

Build production-ready UI with strong visual quality while staying consistent with this codebase.

## When To Use

Use this skill when the user asks to:
- Build or redesign a page/component in `deadtrees-frontend-react`
- Improve visual quality, polish, or UX
- Style or beautify Ant Design + Tailwind interfaces
- Create new map-related UI (panels, overlays, legends, controls)

## Project Reality (Must Follow)

- Stack: **React + TypeScript + Ant Design + Tailwind CSS**
- Tailwind config currently has:
  - `preflight: false` (do not assume Tailwind reset behavior)
  - `fontFamily.sans` set to `Inter` + system fallbacks
  - no custom color scale extension in `tailwind.config.js`
- Ant Design is globally wrapped with `ConfigProvider` in `src/App.tsx` (theme token mostly default today).

## Design Direction

Pick a clear visual direction, but keep it compatible with current product language:
- clean data-product UI
- clear hierarchy
- restrained motion
- readable density for map-heavy workflows

Avoid random one-off art-direction that clashes with existing pages.

## Color System (Use Existing Palette First)

Prefer existing colors/tokens already visible in the app:

- **Primary blue**: `#1677ff` (Ant Design default primary, used in map flags/accents)
- **Secondary blue**: `#3b82f6` (selection and emphasis in map UI)
- **Forest greens**: Tailwind `green-*` plus custom interpolation greens in map layers
- **Deadwood accent**: `#FFB31C` with darker `#cc8f16`
- **Neutral surfaces**: slate/gray scale (`#f8fafc`, `gray-*`, `slate-*`)

Rules:
- Reuse this palette before introducing new brand colors.
- If adding a new color, justify it by feature semantics and keep it local.
- Keep contrast accessible; avoid low-contrast decorative text.

## Ant Design + Tailwind Composition Rules

- Use **Ant Design** for:
  - Forms, inputs, buttons, modals, tables, dropdowns, notifications
  - Complex interaction states and accessibility-heavy primitives
- Use **Tailwind** for:
  - Layout, spacing, flex/grid composition
  - Small visual refinements and responsive behavior
  - Utility-level typography and spacing polish

Do not duplicate responsibility between both systems in the same element unless necessary.

## Typography

- Default to project sans stack (Inter/system). Do not import random display fonts unless requested.
- Use Ant Typography where existing pages already rely on it.
- Keep headings/scales consistent with nearby screens.

## Motion Guidelines

- Prefer subtle transitions: hover/focus/expand/collapse.
- Use motion to clarify interaction, not decorate.
- Keep map controls and data tables stable; avoid attention-stealing animation loops.

## Layout Guidelines

- Prioritize clarity for analysis workflows:
  - controls near map edges
  - strong visual grouping
  - predictable responsive stacking
- Favor compositional polish over novelty for core app screens.

## Map UI Rules

When editing OpenLayers screens:
- Keep controls readable above raster backgrounds (surface + blur + border/shadow as needed).
- Preserve explicit layer semantics:
  - green = forest
  - yellow/orange = deadwood
- Avoid palette changes that break legend interpretation.

## Implementation Workflow

1. Identify the user goal and screen context.
2. Pick one visual direction consistent with the existing product.
3. Reuse current palette/tokens first.
4. Compose with Ant components + Tailwind layout utilities.
5. Validate states:
   - loading
   - empty
   - error
   - hover/focus/disabled
6. Ensure responsive behavior and contrast.

## Output Expectations

When implementing:
- return real working code, not mockups
- keep components maintainable (prefer under ~200 lines when possible)
- extract reusable pieces when UI grows
- use `console.debug` (not `console.log`) for temporary diagnostics

## Anti-Patterns (Avoid)

- Generic “AI” landing-page style that ignores app context
- Introducing a new color theme for a single feature without reason
- Overriding Ant styles globally when local composition is enough
- Dense gradients and flashy motion in data-heavy screens
- Breaking existing semantic colors for map layers/legends

