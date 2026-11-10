# Native benchmark controller lifecycle

Host-side helpers for native benchmark adapters. This package has no model,
workflow dispatch, retry, or verifier-release entry point. It requires Python
3.10+; process identity checks run inside the owned Linux host's PID namespace.

The control directory and signing key belong to the trusted operator and must
stay outside every Task mount. Use a private directory named by a unique
32-character lowercase hexadecimal job ID. `control/config.json` binds
`scope.runId` to `local-<job ID>` and records the SHA-256
`terminalKeyFingerprint`. Never reuse a job directory or signing key.

## Adapter integration

Place this repository's `scripts/benchmarks` on the adapter's Python module
path, then import `controller.cleanup` and `controller.diagnostics`. Pin the
module hashes with the adapter's other runtime sources before admitting work.
Existing frozen controllers retain their original code and evidence.

Label each disposable container and network with
`com.hackerai.benchmark.job=<job ID>`. Container ownership also requires a
Compose config path inside the exact job directory. A shared Compose project
name alone never authorizes removal. Put `remote-token` and `signing-key` only
in the private `control` directory; these exact files are unlinked after
independent container and network absence checks succeed.

1. Call `check_health(metrics, evidence_path)` or `check_deadline(...)` at the
   existing admission and runtime boundaries. The first failed numeric sample
   is durably retained; thresholds are not reduced during recovery.
2. After confirming the exact native child has stopped, call
   `finalize_job(job_root, state)`. Cleanup read failures are terminal,
   unconfirmed outcomes with a separate sanitized diagnostic. Original
   productive-work failures remain in `state`.
3. For an exited supervisor, the operator must first independently read every
   journal-owned product worker terminal and verify the saved Goal's cleanup.
   Only then forward its signed terminal receipt to `reconcile_dead_job`.
   The helper verifies the original signed request, receipt binding, key
   fingerprint, and exact native PID/start-tick identities before recording a
   one-use cleanup intent. The adapter must verify the host boot/PID namespace
   before invoking it. A missing `/proc` mount is never proof of process exit.
4. For a synthetic setup failure with no request, the operator must freshly
   confirm an empty dispatch journal before signing the exact payload accepted
   by `reconcile_dead_undispatched`. The native mailbox must also contain no
   request, response, or request intent. This path cannot clean scored work.

Terminal envelopes use HMAC-SHA256 over `canonical(payload)`, with protocol
`native-goal-terminal-v4`. The original envelope is stored as
`control/mailbox/req-<requestId>.json`. Undispatched authorization uses protocol
`benchmark-no-dispatch-cleanup-v1` and binds the complete configured scope and
job ID. A signed cleanup receipt is not permission to grade or start work.

If a cleanup mutation has an unknown outcome, read back exact resource and
process identities. Do not blindly replay a recorded cleanup intent, restart
an owner, clear a breaker, or convert an infrastructure outcome into a model
failure. Keep original state, guard evidence, and cleanup errors separate.

## Tests

```sh
python3 -B -m unittest discover -s scripts/benchmarks/controller -p 'test_*.py' -v
```

Tests use synthetic Docker responses and private temporary files. They require
no Docker daemon, provider credentials, model calls, or benchmark data. The
main test workflow runs them before application checks.
