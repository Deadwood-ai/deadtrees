# Approved one-off production writes

This playbook (DT-1514) describes how a thread carries out a production
write that the user has approved, such as an import, a backfill or a data fix.
Nothing here grants new access: every write still needs the user's explicit
words for that write, in the thread that asks.

## Why

Threads on the processing server have no permission prompt that reaches the
user, and they may not read production write credentials. In the DT-1487 import
the user ended up pasting commands and screenshots for two days. This playbook
replaces that with one prepared run and, at most, one action by the user.

## Before asking

1. Put the write in a reviewed, merged script or a SQL file committed to the
   thread's branch. No ad-hoc commands.
2. Run it against the isolated local QA stack and show the result: rows touched,
   a sample, and how to undo it.
3. Ask with a decision brief that names the exact command, the target, the
   expected row counts and the undo path. His reply in that thread approves
   that one run and nothing more.

## Route A, the default: run it from the Mac

The write credential stays in the Mac Keychain.

1. The thread sends the coordinator `blocked · tier · link · ask` and names the
   branch, the command and its approval message.
2. The Admin thread on the Mac checks out that branch in its own worktree and
   runs the command with the guarded credential:
   `~/.local/bin/codex-credentials run --keychain <group> -- <command>`. The
   Keychain prompt is the user's one action.
3. Admin posts the output (counts, no values) back to the thread, and the
   thread verifies the result read-only as `team_analyst`.

Use this route whenever the input files can be copied to the Mac or the command
reads them over SSH.

## Route B: a short-lived role, when the write must run on the server

For writes that need data on the processing server, such as large imports.

1. The user creates a role scoped to the tables the script writes, with an
   expiry, and puts its connection string in a 0600 file on the server, for
   example `~/.config/deadtrees/one-off-write.env`. The script prints the
   command; the user runs it.
2. The thread runs the script once with that file, deletes the file in the same
   command, and reports the counts.
3. The role expires on its own. The user drops it once the thread reports done.

The thread never prints, copies or keeps the file, and never reuses it for a
second run.

Open question: tables with row-level security need a policy for this role or
`BYPASSRLS`. The draft doesn't settle which, so Route B waits for that answer.

## Uploads to data2

Storage uploads from the processing server use `dt-storage-upload` (account
`dendro`, key `~/.ssh/processing-to-storage`); see
[processor-hosts.md](processor-hosts.md). They follow the same approval rule.

## Afterwards

Record in the Linear issue what ran, when, the counts and the undo path. No
credentials or raw data.
