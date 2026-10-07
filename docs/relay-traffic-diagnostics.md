# Local relay traffic diagnostics

Routine per-operation traffic logs are disabled. Use aggregate byte counters to
compare isolated and legacy traffic, along with successful operations and relay
failures. Compare matched UTC windows with Cloudflare WebSocket response bytes
for `realtime.hackerai.co` and finalized AWS egress before claiming savings.
The counters estimate publications delivered to server subscriptions, including
fanout. They exclude standalone client subscriptions and WebSocket framing and
are not billing totals.

Trigger workers emit the unsampled OpenTelemetry counter
`hackerai.local_relay.received_bytes`. Its bounded attributes are `operation`
(`command`, `file`, `pty`, `presence`), `source` (`agent-long`, `chat-handler`,
`presence-route`, `sandbox-manager`), `correlation` (`matched`, `unmatched`),
and `channel` (`operation`, `connection`).
The labels contain no user, connection, chat, run, or operation identifiers.
`channel: operation` identifies clients using isolated replies; `connection`
identifies legacy replies and presence probes. Historical snapshots before the
label was introduced have no channel value.
The table contains repeated cumulative snapshots, and counters can reset.
Never sum raw `metric_value`. Trigger attaches run identity at export, so a
run's counter maximum can include bytes recorded during an earlier run.

For a conservative readout, set an explicit UTC range in the query tool and
sum positive chronological differences inside non-overlapping one-minute
machine/worker/label intervals. This omits initial snapshots, increments
crossing minute boundaries and increases obscured by resets. It is not a
complete interval total or precise per-run attribution. Exact totals need
reset-aware adjacent increments with a verified process/series identity.

```sql
SELECT operation, source, correlation, channel,
       sum(greatest(last_value - first_value, 0)) AS observed_increase_bytes
FROM (
  SELECT machine_id, worker_version, toStartOfMinute(bucket_start) AS minute,
         attributes.operation AS operation, attributes.source AS source,
         attributes.correlation AS correlation,
         attributes.channel AS channel,
         argMin(metric_value, bucket_start) AS first_value,
         argMax(metric_value, bucket_start) AS last_value
  FROM metrics
  WHERE metric_name = 'hackerai.local_relay.received_bytes'
  GROUP BY machine_id, worker_version, minute, operation, source, correlation, channel
)
GROUP BY operation, source, correlation, channel
ORDER BY observed_increase_bytes DESC
```

Command/file counters emit once at cleanup. PTY streams flush only new bytes
at exponentially spaced size checkpoints and completion. Presence probes count
incidental publications until their shared client is torn down; these bytes
are classified as unmatched (older workers classified them as matched).
The emission window can differ from the delivery window at its boundaries.
These are delivered payload estimates including fanout, excluding WebSocket
framing and standalone clients. Trigger's metrics table does not cover Vercel
without a metric exporter.
Regular connection, readiness, cancellation and timeout failure diagnostics
remain available in Vercel and Trigger logs.

## Operation channel compatibility

Clients advertising `operationChannels` accept an `operationChannel: true`
request on their connection channel, subscribe to a derived user-limited
operation channel, acknowledge readiness, then execute once. The server drops
its temporary connection subscription after dispatch. Responses and ongoing
cancel/PTY controls use the operation channel; older clients and requests keep
the connection channel. Both peers remain subscribers while publishing, which
preserves the broker's `allow_publish_for_subscriber` permission boundary.
No broker permission/configuration change is required.

Deploy the optional Convex capability validator before upgraded clients.
Desktop picks up the hosted bridge after reload/reconnect; local CLI users need
an updated package. Rollback can stop server selection of operation channels;
new clients still accept legacy requests. Compare complete matched windows and
successful operations after rollout before claiming a bill reduction.
