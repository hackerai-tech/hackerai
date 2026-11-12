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

E2B batches first run a command readiness probe. A failed probe prevents every
attachment from independently retrying against an unavailable command channel.
The probe has two budgets. Five seconds bound the startup request waiting for
a process ID. Thirty seconds bound
the whole command, because every E2B command starts a login shell: a workspace
whose profile is slow has a working channel and must not be reported as
unreachable. A probe that started and still exceeds thirty seconds is killed
by its own process ID before any recovery.

Recovery permits one reconnect and one new readiness probe;
it does not destroy or replace the workspace. `sandbox_attachment_reconnect`
records `same_sandbox` so reconnecting a client cannot be mistaken for a new VM.
`upload_retried_after_reconnect` replaces the misleading fresh-sandbox field.

`sandbox_attachment_failure_diagnostics` distinguishes `readiness` from
`transfer` and records allowlisted E2B CPU, memory and disk metrics when the
control plane responds within one second. `metrics_status=unavailable` is
inconclusive; missing metrics must never replace the original error. Metrics
are sampled on failure and may lag the actual command failure.

Command failures also record whether the SDK observed an exit and whether
cleanup killed the command, found it already gone, failed, or returned an
invalid receipt. An unobserved exit with a `not_found` cleanup receipt does not
prove successful execution. Preserve the failed result; never replay while
cleanup is unconfirmed.

E2B can acknowledge a successful process exit before its event stream closes.
If waiting for that stream subsequently fails, use the acknowledged exit and
collected output rather than replaying the completed command. An abort remains
authoritative. A missing exit or a nonzero exit remains a failure; this recovery
does not establish the cause of historical readiness timeouts.

Cloud URL downloads give curl a ten-second connection deadline, a two-minute
attempt deadline and a two-minute retry-start budget. The SDK command deadline
is longer than curl's maximum combined budget, so a slow transfer can finish
and a stalled transfer can report curl's download timeout instead of losing
the command stream at the SDK's default deadline. Stop still cancels the
specific transfer process and leaves the workspace available for another run.

### Name-resolution fallback

A cloud download whose ordinary attempts end in an observed curl exit 6, or
exit 28 whose own stderr names only name resolution, may run once more with
`--resolve host:443:address`, where the worker resolved the address. The URL,
TLS name and certificate verification are unchanged, and the worker never
fetches the file. A message-derived exit code, any other timeout wording and
command-channel failures do not qualify.

The fallback preserves network restrictions. It runs only when the provider's
own description of the workspace shows no egress
allow list, deny list, proxy or rules. A missing, failed, or restricted
description skips it, as does any answer that is not entirely public IPv4.
Skipping, a failed lookup, and a pinned request without a process result all
report the original download failure; a pinned request that exits nonzero is
final and reports its own exit. The recovery log contains no hosts, addresses
or resolver errors.

Local transfer failures distinguish a disconnected computer, missing Windows
transfer client, DNS failure, and resource exhaustion. A curl DNS error with
`getaddrinfo() thread failed to start` is resource exhaustion evidence, not
proof of a DNS configuration problem. Windows fallback verifies PowerShell
on the selected computer, including its system-directory executable, before
staging a transfer script.

## Cloud fallback directories

When a cloud curl transfer cannot write its destination, the fallback reserves
a new owner-only `hackerai-upload-<uuid>` directory directly beneath the first
usable base. It does not depend on a shared `hackerai-upload` root: a reused
workspace can hold one that the command user cannot write in every base at
once. Existing paths are never changed or removed, so these directories
accumulate until the workspace owner removes them. Desktop and other native
transfers keep the shared-root fallback.

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
