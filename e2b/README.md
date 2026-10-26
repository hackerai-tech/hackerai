# agent-sandbox - E2B Sandbox Template

This is an E2B sandbox template that allows you to run code in a controlled environment.

## Prerequisites

Before you begin, make sure you have:

- An E2B account (sign up at [e2b.dev](https://e2b.dev))
- Your E2B API key (get it from your [E2B dashboard](https://e2b.dev/dashboard))
- Node.js and npm/yarn (or similar) installed

## Configuration

1. Add your E2B API key to `.env.local` in the project root:
   ```
   E2B_API_KEY=your_api_key_here
   ```

For European cloud Agent execution, add the separate EU cluster credentials
without replacing the US key. European runs are restricted to this cluster and
fail closed when `E2B_EU_API_KEY` is unavailable:

```dotenv
E2B_EU_API_KEY=your_eu_api_key_here
E2B_EU_DOMAIN=e2b-juliett.dev
```

## Building the Template

These existing commands build the default tag and affect **new** sandboxes.
They require explicit build/promotion authorization. For an upgrade candidate,
use the staged procedure below instead.

```bash
# For development
pnpm run e2b:build:dev

# For production
pnpm run e2b:build:prod

# For the EU development template
pnpm run e2b:build:eu:dev

# For the EU production template
pnpm run e2b:build:eu:prod
```

The EU commands pass the separate key and `e2b-juliett.dev` domain directly to
the E2B SDK. They do not overwrite or reuse `E2B_API_KEY`. Set
`E2B_EU_TEMPLATE` only when the EU template alias should differ from
`terminal-agent-sandbox-dev` or `terminal-agent-sandbox`.

## Upgrading envd and existing workspaces

E2B provisions the guest agent, envd, during a template rebuild. The installed
SDK recommends rebuilding to obtain the latest sandbox agent; it does not expose
an envd version option on `Template.build`. Keep the provider-managed agent out
of the Dockerfile. All builds here use whole-build `skipCache: true` with the
existing 4 vCPU / 4096 MiB allocation. A rebuild is the upgrade mechanism, but
does not prove which agent the hosted regional service supplied. Record and
verify its actual version before accepting the build. Do not infer an automatic
update minimum from the SDK package version or the application's `sandboxVersion`.
Automatic updates require an actual running envd of at least `0.6.12`, but rollout
is gradual: eligibility is not a delivery guarantee for any particular sandbox,
and there is no customer-visible eligibility indicator. The readiness safeguard
requires actual envd `>=0.10.0` **and** provider rollout; the version alone cannot
prove the safeguard is enabled. Rebuild and verify rather than waiting for an
eventual update to an existing workspace.

Rebuilding changes new sandboxes only. It does not update existing running/paused
workspaces or snapshots. Disk-only reboot is recovery within the same
workspace, not an envd upgrade. Copying an old root filesystem or starting from an
old snapshot also cannot establish that a new agent was installed.

### Build and validate a candidate

1. Verify the intended HackerAI environment, E2B account/project, region and key
   in the authoritative dashboard. Verify Convex, Vercel and Trigger independently
   before any app acceptance or configuration change. Load only that target's
   regional key into a protected process. This command does not load `.env.local`.
2. After build authorization, select an unused candidate tag and run, for example:

   ```sh
   corepack pnpm exec tsx scripts/build-e2b-candidate.ts us-dev candidate-upgrade-1
   ```

   Valid targets are `us-dev`, `eu-dev`, `us-prod`, and `eu-prod`; the target selects
   an alias/domain, not an account. The key's account still needs independent
   verification. The command requires an existing default tag and refuses a reused
   candidate tag. It rebuilds without changing capacity, verifies the candidate
   points at the returned build, and verifies the previous default is unchanged.
   It does not promote, create a sandbox, or migrate files. Keep the returned build
   ID and `validationReference`. On a timeout or readback failure, inspect the
   regional build and tags before retrying; do not start a second build blindly.

3. Under separately authorized disposable validation, create a **new synthetic**
   sandbox using that exact `templateId:buildId` reference, the same regional key
   and domain, a bounded lifetime, SDK retries disabled, and unique QA metadata.
   Record the sandbox ID immediately. Read `Sandbox.getInfo()` for template ID,
   CPU, memory and **template build-time** `envdVersion`. Run
   `/usr/bin/envd -version` inside that already-running disposable sandbox to
   verify the **actual** binary is at least `0.10.0`; keep both observations
   separate. If the command is unavailable, actual version and readiness remain
   unknown. A new rebuild should supply the current provider-managed agent, but
   the observed version must pass this check. Provider rollout is still required
   and has no customer-visible confirmation signal; do not label it enabled.
4. Time a harmless command, write/read synthetic bytes, flush those bytes, pause,
   resume normally once, and verify the exact bytes again. On this disposable
   sandbox only, also rehearse a cold reboot and explicit pause. A failed reboot
   preserves the original snapshot; a successful reboot loses running processes
   and unflushed writes, and partial files are possible. The next pause replaces
   the saved state with the rebooted state. With `onTimeout: "pause"`, timeout
   performs that pause automatically, even if the application is fenced or its
   worker has failed. There is no API rollback to the earlier memory snapshot.
   Collect timestamped
   `getMetrics()` samples during a bounded representative workload; absence of
   metrics is unknown. Check tool versions and the existing trust-store gates.
   Record readiness durations, observed envd, allocated resources and persistence
   results. Do not infer a memory-download or CPU-starvation cause from a timeout.
5. Delete only the disposable sandbox created for this validation and verify it
   is absent. If creation has an uncertain outcome, reconcile the unique QA
   metadata before any retry. Retain the candidate build for review. Promotion of
   its default tag and app configuration are separate authorized actions; retain
   the previous build ID for new-sandbox rollback. Reverting a template tag does
   not roll back existing workspace files or memory.

The Docker image workflow runs only on `main` pushes touching `docker/**` (or
manual dispatch). This candidate command is not wired into CI. A branch/PR edit
to `e2b/` does not start an E2B build. Inspect workflow filters again before any
future infrastructure push; never use a review request as build authorization.

### Preserve an existing workspace during migration

Migration requires its own authorized operation and a maintenance window. This
repository does not automatically replace an old workspace because of its version.

1. Verify the exact source owner, sandbox, region, template, account and existing
   workspace pin. Record every existing recovery/migration/preservation fence and
   leave it intact. Stop new Agent work, child runs, leases and inbound auto-resume
   traffic. Acquire an appropriate durable maintenance fence using an approved
   operator procedure. If no safe fence/cutover procedure exists for the source's
   current state, stop; do not repurpose or clear a recovery fence.
2. Inventory the **complete agreed data scope**, including hidden files, additional
   data directories, symlinks, permissions, ownership, hard links, ACLs and extended
   attributes where needed. Stop writers and explicitly flush files/databases.
   Exclude the old operating system, envd and runtime credentials from restoration.
   Identify software/configuration that must be reinstalled on the fresh template.
   If the source cannot be read, use the separately consented recovery procedure
   first; never describe inaccessible or unflushed data as preserved.
3. Create an independent, access-controlled backup and a content manifest of the
   quiesced source: relative path, type, byte count and SHA-256 for every regular
   file, symlink target, and required metadata. Keep filenames and hashes private.
   Verify the backup by extracting/reading it and comparing its manifest. Retain
   the original source and all historical snapshots. A post-reboot backup cannot
   restore the original memory or unflushed writes.
4. Create a fresh destination from the **validated exact build** in the same
   authorized environment/region. Verify ownership and actual envd before copying.
   Copy only the agreed data scope, preserving required metadata; never overwrite
   the provider agent with source system files. Generate the destination manifest
   and require an exact match to the source. Re-read the source manifest to detect
   writes during transfer. For a Linux-to-Linux filesystem comparison, a dry-run
   `rsync -aHAXnc --numeric-ids --delete --itemize-changes SOURCE/ DEST/` can check
   content and metadata differences; keep its path-bearing output private and
   never remove `-n` from that verification command. Handle excluded files and
   baseline destination files explicitly, not by ignoring mismatches.
5. Flush and pause the destination, normally reconnect, and compare the full
   destination content manifest again. Run a bounded synthetic tool request from
   the intended web/Trigger path, verify completion and saved response after reload.
   Require verified hashes, metadata, persistence and actual application routing
   before a separately authorized atomic workspace-pin cutover. The synthetic
   probe in disk recovery alone is insufficient evidence for migration.
6. Keep the old source paused and retained through acceptance. Do not delete,
   replace, clear fences, or automatically roll back a destination after new writes.
   Failed copying, mismatched manifests, ambiguous cancellation, failed persistence
   or failed pin readback must retain both workspaces and the fence for inspection.
   Rollback after cutover must reconcile new writes, not discard them.

Provider references: [template builds](https://docs.e2b.dev/template/build),
[tags and exact builds](https://docs.e2b.dev/template/tags),
[resource metrics](https://docs.e2b.dev/sandbox/metrics), and
[reboot semantics](https://docs.e2b.dev/sandbox/resume-without-memory).
