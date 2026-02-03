# Explore & Plan Command

**Usage:** `@explore-plan <issue_id or description>`

Examples:
- `@explore-plan DT-184` (Linear issue)
- `@explore-plan implement email notifications for failures`

---

## Phase 1: Explore (Context + Questions)

### 1.1 Detect Input Type
- If input matches `DT-\d+` → Fetch from Linear MCP
- Otherwise → Treat as free text description

### 1.2 Linear Context (if issue ID)
```
get_issue: id=<issue_id>
list_comments: issueId=<issue_id>
get_project: id=<project_id> (if issue has project)
```
Extract: title, description, labels, priority, project, related issues

### 1.3 Database Context (MCP)
Check if issue relates to:
- Processing failures → Query `v2_statuses`, `v2_logs`
- Datasets → Query relevant tables
- Schema changes → Check `v2_*` table structures

```sql
-- Example: Check relevant table structures
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = '<relevant_table>';
```

### 1.4 Source Code Context
1. **Search for relevant files** using Grep/Glob
2. **Read key implementation files** related to the issue
3. **Check existing patterns** - how similar features are implemented
4. **Review test coverage** - existing tests for related functionality
5. **Check dependencies** - what modules/functions are involved

Focus: Solve using existing codebase patterns, avoid overengineering.

### 1.5 PostHog Context (if frontend-related)
```
list-errors: status=active, dateFrom=-P7D
```
Check for related errors or user behavior patterns.

### 1.6 Explore Summary & Options
At the end of the explore phase:
- Summarize the key context gathered
- Present 2-4 viable implementation options
- For each option, include: short description, pros/cons, risks, and testability
- Keep options distinct to enable divergence before convergence

### 1.7 Clarifying Questions
Ask all clarifying questions in the explore phase using this format:

```
## Clarifying Questions

1. [Question about scope/approach]
   a) Option A
   b) Option B
   c) Option C

2. [Question about priority/tradeoffs]
   a) Option A
   b) Option B

3. [Question about constraints]
   a) Option A
   b) Option B
```

**User responds with:** `1a, 2b, 3a` or `1 a, 2 b`

Continue asking until all ambiguity is resolved.

---

## Phase 2: Converge (Select Approach)

Use the explore summary and answers to:
- Select a single approach
- Explain why it was chosen
- Note any tradeoffs being accepted

---

## Phase 3: Create Plan (Sized + Verifiable)

When context is complete, create plan file.
Size the work: if the scope is large or risky, split into smaller, focused plans.

**Location:** `scratchpad/plans/<issue_id>-<slug>.md`
- Example: `scratchpad/plans/DT-184-auto-issue-creation.md`
- If no issue ID: `scratchpad/plans/<date>-<slug>.md`

**Plan Format (Minimal):**

```markdown
# Plan: <Title>

**Issue:** <DT-XXX or N/A>
**Created:** <date>

## Goal
<1-2 sentences describing what we're building and why>

## Tasks
1. [ ] <Task 1>
2. [ ] <Task 2>
3. [ ] <Task 3>
...

## Acceptance Criteria
- [ ] <Criterion 1>
- [ ] <Criterion 2>
- [ ] <Criterion 3>

## Verification
- <Primary automated verification (unit/integration test)>
- <If browser-only: minimal manual steps + console checks + test accounts>
- <Verification must be the final implementation step>

## Key Files
- `path/to/file1.py` — <what to change>
- `path/to/file2.py` — <what to change>

## Notes
<Any important context, constraints, or decisions made>
```

---

## Phase 4: Present & Wait

After creating the plan:

1. **Show the plan** in chat
2. **State:** "Plan saved to `scratchpad/plans/<filename>.md`"
3. **Wait** for user to review and approve
4. **Do not** start implementation until user confirms

---

## Rules

1. **MCP only** for database and Linear queries
2. **Read before writing** — understand existing patterns first
3. **Minimal plans** — goal, tasks, acceptance criteria, verification only
4. **No overengineering** — use existing codebase patterns
5. **Ask questions** — use numbered options for clarity
6. **Size the work** — split into smaller plans if too big
7. **Verification last** — prefer automated tests; browser only if needed
8. **Wait for approval** — don't start implementation without user OK

## Reference Rules
- `.cursor/rules/code-map.mdc` — where functionality lives
- `.cursor/rules/processor-pipeline.mdc` — processing flow
- `.cursor/rules/data-debugging.mdc` — database investigation
- `.cursor/agents/pm.md` — Linear organization rules
