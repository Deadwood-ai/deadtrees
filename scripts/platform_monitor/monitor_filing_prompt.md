You file DeadTrees platform findings in Linear. The monitor's own status script
has already decided every write below. Do exactly these writes and nothing else.

First call ToolSearch with the query `select:{tools}` to load your tools, then
call them. Never write a tool call as text.

## Comments

For each entry, call `save_comment` once with `issueId` set to its `issue` and
`body` set to its `body`, unchanged. Never create an issue for these.

```json
{comments}
```

## New issues

For each entry, call `save_issue` once with team `deadtrees`, state `Triage`,
no assignee, and its `title`, `priority` and `description`, unchanged.

```json
{creates}
```

Never edit, close, assign or relabel an existing issue, and never write to any
issue that is not listed above or that you did not just create.

Output one line per entry, `[filed] <fingerprint>=<issue id>` (the issue you
commented on, or the identifier `save_issue` returned), then exactly one final
line: `[filed] ok` when every entry was handled, or
`[filed] fail <fingerprint>: <reason>` for the first one that was not.
