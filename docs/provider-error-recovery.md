# Provider error recovery

Agent provider failures may arrive as an HTTP rejection or as an error inside
an already-open SSE stream. A numeric SSE `code` in the 5xx range is eligible
for the same bounded disconnect continuation as an HTTP `statusCode`. A bare
abort without an upstream status remains ineligible; user cancellation always
wins. Recovery retains completed tool results and removes only the incomplete
tail. The existing model selection, billing, authorization, and retry limits
still apply.

A retained local tool call can lack its result even before a completed sibling
or later step. Continuation preserves that call as an error with an explicitly
unknown execution outcome, so the next request has a matching result without
claiming success or user cancellation. The model must verify its effects before
considering another execution; this marker alone does not prove whether the
tool ran. Completed results and provider-executed calls remain unchanged.

The local provider watchdog distinguishes waiting for a response from waiting
for a streamed chunk. A response timeout can leave only completed tool results
in the transcript, with no new step or partial tail to trim. That specific local
error may retain the completed tail for the existing bounded continuation;
provider-supplied error wording alone does not enable it.

A rejection delivered through `streamText.onError` before any output can use
the existing fallback, including an active Abliteration experiment's baseline
route. This does not enable replay of arbitrary output-bearing 400 failures.
The recognized Fireworks image-format rejection uses the existing image-tool
recovery path. Generic invalid-parameter errors are not assumed to be images.

Storage compaction preserves step boundaries in retained history. For older
Abliteration histories, request preparation splits assistant batches exceeding
128 calls only when every call has exactly one adjacent result. Calls, results,
and their IDs are retained; incomplete or ambiguous batches are left unchanged
and reported by shape diagnostics. Storage's hard byte limit can still remove
old parts as before.

## Diagnosing a failure

Inspect the existing `provider_streaming_error` / `provider_stream_terminated`
event and the primary stream's `provider_recovery_decision` event in the same
Trigger run. The decision records eligibility or the skip reason, cancellation,
retry budget state, completed tool count, safe continuation availability, and
provider correlation IDs. Later recovery attempts/outcomes continue to use
`agent_provider_disconnect_recovery_attempted` and
`agent_provider_disconnect_recovery_completed`.

The provider request diagnostics include the maximum calls per assistant,
unmatched call/result counts, duplicate calls within a batch, and the number of
oversized batches repaired in that request. Error extraction retains known
schema parameter paths with numeric indices normalized, when supplied by the
provider. No new diagnostic includes prompts, tool arguments/results, image
contents, or signed URLs.

Generic `invalid_request` responses still require an upstream request ID and
these shape diagnostics to identify the rejected constraint. An image fetch
403 is not proof of expiration: check storage authorization and URL freshness
before changing image handling. This change does not refresh signed URLs.

## Verification

Automated regression tests exercise real AI SDK streaming: execute a tool,
inject an SSE 504, preserve its result, and complete fallback through the UI
message parser without executing that tool twice. They also exercise an HTTP
rejection delivered asynchronously, cancellation/retry guards, storage-to-SDK
round trips, and 148-call legacy histories with complete and ambiguous pairs.

Before promotion, use the PR's Preview with an internal account:

1. Start a disposable Agent chat and ask it to write a short marker to a
   temporary file, read it, and report completion. Reload the chat; the tool
   results and final response should remain visible.
2. Attach a small PNG and request a short description. Confirm completion and
   that no raw image or signed URL appears in the new diagnostics.
3. If an upstream failure occurs, inspect the matching Preview Trigger run.
   It should record recovery eligibility/skip reason, preserve completed work,
   and obey the existing retry budget. Canceling must prevent a new model leg.

Fault injection is covered locally; do not replay customer runs to manufacture
these failures. Production verification requires the new Trigger worker
deployment and new runs; existing failed runs do not change retroactively.

## Objective checkpoints

The `agent-objective-checkpoint` experiment extends the private child work
ledger and the parent chat's private runtime state. It applies to Trigger Agent
runs and is inherited by their children; Ask keeps its existing behavior. The
initial policy is two unsuccessful attempts without a new meaningful
observation against the current user/delegated objective. The agent must assess
a completed tool result before another exploratory action can start. A useful
negative result can count as evidence; changing command arguments cannot reset
the counter by itself. These assessments are model judgments, not independent
verification of findings. Evaluate premature stops and assessment overhead along
with saved execution cost before expanding the experiment.

The runtime persists pending and running action state before execution, then
stores the outcome, tool-call identity and a bounded result summary. Completed
identical actions are not automatically replayed under a new tool-call ID.
The ledger retains observations, artifact references, pending work, the blocker
and observed cumulative spend across recovery. It has bounded action and byte
limits; reaching them stops further execution rather than discarding history.
It is not an exactly-once protocol: an external effect can occur before its
result is saved. Such actions become outcome-unknown, and cannot be declared
completed by a model assessment.

Provider recovery keeps the same runtime checkpoint. Worker or child recovery
checks the saved sandbox identity. A recorded terminal session can be inspected
at most twice using the existing read-only session view; no command or input is
replayed. Missing sessions, changed/unavailable sandboxes and unverified saved
artifact references produce a blocker. Artifact locations alone do not prove
availability or content identity, so automated artifact-bearing resume remains
conservative. Completed results remain available for a partial response.

A fresh, user-requested follow-up may reset the two-failure counter; automatic
continuations and provider retries cannot. It does not reset step, time, billing,
child resume or provider retry budgets. Unknown action outcomes and environment
checks still prevent resumption. Existing child results are delivered through
the parent completion gate even when new exploration stops. A blocked child
returns partial/blocked task status with the recovery limitation.

`agent_objective_checkpoint_exposed` records execution under the policy.
`agent_objective_progress_assessed` records the declared outcome and checkpoint
status. `agent_objective_action_reconciled` records the observed action state.
`agent_objective_checkpoint_spend` records cumulative observed cost after normal
step accounting, including reporting steps. Use the latest `run_spend_dollars` value per
run, not the sum of these events; `spend_dollars` also retains prior recovery
spend and must not be summed across follow-up runs; match parent and child lineage with existing
billing records to avoid double-counting. Reserved dollars are unknown (`null`):
existing concurrency reservations are not financial reservations. No event
contains arguments, observations, result summaries or artifact locations.
Reduced waste does not by itself establish the required 40% all-cost margin;
prices, entitlements and existing billing gates are unchanged.

Deploy the optional Convex fields and backend functions before the new Trigger
worker. Preview and Production flag definitions are separate. Verify each
worker's actual PostHog project independently from Vercel before enabling it.
Disabling the flag stops assignment to new runs; an already exposed run retains
its policy until completion. Keep durable records when rolling back.

For manual acceptance, use an independently verified Preview custom URL and
worker with an internal account. Repeat the following with a cloud sandbox,
a local sandbox and the desktop transport:

1. In a disposable Agent chat, attempt two different commands against an
   intentionally unavailable owned fixture. Check that the final response
   retains useful partial results, the blocker and spend; no third exploratory
   action should execute. A newly established negative result should permit
   further work.
2. Write a disposable marker, then disconnect/reload immediately. Confirm its
   saved tool result remains visible and recovery does not write it again.
3. Start a bounded background command and reconnect. Confirm session inspection
   happens before further work. A missing session or changed sandbox must return
   an unknown-outcome blocker, without restarting the command. Saved artifact
   references must not be described as verified unless actually checked.
4. Cancel during recovery, then repeat near the existing spend cap. Cancellation
   and budget exhaustion must prevent further execution. Repeat through a
   delegated general child and confirm the parent receives its partial result.
