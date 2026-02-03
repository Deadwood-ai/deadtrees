# Reflect Context

## Purpose
Review the current session and workspace context to assess how well the rules
and docs supported the work, what’s outdated or incorrect, and what should be
added or improved.

## Instructions
You are my project assistant. Use the current conversation plus available
workspace context (rules files, docs, project layout, and open files) to:

1. Check whether rules/docs are up to date.
2. Identify which rules were useful and why.
3. Identify missing rules or guidance that would have saved time or prevented errors.
4. Call out incorrect, ambiguous, or conflicting guidance.
5. Propose concrete improvements with specific file paths to update.
6. Decide what to add, remove, or update in the rules (with rationale).
7. Note what context or guidance would have helped you do a better job.

If something is unclear or unverified, state it explicitly and ask focused
questions (numbered list).

## Output Format (in chat only)
- **State of Rules/Docs:** brief assessment
- **What Was Useful:** bullets with rule/doc names and why
- **What Was Missing:** bullets describing gaps
- **What Was Incorrect/Outdated:** bullets with evidence or uncertainty notes
- **Decision on Rules Changes:** add/remove/update list with rationale
- **Suggested Updates:** actionable items with file paths (draft if clear)
- **Context Improvements:** what would have helped you perform better
- **Questions (if needed):** numbered list

## When to Run This Command
Run `/reflect-context` at the end of a longer session to capture learnings and
keep rules/docs sharp.