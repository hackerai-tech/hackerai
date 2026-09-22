# Deletion completion verification

Deletion dialogs keep progress visible and prevent dismissal while their action is pending. Task, project, and uploaded-file deletion additionally check backend completion. Their progress toast survives a sidebar row being removed. Task DELETE endpoints return acceptance (202), rather than claiming that scheduled batches have completed.

Pending attachment receipts remain until S3 deletion succeeds. Failed storage jobs, failed required account-provider cleanup, malformed status responses, and timeouts surface errors instead of success. A timeout does not cancel background cleanup: task/project/file confirmation waits up to five minutes; account deletion waits up to twenty seconds for outstanding storage cleanup after its database batches finish. Failed storage receipts remain available for support to investigate and retry.

## Automated and local verification

- Initial verification covered 23 targeted Jest suites and 208 tests; the PR also runs the current full repository suite after updating to main. Coverage includes: deferred requests, dialog dismissal, duplicate clicks, backend acceptance, incomplete/failed storage, unmounted sidebar progress, file-removal failure, account-provider errors, authorization, and existing chat/file regressions.
- Root `tsc --noEmit` covers frontend and Convex sources. The repository does not have a separate `convex/tsconfig.json`.
- Isolated local Convex: a task with 105 messages, a project with 55 tasks, and bulk deletion all reached explicit `complete` status after their scheduled batches ran.
- Browser fixtures rendered the actual components and application CSS with controlled delayed responses. Bulk tasks, project deletion, unsharing, and notes retained progress and rejected Escape while pending. Completion released the controls or closed the dialog as appropriate.
- Full authenticated provider flows and production deletion were not executed.

## Manual checks before release

Use disposable test data and test billing accounts.

1. **Settings → Data controls:** delete all tasks with enough messages to span batches and at least one attachment. Keep the request/status response delayed. Loading should stay visible and confirmation should remain disabled until task records and pending attachment cleanup are gone. A failure must show an error without redirecting as if deletion succeeded.
2. **Sidebar task and project menus:** delete a large task and a project containing more than 50 tasks. Progress must survive the sidebar item disappearing. Project tasks must remain available outside the deleted project. Confirm success only after remaining cleanup finishes.
3. **Shared tasks, saved notes, attachments:** exercise single and bulk removal. Repeat clicks, Escape, and close controls must not dismiss pending work or start duplicate operations. Failed attachment deletion must leave the attachment visible.
4. **Terminal sandbox deletion:** verify the current multi-provider cleanup processes all returned pages. A genuine missing sandbox is idempotent success; an unexpected provider failure remains an error.
5. **Account, team membership/invitations, subscription cancellation, extra usage:** confirm progress remains visible until the request completes. Test account deletion with a storage/provider failure: it must not report success or remove the external identity before required cleanup succeeds. Retry after a Stripe customer was already deleted should skip that completed stage.

Deploy the additive Convex schema/functions before the frontend using their new status queries. The feature branch has not been deployed to production.
