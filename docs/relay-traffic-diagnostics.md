# Local relay traffic diagnostics

Server-side Centrifugo subscriptions emit structured completion logs for
commands, desktop file requests, and PTY sessions. Search the Vercel and
Trigger logs for `local_relay_command_traffic`, `local_relay_file_traffic`,
`local_relay_pty_traffic`, or `local_relay_presence_traffic` after the code is
deployed. These logs contain
user, connection, and operation IDs plus counts; they never include commands,
paths, file contents, or terminal output.

Every subscription with at least 1 MiB of estimated received payload is
logged. Smaller subscriptions are sampled at 1 in 8 using their random
operation ID; `sample_rate` records which rule applied. The counters are per
server subscription, not distinct bytes sent by the relay. Long-lived
active PTY sessions also log cumulative checkpoints at 1 MiB, 2 MiB, 4 MiB,
and so on, so an ongoing stream is visible before it exits. When aggregating
bytes, use a PTY session's completion record if present; otherwise use only
its latest checkpoint. In particular,
`received_payload_bytes_estimate` includes publications for other operations
on the same user channel. `unmatched_payload_bytes_estimate` counts the
estimated bytes attributable to those other operations, while
`stdout_bytes`, `stderr_bytes`, and `pty_data_bytes` count only matching
output. A large unmatched share points to channel fanout. Repeated
`subscription_events` with one publish attempt show reconnects without
replaying the operation.

Presence records cover both `/api/sandbox/presence` (`source: presence-route`)
and sandbox-manager probes used by Ask and Agent (`source: sandbox-manager`).
Each record has a random `probe_id` for one connection subscription and counts
all publications until the shared probe client is torn down, including traffic
after that connection's presence reply while other replies are pending.
`presence_reliable` describes the whole batch's result. These probes do not
publish commands: every received publication is incidental channel fanout.
Apply the same 1-in-8 sampling rule to these records; large records are exact
within the payload estimate. The SDK client names `hackerai-presence-route`
and `hackerai-sandbox-manager` distinguish these connections in broker metrics
that support client-name labels. Request/reply frames and WebSocket overhead
are outside the publication estimate.

Compare the estimated subscription totals and sampled operation counts with
Cloudflare's WebSocket response bytes and request counts for
`realtime.hackerai.co`. The estimate includes a small fixed envelope allowance
per publication and is intended for attribution, not billing reconciliation.
These server logs cannot attribute bytes sent to standalone local or Desktop
clients; if Cloudflare grows without a corresponding server-side increase,
inspect relay-side metrics or client diagnostics before changing traffic rules.

Trigger workers also emit the unsampled OpenTelemetry counter
`hackerai.local_relay.received_bytes`. Its bounded attributes are `operation`
(`command`, `file`, `pty`, `presence`), `source` (`agent-long`, `chat-handler`,
`presence-route`, `sandbox-manager`) and `correlation` (`matched`, `unmatched`).
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
SELECT operation, source, correlation,
       sum(greatest(last_value - first_value, 0)) AS observed_increase_bytes
FROM (
  SELECT machine_id, worker_version, toStartOfMinute(bucket_start) AS minute,
         attributes.operation AS operation, attributes.source AS source,
         attributes.correlation AS correlation,
         argMin(metric_value, bucket_start) AS first_value,
         argMax(metric_value, bucket_start) AS last_value
  FROM metrics
  WHERE metric_name = 'hackerai.local_relay.received_bytes'
  GROUP BY machine_id, worker_version, minute, operation, source, correlation
)
GROUP BY operation, source, correlation
ORDER BY observed_increase_bytes DESC
```

Command/file counters emit at cleanup; PTY checkpoints add only new bytes.
The emission window can differ from the delivery window at its boundaries.
These are delivered payload estimates including fanout, excluding WebSocket
framing and standalone clients. Vercel continues to use structured logs;
Trigger's metrics table does not cover Vercel without a metric exporter.

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
