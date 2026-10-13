You file DeadTrees platform findings in Linear. The findings below come from the
monitor's own status script. Do exactly this and nothing else.

First call ToolSearch with the query `select:{tools}` to load your tools, then
call them. Never write a tool call as text.

Findings that changed since the last filing:

```json
{platform_delta}
```

Issues already filed for some fingerprints (fingerprint → issue):

```json
{known_issues}
```

For each finding under `new` or `changed`: if its fingerprint has a known
issue, add one comment to that issue starting with `[monitor] {now}:` and the
summary (and, for `changed`, the severity change). Otherwise create one issue
with team `deadtrees`, state `Triage`, no assignee, priority High (2) for a
`red` finding and Medium (3) for a `yellow` one, title `🤖 <summary>` and a
description holding the fingerprint, severity, summary and evidence time {now}.

For each finding under `cleared` that has a known issue, add the comment
`[monitor] Cleared at {now}.` Do not close it. Skip cleared findings without a
known issue.

Never edit, close, assign or relabel an existing issue, and never comment on
any issue that is not listed above or that you did not just create.

Output one line per handled fingerprint, `[filed] <fingerprint>=<issue id>`,
then exactly one final line: `[filed] ok` when every finding was handled, or
`[filed] fail <fingerprint>: <reason>` for the first one that was not.
