# Message search storage migration

Message bodies stay in `messages`. `message_search` holds the existing indexed
text, visibility and result metadata. Saves, edits, recovered Agent snapshots,
branches and deletions keep the two records in the same transaction. Search text
retains the existing size limit; this migration does not change search coverage
or shorten canonical message parts.

Deploying the code does not start a migration. Until an operator starts one,
queries use the existing `messages.search_content` index.

After independently verifying the intended account, project, deployment and URL,
use an explicitly selected deployment to invoke these **internal** mutations:

1. `messageSearchMigration:start` with `{ "direction": "separate" }`.
2. Call `messageSearchMigration:advance` with `{}` until `done` is true.

Each call is bounded by document count and bytes. The cursor is stored on the
backend; retrying a failed call or restarting the client resumes safely. During
`copying`, writes maintain both representations and searches still use the legacy
index. Only a completed copy enables separate search reads. `stripping` then
removes the duplicate text from message bodies; `ready` is the final phase.
New search records use their own creation timestamp from the same transaction;
backfilled records preserve the original message creation timestamp explicitly.

## Rollback

Do **not** deploy old readers directly after `stripping` has started. They cannot
search messages whose legacy text has been removed.

Invoke `start` with `{ "direction": "restore" }`, then call `advance` until it
returns `phase: "legacy"` and `done: true`. Searches keep using the separate table
while the exact indexed text is restored. Concurrent writes maintain both copies.
Only after restoration completes is code using the old index safe to deploy.
A restore requested during `copying` can return to legacy immediately because no
legacy text has been removed yet. Separating again runs a fresh bounded copy.

Missing search records after cutover are consistency errors. Migration fails
closed instead of silently dropping text or claiming restoration succeeded.
Investigate any writer that bypasses the message storage helpers before retrying.
