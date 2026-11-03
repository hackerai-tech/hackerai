# Wallet settlement receipts

An Extra Usage action can lose its response before or after its wallet debit
commits. A completed Agent task or a usage-log row cannot prove that application.
New personal and team wallet calls carry a per-operation identity, separate from
the run's settlement ID. Selective Ask/Agent steps use distinct sequence-based
identities; finalization has another identity. Admission/other callers generate
an operation UUID once before sending the action. Admission retains that ID in
`RateLimitInfo` and joins it to the final usage row as `admission_operation_id`.

The operation claims its execution before reads, debits or auto-reload work. A
completed duplicate returns the original action result. A pending duplicate
fails closed, including after a worker interruption; it never takes over the
operation or drives another Stripe reload. There is no expiry, lease takeover,
sweeper, historical backfill, automatic financial retry or balance adjustment.
Deploy the additive backend before the web/Trigger callers. Older callers omit
the optional identity and retain their behavior until their workers drain.

Each attempt at the transactional wallet mutation stores a receipt alongside the
balance and spending-counter changes. Known underfunded attempts and the existing
post-reload retry have different attempt sequences. Once an attempt applies, no
other attempt for that operation can debit again. The receipt records actual
before/after wallet balances and explicit applied/not-applied outcomes; its result
retains cap/member/pool denial flags. Missing wallets have null balances. Reuse
with a different account, organization, settlement ID or point amount fails
closed. These fields form an immutable input fingerprint; credentials are never
stored. Balances, prices, caps and Stripe's reload/credit idempotency policy are
unchanged.

## Reconcile without replay

Use the signed backend-only `settlementReceipts.getForBackend` query with the
operation ID and exact user/optional organization scope. After account deletion,
use the `__deleted_user__` sentinel for retained receipts; the original user ID
is no longer available through this query. The query returns the
original identity, action state/result, and a bounded set of debit receipts.
Failure diagnostics include `settlement_operation_id`; selective step IDs also
join the existing run settlement ID and sequence.

- Completed action: read its saved result and debit receipts. Do not repeat the
  debit to verify it.
- Pending action with an applied receipt: the wallet debit committed, even if
  the caller did not acknowledge it. The enclosing action's reload outcome can
  remain unresolved; the receipt links the existing auto-reload operation IDs
  before Stripe execution. Verify that separate reload operation and
  credit receipt before drawing conclusions about new money movement.
- Pending action without an applied receipt: absence alone does not prove safe
  non-application while the original executor may still be running. Preserve the
  fence and investigate using authoritative records.
- Missing operation: there is no new receipt evidence. Do not manufacture an
  operation identity for an old UNKNOWN or replay it under a new identity.

Usage logs retain `usage_deduction_outcome_unknown` for new records. The usage log
remains a caller summary, not a transactionally coupled wallet receipt. A receipt
can prove a wallet debit but does not prove the pricing of every provider call.
Request-time cost/pricing telemetry remains the calculation evidence.

Receipts and pending fences are retained without a TTL. Account deletion
anonymizes their direct user ID while preserving the financial evidence and
no-replay protection. New claims, debit writes and reload linkage check the
deletion fence before writing. Cleanup may leave an already running action
pending after anonymization; its original identity cannot resume it. The saved
debit and linked reload IDs remain available under the anonymized scope. Do not
hold account erasure indefinitely for a pending operation. Any future retention
policy must preserve idempotency before pruning receipt data.

## Boundaries and acceptance

This contract covers Extra Usage wallet debits, including team balance/member
counters. Included allowance lives in Redis and retains its existing behavior;
a wallet receipt does not prove an included-bucket debit. Refunds, purchases and
Stripe auto-reload crediting retain their existing separate idempotency records.
The two stores are not a cross-service atomic transaction.

Before production rollout, verify a new disposable QA operation for personal and
team wallets, duplicate/concurrent calls, changed-amount rejection, monthly/member
caps and underfunded auto-reload. Inject loss before debit, after debit and after
action completion. Check saved results and actual wallet/member deltas. A pending
duplicate must not drive Stripe again. Verify Ask and Trigger Agent both pass
distinct step/final operation IDs and retain UNKNOWN on failure. Never use a
historical customer operation for these tests.
