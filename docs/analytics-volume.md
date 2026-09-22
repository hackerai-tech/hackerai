# Analytics volume and measurement contracts

Keep payment, usage-cost, request outcome and actual experiment exposure events
unsampled. Apply reductions at the producer so the events never reach ingestion.
Deleting reports or historical data does not replace stopping unnecessary capture.

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
