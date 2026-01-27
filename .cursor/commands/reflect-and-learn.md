# Reflect and Learn

## Purpose
Analyze the current conversation to identify knowledge gaps, misconceptions, and learning opportunities. Generate bite-sized flashcards for spaced repetition learning (RemNote format).

## Instructions

You are a learning coach analyzing my development session. Your goal is to help me grow as a software engineer by identifying what I struggled with and converting those struggles into learnable, memorable knowledge.

### Step 1: Analyze the Conversation

Review the entire conversation and identify:

1. **Misconceptions** - Where did I assume something incorrectly?
2. **Knowledge gaps** - What concepts was I missing?
3. **Inefficient patterns** - Where did I take a longer path than necessary?
4. **Repeated mistakes** - What did I get wrong multiple times?
5. **Unclear mental models** - Where did I not understand how things connect?

### Step 2: Extract Learning Points

For each struggle, extract:
- The **correct terminology** (naming things properly)
- The **underlying concept** (how it actually works)
- The **heuristic** (when to use what approach)
- The **anti-pattern** (what to avoid)

### Step 3: Generate RemNote Cards

Create cards in the following format. Each card should be:
- **Atomic** - One concept per card
- **Brief** - Answer under 50 words
- **Contextual** - Reference the actual mistake when helpful
- **Tagged** - Include domain tags

#### Output Format

```markdown
## Session Learning Cards - [DATE]

**Session Context:** [Brief description of what was worked on]

---

### Terminology Cards

T:: [Term or Question]
A:: [Brief, clear answer]
Tags: #[domain] #[subtopic]

---

### Concept Cards

C:: [Concept name or question]
A:: [Explanation of how it works]
Tags: #[domain] #[subtopic]

---

### Heuristic Cards

H:: [When to use X vs Y?] or [How to decide between options?]
A:: [Decision framework or rule of thumb]
Tags: #[domain] #[subtopic]

---

### Anti-pattern Cards

A:: [What to avoid]
A:: [Why it's problematic and what to do instead]
Tags: #[domain] #[subtopic]

---

### Mental Model Cards

M:: [Model name]
A:: [Visual or structural explanation of how things connect]
Tags: #[domain] #[subtopic]
```

### Step 4: Prioritize

Order cards by:
1. **Frequency** - Mistakes made multiple times first
2. **Impact** - Concepts that would have saved the most time
3. **Fundamentals** - Building blocks that enable other learning

### Step 5: Suggest Next Steps

After the cards, add:

```markdown
## Recommended Deep Dives

If you want to strengthen these areas, consider:
1. [Specific resource or exercise]
2. [Specific resource or exercise]
3. [Specific resource or exercise]
```

---

## Domain Tags Reference

Use these tags for consistency:

**Frontend:**
- #react #hooks #state #components #typescript #openlayers #antd

**Backend:**
- #fastapi #python #async #api-design

**Database:**
- #postgres #supabase #rpc #migrations #sql #rls

**Architecture:**
- #data-flow #state-management #component-design #separation-of-concerns

**Debugging:**
- #debugging #logging #hypothesis-driven #root-cause

**Process:**
- #prompting #requirements #ux-design #iteration

---

## Example Output

```markdown
## Session Learning Cards - 2026-01-27

**Session Context:** Implemented public labelling feature (DT-138) - polygon editing in DatasetDetails with correction status styling.

---

### Terminology Cards

T:: What is a computed field in PostgreSQL?
A:: Data derived at query time via JOINs or expressions, not stored as a table column. Example: `correction_status` comes from joining `v2_geometry_corrections`, not from the geometry table itself.
Tags: #postgres #database

---

T:: What is optimistic locking?
A:: A concurrency control method where you check if data changed before saving (via `updated_at` timestamp), rather than locking the row during editing.
Tags: #postgres #concurrency

---

### Concept Cards

C:: How do React hooks ordering rules work?
A:: Hooks must be called unconditionally and in the same order every render. Place all hooks before any conditional returns. Violating this causes "change in order of Hooks" errors.
Tags: #react #hooks

---

C:: What's the difference between useMemo and useEffect?
A:: useMemo: memoize expensive computations DURING render, returns a value.
useEffect: run side effects AFTER render (fetch, subscriptions), returns cleanup function.
Tags: #react #hooks

---

### Heuristic Cards

H:: When should I extract a custom hook vs a component?
A:: Extract a **hook** when you have reusable stateful logic (data fetching, form handling). Extract a **component** when you have reusable UI. If it's just logic with no UI, it's a hook.
Tags: #react #architecture

---

H:: How do I know if a fix worked when multiple code paths exist?
A:: Search for ALL occurrences of the behavior (grep for style names, function calls). In OpenLayers, check: initial style, dynamic style updates in useEffect, and all layers that might render the same feature.
Tags: #debugging #openlayers

---

### Anti-pattern Cards

A:: Querying for computed fields as if they were columns
A:: Before adding a field to a SELECT query, verify it exists as a column in the table. Computed fields (from JOINs in RPC functions) won't exist on the base table and cause "column does not exist" errors.
Tags: #postgres #debugging

---

A:: Growing a component beyond 300-400 lines
A:: Large components become hard to maintain. Extract: (1) custom hooks for logic, (2) child components for UI sections, (3) utility functions for pure transformations. Refactor before reaching 500+ lines.
Tags: #react #architecture

---

### Mental Model Cards

M:: Frontend Data Flow Pipeline
A:: Database → RPC/API → React Query cache → Component state → Render decision. Data can be filtered at any level. Ask: "Where should this filtering happen?" (DB for performance, frontend for flexibility)
Tags: #architecture #data-flow

---

M:: Mode Transition State Preservation
A:: Before transitioning modes (view → edit), explicitly save: viewport, layer visibility, selected items. On transition back, restore or reset each. List them explicitly before implementing.
Tags: #react #state-management

---

## Recommended Deep Dives

1. **React Hooks mental model**: Read "A Complete Guide to useEffect" by Dan Abramov
2. **PostgreSQL computed columns**: Practice creating views and RPC functions that join tables
3. **OpenLayers styling**: Create a style function reference doc showing all places styles can be set
```

---

## When to Run This Command

Run `/reflect-and-learn` at the end of:
- A feature implementation session
- A debugging session where you struggled
- A PR review where you learned something
- Weekly, reviewing all conversations from the week
