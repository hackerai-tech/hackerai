# E2B disk-only workspace recovery

This is an operator-only, one-shot path for a **known paused sandbox** whose
memory restore fails. It is never triggered by a model tool, timeout, or normal
Agent retry. The operator must confirm that running processes and unflushed
writes will be lost if a reboot occurs. Reboot does not recover old jobs or
upgrade the sandbox's template/envd. For an envd upgrade, follow the
[template and workspace upgrade procedure](../e2b/README.md#upgrading-envd-and-existing-workspaces).

## Before running

1. Verify the intended HackerAI environment and the matching Convex account,
   project, deployment, URL, Redis database, E2B account/project, and regional
   API key using their authoritative dashboards. Do not copy credentials from
   another environment. The CLI can compare key fingerprint and endpoint, but
   the E2B SDK does not return an account/project ID from `getInfo()`; these
   dashboard checks remain an operator responsibility.
2. Confirm the WorkOS user ID, exact existing sandbox ID, region, template and
   sandbox version from the existing workspace record and E2B inventory. The
   command checks these values again through the selected regional E2B key.
   Keep migration and preservation fences intact.
   The provider-reported envd must be a stable version at least `0.5.0`, the
   [documented prerequisite for independent snapshots](https://docs.e2b.dev/sandbox/snapshots).
   Recovery refuses an older, missing or prerelease version before reboot, and
   rechecks after fencing. This is a snapshot capability floor, not an envd
   automatic-update floor or a promise that snapshot creation will succeed.
   A source below it requires a separately approved preservation/recovery plan;
   rebuilding a template does not upgrade that source in place.
3. Stop new Agent/chat work and other app connections for this user. Quiesce
   inbound traffic to the sandbox, since `autoResume: true` can start it even
   without an app connect. Wait for the Redis workspace activity key to expire
   (15 minutes after the last lease refresh). The atomic claim refuses recent
   activity. A running sandbox, another recovery, cleanup, or failed identity
   check blocks reboot.
4. Obtain the owner's informed approval for disk-only recovery and record an
   operator ticket. The authorization JSON must be supplied on **stdin** and
   include a fresh UUID idempotency key. Never put credentials in the JSON or
   command arguments. Load only the designated environment's credentials into
   the local process; do not print them. Set `HACKERAI_ENVIRONMENT` to
   `preview` or `production` after verifying the other target values.

Authorization JSON schema:

```json
{
  "version": 1,
  "environment": "preview",
  "operatorId": "operator-ticket",
  "idempotencyKey": "fresh-uuid",
  "userId": "verified-workos-user-id",
  "sandboxId": "exact-existing-e2b-id",
  "region": "us-east-1",
  "e2bAccount": "dashboard-verified-account",
  "e2bProject": "dashboard-verified-project",
  "expectedApiKeyHmacSha256": "64-lowercase-hex-characters",
  "expectedRedisHost": "verified.upstash.io",
  "expectedConvexUrl": "https://verified-deployment.convex.cloud",
  "expectedTemplate": "template-from-e2b-metadata",
  "expectedSandboxVersion": "version-from-e2b-metadata",
  "intent": "I accept loss of running processes and unflushed writes",
  "trafficQuiesced": true
}
```

Use `corepack pnpm exec tsx scripts/recover-e2b-disk-only.ts < authorization.json`
from the verified checkout. Protect and remove the local authorization file
according to the incident record policy.

The key proof is HMAC-SHA256 of the fixed context string
`hackerai-e2b-disk-recovery-target-v1`, keyed by the verified regional E2B API
key. Generate it in a protected process with the key in its environment, not
in shell arguments or the authorization file. Confirm the key's project in
the E2B dashboard before recording this proof.

For the US region, with the verified key already loaded into the protected
process environment:

```sh
node -e 'const {createHmac}=require("node:crypto"); const key=process.env.E2B_API_KEY; if (!key) process.exit(1); process.stdout.write(createHmac("sha256",key).update("hackerai-e2b-disk-recovery-target-v1").digest("hex")+"\n")'
```

For Europe, use `E2B_EU_API_KEY` in that snippet.

## What the command does

It checks the target and paused sandbox, atomically writes a durable recovery
fence in `cloud_workspace_migration:v1:<user>`, then checks the identity
again. Normal app acquisitions, cached clients, lease refreshes and cleanup
fail closed while fenced. It issues one
`Sandbox.connect(id, { onResume: "reboot", requestTimeoutMs: 300000, retries: 0 })`,
checks a harmless command, and hashes bounded top-level `/home/user` file
metadata without displaying file names or contents. It captures a separate
ready-state E2B snapshot and independently reads back its receipt before
explicitly pausing, then normally reconnects, checks the metadata fingerprint
and a synthetic probe's exact bytes, removes the probe and pauses again. SDK
retries are disabled for recovery connects, snapshot creation and pauses.
Identity is rechecked after the reboot and both pauses. Only after the final paused
state is verified does it release the fence and store an idempotent result.

The metadata fingerprint proves the same observed top-level listing across
the two resumes. It does **not** prove every file's contents, historical
completeness, or survival of unflushed writes. The probe proves only that our
new synthetic bytes survived the normal pause/resume cycle. The original memory
is **no longer reachable once the rebooted sandbox is running**; do not promise rollback. The
ready-state snapshot ID in the result is backup evidence, not a replacement
workspace or authorization to create one.

The result also includes sanitized envd version, allocated CPU/memory, connect
duration, and the most recent resource sample from the preceding five minutes,
before and after recovery. The metrics lookup has a two-second timeout and no
retries; missing samples are `null`, not evidence of low pressure. Sampling uses
the control-plane API and does not resume the paused sandbox. These observations
do not identify the provider's internal readiness stage or establish why a
previous resume failed. No paths, file names, contents, environment values or
raw provider messages enter these diagnostics.

The [E2B reboot contract](https://docs.e2b.dev/sandbox/resume-without-memory)
distinguishes a failed boot (the original paused snapshot remains intact) from a
successful boot (original memory is no longer reachable). Explicitly pausing
saves the recovered state. Leaving the rebooted sandbox to time out is not a
substitute: the documented behavior can return it to the old snapshot. Do not
describe the new ready-state backup as a pre-reboot rollback point.

## If it stops

The recovery fence has no automatic expiry. A request timeout or cancellation
does not prove that E2B stopped its provider-side work. A 409, unsupported
reboot, command/inventory failure, snapshot failure, pause failure, or failed
normal resume all require inspecting the exact sandbox and provider activity
before another action. Re-running with the same idempotency key returns the
stored result only if completed; otherwise it does not issue another reboot.
Read the last durable `step`, E2B state, snapshot ID if one was created, and
whether the sandbox is running or paused. A failed progress write may leave
the durable step behind provider reality, so corroborate it with E2B. Keep the fence while resolving an uncertain
state. Do not kill, delete, reset, create a fresh workspace, or clear a
migration fence to make recovery pass. Escalate to E2B support if provider
state is ambiguous.

Use a disposable synthetic sandbox for an end-to-end rehearsal. Never run a
test against a customer's workspace.

## Customer-confirmed recovery (default off)

The chat error surface can offer one disk-only recovery confirmation for an
owned workspace after two **distinct ordinary acquisitions** fail to resume the
same paused sandbox. SDK retries share an acquisition ID. A single failure
leaves normal retry behavior intact. Successful acquisition clears the failure
record. New failure records are limited to users assigned the recovery flag and
identities compatible with the pinned retry path. Existing pins remain intact
when the rollout is disabled; disabling a feature never authorizes replacement.
Customer recovery never invokes a model or replays a previous action.

The customer path is deliberately narrower than the operator CLI. It requires:

- A current cloud-enabled subscription, access gates, explicit PostHog assignment,
  and a server-owned target manifest matching the web and worker environments.
- Exact user, sandbox, cluster, template and supported version identity; one
  workspace in that regional inventory; only recognized metadata (extra metadata
  may represent a preservation hold).
- No active parent/child Agent resources, recent workspace activity, migration,
  cleanup, unresolved recovery or uncertain provider action. Cloud Agent admission,
  acquisition, cached-client lease refresh and cleanup share the durable fence.
- Independent provider readback of a known boolean `lifecycle.autoResume` and
  `onTimeout === "pause"`, checked before and after the atomic recovery claim.

Existing auto-resume workspaces can use the same one-shot path. The
[E2B reboot contract](https://docs.e2b.dev/sandbox/resume-without-memory) refuses
reboot while a conflicting memory restore is in flight. If inbound traffic has
already started the sandbox, connect returns that running sandbox without
rebooting it. The workflow verifies readiness and persistence in either case;
it does not claim that memory was discarded when the provider returned an
already-running workspace. It never pauses a newly running workspace simply to
force the initial reboot, changes lifecycle settings, or creates a replacement.
Unknown lifecycle, provider conflict or uncertain recovery outcome requires
support. Validate these provider semantics on disposable sandboxes before
rollout, including a real inbound-traffic race.

Only definite 400/422 ordinary resume failures, known SDK/application
connection deadlines, and an E2B SDK `SandboxError` with HTTP 504 from a
verified paused-workspace connect can contribute to a recoverable incident.
These timeouts remain uncertain, including a gateway timeout before the client
deadline: wait the full fifteen-minute idle window after the last
failure, check leases and active work, then independently verify exact paused
identity and regional inventory. E2B must refuse the single reboot request if an
old restore is still starting. Cancellation, 409s, other 5xx responses and unknown
outcomes remain support-only. Uncertainty from one of those failures cannot be
erased by a later known timeout or definite failure.

Consent is a user-scoped receipt with a random UUID and server-selected target.
Unconsumed offers expire for confirmation after ten minutes and can be refreshed.
“Not now” defers; the customer can reopen the warning after reload. Renewal uses
an atomic compare-and-set and never resets confirmed, executing or failed
receipts. Only the winner of atomic confirmation dispatches a task; the atomic
workspace claim consumes confirmed consent before any provider mutation.
Execution must begin within ten minutes of confirmation. A newer failure after
successful recovery routes to support without authorizing another reboot. Task
retries are disabled. Lost dispatch, interruption or uncertain provider mutation
requires reconciliation, never a customer reset or automatic retry.

The worker rechecks environment/region, assignment, eligibility, billing-backed
entitlement and access, then shares the operator recovery procedure. It writes a
unique synthetic probe, reads its bytes, creates a separate snapshot and lists
snapshots for the exact sandbox to corroborate the backup receipt. It explicitly
pauses, resumes normally, checks terminal access, top-level metadata and probe
bytes, removes the probe, pauses again and independently verifies identity
and lifecycle. It then reconnects normally and checks terminal/file access and
running identity before recording `verified_ready` and releasing the fence, pin ordinary acquisition to
the original sandbox and publish completion. Probe persistence proves our test
bytes survived that cycle; it does not prove historical file completeness.

Failure or interruption retains the durable fence after a claim. Progress and
backup IDs remain server-side. The UI displays bounded stage names, then asks
for support if failed or stale; it never clears a fence or retries a reboot.
A timed-out provider operation must be reconciled against provider reality.
After verified recovery the customer can start a new request without reloading.
Completed tool actions and old jobs are never automatically replayed. The
operator CLI retains its `verified_paused` outcome and final paused state.

The recovery card is a persistent banner while Cloud is selected. It reads
server state on navigation/reload and refreshes on cloud acquisition failures,
so a live stream event or opening a menu is not required to rediscover progress
or a deferred warning.
Waiting is polled automatically. Support opens a customer-sendable Messenger
draft with only the opaque incident reference and status; the help center and
visible reference remain available if Messenger is blocked.

### Configuration and rollout

[HAC-188](https://linear.app/hackerai/issue/HAC-188/customer-confirmed-disk-recovery-for-repeatedly-failing-cloud)
owns the hypothesis, guardrails, staged rollout, review date and cleanup plan.
The flag key is `cloud-workspace-customer-recovery`. No flag or runtime
configuration is enabled by this code change. Missing configuration, a missing
flag or unavailable evaluation fails closed.

Before any enablement, independently verify Preview (`hackerai-dev`, project 401167) and Production (144137), plus their Vercel, Trigger and designated Convex
account/deployment selections. Preview should use 100% of the eligible internal
synthetic test population. Production must remain inactive/0% until separately
authorized. Do not copy configuration or credentials between environments.

Set `HACKERAI_ENVIRONMENT` and a server-only `CLOUD_DISK_RECOVERY_TARGETS` JSON
object on **both** the selected Vercel runtime and matching Trigger worker.
Keys are supported Trigger region names. Each regional entry has exactly:

```json
{
  "environment": "preview",
  "e2bAccount": "dashboard-verified-account",
  "e2bProject": "dashboard-verified-project",
  "expectedApiKeyHmacSha256": "64-lowercase-hex-characters",
  "expectedRedisHost": "verified.upstash.io",
  "expectedConvexUrl": "https://verified-deployment.convex.cloud",
  "expectedDomain": "verified-regional-e2b-domain",
  "expectedPostHogKeyHmacSha256": "64-lowercase-hex-characters"
}
```

Use the same fixed-context key proof as the operator path. The PostHog proof is
HMAC-SHA256 of that runtime's public project key, keyed with its regional E2B
key. Account/project names are operator attestations; the provider SDK cannot
independently resolve them. Record authoritative dashboard evidence before
writing a manifest. Parse/validate the complete JSON and perform sanitized
readback. A manifest/env change needs a new web deployment and matching worker
deployment. A flag-only change needs a new status request/Agent run, provided
both deployed runtimes already have the correct configuration. Disabling the
flag blocks new confirmations/executions; existing recovery fences remain.

### Acceptance before enabling

Use only a disposable synthetic Preview sandbox. Exercise both supported
auto-resume settings. In the actual signed-in Preview app, cause two distinct definite ordinary
resume failures without changing sandbox identity. A single failure must show
normal retry; repeated eligible failures must show the loss warning and explicit
confirmation. Decline, reload, concurrent tabs and a lost response must not
trigger duplicate work. Confirm once and observe backup/verification progress,
then issue a new bounded command/file request without reloading, in the original
workspace. Check terminal and known synthetic file bytes across another normal
pause/resume. Confirm old actions/jobs were not replayed.

Also rehearse known connection deadlines before/after the idle window, unknown
resume outcomes, unknown lifecycle, inbound auto-resume conflicts, active work,
recent lease, concurrent recovery, backup/readback failure, probe mismatch and worker
interruption. These must refuse recovery or retain the exact fence and require
support. Unit tests and a synthetic browser component harness do not establish
provider or authenticated Preview acceptance. Do not test customer sandboxes.
