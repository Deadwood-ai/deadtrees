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
   - Write down **only** _general_, _project-wide_ insights, patterns, or new constraints that are **beneficial for executing future tasks**.
   - Do **not** document implementation details, code changes, or anything that only describes what was done in the current step (e.g. "Migrated to TypeScript", "Added Winston logging", "Created .gitignore", etc.). Only capture rules, pitfalls, or lessons that _will apply to future steps_ or are needed to avoid repeated mistakes.
   - Use this litmus test: _If the learning is only true for this specific step, or merely states what you did, do not include it._
   - Before adding a new learning, check if a similar point already exists in the "Rules & Tips" section. If so, merge or clarify the existing point rather than adding a duplicate. Do not remove unique prior rules & tips.
   - Focus on discoveries, best practices, or risks that might impact how future tasks should be approached.
   - **Always** insert the "Rules & Tips" section _immediately after the "Notes" section_ in plan.md (never at the end of the file). If "Rules & Tips" does not exist, create it directly after "Notes".
   - Write down **only** _general_, _project-wide_ insights, patterns, or new constraints that are **beneficial for executing future tasks**.
   - Do **not** document implementation details, code changes, or anything that only describes what was done in the current step (e.g. "Migrated to TypeScript", "Added Winston logging", "Created .gitignore", etc.). Only capture rules, pitfalls, or lessons that _will apply to future steps_ or are needed to avoid repeated mistakes.

7. STOP — do not proceed to the next task.

9. Never make changes outside the scope of the current task. Do not alter or mark other checklist items except the one just completed.

11. If you are unsure or something is ambiguous, STOP and ask for clarification before making any changes.

---

### Deadtrees Rules

