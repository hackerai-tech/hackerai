# Local relay traffic diagnostics

Server-side Centrifugo subscriptions emit structured completion logs for
commands, desktop file requests, and PTY sessions. Search the Vercel and
Trigger logs for `local_relay_command_traffic`, `local_relay_file_traffic`,
or `local_relay_pty_traffic` after the code is deployed. These logs contain
user, connection, and operation IDs plus counts; they never include commands,
paths, file contents, or terminal output.

Every subscription with at least 1 MiB of estimated received payload is
logged. Smaller subscriptions are sampled at 1 in 256 using their random
operation ID; `sample_rate` records which rule applied. The counters are per
server subscription, not distinct bytes sent by the relay. Long-lived
active PTY sessions also log cumulative checkpoints at 1 MiB, 2 MiB, 4 MiB,
and so on, so an ongoing stream is visible before it exits. Count only the
latest checkpoint per PTY session when aggregating bytes. In particular,
`received_payload_bytes_estimate` includes publications for other operations
on the same user channel, while `stdout_bytes`, `stderr_bytes`, and
`pty_data_bytes` count only matching output. A large difference, together
with many `unmatched_publications`, points to channel fanout. Repeated
`subscription_events` with one publish attempt show reconnects without
replaying the operation.

Compare the estimated subscription totals and sampled operation counts with
Cloudflare's WebSocket response bytes and request counts for
`realtime.hackerai.co`. The estimate includes a small fixed envelope allowance
per publication and is intended for attribution, not billing reconciliation.
These server logs cannot attribute bytes sent to standalone local or Desktop
clients; if Cloudflare grows without a corresponding server-side increase,
inspect relay-side metrics or client diagnostics before changing traffic rules.
