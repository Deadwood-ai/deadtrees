## EXECUTOR MODE — ONE TASK AT A TIME

### Instructions

1. **Read the "Rules & Tips" section in `implementation.md` (if it exists) before starting.**
   - Ensure you understand all prior discoveries, insights, and constraints that may impact your execution of the current or following tasks.
2. Open `implementation.md` and find the first unchecked (`[ ]`) task.
3. Apply exactly one atomic code change to fully implement this specific task.
   - **Limit your changes strictly to what is explicitly described in the current checklist item.**
   - Do not combine, merge, or anticipate future steps.
   - **If this step adds a new function, class, or constant, do not reference, call, or use it anywhere else in the code until a future checklist item explicitly tells you to.**
   - Only update files required for this specific step.
   - **Never edit, remove, or update any other code, file, or checklist item except what this step describes—even if related changes seem logical.**
5. When there are **no lint errors** and all tests pass:
   d. Mark the task as complete by changing `[ ]` to `[x]` in `implementation.md`. _(Do not commit plan.md; it is in .gitignore.)_
   e. Summarize what changed, mentioning affected files and key logic.
6. **Reflect on learnings from this step:**
   - Write down only _general_, _project-wide_ insights, patterns, or new constraints that could be **beneficial for executing future tasks**.
   - Do **not** document implementation details, code changes, or anything that only describes what was done in the current step (e.g. "Migrated to TypeScript", "Added Winston logging", "Created .gitignore", etc.). Only capture rules, pitfalls, or lessons that _will apply to future steps_ or are needed to avoid repeated mistakes.
   - Use this litmus test: _If the learning is only true for this specific step, or merely states what you did, do not include it._
   - Before adding a new learning, check if a similar point already exists in the "Rules & Tips" section. If so, merge or clarify the existing point rather than adding a duplicate. Do not remove unique prior rules & tips.
   - Focus on discoveries, best practices, or risks that might impact how future tasks should be approached.
   - **Always** insert the "Rules & Tips" section _immediately after the "Notes" section_ in plan.md (never at the end of the file). If "Rules & Tips" does not exist, create it directly after "Notes".
7. STOP — do not proceed to the next task.

9. Never make changes outside the scope of the current task. Do not alter or mark other checklist items except the one just completed.

11. If you are unsure or something is ambiguous, STOP and ask for clarification before making any changes.

---

### 3D Trees Project-Specific Rules

#### Technology Stack Integration

- **Package Manager:** Use `npm` (not yarn) for all commands
- **Linting:** Run `npm run lint` to check for ESLint errors
- **Build:** Use `npm run build` to verify TypeScript compilation
- **Unit Testing:** Currently no test framework is set up. If tests are added during planning, set up Vitest with `npm run test`
- **E2E Testing:** Use Playwright MCP tools for browser automation, testing, and debugging

#### Database Operations with MCP Tools

When tasks involve database operations, use MCP tools for verification:

- **Before database changes:** Use `mcp_3dtrees-dev_list_schemas()` and `mcp_3dtrees-dev_get_object_details()` to understand current schema
- **After changes:** Use `mcp_3dtrees-dev_analyze_db_health()` to verify database integrity
- **Query optimization:** Use `mcp_3dtrees-dev_explain_query()` for complex queries

#### End-to-End Testing with Playwright MCP

When tasks require E2E testing, debugging, or browser automation, use Playwright MCP tools:

**Basic Workflow:**

- **Navigation:** Use `mcp_playwright_browser_navigate()` to access pages
- **Page capture:** Use `mcp_playwright_browser_snapshot()` for accessibility-friendly page analysis
- **Interactions:** Use `mcp_playwright_browser_click()`, `mcp_playwright_browser_type()`, `mcp_playwright_browser_select_option()`
- **Verification:** Use `mcp_playwright_browser_wait_for()` to wait for elements or text
- **Screenshots:** Use `mcp_playwright_browser_take_screenshot()` for visual verification

**Testing Scenarios:**

- **Authentication flows:** Login, signup, logout, password reset
- **Data upload workflows:** File uploads, form submissions, progress tracking
- **3D visualization:** Component loading, interaction, performance
- **User journeys:** Complete workflows from start to finish

**Debugging with Playwright MCP:**

- **Console errors:** Use `mcp_playwright_browser_console_messages()` to check for JavaScript errors
- **Network issues:** Use `mcp_playwright_browser_network_requests()` to debug API calls
- **Page state:** Use `mcp_playwright_browser_snapshot()` to understand current page state

**Best Practices:**

- Always start E2E tests with `mcp_playwright_browser_navigate()` to the target page
- Use `mcp_playwright_browser_wait_for()` instead of arbitrary delays
- Capture screenshots at failure points for debugging
- Use element references from snapshots for reliable interactions
- Clean up browser state between test scenarios

#### Supabase Integration

- **Database types:** Regenerate types after schema changes using Supabase CLI
- **Authentication:** Use `src/lib/supabase/client.ts` for client-side operations
- **Server-side:** Use `src/lib/supabase/server.ts` for server-side operations
- **File uploads:** Handle large 3D data files with proper progress tracking

#### Frontend Development

- **Component structure:** Follow shadcn/ui patterns in `src/components/ui/`
- **Path aliases:** Use `@/` prefix for imports (configured in Vite)
- **Styling:** Use Tailwind CSS classes with shadcn/ui components
- **3D visualization:** Handle WebGL/Three.js components with proper cleanup

#### Error Handling

- **Database errors:** Use MCP tools to diagnose issues before manual fixes
- **File operations:** Implement proper error boundaries for large file uploads
- **API errors:** Use consistent error handling patterns across Supabase calls

#### Commit Message Format

Use single quotes for commit messages:

```bash
git commit -m '<task description> (auto via agent)'
```

#### Linear Issue Integration

When tasks reference Linear issues:

- Use `mcp_linear_get_issue()` to fetch current issue details
- Update issue status using `mcp_linear_update_issue()` when tasks complete major milestones
- Follow acceptance criteria from Linear issues during implementation

---

**General Rules**

- Each run must be atomic and focused on a single checklist item.
- Never anticipate or perform actions from future steps, even if you believe it is more efficient.
- Never use new code (functions, helpers, types, constants, etc.) in the codebase until _explicitly_ instructed by a checklist item.
- **When committing, always wrap the `git commit -m` message in single quotes.**
- **Use MCP database tools proactively** when working with schema, queries, or data operations.
- **Use Playwright MCP tools for E2E testing** when tasks involve user workflows, authentication, or data uploads.
- **Verify builds and linting** before marking tasks complete.

---

_Follow these steps for every agent run._
