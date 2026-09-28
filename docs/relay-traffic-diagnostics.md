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
