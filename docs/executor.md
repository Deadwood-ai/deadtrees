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
   - **ONLY** add to "Rules & Tips" if you discovered specific constraints, patterns, or gotchas that **future tasks in this same implementation.md** will need to know to succeed.
   - **DO NOT** add general documentation of what was done, generic best practices, or information already covered in requirements.md, design.md, or the implementation.md task descriptions.
   - Use this litmus test: _"Will a future task in this implementation plan fail or be done incorrectly without knowing this specific technical constraint or pattern?"_
   - Examples of what TO include: "Database enum updates require dropping dependent views first", "Status columns must follow is_*_done naming pattern", "Function X must be called before function Y"
   - Examples of what NOT to include: "Added logging", "Created new table", "Updated models", general coding standards, or anything that describes what you accomplished
   - Before adding, check if similar information already exists in "Rules & Tips" and merge/clarify instead of duplicating.
   - **Always** insert "Rules & Tips" section _immediately after the "Notes" section_ in implementation.md (never at the end).

7. STOP — do not proceed to the next task.

9. Never make changes outside the scope of the current task. Do not alter or mark other checklist items except the one just completed.

11. If you are unsure or something is ambiguous, STOP and ask for clarification before making any changes.

---

### Deadtrees Rules

