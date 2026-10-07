# Attachment staging diagnostics

Use the actual `sandbox_provider` on the staging event to attribute a failure.
Cloud selection preferences and the presence of a curl error do not establish
which provider performed the upload. Curl exit 23 establishes a destination
write failure, but does not identify its filesystem cause.

`sandbox_attachment_staging_fallback` records the initial failure category and
exit code, staging attempt, request/run ID, environment and release. Its
`fallback_outcome` is `retrying`, `recovered`, `failed`, or `unavailable`.
Count terminal outcomes only; `retrying` is the start of the same fallback.
An unavailable fallback directory is separate from a failed fallback transfer.
Successful recovery preserves the original reason rather than treating the
initial write as healthy. Operational logs also include the sandbox ID when
available; product analytics deliberately excludes it.

`sandbox_attachment_staging_completed` supplies an attachment-count denominator
per staging attempt: `total_count`, `direct_success_count`, `recovered_count`,
and `failed_count`. `staging_attempt` distinguishes `initial` from
`reconnect_retry`; do not sum both as independent customer tasks. These
counts exclude sandbox acquisition failures and cancelled staging attempts.

## Command readiness and reconnect

E2B batches first run a five-second command readiness probe. A failed probe
prevents every attachment from independently retrying against an unavailable
command channel. Recovery permits one reconnect and one new readiness probe;
it does not destroy or replace the workspace. `sandbox_attachment_reconnect`
records `same_sandbox` so reconnecting a client cannot be mistaken for a new VM.
`upload_retried_after_reconnect` replaces the misleading fresh-sandbox field.

`sandbox_attachment_failure_diagnostics` distinguishes `readiness` from
`transfer` and records allowlisted E2B CPU, memory and disk metrics when the
control plane responds within one second. `metrics_status=unavailable` is
inconclusive; missing metrics must never replace the original error. Metrics
are sampled on failure and may lag the actual command failure.

Local transfer failures distinguish a disconnected computer, missing Windows
transfer client, DNS failure, and resource exhaustion. A curl DNS error with
`getaddrinfo() thread failed to start` is resource exhaustion evidence, not
proof of a DNS configuration problem. Windows fallback verifies PowerShell
on the selected computer, including its system-directory executable, before
staging a transfer script.

## E2B write probes

Only write failures eligible for path fallback trigger diagnostics. At most
three probes run per staging attempt. Each uses the same default command user
as the upload, a three-second shell deadline and a four-second SDK execution
timeout. Missing Python/timeout tools, malformed output, or command failures
produce `diagnostics_probe_status=unavailable`; they must not obscure the
transfer error or prevent fallback. Cancellation still propagates.

The probe checks target existence/type, numeric ownership/mode, effective UID
and GID, available bytes/inodes, read-only filesystem status and creation of a
one-byte exclusive temporary file. It removes only that probe file. It never
reads attachment contents, overwrites existing files, lists directories, or
returns paths/usernames/raw errors. The server validates and allowlists every
returned diagnostic field. `diagnostics_probe_cleanup_failed` means removal of
that probe file failed and a temporary artifact may remain in the sandbox.

If the intended parent is absent/inaccessible, the probe uses its nearest
accessible existing ancestor: `diagnostics_probe_directory_is_parent=false`.
A successful write there does not prove the original destination is writable.
Likewise, a writable directory does not prove an existing target can be replaced.

## Interpreting evidence

- An existing target owned by another UID, with `target_writable=false`, plus a
  successful directory probe supports a target collision/permissions diagnosis.
  Use reserved staging directories rather than altering existing user files.
- Low free bytes/inodes or `disk_full`/`quota_exceeded` requires capacity work or
  cleanup restricted to disposable staging artifacts.
- `filesystem_read_only=true` or `write_probe_result=read_only` supports an E2B
  filesystem investigation using operational sandbox IDs and run timestamps.
- Probe unavailability is inconclusive. Correlate the original error, E2B
  acquisition/resume evidence, and surrounding command failures before blaming
  the provider or changing sandbox state.

Validate in the authorized Preview environment with a disposable E2B sandbox:
normal upload; existing non-writable target with writable parent; unavailable
upload directory; cancellation during staging. Expect normal completion or the
existing actionable failure, correct rewritten attachment references, and
structured terminal outcomes without filenames, signed URLs or contents.
