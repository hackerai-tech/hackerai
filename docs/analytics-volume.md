# Analytics volume and measurement contracts

Keep payment, usage-cost, request outcome and actual experiment exposure events
unsampled. Apply reductions at the producer so the events never reach ingestion.
Deleting reports or historical data does not replace stopping unnecessary capture.

`x_referral_visit` records an actual browser arrival with a `t.co`, `x.com`, or
`twitter.com` referrer, including their subdomains. It requires the existing
analytics consent decision and excludes recognizable crawlers/link previews.
Anonymous arrivals initialize the same PostHog identity later used by `identify`,
but allow only this event through `before_send`; pageviews, replay, surveys and
exception capture stay disabled. Preserve the anonymous identity across navigation,
and reset it on logout from an identified account or consent withdrawal.
Capture is best effort; a stable identity/day UUID bounds repeats and browser
storage avoids sending them. Count distinct persons over the entire reporting
window, not summed daily uniques or event counts. The event allowlist removes
SDK-added URLs, query strings and person properties. It does not require tagged
links or replace the original first-touch attribution. Direct/search visits have
no X evidence and are not inferred to be X traffic.

## Customer-visible performance

`chat_visible_response_performance` records one best-effort summary per new
Ask/Agent POST for an already identified, consent-eligible browser user. GET
reconnects and loaded history do not start samples. Correlate by `sample_id`,
`chat_id`, and `trigger_run_id` when available. Retain errors, aborts, navigation,
superseded requests, and null first-text timings; null is not a fast response.
Use `visible_text_observed=true` and `backgrounded=false` for foreground latency
percentiles, and report the excluded/missing share alongside them.

`first_visible_text_ms` starts at transport dispatch and ends after a DOM text
commit and two animation-frame callbacks, when a rendered text element intersects
the chat viewport. It is a paint-opportunity proxy, not proof of display pixels.
It excludes reasoning-only data and older assistant messages. Text update gaps
can include tool work, reasoning, approvals, or network delays; they are not
automatically provider stalls. Partially visible text elements may include
updates below the viewport. Backgrounding breaks the gap interval. Navigation or
process termination can truncate/lose a sample; the telemetry is not a ledger.

`chat_browser_responsiveness` uses stable 10% sampling of identified users.
It aggregates textarea input-to-frame delay, frame gaps during scrolling,
Long Tasks, and Event Timing entry counts/durations for at most one minute, flushing on
visibility change, page hide, and cleanup. Idle windows emit nothing. API support
booleans distinguish unsupported metrics from observed zeroes. Frame delays are
main-thread proxies, not compositor frame rates. The maximum Event Timing entry
duration is not the standardized INP statistic. Compare per-user distributions;
do not multiply sampled-user counts into exact totals.

Both events contain only bounded metadata, timings, counts, and correlation IDs.
They do not capture message text, keys, DOM content, selectors, or raw browser
performance entries. The final PostHog before-send hook allowlists properties
for these two events, excluding SDK-added URLs, referrers, attribution, and
unrelated registered properties. Consent withdrawal/account changes discard pending samples.
The owning performance work is HAC-151; evaluate browser overhead and acquisition
success after rollout before changing sampling or deadline policy.

Cloud acquisition uses one 30-second active-wait budget across provider retries
and consecutive failed attempts in a manager. E2B receives the shared abort
signal for discovery, lookup, connect and create; the signal cancels supported
SDK requests. The outer deadline also bounds adapters that cannot abort. Late
results are fenced before publishing/caching a connection. A timeout does not
authorize deleting a workspace, replacing a migration destination, or retrying
an uncertain create. A provider may complete remote work after local cancellation.

`computer_activation_cta_impressed` records one identified user/surface/source
per UTC day, matching upgrade-impression granularity. Browser storage prevents
repeat sends across mounts and reloads; a stable ingestion UUID deduplicates
devices and storage failures. Click and download events remain unsampled.
Compare distinct exposed users, not old mount counts, across this boundary.
The mounted computer CTA retries unavailable capture for up to one minute,
stopping after capture or daily deduplication, and cancels retries on unmount.

Desktop relay telemetry retains the first occurrence of each bounded
event/state/source/errorType/code/transport/recovered signature in a five-minute
window. Callbacks are identical when all seven values match; other properties,
including reason and retry counts, do not affect aggregation. Later identical
callbacks are summarized on the next event after the window or on bridge teardown.
Failed captures remain pending for the next callback or flush. The buffer holds
at most 32 signatures, evicting the oldest if capture remains unavailable.
Sum `coalesce(properties.telemetry_occurrences, 1)` to count callbacks; summary
events carry `telemetry_summary=true` and the first/last observation times.
An abrupt process exit can lose a pending summary, so this remains best-effort
diagnostic telemetry. Full local console diagnostics and transport behavior are
independent of this aggregation.

Survey selection batches the independent-paid and legacy flags when both are
eligible. Each request evaluates fresh values with the same person properties;
there is no cross-user or cross-request cache. The pinned SDK's `getAllFlags`
does not emit automatic exposure. Preserve the explicit selection/shown events
and fallback to separate checks if the batch throws.

PostHog's full-refresh warehouse imports of `unit_economics_daily`, `feedback`
and `platform_costs_daily` run daily. Reports can lag source data by a day.
Keep full refresh until an incremental replacement accounts for mutable rows,
backdated adjustments and deletions. Sync schedules are managed in PostHog,
independently of Vercel, Trigger and Convex deployments.

## Desktop acknowledged output

`desktop_ack_command_started` and `desktop_ack_command_settled` measure the
Desktop sender's `ack-v1` delivery window. They are separate from the legacy
`desktop_stream_command_settled` event. Join each pair by connection and command
ID, and use `triggerRunId` / `chatId` for outcome correlation. Both schema versions
include the loaded frontend commit when available; worker version alone cannot
identify the Desktop frontend. Deduplicate by event name, connection and command.

Schema version 1 emits every identified command's start/final. Version 2 keeps
stable 10% command samples, selected by hashing connection/command IDs at start.
Sampled starts and finals carry `telemetry_sampled=true`. Every incomplete,
canceled, error-frame, nonzero/unknown-exit, retry/resume/publish-failure or
30-second-plus settlement is retained, including unsampled commands; these
extra finals carry `telemetry_sampled=false`. `telemetry_sample_rate` is 1 for
always-retained diagnostic finals and 0.1 for routine sampled details. For
unbiased detailed coverage and latency distributions, filter version 2 to
`telemetry_sampled=true` on **both** sides, including diagnostic finals in that
cohort. Do not divide all retained finals by sampled starts.

`desktop_ack_delivery_summary` carries unsampled version 2 counters for every
consent-eligible identified command, independently of detail sampling. One bridge
keeps fixed-size counters and flushes after one minute of activity, on page hide,
on visibility becoming hidden, and after settling streams on bridge shutdown.
Summaries include the connection and loaded frontend build, but no command,
chat or run IDs. `telemetrySessionId` and `windowSequence` distinguish windows
and let consumers detect missing windows. The authenticated queue also assigns
a stable ingestion UUID per summary. Failed capture retains counters until the
next flush; bridge teardown makes one final attempt and releases its listeners.

Use sums of summary counters for version 2 reliability metrics:

- Delivery ACK rate: `sum(acknowledgedCount) / sum(startedCount)`.
- Settlement coverage: `sum(settledCount) / sum(startedCount)`; report canceled
  and incomplete counts separately.
- ACK rate among streams with retry evidence:
  `sum(retryEvidenceAcknowledgedCount) / sum(retryEvidenceCount)`.
- Failure diagnostics: `terminalErrorCount`, `nonzeroExitCount`,
  `bufferLimitCount`, `deadlineExceededCount`, `ownershipLostCount`, `stoppedCount`.
  `publishFailureCount`, `replayCount` and `resumeCount` count attempts/requests,
  whereas `retryEvidenceCount` counts affected commands once.

Starts and settlements can land in different windows. For each complete session,
`sum(startedCount) - sum(settledCount)` equals its last `pendingAtEnd` (the first
`pendingAtStart` is zero). For a partial session, include the first
`pendingAtStart`. Do not sum pending gauges or treat an unclosed command as
successful. Prefer complete sessions for rates and report open commands and
window-sequence gaps at reporting boundaries. During mixed-version rollout,
combine version 1 individual counts with version 2 summary sums; never add
version 2 detail events to summary counts.

Analytics remains best effort through the existing bounded authenticated queue.
Identity/consent changes discard pending counters and invalidate old settlements.
App/process termination can lose the last unflushed minute or queued events;
pagehide is not guaranteed on native quit. These counters are observed telemetry,
not an execution ledger or a census of unidentified clients. Sampled start/final
coverage and missing summary windows remain useful data-quality checks.

`acknowledged` means the cumulative receiver ACK reached the terminal frame.
`terminalType` distinguishes an exit frame from an error frame; acknowledgement
is not successful execution, durable storage, semantic correctness or whole-run
completion. `canceled` and `incomplete` remain separate outcomes. Finite reasons
identify terminal ACK, cancellation, buffer exhaustion, deadline, lost ownership
and explicit stop without exporting exception text.

Frame counts distinguish observed callbacks, admitted frames and acknowledged
frames. An overflow-rejected callback is observed but not admitted. Publish and
replay attempts are attempts, not receipts; publish failures count rejected
promises observed before settlement. Resume requests and replay attempts can
follow a lost ACK even when the original output arrived. Report terminal ACK
rates among all observed starts and separately among streams with replay,
resume or publish-failure evidence; never claim a retransmission alone proves
recovery. Counts, pending bytes and duration are frozen before buffer release,
including when native invocation or publication has not returned. No command
text, stdout/stderr, error message, paths or environment values are collected.

## Terminal call timing logs

`terminal_call_finished` version 2 retains 10% of routine calls, deterministically
by run/chat and tool-call ID. Routine means a returned zero exit or live session,
under 30 seconds, without an error, abort, wait expiry, timeout, explicit unknown
status, unsuccessful result, recovered-record marker or persistence failure.
All other calls are retained. Nested session exit codes are checked too.
`telemetry_selection` identifies sampled versus diagnostic logs;
`telemetry_sample_rate` is 0.1 or 1 respectively. Use inverse-probability weights
for estimated log totals; raw counts and unweighted percentiles across the
combined retained population are biased toward diagnostics. Old logs have an
implicit rate of 1. Existing unsampled `hackerai-tool_usage`, request outcomes,
cost events, and separate recovery/persistence logs remain authoritative for
aggregate tool usage and reliability. A silent relay retry does not necessarily
set a recovered marker on the returned tool result; its separate recovery logs
remain unsampled.

Sampling only controls PostHog log capture. Tool execution, thrown errors,
returned content, and `callTiming` on every tool result are unchanged. Only
bounded status metadata and timing/counts are logged; error text, commands,
stdin, session handles, paths, and output are excluded.
