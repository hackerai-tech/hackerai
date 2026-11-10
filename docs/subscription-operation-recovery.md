# Cancel/keep operation recovery

Cancel and keep-plan requests share a Convex claim keyed by Stripe customer.
The claim precedes the subscription read, so overlapping requests cannot act on
conflicting snapshots. A competing request receives HTTP 409 and must be retried
after the first finishes. Different customers remain independent.

Preflight claims expire after two minutes. Before an external write, the owner
atomically changes its claim to `writing`; that claim never expires automatically.
A stale preflight owner cannot write or release a replacement owner's claim.
Successful operations and definitive Stripe rejections release the claim.
Token-matched cleanup retries once. If both attempts fail, the confirmed result
or original error is preserved and `billing_operation_release_failed` is logged;
a read-only claim still expires normally.
Network failures, conflicting requests, 5xx responses, process termination, or
failure to release can leave it in place. This deliberately trades temporary
billing unavailability for preventing an unresolved cancel from applying after a
successful keep. Normal feedback failures do not bypass the claim.

## Recovering a retained claim

1. Verify the intended HackerAI environment, Convex account/project/deployment,
   and Stripe account/mode before reading or changing anything.
2. Inspect that customer's `billing_operations` row and the corresponding
   `billing_operation_requires_reconciliation` or `billing_operation_release_failed`
   error (a killed process may not
   emit it). Record the operation, creation time and exact owner token. Do not
   delete the row merely because it is old.
3. Verify the original web request has stopped and every Stripe write it issued
   has a terminal outcome in Stripe request logs, including schedule releases
   and metadata updates. A subscription GET, timeout, or webhook alone does not
   prove a request cannot still apply. If any outcome remains unknown, retain
   the claim and resolve it with Stripe support.
4. Reconcile the confirmed subscription state and cancellation feedback using
   the existing webhook/reconciliation paths. Do not submit another change as
   a diagnostic probe.
5. From the verified backend's trusted service client, invoke
   `billingOperations.finish` with that customer and exact original token.
   Supply service authentication through the existing signed client; never put
   service keys in shell arguments or logs. The mutation refuses to delete a
   different owner's claim. Read back the row and let the user retry, which
   reads fresh Stripe state.

Do not reset claims on deployment, through cron, or through account deletion.
They contain only the billing customer reference and coordination metadata, not
cancellation feedback. This guard covers the in-app cancel/keep actions; external
Stripe Dashboard/Portal commands do not participate in application coordination.
