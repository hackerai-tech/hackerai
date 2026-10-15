# E2B disk-only workspace recovery

This is an operator-only, one-shot path for a **known paused sandbox** whose
memory restore fails. It is never triggered by a model tool, timeout, or normal
Agent retry. The operator must confirm that running processes and unflushed
writes may be lost. Reboot does not recover old jobs.

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
`Sandbox.connect(id, { onResume: "reboot", requestTimeoutMs: 300000 })`,
checks a harmless command, and hashes bounded top-level `/home/user` file
metadata without displaying file names or contents. It captures a separate
ready-state E2B snapshot before explicitly pausing, then normally reconnects,
checks the metadata fingerprint and pauses again. Only after the final paused
state is verified does it release the fence and store an idempotent result.

The metadata fingerprint proves the same observed top-level listing across
the two resumes. It does **not** prove every file's contents, historical
completeness, or survival of unflushed writes. The original memory snapshot
may be unreachable after a successful reboot; do not promise rollback. The
ready-state snapshot ID in the result is backup evidence, not a replacement
workspace or authorization to create one.

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
