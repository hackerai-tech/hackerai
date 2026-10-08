# Analytics volume and measurement contracts

Keep payment, usage-cost, request outcome and actual experiment exposure events
unsampled. Apply reductions at the producer so the events never reach ingestion.
Deleting reports or historical data does not replace stopping unnecessary capture.

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

Miosa step sampling is defined in [Miosa measurement](miosa-measurement.md).
Use the unsampled acquisition summary for rates and latency; sampled step events
are for diagnosis, not a substitute denominator.

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
