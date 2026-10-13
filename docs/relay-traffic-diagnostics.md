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

## Terminal-history maintenance attribution

Local/Desktop record stores also emit two counters:
`hackerai.local_relay.terminal_record_operations` and
`hackerai.local_relay.terminal_record_payload_bytes`. Cloud stores emit neither.
Both use bounded labels only: `source` (Agent, chat handler, or unknown when
unavailable), `operation`, `outcome`, `transport` (`native_file` or
`posix_command`), and `reason` (`none`, `windows`, or `node_unavailable`). No
commands, output, paths, user/scope/session identifiers, or error text are labels.

- `checkpoint_write`: UTF-8 bytes in the complete serialized record submitted
  to the file transport. A failure still counts the attempted payload, even if
  no bytes or only part of it reached the host. Validation failures before
  serialization have no payload bytes.
- `recovery_read` and `retention_read`: UTF-8 bytes actually returned by a
  resolved read, including malformed, oversized or foreign records labelled
  `rejected`. A failed read has no measured payload; partial transport bytes
  are unknown. A successful read validates record identity/schema; it does not
  imply that a recovery caller accepted the record's age.
- `prune_route`: one decision for each prune call: `success` for a completed
  in-sandbox scan, `incomplete` when it declined safely, `failure` for command
  or response errors, `fallback` for Windows or missing/older Node, or
  `throttled` when the existing one-minute gate skipped work. Transport on a
  throttled call is the store's file transport, not an executed scanner.
- `prune_fallback`: completion/failure of the subsequent file-API scan. Its
  `success` means the best-effort scan finished; inspect `retention_read`
  failures/rejections separately. Do not add route and fallback counts to
  estimate distinct prune calls.

The byte counter measures logical record payloads at the store boundary. It
excludes the in-sandbox scanner's local disk reads, its command/summary, directory
listings, deletions, base64 expansion, protocol overhead, retries and fanout.
POSIX command failures may conceal partial reads. It is not AWS billed egress
and must not be subtracted from the received-publication counter as if the two
measured the same boundary. Write bytes flow toward the local host; read bytes
flow toward the server, although both pass through the relay.

Use the chronological within-minute query above with the new metric name and
partition by **machine, worker, operation, outcome, transport, reason and
source**. Never sum cumulative snapshots. The same initial/boundary/reset
under-counting and exporter-coverage limits apply. Compare complete UTC windows
and the mix of fallback outcomes before changing persistence behavior. These
metrics arrive after the server deployment; no client update is required.
