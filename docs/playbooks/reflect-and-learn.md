# Reflect And Learn Playbook

Use this when the user asks for `/reflect-and-learn`, `reflect and learn`, a
session retrospective, or learning cards. The goal is to improve future agent
sessions without letting the rule set grow by default.

## Goal

Review the actual session and identify:

- what worked
- what was confusing
- what was slow or wasteful
- what was incorrect, stale, duplicated, or missing in current docs
- whether a concise rule, playbook edit, or local setup change would have helped

## Rule-Change Budget

Only recommend changing rules when all of these are true:

1. The issue actually affected this session.
2. A future agent is likely to hit the same issue.
3. The fix can be stated as a short durable rule, pointer, or deletion.
4. It replaces or clarifies existing guidance instead of just adding more text.

Prefer deleting stale guidance, merging duplicates, or linking to a playbook over
adding broad new rules.

## Analyze

Check these sources before recommending rule changes:

- root `AGENTS.md`
- `docs/agents/README.md`
- `docs/agents/rules.md`
- task-specific playbooks under `docs/playbooks/`
- frontend `AGENTS.md` for frontend work
- local-only access docs only when the session involved credentials or remote access

Look for:

- rules that were helpful enough to keep
- rules that were missing but would have prevented a mistake
- rules that were stale or contradicted the live repo
- workflow steps that were too hidden for an agent to discover
- places where credentials or access boundaries were unclear
- one-off facts that should not become permanent rules

## Output

```markdown
## Reflect And Learn - YYYY-MM-DD

### Session Context
...

### What Worked
...

### What Was Confusing Or Wasteful
...

### Rule/Doc Findings
- Keep:
- Change:
- Delete or merge:
- Do not codify:

### Minimal Rule Updates
1. ...

### Learning Cards
H:: ...
A:: ...
Tags: #...
```

If the user asked for reflection only, do not edit files. If the user asked to
update rules, make the smallest focused edits after the reflection and report
which files changed.

Useful tag families: `#frontend`, `#backend`, `#database`, `#architecture`,
`#debugging`, `#process`, `#git`, `#supabase`, `#openlayers`, `#testing`,
`#agent-rules`, `#access`.
