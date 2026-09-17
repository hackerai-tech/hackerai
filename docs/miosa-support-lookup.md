# Identifying Miosa workspaces

New sandboxes carry `userReference`, `environment`, and `identityVersion` metadata
plus tags such as `hackerai-user-c6c289e49e9c`. The reference is a shortened hash
of the stable WorkOS user ID. No email, account name, prompt, or scan target is
sent in these fields. Plan is intentionally omitted because it can change.

Miosa's dashboard must display metadata or tags for these labels to be visible.
Ask support for the sandbox UUID or complete existing name if labels are hidden.
The SDK does not update metadata on reuse, so existing sandboxes retain their
current metadata; the lookup works for their IDs and names immediately.

## Internal lookup

Use the read-only support command from an authorized operator workstation:

```sh
pnpm exec tsx scripts/miosa-lookup.ts --env-file /absolute/path/to/verified.env --email account@example.com
pnpm exec tsx scripts/miosa-lookup.ts --env-file /absolute/path/to/verified.env --reference hackerai-user-c6c289e49e9c
pnpm exec tsx scripts/miosa-lookup.ts --env-file /absolute/path/to/verified.env --sandbox-id SANDBOX_UUID
```

Before running, verify the file's WorkOS account/client and Miosa tenant both
belong to the intended HackerAI environment. The command loads only this file,
never another checkout's configuration or ambient credentials. Required fields
are `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, and `MIOSA_API_KEY`; `MIOSA_BASE_URL`
is optional. Do not copy credentials between environments to run the lookup.

Output includes the matching account's name/email, full external user identity,
reference, sandbox IDs, state, and template. It contains personal information:
keep it internal and share only the pseudonymous reference/UUID with Miosa.
Email lookup is direct; reverse lookup paginates through WorkOS accounts and
can be slower. Zero matches can mean a deleted account or the wrong environment.
Multiple matches are rejected; use the full existing workspace name or UUID.
SDK sandbox listing determines which workspaces are returned, including whether
destroyed workspaces are available.

## Acquisition incident correlation

Acquisition step, failure, fallback, and completion telemetry share an
`acquisition_id`; a Trigger run can perform multiple acquisitions. Step events
also contain sanitized sandbox ID/state and provider operation/request IDs when
available. Local readiness failures retain their observed terminal state, not
just the stale SDK object's state. Raw messages, headers, metadata, and user
command/file content must not be collected to obtain this correlation.

On an SDK acquisition timeout, reconciliation uses bounded read-only lookup of
the known sandbox ID, or the stable name with matching external-user identity
when a fresh create's ID is unknown. It never replays create/resume. A running,
resuming, or provisioning result must still pass readiness and initialization
before use. Pause/resume conflicts use the same verification path. Missing
known IDs never fall back to a replacement by name.

Reconciliation adds at most ten seconds of lookup time; its separate client has
two-second HTTP timeouts and no HTTP retries. Failed reconciliation preserves
the original failure for fallback and records the reconciliation cause as a
separate step. Success means the VM is reused by the current request, not proof
that no other late provider operations exist.

If a late create remains invisible, telemetry records an unresolved failure.
The configured seven-minute provider idle-pause policy remains the safeguard
for unused late allocations. Automatic client-side pause/destroy is unsafe:
another chat or worker may be using the shared workspace. Strict post-timeout
cleanup needs a provider-side conditional cancellation/inactivity contract or
a cross-worker use fence covering every sandbox transport; an in-process lock
or a name lookup alone cannot establish inactivity. Keep E2B fallback enabled.

Before deploying broadly, use an eligible Preview test account to run a bounded
Agent command in a disposable chat, reconnect after pause, and verify completion
and file integrity. Confirm acquisition step/fallback/completion correlation in
the actual Trigger Preview worker. Controlled timeout/conflict tests should run
in the test harness, never by disrupting a customer VM; recovery must use the
known ID and pass readiness before commands execute. Live verification must
not be inferred from mocked regression tests.

## Compatibility

The 24-character external user hash, external workspace ID, and `-v2` sandbox
name remain unchanged. Support references are labels, not authorization keys.
No sandbox is created, resumed, renamed, or destroyed by the lookup. Environment
metadata comes from `TRIGGER_ENV` or `VERCEL_ENV`; without a recognized explicit
value it is `unknown`, since `NODE_ENV=production` can also mean Preview.

Verify a new sandbox's tags/metadata and look it up by UUID. Then use a paused
existing sandbox's name to confirm its owner resolves while it remains paused.
