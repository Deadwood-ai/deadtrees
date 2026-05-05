# Local Review Instructions

Use this file when the user asks for a local pre-PR review, mentions
`@local-review-instructions`, or wants Codex to improve a worktree before opening
a pull request.

## Intent

Run the review as a pragmatic local quality pass before PR review.

The goal is to improve correctness, maintainability, and testability in the
current application without turning the change into a broad rewrite. Treat the
current branch as a nearly finished first version: look for concrete risks and
small high-leverage cleanups that make the PR easier to review and safer to ship.

## Review Scope

Review the diff against the intended base branch, usually `main`.

Prioritize:

- Correctness bugs and broken user flows.
- Authorization, RLS, signed URL, upload validation, secret handling, and other
  security or privacy risks.
- Data loss, unsafe migrations, storage mistakes, processor queue mistakes, and
  production deployment hazards.
- Testability gaps where a realistic regression is likely or the changed behavior
  is hard to verify.
- Maintainability problems that create concrete future risk, such as duplicated
  workflow logic, scattered ownership, hidden ordering assumptions, unclear domain
  names, brittle coupling, or oversized unstructured functions.
- Frontend UX regressions that affect real workflows, including broken responsive
  layouts, inaccessible controls, confusing states, missing loading/error states,
  or text/layout overlap.

Avoid:

- Subjective style nits.
- Formatting-only comments.
- Broad rewrites.
- New abstractions unless they clearly remove real complexity or match an
  existing local pattern.
- Architecture suggestions that are not justified by the current diff.
- Expanding scope into unrelated files unless the current change depends on them.

## How To Run

If using the Codex CLI directly, prefer:

```bash
codex review --base main - < docs/agents/local-review-instructions.md
```

Use a different base branch only when the worktree clearly targets another base.
For uncommitted work, include staged, unstaged, and untracked changes when needed.

## Output Format

Lead with findings, ordered by severity. For each finding, include:

- Severity.
- File and line reference where possible.
- The concrete risk.
- The smallest reasonable fix.
- What validation would prove the fix.

Then include:

- `Recommended local cleanup before PR`: a short list of changes worth doing now.
- `Defer`: items that are valid but should wait because they are not necessary for
  this PR.
- `Validation`: tests, browser checks, DB checks, or commands already run or still
  needed.

If there are no meaningful issues, say so clearly and list remaining test gaps or
residual risk.

## Acting On Findings

When the user asks Codex to run the local review and improve the worktree:

1. Inspect the repo state first.
2. Run or perform the review using these instructions.
3. Fix only high-signal findings that are in scope for the branch.
4. Preserve user changes and avoid unrelated refactors.
5. Run the smallest relevant validation set.
6. Summarize what changed, what was validated, and what remains deferred.

Do not commit, push, open a PR, mutate production, or perform production database
writes unless the user explicitly asks.
