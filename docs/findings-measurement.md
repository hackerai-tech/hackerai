# Findings measurement and corrections

Findings are a permanent workflow. Instrumentation measures whether people can
retrieve, correct, and use a saved report; it does not decide whether to remove
the feature. HAC-30 owns the researcher feedback and human release review.

## Interpreting outcomes

`finding_operation_completed` uses `finding_event_version: 1` and an explicit
property allowlist. Server report tools also emit `finding.operation_completed`
structured logs. Join durable tool operations through `trigger_run_id` and
`tool_call_id` to the actual task version. A generic current-worker lookup may
refer to a different task; inspect versions of actual `agent-long` runs.

- `success`: the operation returned a confirmed result.
- `rejected`: a known validation, evidence, provenance, duplicate, access, or
  optimistic-concurrency rejection. `not_found` deliberately does not disclose
  whether a report exists in another chat or account.
- `uncertain`: a write response could not be confirmed. Read back before retrying.
- `failed`: a read/export failure or an unhandled tool failure.
- `canceled`: the operation aborted, or a user canceled the save dialog.
- `initiated`: browser download dispatch or source-link navigation, not proof
  that the file was saved or navigation completed.

Tool input-schema rejections before execution remain in the existing generic
tool-error path; they do not emit this operation event.

Operations cover create/list/get/update, rendered detail loads, settled search
results, closure, export, source navigation, and voluntary feedback. Search
counts describe the first loaded page, not a total result count. Successful
native saves and File System Access saves differ from the browser blob fallback.
`transport: not_acquired` means no active sandbox was observed by that tool,
not that a cloud or Desktop transport was verified. List/get do not use a sandbox.

No prompts, search strings, target URLs, report bodies, evidence, paths, code,
correction reasons, or raw errors belong in analytics or these structured logs.
Opaque finding IDs and report timestamps correlate versions. Client events obey
the existing authenticated analytics/consent boundary and can be absent; server
tool outcomes are not a customer-usefulness verdict. Exclude internal QA users
from customer readouts and distinguish unique users/reports from repeated events.

## Quality and feedback

New and corrected reports require confidence, counterevidence, and conditions
that would change severity. Low/medium confidence requires a proof-gap rationale.
These requirements improve assessment completeness, not independent validation.
Legacy reports remain readable; their next correction must supply missing fields.

The detail panel asks voluntarily whether that revision was useful and
reproducible, needs correction, or has not been checked. The authenticated owner
can change their answer. Identical retries are idempotent, stale submissions are
rejected, and feedback never changes the report version or status. A correction
leaves the prior answer attached to its original version, so the new revision
appears unrated. The stored answer is the latest owner response, not a survey of
all reviewers. Self-selected feedback must not be presented as a causal benefit.

Successful corrections atomically retain the latest 20 metadata entries on the
finding, with the correction message, reason, changed fields, and prior/current
severity, CVSS score, and confidence. The total recorded correction count can
exceed 20. Earlier bodies are not retained or recoverable from this timeline;
pre-existing corrections are not backfilled. Rejected writes leave this history
unchanged. Replacement file references must be verified in the run’s acquired
sandbox; unavailable evidence rejects the correction and preserves the saved report. Deleting the finding removes its embedded history and feedback.

Review confirmed detail/export use alongside feedback, correction frequency,
false-positive closures, evidence warnings, rejected/stale/uncertain operations,
and latency. Keep absent feedback and unconfirmed downloads in the denominator
as unknown outcomes. A clean operation log alone does not prove a useful finding.
