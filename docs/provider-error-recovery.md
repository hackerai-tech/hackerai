# Provider error recovery

Agent provider failures may arrive as an HTTP rejection or as an error inside
an already-open SSE stream. A numeric SSE `code` in the 5xx range is eligible
for the same bounded disconnect continuation as an HTTP `statusCode`. A bare
abort without an upstream status remains ineligible; user cancellation always
wins. Recovery retains completed tool results and removes only the incomplete
tail. The existing model selection, billing, authorization, and retry limits
still apply.

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
